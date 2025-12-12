const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: System Load WebSocket
 *   description: Real-time system load monitoring via WebSocket
 *
 * components:
 *   schemas:
 *     WebSocketSystemLoadSubscription:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 *           description: JWT authentication token
 *           example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     WebSocketSystemLoadUpdate:
 *       type: object
 *       description: System load data (identical structure to GET /system/load response)
 *       properties:
 *         cpu:
 *           type: object
 *           properties:
 *             load:
 *               type: number
 *               description: Overall CPU load percentage
 *               example: 25.5
 *             info:
 *               type: object
 *               properties:
 *                 brand:
 *                   type: string
 *                   example: "Intel(R) Core(TM) i7-12700K"
 *                 manufacturer:
 *                   type: string
 *                   example: "Intel"
 *                 totalCores:
 *                   type: number
 *                   example: 20
 *                 physicalCores:
 *                   type: number
 *                   example: 12
 *             cores:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   number:
 *                     type: number
 *                     example: 1
 *                   load:
 *                     type: object
 *                     properties:
 *                       total:
 *                         type: number
 *                         example: 15.5
 *                   temperature:
 *                     type: number
 *                     nullable: true
 *                     example: 45.2
 *         temperature:
 *           type: object
 *           properties:
 *             main:
 *               type: number
 *               example: 42.0
 *             max:
 *               type: number
 *               example: 48.5
 *             min:
 *               type: number
 *               example: 38.2
 *         memory:
 *           type: object
 *           properties:
 *             total:
 *               type: number
 *               example: 34359738368
 *             total_human:
 *               type: string
 *               example: "32.00 GiB"
 *             used:
 *               type: number
 *               example: 8589934592
 *             used_human:
 *               type: string
 *               example: "8.00 GiB"
 *             percentage:
 *               type: object
 *               properties:
 *                 actuallyUsed:
 *                   type: number
 *                   example: 25
 *         network:
 *           type: object
 *           properties:
 *             interfaces:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   interface:
 *                     type: string
 *                     example: "eth0"
 *                   type:
 *                     type: string
 *                     example: "wired"
 *                   state:
 *                     type: string
 *                     example: "up"
 *                   statistics:
 *                     type: object
 *                     properties:
 *                       rx:
 *                         type: object
 *                         properties:
 *                           speed_bps:
 *                             type: number
 *                             example: 1048576
 *                           speed_human:
 *                             type: string
 *                             example: "1.00 MiB/s"
 *                       tx:
 *                         type: object
 *                         properties:
 *                           speed_bps:
 *                             type: number
 *                             example: 524288
 *                           speed_human:
 *                             type: string
 *                             example: "512.00 KiB/s"
 *         pools:
 *           type: array
 *           description: Pool data with performance and temperature (initial + every 2s)
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *                 example: "1746318722394"
 *               name:
 *                 type: string
 *                 example: "media"
 *               type:
 *                 type: string
 *                 example: "mergerfs"
 *               data_devices:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     device:
 *                       type: string
 *                       example: "/dev/sdj1"
 *                     powerStatus:
 *                       type: string
 *                       enum: [active, standby, unknown]
 *                     performance:
 *                       type: object
 *                       properties:
 *                         readSpeed:
 *                           type: number
 *                           example: 1048576
 *                         writeSpeed:
 *                           type: number
 *                           example: 524288
 *                         readSpeed_human:
 *                           type: string
 *                           example: "1.0 MB/s"
 *                         writeSpeed_human:
 *                           type: string
 *                           example: "512 KB/s"
 *                     temperature:
 *                       type: number
 *                       nullable: true
 *                       description: Temperature in Celsius (null if disk is in standby)
 *                       example: 35
 *               performance:
 *                 type: object
 *                 description: Pool-level total performance (sum of all disks)
 *                 properties:
 *                   readSpeed:
 *                     type: number
 *                   writeSpeed:
 *                     type: number
 *                   readSpeed_human:
 *                     type: string
 *                   writeSpeed_human:
 *                     type: string
 *         poolsTemperatures:
 *           type: array
 *           description: Pool temperatures only (every 10s)
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *               name:
 *                 type: string
 *               temperatures:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     device:
 *                       type: string
 *                       example: "sdj"
 *                     temperature:
 *                       type: number
 *                       nullable: true
 *                       example: 35
 *                     status:
 *                       type: string
 *                       enum: [active, standby, unknown]
 *
 * /system/websocket/stats:
 *   get:
 *     summary: Get WebSocket monitoring statistics
 *     tags: [System Load WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: WebSocket monitoring statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     activeSubscriptions:
 *                       type: number
 *                       description: Number of active monitoring subscriptions
 *                       example: 1
 *                     cachedData:
 *                       type: number
 *                       description: Number of cached data entries
 *                       example: 2
 *                     clientCount:
 *                       type: number
 *                       description: Number of connected clients
 *                       example: 3
 *                     subscription:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         interval:
 *                           type: number
 *                           description: Update interval in milliseconds
 *                           example: 10000
 *                         uptime:
 *                           type: number
 *                           description: Subscription uptime in milliseconds
 *                           example: 120000
 *                         isActive:
 *                           type: boolean
 *                           example: true
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 *
 * /system/websocket/events:
 *   get:
 *     summary: WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for real-time system load monitoring.
 *
 *       **Connection:** Connect to WebSocket at `/api/v1/system` namespace
 *
 *       **Events to emit (client → server):**
 *
 *       - `subscribe-load`: Subscribe to system load updates
 *       - `unsubscribe-load`: Unsubscribe from system load updates
 *       - `get-load`: Get immediate system load data (one-time)
 *
 *       **Events to listen for (server → client):**
 *
 *       - `load-update`: Real-time system data updates with different keys at different intervals:
 *         - `cpu`: CPU load data (every 1s)
 *         - `memory`: Memory and uptime data (every 8s)
 *         - `network`: Network interface statistics (every 2s)
 *         - `pools`: Pools with performance data per disk (initial + every 2s)
 *         - `poolsTemperatures`: Disk temperatures only (every 10s)
 *       - `load-subscription-confirmed`: Subscription confirmation with intervals
 *       - `load-unsubscription-confirmed`: Unsubscription confirmation
 *       - `error`: General error messages
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```
 *       const socket = io('http://localhost:3000/api/v1/system', {
 *         path: '/socket.io/'
 *       });
 *       ```
 *
 *       Subscribe to system load updates (pools always included):
 *       ```
 *       socket.emit('subscribe-load', {
 *         token: 'your-jwt-token'
 *       });
 *       ```
 *
 *       Listen for updates and merge by key:
 *       ```
 *       socket.on('load-update', (data) => {
 *         if (data.cpu) updateCpu(data.cpu);
 *         if (data.memory) updateMemory(data.memory);
 *         if (data.network) updateNetwork(data.network);
 *         if (data.pools) updatePools(data.pools);
 *         if (data.poolsTemperatures) updatePoolTemperatures(data.poolsTemperatures);
 *       });
 *       ```
 *     tags: [System Load WebSocket]
 *     responses:
 *       200:
 *         description: WebSocket events documentation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: object
 *                   properties:
 *                     client_to_server:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           event:
 *                             type: string
 *                           description:
 *                             type: string
 *                           payload:
 *                             $ref: '#/components/schemas/WebSocketSystemLoadSubscription'
 *                     server_to_client:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           event:
 *                             type: string
 *                           description:
 *                             type: string
 *                           payload:
 *                             $ref: '#/components/schemas/WebSocketSystemLoadUpdate'
 */

// WebSocket Events Documentation Endpoint
router.get('/websocket/events', (req, res) => {
  res.json({
    events: {
      client_to_server: [
        {
          event: 'subscribe-load',
          description: 'Subscribe to real-time system load updates (pools always included)',
          payload: {
            token: 'JWT token (required)'
          }
        },
        {
          event: 'unsubscribe-load',
          description: 'Unsubscribe from system load updates',
          payload: {}
        },
        {
          event: 'get-load',
          description: 'Get immediate system load data (one-time request)',
          payload: {
            token: 'JWT token'
          }
        }
      ],
      server_to_client: [
        {
          event: 'load-update',
          description: 'Real-time system data updates with different keys at different intervals',
          keys: {
            cpu: 'CPU load data (every 1s)',
            memory: 'Memory and uptime data (every 8s)',
            network: 'Network interface statistics (every 2s)',
            pools: 'Pools with performance data per disk (initial + every 2s)',
            poolsTemperatures: 'Disk temperatures only (every 10s)'
          }
        },
        {
          event: 'load-subscription-confirmed',
          description: 'Confirmation of successful subscription',
          payload: {
            cpuInterval: '1000ms',
            memoryInterval: '8000ms',
            networkInterval: '2000ms',
            poolsPerformanceInterval: '2000ms',
            poolsTemperatureInterval: '10000ms'
          }
        },
        {
          event: 'load-unsubscription-confirmed',
          description: 'Confirmation of successful unsubscription'
        },
        {
          event: 'error',
          description: 'General error messages'
        }
      ]
    },
    examples: {
      subscribe: {
        event: 'subscribe-load',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        },
        note: 'Pools with performance and temperature are always included'
      },
      get_immediate_load: {
        event: 'get-load',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      }
    },
    notes: {
      unified_event: 'All updates come via load-update event with different keys (cpu, memory, network, pools, poolsTemperatures)',
      byte_format: 'Human-readable values respect user byte_format preference (binary: MiB, GiB / decimal: MB, GB)',
      intervals: 'CPU: 1s, Memory: 8s, Network: 2s, Pools performance: 2s, Pools temperature: 10s',
      standby_disks: 'Standby disks have temperature=null to avoid waking them up'
    }
  });
});

// WebSocket Statistics Endpoint
router.get('/websocket/stats', authenticateToken, async (req, res) => {
  try {
    // Get WebSocket manager instance from app locals
    const systemLoadWebSocketManager = req.app.locals.systemLoadWebSocketManager;

    if (!systemLoadWebSocketManager) {
      return res.status(500).json({
        success: false,
        message: 'System Load WebSocket manager not initialized'
      });
    }

    const stats = systemLoadWebSocketManager.getMonitoringStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('Error getting System Load WebSocket stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get System Load WebSocket statistics',
      error: error.message
    });
  }
});

module.exports = router;
