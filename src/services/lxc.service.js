const { exec, spawn } = require('child_process');
const util = require('util');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const https = require('https');
const os = require('os');
const net = require('net');

const execPromise = util.promisify(exec);

// Late require to avoid circular dependency
let systemService = null;
function getSystemService() {
  if (!systemService) {
    systemService = require('./system.service');
  }
  return systemService;
}

let mosService = null;
function getMosService() {
  if (!mosService) {
    mosService = require('./mos.service');
  }
  return mosService;
}

const MOS_NOTIFY_SOCKET = '/var/run/mos-notify.sock';
const DEFAULT_LXC_PATH = '/var/lib/lxc';

// Cache for LXC path
let cachedLxcPath = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 60000; // 1 minute

// Track active backup/restore operations
const activeOperations = new Map();

/**
 * Send notification via mos-notify socket
 * @private
 */
async function sendNotification(title, message, priority = 'normal') {
  return new Promise((resolve) => {
    const client = net.createConnection(MOS_NOTIFY_SOCKET, () => {
      const payload = JSON.stringify({ title, message, priority });
      client.write(payload);
      client.end();
      resolve(true);
    });
    client.on('error', () => resolve(false));
    client.setTimeout(1000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Get LXC registry from settings
 * @returns {Promise<string|null>} The lxc_registry value or null
 */
async function getLxcRegistry() {
  try {
    const data = await fsPromises.readFile('/boot/config/lxc.json', 'utf8');
    const settings = JSON.parse(data);
    return settings.lxc_registry || null;
  } catch (error) {
    return null;
  }
}

/**
 * LXC Container Service
 */
class LxcService {
  /**
   * Get the configured LXC path from settings or use default
   * Uses caching to avoid reading the config file on every call
   * @returns {Promise<string>} The LXC directory path
   */
  async getLxcPath() {
    const now = Date.now();
    if (cachedLxcPath && (now - cacheTimestamp) < CACHE_DURATION) {
      return cachedLxcPath;
    }

    try {
      const settings = await getMosService().getLxcSettings();
      cachedLxcPath = settings.directory || DEFAULT_LXC_PATH;
      cacheTimestamp = now;
      return cachedLxcPath;
    } catch (error) {
      // Fallback to default if settings can't be read
      return DEFAULT_LXC_PATH;
    }
  }

  /**
   * Clear the LXC path cache (call when settings change)
   */
  clearPathCache() {
    cachedLxcPath = null;
    cacheTimestamp = 0;
  }

  /**
   * Get distribution information for a specific container from its config file
   * @param {string} containerName - Name of the container
   * @returns {Promise<string|null>} Distribution name or null if not found
   */
  async getContainerDistribution(containerName) {
    try {
      const lxcPath = await this.getLxcPath();
      const configPath = `${lxcPath}/${containerName}/config`;

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

      // Get LXC path once for all containers
      const lxcPath = await this.getLxcPath();

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
        const [distribution, autostart, description, webui, isBtrfs] = await Promise.all([
          this.getContainerDistribution(name),
          this.getContainerAutostart(name),
          this.getContainerDescription(name),
          this.getContainerWebui(name),
          this.isContainerBtrfs(name)
        ]);

        // Check for active backup/restore operation - return only type or null
        const activeOp = activeOperations.get(name);
        const active_operation = activeOp ? activeOp.type : null;

        containers.push({
          name,
          state,
          autostart,
          ipv4,
          ipv6,
          unprivileged,
          distribution,
          description,
          webui,
          backing_storage: isBtrfs ? 'btrfs' : 'directory',
          custom_icon: this.hasCustomIcon(name),
          config: `${lxcPath}/${name}/config`,
          active_operation
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
      // Check for active backup/restore operation
      const activeOp = activeOperations.get(containerName);
      if (activeOp) {
        throw new Error(`Cannot start container: ${activeOp.type} operation in progress`);
      }
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
      // Check for active backup/restore operation
      const activeOp = activeOperations.get(containerName);
      if (activeOp) {
        throw new Error(`Cannot stop container: ${activeOp.type} operation in progress`);
      }
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
      // Check for active backup/restore operation
      const activeOp = activeOperations.get(containerName);
      if (activeOp) {
        throw new Error(`Cannot restart container: ${activeOp.type} operation in progress`);
      }
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
      // Check for active backup/restore operation
      const activeOp = activeOperations.get(containerName);
      if (activeOp) {
        throw new Error(`Cannot kill container: ${activeOp.type} operation in progress`);
      }
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
      // Check for active backup/restore operation
      const activeOp = activeOperations.get(containerName);
      if (activeOp) {
        throw new Error(`Cannot freeze container: ${activeOp.type} operation in progress`);
      }
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
      // Check for active backup/restore operation
      const activeOp = activeOperations.get(containerName);
      if (activeOp) {
        throw new Error(`Cannot unfreeze container: ${activeOp.type} operation in progress`);
      }
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

      // Get LXC settings for backing storage and registry
      const lxcSettings = await getMosService().getLxcSettings();
      const lxcRegistry = lxcSettings.lxc_registry || null;
      const backingStorage = lxcSettings.backing_storage || 'directory';

      // Determine backing storage option for lxc-create
      // 'directory' -> -B dir, 'btrfs' -> -B btrfs
      const backingOption = backingStorage === 'btrfs' ? '-B btrfs' : '-B dir';

      // If btrfs is selected, verify LXC directory is on BTRFS filesystem
      if (backingStorage === 'btrfs') {
        const lxcPath = await this.getLxcPath();
        const fsType = await this.getFilesystemType(lxcPath);
        if (fsType !== 'btrfs') {
          throw new Error(`Cannot use BTRFS backing storage: LXC directory is not on a BTRFS filesystem (detected: ${fsType})`);
        }
      }

      // Create the container (add --server if custom registry is set)
      let command = `lxc-create --name ${containerName} ${backingOption} --template download -- --dist ${distribution} --release ${release} --arch ${arch}`;
      if (lxcRegistry) {
        command = `lxc-create --name ${containerName} ${backingOption} --template download -- --server ${lxcRegistry} --dist ${distribution} --release ${release} --arch ${arch}`;
      }
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
        message: `Container ${containerName} created successfully with ${distribution} ${release} (${arch}) using ${backingStorage} backing storage`,
        autostart,
        description: containerDescription,
        backing_storage: backingStorage
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
   * Get webui URL for a container
   * @param {string} containerName - Name of the container
   * @returns {Promise<string|null>} WebUI URL or null if not found
   */
  async getContainerWebui(containerName) {
    try {
      const configPath = `/var/lib/lxc/${containerName}/config`;

      if (!fs.existsSync(configPath)) {
        return null;
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      // Match the webui line (always commented)
      const webuiMatch = configContent.match(/^#container_webui=(.*)$/m);

      if (webuiMatch && webuiMatch[1]) {
        let webui = webuiMatch[1].trim();
        // Convert [IP] to [ADDRESS] for consistency with compose containers
        if (webui.includes('[IP]')) {
          webui = webui.replace(/\[IP\]/g, '[ADDRESS]');
        }
        return webui || null;
      }

      return null;
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
      // Check for active backup/restore operation
      const activeOp = activeOperations.get(containerName);
      if (activeOp) {
        throw new Error(`Cannot destroy container: ${activeOp.type} operation in progress`);
      }

      // Check if container exists
      const exists = await this.containerExists(containerName);
      if (!exists) {
        throw new Error(`Container ${containerName} does not exist`);
      }

      const lxcPath = await this.getLxcPath();

      // Remove immutable flags from /var/empty if it exists (some containers set these)
      const varEmptyPath = `${lxcPath}/${containerName}/rootfs/var/empty`;
      if (fs.existsSync(varEmptyPath)) {
        await execPromise(`find "${varEmptyPath}" -exec chattr -i {} \\;`).catch(() => {});
      }

      // Destroy the container (--force will stop it first if running)
      await execPromise(`lxc-destroy --force -n ${containerName}`);

      // Remove custom icon if it exists
      const iconPath = `${lxcPath}/custom_icons/${containerName}.png`;
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
   * Download data from URL using wget
   * @param {string} url - URL to download from
   * @returns {Promise<string>} Downloaded data
   */
  async downloadData(url) {
    try {
      const { stdout } = await execPromise(`wget -qO- "${url}"`);
      return stdout;
    } catch (error) {
      throw new Error(`Failed to download data from ${url}: ${error.message}`);
    }
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

        // Get custom registry if configured, otherwise use default
        const lxcRegistry = await getLxcRegistry();
        const baseUrl = lxcRegistry ? `https://${lxcRegistry}` : 'https://images.linuxcontainers.org';

        // Download fresh data
        const rawData = await this.downloadData(`${baseUrl}/meta/simplestreams/v1/index.json`);

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
   * Get CPU usage for a container (0-100%), normalized to available cores
   * @param {string} containerName - Name of the container
   * @returns {Promise<number>} CPU usage percentage (0-100)
   */
  async getContainerCpuUsage(containerName) {
    try {
      const basePath = `/sys/fs/cgroup/lxc.payload.${containerName}`;
      const cpuStatPath = `${basePath}/cpu.stat`;

      if (!fs.existsSync(cpuStatPath)) return 0;

      // Get CPU count: try container cpuset, fallback to host
      let cpuCount = os.cpus().length || 1;
      try {
        const cpuset = fs.readFileSync(`${basePath}/cpuset.cpus.effective`, 'utf8').trim();
        if (cpuset) {
          // Parse "0-3" or "0,2,4" format
          cpuCount = cpuset.split(',').reduce((sum, part) => {
            const [a, b] = part.split('-').map(Number);
            return sum + (b !== undefined ? b - a + 1 : 1);
          }, 0) || cpuCount;
        }
      } catch (e) { /* use host count */ }

      // Measure CPU usage over 1 second
      const getUsage = () => {
        const match = fs.readFileSync(cpuStatPath, 'utf8').match(/usage_usec\s+(\d+)/);
        return match ? parseInt(match[1]) : 0;
      };

      const usage1 = getUsage();
      await new Promise(r => setTimeout(r, 1000));
      const usage2 = getUsage();

      // Normalize: delta_usec / (cpuCount * 1_000_000) * 100 = delta_usec / (cpuCount * 10000)
      const cpuUsage = (usage2 - usage1) / (cpuCount * 10000);
      return Math.min(100, Math.max(0, cpuUsage));
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
            active_operation: container.active_operation,
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

  /**
   * Get LXC backup settings from lxc.json
   * @returns {Promise<Object>} Backup settings
   */
  async getBackupSettings() {
    try {
      const data = await fsPromises.readFile('/boot/config/lxc.json', 'utf8');
      const settings = JSON.parse(data);
      return {
        backup_path: settings.backup_path || null,
        backups_to_keep: settings.backups_to_keep || 3,
        compression: settings.compression !== undefined ? settings.compression : 6,
        threads: settings.threads || 0,
        use_snapshot: settings.use_snapshot || false
      };
    } catch (error) {
      return {
        backup_path: null,
        backups_to_keep: 3,
        compression: 6,
        threads: 0,
        use_snapshot: false
      };
    }
  }

  /**
   * Check if a container has an active backup/restore operation
   * @param {string} containerName - Container name
   * @returns {Object|null} Active operation info or null
   */
  getActiveOperation(containerName) {
    return activeOperations.get(containerName) || null;
  }

  /**
   * Get all active backup/restore operations
   * @returns {Array} Array of active operations
   */
  getAllActiveOperations() {
    const operations = [];
    for (const [name, op] of activeOperations) {
      operations.push({ container: name, ...op });
    }
    return operations;
  }

  /**
   * Check filesystem type of a path
   * @param {string} dirPath - Path to check
   * @returns {Promise<string>} Filesystem type (btrfs, ext4, etc.)
   */
  async getFilesystemType(dirPath) {
    try {
      const { stdout } = await execPromise(`stat -f -c %T "${dirPath}" 2>/dev/null`);
      return stdout.trim();
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Check if container rootfs is a BTRFS subvolume
   * @param {string} containerName - Container name
   * @returns {Promise<boolean>} True if BTRFS subvolume
   */
  async isContainerBtrfs(containerName) {
    try {
      const lxcPath = await this.getLxcPath();
      const configPath = `${lxcPath}/${containerName}/config`;
      const configContent = await fsPromises.readFile(configPath, 'utf8');
      const rootfsMatch = configContent.match(/^lxc\.rootfs\.path\s*=\s*(.+)$/m);
      if (rootfsMatch) {
        return rootfsMatch[1].trim().startsWith('btrfs:');
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Create a backup of an LXC container
   * @param {string} containerName - Name of container to backup
   * @param {Object} options - Override options (backup_path, compression, threads, use_snapshot)
   * @returns {Promise<Object>} Result of backup operation
   */
  async backupContainer(containerName, options = {}) {
    // Check if container exists
    const exists = await this.containerExists(containerName);
    if (!exists) {
      throw new Error(`Container ${containerName} does not exist`);
    }

    // Check if backup already running for this container
    if (activeOperations.has(containerName)) {
      const op = activeOperations.get(containerName);
      throw new Error(`${op.type} already in progress for container ${containerName}`);
    }

    // Get settings
    const settings = await this.getBackupSettings();
    const backupPath = options.backup_path || settings.backup_path;
    const compression = options.compression !== undefined ? options.compression : settings.compression;
    const threads = options.threads !== undefined ? options.threads : settings.threads;
    let useSnapshot = options.use_snapshot !== undefined ? options.use_snapshot : settings.use_snapshot;
    const backupsToKeep = options.backups_to_keep !== undefined ? options.backups_to_keep : settings.backups_to_keep;
    const allowRunning = options.allow_running !== undefined ? options.allow_running : false;

    // Check if container uses BTRFS backing storage - snapshots only work efficiently with BTRFS
    const isBtrfs = await this.isContainerBtrfs(containerName);
    if (useSnapshot && !isBtrfs) {
      // Disable snapshot mode for non-BTRFS containers (would be slow copy instead of instant snapshot)
      useSnapshot = false;
      console.log(`Container ${containerName} uses directory backing storage - snapshot mode disabled`);
    }

    if (!backupPath) {
      throw new Error('Backup path not configured. Please set backup_path in LXC settings.');
    }

    // Create backup directory if it doesn't exist
    const containerBackupPath = path.join(backupPath, containerName);
    await fsPromises.mkdir(containerBackupPath, { recursive: true });

    // Check if container is running
    const containers = await this.listContainers();
    const container = containers.find(c => c.name === containerName);
    const wasRunning = container && container.state === 'running';

    // Generate backup filename
    const date = new Date();
    const dateStr = date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const backupFilename = `${containerName}_${dateStr}.tar.xz`;
    const backupFullPath = path.join(containerBackupPath, backupFilename);

    // Calculate threads
    const cpuCount = os.cpus().length;
    const actualThreads = threads === 0 ? Math.max(1, Math.floor(cpuCount / 2)) : Math.min(threads, cpuCount);

    // Set active operation
    const abortController = { aborted: false };
    activeOperations.set(containerName, {
      type: 'backup',
      startedAt: new Date().toISOString(),
      useSnapshot,
      backupFile: backupFilename,
      abort: () => { abortController.aborted = true; }
    });

    // Run backup async
    this._runBackup(containerName, {
      backupFullPath,
      backupFilename,
      containerBackupPath,
      compression,
      actualThreads,
      useSnapshot,
      wasRunning,
      allowRunning,
      backupsToKeep,
      abortController
    });

    return {
      success: true,
      message: `Backup started for container ${containerName}`,
      backup_file: backupFilename,
      use_snapshot: useSnapshot,
      is_btrfs: isBtrfs,
      was_running: wasRunning,
      allow_running: allowRunning
    };
  }

  /**
   * Internal: Run the actual backup process
   * @private
   */
  async _runBackup(containerName, opts) {
    const {
      backupFullPath,
      backupFilename,
      containerBackupPath,
      compression,
      actualThreads,
      useSnapshot,
      wasRunning,
      allowRunning,
      backupsToKeep,
      abortController
    } = opts;

    // Track if we stopped the container (for restart in finally/catch)
    const shouldStop = wasRunning && !allowRunning;

    // Define outside try block so they're accessible in catch for cleanup
    let tempSnapshot = null;
    let tempIconPath = null;
    let iconCopied = false;

    try {
      await sendNotification('LXC Backup', `Starting backup of ${containerName}`, 'normal');

      const lxcPath = await this.getLxcPath();
      const containerPath = `${lxcPath}/${containerName}`;
      let sourcePath = containerPath;

      // Stop container if not allow_running
      if (shouldStop) {
        await execPromise(`lxc-stop -n ${containerName}`);
      }

      if (abortController.aborted) {
        if (shouldStop) await execPromise(`lxc-start -n ${containerName}`).catch(() => {});
        throw new Error('Backup aborted by user');
      }

      // Create snapshot if requested
      if (useSnapshot) {

        // Get current snapshots
        let currentSnaps = [];
        try {
          const { stdout } = await execPromise(`lxc-snapshot -n ${containerName} -L 2>/dev/null`);
          currentSnaps = stdout.trim().split('\n').filter(l => l).map(l => l.split(' ')[0]);
        } catch (e) { /* no snapshots */ }

        // Create new snapshot
        await execPromise(`lxc-snapshot -n ${containerName}`);

        // Find new snapshot name
        const { stdout: newSnapsOut } = await execPromise(`lxc-snapshot -n ${containerName} -L 2>/dev/null`);
        const newSnaps = newSnapsOut.trim().split('\n').filter(l => l).map(l => l.split(' ')[0]);
        tempSnapshot = newSnaps.find(s => !currentSnaps.includes(s));

        if (tempSnapshot) {
          sourcePath = `${containerPath}/snaps/${tempSnapshot}`;
          // Remove timestamp file from snapshot
          await fsPromises.unlink(`${sourcePath}/ts`).catch(() => {});
        }

        // Start container again immediately after snapshot
        if (shouldStop) {
          await execPromise(`lxc-start -n ${containerName}`);
        }
      }

      if (abortController.aborted) {
        if (tempSnapshot) {
          await execPromise(`lxc-snapshot -n ${containerName} -d ${tempSnapshot}`).catch(() => {});
        }
        throw new Error('Backup aborted by user');
      }

      // Copy custom icon if exists
      const iconPath = `${lxcPath}/custom_icons/${containerName}.png`;
      tempIconPath = `${sourcePath}/${containerName}.png`;
      if (fs.existsSync(iconPath)) {
        await fsPromises.copyFile(iconPath, tempIconPath);
        iconCopied = true;
      }

      // Create tar.xz archive
      await new Promise((resolve, reject) => {
        let resolved = false;
        let abortCheck = null;

        // Use nice 10 to reset priority (API runs at -10, so child would inherit that)
        // This gives backup processes normal/lower priority so API stays responsive
        const tarProcess = spawn('nice', [
          '-n', '10',
          'tar',
          '-cf', '-',
          '--exclude=snaps',
          '-C', sourcePath,
          '.'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        const xzProcess = spawn('nice', [
          '-n', '10',
          'xz',
          `-${compression}`,
          `--threads=${actualThreads}`
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        const writeStream = fs.createWriteStream(backupFullPath);

        // Handle EPIPE errors on pipes (happens when processes are killed)
        tarProcess.stdout.on('error', (err) => {
          if (err.code !== 'EPIPE') console.error('tar stdout error:', err.message);
        });
        xzProcess.stdin.on('error', (err) => {
          if (err.code !== 'EPIPE') console.error('xz stdin error:', err.message);
        });
        xzProcess.stdout.on('error', (err) => {
          if (err.code !== 'EPIPE') console.error('xz stdout error:', err.message);
        });

        tarProcess.stdout.pipe(xzProcess.stdin);
        xzProcess.stdout.pipe(writeStream);

        let tarError = '';
        let xzError = '';

        tarProcess.stderr.on('data', (data) => { tarError += data.toString(); });
        xzProcess.stderr.on('data', (data) => { xzError += data.toString(); });

        const cleanup = (err) => {
          if (resolved) return;
          resolved = true;
          if (abortCheck) clearInterval(abortCheck);

          // Unpipe before killing to prevent EPIPE
          try {
            tarProcess.stdout.unpipe(xzProcess.stdin);
            xzProcess.stdout.unpipe(writeStream);
          } catch (e) { /* ignore */ }

          // Kill processes
          tarProcess.kill('SIGKILL');
          xzProcess.kill('SIGKILL');
          writeStream.destroy();

          reject(err);
        };

        const finish = () => {
          if (resolved) return;
          resolved = true;
          if (abortCheck) clearInterval(abortCheck);
          resolve();
        };

        // Check for abort periodically
        abortCheck = setInterval(() => {
          if (abortController.aborted) {
            cleanup(new Error('Backup aborted by user'));
          }
        }, 1000);

        writeStream.on('finish', finish);

        writeStream.on('error', (err) => {
          if (err.code !== 'EPIPE') cleanup(err);
        });

        tarProcess.on('error', (err) => {
          if (err.code !== 'EPIPE') cleanup(err);
        });

        xzProcess.on('error', (err) => {
          if (err.code !== 'EPIPE') cleanup(err);
        });

        xzProcess.on('close', (code) => {
          if (!resolved && code !== 0 && !abortController.aborted) {
            cleanup(new Error(`xz exited with code ${code}: ${xzError}`));
          }
        });
      });

      // Cleanup temp icon
      if (iconCopied) {
        await fsPromises.unlink(tempIconPath).catch(() => {});
      }

      // Cleanup temp snapshot
      if (tempSnapshot) {
        await execPromise(`lxc-snapshot -n ${containerName} -d ${tempSnapshot}`).catch(() => {});
      }

      // Start container if we stopped it and didn't use snapshot (snapshot already restarted it)
      if (shouldStop && !useSnapshot) {
        await execPromise(`lxc-start -n ${containerName}`);
      }

      // Delete old backups
      await this._cleanupOldBackups(containerBackupPath, containerName, backupsToKeep);

      activeOperations.delete(containerName);
      await sendNotification('LXC Backup', `Backup of ${containerName} completed: ${backupFilename}`, 'normal');

    } catch (error) {
      activeOperations.delete(containerName);

      // Clean up temporary files
      await fsPromises.unlink(backupFullPath).catch(() => {});

      // Clean up temporary icon if copied
      if (iconCopied && tempIconPath) {
        await fsPromises.unlink(tempIconPath).catch(() => {});
      }

      // Clean up temporary snapshot if created
      if (tempSnapshot) {
        await execPromise(`lxc-snapshot -n ${containerName} -d ${tempSnapshot}`).catch(() => {});
      }

      // Restart container if we stopped it (catch any error, container might already be running)
      if (shouldStop) {
        await execPromise(`lxc-start -n ${containerName}`).catch(() => {});
      }

      await sendNotification('LXC Backup', `Backup of ${containerName} failed: ${error.message}`, 'alert');
    }
  }

  /**
   * Delete old backups to keep only the specified number
   * @private
   */
  async _cleanupOldBackups(containerBackupPath, containerName, backupsToKeep) {
    try {
      const files = await fsPromises.readdir(containerBackupPath);
      const backupFiles = files
        .filter(f => f.startsWith(`${containerName}_`) && f.endsWith('.tar.xz'))
        .sort()
        .reverse(); // Newest first

      if (backupFiles.length > backupsToKeep) {
        const filesToDelete = backupFiles.slice(backupsToKeep);
        for (const file of filesToDelete) {
          await fsPromises.unlink(path.join(containerBackupPath, file));
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not cleanup old backups: ${error.message}`);
    }
  }

  /**
   * Abort an active backup operation
   * @param {string} containerName - Container name
   * @returns {Object} Result
   */
  async abortBackup(containerName) {
    const operation = activeOperations.get(containerName);
    if (!operation) {
      throw new Error(`No active operation for container ${containerName}`);
    }

    if (operation.abort) {
      operation.abort();
    }

    return {
      success: true,
      message: `Abort signal sent for ${operation.type} of ${containerName}`
    };
  }

  /**
   * List available backups for a container or all containers
   * @param {string} containerName - Optional container name
   * @param {Object} user - Optional user object for byte_format preference
   * @returns {Promise<Array>} List of backups
   */
  async listBackups(containerName = null, user = null) {
    const settings = await this.getBackupSettings();
    if (!settings.backup_path) {
      return [];
    }

    const backups = [];

    try {
      if (containerName) {
        // List backups for specific container
        const containerBackupPath = path.join(settings.backup_path, containerName);
        if (fs.existsSync(containerBackupPath)) {
          const files = await fsPromises.readdir(containerBackupPath);
          for (const file of files) {
            if (file.endsWith('.tar.xz')) {
              const filePath = path.join(containerBackupPath, file);
              const stats = await fsPromises.stat(filePath);
              backups.push({
                container: containerName,
                filename: file,
                size: stats.size,
                size_human: getSystemService().formatBytes(stats.size, user),
                created: stats.mtime.toISOString()
              });
            }
          }
        }
      } else {
        // List backups for all containers
        if (fs.existsSync(settings.backup_path)) {
          const dirs = await fsPromises.readdir(settings.backup_path);
          for (const dir of dirs) {
            const containerBackupPath = path.join(settings.backup_path, dir);
            const stat = await fsPromises.stat(containerBackupPath);
            if (stat.isDirectory()) {
              const files = await fsPromises.readdir(containerBackupPath);
              for (const file of files) {
                if (file.endsWith('.tar.xz')) {
                  const filePath = path.join(containerBackupPath, file);
                  const stats = await fsPromises.stat(filePath);
                  backups.push({
                    container: dir,
                    filename: file,
                    size: stats.size,
                    size_human: getSystemService().formatBytes(stats.size, user),
                    created: stats.mtime.toISOString()
                  });
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Warning: Error listing backups: ${error.message}`);
    }

    // Sort by creation date descending
    return backups.sort((a, b) => new Date(b.created) - new Date(a.created));
  }

  /**
   * Delete a specific backup
   * @param {string} containerName - Container name
   * @param {string} filename - Backup filename
   * @returns {Promise<Object>} Result
   */
  async deleteBackup(containerName, filename) {
    const settings = await this.getBackupSettings();
    if (!settings.backup_path) {
      throw new Error('Backup path not configured');
    }

    // Validate filename (prevent path traversal)
    if (filename.includes('/') || filename.includes('..')) {
      throw new Error('Invalid backup filename');
    }

    const backupPath = path.join(settings.backup_path, containerName, filename);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${filename}`);
    }

    await fsPromises.unlink(backupPath);

    // Remove container backup directory if empty
    const containerBackupDir = path.join(settings.backup_path, containerName);
    try {
      const remaining = await fsPromises.readdir(containerBackupDir);
      if (remaining.length === 0) {
        await fsPromises.rmdir(containerBackupDir);
      }
    } catch (e) { /* ignore */ }

    return {
      success: true,
      message: `Backup ${filename} deleted successfully`
    };
  }

  /**
   * Restore a container from backup
   * @param {string} sourceContainer - Source container name (for backup lookup)
   * @param {string} newName - Name for restored container
   * @param {string} backupFilename - Backup filename to restore
   * @returns {Promise<Object>} Result
   */
  async restoreContainer(sourceContainer, newName, backupFilename) {
    // Validate new name
    if (!this.validateContainerName(newName)) {
      throw new Error('Invalid container name');
    }

    // Check if target container exists and has active operation
    if (activeOperations.has(newName)) {
      const op = activeOperations.get(newName);
      throw new Error(`${op.type} already in progress for container ${newName}`);
    }

    const settings = await this.getBackupSettings();
    if (!settings.backup_path) {
      throw new Error('Backup path not configured');
    }

    const backupPath = path.join(settings.backup_path, sourceContainer, backupFilename);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupFilename}`);
    }

    // Check if target container exists
    const targetExists = await this.containerExists(newName);
    let wasRunning = false;

    if (targetExists) {
      const containers = await this.listContainers();
      const container = containers.find(c => c.name === newName);
      wasRunning = container && container.state === 'running';
    }

    // Set active operation
    const abortController = { aborted: false };
    activeOperations.set(newName, {
      type: 'restore',
      startedAt: new Date().toISOString(),
      backupFile: backupFilename,
      abort: () => { abortController.aborted = true; }
    });

    // Run restore async
    this._runRestore(sourceContainer, newName, backupPath, backupFilename, targetExists, wasRunning, abortController);

    return {
      success: true,
      message: `Restore started for container ${newName} from ${backupFilename}`,
      target_exists: targetExists,
      was_running: wasRunning
    };
  }

  /**
   * Internal: Run the actual restore process
   * @private
   */
  async _runRestore(sourceContainer, newName, backupPath, backupFilename, targetExists, wasRunning, abortController) {
    const lxcPath = await this.getLxcPath();
    const containerPath = `${lxcPath}/${newName}`;

    try {
      await sendNotification('LXC Restore', `Starting restore of ${newName} from ${backupFilename}`, 'normal');

      // Stop and destroy existing container if needed
      if (targetExists) {
        if (wasRunning) {
          await execPromise(`lxc-stop -n ${newName}`).catch(() => {});
        }

        // Delete existing snapshots
        try {
          const { stdout } = await execPromise(`lxc-snapshot -n ${newName} -L 2>/dev/null`);
          const snaps = stdout.trim().split('\n').filter(l => l).map(l => l.split(' ')[0]);
          for (const snap of snaps) {
            await execPromise(`lxc-snapshot -n ${newName} -d ${snap}`).catch(() => {});
          }
        } catch (e) { /* no snapshots */ }

        await execPromise(`lxc-destroy -n ${newName}`);
      }

      if (abortController.aborted) {
        throw new Error('Restore aborted by user');
      }

      // Get backing storage from LXC settings
      const lxcSettings = await getMosService().getLxcSettings();
      const backingStorage = lxcSettings.backing_storage || 'directory';
      const useBtrfs = backingStorage === 'btrfs';

      // Validate BTRFS usage if configured
      if (useBtrfs) {
        const fsType = await this.getFilesystemType(lxcPath);
        if (fsType !== 'btrfs') {
          throw new Error(`BTRFS backing storage configured but LXC directory is on ${fsType} filesystem`);
        }
      }

      // Create container directory
      await fsPromises.mkdir(containerPath, { recursive: true });

      // Create BTRFS subvolume for rootfs if backing_storage is btrfs
      if (useBtrfs) {
        await execPromise(`btrfs subvolume create ${containerPath}/rootfs`);
      }

      // Extract backup (use nice for lower priority)
      await execPromise(`nice -n 10 tar -xf "${backupPath}" -C "${containerPath}"`);

      if (abortController.aborted) {
        // Cleanup on abort
        await execPromise(`rm -rf "${containerPath}"`).catch(() => {});
        throw new Error('Restore aborted by user');
      }

      // Update config file
      const configPath = `${containerPath}/config`;
      let configContent = await fsPromises.readFile(configPath, 'utf8');

      // Update rootfs path based on backing_storage setting
      if (useBtrfs) {
        configContent = configContent.replace(
          /^lxc\.rootfs\.path\s*=\s*.+$/m,
          `lxc.rootfs.path = btrfs:${containerPath}/rootfs`
        );
      } else {
        configContent = configContent.replace(
          /^lxc\.rootfs\.path\s*=\s*.+$/m,
          `lxc.rootfs.path = dir:${containerPath}/rootfs`
        );
      }

      // Update container name
      configContent = configContent.replace(
        /^lxc\.uts\.name\s*=\s*.+$/m,
        `lxc.uts.name = ${newName}`
      );

      await fsPromises.writeFile(configPath, configContent);

      // Handle custom icon
      const sourceIconPath = `${containerPath}/${sourceContainer}.png`;
      if (fs.existsSync(sourceIconPath)) {
        const iconsDir = `${lxcPath}/custom_icons`;
        await fsPromises.mkdir(iconsDir, { recursive: true });
        await fsPromises.rename(sourceIconPath, `${iconsDir}/${newName}.png`);
      }

      // Delete any snaps directory from backup
      const snapsPath = `${containerPath}/snaps`;
      if (fs.existsSync(snapsPath)) {
        await fsPromises.rm(snapsPath, { recursive: true });
      }

      // Assign next available index
      try {
        const nextIndex = await this.getNextAvailableIndex();
        await this.setContainerIndex(newName, nextIndex);
      } catch (e) {
        console.warn(`Warning: Could not assign index: ${e.message}`);
      }

      // Start container if it was running
      if (wasRunning) {
        await execPromise(`lxc-start -n ${newName}`);
      }

      activeOperations.delete(newName);
      await sendNotification('LXC Restore', `Container ${newName} restored successfully from ${backupFilename}`, 'normal');

    } catch (error) {
      activeOperations.delete(newName);
      await sendNotification('LXC Restore', `Restore of ${newName} failed: ${error.message}`, 'alert');
    }
  }

  /**
   * Convert container rootfs to BTRFS subvolume
   * @param {string} containerName - Container name
   * @returns {Promise<Object>} Result
   */
  async convertToBtrfs(containerName) {
    // Check if container exists
    const exists = await this.containerExists(containerName);
    if (!exists) {
      throw new Error(`Container ${containerName} does not exist`);
    }

    // Check if already BTRFS
    if (await this.isContainerBtrfs(containerName)) {
      throw new Error(`Container ${containerName} is already using BTRFS`);
    }

    // Check if LXC directory is on BTRFS
    const lxcPath = await this.getLxcPath();
    const fsType = await this.getFilesystemType(lxcPath);
    if (fsType !== 'btrfs') {
      throw new Error(`LXC directory is not on a BTRFS filesystem (detected: ${fsType})`);
    }

    // Check if container is running
    const containers = await this.listContainers();
    const container = containers.find(c => c.name === containerName);
    const wasRunning = container && container.state === 'running';

    // Check for active operation
    if (activeOperations.has(containerName)) {
      const op = activeOperations.get(containerName);
      throw new Error(`${op.type} already in progress for container ${containerName}`);
    }

    activeOperations.set(containerName, {
      type: 'convert-btrfs',
      startedAt: new Date().toISOString()
    });

    // Run async
    this._runConvertToBtrfs(containerName, wasRunning);

    return {
      success: true,
      message: `BTRFS conversion started for container ${containerName}`,
      was_running: wasRunning
    };
  }

  /**
   * Internal: Run BTRFS conversion
   * @private
   */
  async _runConvertToBtrfs(containerName, wasRunning) {
    const lxcPath = await this.getLxcPath();
    const containerPath = `${lxcPath}/${containerName}`;
    const rootfsPath = `${containerPath}/rootfs`;
    const tempPath = `${containerPath}/rootfs.old`;

    try {
      await sendNotification('LXC Convert', `Starting BTRFS conversion for ${containerName}`, 'normal');

      // Stop container
      if (wasRunning) {
        await execPromise(`lxc-stop -n ${containerName}`);
      }

      // Rename old rootfs
      await fsPromises.rename(rootfsPath, tempPath);

      // Create BTRFS subvolume
      await execPromise(`btrfs subvolume create ${rootfsPath}`);

      // Copy data
      await execPromise(`cp -a ${tempPath}/. ${rootfsPath}/`);

      // Update config
      const configPath = `${containerPath}/config`;
      let configContent = await fsPromises.readFile(configPath, 'utf8');
      configContent = configContent.replace(
        /^lxc\.rootfs\.path\s*=\s*dir:.+$/m,
        `lxc.rootfs.path = btrfs:${rootfsPath}`
      );
      await fsPromises.writeFile(configPath, configContent);

      // Remove old rootfs
      await fsPromises.rm(tempPath, { recursive: true });

      // Start container if it was running
      if (wasRunning) {
        await execPromise(`lxc-start -n ${containerName}`);
      }

      activeOperations.delete(containerName);
      await sendNotification('LXC Convert', `Container ${containerName} converted to BTRFS`, 'normal');

    } catch (error) {
      activeOperations.delete(containerName);
      // Try to restore on error
      if (fs.existsSync(tempPath) && !fs.existsSync(rootfsPath)) {
        await fsPromises.rename(tempPath, rootfsPath).catch(() => {});
      }
      await sendNotification('LXC Convert', `BTRFS conversion of ${containerName} failed: ${error.message}`, 'alert');
    }
  }

  /**
   * List all snapshots for all containers
   * @param {Object} user - Optional user object for byte_format preference
   * @returns {Promise<Array>} List of all snapshots grouped by container
   */
  async listAllSnapshots(user = null) {
    try {
      const containers = await this.listContainers();
      const allSnapshots = [];

      for (const container of containers) {
        try {
          const snapshots = await this.listSnapshots(container.name, user);
          for (const snapshot of snapshots) {
            allSnapshots.push({
              container: container.name,
              ...snapshot
            });
          }
        } catch (e) {
          // Container might not support snapshots, skip
        }
      }

      // Sort by container name, then by snapshot name
      return allSnapshots.sort((a, b) => {
        if (a.container !== b.container) {
          return a.container.localeCompare(b.container);
        }
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      throw new Error(`Failed to list all snapshots: ${error.message}`);
    }
  }

  /**
   * List all snapshots for a container
   * @param {string} containerName - Container name
   * @param {Object} user - Optional user object for byte_format preference
   * @returns {Promise<Array>} List of snapshots
   */
  async listSnapshots(containerName, user = null) {
    // Check if container exists
    const exists = await this.containerExists(containerName);
    if (!exists) {
      throw new Error(`Container ${containerName} does not exist`);
    }

    try {
      const lxcPath = await this.getLxcPath();
      const { stdout } = await execPromise(`lxc-snapshot -n ${containerName} -L 2>/dev/null`);
      const lines = stdout.trim().split('\n').filter(l => l.trim());

      const snapshots = [];
      for (const line of lines) {
        // Format: "snap0 (/var/lib/lxc/container/snaps/snap0) 2024-01-20 21:30:00"
        const parts = line.split(/\s+/);
        if (parts.length >= 1) {
          const name = parts[0];
          const snapsPath = `${lxcPath}/${containerName}/snaps/${name}`;

          // Try to get timestamp from ts file
          let timestamp = null;
          try {
            const tsPath = `${snapsPath}/ts`;
            if (fs.existsSync(tsPath)) {
              const ts = await fsPromises.readFile(tsPath, 'utf8');
              timestamp = ts.trim();
            }
          } catch (e) { /* ignore */ }

          // Get size
          let size = 0;
          try {
            const { stdout: duOut } = await execPromise(`du -sb "${snapsPath}" 2>/dev/null`);
            size = parseInt(duOut.split('\t')[0]) || 0;
          } catch (e) { /* ignore */ }

          snapshots.push({
            name,
            timestamp,
            size,
            size_human: getSystemService().formatBytes(size, user)
          });
        }
      }

      return snapshots;
    } catch (error) {
      // No snapshots or error
      return [];
    }
  }

  /**
   * Create a snapshot of a container
   * @param {string} containerName - Container name
   * @param {string} snapshotName - Optional snapshot name (auto-generated if not provided)
   * @param {Object} options - Options
   * @param {boolean} options.allowRunning - Allow snapshot of running container (default: false)
   * @returns {Promise<Object>} Result
   */
  async createSnapshot(containerName, snapshotName = null, options = {}) {
    const { allowRunning = false } = options;

    // Check if container exists
    const exists = await this.containerExists(containerName);
    if (!exists) {
      throw new Error(`Container ${containerName} does not exist`);
    }

    // Check if container uses BTRFS backing storage
    const isBtrfs = await this.isContainerBtrfs(containerName);
    if (!isBtrfs) {
      throw new Error(`Snapshots require BTRFS backing storage. Container ${containerName} uses directory backing storage.`);
    }

    // Check for active operation
    const activeOp = activeOperations.get(containerName);
    if (activeOp) {
      throw new Error(`Cannot create snapshot: ${activeOp.type} operation in progress`);
    }

    // Check if container is running
    const containers = await this.listContainers();
    const container = containers.find(c => c.name === containerName);
    const wasRunning = container && container.state === 'running';

    // Stop container if running and allowRunning is false
    if (wasRunning && !allowRunning) {
      await execPromise(`lxc-stop -n ${containerName}`);
    }

    try {
      // Get current snapshots to determine new snapshot name
      const currentSnaps = await this.listSnapshots(containerName);

      // Create snapshot
      let cmd = `lxc-snapshot -n ${containerName}`;
      if (snapshotName) {
        // Validate snapshot name
        if (!/^[a-zA-Z0-9_-]+$/.test(snapshotName)) {
          throw new Error('Snapshot name can only contain letters, numbers, hyphens and underscores');
        }
        cmd += ` -N ${snapshotName}`;
      }

      await execPromise(cmd);

      // Find the new snapshot name
      const newSnaps = await this.listSnapshots(containerName);
      const newSnapshot = newSnaps.find(s => !currentSnaps.some(cs => cs.name === s.name));

      return {
        success: true,
        message: `Snapshot created for container ${containerName}`,
        snapshot: newSnapshot ? newSnapshot.name : snapshotName || 'snap0'
      };
    } finally {
      // Restart container if it was running before
      if (wasRunning && !allowRunning) {
        await execPromise(`lxc-start -n ${containerName}`).catch(() => {});
      }
    }
  }

  /**
   * Delete a snapshot
   * @param {string} containerName - Container name
   * @param {string} snapshotName - Snapshot name
   * @returns {Promise<Object>} Result
   */
  async deleteSnapshot(containerName, snapshotName) {
    // Check if container exists
    const exists = await this.containerExists(containerName);
    if (!exists) {
      throw new Error(`Container ${containerName} does not exist`);
    }

    // Check for active operation
    const activeOp = activeOperations.get(containerName);
    if (activeOp) {
      throw new Error(`Cannot delete snapshot: ${activeOp.type} operation in progress`);
    }

    // Validate snapshot name
    if (!/^[a-zA-Z0-9_-]+$/.test(snapshotName)) {
      throw new Error('Invalid snapshot name');
    }

    // Check if snapshot exists
    const snapshots = await this.listSnapshots(containerName);
    if (!snapshots.some(s => s.name === snapshotName)) {
      throw new Error(`Snapshot ${snapshotName} not found`);
    }

    // Unmount rootfs if mounted (for btrfs)
    const lxcPath = await this.getLxcPath();
    const snapsPath = `${lxcPath}/${containerName}/snaps/${snapshotName}`;
    await execPromise(`umount ${snapsPath}/rootfs 2>/dev/null`).catch(() => {});

    // Delete snapshot
    await execPromise(`lxc-snapshot -n ${containerName} -d ${snapshotName}`);

    return {
      success: true,
      message: `Snapshot ${snapshotName} deleted from container ${containerName}`
    };
  }

  /**
   * Restore container from a snapshot
   * @param {string} containerName - Container name
   * @param {string} snapshotName - Snapshot name to restore
   * @returns {Promise<Object>} Result
   */
  async restoreSnapshot(containerName, snapshotName) {
    // Check if container exists
    const exists = await this.containerExists(containerName);
    if (!exists) {
      throw new Error(`Container ${containerName} does not exist`);
    }

    // Check for active operation
    if (activeOperations.has(containerName)) {
      const op = activeOperations.get(containerName);
      throw new Error(`Cannot restore snapshot: ${op.type} operation in progress`);
    }

    // Validate snapshot name
    if (!/^[a-zA-Z0-9_-]+$/.test(snapshotName)) {
      throw new Error('Invalid snapshot name');
    }

    // Check if snapshot exists
    const snapshots = await this.listSnapshots(containerName);
    if (!snapshots.some(s => s.name === snapshotName)) {
      throw new Error(`Snapshot ${snapshotName} not found`);
    }

    // Check if container is running
    const containers = await this.listContainers();
    const container = containers.find(c => c.name === containerName);
    const wasRunning = container && container.state === 'running';

    // Set active operation
    activeOperations.set(containerName, {
      type: 'snapshot',
      startedAt: new Date().toISOString()
    });

    // Run async
    this._runRestoreSnapshot(containerName, snapshotName, wasRunning);

    return {
      success: true,
      message: `Snapshot restore started for container ${containerName} from ${snapshotName}`,
      was_running: wasRunning
    };
  }

  /**
   * Create a new container from a snapshot
   * @param {string} sourceContainer - Source container name
   * @param {string} snapshotName - Snapshot name to clone from
   * @param {string} newName - Name for the new container
   * @returns {Promise<Object>} Result
   */
  async cloneFromSnapshot(sourceContainer, snapshotName, newName) {
    // Validate new name
    if (!this.validateContainerName(newName)) {
      throw new Error('Invalid container name');
    }

    // Check if source container exists
    const sourceExists = await this.containerExists(sourceContainer);
    if (!sourceExists) {
      throw new Error(`Container ${sourceContainer} does not exist`);
    }

    // Check if new container already exists
    const newExists = await this.containerExists(newName);
    if (newExists) {
      throw new Error(`Container ${newName} already exists`);
    }

    // Validate snapshot name
    if (!/^[a-zA-Z0-9_-]+$/.test(snapshotName)) {
      throw new Error('Invalid snapshot name');
    }

    // Check if snapshot exists
    const snapshots = await this.listSnapshots(sourceContainer);
    if (!snapshots.some(s => s.name === snapshotName)) {
      throw new Error(`Snapshot ${snapshotName} not found`);
    }

    // Check for active operation on source
    if (activeOperations.has(sourceContainer)) {
      const op = activeOperations.get(sourceContainer);
      throw new Error(`Cannot clone: ${op.type} operation in progress on source container`);
    }

    // Set active operation
    activeOperations.set(sourceContainer, {
      type: 'snapshot',
      startedAt: new Date().toISOString()
    });

    // Run async
    this._runCloneFromSnapshot(sourceContainer, snapshotName, newName);

    return {
      success: true,
      message: `Clone started: creating ${newName} from ${sourceContainer}/${snapshotName}`
    };
  }

  /**
   * Internal: Run clone from snapshot
   * @private
   */
  async _runCloneFromSnapshot(sourceContainer, snapshotName, newName) {
    try {
      await sendNotification('LXC Snapshot', `Cloning ${newName} from ${sourceContainer}/${snapshotName}`, 'normal');

      // Use lxc-copy to create new container from snapshot
      await execPromise(`lxc-copy -n ${sourceContainer} -N ${newName} -s -S ${snapshotName}`);

      // Assign next available index
      try {
        const nextIndex = await this.getNextAvailableIndex();
        await this.setContainerIndex(newName, nextIndex);
      } catch (e) {
        console.warn(`Warning: Could not assign index: ${e.message}`);
      }

      activeOperations.delete(sourceContainer);
      await sendNotification('LXC Snapshot', `Container ${newName} cloned successfully`, 'normal');

    } catch (error) {
      activeOperations.delete(sourceContainer);
      // Cleanup on error
      await execPromise(`lxc-destroy -n ${newName} 2>/dev/null`).catch(() => {});
      await sendNotification('LXC Snapshot', `Clone failed: ${error.message}`, 'alert');
    }
  }

  /**
   * Internal: Run snapshot restore
   * @private
   */
  async _runRestoreSnapshot(containerName, snapshotName, wasRunning) {
    try {
      await sendNotification('LXC Snapshot', `Restoring ${containerName} from snapshot ${snapshotName}`, 'normal');

      // Stop container if running
      if (wasRunning) {
        await execPromise(`lxc-stop -n ${containerName}`);
      }

      // Restore snapshot
      await execPromise(`lxc-snapshot -n ${containerName} -r ${snapshotName}`);

      // Start container if it was running
      if (wasRunning) {
        await execPromise(`lxc-start -n ${containerName}`);
      }

      activeOperations.delete(containerName);
      await sendNotification('LXC Snapshot', `Snapshot ${snapshotName} restored to ${containerName}`, 'normal');

    } catch (error) {
      activeOperations.delete(containerName);
      // Try to start container if it was running
      if (wasRunning) {
        await execPromise(`lxc-start -n ${containerName}`).catch(() => {});
      }
      await sendNotification('LXC Snapshot', `Snapshot restore failed for ${containerName}: ${error.message}`, 'alert');
    }
  }
}

module.exports = new LxcService();
