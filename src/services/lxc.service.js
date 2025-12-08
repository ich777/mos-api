const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const https = require('https');

const execPromise = util.promisify(exec);

/**
 * LXC Container Service
 */
class LxcService {
  /**
   * Get distribution information for a specific container from its config file
   * @param {string} containerName - Name of the container
   * @returns {Promise<string|null>} Distribution name or null if not found
   */
  async getContainerDistribution(containerName) {
    try {
      const configPath = `/var/lib/lxc/${containerName}/config`;

      // Check if config file exists
      if (!fs.existsSync(configPath)) {
        return null;
      }

      const configContent = fs.readFileSync(configPath, 'utf8');

      // Look for the template parameters line - more flexible regex
      const distMatch = configContent.match(/# Parameters passed to the template:.*?--dist\s+(\S+)/);

      if (distMatch && distMatch[1]) {
        return distMatch[1];
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if a custom icon exists for a specific container
   * @param {string} containerName - Name of the container
   * @returns {boolean} True if custom icon exists, false otherwise
   */
  hasCustomIcon(containerName) {
    try {
      const iconPath = `/var/lib/lxc/custom_icons/${containerName}.png`;
      return fs.existsSync(iconPath);
    } catch (error) {
      return false;
    }
  }

  /**
   * List all LXC containers with their status and IP addresses
   * @returns {Promise<Array>} Array of container objects with name, state, and IP addresses
   */
  async listContainers() {
    try {
      // Use the fancy format with explicit header
      const { stdout } = await execPromise('lxc-ls --fancy');

      // Parse the output to get container information
      const lines = stdout.trim().split('\n');

      // First line contains headers
      const headerLine = lines[0];

      // Find the positions of each column in the header
      const namePos = 0; // Name always starts at position 0
      const statePos = headerLine.indexOf('STATE');
      const autostartPos = headerLine.indexOf('AUTOSTART');
      const groupsPos = headerLine.indexOf('GROUPS');
      const ipv4Pos = headerLine.indexOf('IPV4');
      const ipv6Pos = headerLine.indexOf('IPV6');
      const unprivPos = headerLine.indexOf('UNPRIVILEGED');

      const containers = [];

      // Process each container line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue; // Skip empty lines

        // Extract each field based on its position in the header
        const name = line.substring(namePos, statePos).trim();
        const state = line.substring(statePos, autostartPos).trim().toLowerCase();

        // Process IPv4 addresses
        let ipv4 = [];
        const ipv4Text = line.substring(ipv4Pos, ipv6Pos).trim();
        if (ipv4Text && ipv4Text !== '-') {
          ipv4 = ipv4Text.split(',').map(ip => ip.trim()).filter(ip => ip && ip !== '-');
        }

        // Process IPv6 addresses
        let ipv6 = [];
        const ipv6Text = line.substring(ipv6Pos, unprivPos).trim();
        if (ipv6Text && ipv6Text !== '-') {
          ipv6 = ipv6Text.split(',').map(ip => ip.trim()).filter(ip => ip && ip !== '-');
        }

        // Process unprivileged status
        // In der Ausgabe steht bereits 'false' oder 'true' als String
        const unprivText = line.substring(unprivPos).trim().toLowerCase();
        const unprivileged = unprivText === 'true';

        // Get configuration values from config file
        const [distribution, autostart, description] = await Promise.all([
          this.getContainerDistribution(name),
          this.getContainerAutostart(name),
          this.getContainerDescription(name)
        ]);

        containers.push({
          name,
          state,
          autostart,
          ipv4,
          ipv6,
          unprivileged,
          distribution,
          description,
          custom_icon: this.hasCustomIcon(name),
          config: `/var/lib/lxc/${name}/config`
        });
      }

      return containers;
    } catch (error) {
      throw new Error(`Failed to list LXC containers: ${error.message}`);
    }
  }

  /**
   * Start an LXC container
   * @param {string} containerName - Name of the container to start
   * @returns {Promise<Object>} Result of the operation
   */
  async startContainer(containerName) {
    try {
      await execPromise(`lxc-start -n ${containerName}`);
      return { success: true, message: `Container ${containerName} started successfully` };
    } catch (error) {
      throw new Error(`Failed to start container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Stop an LXC container
   * @param {string} containerName - Name of the container to stop
   * @returns {Promise<Object>} Result of the operation
   */
  async stopContainer(containerName) {
    try {
      await execPromise(`lxc-stop -n ${containerName}`);
      return { success: true, message: `Container ${containerName} stopped successfully` };
    } catch (error) {
      throw new Error(`Failed to stop container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Restart an LXC container (stop, wait 1 second, then start)
   * @param {string} containerName - Name of the container to restart
   * @returns {Promise<Object>} Result of the operation
   */
  async restartContainer(containerName) {
    try {
      // Stop the container first
      await execPromise(`lxc-stop -n ${containerName}`);

      // Wait 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Start the container again
      await execPromise(`lxc-start -n ${containerName}`);

      return { success: true, message: `Container ${containerName} restarted successfully` };
    } catch (error) {
      throw new Error(`Failed to restart container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Force kill an LXC container
   * @param {string} containerName - Name of the container to kill
   * @returns {Promise<Object>} Result of the operation
   */
  async killContainer(containerName) {
    try {
      await execPromise(`lxc-stop -n ${containerName} -k`);
      return { success: true, message: `Container ${containerName} killed successfully` };
    } catch (error) {
      throw new Error(`Failed to kill container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Freeze (pause) an LXC container
   * @param {string} containerName - Name of the container to freeze
   * @returns {Promise<Object>} Result of the operation
   */
  async freezeContainer(containerName) {
    try {
      await execPromise(`lxc-freeze -n ${containerName}`);
      return { success: true, message: `Container ${containerName} frozen successfully` };
    } catch (error) {
      throw new Error(`Failed to freeze container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Unfreeze (resume) an LXC container
   * @param {string} containerName - Name of the container to unfreeze
   * @returns {Promise<Object>} Result of the operation
   */
  async unfreezeContainer(containerName) {
    try {
      await execPromise(`lxc-unfreeze -n ${containerName}`);
      return { success: true, message: `Container ${containerName} unfrozen successfully` };
    } catch (error) {
      throw new Error(`Failed to unfreeze container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Check if a container exists
   * @param {string} containerName - Name of the container to check
   * @returns {Promise<boolean>} True if container exists, false otherwise
   */
  async containerExists(containerName) {
    try {
      const containers = await this.listContainers();
      return containers.some(container => container.name === containerName);
    } catch (error) {
      throw new Error(`Failed to check if container exists: ${error.message}`);
    }
  }

  /**
   * Create a new LXC container
   * @param {string} containerName - Name of the container to create
   * @param {string} distribution - Distribution (e.g., ubuntu, debian)
   * @param {string} release - Release version (e.g., bionic, bookworm)
   * @param {string} arch - Architecture (defaults to amd64)
   * @param {boolean} autostart - Whether container should autostart (defaults to false)
   * @param {string} containerDescription - Optional description for the container
   * @param {boolean} startAfterCreation - Whether to start container after creation (defaults to false)
   * @returns {Promise<Object>} Result of the operation
   */
  async createContainer(containerName, distribution, release, arch = 'amd64', autostart = false, containerDescription = null, startAfterCreation = false) {
    try {
      // Check if container already exists
      const exists = await this.containerExists(containerName);
      if (exists) {
        throw new Error(`Container ${containerName} already exists`);
      }

      // Validate description if provided
      if (containerDescription && !this.validateContainerDescription(containerDescription)) {
        throw new Error(`Invalid description. Must be max 65 characters and only contain letters, numbers, spaces and these special characters: . - _ ,`);
      }

      // Validate container name
      if (!this.validateContainerName(containerName)) {
        throw new Error(`Invalid container name. Container names must be 1-64 characters long, contain only letters, numbers, hyphens, and underscores, and must not start or end with a hyphen or underscore.`);
      }

      // Create the container
      const command = `lxc-create --name ${containerName} --template download -- --dist ${distribution} --release ${release} --arch ${arch}`;
      await execPromise(command);

      // Set autostart configuration
      await this.setContainerAutostart(containerName, autostart);

      // Set container description if provided
      if (containerDescription) {
        await this.setContainerDescription(containerName, containerDescription);
      }

      // Automatically assign the next available index
      try {
        const nextIndex = await this.getNextAvailableIndex();
        await this.setContainerIndex(containerName, nextIndex);
      } catch (indexError) {
        // Don't fail container creation if index assignment fails
        console.warn(`Warning: Could not assign index to container ${containerName}: ${indexError.message}`);
      }

      let startResult = null;

      // Start container if requested
      if (startAfterCreation === true) {
        try {
          startResult = await this.startContainer(containerName);
        } catch (startError) {
          // Don't fail container creation if start fails
          console.warn(`Warning: Container ${containerName} was created but could not be started: ${startError.message}`);
          startResult = { success: false, message: startError.message };
        }
      }

      const result = {
        success: true,
        message: `Container ${containerName} created successfully with ${distribution} ${release} (${arch})`,
        autostart,
        description: containerDescription
      };

      // Add start information if container was started or start was attempted
      if (startAfterCreation === true) {
        result.started = startResult ? startResult.success : false;
        if (startResult && startResult.success) {
          result.message += ' and started successfully';
        } else if (startResult) {
          result.message += ` but failed to start: ${startResult.message}`;
        }
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to create container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Set autostart configuration for a container
   * @param {string} containerName - Name of the container
   * @param {boolean} autostart - Whether container should autostart
   * @returns {Promise<void>}
   */
  async setContainerAutostart(containerName, autostart) {
    try {
      const configPath = `/var/lib/lxc/${containerName}/config`;

      if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found for container ${containerName}`);
      }

      let configContent = fs.readFileSync(configPath, 'utf8');
      const autostartValue = autostart ? '1' : '0';
      const autostartLine = `lxc.start.auto = ${autostartValue}`;

      // Check if lxc.start.auto line already exists (more flexible regex)
      if (configContent.includes('lxc.start.auto')) {
        // Replace any existing lxc.start.auto line regardless of spacing or value
        configContent = configContent.replace(/^lxc\.start\.auto\s*=\s*.*$/gm, autostartLine);
      } else {
        // Add new line at the end
        configContent += `\n${autostartLine}\n`;
      }

      fs.writeFileSync(configPath, configContent);
    } catch (error) {
      throw new Error(`Failed to set autostart for container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Validate container description for allowed characters
   * @param {string} description - Description to validate
   * @returns {boolean} True if valid, false otherwise
   */
  validateContainerDescription(description) {
    if (!description || typeof description !== 'string') {
      return true; // Empty or null descriptions are allowed
    }

    // Check length (maximum 65 characters)
    if (description.length > 65) {
      return false;
    }

    // Allow letters, numbers, spaces, and specific special characters: . - _ ,
    const allowedPattern = /^[a-zA-Z0-9\s.\-_,]*$/;
    return allowedPattern.test(description);
  }

  /**
   * Validate container name for allowed characters
   * @param {string} containerName - Container name to validate
   * @returns {boolean} True if valid, false otherwise
   */
  validateContainerName(containerName) {
    if (!containerName || typeof containerName !== 'string') {
      return false; // Container name is required
    }

    // Container names should only contain letters, numbers, hyphens, and underscores
    // No spaces or other special characters allowed
    const allowedPattern = /^[a-zA-Z0-9\-_]+$/;

    // Additional checks
    if (containerName.length < 1 || containerName.length > 64) {
      return false; // Length should be between 1 and 64 characters
    }

    // Container name should not start or end with hyphen or underscore
    if (containerName.startsWith('-') || containerName.startsWith('_') ||
        containerName.endsWith('-') || containerName.endsWith('_')) {
      return false;
    }

    return allowedPattern.test(containerName);
  }

  /**
   * Set description for a container
   * @param {string} containerName - Name of the container
   * @param {string} description - Description for the container
   * @returns {Promise<void>}
   */
  async setContainerDescription(containerName, description) {
    try {
      const configPath = `/var/lib/lxc/${containerName}/config`;

      if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found for container ${containerName}`);
      }

      // Skip validation for empty descriptions (used for removal)
      if (description && description.trim() !== '') {
        // Validate description characters
        if (!this.validateContainerDescription(description)) {
          throw new Error(`Invalid description. Must be max 65 characters and only contain letters, numbers, spaces and these special characters: . - _ ,`);
        }
      }

      let configContent = fs.readFileSync(configPath, 'utf8');

      // Check if container_description line already exists
      if (configContent.includes('#container_description')) {
        if (description && description.trim() !== '') {
          // Replace with new description
          const descriptionLine = `#container_description=${description}`;
          configContent = configContent.replace(/^#container_description=.*$/gm, descriptionLine);
        } else {
          // Remove the description line completely
          configContent = configContent.replace(/^#container_description=.*$\n?/gm, '');
        }
      } else {
        // Only add new line if description is not empty
        if (description && description.trim() !== '') {
          const descriptionLine = `#container_description=${description}`;
          const lines = configContent.split('\n');
          let insertIndex = 0;

          // Find the last comment line at the beginning
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#') || lines[i].trim() === '') {
              insertIndex = i + 1;
            } else {
              break;
            }
          }

          lines.splice(insertIndex, 0, descriptionLine);
          configContent = lines.join('\n');
        }
        // If description is empty and line doesn't exist, do nothing
      }

      fs.writeFileSync(configPath, configContent);
    } catch (error) {
      throw new Error(`Failed to set description for container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Get autostart configuration for a container
   * @param {string} containerName - Name of the container
   * @returns {Promise<boolean>} True if autostart is enabled, false otherwise
   */
  async getContainerAutostart(containerName) {
    try {
      const configPath = `/var/lib/lxc/${containerName}/config`;

      if (!fs.existsSync(configPath)) {
        return false;
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      // More flexible regex to match different formats and values
      const autostartMatch = configContent.match(/^lxc\.start\.auto\s*=\s*(.+)$/m);

      if (autostartMatch && autostartMatch[1]) {
        const value = autostartMatch[1].trim().toLowerCase();
        // Support different formats: 1, true, yes, on
        return value === '1' || value === 'true' || value === 'yes' || value === 'on';
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get description for a container
   * @param {string} containerName - Name of the container
   * @returns {Promise<string|null>} Description or null if not found
   */
  async getContainerDescription(containerName) {
    try {
      const configPath = `/var/lib/lxc/${containerName}/config`;

      if (!fs.existsSync(configPath)) {
        return null;
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      // More flexible regex to match the description line
      const descriptionMatch = configContent.match(/^#container_description=(.*)$/m);

      return descriptionMatch ? descriptionMatch[1].trim() : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get index for a specific container
   * @param {string} containerName - Name of the container
   * @returns {Promise<number|null>} Container index or null if not found
   */
  async getContainerIndex(containerName) {
    try {
      const configPath = `/var/lib/lxc/${containerName}/config`;

      if (!fs.existsSync(configPath)) {
        return null;
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      // Read from #container_order= in config file but return as index for API
      const orderMatch = configContent.match(/^#container_order=(.*)$/m);

      if (orderMatch && orderMatch[1]) {
        const index = parseInt(orderMatch[1].trim());
        return isNaN(index) ? null : index;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Set index for a container
   * @param {string} containerName - Name of the container
   * @param {number} index - Index for the container
   * @returns {Promise<void>}
   */
  async setContainerIndex(containerName, index) {
    try {
      const configPath = `/var/lib/lxc/${containerName}/config`;

      if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found for container ${containerName}`);
      }

      // Validate index (should be a positive integer)
      if (!Number.isInteger(index) || index < 1) {
        throw new Error(`Invalid index value. Index must be a positive integer starting from 1.`);
      }

      let configContent = fs.readFileSync(configPath, 'utf8');
      const orderLine = `#container_order=${index}`;

      // Check if container_order line already exists (more flexible regex)
      if (configContent.includes('#container_order')) {
        // Replace any existing container_order line regardless of spacing or value
        configContent = configContent.replace(/^#container_order=.*$/gm, orderLine);
      } else {
        // Add new line at the beginning after any existing comments
        const lines = configContent.split('\n');
        let insertIndex = 0;

        // Find the last comment line at the beginning
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#') || lines[i].trim() === '') {
            insertIndex = i + 1;
          } else {
            break;
          }
        }

        lines.splice(insertIndex, 0, orderLine);
        configContent = lines.join('\n');
      }

      fs.writeFileSync(configPath, configContent);
    } catch (error) {
      throw new Error(`Failed to set index for container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Get the next available index number for a new container
   * @returns {Promise<number>} Next available index number
   */
  async getNextAvailableIndex() {
    try {
      // Get all containers
      const containers = await this.listContainers();

      // Get all current indices
      const indices = [];
      for (const container of containers) {
        const index = await this.getContainerIndex(container.name);
        if (index !== null) {
          indices.push(index);
        }
      }

      // If no indices exist, start with 1
      if (indices.length === 0) {
        return 1;
      }

      // Find the highest index and add 1
      const maxIndex = Math.max(...indices);
      return maxIndex + 1;
    } catch (error) {
      // Default to 1 if there's an error
      return 1;
    }
  }

  /**
   * Update container configuration (autostart and description)
   * @param {string} containerName - Name of the container
   * @param {Object} options - Configuration options
   * @param {boolean} options.autostart - Whether container should autostart
   * @param {string} options.description - Description for the container
   * @returns {Promise<Object>} Result of the operation
   */
  async updateContainerConfig(containerName, options = {}) {
    try {
      // Check if container exists
      const exists = await this.containerExists(containerName);
      if (!exists) {
        throw new Error(`Container ${containerName} does not exist`);
      }

      // Validate description if provided (allow null/empty for removal)
      if (options.description !== undefined && options.description !== null && options.description !== '') {
        if (!this.validateContainerDescription(options.description)) {
          throw new Error(`Invalid description. Must be max 65 characters and only contain letters, numbers, spaces and these special characters: . - _ ,`);
        }
      }

      const updates = {};

      // Update autostart if provided
      if (typeof options.autostart === 'boolean') {
        await this.setContainerAutostart(containerName, options.autostart);
        updates.autostart = options.autostart;
      }

      // Update description if provided
      if (options.description !== undefined) {
        if (options.description === null || options.description === '') {
          // Remove description by setting it to empty
          await this.setContainerDescription(containerName, '');
        } else {
          await this.setContainerDescription(containerName, options.description);
        }
        updates.description = options.description;
      }

      return {
        success: true,
        message: `Container ${containerName} configuration updated successfully`,
        updates
      };
    } catch (error) {
      throw new Error(`Failed to update container ${containerName} configuration: ${error.message}`);
    }
  }

  /**
   * Updates container indices for multiple containers
   * @param {Array} containers - Array of containers with name and new index
   * @returns {Promise<Array>} Updated container list with new indices
   */
  async updateContainerIndices(containers) {
    try {
      // Validate input
      if (!Array.isArray(containers)) {
        throw new Error('Containers must be an array');
      }

      // Validate each container entry
      for (const container of containers) {
        if (!container.name) {
          throw new Error('Each container must have a name');
        }
        if (container.index !== undefined && (!Number.isInteger(container.index) || container.index < 1)) {
          throw new Error(`Invalid index for container ${container.name}. Index must be a positive integer starting from 1.`);
        }

        // Validate autostart if provided
        if (container.autostart !== undefined && typeof container.autostart !== 'boolean') {
          throw new Error(`Invalid autostart value for container ${container.name}. Autostart must be a boolean.`);
        }

        // Validate description if provided
        if (container.description !== undefined && container.description !== null && container.description !== '') {
          if (!this.validateContainerDescription(container.description)) {
            throw new Error(`Invalid description for container ${container.name}. Must be max 65 characters and only contain letters, numbers, spaces and these special characters: . - _ ,`);
          }
        }

        // Check if container exists
        const exists = await this.containerExists(container.name);
        if (!exists) {
          throw new Error(`Container ${container.name} does not exist`);
        }
      }

      // Check for duplicate indices (only if indices are provided)
      const indicesProvided = containers.filter(c => c.index !== undefined);
      if (indicesProvided.length > 0) {
        const indices = indicesProvided.map(c => c.index);
        const uniqueIndices = new Set(indices);
        if (indices.length !== uniqueIndices.size) {
          throw new Error('Duplicate index values are not allowed');
        }
      }

      // Update properties for each container
      const updatedContainers = [];
      for (const container of containers) {
        const updates = {
          name: container.name
        };

        // Update index if provided
        if (container.index !== undefined) {
          await this.setContainerIndex(container.name, container.index);
          updates.index = container.index;
        }

        // Update autostart if provided
        if (container.autostart !== undefined) {
          await this.setContainerAutostart(container.name, container.autostart);
          updates.autostart = container.autostart;
        }

        // Update description if provided
        if (container.description !== undefined) {
          if (container.description === null || container.description === '') {
            // Remove description by setting it to empty
            await this.setContainerDescription(container.name, '');
          } else {
            await this.setContainerDescription(container.name, container.description);
          }
          updates.description = container.description;
        }

        updatedContainers.push(updates);
      }

      return updatedContainers;
    } catch (error) {
      throw new Error(`Failed to update container indices: ${error.message}`);
    }
  }

  /**
   * Get all containers with their current index
   * @returns {Promise<Array>} Array of containers with name and index
   */
  async getAllContainerIndices() {
    try {
      // Get all containers
      const containers = await this.listContainers();

      // Get index, autostart and description for each container
      const containerIndices = [];
      for (const container of containers) {
        const [index, autostart, description] = await Promise.all([
          this.getContainerIndex(container.name),
          this.getContainerAutostart(container.name),
          this.getContainerDescription(container.name)
        ]);

        containerIndices.push({
          name: container.name,
          index: index || null, // null if no index is set
          autostart: autostart,
          description: description || null // null if no description is set
        });
      }

      // Sort by index (containers without index go to the end)
      containerIndices.sort((a, b) => {
        if (a.index === null && b.index === null) return a.name.localeCompare(b.name);
        if (a.index === null) return 1;
        if (b.index === null) return -1;
        return a.index - b.index;
      });

      return containerIndices;
    } catch (error) {
      throw new Error(`Failed to get container indices: ${error.message}`);
    }
  }

  /**
   * Destroy (delete) an LXC container
   * @param {string} containerName - Name of the container to destroy
   * @returns {Promise<Object>} Result of the operation
   */
  async destroyContainer(containerName) {
    try {
      // Check if container exists
      const exists = await this.containerExists(containerName);
      if (!exists) {
        throw new Error(`Container ${containerName} does not exist`);
      }

      // Destroy the container (--force will stop it first if running)
      await execPromise(`lxc-destroy --force -n ${containerName}`);

      // Remove custom icon if it exists
      const iconPath = `/var/lib/lxc/custom_icons/${containerName}.png`;
      if (fs.existsSync(iconPath)) {
        try {
          fs.unlinkSync(iconPath);
        } catch (iconError) {
          // Don't fail the entire operation if icon deletion fails
          console.warn(`Warning: Could not delete custom icon for ${containerName}: ${iconError.message}`);
        }
      }

      // Reindex remaining containers to close gaps in indices
      try {
        await this.reindexContainerIndices();
      } catch (reindexError) {
        // Don't fail the main operation if reindexing fails
        console.warn(`Warning: Could not reindex container indices after deletion: ${reindexError.message}`);
      }

      return {
        success: true,
        message: `Container ${containerName} destroyed successfully`
      };
    } catch (error) {
      throw new Error(`Failed to destroy container ${containerName}: ${error.message}`);
    }
  }

  /**
   * Reindex all containers to close gaps in index numbers
   * @returns {Promise<void>}
   */
  async reindexContainerIndices() {
    try {
      // Get all containers
      const containers = await this.listContainers();

      // Get current indices for all containers
      const containerIndices = [];
      for (const container of containers) {
        const index = await this.getContainerIndex(container.name);
        if (index !== null) {
          containerIndices.push({
            name: container.name,
            index: index
          });
        }
      }

      // Sort by current index
      containerIndices.sort((a, b) => a.index - b.index);

      // Reindex starting from 1
      for (let i = 0; i < containerIndices.length; i++) {
        const newIndex = i + 1;
        if (containerIndices[i].index !== newIndex) {
          await this.setContainerIndex(containerIndices[i].name, newIndex);
        }
      }
    } catch (error) {
      throw new Error(`Failed to reindex container indices: ${error.message}`);
    }
  }

  /**
   * Download data from URL
   * @param {string} url - URL to download from
   * @returns {Promise<string>} Downloaded data
   */
  async downloadData(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          resolve(data);
        });

        response.on('error', (error) => {
          reject(error);
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Get available container images/distributions
   * @returns {Promise<Object>} Available distributions, releases and architectures
   */
  async getAvailableImages() {
    try {
      const cacheDir = '/var/mos/lxc';
      const cacheFile = path.join(cacheDir, 'container_index.json');
      const oneHourAgo = Date.now() - (60 * 60 * 1000); // 1 hour in milliseconds

      let needsUpdate = true;

      // Check if cache file exists and is not older than 1 hour
      if (fs.existsSync(cacheFile)) {
        const stats = fs.statSync(cacheFile);
        if (stats.mtimeMs > oneHourAgo) {
          needsUpdate = false;
        }
      }

      let indexData;

      if (needsUpdate) {
        // Ensure cache directory exists
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }

        // Download fresh data
        const rawData = await this.downloadData('https://images.linuxcontainers.org/meta/simplestreams/v1/index.json');

        // Save to cache file
        fs.writeFileSync(cacheFile, rawData);
        indexData = JSON.parse(rawData);
      } else {
        // Load from cache
        const rawData = fs.readFileSync(cacheFile, 'utf8');
        indexData = JSON.parse(rawData);
      }

      // Parse and organize the data
      const distributions = {};
      const filteredArchitectures = []; // Store filtered architectures here
      const products = indexData.index.images.products || [];

      products.forEach(product => {
        // Format: "distribution:release:arch:variant"
        const parts = product.split(':');
        if (parts.length >= 3) {
          const [dist, release, arch, variant] = parts;

          if (!distributions[dist]) {
            distributions[dist] = {};
          }

          if (!distributions[dist][release]) {
            distributions[dist][release] = {
              architectures: [],
              variants: []
            };
          }

          // Check if this is amd64 architecture
          if (arch === 'amd64') {
            // Add architecture if not already present
            if (!distributions[dist][release].architectures.includes(arch)) {
              distributions[dist][release].architectures.push(arch);
            }
          } else {
            // Store non-amd64 architectures in filtered array
            const filteredEntry = {
              distribution: dist,
              release: release,
              architecture: arch,
              variant: variant || null
            };

            // Check if this exact entry already exists
            const existingEntry = filteredArchitectures.find(entry =>
              entry.distribution === dist &&
              entry.release === release &&
              entry.architecture === arch &&
              entry.variant === (variant || null)
            );

            if (!existingEntry) {
              filteredArchitectures.push(filteredEntry);
            }
          }

          // Add variant if specified and not already present (for all architectures)
          if (variant && !distributions[dist][release].variants.includes(variant)) {
            distributions[dist][release].variants.push(variant);
          }
        }
      });

      // Remove distributions/releases that have no amd64 architectures
      const cleanedDistributions = {};
      Object.keys(distributions).forEach(dist => {
        const cleanedReleases = {};
        Object.keys(distributions[dist]).forEach(release => {
          if (distributions[dist][release].architectures.length > 0) {
            cleanedReleases[release] = distributions[dist][release];
          }
        });
        if (Object.keys(cleanedReleases).length > 0) {
          cleanedDistributions[dist] = cleanedReleases;
        }
      });

      // Sort everything for consistent output
      const sortedDistributions = {};
      Object.keys(cleanedDistributions).sort().forEach(dist => {
        sortedDistributions[dist] = {};
        Object.keys(cleanedDistributions[dist]).sort().forEach(release => {
          sortedDistributions[dist][release] = {
            architectures: cleanedDistributions[dist][release].architectures.sort(),
            variants: cleanedDistributions[dist][release].variants.sort()
          };
        });
      });

      // Sort filtered architectures by distribution, release, architecture
      filteredArchitectures.sort((a, b) => {
        if (a.distribution !== b.distribution) {
          return a.distribution.localeCompare(b.distribution);
        }
        if (a.release !== b.release) {
          return a.release.localeCompare(b.release);
        }
        return a.architecture.localeCompare(b.architecture);
      });

      return {
        success: true,
        cached: !needsUpdate,
        lastUpdated: fs.existsSync(cacheFile) ? new Date(fs.statSync(cacheFile).mtime).toISOString() : null,
        distributions: sortedDistributions,
        filtered: filteredArchitectures
      };

    } catch (error) {
      throw new Error(`Failed to get available images: ${error.message}`);
    }
  }

  /**
   * Get CPU usage for a specific container by reading cgroup stats twice with 1 second interval
   * @param {string} containerName - Name of the container
   * @returns {Promise<number>} CPU usage percentage
   */
  async getContainerCpuUsage(containerName) {
    try {
      const cpuStatPath = `/sys/fs/cgroup/lxc.payload.${containerName}/cpu.stat`;

      // Check if path exists
      if (!fs.existsSync(cpuStatPath)) {
        return 0;
      }

      // First measurement
      const stats1 = fs.readFileSync(cpuStatPath, 'utf8');
      const usage1Match = stats1.match(/usage_usec\s+(\d+)/);
      const usage1 = usage1Match ? parseInt(usage1Match[1]) : 0;

      // Wait 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Second measurement
      const stats2 = fs.readFileSync(cpuStatPath, 'utf8');
      const usage2Match = stats2.match(/usage_usec\s+(\d+)/);
      const usage2 = usage2Match ? parseInt(usage2Match[1]) : 0;

      // Calculate CPU usage percentage
      const cpuUsage = Math.max(0, (usage2 - usage1) / 10000);

      return cpuUsage;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Get memory usage for a specific container by reading cgroup memory.stat directly
   * @param {string} containerName - Name of the container
   * @returns {Promise<Object>} Memory usage with raw bytes and formatted string
   */
  async getContainerMemoryUsage(containerName) {
    try {
      const memoryStatPath = `/sys/fs/cgroup/lxc.payload.${containerName}/memory.stat`;

      // Check if path exists
      if (!fs.existsSync(memoryStatPath)) {
        return { bytes: 0, formatted: '0 Bytes' };
      }

      const memoryStats = fs.readFileSync(memoryStatPath, 'utf8');

      // Sum up the relevant memory fields
      const relevantFields = ['anon', 'kernel', 'kernel_stack', 'pagetables', 'sec_pagetables', 'percpu', 'sock', 'vmalloc', 'shmem'];
      let totalBytes = 0;

      relevantFields.forEach(field => {
        const regex = new RegExp(`^${field}\\s+(\\d+)$`, 'm');
        const match = memoryStats.match(regex);
        if (match) {
          totalBytes += parseInt(match[1]);
        }
      });

      // Format bytes into human readable format
      let formatted;
      if (totalBytes === 0) {
        formatted = '0 Bytes';
      } else if (totalBytes >= 1099511627776) { // 1 TiB
        formatted = (totalBytes / 1099511627776).toFixed(2) + ' TiB';
      } else if (totalBytes >= 1073741824) { // 1 GiB
        formatted = (totalBytes / 1073741824).toFixed(2) + ' GiB';
      } else if (totalBytes >= 1048576) { // 1 MiB
        formatted = (totalBytes / 1048576).toFixed(2) + ' MiB';
      } else {
        formatted = totalBytes + ' Bytes';
      }

      return { bytes: totalBytes, formatted };
    } catch (error) {
      return { bytes: 0, formatted: '0 Bytes' };
    }
  }

  /**
   * Get IP addresses for a specific container using lxc-info
   * @param {string} containerName - Name of the container
   * @returns {Promise<Object>} Object with IPv4, IPv6, and Docker IPs
   */
  async getContainerIpAddresses(containerName) {
    try {
      const { stdout } = await execPromise(`lxc-info ${containerName} -iH 2>/dev/null`);

      if (!stdout.trim()) {
        return { ipv4: [], ipv6: [], docker: [] };
      }

      const lines = stdout.trim().split('\n');
      const ipv4 = [];
      const ipv6 = [];
      const docker = [];

      lines.forEach(line => {
        const ip = line.trim();
        if (!ip) return;

        if (ip.includes(':')) {
          // IPv6
          ipv6.push(ip);
        } else if (ip.includes('.')) {
          // IPv4
          if (ip.startsWith('172.')) {
            // Docker IP
            docker.push(ip);
          } else {
            // Regular IPv4
            ipv4.push(ip);
          }
        }
      });

      return { ipv4, ipv6, docker };
    } catch (error) {
      return { ipv4: [], ipv6: [], docker: [] };
    }
  }

  /**
   * Get resource usage for all containers with structured JSON output sorted by name
   * @returns {Promise<Array>} Array of containers with CPU, memory, and IP information
   */
  async getContainerResourceUsage() {
    try {
      // Get list of all containers
      const containers = await this.listContainers();

      // Get detailed resource information for each container
      const containerData = await Promise.all(
        containers.map(async (container) => {
          let cpuUsage = 0;
          let memoryUsage = { bytes: 0, formatted: '0 Bytes' };

          // Only collect CPU and memory data for running containers
          if (container.state === 'running') {
            [cpuUsage, memoryUsage] = await Promise.all([
              this.getContainerCpuUsage(container.name),
              this.getContainerMemoryUsage(container.name)
            ]);
          }

          // Always get IP addresses (even for stopped containers, in case they have static IPs)
          const ipAddresses = await this.getContainerIpAddresses(container.name);

          return {
            name: container.name,
            state: container.state,
            autostart: container.autostart,
            unprivileged: container.unprivileged,
            cpu: {
              usage: cpuUsage,
              unit: '%'
            },
            memory: {
              bytes: memoryUsage.bytes,
              formatted: memoryUsage.formatted
            },
            network: {
              ipv4: ipAddresses.ipv4,
              ipv6: ipAddresses.ipv6,
              docker: ipAddresses.docker,
              all: [...ipAddresses.ipv4, ...ipAddresses.docker, ...ipAddresses.ipv6]
            }
          };
        })
      );

      // Sort by container name and return directly
      return containerData.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(`Failed to get container resource usage: ${error.message}`);
    }
  }
}

module.exports = new LxcService();
