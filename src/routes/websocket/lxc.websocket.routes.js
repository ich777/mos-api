const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     LxcContainerUsage:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Container name
 *           example: "webserver"
 *         state:
 *           type: string
 *           description: Container state (running/stopped)
 *           example: "running"
 *         autostart:
 *           type: boolean
 *           description: Whether container starts on boot
 *           example: true
 *         unprivileged:
 *           type: boolean
 *           description: Whether container is unprivileged
 *           example: true
 *         architecture:
 *           type: string
 *           nullable: true
 *           description: Container architecture (e.g., amd64, arm64)
 *           example: "amd64"
 *         cpu:
 *           type: object
 *           properties:
 *             usage:
 *               type: number
 *               description: CPU usage percentage
 *               example: 15.2
 *             unit:
 *               type: string
 *               example: "%"
 *         memory:
 *           type: object
 *           properties:
 *             bytes:
 *               type: integer
 *               description: Memory usage in bytes
 *               example: 536870912
 *             formatted:
 *               type: string
 *               description: Memory usage formatted
 *               example: "512.00 MiB"
 *         network:
 *           type: object
 *           properties:
 *             ipv4:
 *               type: array
 *               items:
 *                 type: string
 *               example: ["192.168.1.100"]
 *             ipv6:
 *               type: array
 *               items:
 *                 type: string
 *               example: []
 *             docker:
 *               type: array
 *               items:
 *                 type: string
 *               example: ["172.17.0.2"]
 *             all:
 *               type: array
 *               items:
 *                 type: string
 *               example: ["192.168.1.100", "172.17.0.2"]
 *
 *     LxcContainerUsageUpdate:
 *       type: object
 *       properties:
 *         containers:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/LxcContainerUsage'
 *         timestamp:
 *           type: integer
 *           description: Unix timestamp in milliseconds
 *           example: 1234567890123
 *
 *     LxcContainersUpdate:
 *       type: object
 *       properties:
 *         containers:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: "webserver"
 *               state:
 *                 type: string
 *                 example: "running"
 *               autostart:
 *                 type: boolean
 *                 example: true
 *               unprivileged:
 *                 type: boolean
 *                 example: true
 *               architecture:
 *                 type: string
 *                 example: "amd64"
 *               index:
 *                 type: integer
 *                 example: 1
 *               description:
 *                 type: string
 *                 example: "Web Server"
 *         timestamp:
 *           type: integer
 *           example: 1234567890123
 */

/**
 * @swagger
 * /lxc/websocket/events:
 *   get:
 *     summary: WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for real-time LXC container usage monitoring.
 *
 *       **Connection:** Connect to WebSocket at `/api/v1/lxc` namespace
 *
 *       **Events to emit (client → server):**
 *
 *       - `subscribe-container-usage`: Subscribe to container usage updates (all or single via `name` param)
 *       - `unsubscribe-container-usage`: Unsubscribe from container usage updates
 *       - `get-container-usage`: Get immediate container usage data (one-time)
 *       - `get-lxc-containers`: Get all containers with full details (one-time, like GET /lxc/containers)
 *
 *       **Events to listen for (server → client):**
 *
 *       - `container-usage-update`: Real-time container usage data (every ~2s)
 *       - `lxc-containers-update`: Full container details (response to get-lxc-containers)
 *       - `container-usage-subscription-confirmed`: Subscription confirmation
 *       - `container-usage-unsubscription-confirmed`: Unsubscription confirmation
 *       - `error`: General error messages
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```javascript
 *       const socket = io('http://localhost:3000/api/v1/lxc', {
 *         path: '/api/v1/socket.io/'
 *       });
 *       ```
 *
 *       Subscribe to all containers:
 *       ```javascript
 *       socket.emit('subscribe-container-usage', { token: 'your-jwt-token' });
 *       ```
 *
 *       Subscribe to single container:
 *       ```javascript
 *       socket.emit('subscribe-container-usage', { token: 'your-jwt-token', name: 'webserver' });
 *       ```
 *
 *       Listen for updates:
 *       ```javascript
 *       socket.on('container-usage-update', (data) => {
 *         console.log('Container usage:', data.containers);
 *       });
 *       ```
 *     tags: [LXC WebSocket]
 *     responses:
 *       200:
 *         description: WebSocket events documentation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 namespace:
 *                   type: string
 *                   example: "/api/v1/lxc"
 *                 events:
 *                   type: object
 */

// WebSocket Events Documentation Endpoint
router.get('/websocket/events', (req, res) => {
  res.json({
    namespace: '/api/v1/lxc',
    description: 'Real-time LXC container usage monitoring via WebSocket',
    events: {
      client_to_server: [
        {
          event: 'subscribe-container-usage',
          description: 'Subscribe to real-time container usage updates (all or single container)',
          payload: {
            token: 'JWT token (required)',
            name: 'Container name (optional, omit for all containers)'
          }
        },
        {
          event: 'unsubscribe-container-usage',
          description: 'Unsubscribe from container usage updates',
          payload: {
            token: 'JWT token (required)'
          }
        },
        {
          event: 'get-container-usage',
          description: 'Get immediate container usage data (one-time request)',
          payload: {
            token: 'JWT token (required)'
          }
        },
        {
          event: 'get-lxc-containers',
          description: 'Get all containers with full details (one-time, like GET /lxc/containers)',
          payload: {
            token: 'JWT token (required)'
          }
        }
      ],
      server_to_client: [
        {
          event: 'container-usage-update',
          description: 'Real-time container usage data',
          payload: {
            containers: [
              {
                name: 'webserver',
                state: 'running',
                autostart: true,
                unprivileged: true,
                architecture: 'amd64',
                cpu: { usage: 15.2, unit: '%' },
                memory: { bytes: 536870912, formatted: '512.00 MiB' },
                network: {
                  ipv4: ['192.168.1.100'],
                  ipv6: [],
                  docker: ['172.17.0.2'],
                  all: ['192.168.1.100', '172.17.0.2']
                }
              },
              {
                name: 'database',
                state: 'stopped',
                autostart: false,
                unprivileged: true,
                architecture: 'amd64',
                cpu: { usage: 0, unit: '%' },
                memory: { bytes: 0, formatted: '0 Bytes' },
                network: { ipv4: [], ipv6: [], docker: [], all: [] }
              }
            ],
            timestamp: 1234567890123
          }
        },
        {
          event: 'lxc-containers-update',
          description: 'Full container details (response to get-lxc-containers)',
          payload: {
            containers: [
              {
                name: 'webserver',
                state: 'running',
                autostart: true,
                unprivileged: true,
                architecture: 'amd64',
                index: 1,
                description: 'Web Server'
              }
            ],
            timestamp: 1234567890123
          }
        },
        {
          event: 'container-usage-subscription-confirmed',
          description: 'Confirmation of successful subscription',
          payload: {
            interval: '2000ms',
            filter: 'all or container name'
          }
        },
        {
          event: 'container-usage-unsubscription-confirmed',
          description: 'Confirmation of successful unsubscription'
        },
        {
          event: 'error',
          description: 'General error messages',
          payload: {
            message: 'Error description'
          }
        }
      ]
    },
    examples: {
      subscribe_all: {
        event: 'subscribe-container-usage',
        description: 'Subscribe to all containers',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      },
      subscribe_single: {
        event: 'subscribe-container-usage',
        description: 'Subscribe to single container',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          name: 'webserver'
        }
      },
      get_usage: {
        event: 'get-container-usage',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      },
      get_containers: {
        event: 'get-lxc-containers',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      }
    },
    notes: {
      update_interval: 'Updates are sent every ~2 seconds (includes 1 second for CPU measurement)',
      stopped_containers: 'Stopped containers are included with state="stopped" and 0 values for CPU/memory',
      network_info: 'Network information includes IPv4, IPv6, and Docker bridge IPs'
    }
  });
});

/**
 * @swagger
 * /lxc/websocket/stats:
 *   get:
 *     summary: Get LXC WebSocket statistics
 *     description: Returns current statistics for the LXC container usage WebSocket
 *     tags: [LXC WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: WebSocket statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activeSubscriptions:
 *                   type: integer
 *                   description: Number of active container usage subscriptions
 *                   example: 3
 *                 clientCount:
 *                   type: integer
 *                   description: Total connected clients
 *                   example: 5
 *                 subscription:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     interval:
 *                       type: integer
 *                       description: Update interval in milliseconds
 *                       example: 2000
 *                     isActive:
 *                       type: boolean
 *                       example: true
 *       503:
 *         description: LXC WebSocket manager not initialized
 */
router.get('/websocket/stats', authenticateToken, async (req, res) => {
  try {
    const lxcWebSocketManager = req.app.locals.lxcWebSocketManager;

    if (!lxcWebSocketManager) {
      return res.status(503).json({
        error: 'LXC WebSocket manager not initialized'
      });
    }

    const stats = lxcWebSocketManager.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
