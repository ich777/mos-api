const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Disks WebSocket
 *   description: Real-time disk I/O throughput and temperature monitoring via WebSocket
 *
 * components:
 *   schemas:
 *     WebSocketDisksSubscription:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 *           description: JWT authentication token
 *           example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *         devices:
 *           type: array
 *           description: List of device names to monitor. Empty array = all disks
 *           items:
 *             type: string
 *           example: ["sda", "sdb", "nvme0n1"]
 *         includeTemperature:
 *           type: boolean
 *           description: Include disk temperature data (every 10s)
 *           default: true
 *           example: true
 *     WebSocketDiskThroughput:
 *       type: object
 *       properties:
 *         device:
 *           type: string
 *           description: Device name
 *           example: "sda"
 *         readSpeed:
 *           type: number
 *           description: Current read speed in bytes/s
 *           example: 52428800
 *         writeSpeed:
 *           type: number
 *           description: Current write speed in bytes/s
 *           example: 10485760
 *         readSpeed_human:
 *           type: string
 *           description: Human-readable read speed (respects user byte_format preference)
 *           example: "50 MiB/s"
 *         writeSpeed_human:
 *           type: string
 *           description: Human-readable write speed
 *           example: "10 MiB/s"
 *         readBytes_total:
 *           type: number
 *           description: Total bytes read since boot
 *           example: 1099511627776
 *         writeBytes_total:
 *           type: number
 *           description: Total bytes written since boot
 *           example: 549755813888
 *         readBytes_total_human:
 *           type: string
 *           example: "1 TiB"
 *         writeBytes_total_human:
 *           type: string
 *           example: "512 GiB"
 *         timestamp:
 *           type: number
 *           example: 1702296720000
 *     WebSocketDiskTemperature:
 *       type: object
 *       properties:
 *         device:
 *           type: string
 *           example: "sda"
 *         temperature:
 *           type: number
 *           nullable: true
 *           description: Temperature in Celsius (null if standby or unavailable)
 *           example: 35
 *         status:
 *           type: string
 *           enum: [active, standby, error]
 *           description: Disk power status
 *           example: "active"
 *         timestamp:
 *           type: number
 *           example: 1702296720000
 *     WebSocketDisksUpdate:
 *       type: object
 *       properties:
 *         throughput:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/WebSocketDiskThroughput'
 *         temperature:
 *           type: array
 *           nullable: true
 *           items:
 *             $ref: '#/components/schemas/WebSocketDiskTemperature'
 *         timestamp:
 *           type: number
 *           example: 1702296720000
 *
 * /disks/websocket/stats:
 *   get:
 *     summary: Get Disks WebSocket monitoring statistics
 *     tags: [Disks WebSocket]
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
 *                     clientCount:
 *                       type: number
 *                       description: Number of connected clients
 *                       example: 2
 *                     samplingActive:
 *                       type: boolean
 *                       description: Whether background I/O sampling is active
 *                       example: true
 *                     subscriptions:
 *                       type: object
 *                       properties:
 *                         throughput:
 *                           type: object
 *                           nullable: true
 *                           properties:
 *                             interval:
 *                               type: number
 *                               example: 2000
 *                             isActive:
 *                               type: boolean
 *                         temperature:
 *                           type: object
 *                           nullable: true
 *                           properties:
 *                             interval:
 *                               type: number
 *                               example: 10000
 *                             isActive:
 *                               type: boolean
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 *
 * /disks/websocket/events:
 *   get:
 *     summary: Disks WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for real-time disk monitoring.
 *
 *       **Connection:** Connect to WebSocket at `/disks` namespace with path `/api/v1/socket.io/`
 *
 *       **Events to emit (client → server):**
 *
 *       - `subscribe-disks`: Subscribe to disk throughput and temperature updates
 *       - `unsubscribe-disks`: Unsubscribe from disk updates
 *       - `get-disks`: Get immediate disk data (one-time)
 *
 *       **Events to listen for (server → client):**
 *
 *       - `disks-update`: Real-time throughput data (every 2s)
 *       - `disks-temperature-update`: Temperature data (every 10s if includeTemperature=true)
 *       - `disks-subscription-confirmed`: Subscription confirmation
 *       - `disks-unsubscription-confirmed`: Unsubscription confirmation
 *       - `error`: Error messages
 *
 *       **Important Notes:**
 *       - Standby disks are NOT woken up for temperature queries
 *       - Throughput comes from /proc/diskstats (no disk wake-up)
 *       - Temperature uses `smartctl -n standby` (safe for standby disks)
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```javascript
 *       const socket = io('http://localhost:3000/disks', {
 *         path: '/api/v1/socket.io/'
 *       });
 *       ```
 *
 *       Subscribe to all disks with temperature:
 *       ```javascript
 *       socket.emit('subscribe-disks', {
 *         token: 'your-jwt-token',
 *         devices: [],  // empty = all disks
 *         includeTemperature: true
 *       });
 *       ```
 *
 *       Subscribe to specific disks:
 *       ```javascript
 *       socket.emit('subscribe-disks', {
 *         token: 'your-jwt-token',
 *         devices: ['sda', 'sdb'],
 *         includeTemperature: false
 *       });
 *       ```
 *
 *       Listen for updates:
 *       ```javascript
 *       socket.on('disks-update', (data) => {
 *         console.log('Throughput:', data.throughput);
 *       });
 *
 *       socket.on('disks-temperature-update', (data) => {
 *         console.log('Temperatures:', data.temperatures);
 *       });
 *       ```
 *     tags: [Disks WebSocket]
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
 *                     server_to_client:
 *                       type: array
 *                       items:
 *                         type: object
 */

// WebSocket Events Documentation Endpoint
router.get('/websocket/events', (req, res) => {
  res.json({
    events: {
      client_to_server: [
        {
          event: 'subscribe-disks',
          description: 'Subscribe to real-time disk throughput and temperature updates',
          payload: {
            token: 'JWT token (required)',
            devices: 'Array of device names (optional, empty = all disks)',
            includeTemperature: 'boolean (optional, default: true) - Include temperature data'
          }
        },
        {
          event: 'unsubscribe-disks',
          description: 'Unsubscribe from disk updates',
          payload: {}
        },
        {
          event: 'get-disks',
          description: 'Get immediate disk data (one-time request)',
          payload: {
            token: 'JWT token (required)',
            devices: 'Array of device names (optional)',
            includeTemperature: 'boolean (optional)'
          }
        }
      ],
      server_to_client: [
        {
          event: 'disks-update',
          description: 'Real-time throughput data (sent every 2 seconds)',
          payload: {
            throughput: 'Array of { device, readSpeed, writeSpeed, readSpeed_human, writeSpeed_human, ... }',
            temperature: 'Array of temperatures (only on initial subscription)',
            timestamp: 'Unix timestamp'
          }
        },
        {
          event: 'disks-temperature-update',
          description: 'Temperature data (sent every 10 seconds if includeTemperature=true)',
          payload: {
            temperatures: 'Array of { device, temperature, status }',
            timestamp: 'Unix timestamp'
          }
        },
        {
          event: 'disks-subscription-confirmed',
          description: 'Confirmation of successful subscription',
          payload: {
            throughputInterval: '2000 (ms)',
            temperatureInterval: '10000 (ms) or null if not requested',
            devices: 'Subscribed devices or "all"'
          }
        },
        {
          event: 'disks-unsubscription-confirmed',
          description: 'Confirmation of successful unsubscription'
        },
        {
          event: 'error',
          description: 'Error messages'
        }
      ]
    },
    examples: {
      subscribe_all_disks: {
        event: 'subscribe-disks',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          devices: [],
          includeTemperature: true
        }
      },
      subscribe_specific_disks: {
        event: 'subscribe-disks',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          devices: ['sda', 'sdb', 'nvme0n1'],
          includeTemperature: false
        }
      }
    },
    notes: {
      standby_safety: 'Standby disks are NOT woken up. Temperature queries use smartctl -n standby.',
      throughput_source: 'I/O throughput is read from /proc/diskstats (kernel statistics, no disk access)',
      byte_format: 'Human-readable values respect user byte_format preference (binary: MiB, GiB / decimal: MB, GB)'
    }
  });
});

router.get('/websocket/stats', authenticateToken, async (req, res) => {
  try {
    // Get WebSocket manager instance from app locals
    const disksWebSocketManager = req.app.locals.disksWebSocketManager;

    if (!disksWebSocketManager) {
      return res.status(500).json({
        success: false,
        message: 'Disks WebSocket manager not initialized'
      });
    }

    const stats = disksWebSocketManager.getMonitoringStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('Error getting Disks WebSocket stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get WebSocket statistics',
      error: error.message
    });
  }
});

module.exports = router;
