
class PoolWebSocketManager {
  constructor(io, poolsService) {
    this.io = io;
    this.poolsService = poolsService;
    this.activeSubscriptions = new Map();
    this.dataCache = new Map();
    this.cacheDuration = 10000; // 10 seconds cache
  }

  /**
   * Handle WebSocket connection for pool monitoring
   */
  handleConnection(socket) {
    console.log(`Client connected for pool monitoring: ${socket.id}`);

    // Subscribe to pools with filters (replaces both single pool and all pools)
    socket.on('subscribe-pools', async (data) => {
      try {
        const { interval = 30000, token, filters = {} } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        socket.userId = authResult.user.userId;
        socket.userRole = authResult.user.role;

        // Join pools room
        socket.join('pools');
        console.log(`Client ${socket.id} (${authResult.user.role}) subscribed to pools with filters:`, filters);

        // Send immediate update
        await this.sendPoolsUpdate(socket, false, filters);

        // Start monitoring
        this.startPoolsMonitoring(interval, filters);

        socket.emit('pools-subscription-confirmed', { interval, filters });
      } catch (error) {
        console.error('Error in subscribe-pools:', error);
        socket.emit('error', { message: 'Failed to subscribe to pools updates' });
      }
    });

    // Unsubscribe from pools
    socket.on('unsubscribe-pools', () => {
      try {
        socket.leave('pools');
        console.log(`Client ${socket.id} unsubscribed from pools`);

        // Check if we should stop monitoring
        this.checkStopPoolsMonitoring();

        socket.emit('pools-unsubscription-confirmed');
      } catch (error) {
        console.error('Error in unsubscribe-pools:', error);
      }
    });

    // Get immediate pools data (one-time request)
    socket.on('get-pools', async (data) => {
      try {
        const { token, filters = {} } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        await this.sendPoolsUpdate(socket, true, filters); // Force refresh
      } catch (error) {
        console.error('Error in get-pools:', error);
        socket.emit('error', { message: 'Failed to get pools data' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      // Socket.io automatically handles room cleanup
      // Check if monitoring needs to be stopped
      this.checkStopPoolsMonitoring();
    });
  }

  /**
   * Start monitoring pools with filters if not already active
   */
  startPoolsMonitoring(interval = 30000, filters = {}) {
    const monitoringKey = `pools-${JSON.stringify(filters)}`;

    if (this.activeSubscriptions.has(monitoringKey)) {
      return; // Already monitoring
    }

    console.log(`Starting pools monitoring with ${interval}ms interval and filters:`, filters);

    const intervalId = setInterval(async () => {
      try {
        // Check if anyone is still subscribed
        const room = this.io.sockets.adapter.rooms.get('pools');
        if (!room || room.size === 0) {
          console.log('No clients subscribed to pools, stopping monitoring');
          clearInterval(intervalId);
          this.activeSubscriptions.delete(monitoringKey);
          return;
        }

        // Send update to all subscribers with same filters
        await this.sendPoolsUpdate(null, false, filters);
      } catch (error) {
        console.error('Error in pools monitoring:', error);
      }
    }, interval);

    this.activeSubscriptions.set(monitoringKey, {
      intervalId,
      interval,
      startTime: Date.now(),
      filters
    });
  }

  /**
   * Check if monitoring should be stopped
   */
  checkStopPoolsMonitoring() {
    const room = this.io.sockets.adapter.rooms.get('pools');
    if (!room || room.size === 0) {
      // Stop all monitoring subscriptions
      for (const [key, subscription] of this.activeSubscriptions) {
        if (key.startsWith('pools-')) {
          console.log(`Stopping pools monitoring: ${key}`);
          clearInterval(subscription.intervalId);
          this.activeSubscriptions.delete(key);
        }
      }
      // Clear all pools cache
      for (const [key] of this.dataCache) {
        if (key.startsWith('pools-data-') || key.startsWith('pools-last-hash-')) {
          this.dataCache.delete(key);
        }
      }
    }
  }

  /**
   * Send pools update to socket or room
   * Uses same data structure as REST API GET /pools
   */
  async sendPoolsUpdate(socket, forceRefresh = false, filters = {}) {
    try {
      const poolsData = await this.getPoolsDataWithCache(forceRefresh, filters);

      // Generate hash of current data for change detection
      const currentHash = this.generateDataHash(poolsData);
      const lastHashKey = `pools-last-hash-${JSON.stringify(filters)}`;
      const lastHash = this.dataCache.get(lastHashKey);

      // Only send if data actually changed or it's a forced refresh
      if (!forceRefresh && lastHash === currentHash) {
        return;
      }

      // Store new hash
      this.dataCache.set(lastHashKey, currentHash);

      // Send pools data as pure array, identical to REST API GET /pools
      if (socket) {
        socket.emit('pools-update', poolsData);
      } else {
        this.io.to('pools').emit('pools-update', poolsData);
      }

      console.log('Pools data changed, update sent to clients with filters:', filters);

    } catch (error) {
      console.error('Failed to send pools update:', error);

      const errorMsg = {
        error: error.message,
        timestamp: new Date().toISOString()
      };

      if (socket) {
        socket.emit('error', errorMsg);
      } else {
        this.io.to('pools').emit('error', errorMsg);
      }
    }
  }

  /**
   * Get pools data with caching (includes complete disk details)
   * Reuses the pools service method to maintain consistency with REST API
   */
  async getPoolsDataWithCache(forceRefresh = false, filters = {}) {
    const cacheKey = `pools-data-${JSON.stringify(filters)}`;
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      // Use pools service with same filtering as REST API GET /pools
      const pools = await this.poolsService.listPools(filters);

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: pools,
        timestamp: Date.now()
      });

      return pools;

    } catch (error) {
      console.error('Error getting pools data:', error);
      throw error;
    }
  }


  /**
   * Emit pools update after file operations (called from other services)
   */
  async emitPoolsUpdate(poolId = null) {
    try {
      const room = this.io.sockets.adapter.rooms.get('pools');
      if (room && room.size > 0) {
        // Clear all pools cache to force fresh data
        for (const [key] of this.dataCache) {
          if (key.startsWith('pools-data-') || key.startsWith('pools-last-hash-')) {
            this.dataCache.delete(key);
          }
        }
        // Send update with no filters to get all pools
        await this.sendPoolsUpdate(null, true, {});
      }
    } catch (error) {
      console.error('Failed to emit pools update:', error);
    }
  }

  /**
   * Cleanup when clients disconnect
   */
  cleanupDisconnectedClient() {
    // Check if monitoring should be stopped
    this.checkStopPoolsMonitoring();
  }

  /**
   * Get monitoring statistics
   */
  getMonitoringStats() {
    const stats = {
      activeSubscriptions: this.activeSubscriptions.size,
      cachedPools: this.dataCache.size,
      subscriptions: []
    };

    for (const [poolId, subscription] of this.activeSubscriptions) {
      const room = this.io.sockets.adapter.rooms.get(`pool-${poolId}`);
      stats.subscriptions.push({
        poolId,
        clientCount: room ? room.size : 0,
        interval: subscription.interval,
        uptime: Date.now() - subscription.startTime
      });
    }

    return stats;
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


  /**
   * Generate hash for change detection
   */
  generateDataHash(data) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
  }

}

module.exports = PoolWebSocketManager;
