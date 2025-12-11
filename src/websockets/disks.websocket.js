/**
 * Disks WebSocket Manager
 * Provides real-time disk I/O throughput and temperature monitoring
 *
 * Events:
 * - subscribe-disks: Subscribe to disk updates (all or specific devices)
 * - unsubscribe-disks: Unsubscribe from disk updates
 * - get-disks: One-time request for disk data
 *
 * Emits:
 * - disks-update: Throughput data (every 2s)
 * - disks-temperature-update: Temperature data (every 5-10s)
 * - disks-subscription-confirmed: Subscription confirmed
 * - error: Error occurred
 */

class DisksWebSocketManager {
  constructor(io, disksService) {
    this.io = io;
    this.disksService = disksService;
    this.activeSubscriptions = new Map();
    this.authCache = new Map();
    this.authCacheDuration = 5 * 60 * 1000; // 5 minutes

    // Intervals
    this.throughputInterval = 2000; // 2 seconds for I/O throughput
    this.temperatureInterval = 10000; // 10 seconds for temperatures

    // Client subscriptions: Map<socketId, { devices: string[], user: Object }>
    this.clientSubscriptions = new Map();
  }

  /**
   * Handle WebSocket connection for disk monitoring
   */
  handleConnection(socket) {
    // Subscribe to disk updates
    socket.on('subscribe-disks', async (data) => {
      try {
        const { token, devices = [], includeTemperature = true } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        socket.userId = authResult.user.id;
        socket.userRole = authResult.user.role;
        socket.user = authResult.user;

        // Store client subscription preferences
        this.clientSubscriptions.set(socket.id, {
          devices, // Empty array = all disks
          includeTemperature,
          user: authResult.user
        });

        // Join disks room
        socket.join('disks');
        console.log(`Client ${socket.id} (${authResult.user.role}) subscribed to disks:`,
          devices.length > 0 ? devices : 'all');

        // Ensure disk stats sampling is running
        if (!this.disksService.isDiskStatsSamplingActive()) {
          this.disksService.startDiskStatsSampling(this.throughputInterval);
        }

        // Send immediate update
        await this.sendDisksUpdate(socket, true);

        // Start monitoring if not already active
        this.startDisksMonitoring(includeTemperature);

        socket.emit('disks-subscription-confirmed', {
          throughputInterval: this.throughputInterval,
          temperatureInterval: includeTemperature ? this.temperatureInterval : null,
          devices: devices.length > 0 ? devices : 'all'
        });
      } catch (error) {
        console.error('Error in subscribe-disks:', error);
        socket.emit('error', { message: 'Failed to subscribe to disk updates' });
      }
    });

    // Unsubscribe from disks
    socket.on('unsubscribe-disks', () => {
      try {
        socket.leave('disks');
        this.clientSubscriptions.delete(socket.id);
        console.log(`Client ${socket.id} unsubscribed from disks`);

        // Check if we should stop monitoring
        this.checkStopDisksMonitoring();

        socket.emit('disks-unsubscription-confirmed');
      } catch (error) {
        console.error('Error in unsubscribe-disks:', error);
      }
    });

    // Get immediate disk data (one-time request)
    socket.on('get-disks', async (data) => {
      try {
        const { token, devices = [], includeTemperature = false } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        // Temporarily set user for formatting
        socket.user = authResult.user;

        // Get throughput data
        const throughputData = this.getFilteredThroughput(devices, authResult.user);

        // Get temperature if requested
        let temperatureData = null;
        if (includeTemperature && devices.length > 0) {
          temperatureData = await this.disksService.getMultipleDisksTemperature(devices);
        } else if (includeTemperature) {
          // Get all disk temperatures
          const allDisks = this.disksService.getAllDisksThroughput();
          const deviceNames = allDisks.map(d => d.device);
          temperatureData = await this.disksService.getMultipleDisksTemperature(deviceNames);
        }

        socket.emit('disks-update', {
          throughput: throughputData,
          temperature: temperatureData,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('Error in get-disks:', error);
        socket.emit('error', { message: 'Failed to get disk data' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Disks WebSocket client disconnected: ${socket.id}`);
      this.clientSubscriptions.delete(socket.id);
      this.checkStopDisksMonitoring();
    });
  }

  /**
   * Start monitoring disks with separate timers for throughput and temperature
   */
  startDisksMonitoring(includeTemperature = true) {
    // Start throughput monitoring if not already active
    if (!this.activeSubscriptions.has('disks-throughput')) {
      console.log(`[DisksWebSocket] Starting throughput monitoring (${this.throughputInterval}ms)`);

      const throughputIntervalId = setInterval(async () => {
        try {
          const room = this.io.adapter.rooms.get('disks');
          if (!room || room.size === 0) {
            this.stopDisksMonitoring();
            return;
          }

          // Send throughput updates to each client with their preferences
          await this.broadcastThroughputUpdates();
        } catch (error) {
          console.error('Error in disk throughput monitoring:', error);
        }
      }, this.throughputInterval);

      this.activeSubscriptions.set('disks-throughput', {
        intervalId: throughputIntervalId,
        interval: this.throughputInterval,
        startTime: Date.now(),
        type: 'throughput'
      });
    }

    // Start temperature monitoring if requested and not already active
    if (includeTemperature && !this.activeSubscriptions.has('disks-temperature')) {
      console.log(`[DisksWebSocket] Starting temperature monitoring (${this.temperatureInterval}ms)`);

      const tempIntervalId = setInterval(async () => {
        try {
          const room = this.io.adapter.rooms.get('disks');
          if (!room || room.size === 0) {
            return;
          }

          // Send temperature updates to clients who requested it
          await this.broadcastTemperatureUpdates();
        } catch (error) {
          console.error('Error in disk temperature monitoring:', error);
        }
      }, this.temperatureInterval);

      this.activeSubscriptions.set('disks-temperature', {
        intervalId: tempIntervalId,
        interval: this.temperatureInterval,
        startTime: Date.now(),
        type: 'temperature'
      });
    }
  }

  /**
   * Stop all disks monitoring
   */
  stopDisksMonitoring() {
    // Stop throughput monitoring
    const throughputSub = this.activeSubscriptions.get('disks-throughput');
    if (throughputSub) {
      clearInterval(throughputSub.intervalId);
      this.activeSubscriptions.delete('disks-throughput');
      console.log('[DisksWebSocket] Stopped throughput monitoring');
    }

    // Stop temperature monitoring
    const tempSub = this.activeSubscriptions.get('disks-temperature');
    if (tempSub) {
      clearInterval(tempSub.intervalId);
      this.activeSubscriptions.delete('disks-temperature');
      console.log('[DisksWebSocket] Stopped temperature monitoring');
    }

    // Stop background sampling if no clients
    const room = this.io.adapter.rooms.get('disks');
    if (!room || room.size === 0) {
      this.disksService.stopDiskStatsSampling();
    }
  }

  /**
   * Check if monitoring should be stopped
   */
  checkStopDisksMonitoring() {
    const room = this.io.adapter.rooms.get('disks');
    if (!room || room.size === 0) {
      this.stopDisksMonitoring();
    }
  }

  /**
   * Broadcast throughput updates to all subscribed clients
   */
  async broadcastThroughputUpdates() {
    const room = this.io.adapter.rooms.get('disks');
    if (!room) return;

    for (const socketId of room) {
      const socket = this.io.sockets.get(socketId);
      if (!socket) continue;

      const subscription = this.clientSubscriptions.get(socketId);
      if (!subscription) continue;

      const throughputData = this.getFilteredThroughput(
        subscription.devices,
        subscription.user
      );

      socket.emit('disks-update', {
        throughput: throughputData,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Broadcast temperature updates to clients who requested it
   */
  async broadcastTemperatureUpdates() {
    const room = this.io.adapter.rooms.get('disks');
    if (!room) return;

    for (const socketId of room) {
      const socket = this.io.sockets.get(socketId);
      if (!socket) continue;

      const subscription = this.clientSubscriptions.get(socketId);
      if (!subscription || !subscription.includeTemperature) continue;

      try {
        let devices = subscription.devices;

        // If no specific devices, get all tracked devices
        if (devices.length === 0) {
          const allDisks = this.disksService.getAllDisksThroughput();
          devices = allDisks.map(d => d.device);
        }

        const temperatureData = await this.disksService.getMultipleDisksTemperature(devices);

        socket.emit('disks-temperature-update', {
          temperatures: temperatureData,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error(`Error getting temperature for client ${socketId}:`, error.message);
      }
    }
  }

  /**
   * Get filtered throughput data based on device list
   */
  getFilteredThroughput(devices, user) {
    if (devices && devices.length > 0) {
      // Return only requested devices
      return devices.map(device => this.disksService.getDiskThroughput(device, user))
        .filter(d => d !== null);
    }
    // Return all disks
    return this.disksService.getAllDisksThroughput(user);
  }

  /**
   * Send initial disk update to a specific socket
   */
  async sendDisksUpdate(socket, includeTemperature = false) {
    try {
      const subscription = this.clientSubscriptions.get(socket.id);
      if (!subscription) return;

      const throughputData = this.getFilteredThroughput(
        subscription.devices,
        subscription.user
      );

      let temperatureData = null;
      if (includeTemperature && subscription.includeTemperature) {
        let devices = subscription.devices;
        if (devices.length === 0) {
          devices = throughputData.map(d => d.device);
        }
        temperatureData = await this.disksService.getMultipleDisksTemperature(devices);
      }

      socket.emit('disks-update', {
        throughput: throughputData,
        temperature: temperatureData,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error sending disks update:', error);
      socket.emit('error', { message: 'Failed to send disk data' });
    }
  }

  /**
   * Emit disk update after changes (called from other services)
   */
  async emitDisksUpdate() {
    try {
      const room = this.io.adapter.rooms.get('disks');
      if (room && room.size > 0) {
        await this.broadcastThroughputUpdates();
      }
    } catch (error) {
      console.error('Failed to emit disks update:', error);
    }
  }

  /**
   * Get monitoring statistics
   */
  getMonitoringStats() {
    const room = this.io.adapter.rooms.get('disks');
    const throughputSub = this.activeSubscriptions.get('disks-throughput');
    const tempSub = this.activeSubscriptions.get('disks-temperature');

    return {
      clientCount: room ? room.size : 0,
      samplingActive: this.disksService.isDiskStatsSamplingActive(),
      subscriptions: {
        throughput: throughputSub ? {
          interval: throughputSub.interval,
          uptime: Date.now() - throughputSub.startTime,
          isActive: true
        } : null,
        temperature: tempSub ? {
          interval: tempSub.interval,
          uptime: Date.now() - tempSub.startTime,
          isActive: true
        } : null
      },
      clientSubscriptions: Array.from(this.clientSubscriptions.entries()).map(([id, sub]) => ({
        socketId: id,
        devices: sub.devices.length > 0 ? sub.devices : 'all',
        includeTemperature: sub.includeTemperature
      }))
    };
  }

  /**
   * Authenticate user with caching
   */
  async authenticateUser(token) {
    if (!token) {
      return { success: false, message: 'Authentication token is required' };
    }

    // Check cache first
    const cached = this.authCache.get(token);
    if (cached && (Date.now() - cached.timestamp) < this.authCacheDuration) {
      return cached.data;
    }

    try {
      const jwt = require('jsonwebtoken');
      const { getBootToken } = require('../middleware/auth.middleware');
      const userService = require('../services/user.service');

      // Check if it's the boot token
      const bootToken = await getBootToken();
      if (bootToken && token === bootToken) {
        const result = {
          success: true,
          user: {
            id: 'boot',
            username: 'boot',
            role: 'admin',
            isBootToken: true,
            byte_format: 'binary' // Default for boot token
          }
        };

        this.authCache.set(token, { data: result, timestamp: Date.now() });
        return result;
      }

      // Check if it's an admin API token
      const adminTokenData = await userService.validateAdminToken(token);
      if (adminTokenData) {
        const result = {
          success: true,
          user: adminTokenData
        };
        this.authCache.set(token, { data: result, timestamp: Date.now() });
        return result;
      }

      // Regular JWT verification
      const decodedUser = jwt.verify(token, process.env.JWT_SECRET);

      // Check if user still exists
      const users = await userService.loadUsers();
      const currentUser = users.find(u => u.id === decodedUser.id);

      if (!currentUser) {
        return { success: false, message: 'User no longer exists' };
      }

      // samba_only users are not allowed
      if (currentUser.role === 'samba_only') {
        return { success: false, message: 'Access denied. This account is for file sharing only' };
      }

      // Check if role has changed
      if (currentUser.role !== decodedUser.role) {
        return { success: false, message: 'Token invalid due to role change. Please login again' };
      }

      const result = {
        success: true,
        user: {
          id: currentUser.id,
          username: currentUser.username,
          role: currentUser.role,
          byte_format: currentUser.byte_format || 'binary'
        }
      };

      this.authCache.set(token, { data: result, timestamp: Date.now() });
      return result;

    } catch (authError) {
      const errorResult = { success: false, message: 'Invalid authentication token' };
      // Cache failed auth for shorter time (1 minute)
      this.authCache.set(token, { data: errorResult, timestamp: Date.now() });
      return errorResult;
    }
  }
}

module.exports = DisksWebSocketManager;
