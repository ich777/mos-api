class SystemLoadWebSocketManager {
  constructor(io, systemService) {
    this.io = io;
    this.systemService = systemService;
    this.activeSubscriptions = new Map();
    this.dataCache = new Map();
    this.staticDataCache = new Map(); // Cache for static system data
    this.clientStaticDataSent = new Set(); // Track which clients received static data
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

        // Send immediate full update (includes static data)
        await this.sendSystemLoadUpdate(socket, true, true);

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

        await this.sendSystemLoadUpdate(socket, true, true); // Force refresh with full data
      } catch (error) {
        console.error('Error in get-load:', error);
        socket.emit('error', { message: 'Failed to get system load data' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      // Clean up client tracking
      this.clientStaticDataSent.delete(socket.id);
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

        // Send partial update to all subscribers (dynamic data only)
        await this.sendSystemLoadUpdate(null, false, false);
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
        // Clear all caches
        this.dataCache.delete('system-load-data');
        this.dataCache.delete('system-load-dynamic');
        this.staticDataCache.clear();
        this.clientStaticDataSent.clear();
      }
    }
  }

  /**
   * Send system load update to socket or room
   * @param {Object} socket - Specific socket to send to (null for room broadcast)
   * @param {boolean} forceRefresh - Force cache refresh
   * @param {boolean} sendFullData - Send complete data structure (true) or only dynamic values (false)
   */
  async sendSystemLoadUpdate(socket, forceRefresh = false, sendFullData = false) {
    try {
      let loadData;

      if (sendFullData) {
        // Send complete data structure (for initial connection or forced refresh)
        loadData = await this.getSystemLoadDataWithCache(forceRefresh);

        // Mark clients as having received static data
        if (socket) {
          this.clientStaticDataSent.add(socket.id);
        } else {
          // For room broadcast, mark all clients in room
          const room = this.io.adapter.rooms.get('system-load');
          if (room) {
            room.forEach(socketId => {
              this.clientStaticDataSent.add(socketId);
            });
          }
        }
      } else {
        // Send only dynamic data for efficiency
        loadData = await this.getDynamicSystemLoadData(forceRefresh);
      }

      // Send system load data
      if (socket) {
        socket.emit('load-update', loadData);
      } else {
        this.io.to('system-load').emit('load-update', loadData);
      }

      // Debug
      //console.log(`System load update sent (${sendFullData ? 'full' : 'partial'} data)`);

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
   * Get complete system load data with caching
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

      // Cache the complete result
      this.dataCache.set(cacheKey, {
        data: loadData,
        timestamp: Date.now()
      });

      // Also cache static data separately for future use
      this.cacheStaticData(loadData);

      return loadData;

    } catch (error) {
      console.error('Error getting system load data:', error);
      throw error;
    }
  }

  /**
   * Get only dynamic system load data (optimized for frequent updates)
   */
  async getDynamicSystemLoadData(forceRefresh = false) {
    const cacheKey = 'system-load-dynamic';
    const cached = this.dataCache.get(cacheKey);

    // Return cached dynamic data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      // Get fresh complete data
      const fullData = await this.systemService.getSystemLoad();

      // Extract only dynamic values
      const dynamicData = this.extractDynamicData(fullData);

      // Cache the dynamic result
      this.dataCache.set(cacheKey, {
        data: dynamicData,
        timestamp: Date.now()
      });

      return dynamicData;

    } catch (error) {
      console.error('Error getting dynamic system load data:', error);
      throw error;
    }
  }

  /**
   * Cache static system data separately
   */
  cacheStaticData(fullData) {
    const staticData = {
      cpu: {
        info: fullData.cpu.info,
        cores: fullData.cpu.cores.map(core => ({
          number: core.number,
          isPhysical: core.isPhysical,
          isHyperThreaded: core.isHyperThreaded,
          physicalCoreNumber: core.physicalCoreNumber,
          coreArchitecture: core.coreArchitecture
        }))
      },
      memory: {
        total: fullData.memory.total,
        total_human: fullData.memory.total_human
      },
      network: {
        interfaces: fullData.network.interfaces.map(iface => ({
          interface: iface.interface,
          type: iface.type,
          speed: iface.speed,
          ip4: iface.ip4,
          ip6: iface.ip6,
          mac: iface.mac
        }))
      }
    };

    this.staticDataCache.set('system-static-data', {
      data: staticData,
      timestamp: Date.now()
    });
  }

  /**
   * Extract only dynamic data from full system load data
   */
  extractDynamicData(fullData) {
    return {
      cpu: {
        load: fullData.cpu.load,
        cores: fullData.cpu.cores.map(core => ({
          number: core.number,
          load: core.load,
          temperature: core.temperature
        }))
      },
      temperature: fullData.temperature,
      memory: {
        free: fullData.memory.free,
        free_human: fullData.memory.free_human,
        used: fullData.memory.used,
        used_human: fullData.memory.used_human,
        dirty: fullData.memory.dirty,
        percentage: fullData.memory.percentage
      },
      network: {
        interfaces: fullData.network.interfaces.map(iface => ({
          interface: iface.interface,
          state: iface.state,
          statistics: iface.statistics
        })),
        summary: fullData.network.summary
      }
    };
  }

  /**
   * Emit system load update after system changes (called from other services)
   */
  async emitSystemLoadUpdate() {
    try {
      const room = this.io.adapter.rooms.get('system-load');
      if (room && room.size > 0) {
        // Clear cache
        this.dataCache.delete('system-load-data');
        this.dataCache.delete('system-load-dynamic');
        // Send update with full data to refresh all clients
        await this.sendSystemLoadUpdate(null, true, true);
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
