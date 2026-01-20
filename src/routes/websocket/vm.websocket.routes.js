const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: VM WebSocket
 *   description: Real-time VM monitoring via WebSocket
 *
 * components:
 *   schemas:
 *     WebSocketVmUsageSubscription:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 *           description: JWT authentication token
 *           example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     WebSocketVmUsageUpdate:
 *       type: object
 *       description: VM usage data for all VMs
 *       properties:
 *         vms:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: VM name
 *                 example: "Debian"
 *               state:
 *                 type: string
 *                 enum: [running, stopped]
 *                 example: "running"
 *               cpu:
 *                 type: object
 *                 properties:
 *                   usage:
 *                     type: number
 *                     description: CPU usage percentage (0-100)
 *                     example: 25.3
 *                   unit:
 *                     type: string
 *                     example: "%"
 *               memory:
 *                 type: object
 *                 properties:
 *                   bytes:
 *                     type: integer
 *                     description: Memory usage in bytes
 *                     example: 4294967296
 *                   formatted:
 *                     type: string
 *                     description: Memory usage formatted in GiB
 *                     example: "4.00 GiB"
 *         timestamp:
 *           type: number
 *           description: Unix timestamp in milliseconds
 *           example: 1234567890123
 *
 * /vm/websocket/stats:
 *   get:
 *     summary: Get WebSocket monitoring statistics
 *     tags: [VM WebSocket]
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
 *                           example: 2000
 *                         isActive:
 *                           type: boolean
 *                           example: true
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 *
 * /vm/websocket/events:
 *   get:
 *     summary: WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for real-time VM usage monitoring.
 *
 *       **Connection:** Connect to WebSocket at `/api/v1/vm` namespace
 *
 *       **Events to emit (client → server):**
 *
 *       - `subscribe-vm-usage`: Subscribe to VM usage updates (all VMs or single VM via `name` param)
 *       - `unsubscribe-vm-usage`: Unsubscribe from VM usage updates
 *       - `get-vm-usage`: Get immediate VM usage data (one-time)
 *       - `get-vm-machines`: Get all VMs with full details (one-time, like GET /vm/machines)
 *
 *       **Events to listen for (server → client):**
 *
 *       - `vm-usage-update`: Real-time VM usage data (every ~2s, includes 1s CPU measurement)
 *       - `vm-machines-update`: Full VM details (response to get-vm-machines)
 *       - `vm-usage-subscription-confirmed`: Subscription confirmation
 *       - `vm-usage-unsubscription-confirmed`: Unsubscription confirmation
 *       - `error`: General error messages
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```javascript
 *       const socket = io('http://localhost:3000/api/v1/vm', {
 *         path: '/api/v1/socket.io/'
 *       });
 *       ```
 *
 *       Subscribe to VM usage updates:
 *       ```javascript
 *       socket.emit('subscribe-vm-usage', {
 *         token: 'your-jwt-token'
 *       });
 *       ```
 *
 *       Listen for updates:
 *       ```javascript
 *       socket.on('vm-usage-update', (data) => {
 *         data.vms.forEach(vm => {
 *           console.log(`${vm.name}: ${vm.state}`);
 *           if (vm.state === 'running') {
 *             console.log(`  CPU: ${vm.cpu.usage}%`);
 *             console.log(`  RAM: ${vm.memory.formatted}`);
 *           }
 *         });
 *       });
 *       ```
 *
 *       Unsubscribe:
 *       ```javascript
 *       socket.emit('unsubscribe-vm-usage', {
 *         token: 'your-jwt-token'
 *       });
 *       ```
 *     tags: [VM WebSocket]
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
    namespace: '/api/v1/vm',
    description: 'Real-time VM usage monitoring via WebSocket',
    events: {
      client_to_server: [
        {
          event: 'subscribe-vm-usage',
          description: 'Subscribe to real-time VM usage updates (all VMs or single VM)',
          payload: {
            token: 'JWT token (required)',
            name: 'VM name (optional, omit for all VMs)'
          }
        },
        {
          event: 'unsubscribe-vm-usage',
          description: 'Unsubscribe from VM usage updates',
          payload: {
            token: 'JWT token (required)'
          }
        },
        {
          event: 'get-vm-usage',
          description: 'Get immediate VM usage data (one-time request)',
          payload: {
            token: 'JWT token (required)'
          }
        },
        {
          event: 'get-vm-machines',
          description: 'Get all VMs with full details (one-time, like GET /vm/machines)',
          payload: {
            token: 'JWT token (required)'
          }
        }
      ],
      server_to_client: [
        {
          event: 'vm-usage-update',
          description: 'Real-time VM usage data for all VMs',
          payload: {
            vms: [
              {
                name: 'Debian',
                state: 'running',
                cpu: { usage: 25.3, unit: '%' },
                memory: { bytes: 4294967296, formatted: '4.00 GiB' }
              },
              {
                name: 'Windows',
                state: 'stopped',
                cpu: { usage: 0, unit: '%' },
                memory: { bytes: 0, formatted: '0 GiB' }
              }
            ],
            timestamp: 1234567890123
          }
        },
        {
          event: 'vm-machines-update',
          description: 'Full VM details (response to get-vm-machines)',
          payload: {
            machines: [
              {
                name: 'Debian',
                state: 'running',
                disks: [{ target: 'vda', source: '/path/to/disk.qcow2' }],
                vncPort: 5900,
                autostart: true,
                index: 1,
                icon: 'debian',
                description: 'Web Server',
                xmlEdited: false
              }
            ],
            timestamp: 1234567890123
          }
        },
        {
          event: 'vm-usage-subscription-confirmed',
          description: 'Confirmation of successful subscription',
          payload: {
            interval: '2000ms (includes 1s CPU measurement)'
          }
        },
        {
          event: 'vm-usage-unsubscription-confirmed',
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
        event: 'subscribe-vm-usage',
        description: 'Subscribe to all VMs',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      },
      subscribe_single: {
        event: 'subscribe-vm-usage',
        description: 'Subscribe to single VM',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          name: 'Debian'
        }
      },
      get_usage: {
        event: 'get-vm-usage',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      },
      get_machines: {
        event: 'get-vm-machines',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      }
    },
    notes: {
      update_interval: 'Updates are sent every ~2 seconds (includes 1 second for CPU measurement)',
      stopped_vms: 'Stopped VMs are included with state="stopped" and 0 values for CPU/memory',
      cpu_pinning: 'CPU usage respects VM CPU pinning configuration',
      memory_format: 'Memory is always formatted in GiB'
    }
  });
});

/**
 * @swagger
 * /vm/websocket/stats:
 *   get:
 *     summary: Get VM WebSocket statistics
 *     description: Returns current statistics for the VM usage WebSocket
 *     tags: [VM WebSocket]
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
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     activeSubscriptions:
 *                       type: integer
 *                       description: Number of active VM usage subscriptions
 *                       example: 3
 *                     clientCount:
 *                       type: integer
 *                       description: Total connected clients
 *                       example: 5
 *                     subscription:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         interval:
 *                           type: integer
 *                           description: Update interval in milliseconds
 *                           example: 2000
 *                         isActive:
 *                           type: boolean
 *                           example: true
 *       500:
 *         description: VM WebSocket manager not initialized or error
 */
router.get('/websocket/stats', authenticateToken, async (req, res) => {
  try {
    // Get WebSocket manager instance from app locals
    const vmWebSocketManager = req.app.locals.vmWebSocketManager;

    if (!vmWebSocketManager) {
      return res.status(500).json({
        success: false,
        message: 'VM WebSocket manager not initialized'
      });
    }

    const stats = vmWebSocketManager.getStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('Error getting VM WebSocket stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get VM WebSocket statistics',
      error: error.message
    });
  }
});

module.exports = router;
