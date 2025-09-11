const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');

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
 *         interval:
 *           type: number
 *           description: Update interval in milliseconds
 *           default: 10000
 *           example: 10000
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
 *       **Connection:** Connect to WebSocket at `/` namespace
 *
 *       **Events to emit (client → server):**
 *
 *       - `subscribe-load`: Subscribe to system load updates
 *       - `unsubscribe-load`: Unsubscribe from system load updates
 *       - `get-load`: Get immediate system load data (one-time)
 *
 *       **Events to listen for (server → client):**
 *
 *       - `load-update`: Real-time system load data updates
 *       - `load-subscription-confirmed`: Subscription confirmation
 *       - `load-unsubscription-confirmed`: Unsubscription confirmation
 *       - `error`: General error messages
 *
 *       **Example Usage:**
 *       ```javascript
 *       const socket = io();
 *
 *       // Subscribe to system load updates
 *       socket.emit('subscribe-load', {
 *         token: 'your-jwt-token',
 *         interval: 10000
 *       });
 *
 *       // Listen for updates
 *       socket.on('load-update', (data) => {
 *         console.log('System load updated:', data);
 *         console.log('CPU Load:', data.cpu.load + '%');
 *         console.log('Memory Used:', data.memory.percentage.actuallyUsed + '%');
 *       });
 *
 *       // Get immediate data
 *       socket.emit('get-load', {
 *         token: 'your-jwt-token'
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
          description: 'Subscribe to real-time system load updates',
          payload: {
            interval: 10000,
            token: 'JWT token'
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
          description: 'Real-time system load data updates (identical to GET /system/load response)',
          payload: 'System load object (same as GET /system/load)'
        },
        {
          event: 'load-subscription-confirmed',
          description: 'Confirmation of successful subscription',
          payload: {
            interval: 'Update interval'
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
      subscribe_system_load: {
        event: 'subscribe-load',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          interval: 10000
        }
      },
      get_immediate_load: {
        event: 'get-load',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      }
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
