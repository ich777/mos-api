const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class MosService {
  constructor() {
    this.settingsPath = '/boot/config/docker.json';
  }

  /**
   * Checks if a directory path is mounted on a pool
   * @param {string} dirPath - The directory path to check
   * @returns {Promise<Object>} The result of the check
   */
  async _checkDirectoryMountStatus(dirPath) {
    try {
      // Normalize the path
      const normalizedPath = path.resolve(dirPath);

      // Check if the path is under /mnt/ (Pool-Mountpoints)
      if (!normalizedPath.startsWith('/mnt/')) {
        return {
          isOnPool: false,
          isValid: false,
          error: 'Services can only be configured on Pool-Mountpoints (/mnt/)',
          suggestion: 'Use a path like /mnt/poolname/service-directory'
        };
      }

      // Extract Pool names from the path (e.g. /mnt/storage-pool/docker -> storage-pool)
      const pathParts = normalizedPath.split('/');
      if (pathParts.length < 3) {
        return {
          isOnPool: false,
          isValid: false,
          error: 'Invalid Pool Path'
        };
      }

      const poolName = pathParts[2];

      // Lazy-load Pool-Service to avoid circular dependencies
      const poolsService = require('./pools.service');

      try {
        // Check if Pool exists and status
        // Since we only have the name, we need to search through all Pools
        const pools = await poolsService._readPools();
        const pool = pools.find(p => p.name === poolName);

        if (!pool) {
          throw new Error(`Pool "${poolName}" not found`);
        }

        if (!pool.status.mounted) {
          return {
            isOnPool: true,
            isValid: false,
            poolName,
            poolPath: `/mnt/${poolName}`,
            userPath: normalizedPath,
            error: `Pool "${poolName}" is not mounted. Service directory would not be available.`,
            suggestion: `Mount the pool "${poolName}" first or choose a different path.`
          };
        }

        return {
          isOnPool: true,
          isValid: true,
          poolName,
          poolPath: `/mnt/${poolName}`,
          userPath: normalizedPath,
          message: `Pool "${poolName}" is mounted - Path is available`
        };

      } catch (poolError) {
        if (poolError.message.includes('not found')) {
          return {
            isOnPool: true,
            isValid: false,
            poolName,
            poolPath: `/mnt/${poolName}`,
            userPath: normalizedPath,
            error: `Pool "${poolName}" does not exist.`,
            suggestion: 'Create the pool first or choose a different path.'
          };
        }
        throw poolError;
      }

    } catch (error) {
      console.error('Error checking directory mount status:', error.message);
      return {
        isOnPool: false,
        isValid: false,
        error: `Error checking directory mount status: ${error.message}`
      };
    }
  }

  /**
   * Checks multiple directory paths at once
   * @param {Object} pathsToCheck - Object with paths {fieldName: path}
   * @returns {Promise<Object>} Summary of the check results
   */
  async _checkMultipleDirectories(pathsToCheck) {
    const results = {};
    const errors = [];

    for (const [fieldName, dirPath] of Object.entries(pathsToCheck)) {
      if (!dirPath || typeof dirPath !== 'string') {
        continue; // Skip empty/invalid paths
      }

      const check = await this._checkDirectoryMountStatus(dirPath);
      results[fieldName] = check;

      if (!check.isValid) {
        errors.push({
          field: fieldName,
          path: dirPath,
          error: check.error,
          suggestion: check.suggestion
        });
      }
    }

    return {
      hasErrors: errors.length > 0,
      results,
      errors
    };
  }

  /**
   * Reads the Docker settings from the docker.json file.
   * @returns {Promise<Object>} The Docker settings as an object
   */
  async getDockerSettings() {
    try {
      const data = await fs.readFile(this.settingsPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('docker.json nicht gefunden');
      }
      throw new Error(`Fehler beim Lesen der docker.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the docker.json. Only the passed fields are updated.
   * If enabled is changed, the Docker service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateDockerSettings(updates) {
    try {
      // Read current settings
      let current = {};
      try {
        const data = await fs.readFile(this.settingsPath, 'utf8');
        current = JSON.parse(data);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['enabled', 'directory', 'appdata', 'docker_net', 'filesystem', 'start_wait', 'update_check'];
      let updateCheckChanged = false;

      // Check directory paths for mount status
      const pathsToCheck = {};
      if (updates.directory && updates.directory !== current.directory) {
        pathsToCheck.directory = updates.directory;
      }
      if (updates.appdata && updates.appdata !== current.appdata) {
        pathsToCheck.appdata = updates.appdata;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck);

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`Docker directory conflict: ${errorDetails}`);
        }
      }

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        if (key === 'docker_net') {
          // Docker-Netzwerk configuration handling
          if (!current.docker_net) current.docker_net = {};

          // Validation of docker_net structure
          if (typeof updates.docker_net === 'object') {
            // Mode validation
            if (updates.docker_net.mode !== undefined) {
              const validModes = ['macvlan', 'ipvlan'];
              if (!validModes.includes(updates.docker_net.mode)) {
                throw new Error(`Invalid docker_net mode: ${updates.docker_net.mode}. Valid modes: ${validModes.join(', ')}`);
              }
              current.docker_net.mode = updates.docker_net.mode;
            }

            // Config validation and adoption
            if (Array.isArray(updates.docker_net.config)) {
              // Validation of config entries
              for (const configEntry of updates.docker_net.config) {
                if (typeof configEntry !== 'object') {
                  throw new Error('docker_net.config entries must be objects');
                }
                // Subnet validation if present
                if (configEntry.subnet && !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(configEntry.subnet)) {
                  throw new Error(`Invalid subnet format: ${configEntry.subnet}. Expected format: x.x.x.x/xx`);
                }
                // Gateway validation if present
                if (configEntry.gateway && !/^(\d{1,3}\.){3}\d{1,3}$/.test(configEntry.gateway)) {
                  throw new Error(`Invalid gateway format: ${configEntry.gateway}. Expected format: x.x.x.x`);
                }
              }
              current.docker_net.config = updates.docker_net.config;
            }
          }
        } else if (key === 'update_check') {
          // Intelligent update_check handling - only changed fields are overwritten
          if (!current.update_check) current.update_check = {};

          const currentUpdateCheck = JSON.parse(JSON.stringify(current.update_check)); // Deep copy for comparison

          // If only a boolean is sent, it is for enabled
          if (typeof updates.update_check === 'boolean') {
            if (current.update_check.enabled !== updates.update_check) {
              updateCheckChanged = true;
            }
            current.update_check.enabled = updates.update_check;
          } else if (typeof updates.update_check === 'object') {
            // Individual update_check properties are adopted
            if (updates.update_check.enabled !== undefined &&
                current.update_check.enabled !== updates.update_check.enabled) {
              updateCheckChanged = true;
            }
            if (updates.update_check.update_check_schedule !== undefined &&
                current.update_check.update_check_schedule !== updates.update_check.update_check_schedule) {
              updateCheckChanged = true;
            }

            // auto_update handling
            if (updates.update_check.auto_update) {
              if (!current.update_check.auto_update) current.update_check.auto_update = {};

              if (updates.update_check.auto_update.enabled !== undefined &&
                  current.update_check.auto_update.enabled !== updates.update_check.auto_update.enabled) {
                updateCheckChanged = true;
              }
              if (updates.update_check.auto_update.auto_update_schedule !== undefined &&
                  current.update_check.auto_update.auto_update_schedule !== updates.update_check.auto_update.auto_update_schedule) {
                updateCheckChanged = true;
              }

              // auto_update properties are adopted
              if (updates.update_check.auto_update.enabled !== undefined)
                current.update_check.auto_update.enabled = updates.update_check.auto_update.enabled;
              if (updates.update_check.auto_update.auto_update_schedule !== undefined)
                current.update_check.auto_update.auto_update_schedule = updates.update_check.auto_update.auto_update_schedule;
            }

            // Main properties are adopted
            if (updates.update_check.enabled !== undefined)
              current.update_check.enabled = updates.update_check.enabled;
            if (updates.update_check.update_check_schedule !== undefined)
              current.update_check.update_check_schedule = updates.update_check.update_check_schedule;
          }
        } else {
          current[key] = updates[key];
        }
      }

      // Write the file
      await fs.writeFile(this.settingsPath, JSON.stringify(current, null, 2), 'utf8');

      // Docker service stop/start on configuration changes
      try {
        // Docker always stop when configuration is changed
        // Ignore errors on stop (e.g. if service is already stopped)
        try {
          await execPromise('/etc/init.d/docker stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        // Docker start only if enabled = true (mos-start reads the new file)
        if (current.enabled === true) {
          await execPromise('/usr/local/bin/mos-start docker');
        }
      } catch (error) {
        throw new Error(`Error restarting docker service: ${error.message}`);
      }

      // mos-cron_update execute if update_check changed
      if (updateCheckChanged) {
        try {
          await execPromise('/usr/local/bin/mos-cron_update');
        } catch (error) {
          console.warn('Warning: mos-cron_update could not be executed:', error.message);
        }
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing docker.json: ${error.message}`);
    }
  }

  /**
   * Reads the LXC settings from the lxc.json file.
   * @returns {Promise<Object>} The LXC settings as an object
   */
  async getLxcSettings() {
    try {
      const data = await fs.readFile('/boot/config/lxc.json', 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('lxc.json not found');
      }
      throw new Error(`Error reading lxc.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the lxc.json. Only the passed fields are changed.
   * If enabled is changed, the LXC service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateLxcSettings(updates) {
    try {
      // Read current settings
      let current = {};
      try {
        const data = await fs.readFile('/boot/config/lxc.json', 'utf8');
        current = JSON.parse(data);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['enabled', 'bridge', 'directory', 'start_wait'];

      // Check directory paths for mount status
      const pathsToCheck = {};
      if (updates.directory && updates.directory !== current.directory) {
        pathsToCheck.directory = updates.directory;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck);

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`LXC directory conflict: ${errorDetails}`);
        }
      }

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        current[key] = updates[key];
      }

      // Write the file
      await fs.writeFile('/boot/config/lxc.json', JSON.stringify(current, null, 2), 'utf8');

      // LXC service stop/start on configuration changes
      try {
        // LXC always stop when configuration is changed
        // Ignore errors on stop (e.g. if service is already stopped)
        try {
          await exec('/etc/init.d/lxc stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        try {
          await exec('/etc/init.d/lxc-net stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        // LXC only start if enabled = true (mos-start reads the new file)
        if (current.enabled === true) {
          await execPromise('/usr/local/bin/mos-start lxc');
        }
      } catch (error) {
        throw new Error(`Error restarting lxc service: ${error.message}`);
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing lxc.json: ${error.message}`);
    }
  }

  /**
   * Reads the VM settings from the vm.json file.
   * @returns {Promise<Object>} The VM settings as an object
   */
  async getVmSettings() {
    try {
      const data = await fs.readFile('/boot/config/vm.json', 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('vm.json not found');
      }
      throw new Error(`Error reading vm.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the vm.json. Only the passed fields are changed.
   * If enabled is changed, the libvirtd service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateVmSettings(updates) {
    try {
      // Read current settings
      let current = {};
      try {
        const data = await fs.readFile('/boot/config/vm.json', 'utf8');
        current = JSON.parse(data);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['enabled', 'directory', 'vdisk_directory', 'start_wait'];

      // Check directory paths for mount status
      const pathsToCheck = {};
      if (updates.directory && updates.directory !== current.directory) {
        pathsToCheck.directory = updates.directory;
      }
      if (updates.vdisk_directory && updates.vdisk_directory !== current.vdisk_directory) {
        pathsToCheck.vdisk_directory = updates.vdisk_directory;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck);

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`VM directory conflict: ${errorDetails}`);
        }
      }

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        current[key] = updates[key];
      }

      // Write the file
      await fs.writeFile('/boot/config/vm.json', JSON.stringify(current, null, 2), 'utf8');

      // libvirtd service stop/start on configuration changes
      try {
        // VM services always stop when configuration is changed
        // Ignore errors on stop (e.g. if service is already stopped)
        try {
          await execPromise('/etc/init.d/libvirtd stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        try {
          await execPromise('/etc/init.d/virtlogd stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        // VM services only start if enabled = true (mos-start reads the new file)
        if (current.enabled === true) {
          await execPromise('/usr/local/bin/mos-start vm');
        }
      } catch (error) {
        throw new Error(`Error restarting vm service: ${error.message}`);
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing vm.json: ${error.message}`);
    }
  }

  /**
   * Reads the Network-Settings from the network.json file.
   * @returns {Promise<Object>} The Network-Settings as an object
   */
  async getNetworkSettings() {
    try {
      const data = await fs.readFile('/boot/config/network.json', 'utf8');
      const settings = JSON.parse(data);
      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('network.json not found');
      }
      throw new Error(`Error reading network.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the network.json. If a service status changes, the service is restarted.
   * @param {Object} updates - The fields to update (services.samba, services.nfs, services.nut and interfaces are considered)
   * @returns {Promise<Object>} The updated settings
   */
  async updateNetworkSettings(updates) {
    try {
      // Read current settings
      let current = {};
      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        current = JSON.parse(data);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // Handle services and interfaces
      let sambaChanged = false, sambaValue = null;
      let nfsChanged = false, nfsValue = null;
      let nutChanged = false, nutValue = null;
      let sshChanged = false, sshValue = null;
      let nmbdChanged = false, nmbdValue = null;
      let tailscaleChanged = false, tailscaleValue = null;
      let netbirdChanged = false, netbirdValue = null;

      // Handle services
      if (updates.services) {
        if (updates.services.samba && typeof updates.services.samba.enabled === 'boolean') {
          if (!current.services) current.services = {};
          if (!current.services.samba) current.services.samba = {};
          if (current.services.samba.enabled !== updates.services.samba.enabled) {
            sambaChanged = true;
            sambaValue = updates.services.samba.enabled;
          }
          current.services.samba.enabled = updates.services.samba.enabled;
        }
        if (updates.services.nfs && typeof updates.services.nfs.enabled === 'boolean') {
          if (!current.services) current.services = {};
          if (!current.services.nfs) current.services.nfs = {};
          if (current.services.nfs.enabled !== updates.services.nfs.enabled) {
            nfsChanged = true;
            nfsValue = updates.services.nfs.enabled;
          }
          current.services.nfs.enabled = updates.services.nfs.enabled;
          // Add exports if necessary
          if (Array.isArray(updates.services.nfs.exports)) {
            current.services.nfs.exports = updates.services.nfs.exports;
          }
        }
        if (updates.services.nut && typeof updates.services.nut.enabled === 'boolean') {
          if (!current.services) current.services = {};
          if (!current.services.nut) current.services.nut = {};
          if (current.services.nut.enabled !== updates.services.nut.enabled) {
            nutChanged = true;
            nutValue = updates.services.nut.enabled;
          }
          current.services.nut.enabled = updates.services.nut.enabled;
        }
        if (updates.services.ssh && typeof updates.services.ssh.enabled === 'boolean') {
          if (!current.services) current.services = {};
          if (!current.services.ssh) current.services.ssh = {};
          if (current.services.ssh.enabled !== updates.services.ssh.enabled) {
            sshChanged = true;
            sshValue = updates.services.ssh.enabled;
          }
          current.services.ssh.enabled = updates.services.ssh.enabled;
        }
        if (updates.services.nmbd && typeof updates.services.nmbd.enabled === 'boolean') {
          if (!current.services) current.services = {};
          if (!current.services.nmbd) current.services.nmbd = {};
          if (current.services.nmbd.enabled !== updates.services.nmbd.enabled) {
            nmbdChanged = true;
            nmbdValue = updates.services.nmbd.enabled;
          }
          current.services.nmbd.enabled = updates.services.nmbd.enabled;
        }
        if (updates.services.tailscale) {
          if (!current.services) current.services = {};
          if (!current.services.tailscale) current.services.tailscale = {};
          if (typeof updates.services.tailscale.enabled === 'boolean' &&
              current.services.tailscale.enabled !== updates.services.tailscale.enabled) {
            tailscaleChanged = true;
            tailscaleValue = updates.services.tailscale.enabled;
          }
          if (updates.services.tailscale.enabled !== undefined)
            current.services.tailscale.enabled = updates.services.tailscale.enabled;
          if (updates.services.tailscale.update_check !== undefined)
            current.services.tailscale.update_check = updates.services.tailscale.update_check;
          if (updates.services.tailscale.tailscaled_params !== undefined)
            current.services.tailscale.tailscaled_params = updates.services.tailscale.tailscaled_params;
        }
        if (updates.services.netbird) {
          if (!current.services) current.services = {};
          if (!current.services.netbird) current.services.netbird = {};
          if (typeof updates.services.netbird.enabled === 'boolean' &&
              current.services.netbird.enabled !== updates.services.netbird.enabled) {
            netbirdChanged = true;
            netbirdValue = updates.services.netbird.enabled;
          }
          if (updates.services.netbird.enabled !== undefined)
            current.services.netbird.enabled = updates.services.netbird.enabled;
          if (updates.services.netbird.update_check !== undefined)
            current.services.netbird.update_check = updates.services.netbird.update_check;
          if (updates.services.netbird.netbird_service_params !== undefined)
            current.services.netbird.netbird_service_params = updates.services.netbird.netbird_service_params;
        }
      }

      // Handle interfaces
      let interfacesChanged = false;
      let primaryInterfaceChanged = false;
      let oldPrimaryInterface = this._determinePrimaryInterface(current.interfaces || []);

      if (updates.interfaces) {
        if (!Array.isArray(current.interfaces)) current.interfaces = [];
        if (!Array.isArray(updates.interfaces)) {
          throw new Error('interfaces must be an array');
        }

        // Check if anything has changed
        if (JSON.stringify(current.interfaces) !== JSON.stringify(updates.interfaces)) {
          interfacesChanged = true;
        }

        // Analyze current and new interface states
        const currentEth0 = current.interfaces.find(iface => iface.name === 'eth0');
        const currentBr0 = current.interfaces.find(iface => iface.name === 'br0');
        const newEth0 = updates.interfaces.find(iface => iface.name === 'eth0');
        const newBr0 = updates.interfaces.find(iface => iface.name === 'br0');

        // Interfaces directly assign (only new format supported)
        current.interfaces = updates.interfaces;

        // Bridge logic: eth0 set to bridged and br0 is missing
        if (newEth0 && newEth0.type === 'bridged' && !newBr0) {
          // Automatically create br0 Bridge-Interface
          const br0Interface = {
            name: 'br0',
            type: 'bridge',
            mode: null,
            interfaces: ['eth0'],
            ipv4: newEth0.ipv4 && newEth0.ipv4.length > 0 ? newEth0.ipv4 : [{ dhcp: false }],
            ipv6: []
          };

          // Reset eth0 (bridged interfaces have no IP configuration)
          newEth0.ipv4 = [];
          newEth0.ipv6 = [];

          current.interfaces.push(br0Interface);
          interfacesChanged = true;
        }

        // Bridge logic: eth0 from bridged to ethernet and br0 exists
        if (newEth0 && newEth0.type === 'ethernet' && currentBr0) {
          // IP configuration from br0 to eth0 (new format)
          if (currentBr0.ipv4 && Array.isArray(currentBr0.ipv4) && currentBr0.ipv4.length > 0) {
            newEth0.ipv4 = currentBr0.ipv4;
          }

          // br0 aus interfaces entfernen
          current.interfaces = current.interfaces.filter(iface => iface.name !== 'br0');
          interfacesChanged = true;
        }

        // Validation for static IP configuration
        for (const iface of current.interfaces) {
          if (iface.ipv4 && Array.isArray(iface.ipv4)) {
            for (const ipv4Config of iface.ipv4) {
              if (ipv4Config.dhcp === false && !ipv4Config.address) {
                throw new Error(`Interface ${iface.name}: address is required when dhcp=false`);
              }
            }
          }
        }
      }

      // Check if primary interface has changed
      const newPrimaryInterface = this._determinePrimaryInterface(current.interfaces || []);
      if (oldPrimaryInterface !== newPrimaryInterface) {
        primaryInterfaceChanged = true;
      }

      // Write file
      await fs.writeFile('/boot/config/network.json', JSON.stringify(current, null, 2), 'utf8');

      // Update LXC default.conf if interfaces or primary interface have changed
      if (interfacesChanged || primaryInterfaceChanged) {
        await this._updateLxcDefaultConf(newPrimaryInterface, current.interfaces);
      }

      // Networking restart if interfaces have changed
      if (interfacesChanged) {
        await execPromise('/etc/init.d/networking restart');
      }

      // Services stop/start
      if (sambaChanged) {
        if (sambaValue === false) {
          await execPromise('/etc/init.d/smbd stop');
        } else if (sambaValue === true) {
          await execPromise('/etc/init.d/smbd start');
        }
      }
      if (nfsChanged) {
        if (nfsValue === false) {
          await execPromise('/etc/init.d/umountnfs.sh stop');
        } else if (nfsValue === true) {
          await execPromise('/etc/init.d/mountnfs.sh start');
        }
      }
      if (nutChanged) {
        if (nutValue === false) {
          await execPromise('/etc/init.d/nut-client stop');
          await execPromise('/etc/init.d/nut-server stop');
        } else if (nutValue === true) {
          await execPromise('/etc/init.d/nut-client start');
          await execPromise('/etc/init.d/nut-server start');
        }
      }
      if (sshChanged) {
        if (sshValue === false) {
          await execPromise('/etc/init.d/ssh stop');
        } else if (sshValue === true) {
          await execPromise('/etc/init.d/ssh start');
        }
      }
      if (nmbdChanged) {
        if (nmbdValue === false) {
          await execPromise('/etc/init.d/nmbd stop');
        } else if (nmbdValue === true) {
          await execPromise('/etc/init.d/nmbd start');
        }
      }
      if (tailscaleChanged) {
        if (tailscaleValue === false) {
          await execPromise('/etc/init.d/tailscaled stop');
        } else if (tailscaleValue === true) {
          await execPromise('/etc/init.d/tailscaled start');
        }
      }
      if (netbirdChanged) {
        if (netbirdValue === false) {
          await execPromise('/etc/init.d/netbird stop');
        } else if (netbirdValue === true) {
          await execPromise('/etc/init.d/netbird start');
        }
      }
      return current;
    } catch (error) {
      throw new Error(`Fehler beim Schreiben der network.json: ${error.message}`);
    }
  }

  /**
   * Reads the system settings from the system.json file.
   * @returns {Promise<Object>} The system settings as an object
   */
  async getSystemSettings() {
    try {
      const data = await fs.readFile('/boot/config/system.json', 'utf8');
      const settings = JSON.parse(data);
      
      // Ensure notification_sound defaults are present
      if (!settings.notification_sound) {
        settings.notification_sound = {
          startup: true,
          reboot: true,
          shutdown: true
        };
        
        // Write back the updated settings with defaults
        try {
          await fs.writeFile('/boot/config/system.json', JSON.stringify(settings, null, 2), 'utf8');
        } catch (writeError) {
          console.warn('Warning: Could not write notification_sound defaults to system.json:', writeError.message);
        }
      }
      
      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('system.json nicht gefunden');
      }
      throw new Error(`Fehler beim Lesen der system.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the system.json. Only hostname and global_spindown are accepted.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateSystemSettings(updates) {
    try {
      // Read current settings
      let current = {};
      try {
        const data = await fs.readFile('/boot/config/system.json', 'utf8');
        current = JSON.parse(data);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['hostname', 'global_spindown', 'keymap', 'timezone', 'ntp', 'notification_sound'];
      let ntpChanged = false;
      let keymapChanged = false;
      let timezoneChanged = false;

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Ungültiges Feld: ${key}`);
        }

        if (key === 'ntp') {
          // Update NTP settings
          if (!current.ntp) current.ntp = {};

          // Check if enabled has changed
          if (updates.ntp.enabled !== undefined && updates.ntp.enabled !== current.ntp.enabled) {
            ntpChanged = true;
          }

          // Check if other NTP settings have changed and service is active
          if (current.ntp.enabled === true && (
            (updates.ntp.mode !== undefined && updates.ntp.mode !== current.ntp.mode) ||
            (Array.isArray(updates.ntp.servers) && JSON.stringify(updates.ntp.servers) !== JSON.stringify(current.ntp.servers))
          )) {
            ntpChanged = true;
          }

          // Update NTP settings
          if (updates.ntp.enabled !== undefined) current.ntp.enabled = updates.ntp.enabled;
          if (updates.ntp.mode !== undefined) current.ntp.mode = updates.ntp.mode;
          if (Array.isArray(updates.ntp.servers)) current.ntp.servers = updates.ntp.servers;
        } else if (key === 'keymap') {
          if (updates.keymap !== current.keymap) {
            keymapChanged = true;
          }
          current[key] = updates[key];
        } else if (key === 'timezone') {
          if (updates.timezone !== current.timezone) {
            timezoneChanged = true;
          }
          current[key] = updates[key];
        } else if (key === 'notification_sound') {
          // Initialize notification_sound with defaults if not present
          if (!current.notification_sound) {
            current.notification_sound = {
              startup: true,
              reboot: true,
              shutdown: true
            };
          }
          
          // Update notification_sound settings
          if (typeof updates.notification_sound === 'object' && updates.notification_sound !== null) {
            // Merge with existing settings, keeping defaults for missing values
            current.notification_sound = {
              startup: updates.notification_sound.startup !== undefined ? updates.notification_sound.startup : current.notification_sound.startup,
              reboot: updates.notification_sound.reboot !== undefined ? updates.notification_sound.reboot : current.notification_sound.reboot,
              shutdown: updates.notification_sound.shutdown !== undefined ? updates.notification_sound.shutdown : current.notification_sound.shutdown
            };
          }
        } else {
          current[key] = updates[key];
        }
      }

      // Write file
      await fs.writeFile('/boot/config/system.json', JSON.stringify(current, null, 2), 'utf8');

      // NTP service stop/start/restart if changed
      if (ntpChanged) {
        if (current.ntp.enabled === false) {
          await execPromise('/etc/init.d/ntpsec stop');
        } else if (current.ntp.enabled === true) {
          // If service was already active and settings have changed, restart
          if (updates.ntp && (updates.ntp.mode !== undefined || Array.isArray(updates.ntp.servers))) {
            await execPromise('/etc/init.d/ntpsec restart');
          } else {
            await execPromise('/etc/init.d/ntpsec start');
          }
        }
      }

      // Keymap directly into system load
      if (keymapChanged) {
        await execPromise(`loadkeys ${current.keymap}`);
      }

      // Timezone directly into system set
      if (timezoneChanged) {
        await execPromise(`ln -sf /usr/share/zoneinfo/${current.timezone} /etc/localtime`);
      }

      return current;
    } catch (error) {
      throw new Error(`Fehler beim Schreiben der system.json: ${error.message}`);
    }
  }

  async listKeymaps() {
    try {
      const keymaps = [];
      const basePath = '/usr/share/keymaps/i386';
      const subdirs = await fs.readdir(basePath);

      for (const subdir of subdirs) {
        const subdirPath = `${basePath}/${subdir}`;
        try {
          const files = await fs.readdir(subdirPath);
          const mapFiles = files.filter(f => f.endsWith('.kmap') || f.endsWith('.kmap.gz'));
          mapFiles.forEach(f => {
            const keymapName = f.replace(/\.kmap.gz$/, '');
            if (!keymaps.includes(keymapName)) {
              keymaps.push(keymapName);
            }
          });
        } catch (error) {
          continue;
        }
      }
      return keymaps.sort();
    } catch (error) {
      throw new Error('Fehler beim Lesen der Keymaps: ' + error.message);
    }
  }

  /**
   * Lists all available timezones under /usr/share/zoneinfo recursively (only files, no directories)
   * @returns {Promise<string[]>} Array of timezones (e.g. Europe/Vienna)
   */
  async listTimezones() {
    const basePath = '/usr/share/zoneinfo';
    const result = [];
    async function walk(dir, relPath = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip hidden and special directories
          if (entry.name.startsWith('.')) continue;
          await walk(`${dir}/${entry.name}`, relPath ? `${relPath}/${entry.name}` : entry.name);
        } else if (entry.isFile()) {
          // Only real timezone files (no posix, right, localtime, etc.)
          if (['posix', 'right', 'localtime', 'posixrules', 'leapseconds', 'zone.tab', 'zone1970.tab', 'iso3166.tab', 'tzdata.zi', 'leap-seconds.list'].includes(entry.name)) continue;
          result.push(relPath ? `${relPath}/${entry.name}` : entry.name);
        }
      }
    }
    await walk(basePath);
    // Filter out right/ timezones
    const filteredResult = result.filter(tz => !tz.startsWith('right/'));
    return filteredResult.sort();
  }

  /**
   * Public method to check directory mount status
   * @param {string|Object} directoryPaths - Single path or object with paths {fieldName: path}
   * @returns {Promise<Object>} Check result
   */
  async checkDirectoryMountStatus(directoryPaths) {
    try {
      if (typeof directoryPaths === 'string') {
        // Einzelner Pfad
        const result = await this._checkDirectoryMountStatus(directoryPaths);
        return {
          path: directoryPaths,
          ...result
        };
      } else if (typeof directoryPaths === 'object') {
        // Mehrere Pfade
        const result = await this._checkMultipleDirectories(directoryPaths);
        return {
          hasErrors: result.hasErrors,
          directories: Object.keys(directoryPaths).map(fieldName => ({
            field: fieldName,
            path: directoryPaths[fieldName],
            ...result.results[fieldName]
          })),
          errors: result.errors
        };
      } else {
        throw new Error('directoryPaths must be a string or object');
      }
    } catch (error) {
      throw new Error(`Error checking directory mount status: ${error.message}`);
    }
  }

  /**
   * Restarts services
   * @param {string} service - Service name ('api' or 'nginx')
   * @returns {Promise<Object>} Restart status
   */
  async restartService(service) {
    try {
      const allowedServices = ['api', 'nginx'];
      if (!allowedServices.includes(service)) {
        throw new Error(`Service '${service}' not allowed. Allowed: ${allowedServices.join(', ')}`);
      }

      // Create a detached child process that executes the restart immediately
      const { spawn } = require('child_process');

      // Execute the restart directly in a detached process
      const child = spawn('/etc/init.d/' + service, ['restart'], {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: `${service} restart initiated`,
        service,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error initiating service restart: ${error.message}`);
    }
  }

  /**
   * Restarts the API immediately
   * @returns {Promise<Object>} Restart status
   */
  async restartApi() {
    return await this.restartService('api');
  }

  /**
   * Restarts nginx immediately
   * @returns {Promise<Object>} Restart status
   */
  async restartNginx() {
    return await this.restartService('nginx');
  }

  /**
   * Updates the LXC default.conf with the current primary interface and correct network type
   * @param {string} primaryInterface - The primary interface (br0 or eth0)
   * @param {Array} interfaces - Interface array from network.json for type determination
   * @returns {Promise<void>}
   */
  async _updateLxcDefaultConf(primaryInterface, interfaces = []) {
    try {
      const confPath = '/boot/config/system/lxc/default.conf';
      let confContent = '';

      // Determine the correct LXC Network Type
      const networkType = this._determineLxcNetworkType(primaryInterface, interfaces);

      try {
        confContent = await fs.readFile(confPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // File does not exist, create basic configuration
        confContent = `# LXC default configuration
lxc.net.0.type = ${networkType}
lxc.net.0.link = ${primaryInterface}
lxc.net.0.flags = up
lxc.net.0.hwaddr = 00:16:3e:xx:xx:xx
`;
      }

      // Replace the type line with the correct network type
      const typeRegex = /^lxc\.net\.0\.type\s*=\s*.+$/m;
      const newTypeLine = `lxc.net.0.type = ${networkType}`;

      if (typeRegex.test(confContent)) {
        confContent = confContent.replace(typeRegex, newTypeLine);
      } else {
        // Add the line if it doesn't exist
        confContent += `\nlxc.net.0.type = ${networkType}\n`;
      }

      // Replace the link line with the new interface
      const linkRegex = /^lxc\.net\.0\.link\s*=\s*.+$/m;
      const newLinkLine = `lxc.net.0.link = ${primaryInterface}`;

      if (linkRegex.test(confContent)) {
        confContent = confContent.replace(linkRegex, newLinkLine);
      } else {
        // Add the line if it doesn't exist
        confContent += `\nlxc.net.0.link = ${primaryInterface}\n`;
      }

      // Make sure the directory exists
      await fs.mkdir('/boot/config/system/lxc', { recursive: true });

      // Write the updated configuration
      await fs.writeFile(confPath, confContent, 'utf8');

      console.log(`LXC default.conf updated: lxc.net.0.type = ${networkType}, lxc.net.0.link = ${primaryInterface}`);
    } catch (error) {
      console.warn(`Warning: Could not update LXC default.conf: ${error.message}`);
    }
  }

  /**
   * Determines the correct LXC Network Type based on Interface Configuration
   * @param {string} primaryInterface - The primary interface (br0 or eth0)
   * @param {Array} interfaces - Interface array from network.json
   * @returns {string} LXC Network Type (veth, macvlan, etc.)
   */
  _determineLxcNetworkType(primaryInterface, interfaces = []) {
    if (!Array.isArray(interfaces)) {
      return 'veth'; // Standard fallback
    }

    const primaryIface = interfaces.find(iface => iface.name === primaryInterface);

    if (primaryIface) {
      // If it is a bridge, use veth
      if (primaryIface.type === 'bridge') {
        return 'veth';
      }

      // If it is a direct interface, use macvlan
      if (primaryIface.type === 'ethernet') {
        return 'macvlan';
      }

      // If it is a bridged interface, use veth
      if (primaryIface.type === 'bridged') {
        return 'veth';
      }
    }

    //  Fallback: Bridge-Interfaces verwenden veth, direkte Interfaces verwenden macvlan
    return primaryInterface === 'br0' ? 'veth' : 'macvlan';
  }



  /**
   * Determines the primary network interface based on the current configuration
   * @param {Array} interfaces - Interface array from network.json
   * @returns {string} The primary interface (br0 or eth0)
   */
  _determinePrimaryInterface(interfaces) {
    if (!Array.isArray(interfaces)) {
      return 'eth0';
    }

    // Check if br0 exists and is active
    const br0 = interfaces.find(iface => iface.name === 'br0');
    if (br0 && br0.type === 'bridge') {
      return 'br0';
    }

    // Check if eth0 is set to bridged
    const eth0 = interfaces.find(iface => iface.name === 'eth0');
    if (eth0 && eth0.type === 'bridged') {
      return 'br0';
    }

    // Default is eth0
    return 'eth0';
  }

  /**
   * Gets the status of all services from different configuration files
   * @returns {Promise<Object>} Status object with all services (flat structure)
   */
  async getAllServiceStatus() {
    try {
      const result = {
        docker: { enabled: false },
        lxc: { enabled: false },
        vm: { enabled: false }
      };

      // Docker Status
      try {
        const dockerSettings = await this.getDockerSettings();
        result.docker.enabled = dockerSettings.enabled === true;
      } catch (error) {
        // File not found or error - remains false
        console.warn('Docker settings not accessible:', error.message);
      }

      // LXC Status
      try {
        const lxcSettings = await this.getLxcSettings();
        result.lxc.enabled = lxcSettings.enabled === true;
      } catch (error) {
        // File not found or error - remains false
        console.warn('LXC settings not accessible:', error.message);
      }

      // VM Status
      try {
        const vmSettings = await this.getVmSettings();
        result.vm.enabled = vmSettings.enabled === true;
      } catch (error) {
        // File not found or error - remains false
        console.warn('VM settings not accessible:', error.message);
      }

      // Network Services Status - directly in result (flat structure)
      try {
        const networkSettings = await this.getNetworkSettings();

        // Dynamically extract all services from network.json.services
        if (networkSettings.services && typeof networkSettings.services === 'object') {
          for (const [serviceName, serviceConfig] of Object.entries(networkSettings.services)) {
            if (serviceConfig && typeof serviceConfig === 'object' && 'enabled' in serviceConfig) {
              result[serviceName] = {
                enabled: serviceConfig.enabled === true
              };
            }
          }
        }
      } catch (error) {
        // File not found or error - services are skipped
        console.warn('Network settings not accessible:', error.message);
      }

      return result;
    } catch (error) {
      throw new Error(`Fehler beim Abrufen des Service-Status: ${error.message}`);
    }
  }

  /**
   * Gets available releases via the mos-os_get_releases script
   * @returns {Promise<Object>} Release information grouped by channels
   */
  async getReleases() {
    try {
      const command = '/usr/local/bin/mos-os_get_releases';

      console.log(`Executing get releases command: ${command}`);

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        console.warn('Get releases script stderr:', stderr);
      }

      // Read JSON file
      const releasesPath = '/var/mos/mos-update/releases.json';

      try {
        const releasesData = await fs.readFile(releasesPath, 'utf8');
        const releases = JSON.parse(releasesData);

        if (!Array.isArray(releases)) {
          throw new Error('Invalid releases data format - expected array');
        }

        // Group releases by channels based on tag_name
        const groupedReleases = {
          alpha: [],
          beta: [],
          stable: []
        };

        releases.forEach(release => {
          if (release.tag_name) {
            const tagName = release.tag_name.toLowerCase();

            if (tagName.includes('-alpha')) {
              groupedReleases.alpha.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            } else if (tagName.includes('-beta')) {
              groupedReleases.beta.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            } else {
              // Alles andere als stable behandeln (keine -alpha oder -beta Kennzeichnung)
              groupedReleases.stable.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            }
          }
        });

        // Sort releases by date (newest first)
        Object.keys(groupedReleases).forEach(channel => {
          groupedReleases[channel].sort((a, b) =>
            new Date(b.published_at) - new Date(a.published_at)
          );
        });

        return groupedReleases;

      } catch (fileError) {
        throw new Error(`Failed to read or parse releases file: ${fileError.message}`);
      }

    } catch (error) {
      console.error('Get releases error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets the current release information from /etc/mos-release.json
   * @returns {Promise<Object>} Release information
   */
  async getCurrentRelease() {
    try {
      const releasePath = '/etc/mos-release.json';
      const releaseData = await fs.readFile(releasePath, 'utf8');
      const release = JSON.parse(releaseData);

      return release;

    } catch (error) {
      console.error('Get current release error:', error.message);
      throw new Error(`Failed to read release information: ${error.message}`);
    }
  }

  /**
   * Executes an OS update using the mos-os_update script
   * @param {string} version - Version (latest or version number like 0.0.0, 1.223.1)
   * @param {string} channel - Update channel (alpha, beta, stable)
   * @param {boolean} updateKernel - Optional, whether to update the kernel (default: true)
   * @returns {Promise<Object>} Update status
   */
  async updateOS(version, channel, updateKernel = true) {
    try {
      // Parameter validation
      if (!version || typeof version !== 'string') {
        throw new Error('Version parameter is required and must be a string');
      }

      if (!channel || !['alpha', 'beta', 'stable'].includes(channel)) {
        throw new Error('Channel must be one of: alpha, beta, stable');
      }

      // Version validation - either "latest" or version number format (with optional suffixes)
      const versionPattern = /^(latest|\d+\.\d+\.\d+.*)$/;
      if (!versionPattern.test(version)) {
        throw new Error('Version must be "latest" or start with a version number (e.g., 0.0.0, 1.223.1, 0.0.0-alpha.1)');
      }

      // Command arguments
      const args = [version, channel];

      // Add third argument only if updateKernel is true
      if (updateKernel === true) {
        args.push('update_kernel');
      }

      const command = `/usr/local/bin/mos-os_update ${args.join(' ')}`;

      console.log(`Executing OS update command: ${command}`);

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      return {
        success: true,
        message: 'OS update initiated successfully',
        version,
        channel,
        updateKernel,
        command,
        output: stdout,
        error: stderr || null,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('OS update error:', error.message);
      return {
        success: false,
        error: error.message,
        version,
        channel,
        updateKernel,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes an OS rollback using the mos-os_update script
   * @param {boolean} kernelRollback - Optional, whether to perform a kernel rollback (default: true)
   * @returns {Promise<Object>} Rollback status
   */
  async rollbackOS(kernelRollback = true) {
    try {
      // Arguments for the command
      const args = ['rollback_mos'];

      // "not_kernel" argument only add if kernelRollback is explicitly false
      if (kernelRollback === false) {
        args.push('not_kernel');
      }

      const command = `/usr/local/bin/mos-os_update ${args.join(' ')}`;

      console.log(`Executing OS rollback command: ${command}`);

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      return {
        success: true,
        message: 'OS rollback initiated successfully',
        kernelRollback,
        command,
        output: stdout,
        error: stderr || null,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('OS rollback error:', error.message);
      return {
        success: false,
        error: error.message,
        kernelRollback,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = new MosService();
