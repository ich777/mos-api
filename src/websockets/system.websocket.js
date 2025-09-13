class SystemLoadWebSocketManager {
  constructor(io, systemService) {
    this.io = io;
    this.systemService = systemService;
    this.activeSubscriptions = new Map();
    this.dataCache = new Map();
    this.cacheDuration = 1750; // 1.75 seconds cache
    this.defaultInterval = 2000; // 2 seconds default update interval
  }

  /**
   * Handle WebSocket connection for system load monitoring
   */
  handleConnection(socket) {
    // Only log when client actually subscribes to system load events

    // Subscribe to system load updates
    socket.on('subscribe-load', async (data) => {
      try {
        const { interval = this.defaultInterval, token } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        socket.userId = authResult.user.userId;
        socket.userRole = authResult.user.role;

        // Join system load room
        socket.join('system-load');
        console.log(`Client ${socket.id} (${authResult.user.role}) subscribed to system load monitoring`);

        // Send immediate update
        await this.sendSystemLoadUpdate(socket, true);

        // Start monitoring
        this.startSystemLoadMonitoring(interval);

        socket.emit('load-subscription-confirmed', { interval });
      } catch (error) {
        console.error('Error in subscribe-load:', error);
        socket.emit('error', { message: 'Failed to subscribe to system load updates' });
      }
    });

    // Unsubscribe from system load
    socket.on('unsubscribe-load', () => {
      try {
        socket.leave('system-load');
        console.log(`Client ${socket.id} unsubscribed from system load`);

        // Check if we should stop monitoring
        this.checkStopSystemLoadMonitoring();

        socket.emit('load-unsubscription-confirmed');
      } catch (error) {
        console.error('Error in unsubscribe-load:', error);
      }
    });

    // Get immediate system load data (one-time request)
    socket.on('get-load', async (data) => {
      try {
        const { token } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        await this.sendSystemLoadUpdate(socket, true); // Force refresh
      } catch (error) {
        console.error('Error in get-load:', error);
        socket.emit('error', { message: 'Failed to get system load data' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      // Socket.io automatically handles room cleanup
      // Check if monitoring needs to be stopped
      this.checkStopSystemLoadMonitoring();
    });
  }

  /**
   * Start monitoring system load if not already active
   */
  startSystemLoadMonitoring(interval) {
    // Use explicit default if no interval provided
    if (!interval) {
      interval = this.defaultInterval;
    }
    const monitoringKey = 'system-load';

    // Stop any existing monitoring first
    if (this.activeSubscriptions.has(monitoringKey)) {
      const existing = this.activeSubscriptions.get(monitoringKey);
      if (existing.interval === interval) {
        return; // Already monitoring with same interval
      }
      // Stop existing monitoring to restart with new interval
      console.log(`Restarting system load monitoring: ${existing.interval}ms → ${interval}ms`);
      clearInterval(existing.intervalId);
      this.activeSubscriptions.delete(monitoringKey);
    }

    console.log(`Starting system load monitoring with ${interval}ms interval`);

    const intervalId = setInterval(async () => {
      try {
        // Check if anyone is still subscribed
        const room = this.io.adapter.rooms.get('system-load');
        if (!room || room.size === 0) {
          console.log('No clients subscribed to system load, stopping monitoring');
          clearInterval(intervalId);
          this.activeSubscriptions.delete(monitoringKey);
          return;
        }

        // Send update to all subscribers
        await this.sendSystemLoadUpdate(null, false);
      } catch (error) {
        console.error('Error in system load monitoring:', error);
      }
    }, interval);

    this.activeSubscriptions.set(monitoringKey, {
      intervalId,
      interval,
      startTime: Date.now()
    });
  }

  /**
   * Check if monitoring should be stopped
   */
  checkStopSystemLoadMonitoring() {
    const room = this.io.adapter.rooms.get('system-load');
    if (!room || room.size === 0) {
      // Stop monitoring subscription
      const subscription = this.activeSubscriptions.get('system-load');
      if (subscription) {
        console.log('Stopping system load monitoring');
        clearInterval(subscription.intervalId);
        this.activeSubscriptions.delete('system-load');
        // Clear cache
        this.dataCache.delete('system-load-data');
      }
    }
  }

  /**
   * Send system load update to socket or room
   * Uses same data structure as REST API GET /system/load
   */
  async sendSystemLoadUpdate(socket, forceRefresh = false) {
    try {
      const loadData = await this.getSystemLoadDataWithCache(forceRefresh);

      // Send system load data, identical to REST API GET /system/load
      if (socket) {
        socket.emit('load-update', loadData);
      } else {
        this.io.to('system-load').emit('load-update', loadData);
      }

      // Debug
      //console.log('System load update sent to clients');

    } catch (error) {
      console.error('Failed to send system load update:', error);

      const errorMsg = {
        error: error.message,
        timestamp: new Date().toISOString()
      };

      if (socket) {
        socket.emit('error', errorMsg);
      } else {
        this.io.to('system-load').emit('error', errorMsg);
      }
    }
  }

  /**
   * Get system load data with caching
   * Reuses the system service method to maintain consistency with REST API
   */
  async getSystemLoadDataWithCache(forceRefresh = false) {
    const cacheKey = 'system-load-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      // Use system service method same as REST API GET /system/load
      const loadData = await this.systemService.getSystemLoad();

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: loadData,
        timestamp: Date.now()
      });

      return loadData;

    } catch (error) {
      console.error('Error getting system load data:', error);
      throw error;
    }
  }

  /**
   * Emit system load update after system changes (called from other services)
   */
  async emitSystemLoadUpdate() {
    try {
      const room = this.io.adapter.rooms.get('system-load');
      if (room && room.size > 0) {
        // Clear cache to force fresh data
        this.dataCache.delete('system-load-data');
        // Send update
        await this.sendSystemLoadUpdate(null, true);
      }
    } catch (error) {
      console.error('Failed to emit system load update:', error);
    }
  }

  /**
   * Cleanup when clients disconnect
   */
  cleanupDisconnectedClient() {
    // Check if monitoring should be stopped
    this.checkStopSystemLoadMonitoring();
  }

  /**
   * Get monitoring statistics
   */
  getMonitoringStats() {
    const room = this.io.adapter.rooms.get('system-load');
    const subscription = this.activeSubscriptions.get('system-load');

    return {
      activeSubscriptions: this.activeSubscriptions.size,
      cachedData: this.dataCache.size,
      clientCount: room ? room.size : 0,
      subscription: subscription ? {
        interval: subscription.interval,
        uptime: Date.now() - subscription.startTime,
        isActive: true
      } : null
    };
  }

  /**
   * Authenticate user
   */
  async authenticateUser(token) {
    if (!token) {
      return { success: false, message: 'Authentication token is required' };
    }

    try {
      const jwt = require('jsonwebtoken');
      const { getBootToken } = require('../middleware/auth.middleware');
      const userService = require('../services/user.service');

      // Check if it's the boot token
      const bootToken = await getBootToken();
      if (bootToken && token === bootToken) {
        return {
          success: true,
          user: {
            id: 'boot',
            username: 'boot',
            role: 'admin',
            isBootToken: true
          }
        };
      }

      // Check if it's an admin API token
      const adminTokenData = await userService.validateAdminToken(token);
      if (adminTokenData) {
        return {
          success: true,
          user: adminTokenData
        };
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

      return {
        success: true,
        user: {
          id: currentUser.id,
          username: currentUser.username,
          role: currentUser.role
        }
      };

    } catch (authError) {
      return { success: false, message: 'Invalid authentication token' };
    }
  }

}

module.exports = SystemLoadWebSocketManager;
