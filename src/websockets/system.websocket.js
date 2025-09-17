class SystemLoadWebSocketManager {
  constructor(io, systemService) {
    this.io = io;
    this.systemService = systemService;
    this.activeSubscriptions = new Map();
    this.dataCache = new Map();
    this.staticDataCache = new Map(); // Cache for static system data
    this.clientStaticDataSent = new Set(); // Track which clients received static data
    this.cacheDuration = 750; // 0.75 seconds cache
    this.cpuInterval = 1000; // 1 second CPU/Memory updates
    this.networkInterval = 2000; // 2 seconds Network updates
  }

  /**
   * Handle WebSocket connection for system load monitoring
   */
  handleConnection(socket) {
    // Only log when client actually subscribes to system load events

    // Subscribe to system load updates
    socket.on('subscribe-load', async (data) => {
      try {
        const { token } = data;

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
        this.startSystemLoadMonitoring();

        socket.emit('load-subscription-confirmed', {
          cpuInterval: this.cpuInterval,
          networkInterval: this.networkInterval
        });
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
   * Start monitoring system load with separate timers for CPU/Memory and Network
   */
  startSystemLoadMonitoring() {
    // Stop any existing monitoring first
    this.stopSystemLoadMonitoring();

    console.log(`Starting system load monitoring - CPU/Memory: ${this.cpuInterval}ms, Network: ${this.networkInterval}ms`);

    // CPU/Memory Timer - Fast updates (1 second)
    const cpuIntervalId = setInterval(async () => {
      try {
        // Check if anyone is still subscribed
        const room = this.io.adapter.rooms.get('system-load');
        if (!room || room.size === 0) {
          console.log('No clients subscribed to system load, stopping CPU monitoring');
          this.stopSystemLoadMonitoring();
          return;
        }

        // Get CPU/Memory data and send update
        const cpuData = await this.getCpuMemoryDataWithCache();
        this.io.to('system-load').emit('load-update', cpuData);
      } catch (error) {
        console.error('Error in CPU/Memory monitoring:', error);
      }
    }, this.cpuInterval);

    // Network Timer - Slower updates (2 seconds)
    const networkIntervalId = setInterval(async () => {
      try {
        // Check if anyone is still subscribed
        const room = this.io.adapter.rooms.get('system-load');
        if (!room || room.size === 0) {
          console.log('No clients subscribed to system load, stopping Network monitoring');
          this.stopSystemLoadMonitoring();
          return;
        }

        // Get Network data and send update
        const networkData = await this.getNetworkDataWithCache();
        this.io.to('system-load').emit('load-update', networkData);
      } catch (error) {
        console.error('Error in Network monitoring:', error);
      }
    }, this.networkInterval);

    // Store both timers
    this.activeSubscriptions.set('system-load-cpu', {
      intervalId: cpuIntervalId,
      interval: this.cpuInterval,
      startTime: Date.now(),
      type: 'cpu'
    });

    this.activeSubscriptions.set('system-load-network', {
      intervalId: networkIntervalId,
      interval: this.networkInterval,
      startTime: Date.now(),
      type: 'network'
    });
  }

  /**
   * Stop system load monitoring
   */
  stopSystemLoadMonitoring() {
    // Stop CPU monitoring
    const cpuSubscription = this.activeSubscriptions.get('system-load-cpu');
    if (cpuSubscription) {
      clearInterval(cpuSubscription.intervalId);
      this.activeSubscriptions.delete('system-load-cpu');
    }

    // Stop Network monitoring
    const networkSubscription = this.activeSubscriptions.get('system-load-network');
    if (networkSubscription) {
      clearInterval(networkSubscription.intervalId);
      this.activeSubscriptions.delete('system-load-network');
    }

    // Clear caches
    this.dataCache.delete('cpu-memory-data');
    this.dataCache.delete('network-data');
    this.staticDataCache.clear();
    this.clientStaticDataSent.clear();

    console.log('System load monitoring stopped');
  }

  /**
   * Check if monitoring should be stopped
   */
  checkStopSystemLoadMonitoring() {
    const room = this.io.adapter.rooms.get('system-load');
    if (!room || room.size === 0) {
      this.stopSystemLoadMonitoring();
    }
  }

  /**
   * Send initial system load data to new client
   * @param {Object} socket - Socket to send to
   * @param {boolean} forceRefresh - Force cache refresh
   */
  async sendSystemLoadUpdate(socket, forceRefresh = false, sendFullData = false) {
    try {
      // Get both CPU/Memory and Network data for initial connection
      const [cpuData, networkData] = await Promise.all([
        this.getCpuMemoryDataWithCache(forceRefresh),
        this.getNetworkDataWithCache(forceRefresh)
      ]);

      const loadData = {
        ...cpuData,
        ...networkData
      };

      // Mark client as having received static data
      this.clientStaticDataSent.add(socket.id);

      // Send initial complete data
      socket.emit('load-update', loadData);

    } catch (error) {
      console.error('Failed to send system load update:', error);
      socket.emit('error', {
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get CPU/Memory data with caching
   */
  async getCpuMemoryDataWithCache(forceRefresh = false) {
    const cacheKey = 'cpu-memory-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      const cpuData = await this.systemService.getCpuMemoryLoad();

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: cpuData,
        timestamp: Date.now()
      });

      // Cache static data separately (CPU data only)
      this.cacheStaticData(cpuData);

      return cpuData;

    } catch (error) {
      console.error('Error getting CPU/Memory data:', error);
      throw error;
    }
  }

  /**
   * Get Network data with caching
   */
  async getNetworkDataWithCache(forceRefresh = false) {
    const cacheKey = 'network-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      const networkData = await this.systemService.getNetworkLoad();

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: networkData,
        timestamp: Date.now()
      });

      return networkData;

    } catch (error) {
      console.error('Error getting Network data:', error);
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
      }
    };

    // Only add network data if it exists
    if (fullData.network && fullData.network.interfaces) {
      staticData.network = {
        interfaces: fullData.network.interfaces.map(iface => ({
          interface: iface.interface,
          type: iface.type,
          speed: iface.speed,
          ip4: iface.ip4,
          ip6: iface.ip6,
          mac: iface.mac
        }))
      };
    }

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
        // Clear caches
        this.dataCache.delete('cpu-memory-data');
        this.dataCache.delete('network-data');
        // Force immediate updates
        const [cpuData, networkData] = await Promise.all([
          this.getCpuMemoryDataWithCache(true),
          this.getNetworkDataWithCache(true)
        ]);
        // Send combined update
        const combinedData = { ...cpuData, ...networkData };
        this.io.to('system-load').emit('load-update', combinedData);
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
    const cpuSubscription = this.activeSubscriptions.get('system-load-cpu');
    const networkSubscription = this.activeSubscriptions.get('system-load-network');

    return {
      activeSubscriptions: this.activeSubscriptions.size,
      cachedData: this.dataCache.size,
      clientCount: room ? room.size : 0,
      subscriptions: {
        cpu: cpuSubscription ? {
          interval: cpuSubscription.interval,
          uptime: Date.now() - cpuSubscription.startTime,
          isActive: true
        } : null,
        network: networkSubscription ? {
          interval: networkSubscription.interval,
          uptime: Date.now() - networkSubscription.startTime,
          isActive: true
        } : null
      }
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
