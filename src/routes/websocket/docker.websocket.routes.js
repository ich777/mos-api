const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Docker WebSocket
 *   description: Real-time Docker operations via WebSocket
 *
 * components:
 *   schemas:
 *     DockerUpdateEvent:
 *       type: object
 *       properties:
 *         status:
 *           type: string
 *           enum: [started, running, completed, cancelled, error, operations-list]
 *           description: Status of the Docker operation
 *           example: "running"
 *         operationId:
 *           type: string
 *           description: Unique operation identifier
 *           example: "pull-1234567890-abc123"
 *         timestamp:
 *           type: number
 *           description: Unix timestamp in milliseconds
 *           example: 1234567890123
 *         operation:
 *           type: string
 *           description: Type of operation (present when status is 'started')
 *           example: "pull"
 *         output:
 *           type: string
 *           description: Live output from the operation (present when status is 'running')
 *           example: "Pulling from library/nginx..."
 *         stream:
 *           type: string
 *           enum: [stdout, stderr]
 *           description: Which output stream the data came from
 *         success:
 *           type: boolean
 *           description: Whether operation completed successfully (present when status is 'completed')
 *         duration:
 *           type: number
 *           description: Operation duration in milliseconds (present when status is 'completed')
 *         message:
 *           type: string
 *           description: Error or status message
 *         operations:
 *           type: array
 *           description: List of active operations (present when status is 'operations-list')
 *           items:
 *             type: object
 *
 * /docker/websocket/events:
 *   get:
 *     summary: WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for real-time Docker operations.
 *
 *       **Connection:** Connect to WebSocket at `/api/v1/docker` namespace
 *
 *       **Simplified Event System:**
 *
 *       **Events to emit (client → server):**
 *       - `docker` - Start a Docker operation (pull, upgrade, upgrade-group, create, check-updates)
 *       - `docker-cancel` - Cancel an ongoing operation
 *       - `docker-get-operations` - Get list of active operations
 *
 *       **Event to listen for (server → client):**
 *       - `docker-update` - **ONE** event for ALL updates (status-based)
 *
 *       **Status values in docker-update:**
 *       - `started` - Operation has started
 *       - `running` - Operation is running (contains `output` field with live data)
 *       - `completed` - Operation completed (contains `success` and `duration`)
 *       - `cancelled` - Operation was cancelled
 *       - `error` - Error occurred (contains `message`)
 *       - `operations-list` - Response to docker-get-operations (contains `operations[]`)
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```javascript
 *       const socket = io('http://localhost:3000/api/v1/docker', {
 *         path: '/api/v1/socket.io/'
 *       });
 *       ```
 *
 *       Pull a Docker image (with live streaming):
 *       ```javascript
 *       socket.emit('docker', {
 *         token: 'your-jwt-token',
 *         operation: 'pull',
 *         params: { image: 'nginx:latest' }
 *       });
 *       ```
 *       Note: Pull is only available via WebSocket (no REST alternative)
 *
 *       Listen for ALL updates with ONE event:
 *       ```javascript
 *       socket.on('docker-update', (data) => {
 *         const { status, operationId, output, message } = data;
 *
 *         switch(status) {
 *           case 'started':
 *             console.log(`Started: ${operationId}`);
 *             break;
 *           case 'running':
 *             console.log('Output:', output); // Live output
 *             break;
 *           case 'completed':
 *             console.log(data.success ? '✓ Success' : '✗ Failed');
 *             break;
 *           case 'cancelled':
 *             console.log('Operation cancelled');
 *             break;
 *           case 'error':
 *             console.error('Error:', message);
 *             break;
 *         }
 *       });
 *       ```
 *
 *       Upgrade all containers in a group (with live streaming):
 *       ```javascript
 *       socket.emit('docker', {
 *         token: 'your-jwt-token',
 *         operation: 'upgrade-group',
 *         params: {
 *           groupId: '1695384000123',
 *           force_update: false
 *         }
 *       });
 *       ```
 *       REST Alternative: `POST /api/v1/docker/mos/groups/{groupId}/upgrade`
 *       (waits for completion, no streaming)
 *
 *       Upgrade a single container (with live streaming):
 *       ```javascript
 *       socket.emit('docker', {
 *         token: 'your-jwt-token',
 *         operation: 'upgrade',
 *         params: { name: 'nginx', force_update: false }
 *       });
 *       ```
 *       REST Alternative: `POST /api/v1/docker/mos/upgrade`
 *       (waits for completion, no streaming)
 *
 *       Create a container (with live streaming):
 *       ```javascript
 *       socket.emit('docker', {
 *         token: 'your-jwt-token',
 *         operation: 'create',
 *         params: {
 *           template: {
 *             name: 'my-nginx',
 *             repo: 'nginx:latest',
 *             ports: [{ host: '8080', container: '80' }],
 *             // ... full template like REST endpoint
 *           }
 *         }
 *       });
 *       ```
 *       REST Alternative: `POST /api/v1/docker/mos/create`
 *       (waits for completion, no streaming)
 *
 *       Check for updates (with live streaming):
 *       ```javascript
 *       socket.emit('docker', {
 *         token: 'your-jwt-token',
 *         operation: 'check-updates',
 *         params: { name: 'nginx' } // or omit for all containers
 *       });
 *       ```
 *       REST Alternative: `POST /api/v1/docker/mos/update_check`
 *       (waits for completion, no streaming)
 *
 *       Get active operations after reconnect:
 *       ```javascript
 *       socket.emit('docker-get-operations', { token: 'your-jwt-token' });
 *
 *       socket.on('docker-update', (data) => {
 *         if (data.status === 'operations-list') {
 *           console.log('Active operations:', data.operations);
 *           // Client is automatically joined to operation rooms
 *         }
 *       });
 *       ```
 *
 *       Cancel an operation:
 *       ```javascript
 *       socket.emit('docker-cancel', {
 *         token: 'your-jwt-token',
 *         operationId: 'pull-1234567890-abc123'
 *       });
 *       ```
 *
 *       **Key Features:**
 *       - Operations run in background (disconnect doesn't kill process)
 *       - Only explicit `docker-cancel` stops the operation
 *       - Multiple clients can watch same operation via rooms
 *       - Reconnect and resume with `docker-get-operations`
 *
 *     tags: [Docker WebSocket]
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
 */

// WebSocket Events Documentation Endpoint
router.get('/websocket/events', (req, res) => {
  res.json({
    namespace: '/api/v1/docker',
    description: 'Simplified event system with ONE event for all updates',
    events: {
      client_to_server: [
        {
          event: 'docker',
          description: 'Start a Docker operation',
          payload: {
            token: 'JWT token (required)',
            operation: 'pull | upgrade | upgrade-group | create | check-updates',
            params: 'Operation-specific parameters'
          },
          examples: {
            pull: {
              token: 'eyJ...',
              operation: 'pull',
              params: { image: 'nginx:latest' }
            },
            upgrade: {
              token: 'eyJ...',
              operation: 'upgrade',
              params: { name: 'nginx', force_update: false }
            },
            'upgrade-group': {
              token: 'eyJ...',
              operation: 'upgrade-group',
              params: { groupId: '1695384000123', force_update: false }
            },
            create: {
              token: 'eyJ...',
              operation: 'create',
              params: {
                template: {
                  name: 'my-nginx',
                  repo: 'nginx:latest',
                  ports: [{ host: '8080', container: '80' }]
                  // ... full template
                }
              }
            }
          }
        },
        {
          event: 'docker-cancel',
          description: 'Cancel an ongoing operation',
          payload: {
            token: 'JWT token (required)',
            operationId: 'Operation ID to cancel'
          }
        },
        {
          event: 'docker-get-operations',
          description: 'Get list of active operations (useful after reconnect)',
          payload: {
            token: 'JWT token (required)'
          }
        }
      ],
      server_to_client: [
        {
          event: 'docker-update',
          description: 'ONE event for ALL updates (status-based)',
          payload: {
            status: 'started | running | completed | cancelled | error | operations-list',
            operationId: 'Unique operation identifier',
            timestamp: 'Unix timestamp in milliseconds',
            // Additional fields based on status:
            operation: 'Operation type (when status=started)',
            output: 'Live output text (when status=running)',
            stream: 'stdout or stderr (when status=running)',
            success: 'true/false (when status=completed)',
            duration: 'Duration in ms (when status=completed)',
            message: 'Error or status message (when status=error/cancelled)',
            operations: 'Array of active ops (when status=operations-list)'
          },
          examples: {
            started: {
              status: 'started',
              operationId: 'pull-1234567890-abc123',
              operation: 'pull',
              image: 'nginx:latest',
              timestamp: 1234567890123
            },
            running: {
              status: 'running',
              operationId: 'pull-1234567890-abc123',
              output: 'Pulling from library/nginx...',
              stream: 'stderr',
              timestamp: 1234567890456
            },
            completed: {
              status: 'completed',
              operationId: 'pull-1234567890-abc123',
              success: true,
              duration: 45230,
              timestamp: 1234567935353
            },
            error: {
              status: 'error',
              operationId: 'pull-1234567890-abc123',
              message: 'Failed to pull image: connection timeout',
              timestamp: 1234567890789
            }
          }
        }
      ]
    },
    comparison: {
      rest_endpoint: '/api/v1/docker/mos/*',
      websocket_advantages: [
        'Real-time output streaming',
        'No timeouts for large images',
        'Background execution (dialog close doesn\'t kill process)',
        'Cancel operations anytime',
        'Reconnect and resume',
        'Multiple clients can watch same operation'
      ],
      note: 'Both REST and WebSocket use the same internal functions (dockerService)'
    }
  });
});

/**
 * @swagger
 * /docker/websocket/stats:
 *   get:
 *     summary: Get WebSocket operation statistics
 *     description: Get statistics about active Docker operations via WebSocket (Admin only)
 *     tags: [Docker WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: WebSocket operation statistics
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
 *                     activeOperations:
 *                       type: number
 *                       description: Number of currently active operations
 *                     operations:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           operationId:
 *                             type: string
 *                           type:
 *                             type: string
 *                           operation:
 *                             type: string
 *                           duration:
 *                             type: number
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */

// WebSocket Statistics Endpoint
router.get('/websocket/stats', authenticateToken, async (req, res) => {
  try {
    // Get WebSocket manager instance from app locals
    const dockerWebSocketManager = req.app.locals.dockerWebSocketManager;

    if (!dockerWebSocketManager) {
      return res.status(500).json({
        success: false,
        message: 'Docker WebSocket manager not initialized'
      });
    }

    const stats = dockerWebSocketManager.getStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('Error getting Docker WebSocket stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get Docker WebSocket statistics',
      error: error.message
    });
  }
});

module.exports = router;
