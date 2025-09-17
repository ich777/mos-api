class SystemLoadWebSocketManager {
  constructor(io, systemService) {
    this.io = io;
    this.systemService = systemService;
    this.activeSubscriptions = new Map();
    this.dataCache = new Map();
    this.staticDataCache = new Map();
    this.clientStaticDataSent = new Set();
    this.cacheDuration = 750;
    this.cpuInterval = 1000;
    this.memoryInterval = 8000;
    this.networkInterval = 2000;
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
        socket.user = authResult.user;

        // Join system load room
        socket.join('system-load');
        console.log(`Client ${socket.id} (${authResult.user.role}) subscribed to system load monitoring`);

        // Send immediate full update (includes static data)
        await this.sendSystemLoadUpdate(socket, true, true);

        // Start monitoring
        this.startSystemLoadMonitoring();

        socket.emit('load-subscription-confirmed', {
          cpuInterval: this.cpuInterval,
          memoryInterval: this.memoryInterval,
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

    // Debug logging
    //console.log(`Starting system load monitoring - CPU: ${this.cpuInterval}ms, Memory: ${this.memoryInterval}ms, Network: ${this.networkInterval}ms`);

    // CPU Timer - Fastest updates (1 second)
    const cpuIntervalId = setInterval(async () => {
      try {
        // Check if anyone is still subscribed
        const room = this.io.adapter.rooms.get('system-load');
        if (!room || room.size === 0) {
          console.log('No clients subscribed to system load, stopping CPU monitoring');
          this.stopSystemLoadMonitoring();
          return;
        }

        // Get CPU data and send update
        const cpuData = await this.getCpuDataWithCache();
        this.io.to('system-load').emit('load-update', cpuData);
      } catch (error) {
        console.error('Error in CPU monitoring:', error);
      }
    }, this.cpuInterval);

    // Memory Timer - Medium updates (4 seconds)
    const memoryIntervalId = setInterval(async () => {
      try {
        // Check if anyone is still subscribed
        const room = this.io.adapter.rooms.get('system-load');
        if (!room || room.size === 0) {
          console.log('No clients subscribed to system load, stopping Memory monitoring');
          this.stopSystemLoadMonitoring();
          return;
        }

        // Get Memory data and send update
        const memoryData = await this.getMemoryDataWithCache();
        this.io.to('system-load').emit('load-update', memoryData);
      } catch (error) {
        console.error('Error in Memory monitoring:', error);
      }
    }, this.memoryInterval);

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

    // Store all timers
    this.activeSubscriptions.set('system-load-cpu', {
      intervalId: cpuIntervalId,
      interval: this.cpuInterval,
      startTime: Date.now(),
      type: 'cpu'
    });

    this.activeSubscriptions.set('system-load-memory', {
      intervalId: memoryIntervalId,
      interval: this.memoryInterval,
      startTime: Date.now(),
      type: 'memory'
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

    // Stop Memory monitoring
    const memorySubscription = this.activeSubscriptions.get('system-load-memory');
    if (memorySubscription) {
      clearInterval(memorySubscription.intervalId);
      this.activeSubscriptions.delete('system-load-memory');
    }

    // Stop Network monitoring
    const networkSubscription = this.activeSubscriptions.get('system-load-network');
    if (networkSubscription) {
      clearInterval(networkSubscription.intervalId);
      this.activeSubscriptions.delete('system-load-network');
    }

    // Clear caches
    this.dataCache.delete('cpu-data');
    this.dataCache.delete('memory-data');
    this.dataCache.delete('network-data');
    this.staticDataCache.clear();
    this.clientStaticDataSent.clear();

    // Debug logging
    //console.log('System load monitoring stopped');
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
      // Get all data types for initial connection
      const [cpuData, memoryData, networkData] = await Promise.all([
        this.getCpuDataWithCache(forceRefresh),
        this.getMemoryDataWithCache(forceRefresh),
        this.getNetworkDataWithCache(forceRefresh)
      ]);

      const loadData = {
        ...cpuData,
        ...memoryData,
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
   * Get CPU data with caching
   */
  async getCpuDataWithCache(forceRefresh = false) {
    const cacheKey = 'cpu-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      const cpuData = await this.systemService.getCpuLoad();

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: cpuData,
        timestamp: Date.now()
      });

      // Cache static data separately
      this.cacheStaticData(cpuData);

      return cpuData;

    } catch (error) {
      console.error('Error getting CPU data:', error);
      throw error;
    }
  }

  /**
   * Get Memory data with caching
   */
  async getMemoryDataWithCache(forceRefresh = false) {
    const cacheKey = 'memory-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      const memoryData = await this.systemService.getMemoryLoad();

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: memoryData,
        timestamp: Date.now()
      });

      return memoryData;

    } catch (error) {
      console.error('Error getting Memory data:', error);
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
      }
    };

    // Only add memory data if it exists
    if (fullData.memory) {
      staticData.memory = {
        total: fullData.memory.total,
        total_human: fullData.memory.total_human
      };
    }

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
        this.dataCache.delete('cpu-data');
        this.dataCache.delete('memory-data');
        this.dataCache.delete('network-data');
        // Force immediate updates
        const [cpuData, memoryData, networkData] = await Promise.all([
          this.getCpuDataWithCache(true),
          this.getMemoryDataWithCache(true),
          this.getNetworkDataWithCache(true)
        ]);
        // Send combined update
        const combinedData = { ...cpuData, ...memoryData, ...networkData };
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
    const memorySubscription = this.activeSubscriptions.get('system-load-memory');
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
        memory: memorySubscription ? {
          interval: memorySubscription.interval,
          uptime: Date.now() - memorySubscription.startTime,
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
