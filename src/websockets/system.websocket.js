class SystemLoadWebSocketManager {
  constructor(io, systemService, poolsService = null, disksService = null) {
    this.io = io;
    this.systemService = systemService;
    this.poolsService = poolsService;
    this.disksService = disksService;
    this.activeSubscriptions = new Map();
    this.dataCache = new Map();
    this.staticDataCache = new Map();
    this.clientStaticDataSent = new Set();
    this.authCache = new Map();
    this.authCacheDuration = 5 * 60 * 1000; // 5 minutes
    this.cacheDuration = 1500;
    this.cpuStaticCacheDuration = 30 * 60 * 1000; // 30 minutes for static CPU data
    this.cpuLoadCacheDuration = 1000; // 1 second for CPU load data
    this.cpuTempCacheDuration = 5000; // 5 seconds for CPU temperature data
    this.memoryStaticCacheDuration = 30 * 60 * 1000; // 30 minutes for memory static data
    this.memoryServicesCacheDuration = 16 * 1000; // 16 seconds for memory services data
    this.networkStaticCacheDuration = 30 * 60 * 1000; // 30 minutes for network static data
    this.cpuInterval = 1000;
    this.memoryInterval = 8000;
    this.networkInterval = 2000;
    this.poolsPerformanceInterval = 2000; // 2 seconds for pools performance
    this.poolsTemperatureInterval = 10000; // 10 seconds for pools temperature

    // Client preferences for pools
    this.clientPoolsPreferences = new Map(); // socketId -> { includePools, includePerformance }

    // Start cache cleanup timer (every 10 minutes)
    setInterval(() => this.cleanupExpiredCaches(), 10 * 60 * 1000);
  }

  /**
   * Handle WebSocket connection for system load monitoring
   */
  handleConnection(socket) {
    // Only log when client actually subscribes to system load events

    // Subscribe to system load updates (always includes pools + performance)
    socket.on('subscribe-load', async (data) => {
      try {
        const { token } = data || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        socket.userId = authResult.user.userId;
        socket.userRole = authResult.user.role;
        socket.user = authResult.user;

        // Store user for byte format preferences
        this.clientPoolsPreferences.set(socket.id, { user: authResult.user });

        // Join system load room
        socket.join('system-load');
        console.log(`Client ${socket.id} (${authResult.user.role}) subscribed to system load monitoring`);

        // Start disk stats sampling for pools performance
        if (this.disksService && !this.disksService.isDiskStatsSamplingActive()) {
          this.disksService.startDiskStatsSampling(this.poolsPerformanceInterval);
        }

        // Send immediate full update (includes static data)
        await this.sendSystemLoadUpdate(socket, true, true);

        // Send initial pools data
        if (this.poolsService) {
          await this.sendInitialPoolsData(socket);
        }

        // Start monitoring (CPU/Memory/Network + Pools Performance + Pools Temperature)
        this.startSystemLoadMonitoring();
        this.startPoolsPerformanceMonitoring();
        this.startPoolsTemperatureMonitoring();

        socket.emit('load-subscription-confirmed', {
          cpuInterval: this.cpuInterval,
          memoryInterval: this.memoryInterval,
          networkInterval: this.networkInterval,
          poolsPerformanceInterval: this.poolsPerformanceInterval,
          poolsTemperatureInterval: this.poolsTemperatureInterval
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
      this.clientPoolsPreferences.delete(socket.id);
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

        // Get first connected user for data formatting (cached for efficiency)
        const user = this.getFirstConnectedUser();

        // Get CPU dynamic data only (fast updates for load/temperature)
        const dynamicData = await this.getCpuDynamicDataWithCache(false, user);

        // Get static data for complete structure (ensure it's available)
        let staticData = this.getStaticCpuData();
        if (!staticData) {
          // Fallback: load static data if not cached yet
          staticData = await this.cacheStaticCpuData();
        }

        // Combine for complete CPU update (frontend expects full structure)
        const cpuUpdate = {
          cpu: {
            info: staticData.cpu.info,
            load: dynamicData.cpu.load,
            cores: staticData.cpu.cores.map((staticCore, index) => ({
              ...staticCore,
              load: dynamicData.cpu.cores[index]?.load,
              temperature: dynamicData.cpu.cores[index]?.temperature
            }))
          },
          temperature: dynamicData.temperature
        };

        this.io.to('system-load').emit('load-update', cpuUpdate);
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

        // Get first connected user for data formatting (cached for efficiency)
        const user = this.getFirstConnectedUser();

        // Get Memory and Uptime data and send update
        const [memoryData, uptime] = await Promise.all([
          this.getMemoryDataWithCache(false, user),
          this.systemService.getUptime()
        ]);

        const memoryWithUptime = {
          ...memoryData,
          uptime: uptime
        };

        this.io.to('system-load').emit('load-update', memoryWithUptime);
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

        // Get first connected user for data formatting (cached for efficiency)
        const user = this.getFirstConnectedUser();

        // Get Network data and send update
        const networkData = await this.getNetworkDataWithCache(false, user);
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

    // Stop Pools Performance monitoring
    this.stopPoolsPerformanceMonitoring();
    this.stopPoolsTemperatureMonitoring();

    // Clear caches
    this.dataCache.delete('cpu-data');
    this.dataCache.delete('memory-data');
    this.dataCache.delete('network-data');
    this.dataCache.delete('pools-data');
    this.staticDataCache.clear();
    this.clientStaticDataSent.clear();
    this.clientPoolsPreferences.clear();

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

  // ============================================================
  // POOLS PERFORMANCE MONITORING (for Dashboard)
  // ============================================================

  /**
   * Send initial pools data to a client (full pool info + performance + temperature per disk)
   */
  async sendInitialPoolsData(socket) {
    if (!this.poolsService) return;

    try {
      const prefs = this.clientPoolsPreferences.get(socket.id);
      const user = prefs?.user || socket.user;

      // Get all pools
      const pools = await this.poolsService.listPools();

      // Add performance and temperature data to each disk and pool total
      const poolsWithData = await Promise.all(pools.map(async pool => {
        const enrichedPool = { ...pool };

        if (this.disksService) {
          // Add performance + temperature to data_devices
          if (enrichedPool.data_devices) {
            enrichedPool.data_devices = await Promise.all(
              enrichedPool.data_devices.map(async disk => {
                const perf = this.disksService.getDiskThroughput(disk.device, user);
                const enrichedDisk = { ...disk, performance: perf };

                // Add temperature only if disk is active (won't wake standby disks)
                if (disk.powerStatus === 'active') {
                  const tempData = await this.disksService.getDiskTemperature(disk.device);
                  enrichedDisk.temperature = tempData?.temperature || null;
                } else {
                  enrichedDisk.temperature = null;
                }

                return enrichedDisk;
              })
            );
          }

          // Add performance + temperature to parity_devices
          if (enrichedPool.parity_devices) {
            enrichedPool.parity_devices = await Promise.all(
              enrichedPool.parity_devices.map(async disk => {
                const perf = this.disksService.getDiskThroughput(disk.device, user);
                const enrichedDisk = { ...disk, performance: perf };

                // Add temperature only if disk is active
                if (disk.powerStatus === 'active') {
                  const tempData = await this.disksService.getDiskTemperature(disk.device);
                  enrichedDisk.temperature = tempData?.temperature || null;
                } else {
                  enrichedDisk.temperature = null;
                }

                return enrichedDisk;
              })
            );
          }

          // Add pool-level total performance
          const devices = this.extractPoolDevices(pool);
          enrichedPool.performance = devices.length > 0
            ? this.disksService.getPoolThroughput(devices, user)
            : null;

          // Remove disks array from pool performance (already on each disk)
          if (enrichedPool.performance) {
            delete enrichedPool.performance.disks;
          }
        }

        return enrichedPool;
      }));

      socket.emit('load-update', {
        pools: poolsWithData,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error sending initial pools data:', error);
    }
  }

  /**
   * Start pools performance monitoring (every 2s)
   */
  startPoolsPerformanceMonitoring() {
    if (this.activeSubscriptions.has('system-load-pools-performance')) {
      return; // Already running
    }

    if (!this.poolsService || !this.disksService) {
      console.warn('[SystemWebSocket] PoolsService or DisksService not available');
      return;
    }

    const intervalId = setInterval(async () => {
      try {
        const room = this.io.adapter.rooms.get('system-load');
        if (!room || room.size === 0) {
          this.stopPoolsPerformanceMonitoring();
          return;
        }

        await this.broadcastPoolsPerformance();
      } catch (error) {
        console.error('Error in pools performance monitoring:', error);
      }
    }, this.poolsPerformanceInterval);

    this.activeSubscriptions.set('system-load-pools-performance', {
      intervalId,
      interval: this.poolsPerformanceInterval,
      startTime: Date.now(),
      type: 'pools-performance'
    });
  }

  /**
   * Stop pools performance monitoring
   */
  stopPoolsPerformanceMonitoring() {
    const sub = this.activeSubscriptions.get('system-load-pools-performance');
    if (sub) {
      clearInterval(sub.intervalId);
      this.activeSubscriptions.delete('system-load-pools-performance');
    }
  }

  /**
   * Start pools temperature monitoring (every 10s)
   */
  startPoolsTemperatureMonitoring() {
    if (this.activeSubscriptions.has('system-load-pools-temperature')) {
      return; // Already running
    }

    if (!this.poolsService || !this.disksService) {
      return;
    }

    const intervalId = setInterval(async () => {
      try {
        const room = this.io.adapter.rooms.get('system-load');
        if (!room || room.size === 0) {
          this.stopPoolsTemperatureMonitoring();
          return;
        }

        await this.broadcastPoolsTemperature();
      } catch (error) {
        console.error('Error in pools temperature monitoring:', error);
      }
    }, this.poolsTemperatureInterval);

    this.activeSubscriptions.set('system-load-pools-temperature', {
      intervalId,
      interval: this.poolsTemperatureInterval,
      startTime: Date.now(),
      type: 'pools-temperature'
    });
  }

  /**
   * Stop pools temperature monitoring
   */
  stopPoolsTemperatureMonitoring() {
    const sub = this.activeSubscriptions.get('system-load-pools-temperature');
    if (sub) {
      clearInterval(sub.intervalId);
      this.activeSubscriptions.delete('system-load-pools-temperature');
    }
  }

  /**
   * Broadcast pools temperature updates to all clients
   */
  async broadcastPoolsTemperature() {
    const room = this.io.adapter.rooms.get('system-load');
    if (!room) return;

    try {
      // Get all pools once
      const pools = await this.poolsService.listPools();

      // Collect all unique disks from all pools
      const poolsTemperatures = [];

      for (const pool of pools) {
        const devices = this.extractPoolDevices(pool);
        const temperatures = [];

        for (const device of devices) {
          const baseDiskPath = this.disksService._getBaseDisk(device);
          const baseDisk = baseDiskPath.replace('/dev/', '');

          // Skip duplicates within the same pool
          if (temperatures.some(t => t.device === baseDisk)) continue;

          const tempData = await this.disksService.getDiskTemperature(baseDisk);
          temperatures.push({
            device: baseDisk,
            temperature: tempData?.temperature || null,
            status: tempData?.status || 'unknown'
          });
        }

        poolsTemperatures.push({
          id: pool.id || pool.name,
          name: pool.name,
          temperatures
        });
      }

      // Send to all clients
      this.io.to('system-load').emit('load-update', {
        poolsTemperatures: poolsTemperatures,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error broadcasting pools temperature:', error);
    }
  }

  /**
   * Broadcast pools performance updates to all clients
   * Performance is attached to each disk (data_devices/parity_devices)
   */
  async broadcastPoolsPerformance() {
    const room = this.io.adapter.rooms.get('system-load');
    if (!room) return;

    try {
      // Get all pools once
      const pools = await this.poolsService.listPools();

      // Send to each client
      for (const socketId of room) {
        const socket = this.io.sockets.get(socketId);
        if (!socket) continue;

        const prefs = this.clientPoolsPreferences.get(socketId);
        const user = prefs?.user || socket.user;

        // Build performance update for each pool
        const poolsPerformance = pools.map(pool => {
          const result = {
            id: pool.id || pool.name,
            name: pool.name
          };

          // Add performance per disk in data_devices
          if (pool.data_devices) {
            result.data_devices = pool.data_devices.map(disk => ({
              id: disk.id,
              device: disk.device,
              performance: this.disksService.getDiskThroughput(disk.device, user)
            }));
          }

          // Add performance per disk in parity_devices
          if (pool.parity_devices) {
            result.parity_devices = pool.parity_devices.map(disk => ({
              id: disk.id,
              device: disk.device,
              performance: this.disksService.getDiskThroughput(disk.device, user)
            }));
          }

          // Add pool-level total performance (without disks array)
          const devices = this.extractPoolDevices(pool);
          const poolPerf = devices.length > 0
            ? this.disksService.getPoolThroughput(devices, user)
            : null;

          if (poolPerf) {
            delete poolPerf.disks;
          }
          result.performance = poolPerf;

          return result;
        });

        socket.emit('load-update', {
          pools: poolsPerformance,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('Error broadcasting pools performance:', error);
    }
  }

  /**
   * Extract disk devices from a pool structure
   */
  extractPoolDevices(pool) {
    const devices = [];
    if (!pool) return devices;

    // Handle data_devices array (MergerFS/SnapRAID style)
    if (pool.data_devices && Array.isArray(pool.data_devices)) {
      for (const disk of pool.data_devices) {
        if (disk.device) devices.push(disk.device);
      }
    }

    // Handle parity_devices array (SnapRAID parity)
    if (pool.parity_devices && Array.isArray(pool.parity_devices)) {
      for (const disk of pool.parity_devices) {
        if (disk.device) devices.push(disk.device);
      }
    }

    // Handle disks array
    if (pool.disks && Array.isArray(pool.disks)) {
      for (const disk of pool.disks) {
        if (disk.device) devices.push(disk.device);
        else if (disk.path) devices.push(disk.path);
      }
    }

    // Handle vdevs structure (ZFS-style)
    if (pool.vdevs && Array.isArray(pool.vdevs)) {
      for (const vdev of pool.vdevs) {
        if (vdev.disks && Array.isArray(vdev.disks)) {
          for (const disk of vdev.disks) {
            if (disk.device) devices.push(disk.device);
            else if (disk.path) devices.push(disk.path);
          }
        }
      }
    }

    // Handle devices array directly
    if (pool.devices && Array.isArray(pool.devices)) {
      for (const device of pool.devices) {
        if (typeof device === 'string') devices.push(device);
        else if (device.device) devices.push(device.device);
        else if (device.path) devices.push(device.path);
      }
    }

    return devices;
  }

  /**
   * Get first connected user from system-load room for data formatting
   */
  getFirstConnectedUser() {
    const room = this.io.adapter.rooms.get('system-load');
    if (!room || room.size === 0) return null;

    // Use iterator for better performance than Array.from()
    const iterator = room.keys();
    const firstSocketId = iterator.next().value;
    const socketObj = firstSocketId ? this.io.sockets.get(firstSocketId) : null;
    return socketObj?.user || null;
  }

  /**
   * Send initial system load data to new client
   * @param {Object} socket - Socket to send to
   * @param {boolean} forceRefresh - Force cache refresh
   */
  async sendSystemLoadUpdate(socket, forceRefresh = false, sendFullData = false) {
    try {
      // Get all data types for initial connection including uptime
      const [cpuData, memoryData, networkData, uptime] = await Promise.all([
        this.getCombinedCpuData(socket.user),
        this.getMemoryDataWithCache(forceRefresh, socket.user),
        this.getNetworkDataWithCache(forceRefresh, socket.user),
        this.systemService.getUptime()
      ]);

      const loadData = {
        ...cpuData,
        ...memoryData,
        ...networkData,
        uptime: uptime
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
   * Get full CPU data with caching (static + dynamic)
   */
  async getCpuDataWithCache(forceRefresh = false, user = null) {
    const cacheKey = 'cpu-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      const cpuData = await this.systemService.getCpuLoad(user);

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
   * Get CPU load data with caching (1 second cache)
   */
  async getCpuLoadDataWithCache(forceRefresh = false) {
    const cacheKey = 'cpu-load-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cpuLoadCacheDuration) {
      return cached.data;
    }

    try {
      const loadData = await this.systemService.getCpuLoadOnly();

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: loadData,
        timestamp: Date.now()
      });

      return loadData;

    } catch (error) {
      console.error('Error getting CPU load data:', error);
      throw error;
    }
  }

  /**
   * Get CPU temperature data with caching (5 seconds cache)
   */
  async getCpuTempDataWithCache(forceRefresh = false) {
    const cacheKey = 'cpu-temp-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cpuTempCacheDuration) {
      return cached.data;
    }

    try {
      const tempData = await this.systemService.getCpuTemperatureOnly();

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: tempData,
        timestamp: Date.now()
      });

      return tempData;

    } catch (error) {
      console.error('Error getting CPU temperature data:', error);
      throw error;
    }
  }

  /**
   * Get combined CPU dynamic data (load + temperature) with optimized caching
   */
  async getCpuDynamicDataWithCache(forceRefresh = false, user = null) {
    try {
      // Get load and temperature data with different cache durations
      const [loadData, tempData] = await Promise.all([
        this.getCpuLoadDataWithCache(forceRefresh),
        this.getCpuTempDataWithCache(forceRefresh)
      ]);

      // Combine load and temperature data
      const dynamicData = {
        cpu: {
          load: loadData.load,
          cores: loadData.cores.map((core, index) => ({
            number: core.number,
            load: core.load,
            temperature: tempData.cores[index] || null
          }))
        },
        temperature: tempData.temperature
      };

      return dynamicData;

    } catch (error) {
      console.error('Error getting combined CPU dynamic data:', error);
      throw error;
    }
  }

  /**
   * Get Memory data with caching
   */
  async getMemoryDataWithCache(forceRefresh = false, user = null) {
    const cacheKey = 'memory-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      const memoryData = await this.systemService.getMemoryLoad(user);

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
  async getNetworkDataWithCache(forceRefresh = false, user = null) {
    const cacheKey = 'network-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      const networkData = await this.systemService.getNetworkLoad(user);

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
   * Cache static CPU data separately (long-term cache)
   */
  async cacheStaticCpuData() {
    try {
      const staticCpuInfo = await this.systemService.getCpuStaticInfo();

      const staticCpuData = {
        cpu: {
          info: staticCpuInfo,
          cores: staticCpuInfo.cores
        }
      };

      this.staticDataCache.set('cpu-static-data', {
        data: staticCpuData,
        timestamp: Date.now()
      });

      return staticCpuData;
    } catch (error) {
      console.error('Error caching static CPU data:', error);
      throw error;
    }
  }

  /**
   * Get static CPU data (cached for long time)
   */
  getStaticCpuData() {
    const cached = this.staticDataCache.get('cpu-static-data');
    if (cached && (Date.now() - cached.timestamp) < this.cpuStaticCacheDuration) {
      return cached.data;
    }
    return null; // Need to load fresh
  }

  /**
   * Get combined CPU data (static + dynamic) for initial connection
   */
  async getCombinedCpuData(user = null) {
    let staticData = this.getStaticCpuData();

    // If no static data cached, load and cache it
    if (!staticData) {
      staticData = await this.cacheStaticCpuData();
    }

    // Get dynamic data
    const dynamicData = await this.getCpuDynamicDataWithCache(false, user);

    // Combine static and dynamic data properly
    const combinedCpuData = {
      cpu: {
        info: staticData.cpu.info,
        load: dynamicData.cpu.load,
        cores: staticData.cpu.cores.map((staticCore, index) => ({
          ...staticCore,
          load: dynamicData.cpu.cores[index]?.load,
          temperature: dynamicData.cpu.cores[index]?.temperature
        }))
      },
      temperature: dynamicData.temperature
    };

    return combinedCpuData;
  }

  /**
   * Cache static memory data (installed memory, services breakdown)
   */
  async cacheStaticMemoryData() {
    try {
      const staticMemoryInfo = await this.systemService.getMemoryStaticInfo();

      this.staticDataCache.set('memory-static-data', {
        data: staticMemoryInfo,
        timestamp: Date.now()
      });

      return staticMemoryInfo;
    } catch (error) {
      console.error('Error caching static memory data:', error);
      throw error;
    }
  }

  /**
   * Get static memory data (cached for long time)
   */
  getStaticMemoryData() {
    const cached = this.staticDataCache.get('memory-static-data');
    if (cached && (Date.now() - cached.timestamp) < this.memoryStaticCacheDuration) {
      return cached.data;
    }
    return null; // Need to load fresh
  }

  /**
   * Get memory services data with 16-second cache
   */
  async getMemoryServicesData() {
    const cacheKey = 'memory-services-data';
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid
    if (cached && (Date.now() - cached.timestamp) < this.memoryServicesCacheDuration) {
      return cached.data;
    }

    try {
      const servicesData = await this.systemService.getMemoryDynamicServices();

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: servicesData,
        timestamp: Date.now()
      });

      return servicesData;

    } catch (error) {
      console.error('Error getting memory services data:', error);
      throw error;
    }
  }

  /**
   * Cache static network data (interface details)
   */
  async cacheStaticNetworkData() {
    try {
      const staticNetworkInfo = await this.systemService.getNetworkStaticInterfaces();

      this.staticDataCache.set('network-static-data', {
        data: staticNetworkInfo,
        timestamp: Date.now()
      });

      return staticNetworkInfo;
    } catch (error) {
      console.error('Error caching static network data:', error);
      throw error;
    }
  }

  /**
   * Get static network data (cached for long time)
   */
  getStaticNetworkData() {
    const cached = this.staticDataCache.get('network-static-data');
    if (cached && (Date.now() - cached.timestamp) < this.networkStaticCacheDuration) {
      return cached.data;
    }
    return null; // Need to load fresh
  }

  /**
   * Cache static system data separately (memory, network - CPU handled separately)
   */
  cacheStaticData(fullData) {
    const staticData = {
      memory: null, // Memory static data is minimal
      network: null
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
        this.dataCache.delete('cpu-load-data');
        this.dataCache.delete('cpu-temp-data');
        this.dataCache.delete('memory-data');
        this.dataCache.delete('memory-services-data');
        this.dataCache.delete('network-data');
        // Force immediate updates
        const [cpuData, memoryData, networkData] = await Promise.all([
          this.getCombinedCpuData(),
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
   * Clean up expired cache entries
   */
  cleanupExpiredCaches() {
    const now = Date.now();

    // Clean auth cache
    for (const [token, cached] of this.authCache) {
      if (now - cached.timestamp > this.authCacheDuration) {
        this.authCache.delete(token);
      }
    }

    // Clean data cache
    for (const [key, cached] of this.dataCache) {
      let duration = this.cacheDuration;
      if (key === 'cpu-load-data') {
        duration = this.cpuLoadCacheDuration;
    } else if (key === 'cpu-temp-data') {
      duration = this.cpuTempCacheDuration;
    } else if (key === 'memory-services-data') {
      duration = this.memoryServicesCacheDuration;
      }
      if (now - cached.timestamp > duration) {
        this.dataCache.delete(key);
      }
    }

    // Clean static CPU data cache
    const staticCpuCache = this.staticDataCache.get('cpu-static-data');
    if (staticCpuCache && now - staticCpuCache.timestamp > this.cpuStaticCacheDuration) {
      this.staticDataCache.delete('cpu-static-data');
    }

    // Clean static memory data cache
    const staticMemoryCache = this.staticDataCache.get('memory-static-data');
    if (staticMemoryCache && now - staticMemoryCache.timestamp > this.memoryStaticCacheDuration) {
      this.staticDataCache.delete('memory-static-data');
    }

    // Clean static network data cache
    const staticNetworkCache = this.staticDataCache.get('network-static-data');
    if (staticNetworkCache && now - staticNetworkCache.timestamp > this.networkStaticCacheDuration) {
      this.staticDataCache.delete('network-static-data');
    }
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
            isBootToken: true
          }
        };

        // Cache boot token authentication
        this.authCache.set(token, {
          data: result,
          timestamp: Date.now()
        });

        return result;
      }

      // Check if it's an admin API token
      const adminTokenData = await userService.validateAdminToken(token);
      if (adminTokenData) {
        const result = {
          success: true,
          user: adminTokenData
        };

        // Cache admin token authentication
        this.authCache.set(token, {
          data: result,
          timestamp: Date.now()
        });

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
          byte_format: currentUser.byte_format
        }
      };

      // Cache successful authentication
      this.authCache.set(token, {
        data: result,
        timestamp: Date.now()
      });

      return result;

    } catch (authError) {
      const errorResult = { success: false, message: 'Invalid authentication token' };

      // Cache failed authentication for shorter time (1 minute)
      this.authCache.set(token, {
        data: errorResult,
        timestamp: Date.now()
      });

      return errorResult;
    }
  }

}

module.exports = SystemLoadWebSocketManager;
