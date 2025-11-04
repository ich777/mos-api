const { spawn } = require('child_process');
const EventEmitter = require('events');

class DockerWebSocketManager extends EventEmitter {
  constructor(io, dockerService) {
    super();
    this.io = io;
    this.dockerService = dockerService;
    this.activeOperations = new Map(); // operationId -> { process, type, startTime, operation, params }
  }

  /**
   * Handle WebSocket connection for Docker operations
   */
  handleConnection(socket) {
    console.log(`Docker WebSocket client connected: ${socket.id}`);

    // Start a Docker operation (pull, upgrade, create, etc.)
    socket.on('docker', async (data) => {
      try {
        const { token, operation, params } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, null, 'error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          this.sendUpdate(socket, null, 'error', { message: 'Admin role required for Docker operations' });
          return;
        }

        socket.userId = authResult.user.userId;
        socket.userRole = authResult.user.role;
        socket.user = authResult.user;

        console.log(`Client ${socket.id} starting Docker operation: ${operation}`);

        // Generate unique operation ID
        const operationId = `${operation}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

        // Join operation room so client can receive updates even after reconnect
        socket.join(`operation-${operationId}`);

        // Execute the operation based on type
        switch (operation) {
          case 'upgrade':
            await this.executeUpgrade(operationId, params);
            break;
          case 'pull':
            await this.executePull(operationId, params);
            break;
          case 'create':
            await this.executeCreate(operationId, params);
            break;
          case 'check-updates':
            await this.executeCheckUpdates(operationId, params);
            break;
          default:
            this.sendUpdate(socket, operationId, 'error', {
              message: `Unknown operation: ${operation}`
            });
        }

      } catch (error) {
        console.error('Error in docker event:', error);
        this.sendUpdate(socket, null, 'error', { message: error.message });
      }
    });

    // Get list of active operations
    socket.on('docker-get-operations', async (data) => {
      try {
        const { token } = data || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, null, 'error', { message: authResult.message });
          return;
        }

        const operations = [];
        for (const [operationId, operation] of this.activeOperations.entries()) {
          operations.push({
            operationId,
            type: operation.type,
            operation: operation.operation,
            params: operation.params,
            duration: Date.now() - operation.startTime,
            status: 'running'
          });
        }

        socket.emit('docker-update', {
          status: 'operations-list',
          operations
        });

        // Join all active operation rooms so client receives future updates
        for (const operationId of this.activeOperations.keys()) {
          socket.join(`operation-${operationId}`);
        }

      } catch (error) {
        console.error('Error in docker-get-operations:', error);
        this.sendUpdate(socket, null, 'error', { message: 'Failed to get operations' });
      }
    });

    // Cancel an ongoing operation
    socket.on('docker-cancel', async (data) => {
      try {
        const { token, operationId } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, operationId, 'error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          this.sendUpdate(socket, operationId, 'error', { message: 'Admin role required' });
          return;
        }

        await this.cancelOperation(operationId);

      } catch (error) {
        console.error('Error in docker-cancel:', error);
        this.sendUpdate(socket, null, 'error', { message: 'Failed to cancel operation' });
      }
    });

    // Handle disconnect - DON'T kill processes, they run in background
    socket.on('disconnect', () => {
      console.log(`Docker WebSocket client disconnected: ${socket.id}`);
      // Don't cleanup operations - they continue running!
    });
  }

  /**
   * Send update to operation room (all connected clients for this operation)
   */
  sendUpdate(target, operationId, status, data = {}) {
    const payload = {
      status,
      operationId,
      timestamp: Date.now(),
      ...data
    };

    if (operationId) {
      // Broadcast to all clients in this operation's room
      this.io.to(`operation-${operationId}`).emit('docker-update', payload);
    } else {
      // Send only to specific socket if no operationId
      if (target && target.emit) {
        target.emit('docker-update', payload);
      }
    }
  }

  /**
   * Execute Docker upgrade operation with streaming output
   */
  async executeUpgrade(operationId, params) {
    const { name, forceUpdate } = params || {};

    this.sendUpdate(null, operationId, 'started', {
      operation: 'upgrade',
      name: name || 'all containers'
    });

    try {
      const scriptPath = '/usr/local/bin/mos-update_containers';
      const args = [];

      if (name) args.push(name);
      if (forceUpdate) args.push('force_update');

      await this.executeCommandWithStream(operationId, scriptPath, args, 'upgrade', params);

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Upgrade failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker pull operation with streaming output
   */
  async executePull(operationId, params) {
    const { image } = params || {};

    if (!image) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Image parameter is required for pull operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'pull',
      image
    });

    try {
      const dockerPath = '/usr/bin/docker';
      const args = ['pull', image];

      await this.executeCommandWithStream(operationId, dockerPath, args, 'pull', params);

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Pull failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker container creation with streaming output
   */
  async executeCreate(operationId, params) {
    const { template } = params || {};

    if (!template) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Template parameter is required for create operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'create',
      name: template.name
    });

    try {
      const fileName = `${template.name.replace(/[^A-Za-z0-9\-_.]/g, '_')}.json`;
      const scriptPath = '/usr/local/bin/mos-deploy_docker';
      const fs = require('fs').promises;
      const path = require('path');

      // Validate template first
      this.dockerService.validateContainerTemplate(template);

      // Write template to file
      const templatesDir = '/boot/config/system/docker/templates';
      const filePath = path.join(templatesDir, fileName);

      // Check if template already exists
      let templateExists = false;
      try {
        await fs.access(filePath);
        templateExists = true;
      } catch (err) {
        // Template doesn't exist yet
      }

      await fs.writeFile(filePath, JSON.stringify(template, null, 2), 'utf8');

      const args = [fileName];
      if (templateExists) {
        args.push('recreate_container');
      }

      await this.executeCommandWithStream(
        operationId,
        scriptPath,
        args,
        'create',
        params,
        { cwd: templatesDir }
      );

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Create failed: ${error.message}`
      });
    }
  }

  /**
   * Execute check for updates operation
   */
  async executeCheckUpdates(operationId, params) {
    const { name } = params || {};

    this.sendUpdate(null, operationId, 'started', {
      operation: 'check-updates',
      name: name || 'all containers'
    });

    try {
      const scriptPath = '/usr/local/bin/mos-check_for_docker_updates';
      const args = name ? [name] : [];

      await this.executeCommandWithStream(operationId, scriptPath, args, 'check-updates', params);

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Check updates failed: ${error.message}`
      });
    }
  }

  /**
   * Execute a command with streaming output
   */
  async executeCommandWithStream(operationId, command, args = [], operationType, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, {
        ...options,
        shell: false
      });

      const startTime = Date.now();

      // Store process for potential cancellation
      this.activeOperations.set(operationId, {
        process,
        type: operationType,
        operation: operationType,
        params,
        startTime
      });

      let stdout = '';
      let stderr = '';

      // Stream stdout
      process.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;

        // Send progress to all clients in operation room
        this.sendUpdate(null, operationId, 'running', {
          output,
          stream: 'stdout'
        });
      });

      // Stream stderr (Docker often uses stderr for progress)
      process.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;

        // Send progress to all clients in operation room
        this.sendUpdate(null, operationId, 'running', {
          output,
          stream: 'stderr'
        });
      });

      // Handle process completion
      process.on('close', (code) => {
        // Remove from active operations
        this.activeOperations.delete(operationId);

        const success = code === 0;
        const duration = Date.now() - startTime;

        // Try to parse JSON output if successful
        let result = null;
        if (success && stdout.trim()) {
          try {
            result = JSON.parse(stdout);
          } catch (e) {
            result = { message: stdout.trim() };
          }
        }

        this.sendUpdate(null, operationId, 'completed', {
          success,
          exitCode: code,
          result,
          duration,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });

        if (success) {
          resolve(result);
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      // Handle process errors
      process.on('error', (error) => {
        this.activeOperations.delete(operationId);

        this.sendUpdate(null, operationId, 'error', {
          message: `Process error: ${error.message}`
        });

        reject(error);
      });
    });
  }

  /**
   * Cancel an ongoing operation
   */
  async cancelOperation(operationId) {
    const operation = this.activeOperations.get(operationId);

    if (!operation) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Operation not found or already completed'
      });
      return;
    }

    try {
      // Kill the process
      operation.process.kill('SIGTERM');

      // Remove from active operations
      this.activeOperations.delete(operationId);

      this.sendUpdate(null, operationId, 'cancelled', {
        message: 'Operation cancelled by user'
      });

      console.log(`Operation ${operationId} cancelled`);
    } catch (error) {
      console.error('Error cancelling operation:', error);
      this.sendUpdate(null, operationId, 'error', {
        message: `Failed to cancel operation: ${error.message}`
      });
    }
  }

  /**
   * Get statistics about active operations
   */
  getStats() {
    const stats = {
      activeOperations: this.activeOperations.size,
      operations: []
    };

    for (const [operationId, operation] of this.activeOperations.entries()) {
      stats.operations.push({
        operationId,
        type: operation.type,
        operation: operation.operation,
        duration: Date.now() - operation.startTime
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
          role: currentUser.role,
          byte_format: currentUser.byte_format
        }
      };

    } catch (authError) {
      return { success: false, message: 'Invalid authentication token' };
    }
  }
}

module.exports = DockerWebSocketManager;
