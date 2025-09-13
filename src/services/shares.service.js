const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const poolsService = require('./pools.service');

class SharesService {
  constructor() {
    this.sharesConfigPath = '/boot/config/shares.json';
    this.poolsConfigPath = '/boot/config/pools.json';
  }

  /**
   * Restart SMB daemon
   * @returns {Promise<boolean>} Success status
   */
  async _restartSmbd() {
    try {
      await execAsync('/etc/init.d/smbd restart');
      return true;
    } catch (error) {
      console.error(`Error restarting SMB daemon: ${error.message}`);
      // Do not treat as critical error - Share was still created/deleted
      return false;
    }
  }

  /**
   * Restart NFS daemon
   * @returns {Promise<boolean>} Success status
   */
  async _restartNfsd() {
    try {
      // Devuan/SysV init - Restart mountnfs (re-generated exports automatically)
      await execAsync('/etc/init.d/mountnfs.sh generate');
      return true;
    } catch (error) {
      console.error(`Error restarting NFS daemon: ${error.message}`);
      // Do not treat as critical error - Share was still created/deleted
      return false;
    }
  }

  /**
   * Get shares configuration from /boot/config/shares.json
   * @returns {Promise<Object>} Shares configuration
   */
  async getShares() {
    try {
      // Check if the file exists
      await fs.access(this.sharesConfigPath);

      // Read the shares.json file
      const sharesData = await fs.readFile(this.sharesConfigPath, 'utf8');

      // Parse JSON and return
      const sharesConfig = JSON.parse(sharesData);

      // Simple validation: Make sure it's an array
      if (!Array.isArray(sharesConfig)) {
        throw new Error(`Invalid shares configuration format: Expected array, got ${typeof sharesConfig}`);
      }

      return sharesConfig;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Shares configuration file not found at ${this.sharesConfigPath}`);
      } else if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in shares configuration file: ${error.message}`);
      } else if (error.code === 'EACCES') {
        throw new Error(`Permission denied reading shares configuration file`);
      } else {
        throw new Error(`Error reading shares configuration: ${error.message}`);
      }
    }
  }

  /**
   * Get SMB shares specifically
   * @returns {Promise<Array>} SMB shares only
   */
  async getSmbShares() {
    try {
      const sharesConfig = await this.getShares();

      // Extract only SMB shares
      let smbShares = [];
      if (sharesConfig && Array.isArray(sharesConfig)) {
        // Go through the array and find SMB entries
        sharesConfig.forEach(item => {
          if (item.smb && Array.isArray(item.smb)) {
            smbShares = smbShares.concat(item.smb);
          }
        });
      }

      return smbShares;
    } catch (error) {
      throw error; // Re-throw to preserve the original error
    }
  }

  /**
   * Get NFS shares specifically
   * @returns {Promise<Array>} NFS shares only
   */
  async getNfsShares() {
    try {
      const sharesConfig = await this.getShares();

      // Extract only NFS shares
      let nfsShares = [];
      if (sharesConfig && Array.isArray(sharesConfig)) {
        // Go through the array and find NFS entries
        sharesConfig.forEach(item => {
          if (item.nfs && Array.isArray(item.nfs)) {
            nfsShares = nfsShares.concat(item.nfs);
          }
        });
      }

      return nfsShares;
    } catch (error) {
      throw error; // Re-throw to preserve the original error
    }
  }

  /**
   * Get shares info/stats
   * @returns {Promise<Object>} Shares statistics
   */
  async getSharesInfo() {
    try {
      const sharesConfig = await this.getShares();

      let totalShares = 0;
      let enabledShares = 0;
      let shareTypes = {};

      if (sharesConfig && Array.isArray(sharesConfig)) {
        sharesConfig.forEach(item => {
          Object.keys(item).forEach(shareType => {
            if (!shareTypes[shareType]) {
              shareTypes[shareType] = 0;
            }

            if (Array.isArray(item[shareType])) {
              item[shareType].forEach(share => {
                totalShares++;
                shareTypes[shareType]++;

                if (share && share.enabled === true) {
                  enabledShares++;
                }
              });
            }
          });
        });
      }

      return {
        success: true,
        data: {
          total: totalShares,
          enabled: enabledShares,
          disabled: totalShares - enabledShares,
          types: shareTypes
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get available pools for share creation
   * @returns {Promise<Array>} Available mounted pools
   */
  async getAvailablePools() {
    try {
      const pools = await poolsService.listPools();

      // Filter only mounted pools
      const availablePools = pools.pools
        .filter(pool => pool.status && pool.status.mounted)
        .map(pool => ({
          name: pool.name,
          id: pool.id,
          type: pool.type,
          mountPath: `/mnt/${pool.name}`,
          totalSpace: pool.status.totalSpace,
          freeSpace: pool.status.freeSpace,
          health: pool.status.health
        }));

      return {
        success: true,
        data: availablePools,
        count: availablePools.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`Error getting available pools: ${error.message}`);
    }
  }

  /**
   * Validate pool exists and is mounted
   * @param {string} poolName - Name of the pool
   * @returns {Promise<Object>} Pool information
   */
  async _validatePool(poolName) {
    try {
      const mountPath = `/mnt/${poolName}`;

      // Simple check: is the mount path accessible and mounted?
      try {
        await fs.access(mountPath);

        // Check if it's actually a mount point by checking /proc/mounts
        const { stdout } = await execAsync('cat /proc/mounts');
        const lines = stdout.split('\n');

        let isMounted = false;
        for (const line of lines) {
          if (line.trim()) {
            const parts = line.split(' ');
            if (parts.length >= 2 && parts[1] === mountPath) {
              isMounted = true;
              break;
            }
          }
        }

        if (!isMounted) {
          throw new Error(`Pool ${poolName} is not mounted`);
        }

      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Pool mount path ${mountPath} does not exist`);
        }
        throw error;
      }

      return {
        name: poolName,
        mountPath
      };
    } catch (error) {
      throw new Error(`Pool validation failed: ${error.message}`);
    }
  }

  /**
   * Extract pool name from share path
   * @param {string} sharePath - Full path to the share
   * @returns {string|null} Pool name or null if not extractable
   */
  _extractPoolNameFromPath(sharePath) {
    try {
      const pathSegments = sharePath.split('/');
      if (pathSegments.length >= 3 && pathSegments[1] === 'mnt') {
        return pathSegments[2];
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract relative path from share path
   * @param {string} sharePath - Full path to the share
   * @param {string} poolName - Pool name
   * @returns {string} Relative path
   */
  _extractRelativePathFromShare(sharePath, poolName) {
    const poolPath = `/mnt/${poolName}`;
    if (sharePath.startsWith(poolPath)) {
      const relativePath = sharePath.substring(poolPath.length);
      return relativePath || '/';
    }
    return '/';
  }

  /**
   * Create default SMB share configuration
   * @param {string} shareName - Name of the share
   * @param {string} sharePath - Full path to the share
   * @param {Object} options - Share options
   * @returns {Object} SMB share configuration
   */
  _createSmbShareConfig(shareName, sharePath, options = {}) {
    const {
      automount = false,
      enabled = true,
      read_only = false,
      guest_ok = false,
      browseable = true,
      write_list = [],
      valid_users = [],
      force_root = false,
      create_mask = "0664",
      directory_mask = "0775",
      inherit_permissions = true,
      hide_dot_files = false,
      preserve_case = true,
      case_sensitive = true,
      comment = null,
      policies = [],
      targetDevices = null
    } = options;

    const shareConfig = {
      id: Date.now().toString(),
      name: shareName,
      path: sharePath,
      automount,
      enabled,
      read_only,
      guest_ok,
      browseable,
      write_list: Array.isArray(write_list) ? write_list : [write_list].filter(Boolean),
      valid_users: Array.isArray(valid_users) ? valid_users : [valid_users].filter(Boolean),
      force_root,
      create_mask,
      directory_mask,
      inherit_permissions,
      hide_dot_files,
      preserve_case,
      case_sensitive,
      comment,
      policies: Array.isArray(policies) ? policies : []
    };

    // Add path_rule if targetDevices are specified
    if (targetDevices && Array.isArray(targetDevices) && targetDevices.length > 0) {
      const poolName = this._extractPoolNameFromPath(sharePath);
      if (poolName) {
        const relativePath = this._extractRelativePathFromShare(sharePath, poolName);
        shareConfig.path_rule = {
          pool: poolName,
          path: relativePath,
          target_devices: targetDevices
        };
      }
    }

    return shareConfig;
  }

  /**
   * Create default NFS share configuration
   * @param {string} shareName - Name of the share
   * @param {string} sharePath - Full path to the share
   * @param {Object} options - Share options
   * @returns {Object} NFS share configuration
   */
  _createNfsShareConfig(shareName, sharePath, options = {}) {
    const {
      source = "10.0.0.0/24",
      enabled = true,
      read_only = false,
      anonuid = null,
      anonpid = null,
      write_operations = "sync",
      mapping = "root_squash",
      secure = "true",
      targetDevices = null
    } = options;

    const shareConfig = {
      id: Date.now().toString(),
      name: shareName,
      path: sharePath,
      source,
      enabled,
      read_only,
      anonuid,
      anonpid,
      write_operations,
      mapping,
      secure
    };

    // Add path_rule if targetDevices are specified
    if (targetDevices && Array.isArray(targetDevices) && targetDevices.length > 0) {
      const poolName = this._extractPoolNameFromPath(sharePath);
      if (poolName) {
        const relativePath = this._extractRelativePathFromShare(sharePath, poolName);
        shareConfig.path_rule = {
          pool: poolName,
          path: relativePath,
          target_devices: targetDevices
        };
      }
    }

    return shareConfig;
  }

  /**
   * Create a new SMB share with optional disk slot specification for MergerFS pools
   * @param {string} shareName - Name of the share
   * @param {string} poolName - Name of the pool
   * @param {string} subPath - Sub-path within the pool (optional)
   * @param {Object} options - Share configuration options
   * @param {string} options.permissions - Directory permissions in octal format (default: '0775')
   * @returns {Promise<Object>} Created share configuration
   */
  async createSmbShare(shareName, poolName, subPath = '', options = {}) {
    try {
      // Validate pool
      const pool = await this._validatePool(poolName);

      // Get pool information for extended functionality
      let poolConfig = null;
      let diskResults = null;
      let pathRuleCreated = false;

      try {
        poolConfig = await this._getPoolByName(poolName);
      } catch (error) {
        // Pool configuration not found - use fallback
        console.warn(`Could not load pool configuration for '${poolName}': ${error.message}`);
      }

      // Extended functionality for MergerFS pools
      if (poolConfig && poolConfig.type === 'mergerfs' && options.targetDevices && Array.isArray(options.targetDevices)) {
        // Validate that the specified disk slots exist
        await this._validateDiskSlots(poolName, options.targetDevices);

        // Create directories on the specified disk slots
        if (options.createDirectories !== false) {
          diskResults = await this._createDiskDirectories(poolName, subPath, options.targetDevices, {
            createDirectories: true,
            setOwnership: true
          });

          // Check if all directories were successfully created
          const failedCreations = Object.keys(diskResults).filter(slot => !diskResults[slot].success);
          if (failedCreations.length > 0) {
            const failureDetails = failedCreations.map(slot =>
              `Slot ${slot}: ${diskResults[slot].error}`
            ).join('; ');
            throw new Error(`Failed to create directories on some disk slots: ${failureDetails}`);
          }
        }

        // Create or update path_rule for this share
        if (options.managePathRules !== false) {
          const rulePath = subPath.startsWith('/') ? subPath : `/${subPath}`;
          try {
            const pathRuleResult = await this.addOrUpdatePathRule(poolName, rulePath, options.targetDevices);
            pathRuleCreated = true;
          } catch (pathRuleError) {
            console.warn(`Could not create path rule: ${pathRuleError.message}`);
          }
        }
      }

      // Create full share path (default behavior)
      const sharePath = path.join(pool.mountPath, subPath).replace(/\/+/g, '/');

      // Check if the share path already exists or should be created (default behavior)
      if (options.createDirectory !== false && (!poolConfig || poolConfig.type !== 'mergerfs' || !options.targetDevices)) {
        try {
          await fs.mkdir(sharePath, { recursive: true });

          // Set ownership to 500:500 (user:group)
          try {
            await execAsync(`chown 500:500 "${sharePath}"`);
          } catch (chownError) {
            // Do nothing
          }

          // Set permissions (default: 0775 = rwxrwxr-x)
          const permissions = options.permissions || '0775';
          try {
            await execAsync(`chmod ${permissions} "${sharePath}"`);
          } catch (chmodError) {
            // Do nothing
          }
        } catch (error) {
          throw new Error(`Could not create share directory ${sharePath}: ${error.message}`);
        }
      } else if (options.createDirectory === false) {
        // Check if path exists
        try {
          await fs.access(sharePath);
        } catch (error) {
          throw new Error(`Share path ${sharePath} does not exist`);
        }
      }

      // Load current shares configuration
      let sharesConfig;
      try {
        sharesConfig = await this.getShares();
      } catch (error) {
        // If file does not exist, create empty configuration
        sharesConfig = [];
      }

      // Check if share name already exists
      if (this._shareExists(sharesConfig, shareName)) {
        throw new Error(`Share with name '${shareName}' already exists`);
      }

      // Create SMB share configuration
      const smbConfig = this._createSmbShareConfig(shareName, sharePath, options);

      // Find or create SMB section
      let smbSection = sharesConfig.find(section => section.smb);
      if (!smbSection) {
        smbSection = { smb: [] };
        sharesConfig.push(smbSection);
      }

      // Add new share to SMB array
      smbSection.smb.push(smbConfig);

      // Save configuration
      await this._saveShares(sharesConfig);

      // Restart SMB daemon
      const smbRestartSuccess = await this._restartSmbd();

      // Build response object
      const result = {
        success: true,
        message: `SMB share '${shareName}' created successfully${smbRestartSuccess ? ' and SMB restarted' : ' (SMB restart failed)'}`,
        data: {
          shareName,
          sharePath,
          poolName,
          config: smbConfig
        },
        smbRestarted: smbRestartSuccess,
        timestamp: new Date().toISOString()
      };

      // Add extended information for MergerFS pools
      if (poolConfig && poolConfig.type === 'mergerfs' && options.targetDevices) {
        result.data.mergerfsDetails = {
          poolType: poolConfig.type,
          targetDevices: options.targetDevices,
          diskDirectories: diskResults,
          pathRuleCreated
        };

        if (diskResults) {
          result.data.mergerfsDetails.createdPaths = Object.keys(diskResults)
            .filter(slot => diskResults[slot].success)
            .map(slot => diskResults[slot].path);
        }
      }

      return result;

    } catch (error) {
      throw new Error(`Error creating SMB share: ${error.message}`);
    }
  }

  /**
   * Create a new NFS share with optional disk slot specification for MergerFS pools
   * @param {string} shareName - Name of the share
   * @param {string} poolName - Name of the pool
   * @param {string} subPath - Sub-path within the pool (optional)
   * @param {Object} options - Share configuration options
   * @param {string} options.permissions - Directory permissions in octal format (default: '0775')
   * @returns {Promise<Object>} Created share configuration
   */
  async createNfsShare(shareName, poolName, subPath = '', options = {}) {
    try {
      // Validate pool
      const pool = await this._validatePool(poolName);

      // Get pool information for extended functionality
      let poolConfig = null;
      let diskResults = null;
      let pathRuleCreated = false;

      try {
        poolConfig = await this._getPoolByName(poolName);
      } catch (error) {
        // Pool configuration not found - use fallback
        console.warn(`Could not load pool configuration for '${poolName}': ${error.message}`);
      }

      // Extended functionality for MergerFS pools
      if (poolConfig && poolConfig.type === 'mergerfs' && options.targetDevices && Array.isArray(options.targetDevices)) {
        // Validate that the specified disk slots exist
        await this._validateDiskSlots(poolName, options.targetDevices);

        // Create directories on the specified disk slots
        if (options.createDirectories !== false) {
          diskResults = await this._createDiskDirectories(poolName, subPath, options.targetDevices, {
            createDirectories: true,
            setOwnership: true
          });

          // Check if all directories were successfully created
          const failedCreations = Object.keys(diskResults).filter(slot => !diskResults[slot].success);
          if (failedCreations.length > 0) {
            const failureDetails = failedCreations.map(slot =>
              `Slot ${slot}: ${diskResults[slot].error}`
            ).join('; ');
            throw new Error(`Failed to create directories on some disk slots: ${failureDetails}`);
          }
        }

        // Create or update path_rule for this share
        if (options.managePathRules !== false) {
          const rulePath = subPath.startsWith('/') ? subPath : `/${subPath}`;
          try {
            const pathRuleResult = await this.addOrUpdatePathRule(poolName, rulePath, options.targetDevices);
            pathRuleCreated = true;
          } catch (pathRuleError) {
            console.warn(`Could not create path rule: ${pathRuleError.message}`);
          }
        }
      }

      // Create full share path (default behavior)
      const sharePath = path.join(pool.mountPath, subPath).replace(/\/+/g, '/');

      // Check if the share path already exists or should be created (default behavior)
      if (options.createDirectory !== false && (!poolConfig || poolConfig.type !== 'mergerfs' || !options.targetDevices)) {
        try {
          await fs.mkdir(sharePath, { recursive: true });

          // Set ownership to 500:500 (user:group)
          try {
            await execAsync(`chown 500:500 "${sharePath}"`);
          } catch (chownError) {
            // Do nothing
          }

          // Set permissions (default: 0775 = rwxrwxr-x)
          const permissions = options.permissions || '0775';
          try {
            await execAsync(`chmod ${permissions} "${sharePath}"`);
          } catch (chmodError) {
            // Do nothing
          }
        } catch (error) {
          throw new Error(`Could not create share directory ${sharePath}: ${error.message}`);
        }
      } else if (options.createDirectory === false) {
        // Check if path exists
        try {
          await fs.access(sharePath);
        } catch (error) {
          throw new Error(`Share path ${sharePath} does not exist`);
        }
      }

      // Load current shares configuration
      let sharesConfig;
      try {
        sharesConfig = await this.getShares();
      } catch (error) {
        // If file does not exist, create empty configuration
        sharesConfig = [];
      }

      // Check if share name already exists
      if (this._shareExists(sharesConfig, shareName)) {
        throw new Error(`Share with name '${shareName}' already exists`);
      }

      // Create NFS share configuration
      const nfsConfig = this._createNfsShareConfig(shareName, sharePath, options);

      // Find or create NFS section
      let nfsSection = sharesConfig.find(section => section.nfs);
      if (!nfsSection) {
        nfsSection = { nfs: [] };
        sharesConfig.push(nfsSection);
      }

      // Add new share to NFS array
      nfsSection.nfs.push(nfsConfig);

      // Save configuration
      await this._saveShares(sharesConfig);

      // Restart NFS daemon
      const nfsRestartSuccess = await this._restartNfsd();

      // Build response object
      const result = {
        success: true,
        message: `NFS share '${shareName}' created successfully${nfsRestartSuccess ? ' and NFS restarted' : ' (NFS restart failed)'}`,
        data: {
          shareName,
          sharePath,
          poolName,
          config: nfsConfig
        },
        nfsRestarted: nfsRestartSuccess,
        timestamp: new Date().toISOString()
      };

      // Add extended information for MergerFS pools
      if (poolConfig && poolConfig.type === 'mergerfs' && options.targetDevices) {
        result.data.mergerfsDetails = {
          poolType: poolConfig.type,
          targetDevices: options.targetDevices,
          diskDirectories: diskResults,
          pathRuleCreated
        };

        if (diskResults) {
          result.data.mergerfsDetails.createdPaths = Object.keys(diskResults)
            .filter(slot => diskResults[slot].success)
            .map(slot => diskResults[slot].path);
        }
      }

      return result;

    } catch (error) {
      throw new Error(`Error creating NFS share: ${error.message}`);
    }
  }

  /**
   * Check if a share name already exists
   * @param {Array} sharesConfig - Current shares configuration
   * @param {string} shareName - Name to check
   * @returns {boolean} True if share exists
   */
  _shareExists(sharesConfig, shareName) {
    if (!Array.isArray(sharesConfig)) return false;

    return sharesConfig.some(section => {
      return Object.keys(section).some(shareType => {
        if (Array.isArray(section[shareType])) {
          return section[shareType].some(share => {
            return share.name === shareName;
          });
        }
        return false;
      });
    });
  }

  /**
   * Find a share by ID
   * @param {Array} sharesConfig - Current shares configuration
   * @param {string} shareId - ID to find
   * @returns {Object|null} Share object with metadata or null if not found
   */
  _findShareById(sharesConfig, shareId) {
    if (!Array.isArray(sharesConfig)) return null;

    for (const section of sharesConfig) {
      for (const shareType of Object.keys(section)) {
        if (Array.isArray(section[shareType])) {
          const shareIndex = section[shareType].findIndex(share => share.id === shareId);
          if (shareIndex !== -1) {
            return {
              share: section[shareType][shareIndex],
              section,
              shareType,
              shareIndex
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * Save shares configuration to file
   * @param {Array} sharesConfig - Shares configuration to save
   */
  async _saveShares(sharesConfig) {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.sharesConfigPath), { recursive: true });

      // Save JSON with pretty formatting
      await fs.writeFile(this.sharesConfigPath, JSON.stringify(sharesConfig, null, 2));
    } catch (error) {
      throw new Error(`Error saving shares configuration: ${error.message}`);
    }
  }

  /**
   * Delete a share by ID
   * @param {string} shareId - ID of the share to delete
   * @param {Object} options - Delete options
   * @returns {Promise<Object>} Delete result
   */
  async deleteShare(shareId, options = {}) {
    try {
      const { deleteDirectory = false, removePathRule = true } = options;

      // Load current shares configuration
      const sharesConfig = await this.getShares();

      // Search for share only by ID
      const shareResult = this._findShareById(sharesConfig, shareId);

      if (!shareResult) {
        throw new Error(`Share with ID '${shareId}' not found`);
      }

      const { share: deletedShare, section, shareType, shareIndex } = shareResult;
      const sharePath = deletedShare.path;
      const shareName = deletedShare.name;
      const deletedShareId = deletedShare.id;

      // Extract pool name from share path
      const poolName = this._extractPoolNameFromPath(sharePath);

      let pathRuleRemoved = false;

      // Try to remove path rule if share has one or if desired
      if (removePathRule && poolName) {
        try {
          // Check if share has an embedded path rule
          if (deletedShare.path_rule && deletedShare.path_rule.pool === poolName) {
            try {
              await this.removePathRule(deletedShare.path_rule.pool, deletedShare.path_rule.path);
              pathRuleRemoved = true;
            } catch (pathRuleError) {
              console.warn(`Could not remove embedded path rule: ${pathRuleError.message}`);
            }
          } else {
            // Fallback: Try to remove path rule based on share path
            const relativePath = this._extractRelativePathFromShare(sharePath, poolName);
            if (relativePath && relativePath !== '/') {
              try {
                await this.removePathRule(poolName, relativePath);
                pathRuleRemoved = true;
              } catch (pathRuleError) {
                console.warn(`Could not remove path rule for '${relativePath}' from pool '${poolName}': ${pathRuleError.message}`);
              }
            }
          }
        } catch (error) {
          console.warn(`Could not process path rule removal: ${error.message}`);
        }
      }

      // Remove share from array
      section[shareType].splice(shareIndex, 1);

      // Remove sections with empty arrays
      const filteredConfig = sharesConfig.filter(section => {
        return Object.keys(section).some(sectionType => {
          return Array.isArray(section[sectionType]) && section[sectionType].length > 0;
        });
      });

      // Save updated configuration
      await this._saveShares(filteredConfig);

      // Restart/Reload appropriate daemon based on share type
      let daemonReloadSuccess = false;
      let daemonReloadMessage = '';

      if (shareType === 'smb') {
        daemonReloadSuccess = await this._restartSmbd();
        daemonReloadMessage = daemonReloadSuccess ? ' and SMB restarted' : ' (SMB restart failed)';
      } else if (shareType === 'nfs') {
        daemonReloadSuccess = await this._restartNfsd();
        daemonReloadMessage = daemonReloadSuccess ? ' and NFS restarted' : ' (NFS restart failed)';
      }

      // Delete directory if desired
      let directoryDeleted = false;
      if (deleteDirectory && sharePath) {
        try {
          await fs.rmdir(sharePath);
          directoryDeleted = true;
        } catch (error) {
          console.warn(`Could not delete share directory ${sharePath}: ${error.message}`);
        }
      }

      return {
        success: true,
        message: `${shareType.toUpperCase()} share '${shareName}' (ID: ${deletedShareId}) deleted successfully${daemonReloadMessage}${pathRuleRemoved ? ' and path rule removed' : ''}`,
        data: {
          shareId: deletedShareId,
          shareName,
          sharePath,
          poolName,
          shareType,
          directoryDeleted,
          pathRuleRemoved,
          config: deletedShare
        },
        daemonReloaded: daemonReloadSuccess,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error deleting share: ${error.message}`);
    }
  }

  /**
   * Update an existing share by ID
   * @param {string} shareId - ID of the share to update
   * @param {Object} updates - Share configuration updates
   * @returns {Promise<Object>} Update result
   */
  async updateShare(shareId, updates) {
    try {
      // Load current shares configuration
      const sharesConfig = await this.getShares();

      // Search for share only by ID
      const shareResult = this._findShareById(sharesConfig, shareId);

      if (!shareResult) {
        throw new Error(`Share with ID '${shareId}' not found`);
      }

      const { section, shareType, shareIndex } = shareResult;
      const originalShare = section[shareType][shareIndex];

      // Update share configuration
      const updatedShareConfig = {
        ...originalShare,
        ...updates,
        id: originalShare.id, // ID cannot be changed
        name: originalShare.name // Name cannot be changed in ID-based updates
      };

      // Check if targetDevices was updated and update path_rule accordingly
      if (updates.hasOwnProperty('targetDevices')) {
        const poolName = this._extractPoolNameFromPath(updatedShareConfig.path);
        if (poolName) {
          // Check if it's a MergerFS pool
          try {
            const pool = await this._getPoolByName(poolName);
            if (pool.type === 'mergerfs') {
              const relativePath = this._extractRelativePathFromShare(updatedShareConfig.path, poolName);

              if (updates.targetDevices && Array.isArray(updates.targetDevices) && updates.targetDevices.length > 0) {
                // Update/create path_rule
                updatedShareConfig.path_rule = {
                  pool: poolName,
                  path: relativePath,
                  target_devices: updates.targetDevices
                };

                // Update or create path rule
                try {
                  await this.addOrUpdatePathRule(poolName, relativePath, updates.targetDevices);
                } catch (pathRuleError) {
                  console.warn(`Could not update path rule: ${pathRuleError.message}`);
                }
              } else if (updates.targetDevices === null || (Array.isArray(updates.targetDevices) && updates.targetDevices.length === 0)) {
                // Remove path_rule if targetDevices is empty or null
                if (updatedShareConfig.path_rule) {
                  try {
                    await this.removePathRule(updatedShareConfig.path_rule.pool, updatedShareConfig.path_rule.path);
                  } catch (pathRuleError) {
                    console.warn(`Could not remove path rule: ${pathRuleError.message}`);
                  }
                  delete updatedShareConfig.path_rule;
                }
              }
            } else {
              // Not a MergerFS pool - remove path_rule if present
              if (updatedShareConfig.path_rule) {
                console.warn(`Removing path_rule from share as pool '${poolName}' is not a MergerFS pool`);
                delete updatedShareConfig.path_rule;
              }
            }
          } catch (poolError) {
            console.warn(`Could not check pool type for '${poolName}': ${poolError.message}`);
          }
        }
      }

      section[shareType][shareIndex] = updatedShareConfig;

      // Save updated configuration
      await this._saveShares(sharesConfig);

      // Restart/Reload appropriate daemon based on share type
      let daemonReloadSuccess = false;
      let daemonReloadMessage = '';

      if (shareType === 'smb') {
        daemonReloadSuccess = await this._restartSmbd();
        daemonReloadMessage = daemonReloadSuccess ? ' and SMB restarted' : ' (SMB restart failed)';
      } else if (shareType === 'nfs') {
        daemonReloadSuccess = await this._restartNfsd();
        daemonReloadMessage = daemonReloadSuccess ? ' and NFS restarted' : ' (NFS restart failed)';
      }

      return {
        success: true,
        message: `${shareType.toUpperCase()} share '${originalShare.name}' (ID: ${originalShare.id}) updated successfully${daemonReloadMessage}`,
        data: {
          shareId: originalShare.id,
          shareName: originalShare.name,
          shareType,
          config: updatedShareConfig
        },
        daemonReloaded: daemonReloadSuccess,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error updating share: ${error.message}`);
    }
  }

  /**
   * Get a specific share by ID
   * @param {string} shareId - ID of the share
   * @returns {Promise<Object>} Share configuration
   */
  async getShare(shareId) {
    try {
      const sharesConfig = await this.getShares();

      // Search for share only by ID
      const shareResult = this._findShareById(sharesConfig, shareId);

      if (!shareResult) {
        throw new Error(`Share with ID '${shareId}' not found`);
      }

      const { share: foundShare, shareType } = shareResult;

      return {
        success: true,
        data: {
          shareId: foundShare.id,
          shareName: foundShare.name,
          shareType,
          config: foundShare
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error getting share: ${error.message}`);
    }
  }

  /**
   * Update target devices for a share (path rule management)
   * @param {string} shareId - ID of the share
   * @param {Array<number>} targetDevices - Array of disk slot numbers
   * @returns {Promise<Object>} Update result
   */
  async updateShareTargetDevices(shareId, targetDevices) {
    try {
      // Validate targetDevices
      if (targetDevices && (!Array.isArray(targetDevices) || !targetDevices.every(device => Number.isInteger(device) && device > 0))) {
        throw new Error('targetDevices must be an array of positive integers (disk slot numbers)');
      }

      return await this.updateShare(shareId, { targetDevices });
    } catch (error) {
      throw new Error(`Error updating share target devices: ${error.message}`);
    }
  }

  /**
   * Get target devices for a share (from path rule)
   * @param {string} shareId - ID of the share
   * @returns {Promise<Object>} Target devices information
   */
  async getShareTargetDevices(shareId) {
    try {
      const shareResult = await this.getShare(shareId);
      const share = shareResult.data.config;

      const poolName = this._extractPoolNameFromPath(share.path);
      let poolType = null;
      let isValidForPathRules = false;
      let currentTargetDevices = null;
      let pathRule = null;

      if (poolName) {
        try {
          const pool = await this._getPoolByName(poolName);
          poolType = pool.type;
          isValidForPathRules = pool.type === 'mergerfs';

          // If it's a MergerFS pool, look for path rules
          if (isValidForPathRules && pool.config && pool.config.path_rules) {
            // Extract the relative path from the share path
            const relativePath = this._extractRelativePathFromShare(share.path, poolName);

            // Find matching path rule in the pool configuration
            const matchingRule = pool.config.path_rules.find(rule => rule.path === relativePath);

            if (matchingRule) {
              currentTargetDevices = matchingRule.target_devices;
              pathRule = matchingRule;
            }
          }
        } catch (poolError) {
          console.warn(`Could not check pool type: ${poolError.message}`);
        }
      }

      return {
        success: true,
        data: {
          shareId,
          shareName: share.name,
          sharePath: share.path,
          poolName,
          poolType,
          isValidForPathRules,
          relativePath: poolName ? this._extractRelativePathFromShare(share.path, poolName) : null,
          currentTargetDevices,
          pathRule
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`Error getting share target devices: ${error.message}`);
    }
  }

  /**
   * Remove target devices from a share (remove path rule)
   * @param {string} shareId - ID of the share
   * @returns {Promise<Object>} Remove result
   */
  async removeShareTargetDevices(shareId) {
    try {
      return await this.updateShare(shareId, { targetDevices: null });
    } catch (error) {
      throw new Error(`Error removing share target devices: ${error.message}`);
    }
  }

  /**
   * Get pools configuration from /boot/config/pools.json
   * @returns {Promise<Array>} Pools configuration
   */
  async _getPools() {
    try {
      // Check if the file exists
      await fs.access(this.poolsConfigPath);

      // Read the pools.json file
      const poolsData = await fs.readFile(this.poolsConfigPath, 'utf8');

      // Parse JSON and return
      const poolsConfig = JSON.parse(poolsData);

      // Simple validation: Make sure it's an array
      if (!Array.isArray(poolsConfig)) {
        throw new Error(`Invalid pools configuration format: Expected array, got ${typeof poolsConfig}`);
      }

      return poolsConfig;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Pools configuration file not found at ${this.poolsConfigPath}`);
      } else if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in pools configuration file: ${error.message}`);
      } else if (error.code === 'EACCES') {
        throw new Error(`Permission denied reading pools configuration file`);
      } else {
        throw new Error(`Error reading pools configuration: ${error.message}`);
      }
    }
  }

  /**
   * Save pools configuration to file
   * @param {Array} poolsConfig - Pools configuration to save
   */
  async _savePools(poolsConfig) {
    try {
      // Make sure the directory exists
      await fs.mkdir(path.dirname(this.poolsConfigPath), { recursive: true });

      // Save JSON with pretty formatting
      await fs.writeFile(this.poolsConfigPath, JSON.stringify(poolsConfig, null, 2));
    } catch (error) {
      throw new Error(`Error saving pools configuration: ${error.message}`);
    }
  }

  /**
   * Get specific pool by name from pools configuration
   * @param {string} poolName - Name of the pool
   * @returns {Promise<Object>} Pool configuration
   */
  async _getPoolByName(poolName) {
    try {
      const pools = await this._getPools();
      const pool = pools.find(p => p.name === poolName);

      if (!pool) {
        throw new Error(`Pool '${poolName}' not found`);
      }

      return pool;
    } catch (error) {
      throw error;
    }
  }



  /**
   * Check if disk directories exist for MergerFS pool
   * @param {string} poolName - Name of the pool
   * @param {Array<number>} diskSlots - Array of disk slot numbers
   * @returns {Promise<Object>} Status of disk directories
   */
  async _checkDiskDirectories(poolName, diskSlots) {
    const basePath = `/var/mergerfs/${poolName}`;
    const results = {};

    for (const slot of diskSlots) {
      const diskPath = path.join(basePath, `disk${slot}`);
      try {
        await fs.access(diskPath);
        results[slot] = { exists: true, path: diskPath };
      } catch (error) {
        results[slot] = { exists: false, path: diskPath };
      }
    }

    return results;
  }

  /**
   * Validate that specified disk slots exist for a pool
   * @param {string} poolName - Name of the pool
   * @param {Array<number>} diskSlots - Array of disk slot numbers to validate
   * @returns {Promise<Object>} Validation result
   */
  async _validateDiskSlots(poolName, diskSlots) {
    try {
      const pool = await this._getPoolByName(poolName);

      if (pool.type !== 'mergerfs') {
        throw new Error(`Pool '${poolName}' is not a MergerFS pool. Disk slots are only available for MergerFS pools.`);
      }

      // Get available slots directly from the pool configuration
      const availableSlots = [];
      if (pool.data_devices && Array.isArray(pool.data_devices)) {
        for (const device of pool.data_devices) {
          const slot = parseInt(device.slot);
          const diskPath = path.join(`/var/mergerfs/${poolName}`, `disk${slot}`);

          try {
            await fs.access(diskPath);
            availableSlots.push(slot);
          } catch (error) {
            // Slot is not available - do not add to list
          }
        }
      }

      const invalidSlots = diskSlots.filter(slot => !availableSlots.includes(slot));

      if (invalidSlots.length > 0) {
        throw new Error(`The following disk slots do not exist or are not available: ${invalidSlots.join(', ')}. Available slots: ${availableSlots.join(', ')}`);
      }

      return {
        valid: true,
        validSlots: diskSlots,
        availableSlots: availableSlots
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create directories on specific disk slots for MergerFS pool
   * @param {string} poolName - Name of the pool
   * @param {string} subPath - Sub-path to create (e.g., "Filme")
   * @param {Array<number>} diskSlots - Array of disk slot numbers
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Creation results
   */
  async _createDiskDirectories(poolName, subPath, diskSlots, options = {}) {
    const basePath = `/var/mergerfs/${poolName}`;
    const results = {};
    const { createDirectories = true, setOwnership = true } = options;

    for (const slot of diskSlots) {
      const diskPath = path.join(basePath, `disk${slot}`);
      const fullPath = path.join(diskPath, subPath);

      try {
        // Check if disk mount point exists
        await fs.access(diskPath);

        if (createDirectories) {
          // Create directory
          await fs.mkdir(fullPath, { recursive: true });

          // Set ownership to 500:500 (user:group)
          if (setOwnership) {
            try {
              await execAsync(`chown 500:500 "${fullPath}"`);
            } catch (chownError) {
              console.warn(`Could not set ownership for ${fullPath}: ${chownError.message}`);
            }
          }
        }

        results[slot] = {
          success: true,
          path: fullPath,
          created: createDirectories,
          diskPath
        };
      } catch (error) {
        results[slot] = {
          success: false,
          error: error.message,
          path: fullPath,
          diskPath
        };
      }
    }

    return results;
  }

  /**
   * Create directories on target devices for a specific path
   * @param {string} poolName - Name of the pool
   * @param {string} rulePath - Path for the rule (e.g., "/Filme")
   * @param {Array<number>} targetDevices - Array of target device slots
   * @returns {Promise<Object>} Creation results
   */
  async _createDirectoriesOnTargetDevices(poolName, rulePath, targetDevices) {
    // Remove leading slash for directory creation
    const subPath = rulePath.startsWith('/') ? rulePath.substring(1) : rulePath;

    // Use existing _createDiskDirectories method
    return await this._createDiskDirectories(poolName, subPath, targetDevices, {
      createDirectories: true,
      setOwnership: true
    });
  }

  /**
   * Add or update path rule in pool configuration
   * @param {string} poolName - Name of the pool
   * @param {string} rulePath - Path for the rule (e.g., "/Filme")
   * @param {Array<number>} targetDevices - Array of target device slots
   * @returns {Promise<Object>} Update result
   */
  async addOrUpdatePathRule(poolName, rulePath, targetDevices) {
    try {
      const pools = await this._getPools();
      const poolIndex = pools.findIndex(p => p.name === poolName);

      if (poolIndex === -1) {
        throw new Error(`Pool '${poolName}' not found`);
      }

      const pool = pools[poolIndex];

      // Check if it's a MergerFS pool
      if (pool.type !== 'mergerfs') {
        throw new Error(`Pool '${poolName}' is not a MergerFS pool. Path rules are only supported for MergerFS pools.`);
      }

      // Check if the pool is mounted
      const poolMountPath = `/mnt/${poolName}`;
      try {
        await fs.access(poolMountPath);
        // Additionally check if it really is a mount point
        const { stdout } = await execAsync(`mountpoint -q "${poolMountPath}" && echo "mounted" || echo "not_mounted"`);
        if (stdout.trim() !== 'mounted') {
          throw new Error(`Pool '${poolName}' is not mounted at '${poolMountPath}'. Cannot create directories on unmounted pool.`);
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Pool mount path '${poolMountPath}' does not exist. Pool '${poolName}' is not mounted.`);
        }
        throw new Error(`Pool '${poolName}' is not properly mounted: ${error.message}`);
      }

      // Validate target devices against available disks
      if (targetDevices && targetDevices.length > 0) {
        const diskValidation = await this._validateDiskSlots(poolName, targetDevices);
        const invalidDisks = Object.entries(diskValidation.results)
          .filter(([slot, result]) => !result.exists)
          .map(([slot]) => slot);

        if (invalidDisks.length > 0) {
          throw new Error(`Invalid disk slots for pool '${poolName}': ${invalidDisks.join(', ')}. Available disks: ${diskValidation.availableSlots.join(', ')}`);
        }
      }

      // Make sure config.path_rules exists
      if (!pool.config) {
        pool.config = {};
      }
      if (!pool.config.path_rules) {
        pool.config.path_rules = [];
      }

      // Normalize the path (make sure it starts with /)
      const normalizedPath = rulePath.startsWith('/') ? rulePath : `/${rulePath}`;

      // Create directories on the specified target devices if given
      let directoryCreationResults = {};
      if (targetDevices && targetDevices.length > 0 && normalizedPath !== '/') {
        try {
          directoryCreationResults = await this._createDirectoriesOnTargetDevices(poolName, normalizedPath, targetDevices);

          // Check if all directories were successfully created
          const failedCreations = Object.entries(directoryCreationResults)
            .filter(([slot, result]) => !result.success);

          if (failedCreations.length > 0) {
            const failedSlots = failedCreations.map(([slot, result]) => `disk${slot}: ${result.error}`);
            console.warn(`Some directories could not be created: ${failedSlots.join(', ')}`);
            // Do not treat as critical error - path rule will still be set
          }
        } catch (dirError) {
          console.warn(`Error creating directories on target devices: ${dirError.message}`);
          // Do not treat as critical error
        }
      }

      // Check if the rule already exists
      const existingRuleIndex = pool.config.path_rules.findIndex(rule => rule.path === normalizedPath);

      if (existingRuleIndex !== -1) {
        // Update existing rule
        pool.config.path_rules[existingRuleIndex].target_devices = targetDevices;
      } else {
        // Add new rule
        pool.config.path_rules.push({
          path: normalizedPath,
          target_devices: targetDevices
        });
      }

      // Save updated configuration
      await this._savePools(pools);

      return {
        success: true,
        message: existingRuleIndex !== -1 ?
          `Path rule for '${normalizedPath}' updated successfully` :
          `Path rule for '${normalizedPath}' added successfully`,
        data: {
          poolName,
          path: normalizedPath,
          target_devices: targetDevices,
          action: existingRuleIndex !== -1 ? 'updated' : 'created',
          directoryCreation: directoryCreationResults
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error managing path rule: ${error.message}`);
    }
  }

  /**
   * Remove path rule from pool configuration
   * @param {string} poolName - Name of the pool
   * @param {string} rulePath - Path for the rule to remove
   * @returns {Promise<Object>} Remove result
   */
  async removePathRule(poolName, rulePath) {
    try {
      const pools = await this._getPools();
      const poolIndex = pools.findIndex(p => p.name === poolName);

      if (poolIndex === -1) {
        throw new Error(`Pool '${poolName}' not found`);
      }

      const pool = pools[poolIndex];

      if (!pool.config || !pool.config.path_rules) {
        throw new Error(`No path rules found for pool '${poolName}'`);
      }

      // Normalize the path
      const normalizedPath = rulePath.startsWith('/') ? rulePath : `/${rulePath}`;

      // Find and remove the rule
      const ruleIndex = pool.config.path_rules.findIndex(rule => rule.path === normalizedPath);

      if (ruleIndex === -1) {
        throw new Error(`Path rule for '${normalizedPath}' not found in pool '${poolName}'`);
      }

      const removedRule = pool.config.path_rules.splice(ruleIndex, 1)[0];

      // Save updated configuration
      await this._savePools(pools);

      return {
        success: true,
        message: `Path rule for '${normalizedPath}' removed successfully`,
        data: {
          poolName,
          removedRule
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error removing path rule: ${error.message}`);
    }
  }

  /**
   * Get path rules for a specific pool
   * @param {string} poolName - Name of the pool
   * @returns {Promise<Object>} Path rules
   */
  async getPathRules(poolName) {
    try {
      const pool = await this._getPoolByName(poolName);

      const pathRules = pool.config?.path_rules || [];

      return {
        success: true,
        data: {
          poolName,
          poolType: pool.type,
          path_rules: pathRules
        },
        count: pathRules.length,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error getting path rules: ${error.message}`);
    }
  }
}

module.exports = new SharesService(); 