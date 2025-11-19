const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const axios = require('axios');
const dockerService = require('./docker.service');

const execPromise = util.promisify(exec);

class DockerComposeService {

  /**
   * Get the base path for compose stacks
   * @returns {string} Base path
   */
  _getBasePath() {
    return '/boot/config/system/docker/compose';
  }

  /**
   * Get the path for a specific stack
   * @param {string} stackName - Stack name
   * @returns {string} Stack path
   */
  _getStackPath(stackName) {
    return path.join(this._getBasePath(), stackName);
  }

  /**
   * Get the base path for removed compose stacks
   * @returns {string} Removed stacks base path
   */
  _getRemovedBasePath() {
    return '/boot/config/system/docker/compose-removed';
  }

  /**
   * Move a stack to the removed directory
   * @param {string} stackName - Stack name
   * @returns {Promise<void>}
   */
  async _moveStackToRemoved(stackName) {
    try {
      const stackPath = this._getStackPath(stackName);
      const removedBasePath = this._getRemovedBasePath();
      const removedPath = path.join(removedBasePath, stackName);

      // Create removed directory if it doesn't exist
      await fs.mkdir(removedBasePath, { recursive: true });

      // Check if stack exists
      try {
        await fs.access(stackPath);
      } catch (err) {
        // Stack doesn't exist, nothing to move
        return;
      }

      // If target already exists in removed, delete it first
      try {
        await fs.access(removedPath);
        await fs.rm(removedPath, { recursive: true, force: true });
      } catch (err) {
        // Removed path doesn't exist, that's fine
      }

      // Move stack to removed directory
      await fs.rename(stackPath, removedPath);
    } catch (error) {
      console.warn(`Failed to move stack to removed: ${error.message}`);
    }
  }

  /**
   * Validate stack name
   * @param {string} name - Stack name to validate
   * @throws {Error} If name is invalid
   */
  _validateStackName(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('Stack name is required and must be a string');
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('Stack name can only contain alphanumeric characters, hyphens and underscores');
    }

    if (name.length < 2 || name.length > 64) {
      throw new Error('Stack name must be between 2 and 64 characters');
    }
  }

  /**
   * Extract icon URL from mos.override.yaml comment
   * @param {string} content - YAML content
   * @returns {string|null} Icon URL or null
   */
  _extractIconUrl(content) {
    const match = content.match(/^#\s*icon_url:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /**
   * Get service names from compose file using docker compose CLI
   * @param {string} stackPath - Path to stack directory
   * @returns {Promise<Array<string>>} Array of service names
   */
  async _getComposeServices(stackPath) {
    try {
      const { stdout } = await execPromise('docker-compose config --services', {
        cwd: stackPath
      });
      return stdout.trim().split('\n').filter(s => s);
    } catch (error) {
      throw new Error(`Failed to get compose services: ${error.message}`);
    }
  }

  /**
   * Generate mos.override.yaml with labels and icon metadata
   * @param {Array<string>} services - Service names
   * @param {string} stackName - Stack name
   * @param {string|null} iconUrl - Icon URL
   * @returns {string} YAML content
   */
  _generateMosOverride(services, stackName, iconUrl = null) {
    let yaml = '# MOS Metadata - Do not edit manually\n';
    if (iconUrl) {
      yaml += `# icon_url: ${iconUrl}\n`;
    }
    yaml += '\nservices:\n';

    services.forEach(service => {
      yaml += `  ${service}:\n`;
      yaml += `    labels:\n`;
      yaml += `      mos.backend: "compose"\n`;
      yaml += `      mos.stack.name: "${stackName}"\n`;
    });

    return yaml;
  }

  /**
   * Download and save icon (PNG only)
   * @param {string} iconUrl - Icon URL
   * @param {string} stackName - Stack name
   * @returns {Promise<string|null>} Path to saved icon or null
   */
  async _downloadIcon(iconUrl, stackName) {
    if (!iconUrl) return null;

    try {
      // Download icon
      const response = await axios.get(iconUrl, {
        responseType: 'arraybuffer',
        headers: { 'Accept': 'image/png' },
        timeout: 10000
      });

      // Validate Content-Type
      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.includes('image/png')) {
        throw new Error('Icon must be a PNG image');
      }

      // Save icon
      const iconDir = '/var/lib/docker/mos/icons/compose';
      await fs.mkdir(iconDir, { recursive: true });
      const iconPath = path.join(iconDir, `${stackName}.png`);
      await fs.writeFile(iconPath, response.data);

      return iconPath;
    } catch (error) {
      // Icon download failure is not critical
      console.warn(`Failed to download icon for stack '${stackName}': ${error.message}`);
      return null;
    }
  }

  /**
   * Get actual container names after stack deployment (including stopped containers)
   * @param {string} stackPath - Path to stack directory
   * @returns {Promise<Array<string>>} Array of container names
   */
  async _getStackContainers(stackPath) {
    try {
      // Use -a to get ALL containers (running AND stopped)
      const { stdout } = await execPromise("docker-compose ps -aq", {
        cwd: stackPath
      });

      const containerIds = stdout.trim().split('\n').filter(s => s);

      if (containerIds.length === 0) {
        return [];
      }

      // Get container names from IDs
      const containerNames = [];
      for (const id of containerIds) {
        try {
          const { stdout: nameStdout } = await execPromise(`docker inspect --format='{{.Name}}' ${id}`);
          const name = nameStdout.trim().replace(/^\//, ''); // Remove leading slash
          if (name) {
            containerNames.push(name);
          }
        } catch (err) {
          console.warn(`Failed to get name for container ${id}: ${err.message}`);
        }
      }

      return containerNames;
    } catch (error) {
      // If stack not running, return empty array
      console.warn(`Failed to get stack containers: ${error.message}`);
      return [];
    }
  }

  /**
   * Deploy a compose stack
   * @param {string} stackPath - Path to stack directory
   * @returns {Promise<void>}
   */
  async _deployStack(stackPath) {
    try {
      await execPromise('docker-compose -f compose.yaml -f mos.override.yaml up -d', {
        cwd: stackPath
      });
    } catch (error) {
      throw new Error(`Failed to deploy stack: ${error.message}`);
    }
  }

  /**
   * Stop and remove a compose stack
   * @param {string} stackPath - Path to stack directory
   * @param {boolean} removeImages - Whether to remove images (default: true)
   * @returns {Promise<void>}
   */
  async _removeStack(stackPath, removeImages = true) {
    try {
      // --rmi all removes all images used by this stack
      // -v removes named volumes declared in the `volumes` section
      const rmiFlag = removeImages ? ' --rmi all' : '';
      await execPromise(`docker-compose -f compose.yaml -f mos.override.yaml down${rmiFlag} -v`, {
        cwd: stackPath
      });
    } catch (error) {
      // Don't throw if stack is already down
      console.warn(`Warning during stack removal: ${error.message}`);
    }
  }

  /**
   * Create a new compose stack
   * @param {string} name - Stack name
   * @param {string} yamlContent - compose.yaml content
   * @param {string|null} envContent - .env content (optional)
   * @param {string|null} iconUrl - Icon URL (optional, PNG only)
   * @returns {Promise<Object>} Created stack info
   */
  async createStack(name, yamlContent, envContent = null, iconUrl = null) {
    try {
      // Validate stack name
      this._validateStackName(name);

      // Validate YAML content
      if (!yamlContent || typeof yamlContent !== 'string') {
        throw new Error('compose.yaml content is required');
      }

      // Check if stack already exists
      const stackPath = this._getStackPath(name);
      try {
        await fs.access(stackPath);
        throw new Error(`Stack '${name}' already exists`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      // If a removed stack with the same name exists, delete it permanently
      const removedBasePath = this._getRemovedBasePath();
      const removedStackPath = path.join(removedBasePath, name);
      try {
        await fs.access(removedStackPath);
        console.log(`[DockerCompose] Deleting existing removed stack: ${name}`);
        await fs.rm(removedStackPath, { recursive: true, force: true });
      } catch (err) {
        // Removed stack doesn't exist, that's fine
      }

      // Create stack directory
      await fs.mkdir(stackPath, { recursive: true });

      // Save compose.yaml
      const composePath = path.join(stackPath, 'compose.yaml');
      await fs.writeFile(composePath, yamlContent);

      // Save .env if provided
      if (envContent) {
        const envPath = path.join(stackPath, '.env');
        await fs.writeFile(envPath, envContent);
      }

      // Get service names
      const services = await this._getComposeServices(stackPath);

      if (!services || services.length === 0) {
        throw new Error('No services found in compose.yaml');
      }

      // Generate mos.override.yaml
      const mosOverride = this._generateMosOverride(services, name, iconUrl);
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      await fs.writeFile(mosOverridePath, mosOverride);

      // Download icon (non-critical)
      let iconPath = null;
      if (iconUrl) {
        iconPath = await this._downloadIcon(iconUrl, name);
      }

      // Create Docker group BEFORE deployment so it exists even if deployment fails
      // Icon field is only the stack name (not full path), or null if no icon
      await dockerService.createContainerGroup(name, [], {
        compose: true,
        icon: iconPath ? name : null
      });

      // Try to deploy stack (this might fail due to invalid YAML, network issues, etc.)
      let containerNames = [];
      let deploymentError = null;
      try {
        console.log(`[DockerCompose] Deploying stack: ${name}`);
        await this._deployStack(stackPath);
        console.log(`[DockerCompose] Stack deployed successfully: ${name}`);
      } catch (deployError) {
        console.error(`[DockerCompose] Deployment failed for ${name}:`, deployError.message);
        deploymentError = deployError;
      }

      // Get containers REGARDLESS of deployment success (containers might be created but not started)
      containerNames = await this._getStackContainers(stackPath);
      console.log(`[DockerCompose] Found ${containerNames.length} containers:`, containerNames);

      // Update group with actual containers (even if deployment failed)
      const groups = await dockerService.getContainerGroups();
      const group = groups.find(g => g.name === name && g.compose === true);
      if (group) {
        console.log(`[DockerCompose] Updating group ${group.id} with containers`);
        await dockerService.updateGroup(group.id, {
          containers: containerNames
        });
      } else {
        console.warn(`[DockerCompose] Group not found for stack: ${name}`);
      }

      // Return result (even if deployment failed, files and group were created)
      const result = {
        success: !deploymentError,
        stack: name,
        services: services,
        containers: containerNames,
        iconPath: iconPath
      };

      if (deploymentError) {
        result.warning = `Stack created but deployment failed: ${deploymentError.message}. Use PUT to fix and redeploy.`;
      }

      return result;
    } catch (error) {
      // Only move to removed if we failed BEFORE creating files
      // If files were created, keep them so user can fix with PUT
      const stackPath = this._getStackPath(name);
      try {
        await fs.access(stackPath);
        // Files exist, don't move them - just delete the group if it was created
        try {
          const groups = await dockerService.getContainerGroups();
          const group = groups.find(g => g.name === name && g.compose === true);
          if (group) {
            await dockerService.deleteContainerGroup(group.id);
          }
        } catch (groupError) {
          // Ignore
        }
      } catch (accessError) {
        // Files don't exist, nothing to clean up
      }

      throw new Error(`Failed to create stack: ${error.message}`);
    }
  }

  /**
   * Get all compose stacks
   * @returns {Promise<Array>} Array of stack objects
   */
  async getStacks() {
    try {
      const basePath = this._getBasePath();

      // Ensure base directory exists
      try {
        await fs.access(basePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return [];
        }
        throw err;
      }

      // Read all stack directories
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      const stacks = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            const stackPath = path.join(basePath, entry.name);
            const composePath = path.join(stackPath, 'compose.yaml');
            const mosOverridePath = path.join(stackPath, 'mos.override.yaml');

            // Check if compose.yaml exists
            try {
              await fs.access(composePath);
            } catch (err) {
              continue; // Skip if no compose.yaml
            }

            // Get services
            const services = await this._getComposeServices(stackPath);

            // Get containers
            const containers = await this._getStackContainers(stackPath);

            // Get icon URL from mos.override.yaml
            let iconUrl = null;
            try {
              const mosOverrideContent = await fs.readFile(mosOverridePath, 'utf8');
              iconUrl = this._extractIconUrl(mosOverrideContent);
            } catch (err) {
              // No mos.override.yaml, that's ok
            }

            stacks.push({
              name: entry.name,
              services: services,
              containers: containers,
              iconUrl: iconUrl,
              running: containers.length > 0
            });
          } catch (err) {
            console.warn(`Failed to read stack '${entry.name}': ${err.message}`);
          }
        }
      }

      return stacks;
    } catch (error) {
      throw new Error(`Failed to get stacks: ${error.message}`);
    }
  }

  /**
   * Get a specific stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Stack object
   */
  async getStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      const envPath = path.join(stackPath, '.env');

      // Check if stack exists
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Read compose.yaml
      const composeContent = await fs.readFile(composePath, 'utf8');

      // Read .env if exists
      let envContent = null;
      try {
        envContent = await fs.readFile(envPath, 'utf8');
      } catch (err) {
        // No .env file, that's ok
      }

      // Get icon URL from mos.override.yaml
      let iconUrl = null;
      try {
        const mosOverrideContent = await fs.readFile(mosOverridePath, 'utf8');
        iconUrl = this._extractIconUrl(mosOverrideContent);
      } catch (err) {
        // No mos.override.yaml
      }

      // Get services and containers
      const services = await this._getComposeServices(stackPath);
      const containers = await this._getStackContainers(stackPath);

      return {
        name: name,
        yaml: composeContent,
        env: envContent,
        services: services,
        containers: containers,
        iconUrl: iconUrl,
        running: containers.length > 0
      };
    } catch (error) {
      throw new Error(`Failed to get stack: ${error.message}`);
    }
  }

  /**
   * Update a compose stack
   * @param {string} name - Stack name
   * @param {string} yamlContent - New compose.yaml content
   * @param {string|null} envContent - New .env content (optional)
   * @param {string|null} iconUrl - New icon URL (optional, PNG only)
   * @returns {Promise<Object>} Updated stack info
   */
  async updateStack(name, yamlContent, envContent = null, iconUrl = null) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      // Check if stack exists
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Validate YAML content
      if (!yamlContent || typeof yamlContent !== 'string') {
        throw new Error('compose.yaml content is required');
      }

      // Stop current stack
      await this._removeStack(stackPath);

      // Update compose.yaml
      await fs.writeFile(composePath, yamlContent);

      // Update .env
      const envPath = path.join(stackPath, '.env');
      if (envContent) {
        await fs.writeFile(envPath, envContent);
      } else {
        // Remove .env if not provided
        try {
          await fs.unlink(envPath);
        } catch (err) {
          // File doesn't exist, that's ok
        }
      }

      // Get new service names
      const services = await this._getComposeServices(stackPath);

      if (!services || services.length === 0) {
        throw new Error('No services found in compose.yaml');
      }

      // Regenerate mos.override.yaml
      const mosOverride = this._generateMosOverride(services, name, iconUrl);
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      await fs.writeFile(mosOverridePath, mosOverride);

      // Update icon if URL provided
      let iconPath = null;
      if (iconUrl) {
        iconPath = await this._downloadIcon(iconUrl, name);
      }

      // Redeploy stack
      await this._deployStack(stackPath);

      // Get new container names
      const containerNames = await this._getStackContainers(stackPath);

      // Update Docker group
      const groups = await dockerService.getContainerGroups();
      const existingGroup = groups.find(g => g.name === name && g.compose === true);

      if (existingGroup) {
        await dockerService.updateGroup(existingGroup.id, {
          containers: containerNames,
          icon: iconPath ? name : existingGroup.icon
        });
      }

      return {
        success: true,
        stack: name,
        services: services,
        containers: containerNames,
        iconPath: iconPath
      };
    } catch (error) {
      throw new Error(`Failed to update stack: ${error.message}`);
    }
  }

  /**
   * Delete a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Deletion result
   */
  async deleteStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      // Check if stack exists
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Stop and remove stack
      await this._removeStack(stackPath);

      // Move stack directory to removed instead of deleting
      await this._moveStackToRemoved(name);

      // Delete icon
      try {
        const iconPath = `/var/lib/docker/mos/icons/compose/${name}.png`;
        await fs.unlink(iconPath);
      } catch (err) {
        // Icon doesn't exist, that's ok
      }

      // Delete Docker group
      const groups = await dockerService.getContainerGroups();
      const group = groups.find(g => g.name === name && g.compose === true);

      if (group) {
        await dockerService.deleteContainerGroup(group.id);
      }

      return {
        success: true,
        message: `Stack '${name}' deleted successfully`
      };
    } catch (error) {
      throw new Error(`Failed to delete stack: ${error.message}`);
    }
  }

  /**
   * Start a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Start result
   */
  async startStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Start stack
      await execPromise('docker-compose -f compose.yaml -f mos.override.yaml start', {
        cwd: stackPath
      });

      // Get containers
      const containers = await this._getStackContainers(stackPath);

      return {
        success: true,
        stack: name,
        containers: containers
      };
    } catch (error) {
      throw new Error(`Failed to start stack: ${error.message}`);
    }
  }

  /**
   * Stop a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Stop result
   */
  async stopStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Stop stack
      await execPromise('docker-compose -f compose.yaml -f mos.override.yaml stop', {
        cwd: stackPath
      });

      return {
        success: true,
        stack: name,
        message: 'Stack stopped successfully'
      };
    } catch (error) {
      throw new Error(`Failed to stop stack: ${error.message}`);
    }
  }

  /**
   * Restart a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Restart result
   */
  async restartStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Restart stack
      await execPromise('docker-compose -f compose.yaml -f mos.override.yaml restart', {
        cwd: stackPath
      });

      // Get containers
      const containers = await this._getStackContainers(stackPath);

      return {
        success: true,
        stack: name,
        containers: containers
      };
    } catch (error) {
      throw new Error(`Failed to restart stack: ${error.message}`);
    }
  }

  /**
   * Pull images for a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Pull result
   */
  async pullStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Pull images
      const { stdout, stderr } = await execPromise('docker-compose -f compose.yaml -f mos.override.yaml pull', {
        cwd: stackPath
      });

      return {
        success: true,
        stack: name,
        output: stdout || stderr
      };
    } catch (error) {
      throw new Error(`Failed to pull stack images: ${error.message}`);
    }
  }

  /**
   * Get all removed (deleted) stacks
   * @returns {Promise<Array>} Array of removed stack names
   */
  async getRemovedStacks() {
    try {
      const removedBasePath = this._getRemovedBasePath();

      // Check if removed directory exists
      try {
        await fs.access(removedBasePath);
      } catch (err) {
        // Directory doesn't exist, return empty array
        return [];
      }

      // Read directory
      const entries = await fs.readdir(removedBasePath, { withFileTypes: true });

      // Filter directories only and return stack names
      const stacks = entries
        .filter(entry => entry.isDirectory())
        .map(entry => ({ name: entry.name }));

      return stacks;
    } catch (error) {
      throw new Error(`Failed to get removed stacks: ${error.message}`);
    }
  }

  /**
   * Get details of a removed stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Stack details (yaml, env, icon)
   */
  async getRemovedStackDetails(name) {
    try {
      const removedBasePath = this._getRemovedBasePath();
      const stackPath = path.join(removedBasePath, name);

      // Check if stack exists
      try {
        await fs.access(stackPath);
      } catch (err) {
        throw new Error(`Removed stack '${name}' not found`);
      }

      // Read compose.yaml
      const composePath = path.join(stackPath, 'compose.yaml');
      let yaml = null;
      try {
        yaml = await fs.readFile(composePath, 'utf8');
      } catch (err) {
        // File doesn't exist
      }

      // Read .env
      const envPath = path.join(stackPath, '.env');
      let envContent = null;
      try {
        envContent = await fs.readFile(envPath, 'utf8');
      } catch (err) {
        // File doesn't exist
      }

      // Read mos.override.yaml for icon URL
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      let iconUrl = null;
      try {
        const mosOverride = await fs.readFile(mosOverridePath, 'utf8');
        iconUrl = this._extractIconUrl(mosOverride);
      } catch (err) {
        // File doesn't exist
      }

      return {
        name: name,
        yaml: yaml,
        env: envContent,
        iconUrl: iconUrl
      };
    } catch (error) {
      throw new Error(`Failed to get removed stack details: ${error.message}`);
    }
  }

}

module.exports = new DockerComposeService();
