const { spawn } = require('child_process');
const EventEmitter = require('events');

/**
 * Docker WebSocket Manager - Handles real-time Docker operations with streaming output
 * @class DockerWebSocketManager
 * @extends EventEmitter
 *
 * For API documentation and usage examples, see: /routes/websocket/docker.websocket.routes.js
 */
class DockerWebSocketManager extends EventEmitter {
  constructor(io, dockerService, dockerComposeService) {
    super();
    this.io = io;
    this.dockerService = dockerService;
    this.dockerComposeService = dockerComposeService;
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
          case 'upgrade-group':
            await this.executeUpgradeGroup(operationId, params);
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
          case 'compose-create':
            await this.executeComposeCreate(operationId, params);
            break;
          case 'compose-update':
            await this.executeComposeUpdate(operationId, params);
            break;
          case 'compose-pull':
            await this.executeComposePull(operationId, params);
            break;
          case 'compose-delete':
            await this.executeComposeDelete(operationId, params);
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
    const { name, force_update } = params || {};

    this.sendUpdate(null, operationId, 'started', {
      operation: 'upgrade',
      name: name || 'all containers'
    });

    try {
      // If no specific container name is given and not forced, only update containers with available updates
      if (!name && !force_update) {
        const containers = await this.dockerService.getDockerImages();
        const containersWithUpdates = containers.filter(c => c.update_available);

        if (containersWithUpdates.length === 0) {
          this.sendUpdate(null, operationId, 'completed', {
            success: true,
            message: 'No updates available for any container'
          });
          return;
        }

        this.sendUpdate(null, operationId, 'running', {
          output: `Found ${containersWithUpdates.length} container(s) with available updates\n`,
          stream: 'stdout'
        });

        // Update each container sequentially
        for (let i = 0; i < containersWithUpdates.length; i++) {
          const container = containersWithUpdates[i];

          this.sendUpdate(null, operationId, 'running', {
            output: `\n=== Upgrading container ${i + 1}/${containersWithUpdates.length}: ${container.name} ===\n`,
            stream: 'stdout'
          });

          const scriptPath = '/usr/local/bin/mos-update_containers';
          const args = [container.name];

          try {
            await this.executeCommandWithStream(operationId, scriptPath, args, 'upgrade', params);
          } catch (error) {
            // Continue with next container even if one fails
          }
        }

        this.sendUpdate(null, operationId, 'completed', {
          success: true,
          message: `Updated ${containersWithUpdates.length} container(s)`
        });
      } else {
        // Update specific container or force update all
        const scriptPath = '/usr/local/bin/mos-update_containers';
        const args = [];

        if (name) args.push(name);
        if (force_update) args.push('force_update');

        await this.executeCommandWithStream(operationId, scriptPath, args, 'upgrade', params);
      }

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Upgrade failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker group upgrade operation with streaming output for each container
   */
  async executeUpgradeGroup(operationId, params) {
    const { groupId, force_update } = params || {};

    this.sendUpdate(null, operationId, 'started', {
      operation: 'upgrade-group',
      groupId: groupId
    });

    try {
      // Get group to find containers
      const groups = await this.dockerService._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // If not forcing update, filter containers to only those with available updates
      let containersToUpdate = group.containers;

      if (!force_update) {
        const allContainers = await this.dockerService.getDockerImages();
        const containerUpdateMap = {};
        allContainers.forEach(c => {
          containerUpdateMap[c.name] = c.update_available;
        });

        containersToUpdate = group.containers.filter(name => containerUpdateMap[name] === true);

        if (containersToUpdate.length === 0) {
          this.activeOperations.delete(operationId);
          this.sendUpdate(null, operationId, 'completed', {
            success: true,
            message: 'No updates available for any container in this group'
          });
          return;
        }

        this.sendUpdate(null, operationId, 'running', {
          output: `Found ${containersToUpdate.length} of ${group.containers.length} container(s) with available updates\n`,
          stream: 'stdout'
        });
      }

      // Process each container sequentially
      for (let i = 0; i < containersToUpdate.length; i++) {
        const containerName = containersToUpdate[i];

        this.sendUpdate(null, operationId, 'running', {
          output: `\n=== Upgrading container ${i + 1}/${containersToUpdate.length}: ${containerName} ===\n`,
          stream: 'stdout'
        });

        const scriptPath = '/usr/local/bin/mos-update_containers';
        const args = [containerName];
        if (force_update) args.push('force_update');

        try {
          await this.executeCommandWithStream(operationId, scriptPath, args, 'upgrade-group', params);
        } catch (error) {
          // Continue with next container even if one fails
        }
      }

      // Remove from active operations and send completion
      this.activeOperations.delete(operationId);

      this.sendUpdate(null, operationId, 'completed', {
        success: true,
        message: `Group upgrade completed - updated ${containersToUpdate.length} container(s)`
      });

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Group upgrade failed: ${error.message}`
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
        // Remove from active operations for operations that manage themselves
        // Don't auto-delete for: upgrade-group, compose-* (they manage their own lifecycle)
        const managedOperations = [
          'upgrade-group',
          'compose-create-deploy',
          'compose-update-down',
          'compose-update-up',
          'compose-delete'
        ];

        if (!managedOperations.includes(operationType)) {
          this.activeOperations.delete(operationId);
        }

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

        // Only send 'completed' if not part of a managed operation (they send their own completed)
        if (!managedOperations.includes(operationType)) {
          this.sendUpdate(null, operationId, 'completed', {
            success,
            exitCode: code,
            result,
            duration,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          });
        }

        if (success) {
          resolve(result);
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      // Handle process errors
      process.on('error', (error) => {
        // Remove from active operations for operations that manage themselves
        const managedOperations = [
          'upgrade-group',
          'compose-create-deploy',
          'compose-update-down',
          'compose-update-up',
          'compose-delete'
        ];

        if (!managedOperations.includes(operationType)) {
          this.activeOperations.delete(operationId);
        }

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
   * Execute Docker Compose stack creation with streaming output
   */
  async executeComposeCreate(operationId, params) {
    const { name, yaml, env, icon } = params || {};

    if (!name || !yaml) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name and yaml are required for compose-create operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-create',
      name
    });

    try {
      const fs = require('fs').promises;
      const path = require('path');

      // Validate stack name
      this.dockerComposeService._validateStackName(name);

      // Get stack path
      const stackPath = this.dockerComposeService._getStackPath(name);

      // Check if stack already exists
      try {
        await fs.access(stackPath);
        throw new Error(`Stack '${name}' already exists`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      // Create stack directory
      await fs.mkdir(stackPath, { recursive: true });

      this.sendUpdate(null, operationId, 'running', {
        output: `Creating stack directory: ${stackPath}\n`,
        stream: 'stdout'
      });

      // Save compose.yaml
      const composePath = path.join(stackPath, 'compose.yaml');
      await fs.writeFile(composePath, yaml);

      this.sendUpdate(null, operationId, 'running', {
        output: `Saved compose.yaml\n`,
        stream: 'stdout'
      });

      // Save .env if provided
      if (env) {
        const envPath = path.join(stackPath, '.env');
        await fs.writeFile(envPath, env);
        this.sendUpdate(null, operationId, 'running', {
          output: `Saved .env file\n`,
          stream: 'stdout'
        });
      }

      // Get service names
      const services = await this.dockerComposeService._getComposeServices(stackPath);

      if (!services || services.length === 0) {
        throw new Error('No services found in compose.yaml');
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Found services: ${services.join(', ')}\n`,
        stream: 'stdout'
      });

      // Generate mos.override.yaml
      const mosOverride = this.dockerComposeService._generateMosOverride(services, name, icon);
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      await fs.writeFile(mosOverridePath, mosOverride);

      this.sendUpdate(null, operationId, 'running', {
        output: `Generated mos.override.yaml\n`,
        stream: 'stdout'
      });

      // Download icon (non-critical)
      let iconPath = null;
      if (icon) {
        iconPath = await this.dockerComposeService._downloadIcon(icon, name);
        if (iconPath) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Icon downloaded\n`,
            stream: 'stdout'
          });
        } else {
          this.sendUpdate(null, operationId, 'running', {
            output: `Warning: Failed to download icon\n`,
            stream: 'stdout'
          });
        }
      }

      // Copy files from boot to working directory
      this.sendUpdate(null, operationId, 'running', {
        output: `Copying files to working directory...\n`,
        stream: 'stdout'
      });

      await this.dockerComposeService._copyStackToWorking(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `Files copied to working directory\n`,
        stream: 'stdout'
      });

      // Create Docker group
      await this.dockerService.createContainerGroup(name, [], {
        compose: true,
        icon: iconPath ? name : null
      });

      this.sendUpdate(null, operationId, 'running', {
        output: `Created Docker group\n`,
        stream: 'stdout'
      });

      // Get working path for deployment
      const workingPath = await this.dockerComposeService._getWorkingPath(name);

      // Deploy stack with streaming from working directory
      this.sendUpdate(null, operationId, 'running', {
        output: `\nDeploying stack from working directory...\n`,
        stream: 'stdout'
      });

      await this.executeCommandWithStream(
        operationId,
        'docker-compose',
        ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'up', '-d'],
        'compose-create-deploy',
        params,
        { cwd: workingPath }
      );

      // Get containers after deployment
      const containerNames = await this.dockerComposeService._getStackContainers(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `\nFound ${containerNames.length} containers: ${containerNames.join(', ')}\n`,
        stream: 'stdout'
      });

      // Update group with containers
      const groups = await this.dockerService.getContainerGroups();
      const group = groups.find(g => g.name === name && g.compose === true);
      if (group) {
        await this.dockerService.updateGroup(group.id, {
          containers: containerNames
        });
      }

      // Send completion
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'completed', {
        success: true,
        stack: name,
        services: services,
        containers: containerNames,
        iconPath: iconPath
      });

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose create failed: ${error.message}`
      });

      // Cleanup on error
      const stackPath = this.dockerComposeService._getStackPath(name);
      try {
        await require('fs').promises.rm(stackPath, { recursive: true, force: true });
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Execute Docker Compose stack update with streaming output
   */
  async executeComposeUpdate(operationId, params) {
    const { name, yaml, env, icon } = params || {};

    if (!name || !yaml) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name and yaml are required for compose-update operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-update',
      name
    });

    try {
      const fs = require('fs').promises;
      const path = require('path');

      this.dockerComposeService._validateStackName(name);

      const stackPath = this.dockerComposeService._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      // Check if stack exists
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this.dockerComposeService._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        this.sendUpdate(null, operationId, 'running', {
          output: `Working directory not found, recreating from boot...\n`,
          stream: 'stdout'
        });

        try {
          await this.dockerComposeService._copyStackToWorking(name);
          this.sendUpdate(null, operationId, 'running', {
            output: `Working directory recreated\n`,
            stream: 'stdout'
          });
        } catch (copyError) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Warning: Failed to recreate working directory: ${copyError.message}\n`,
            stream: 'stdout'
          });
          // Continue anyway, we'll recreate it after updating the boot files
        }
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Stopping current stack...\n`,
        stream: 'stdout'
      });

      // Stop current stack with streaming from working directory
      await this.executeCommandWithStream(
        operationId,
        'docker-compose',
        ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'down', '--rmi', 'all', '-v'],
        'compose-update-down',
        params,
        { cwd: workingPath }
      );

      // Update compose.yaml
      await fs.writeFile(composePath, yaml);

      this.sendUpdate(null, operationId, 'running', {
        output: `Updated compose.yaml\n`,
        stream: 'stdout'
      });

      // Update .env
      const envPath = path.join(stackPath, '.env');
      if (env) {
        await fs.writeFile(envPath, env);
        this.sendUpdate(null, operationId, 'running', {
          output: `Updated .env file\n`,
          stream: 'stdout'
        });
      } else {
        try {
          await fs.unlink(envPath);
          this.sendUpdate(null, operationId, 'running', {
            output: `Removed .env file\n`,
            stream: 'stdout'
          });
        } catch (err) {
          // File doesn't exist
        }
      }

      // Get new service names
      const services = await this.dockerComposeService._getComposeServices(stackPath);

      if (!services || services.length === 0) {
        throw new Error('No services found in compose.yaml');
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Found services: ${services.join(', ')}\n`,
        stream: 'stdout'
      });

      // Regenerate mos.override.yaml
      const mosOverride = this.dockerComposeService._generateMosOverride(services, name, icon);
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      await fs.writeFile(mosOverridePath, mosOverride);

      // Update icon if provided
      let iconPath = null;
      if (icon) {
        iconPath = await this.dockerComposeService._downloadIcon(icon, name);
        if (iconPath) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Icon updated\n`,
            stream: 'stdout'
          });
        } else {
          this.sendUpdate(null, operationId, 'running', {
            output: `Warning: Failed to download icon\n`,
            stream: 'stdout'
          });
        }
      }

      // Copy updated files from boot to working directory
      this.sendUpdate(null, operationId, 'running', {
        output: `Copying updated files to working directory...\n`,
        stream: 'stdout'
      });

      await this.dockerComposeService._copyStackToWorking(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `Files copied to working directory\n`,
        stream: 'stdout'
      });

      this.sendUpdate(null, operationId, 'running', {
        output: `\nRedeploying stack from working directory...\n`,
        stream: 'stdout'
      });

      // Redeploy stack with streaming from working directory
      await this.executeCommandWithStream(
        operationId,
        'docker-compose',
        ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'up', '-d'],
        'compose-update-up',
        params,
        { cwd: workingPath }
      );

      // Get new container names
      const containerNames = await this.dockerComposeService._getStackContainers(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `\nFound ${containerNames.length} containers: ${containerNames.join(', ')}\n`,
        stream: 'stdout'
      });

      // Update Docker group
      const groups = await this.dockerService.getContainerGroups();
      const existingGroup = groups.find(g => g.name === name && g.compose === true);

      if (existingGroup) {
        await this.dockerService.updateGroup(existingGroup.id, {
          containers: containerNames,
          icon: iconPath ? name : existingGroup.icon
        });
      }

      // Send completion
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'completed', {
        success: true,
        stack: name,
        services: services,
        containers: containerNames,
        iconPath: iconPath
      });

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose update failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker Compose pull with streaming output
   */
  async executeComposePull(operationId, params) {
    const { name } = params || {};

    if (!name) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name is required for compose-pull operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-pull',
      name
    });

    try {
      const fs = require('fs').promises;
      const path = require('path');

      this.dockerComposeService._validateStackName(name);

      const stackPath = this.dockerComposeService._getStackPath(name);

      // Check if stack exists in boot
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this.dockerComposeService._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        this.sendUpdate(null, operationId, 'running', {
          output: `Working directory not found, recreating from boot...\n`,
          stream: 'stdout'
        });

        await this.dockerComposeService._copyStackToWorking(name);

        this.sendUpdate(null, operationId, 'running', {
          output: `Working directory recreated\n`,
          stream: 'stdout'
        });
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Pulling images for stack '${name}' from working directory...\n`,
        stream: 'stdout'
      });

      // Pull images with streaming from working directory
      await this.executeCommandWithStream(
        operationId,
        'docker-compose',
        ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'pull'],
        'compose-pull',
        params,
        { cwd: workingPath }
      );

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose pull failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker Compose stack deletion with streaming output
   */
  async executeComposeDelete(operationId, params) {
    const { name } = params || {};

    if (!name) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name is required for compose-delete operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-delete',
      name
    });

    try {
      const fs = require('fs').promises;
      const path = require('path');

      this.dockerComposeService._validateStackName(name);

      const stackPath = this.dockerComposeService._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      // Check if stack exists in boot
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this.dockerComposeService._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        this.sendUpdate(null, operationId, 'running', {
          output: `Working directory not found, recreating from boot...\n`,
          stream: 'stdout'
        });

        try {
          await this.dockerComposeService._copyStackToWorking(name);
          this.sendUpdate(null, operationId, 'running', {
            output: `Working directory recreated\n`,
            stream: 'stdout'
          });
        } catch (copyError) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Failed to recreate working directory: ${copyError.message}\n`,
            stream: 'stdout'
          });
          // Continue anyway, docker-compose down might still work if containers exist
        }
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Stopping and removing stack from working directory...\n`,
        stream: 'stdout'
      });

      // Stop and remove stack with streaming from working directory
      await this.executeCommandWithStream(
        operationId,
        'docker-compose',
        ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'down', '--rmi', 'all', '-v'],
        'compose-delete',
        params,
        { cwd: workingPath }
      );

      // Move stack directory in boot to removed (working directory stays untouched)
      await this.dockerComposeService._moveStackToRemoved(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `Moved stack to removed directory\n`,
        stream: 'stdout'
      });

      // Delete icon
      try {
        const iconPath = `/var/lib/docker/mos/icons/compose/${name}.png`;
        await fs.unlink(iconPath);
        this.sendUpdate(null, operationId, 'running', {
          output: `Deleted icon\n`,
          stream: 'stdout'
        });
      } catch (err) {
        // Icon doesn't exist
      }

      // Delete Docker group
      const groups = await this.dockerService.getContainerGroups();
      const group = groups.find(g => g.name === name && g.compose === true);

      if (group) {
        await this.dockerService.deleteContainerGroup(group.id);
        this.sendUpdate(null, operationId, 'running', {
          output: `Deleted Docker group\n`,
          stream: 'stdout'
        });
      }

      // Send completion
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'completed', {
        success: true,
        message: `Stack '${name}' deleted successfully`
      });

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose delete failed: ${error.message}`
      });
    }
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
