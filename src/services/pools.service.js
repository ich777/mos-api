const fs = require('fs').promises;
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const os = require('os');

// Timestamp-basierter ID-Generator
const generateId = () => Date.now().toString();

class PoolsService {
  constructor(eventEmitter = null) {
    this.poolsFile = '/boot/config/pools.json';
    this.mountBasePath = '/mnt';
    this.mergerfsBasePath = '/var/mergerfs';
    this.snapraidBasePath = '/var/snapraid';
    this.eventEmitter = eventEmitter; // Optional event emitter for WebSocket integration

    // Initialize MOS service for service dependency checks
    this.mosService = null;

    // Default ownership settings for pool mount points
    // Can be overridden per pool or globally configured
    this.defaultOwnership = {
      uid: 500,
      gid: 500
    };

  }

  /**
   * Helper function to execute cryptsetup command with passphrase via stdin
   * This ensures passphrases with spaces and special characters work correctly
   * @param {string[]} args - Command arguments for cryptsetup
   * @param {string} passphrase - Passphrase to pass via stdin
   * @returns {Promise<{stdout: string, stderr: string}>}
   * @private
   */
  _execCryptsetupWithPassphrase(args, passphrase) {
    return new Promise((resolve, reject) => {
      const proc = spawn('cryptsetup', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to spawn cryptsetup: ${error.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`cryptsetup exited with code ${code}: ${stderr || stdout}`));
        }
      });

      // Write passphrase to stdin and close it
      proc.stdin.write(passphrase);
      proc.stdin.end();
    });
  }

  /**
   * Helper function to format bytes in human readable format
   * @param {number} bytes - Bytes to format
   * @param {Object} user - User object with byte_format preference
   * @returns {string} Human readable format
   */
  formatBytes(bytes, user = null) {
    if (bytes === 0) return '0 B';

    const byteFormat = this._getUserByteFormat(user);
    const isBinary = byteFormat === 'binary';
    const k = isBinary ? 1024 : 1000;
    const sizes = isBinary
      ? ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      : ['B', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Helper function to format speed in human readable format
   * @param {number} bytesPerSecond - Bytes per second to format
   * @param {Object} user - User object with byte_format preference
   * @returns {string} Human readable format
   */
  formatSpeed(bytesPerSecond, user = null) {
    if (bytesPerSecond === 0) return '0 B/s';

    const byteFormat = this._getUserByteFormat(user);
    const isBinary = byteFormat === 'binary';
    const k = isBinary ? 1024 : 1000;
    const sizes = isBinary
      ? ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s']
      : ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];

    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Get user's byte format preference
   * @param {Object} user - User object
   * @returns {string} Byte format ('binary' or 'decimal')
   * @private
   */
  _getUserByteFormat(user) {
    if (user && user.byte_format) {
      return user.byte_format;
    }
    return 'binary'; // Default fallback
  }

  /**
   * Set ownership of a directory
   * @param {string} path - Directory path
   * @param {number} uid - User ID
   * @param {number} gid - Group ID
   * @private
   */
  async _setOwnership(path, uid = this.defaultOwnership.uid, gid = this.defaultOwnership.gid) {
    try {
      await execPromise(`chown ${uid}:${gid} "${path}"`);
      console.log(`Set ownership of ${path} to ${uid}:${gid}`);
    } catch (error) {
      console.warn(`Warning: Could not set ownership of ${path}: ${error.message}`);
      // Don't throw error as this is not critical for pool functionality
    }
  }

  /**
   * Create directory with proper ownership
   * @param {string} path - Directory path to create
   * @param {Object} options - Options including uid and gid
   * @private
   */
  async _createDirectoryWithOwnership(path, options = {}) {
    await fs.mkdir(path, { recursive: true });

    // Set ownership if specified
    const uid = options.uid || this.defaultOwnership.uid;
    const gid = options.gid || this.defaultOwnership.gid;

    if (uid !== undefined && gid !== undefined) {
      await this._setOwnership(path, uid, gid);
    }
  }

  /**
   * Refresh device symlinks with udev
   * @private
   */
  async _refreshDeviceSymlinks() {
    try {
      console.log('Refreshing device symlinks with udev...');
      await execPromise('udevadm trigger --subsystem-match=block');
      await execPromise('udevadm settle');
      console.log('Device symlinks refreshed successfully');
    } catch (error) {
      console.warn(`Warning: Could not refresh device symlinks: ${error.message}`);
      // Don't throw error as this is not critical for pool functionality
    }
  }

  /**
   * Get the next available index for a new pool
   * @param {Array} pools - Array of existing pools
   * @returns {number} Next available index
   * @private
   */
  _getNextPoolIndex(pools) {
    if (!pools || pools.length === 0) {
      return 1;
    }

    const maxIndex = pools.reduce((max, pool) => {
      const poolIndex = pool.index || 0;
      return poolIndex > max ? poolIndex : max;
    }, 0);

    return maxIndex + 1;
  }

  /**
   * Ensure pools file exists
   */
  async _ensurePoolsFile() {
    try {
      await fs.access(this.poolsFile);
    } catch (error) {
      // Create directory if it doesn't exist
      const dir = path.dirname(this.poolsFile);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (err) {
        // Directory might already exist
      }

      // Create empty pools file
      await fs.writeFile(this.poolsFile, JSON.stringify([], null, 2));
    }
  }

  /**
   * Read pools data from file
   */
  async _readPools() {
    await this._ensurePoolsFile();
    const data = await fs.readFile(this.poolsFile, 'utf8');
    try {
      return JSON.parse(data);
    } catch (error) {
      throw new Error(`Invalid pools file format: ${error.message}`);
    }
  }

  /**
   * Write pools data to file
   */
  async _writePools(poolsData) {
    await this._ensurePoolsFile();
    await fs.writeFile(this.poolsFile, JSON.stringify(poolsData, null, 2));

    // Emit event for pool data changes
    this._emitEvent('pools:updated', { pools: poolsData });
  }

  /**
   * Emit event if eventEmitter is available
   * @private
   */
  _emitEvent(event, data) {
    if (this.eventEmitter) {
      this.eventEmitter.emit(event, data);
    }
  }

  /**
   * Check if a path is mounted
   */
  async _isMounted(mountPath) {
    try {
      const { stdout } = await execPromise('cat /proc/mounts');
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          // Split the mount line: device mountpoint filesystem options
          const parts = line.split(' ');
          if (parts.length >= 2 && parts[1] === mountPath) {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if a device is already mounted somewhere
   */
  async _isDeviceMounted(devicePath) {
    try {
      const { stdout } = await execPromise('cat /proc/mounts');
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (line.trim() && line.startsWith(devicePath + ' ')) {
          // Extract mount point from the line
          const parts = line.split(' ');
          if (parts.length >= 2) {
            return {
              isMounted: true,
              mountPoint: parts[1]
            };
          }
        }
      }

      return {
        isMounted: false,
        mountPoint: null
      };
    } catch (error) {
      return {
        isMounted: false,
        mountPoint: null,
        error: error.message
      };
    }
  }

  /**
   * Check if a device is already formatted with the specified filesystem
   * This method checks both the device itself and its partitions to handle cases
   * where a device has a partition table (e.g., MBR/GPT) but the filesystem is on a partition
   */
  async checkDeviceFilesystem(device) {
    try {
      // First, try to check the device itself
      const deviceResult = await this._checkSingleDeviceFilesystem(device);

      // If the device has a filesystem that's not a partition table, return it
      // BUT: For single device pools, we should prefer partitions over whole disk filesystems
      if (deviceResult.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceResult.filesystem)) {
        // Check if we have partitions - if yes, prefer them over whole disk filesystem
        const partitions = await this._getDevicePartitions(device);
        if (partitions.length === 0) {
          // No partitions, use whole disk filesystem
          return deviceResult;
        }
        // Continue to check partitions below
      }

      // If the device has a partition table or no filesystem, check its partitions
      const partitions = await this._getDevicePartitions(device);

      if (partitions.length > 0) {
        // Check each partition for filesystems
        for (const partition of partitions) {
          const partitionResult = await this._checkSingleDeviceFilesystem(partition);
          if (partitionResult.isFormatted && !['dos', 'gpt', 'mbr'].includes(partitionResult.filesystem)) {
            // Return the partition info but include the partition path
            return {
              ...partitionResult,
              actualDevice: partition // The actual device/partition that has the filesystem
            };
          }
        }
      }

      // If no filesystem found on device or partitions, return unformatted
      // Don't return partition table types as "formatted"
      if (deviceResult.isFormatted && ['dos', 'gpt', 'mbr'].includes(deviceResult.filesystem)) {
        return {
          isFormatted: false,
          filesystem: null,
          uuid: null
        };
      }

      return deviceResult;

    } catch (error) {
      // If the command fails, the device is likely not formatted
      return {
        isFormatted: false,
        filesystem: null,
        uuid: null,
        error: error.message
      };
    }
  }

  /**
   * Check filesystem on a single device/partition
   * @private
   */
  async _checkSingleDeviceFilesystem(device) {
    try {
      const { stdout } = await execPromise(`blkid -o export ${device}`);

      // If blkid returns output, extract the filesystem type and UUIDs
      if (stdout.trim()) {
        const fsMatch = stdout.match(/TYPE="?([^"\n]+)"?/);
        if (fsMatch && fsMatch[1]) {
          // Extract both filesystem UUID and partition UUID
          const filesystemUuid = stdout.match(/UUID="?([^"\n]+)"?/)?.[1] || null;
          const partitionUuid = stdout.match(/PARTUUID="?([^"\n]+)"?/)?.[1] || null;

          return {
            isFormatted: true,
            filesystem: fsMatch[1],
            uuid: filesystemUuid, // Primary: filesystem UUID for mounting
            partuuid: partitionUuid, // Secondary: partition UUID for identification
            device: device // Store the device path for reference
          };
        }
      }

      return {
        isFormatted: false,
        filesystem: null,
        uuid: null,
        partuuid: null,
        device: device
      };
    } catch (error) {
      return {
        isFormatted: false,
        filesystem: null,
        uuid: null,
        partuuid: null,
        device: device,
        error: error.message
      };
    }
  }

  /**
   * Get all partitions for a given device
   * @private
   */
  async _getDevicePartitions(device) {
    try {
      // Use lsblk to get partitions for the device
      const { stdout } = await execPromise(`lsblk -rno NAME ${device}`);
      const lines = stdout.trim().split('\n');

      // Filter out the main device and return only partitions
      const deviceName = device.split('/').pop();
      const partitions = lines
        .filter(line => line.trim() && line !== deviceName && line.startsWith(deviceName))
        .map(partition => `/dev/${partition.trim()}`);

      return partitions;
    } catch (error) {
      // If lsblk fails, try a fallback method
      try {
        const { stdout } = await execPromise(`ls ${device}* 2>/dev/null || true`);
        const devices = stdout.trim().split('\n').filter(d => d && d !== device);
        return devices;
      } catch (fallbackError) {
        return [];
      }
    }
  }

  /**
   * Get the size of a device in bytes
   * @param {string} device - Device path
   */
  async getDeviceSize(device) {
    try {
      const { stdout } = await execPromise(`blockdev --getsize64 ${device}`);
      return parseInt(stdout.trim());
    } catch (error) {
      throw new Error(`Failed to get device size: ${error.message}`);
    }
  }

  /**
   * Get device UUID (filesystem UUID, not partition UUID)
   * @param {string} device - Device path
   * @returns {Promise<string|null>} - Device filesystem UUID or null if not found
   */
  async getDeviceUuid(device) {
    try {
      // Get filesystem UUID (not PARTUUID) - this is what we need for mounting and identification
      const { stdout } = await execPromise(`blkid -s UUID -o value ${device}`);
      const uuid = stdout.trim();

      return uuid || null;
    } catch (error) {

      // Don't throw error, just return null - let calling code handle it
      return null;
    }
  }

  /**
   * Get BTRFS filesystem UUID from any device in the pool
   * @param {string} device - Any device path in the BTRFS pool
   * @returns {Promise<string|null>} - BTRFS filesystem UUID or null if not found
   */
  async getBtrfsFilesystemUuid(device) {
    try {
      // Use btrfs filesystem show to get the UUID
      const { stdout } = await execPromise(`btrfs filesystem show ${device} 2>/dev/null || echo ""`);

      // Parse the UUID from the output: "uuid: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      const uuidMatch = stdout.match(/uuid:\s*([a-f0-9-]{36})/i);
      if (uuidMatch && uuidMatch[1]) {
        return uuidMatch[1];
      }

      // Fallback: try to get filesystem UUID directly
      return await this.getDeviceUuid(device);
    } catch (error) {
      console.warn(`Could not get BTRFS filesystem UUID for ${device}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get device paths from BTRFS filesystem show
   * @param {string} device - Any device path in the BTRFS pool
   * @returns {Promise<string[]>} - Array of device paths from btrfs filesystem show
   */
  async getBtrfsDevicePaths(device) {
    try {
      const { stdout } = await execPromise(`btrfs filesystem show ${device} 2>/dev/null || echo ""`);

      // Parse device paths from the output
      const deviceMatches = stdout.match(/devid\s+\d+\s+size\s+[\d.]+[KMGT]iB\s+used\s+[\d.]+[KMGT]iB\s+path\s+(\/dev\/[^\s]+)/g);
      if (deviceMatches) {
        return deviceMatches.map(match => {
          const pathMatch = match.match(/path\s+(\/dev\/[^\s]+)/);
          return pathMatch ? pathMatch[1] : null;
        }).filter(Boolean);
      }

      return [];
    } catch (error) {
      console.warn(`Could not get BTRFS device paths for ${device}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get UUIDs for BTRFS pool devices (handles LUKS vs non-LUKS)
   * @param {string[]} devices - Array of device paths
   * @param {boolean} isEncrypted - Whether the pool is encrypted with LUKS
   * @param {string} poolName - Pool name (for LUKS mapping)
   * @returns {Promise<Object[]>} - Array of device info objects with UUIDs
   */
  async getBtrfsPoolDeviceUuids(devices, isEncrypted = false, poolName = null) {
    const deviceInfos = [];

    if (isEncrypted && poolName) {
      // For LUKS encrypted pools, each device has different UUIDs
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        // Get PARTUUID from the physical partition (before LUKS)
        const partuuid = await this._getDevicePartuuid(device);
        // For encrypted devices, we use PARTUUID as unique identifier
        deviceInfos.push({
          device: device,
          uuid: partuuid,
          type: 'partuuid' // Indicates this is a PARTUUID, not filesystem UUID
        });
      }
    } else {
      // For non-encrypted BTRFS pools, all devices share the same filesystem UUID
      // but we need individual device identification
      const btrfsUuid = await this.getBtrfsFilesystemUuid(devices[0]);

      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        // Use the same BTRFS filesystem UUID for all devices in the pool
        deviceInfos.push({
          device: device,
          uuid: btrfsUuid,
          type: 'filesystem' // Indicates this is a filesystem UUID
        });
      }
    }

    return deviceInfos;
  }

  /**
   * Update BTRFS device paths in pool from btrfs filesystem show
   * This ensures we display the correct /dev/sdX or /dev/nvmeX paths
   * @param {Object} pool - Pool object to update
   * @param {string} mountPoint - Mount point of the pool
   * @private
   */
  async _updateBtrfsDevicePathsInPool(pool, mountPoint) {
    try {
      if (pool.type !== 'btrfs') {
        return;
      }

      // Get actual device paths from btrfs filesystem show
      const actualDevicePaths = await this.getBtrfsDevicePaths(mountPoint);

      if (actualDevicePaths.length > 0 && pool.data_devices) {
        // Update device paths in pool data_devices for display purposes
        // Note: We keep the UUIDs as IDs, but store actual paths for display
        for (let i = 0; i < Math.min(pool.data_devices.length, actualDevicePaths.length); i++) {
          if (pool.data_devices[i]) {
            // Store the actual device path for display purposes
            pool.data_devices[i].device = actualDevicePaths[i];
          }
        }

        console.log(`Updated BTRFS device paths for pool ${pool.name}:`, actualDevicePaths);
      }
    } catch (error) {
      console.warn(`Could not update BTRFS device paths for pool ${pool.name}: ${error.message}`);
    }
  }

  /**
   * Get device PARTUUID (partition UUID, not filesystem UUID)
   * @param {string} device - Device path
   * @returns {Promise<string|null>} - Device PARTUUID or null if not found
   */
  async _getDevicePartuuid(device) {
    try {
      // Get PARTUUID (not filesystem UUID) - this is unique per partition
      const { stdout } = await execPromise(`blkid -s PARTUUID -o value ${device}`);
      const partuuid = stdout.trim();

      return partuuid || null;
    } catch (error) {
      // Don't throw error, just return null - let calling code handle it
      return null;
    }
  }

  /**
   * Get UUID-based device path without waking up disks
   * @param {string} uuid - Filesystem UUID
   * @returns {Promise<string|null>} - UUID device path or null if not found
   */
  async getDevicePathFromUuid(uuid) {
    try {
      if (!uuid) return null;

      // First try /dev/disk/by-uuid/ (filesystem UUID)
      const uuidPath = `/dev/disk/by-uuid/${uuid}`;
      try {
        await fs.access(uuidPath);
        return uuidPath;
      } catch (error) {
        // Not found, try PARTUUID
      }

      // Try /dev/disk/by-partuuid/ (partition UUID)
      const partuuidPath = `/dev/disk/by-partuuid/${uuid}`;
      try {
        await fs.access(partuuidPath);
        return partuuidPath;
      } catch (error) {
        // Not found either
        return null;
      }
    } catch (error) {
      // Other error
      return null;
    }
  }

  /**
   * Get real device path from UUID for display purposes (may wake up disks)
   * @param {string} uuid - Filesystem UUID
   * @returns {Promise<string|null>} - Real device path or null if not found
   */
  async getRealDevicePathFromUuid(uuid) {
    try {
      if (!uuid) return null;

      // First try /dev/disk/by-uuid/ (filesystem UUID)
      const uuidPath = `/dev/disk/by-uuid/${uuid}`;
      try {
        await fs.access(uuidPath);
        const { stdout } = await execPromise(`readlink -f ${uuidPath}`);
        const devicePath = stdout.trim();
        return devicePath || null;
      } catch (error) {
        // Not found, try PARTUUID
      }

      // Try /dev/disk/by-partuuid/ (partition UUID)
      const partuuidPath = `/dev/disk/by-partuuid/${uuid}`;
      try {
        await fs.access(partuuidPath);
        const { stdout } = await execPromise(`readlink -f ${partuuidPath}`);
        const devicePath = stdout.trim();
        return devicePath || null;
      } catch (error) {
        // Not found either
        return null;
      }
    } catch (error) {
      // Other error
      return null;
    }
  }

  /**
   * Clean up SnapRAID configuration file for a pool
   * @param {string} poolName - Name of the pool
   * @returns {Promise<boolean>} - Whether cleanup was successful
   */
  async cleanupSnapRAIDConfig(poolName) {
    try {
      const snapraidConfigDir = '/boot/config/snapraid';
      const snapraidConfigPath = path.join(snapraidConfigDir, `${poolName}.conf`);

      // Check if config file exists
      try {
        await fs.access(snapraidConfigPath);
        await fs.unlink(snapraidConfigPath);
        console.log(`SnapRAID config file removed: ${snapraidConfigPath}`);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, that's fine
          return true;
        }
        console.warn(`Warning: Could not remove SnapRAID config file: ${error.message}`);
        return false;
      }
    } catch (error) {
      console.error(`Error during SnapRAID cleanup: ${error.message}`);
      return false;
    }
  }

  /**
   * Execute SnapRAID operation on a pool
   * @param {string} poolId - Pool ID
   * @param {string} operation - Operation to perform (sync, check, scrub, fix, status)
   * @returns {Promise<Object>} - Operation result
   */
  async executeSnapRAIDOperation(poolId, operation) {
    const pool = await this.getPoolById(poolId);

    // Validate pool type
    if (pool.type !== 'mergerfs') {
      throw new Error('SnapRAID operations are only supported for MergerFS pools');
    }

    // Validate that pool has parity devices
    if (!pool.parity_devices || pool.parity_devices.length === 0) {
      throw new Error('Pool does not have any SnapRAID parity devices configured');
    }

    // Validate operation
    const validOperations = ['sync', 'check', 'scrub', 'fix', 'status', 'force_stop'];
    if (!validOperations.includes(operation)) {
      throw new Error(`Invalid operation. Supported operations: ${validOperations.join(', ')}`);
    }

    // Check if operation is already running (except for force_stop)
    const socketPath = `/run/snapraid/${pool.name}.socket`;
    if (operation !== 'force_stop') {
      try {
        await fs.access(socketPath);
        throw new Error(`SnapRAID operation is already running for pool '${pool.name}'. Socket file exists: ${socketPath}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error; // Re-throw if it's not a "file not found" error
        }
        // File doesn't exist, which is good - no operation running
      }
    } else {
      // For force_stop, check if operation is actually running
      try {
        await fs.access(socketPath);
        // Socket exists, operation is running - good for force_stop
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`No SnapRAID operation is currently running for pool '${pool.name}'`);
        }
        throw error;
      }
    }

    // Execute the SnapRAID operation in background
    try {
      const { spawn } = require('child_process');
      console.log(`Starting SnapRAID ${operation} operation for pool '${pool.name}'`);

      // Execute the script with pool name and operation in background
      const child = spawn('/usr/local/bin/mos-snapraid', [pool.name, operation], {
        detached: true,
        stdio: 'ignore'
      });

      // Don't wait for the process to finish
      child.unref();

      return {
        success: true,
        message: `SnapRAID ${operation} operation started successfully for pool '${pool.name}'`,
        operation,
        poolName: pool.name,
        started: true,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`SnapRAID ${operation} operation failed to start: ${error.message}`);
    }
  }

  /**
   * Inject parity operation status into pool.status object (API-only, not persisted)
   * @param {Object} pool - Pool object to inject status into
   * @returns {Promise<void>}
   */
  async _injectParityOperationStatus(pool) {
    try {
      // Ensure status object exists
      if (!pool.status) {
        pool.status = {};
      }

      // Only MergerFS pools can have parity operations
      if (pool.type !== 'mergerfs') {
        pool.status.parity_operation = false;
        return;
      }

      // Check if SnapRAID operation is running via socket file
      const socketPath = `/run/snapraid/${pool.name}.socket`;
      try {
        await fs.access(socketPath);
        // Socket exists, operation is running
        pool.status.parity_operation = true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          // Socket doesn't exist, no operation running
          pool.status.parity_operation = false;
        } else {
          // Other error, assume no operation running
          pool.status.parity_operation = false;
        }
      }
    } catch (error) {
      // On any error, default to false
      if (!pool.status) {
        pool.status = {};
      }
      pool.status.parity_operation = false;
    }
  }

  /**
   * Update the SnapRAID configuration for a pool
   * @param {Object} pool - Pool object
   * @returns {Promise<void>}
   */
  async updateSnapRAIDConfig(pool) {
    if (!pool.parity_devices || pool.parity_devices.length === 0) {
      return;
    }

    const snapraidConfigDir = '/boot/config/snapraid';
    await fs.mkdir(snapraidConfigDir, { recursive: true });
    const snapraidConfigPath = path.join(snapraidConfigDir, `${pool.name}.conf`);

    const mergerfsBaseDir = `/var/mergerfs/${pool.name}`;

    // Create a new SnapRAID config
    let snapraidConfig = `# SnapRAID configuration for ${pool.name} pool\n`;
    snapraidConfig += `# Generated by MOS API on ${new Date().toISOString()}\n\n`;

    // Add all parity devices
    pool.parity_devices.forEach((parityDevice, index) => {
      const parityMountPoint = path.join(this.snapraidBasePath, pool.name, `parity${index + 1}`);
      if (index === 0) {
        snapraidConfig += `parity ${parityMountPoint}/.snapraid.parity\n`;
      } else {
        snapraidConfig += `${index + 1}-parity ${parityMountPoint}/.snapraid.${index + 1}-parity\n`;
      }
    });

    // Add content files for all data devices
    pool.data_devices.forEach(device => {
      const deviceMountPoint = path.join(mergerfsBaseDir, `disk${device.slot}`);
      snapraidConfig += `content ${deviceMountPoint}/.snapraid\n`;
    });

    // Add content files for parity devices
    pool.parity_devices.forEach((parityDevice, index) => {
      const parityMountPoint = path.join(this.snapraidBasePath, pool.name, `parity${index + 1}`);
      snapraidConfig += `content ${parityMountPoint}/.snapraid.content\n`;
    });

    snapraidConfig += '\n';

    // Add data disks with IDs
    pool.data_devices.forEach((device, index) => {
      const deviceMountPoint = path.join(mergerfsBaseDir, `disk${device.slot}`);
      const diskId = `d${index + 1}`;
      snapraidConfig += `data ${diskId} ${deviceMountPoint}\n`;
    });

    snapraidConfig += '\n';

    // Add standard exclusion patterns
    snapraidConfig += `exclude *.tmp\n`;
    snapraidConfig += `exclude *.temp\n`;
    snapraidConfig += `exclude *.log\n`;
    snapraidConfig += `exclude *.bak\n`;
    snapraidConfig += `exclude Thumbs.db\n`;
    snapraidConfig += `exclude .DS_Store\n`;
    snapraidConfig += `exclude .AppleDouble\n`;
    snapraidConfig += `exclude ._*\n`;
    snapraidConfig += `exclude .Spotlight-V100\n`;
    snapraidConfig += `exclude .Trashes\n`;
    snapraidConfig += `exclude .fseventsd\n`;
    snapraidConfig += `exclude .DocumentRevisions-V100\n`;
    snapraidConfig += `exclude .TemporaryItems\n`;
    snapraidConfig += `exclude lost+found/\n`;
    snapraidConfig += `exclude .recycle/\n`;
    snapraidConfig += `exclude $RECYCLE.BIN/\n`;
    snapraidConfig += `exclude System Volume Information/\n`;
    snapraidConfig += `exclude pagefile.sys\n`;
    snapraidConfig += `exclude hiberfil.sys\n`;
    snapraidConfig += `exclude swapfile.sys\n`;

    // Write the updated config file
    await fs.writeFile(snapraidConfigPath, snapraidConfig);
  }

  /**
   * Create a multi-device BTRFS pool with RAID support
   * @param {string} name - Pool name
   * @param {string[]} devices - Array of device paths
   * @param {string} raidLevel - BTRFS raid level ('raid0', 'raid1', 'raid10', 'single', etc.)
   * @param {Object} options - Additional options
   * @param {Object} options.config - Pool configuration
   * @param {boolean} options.config.encrypted - Enable LUKS encryption
   * @param {boolean} options.config.create_keyfile - Create keyfile for encrypted pool (default: false)
   * @param {string} options.passphrase - Passphrase for encryption (required if encrypted=true)
   */
  async createMultiDevicePool(name, devices, raidLevel = 'raid1', options = {}) {
    let encryptionEnabled = false;
    let luksDevices = null;

    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');

      // Validate encryption parameters
      if (options.config?.encrypted) {
        if (!options.passphrase || options.passphrase.trim() === '') {
          if (options.config?.create_keyfile) {
            // Generate secure random passphrase if keyfile creation is requested
            options.passphrase = this._generateSecurePassphrase();
            console.log(`Generated secure passphrase for encrypted pool '${name}' (will be stored in keyfile)`);
          } else {
            throw new Error('Passphrase is required for encrypted pools');
          }
        }
        if (options.passphrase.length < 8) {
          throw new Error('Passphrase must be at least 8 characters long for LUKS encryption');
        }
      }

      // Check if it's really a multi-device pool
      if (!Array.isArray(devices)) {
        throw new Error('Devices must be an array of device paths');
      }

      // If only one device is passed, redirect to single-device method
      if (devices.length === 1) {
        return this.createSingleDevicePool(name, devices[0], 'btrfs', options);
      }

      // Multi-Device-Pool benötigt mindestens 2 Geräte
      if (devices.length < 2) {
        throw new Error('At least two devices are required for a multi-device pool');
      }

      // Validate raid level - 'single' is a valid BTRFS configuration
      // Raid-Level 'single': Data is written to one device
      // Raid-Level 'raid0': Data is distributed across multiple devices (Striping)
      // Raid-Level 'raid1': Data is mirrored across all devices (Mirroring)
      // Raid-Level 'raid10': Combination of Striping and Mirroring
      const validRaidLevels = ['raid0', 'raid1', 'raid10', 'single'];
      if (!validRaidLevels.includes(raidLevel)) {
        throw new Error(`Unsupported RAID level: ${raidLevel}. Supported: ${validRaidLevels.join(', ')}`);
      }

      // BTRFS is required for multi-device pools
      const filesystem = 'btrfs';

      let actualDevices = devices;
      let encryptionEnabled = false;

      // Read current pools data
      const pools = await this._readPools();

      // Check if pool with the same name already exists
      const existingPoolIndex = pools.findIndex(p => p.name === name);
      if (existingPoolIndex !== -1) {
        throw new Error(`Pool with name "${name}" already exists`);
      }

      // Check each device
      for (const device of devices) {
        await fs.access(device).catch(() => {
          throw new Error(`Device ${device} does not exist`);
        });

        // Check if device is already mounted
        const mountStatus = await this._isDeviceMounted(device);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before creating a pool.`);
        }
      }

      // Create mount point with proper ownership
      const mountPoint = path.join(this.mountBasePath, name);
      const ownershipOptions = {
        uid: this.defaultOwnership.uid,
        gid: this.defaultOwnership.gid
      };
      await this._createDirectoryWithOwnership(mountPoint, ownershipOptions);

      // Prepare devices for BTRFS
      const preparedDevices = [];

      if (options.format === true) {
        // format=true: Create partitions and format
        for (const device of devices) {
          const isPartition = this._isPartitionPath(device);
          if (!isPartition) {
            // Whole disk - create partition table and partition
            console.log(`${device} is a whole disk, creating partition table and partition...`);

            // Create GPT partition table (deletes old partitions)
            await execPromise(`parted -s ${device} mklabel gpt`);

            // Create a single partition using the entire disk
            await execPromise(`parted -s ${device} mkpart primary 2048s 100%`);

            // Wait a moment for the partition to be recognized by the kernel
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Inform kernel about partition table changes
            try {
              await execPromise(`partprobe ${device}`);
            } catch (error) {
              console.warn(`partprobe failed: ${error.message}`);
            }

            // Determine partition path
            const partitionPath = this._getPartitionPath(device, 1);
            preparedDevices.push(partitionPath);
            console.log(`Created partition: ${partitionPath}`);
          } else {
            // Already a partition - use as-is (will be formatted later)
            preparedDevices.push(device);
          }
        }
      } else {
        // format=false: Import mode - use existing filesystems as-is
        for (const device of devices) {
          const isPartition = this._isPartitionPath(device);
          if (!isPartition) {
            // Whole disk - check what's on it
            const deviceInfo = await this.checkDeviceFilesystem(device);
            if (deviceInfo.actualDevice) {
              // Has partition with filesystem - use the partition
              preparedDevices.push(deviceInfo.actualDevice);
            } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
              // Whole disk has filesystem directly (no partition) - use whole disk
              preparedDevices.push(device);
            } else {
              // No usable filesystem found
              throw new Error(`Device ${device} has no usable filesystem. Use format: true to create partition and format.`);
            }
          } else {
            // Already a partition - use as-is
            preparedDevices.push(device);
          }
        }
      }

      // Validate filesystems BEFORE encryption (for format=false)
      let hasLuksDevices = false;
      let allDevicesAreLuks = false;
      actualDevices = [...preparedDevices]; // Initialize with prepared devices

      if (options.format === false) {
        // Check if any device is already LUKS encrypted (only for format=false)
        const luksDeviceIndices = [];
        for (let i = 0; i < preparedDevices.length; i++) {
          const deviceInfo = await this.checkDeviceFilesystem(preparedDevices[i]);
          if (deviceInfo.isFormatted && deviceInfo.filesystem === 'crypto_LUKS') {
            luksDeviceIndices.push(i);
          }
        }

        hasLuksDevices = luksDeviceIndices.length > 0;
        allDevicesAreLuks = luksDeviceIndices.length === preparedDevices.length;

        if (hasLuksDevices && (!options.passphrase || options.passphrase.trim() === '')) {
          throw new Error(`Some devices are LUKS encrypted but no passphrase provided. Please provide a passphrase to unlock the devices.`);
        }

        for (let i = 0; i < preparedDevices.length; i++) {
          const preparedDevice = preparedDevices[i];
          const deviceInfo = await this.checkDeviceFilesystem(preparedDevice);

          if (deviceInfo.isFormatted && deviceInfo.filesystem === 'crypto_LUKS') {
            // Device is LUKS - need to open it to check filesystem inside
            console.log(`Device ${preparedDevice} is LUKS encrypted, opening to check filesystem...`);

            await this._cleanupExistingLuksMappers(name);
            let luksDevices;
            try {
              luksDevices = await this._openLuksDevicesWithSlots([preparedDevice], name, [i + 1], options.passphrase);
            } catch (error) {
              throw new Error(`Failed to open LUKS device ${preparedDevice}: ${error.message}. Please check your passphrase or keyfile.`);
            }

            const luksDevice = luksDevices[0].mappedDevice;
            const luksFilesystemInfo = await this.checkDeviceFilesystem(luksDevice);

            if (!luksFilesystemInfo.isFormatted || luksFilesystemInfo.filesystem !== 'btrfs') {
              throw new Error(`LUKS container ${luksDevice} has filesystem ${luksFilesystemInfo.filesystem || 'none'}, but BTRFS is required. Use format: true to reformat.`);
            }

            console.log(`LUKS device ${preparedDevice} contains BTRFS - will be used as-is`);
            // Replace with LUKS device for mounting
            actualDevices[i] = luksDevice;
            encryptionEnabled = true;
          } else if (deviceInfo.isFormatted) {
            if (deviceInfo.filesystem !== 'btrfs') {
              throw new Error(`Device ${preparedDevice} is already formatted with ${deviceInfo.filesystem}, but BTRFS is required for multi-device pools. Use format: true to overwrite.`);
            }
            console.log(`Device ${preparedDevice} is already formatted with BTRFS - will be used as-is`);
          } else {
            throw new Error(`Device ${preparedDevice} is not formatted. Use format: true to format the device with BTRFS.`);
          }
        }
      }

      // Store original devices for UUID retrieval before encryption
      const originalDevices = [...preparedDevices];

      // Handle LUKS encryption for new encryption (format=true)
      if (options.config?.encrypted && !hasLuksDevices) {
        console.log(`Setting up LUKS encryption for multi-device pool '${name}' on prepared devices`);
        await this._cleanupExistingLuksMappers(name);
        await this._setupPoolEncryption(preparedDevices, name, options.passphrase, options.config.create_keyfile);

        const dataSlots = preparedDevices.map((_, i) => i + 1);
        const luksDevices = await this._openLuksDevicesWithSlots(preparedDevices, name, dataSlots, options.passphrase);
        actualDevices = luksDevices.map(d => d.mappedDevice);
        encryptionEnabled = true;
      } else if (hasLuksDevices && !allDevicesAreLuks) {
        throw new Error(`Cannot mix LUKS encrypted and non-encrypted devices in the same pool. All devices must be either encrypted or non-encrypted.`);
      }

      // Format with BTRFS only if format=true
      if (options.format === true) {
        const devicesToFormat = encryptionEnabled ? actualDevices : preparedDevices;
        const deviceArgs = devicesToFormat.join(' ');
        const formatCommand = `mkfs.btrfs -f -d ${raidLevel} -m ${raidLevel} -L "${name}" ${deviceArgs}`;

        await execPromise(formatCommand);
        await this._refreshDeviceSymlinks();
      } else {
        console.log(`Skipping formatting - importing existing BTRFS filesystem`);
      }

      // Create pool object with multiple devices
      const poolId = Date.now().toString();

      // For multi-device BTRFS pools, we need filesystem UUIDs from physical devices
      // These are the UUIDs found in /dev/disk/by-uuid/ that point to the actual partitions
      const dataDevices = [];
      for (let i = 0; i < devices.length; i++) {
        // Use filesystem UUID from the original physical partition (before any encryption)
        const uuid = await this.getDeviceUuid(originalDevices[i]);
        dataDevices.push({
          slot: (i + 1).toString(),
          id: uuid, // Use filesystem UUID from physical partition
          filesystem,
          spindown: null
        });
      }

      const newPool = {
        id: poolId,
        name,
        type: 'btrfs',
        automount: options.automount !== undefined ? options.automount : false,
        comment: options.comment || "",
        index: this._getNextPoolIndex(pools),
        data_devices: dataDevices,
        parity_devices: [],

        config: {
          encrypted: encryptionEnabled,
          raid_level: raidLevel
        }
      };

      // Add pool to pools array and save
      pools.push(newPool);
      await this._writePools(pools);

      // Mount the pool if automount is true
      if (newPool.automount) {
        try {
          // Use the first actual device (LUKS device if encrypted, partition if not) for mounting BTRFS
          const deviceToMount = actualDevices[0];
          await this.mountDevice(deviceToMount, mountPoint, { mountOptions: `device=${deviceToMount}` });

          // After mounting, update device paths from btrfs filesystem show
          await this._updateBtrfsDevicePathsInPool(newPool, mountPoint);
        } catch (mountError) {
          // Mount error is ignored, as automount is optional
          console.warn(`Automount failed for pool ${name}: ${mountError.message}`);
        }
      }

      return {
        success: true,
        message: `Successfully created multi-device BTRFS pool "${name}" with ${raidLevel} configuration`,
        pool: newPool
      };
    } catch (error) {
      // Cleanup LUKS devices if encryption was enabled and pool creation failed
      if (encryptionEnabled && luksDevices) {
        console.log(`Pool creation failed, cleaning up LUKS devices for '${name}'`);
        try {
          await this._closeLuksDevices(devices, name);
        } catch (cleanupError) {
          console.warn(`Warning: Could not cleanup LUKS devices: ${cleanupError.message}`);
        }
      }
      throw new Error(`Error creating multi-device pool: ${error.message}`);
    }
  }

  /**
   * Add new device(s) to an existing BTRFS pool
   * @param {string} poolId - ID of the existing pool
   * @param {string[]} newDevices - Array of new device paths to add
   * @param {Object} options - Additional options
   */
  async addDevicesToPool(poolId, newDevices, options = {}) {
    try {
      if (!poolId) throw new Error('Pool ID is required');
      if (!Array.isArray(newDevices) || newDevices.length === 0) {
        throw new Error('At least one new device is required');
      }

      // Load pools data
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const pool = pools[poolIndex];

      // Handle different pool types
      if (pool.type === 'btrfs') {
        return await this._addDevicesToBTRFSPool(pool, newDevices, options, pools, poolIndex);
      } else if (pool.type === 'mergerfs') {
        return await this._addDevicesToMergerFSPool(pool, newDevices, options, pools, poolIndex);
      } else {
        throw new Error(`Pool type '${pool.type}' does not support adding devices`);
      }

    } catch (error) {
      throw new Error(`Error adding devices to pool: ${error.message}`);
    }
  }

  /**
   * Add devices to a BTRFS pool
   */
  async _addDevicesToBTRFSPool(pool, newDevices, options, pools, poolIndex) {
    // Check if pool is mounted
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const isMounted = await this._isMounted(mountPoint);
    if (!isMounted) {
      throw new Error(`Pool ${pool.name} must be mounted to add devices`);
    }

    // Handle LUKS encryption for new devices if pool is encrypted
    let actualDevicesToAdd = newDevices;
    let luksDevices = null;

    if (pool.config?.encrypted) {
      console.log(`Setting up LUKS encryption for new devices in pool '${pool.name}'`);

      // Setup LUKS encryption on new devices
      await this._setupPoolEncryption(newDevices, pool.name, options.passphrase, false);

      // Open LUKS devices
      luksDevices = await this._openLuksDevices(newDevices, pool.name, options.passphrase);
      actualDevicesToAdd = luksDevices.map(d => d.mappedDevice);

      console.log(`LUKS devices opened for adding to pool: ${actualDevicesToAdd.join(', ')}`);
    }

    // Check each new device (use actual devices to add)
    for (const device of actualDevicesToAdd) {
      // Check if device exists
      await fs.access(device).catch(() => {
        throw new Error(`Device ${device} does not exist`);
      });

      // Check if device is already mounted
      const mountStatus = await this._isDeviceMounted(device);
      if (mountStatus.isMounted) {
        throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before adding to pool.`);
      }

      // Check if device is already part of this pool
      const isInPool = pool.data_devices.some(d => d.device === device);
      if (isInPool) {
        throw new Error(`Device ${device} is already part of pool ${pool.name}`);
      }

      // Check device format status
      const deviceInfo = await this.checkDeviceFilesystem(device);
      if (!deviceInfo.isFormatted) {
        // Device is not formatted - BTRFS device add will format it, but require explicit confirmation
        if (options.format !== true) {
          throw new Error(`Device ${device} is not formatted. Use format: true to confirm adding and formatting the device.`);
        }
      } else if (deviceInfo.isFormatted && deviceInfo.filesystem !== 'btrfs') {
        // Device has wrong filesystem
        throw new Error(`Device ${device} is already formatted with ${deviceInfo.filesystem}. BTRFS pools require unformatted devices or devices with BTRFS filesystem.`);
      }
    }

    // Add each device to the BTRFS volume
    for (const device of actualDevicesToAdd) {
      await execPromise(`btrfs device add ${device} ${mountPoint}`);
    }

    // Update the pool data structure - get UUIDs for new devices
    const newDataDevices = [];
    for (let i = 0; i < newDevices.length; i++) {
      const originalDevice = newDevices[i];
      const actualDevice = actualDevicesToAdd[i];

      // For encrypted pools, get UUID from physical device but store mapped device
      let deviceUuid;
      let deviceToStore;

      if (pool.config?.encrypted) {
        deviceUuid = await this.getDeviceUuid(originalDevice);
        deviceToStore = actualDevice; // Store the mapped device path
      } else {
        deviceUuid = await this.getDeviceUuid(actualDevice);
        deviceToStore = actualDevice;
      }

      newDataDevices.push({
        slot: (pool.data_devices.length + i + 1).toString(),
        id: deviceUuid,
        filesystem: 'btrfs',
        spindown: null
      });
    }

    // Update original devices array for encrypted pools
    if (pool.config?.encrypted) {
      if (!pool.devices) {
        pool.devices = [];
      }
      pool.devices.push(...newDevices);
    }

    // Add new devices to the pool's data_devices array
    pool.data_devices = [...pool.data_devices, ...newDataDevices];

    // Check if a single-device pool is being converted to a multi-device pool
    if (!pool.config.raid_level && pool.data_devices.length > 1) {
      // Set raid1 by default for more security
      pool.config.raid_level = 'raid1';

      // Execute the corresponding BTRFS balance command to apply the RAID level
      try {
        await execPromise(`btrfs balance start -dconvert=raid1 -mconvert=raid1 ${mountPoint}`);
      } catch (error) {
        // Log error, but continue - the pool can be rebalanced later
        console.warn(`Warning: Could not convert to RAID1: ${error.message}`);
      }
    }

    // Don't persist dynamic status info to pools.json
    // Status will be calculated dynamically when pools are retrieved

    // Write updated pool data (without status)
    pools[poolIndex] = pool;
    await this._writePools(pools);

    return {
      success: true,
      message: `Successfully added ${newDevices.length} device(s) to BTRFS pool ${pool.name}`,
      pool
    };
  }

  /**
   * Add devices to a MergerFS pool
   */
  async _addDevicesToMergerFSPool(pool, newDevices, options, pools, poolIndex) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const mergerfsBasePath = path.join(this.mergerfsBasePath, pool.name);

    // Determine filesystem from existing devices
    const existingFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

    // Handle LUKS encryption for new devices if pool is encrypted
    let actualDevicesToAdd = newDevices;
    let luksDevices = null;

    if (pool.config?.encrypted) {
      console.log(`Setting up LUKS encryption for new devices in MergerFS pool '${pool.name}'`);

      // Setup LUKS encryption on new devices
      await this._setupPoolEncryption(newDevices, pool.name, options.passphrase, false);

      // Open LUKS devices
      luksDevices = await this._openLuksDevices(newDevices, pool.name, options.passphrase);
      actualDevicesToAdd = luksDevices.map(d => d.mappedDevice);

      console.log(`LUKS devices opened for adding to MergerFS pool: ${actualDevicesToAdd.join(', ')}`);
    }

    // Check and format new devices if needed
    const formattedDevices = [];
    for (let i = 0; i < newDevices.length; i++) {
      const originalDevice = newDevices[i];
      const deviceToCheck = actualDevicesToAdd[i];

      // Check if device exists
      await fs.access(deviceToCheck).catch(() => {
        throw new Error(`Device ${deviceToCheck} does not exist`);
      });

      // Check if device is already mounted
      const mountStatus = await this._isDeviceMounted(deviceToCheck);
      if (mountStatus.isMounted) {
        throw new Error(`Device ${deviceToCheck} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before adding to pool.`);
      }

      // Check if device is already part of this pool
      const isInPool = pool.data_devices.some(d => d.device === deviceToCheck) ||
                      pool.parity_devices.some(d => d.device === deviceToCheck);
      if (isInPool) {
        throw new Error(`Device ${deviceToCheck} is already part of pool ${pool.name}`);
      }

      // Check/format device
      const deviceInfo = await this.checkDeviceFilesystem(deviceToCheck);
      const actualDeviceToUse = deviceInfo.actualDevice || deviceToCheck;
      const isUsingPartition = deviceInfo.actualDevice && deviceInfo.actualDevice !== deviceToCheck;

      let actualDevice = deviceToCheck;
      if (!deviceInfo.isFormatted) {
        // Device is not formatted - require explicit format option
        throw new Error(`Device ${deviceToCheck} is not formatted. Use format: true to format the device with ${existingFilesystem}.`);
      } else if (options.format === true) {
        // Explicit format requested - reformat the device
        const formatResult = await this.formatDevice(deviceToCheck, existingFilesystem);
        actualDevice = formatResult.device; // Use the partition created by formatDevice

        // For encrypted pools, get UUID from physical device
        let uuid;
        if (pool.config?.encrypted) {
          uuid = await this.getDeviceUuid(originalDevice);
        } else {
          uuid = await this.getDeviceUuid(actualDevice);
        }

        formattedDevices.push({
          originalDevice,
          device: actualDevice,
          filesystem: existingFilesystem,
          uuid,
          isUsingPartition: actualDevice !== deviceToCheck
        });
      } else if (deviceInfo.filesystem !== existingFilesystem) {
        const deviceDisplayName = isUsingPartition ? `${deviceToCheck} (partition ${actualDeviceToUse})` : deviceToCheck;
        throw new Error(`Device ${deviceDisplayName} has filesystem ${deviceInfo.filesystem}, expected ${existingFilesystem}. Use format: true to reformat.`);
      } else {
        // Always get UUID from the actual device being used to ensure we have the correct one
        let uuid = await this.getDeviceUuid(actualDeviceToUse);
        if (!uuid) {
          // Fallback: try to get UUID from deviceInfo if getDeviceUuid failed
          uuid = deviceInfo.uuid;
        }
        if (!uuid) {
          throw new Error(`No filesystem UUID found for device ${actualDeviceToUse}. Device may not be properly formatted.`);
        }

        formattedDevices.push({
          originalDevice,
          device: actualDeviceToUse,
          filesystem: deviceInfo.filesystem,
          uuid: pool.config?.encrypted ? await this.getDeviceUuid(originalDevice) : uuid,
          isUsingPartition
        });
      }
    }

    // Mount and add new devices to MergerFS
    const newDataDevices = [];
    for (let i = 0; i < formattedDevices.length; i++) {
      const { device, filesystem, uuid, isUsingPartition } = formattedDevices[i];
      const diskIndex = pool.data_devices.length + i + 1;
      const diskMountPoint = path.join(mergerfsBasePath, `disk${diskIndex}`);



      // Create mount point with proper ownership and mount device
      const ownershipOptions = {
        uid: this.defaultOwnership.uid,
        gid: this.defaultOwnership.gid
      };
      await this._createDirectoryWithOwnership(diskMountPoint, ownershipOptions);
      await this.mountDevice(device, diskMountPoint); // Mount the actual device (partition)

      // Ensure we get the correct UUID from the actual device being used
      let finalUuid = uuid;
      if (!finalUuid) {
        finalUuid = await this.getDeviceUuid(device);
      }

      newDataDevices.push({
        slot: diskIndex.toString(),
        id: finalUuid, // UUID of the actual partition/device being used
        filesystem,
        spindown: null
      });
    }

    // Update original devices array for encrypted pools
    if (pool.config?.encrypted) {
      if (!pool.devices) {
        pool.devices = [];
      }
      pool.devices.push(...newDevices);
    }

    // Add new devices to pool
    pool.data_devices = [...pool.data_devices, ...newDataDevices];

    // Remount MergerFS with all devices
    const allMountPoints = pool.data_devices.map((_, index) =>
      path.join(mergerfsBasePath, `disk${index + 1}`)
    ).join(':');

    // Unmount current MergerFS
    try {
      await execPromise(`umount ${mountPoint}`);
    } catch (error) {
      // Pool might not be mounted, continue
    }

    // Remount with all devices
    const mergerfsOptions = pool.config.global_options?.join(',') ||
      'defaults,allow_other,use_ino,cache.files=partial,dropcacheonclose=true,category.create=mfs';
    await execPromise(`mergerfs -o ${mergerfsOptions} ${allMountPoints} ${mountPoint}`);

    // Update SnapRAID config if applicable
    if (pool.parity_devices.length > 0) {
      await this.updateSnapRAIDConfig(pool);
    }

    // Don't persist dynamic status info to pools.json
    // Status will be calculated dynamically when pools are retrieved

    // Write updated pool data (without status)
    pools[poolIndex] = pool;
    await this._writePools(pools);

    return {
      success: true,
      message: `Successfully added ${newDevices.length} device(s) to MergerFS pool ${pool.name}`,
      pool
    };
  }

  /**
   * Change the RAID level of an existing BTRFS pool
   * @param {string} poolId - ID of the existing pool
   * @param {string} newRaidLevel - New RAID level to convert to
   * @param {Object} options - Additional options
   */
  async changePoolRaidLevel(poolId, newRaidLevel, options = {}) {
    try {
      if (!poolId) throw new Error('Pool ID is required');

      // Validate new raid level
      const validRaidLevels = ['raid0', 'raid1', 'raid10', 'single'];
      if (!validRaidLevels.includes(newRaidLevel)) {
        throw new Error(`Unsupported RAID level: ${newRaidLevel}. Supported: ${validRaidLevels.join(', ')}`);
      }

      // Load pools data
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const pool = pools[poolIndex];

      // Verify that this is a BTRFS pool
      if (pool.type !== 'btrfs') {
        throw new Error('Only BTRFS pools can have their RAID level changed');
      }

      // Check if current and new RAID levels are the same
      if (pool.raid_level === newRaidLevel || pool.config.raid_level === newRaidLevel) {
        return {
          success: true,
          message: `Pool ${pool.name} is already using ${newRaidLevel}`,
          pool
        };
      }

      // Check if pool is mounted
      const mountPoint = path.join(this.mountBasePath, pool.name);
      const isMounted = await this._isMounted(mountPoint);
      if (!isMounted) {
        throw new Error(`Pool ${pool.name} must be mounted to change RAID level`);
      }

      // Verify minimum device requirements for RAID levels
      const deviceCount = pool.data_devices.length;
      if ((newRaidLevel === 'raid0' || newRaidLevel === 'raid1') && deviceCount < 2) {
        throw new Error(`At least 2 devices are required for ${newRaidLevel}`);
      }
      if (newRaidLevel === 'raid10' && deviceCount < 4) {
        throw new Error(`At least 4 devices are required for ${newRaidLevel}`);
      }

      // Special checks for specific RAID level conversions
      if ((pool.raid_level === 'raid0' || pool.config.raid_level === 'raid0') && newRaidLevel === 'raid1') {
        // Check available storage space for converting from RAID 0 to RAID 1
        const spaceInfo = await this.getDeviceSpace(mountPoint);

        // For RAID 0 to RAID 1: Need at least 50% free space
        // because the data is converted from striped to mirrored data
        const freeSpacePercentage = (spaceInfo.freeSpace / spaceInfo.totalSpace) * 100;

        if (freeSpacePercentage < 50) {
          throw new Error(`Insufficient free space for converting from RAID 0 to RAID 1. ` +
                         `At least 50% free space is required, but only ${freeSpacePercentage.toFixed(1)}% is available.`);
        }

        // Add a note to the pool configuration
        if (!pool.config.notes) pool.config.notes = [];
        pool.config.notes.push({
          timestamp: Date.now(),
          message: `Starting conversion from RAID 0 (Striping) to RAID 1 (Mirroring). ` +
                   `This operation may take longer depending on the pool size and requires sufficient storage space.`
        });
      }

      // Change data and metadata RAID level
      await execPromise(`btrfs balance start -dconvert=${newRaidLevel} -mconvert=${newRaidLevel} ${mountPoint}`);

      // Update pool configuration
      pool.raid_level = newRaidLevel;
      pool.config = pool.config || {};
      pool.config.raid_level = newRaidLevel;

      // When we switch to 'single', adjust the pool structure accordingly
      if (newRaidLevel === 'single' && pool.data_devices.length > 1) {
        // Only the first device in the pool is used for data
        // We keep the other devices in the data structure, as they are still part of the BTRFS filesystem

        // Add a note to the pool configuration
        if (!pool.config.notes) pool.config.notes = [];
        pool.config.notes.push({
          timestamp: Date.now(),
          message: `Pool was converted to 'single' mode. Only the first device (${pool.data_devices[0].device}) is used for data.`
        });
      }

      // Write updated pool data
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully changed pool ${pool.name} to RAID level ${newRaidLevel}`,
        pool
      };
    } catch (error) {
      throw new Error(`Error changing RAID level: ${error.message}`);
    }
  }

  /**
   * Check if a device path is a partition
   */
  _isPartitionPath(device) {
    // Check for partition patterns:
    // /dev/sdb1, /dev/sdc2, etc. (SATA/SCSI)
    // /dev/nvme0n1p1, /dev/nvme0n1p2, etc. (NVMe)
    // /dev/mapper/luks_0 should be treated as a "partition" (no need to partition LUKS containers)
    if (device.includes('/dev/mapper/')) {
      return true; // LUKS mapped devices should be formatted directly, not partitioned
    }
    return /\/dev\/(sd[a-z]+\d+|nvme\d+n\d+p\d+|hd[a-z]+\d+|vd[a-z]+\d+)$/.test(device);
  }

  /**
   * Get the partition path for a device and partition number
   */
  _getPartitionPath(device, partitionNumber) {
    // Handle NVMe devices (e.g., /dev/nvme0n1 -> /dev/nvme0n1p1)
    // Handle LUKS mapped devices (e.g., /dev/mapper/luks_0 -> /dev/mapper/luks_0p1)
    if (device.includes('nvme') || device.includes('/dev/mapper/')) {
      return `${device}p${partitionNumber}`;
    }
    // Handle regular SATA/SCSI devices (e.g., /dev/sdb -> /dev/sdb1)
    return `${device}${partitionNumber}`;
  }

  /**
   * Create a partition on a whole disk if needed
   * @param {string} device - Device path
   * @returns {Promise<string>} - Partition path or original device if already a partition
   */
  async _ensurePartition(device) {
    // Check if device is a partition or a whole disk
    const isPartition = this._isPartitionPath(device);
    let targetDevice = device;

    if (!isPartition) {
      // This is a whole disk - create partition table and partition first
      console.log(`${device} is a whole disk, creating partition table and partition...`);

      // Create GPT partition table
      await execPromise(`parted -s ${device} mklabel gpt`);

      // Create a single partition using the entire disk
      await execPromise(`parted -s ${device} mkpart primary 2048s 100%`);

      // Wait a moment for the partition to be recognized by the kernel
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Inform kernel about partition table changes
      try {
        await execPromise(`partprobe ${device}`);
      } catch (error) {
        // partprobe might fail on some systems, but that's usually not critical
        console.warn(`partprobe failed: ${error.message}`);
      }

      // Determine partition path
      targetDevice = this._getPartitionPath(device, 1);

      console.log(`Created partition: ${targetDevice}`);
    }

    return targetDevice;
  }

  /**
   * Format a device with the specified filesystem
   * Creates a partition first if device is a whole disk
   */
  async formatDevice(device, filesystem = 'xfs') {
    console.log(`Formatting ${device} with ${filesystem}...`);

    try {
      // Ensure partition exists (create if whole disk)
      const targetDevice = await this._ensurePartition(device);

      // Check if the target device (partition) is already formatted with the requested filesystem
      const deviceInfo = await this.checkDeviceFilesystem(targetDevice);

      if (deviceInfo.isFormatted && deviceInfo.filesystem === filesystem) {
        return {
          success: true,
          message: `Device ${targetDevice} is already formatted with ${filesystem}`,
          device: targetDevice,
          filesystem,
          uuid: deviceInfo.uuid,
          alreadyFormatted: true
        };
      }

      // Format the partition with the specified filesystem
      let command;

      switch (filesystem) {
        case 'ext4':
          command = `mkfs.ext4 -F ${targetDevice}`;
          break;
        case 'xfs':
          command = `mkfs.xfs -f ${targetDevice}`;
          break;
        case 'btrfs':
          command = `mkfs.btrfs -f ${targetDevice}`;
          break;
        default:
          throw new Error(`Unsupported filesystem type: ${filesystem}. Supported types are: ext4, xfs, btrfs`);
      }

      if (!command) {
        throw new Error(`Failed to determine format command for filesystem: ${filesystem}`);
      }

      await execPromise(command);

      // Get the UUID after formatting
      const { stdout } = await execPromise(`blkid -o export ${targetDevice}`);
      const uuid = stdout.match(/UUID="?([^"\n]+)"?/)?.[1] || null;

      return {
        success: true,
        message: `Device ${device} successfully formatted with ${filesystem}`,
        device: targetDevice,
        filesystem,
        uuid,
        alreadyFormatted: false
      };
    } catch (error) {
      throw new Error(`Error formatting device ${device}: ${error.message}`);
    }
  }

  /**
   * Mount a device
   * This method automatically detects if the filesystem is on a partition and mounts the correct device
   */
  async mountDevice(device, mountPoint, options = {}) {
    try {
      // Check if the device exists
      await fs.access(device);

      // Check if the device is formatted and get the actual device to mount
      let deviceInfo = await this.checkDeviceFilesystem(device);

      // Determine the actual device to mount (could be a partition)
      const actualDeviceToMount = deviceInfo.actualDevice || device;
      const isUsingPartition = deviceInfo.actualDevice && deviceInfo.actualDevice !== device;

      // Format if requested and not already formatted with the correct filesystem
      if (options.format && (!deviceInfo.isFormatted ||
          (options.filesystem && deviceInfo.filesystem !== options.filesystem))) {
        await this.formatDevice(actualDeviceToMount, options.filesystem || 'xfs');
        // Re-check the filesystem info after formatting
        deviceInfo = await this.checkDeviceFilesystem(device);
      } else if (!deviceInfo.isFormatted) {
        const deviceDisplayName = isUsingPartition ? `${device} (no filesystem found on device or partitions)` : device;
        throw new Error(`Device ${deviceDisplayName} is not formatted. Please format it first or use the format option.`);
      }

      // Create mount point if it doesn't exist with proper ownership
      try {
        await fs.access(mountPoint);
      } catch {
        const ownershipOptions = {
          uid: this.defaultOwnership.uid,
          gid: this.defaultOwnership.gid
        };
        await this._createDirectoryWithOwnership(mountPoint, ownershipOptions);
      }

      // Check if already mounted
      if (await this._isMounted(mountPoint)) {
        return {
          success: true,
          message: `Device ${device} is already mounted at ${mountPoint}`,
          requestedDevice: device,
          actualDevice: actualDeviceToMount,
          mountPoint,
          alreadyMounted: true,
          isUsingPartition
        };
      }

      // Check if the actual device is already mounted elsewhere
      const mountStatus = await this._isDeviceMounted(actualDeviceToMount);
      if (mountStatus.isMounted) {
        throw new Error(`Device ${actualDeviceToMount} is already mounted at ${mountStatus.mountPoint}. Please unmount it first.`);
      }

      // Prepare mount options
      let mountOptions = '';
      if (options.mountOptions) {
        mountOptions = `-o ${options.mountOptions}`;
      }

      // Prefer mounting by UUID if available for better reliability
      let mountCommand;
      if (deviceInfo.uuid && options.preferUUID !== false) {
        mountCommand = `mount ${mountOptions} UUID=${deviceInfo.uuid} ${mountPoint}`;
      } else {
        mountCommand = `mount ${mountOptions} ${actualDeviceToMount} ${mountPoint}`;
      }

      // Mount the device
      await execPromise(mountCommand);

      // Set ownership of the mount point after mounting (if not already set)
      const uid = this.defaultOwnership.uid;
      const gid = this.defaultOwnership.gid;
      if (uid !== undefined && gid !== undefined) {
        try {
          const stats = await fs.stat(mountPoint);
          // Only set ownership if it's different from what we want
          if (stats.uid !== uid || stats.gid !== gid) {
            await this._setOwnership(mountPoint, uid, gid);
          }
        } catch (error) {
          // If stat fails, try to set ownership anyway
          await this._setOwnership(mountPoint, uid, gid);
        }
      }

      const successMessage = isUsingPartition
        ? `Device ${device} (partition ${actualDeviceToMount}) successfully mounted at ${mountPoint}`
        : `Device ${device} successfully mounted at ${mountPoint}`;

      return {
        success: true,
        message: successMessage,
        requestedDevice: device,
        actualDevice: actualDeviceToMount,
        mountPoint,
        filesystem: deviceInfo.filesystem,
        uuid: deviceInfo.uuid,
        alreadyMounted: false,
        isUsingPartition,
        mountedByUUID: deviceInfo.uuid && options.preferUUID !== false
      };
    } catch (error) {
      throw new Error(`Error mounting device ${device}: ${error.message}`);
    }
  }

  /**
   * Unmount a device
   */
  async unmountDevice(mountPoint, options = {}) {
    try {
      // Check if the path is mounted
      if (!(await this._isMounted(mountPoint))) {
        return {
          success: true,
          message: `Path ${mountPoint} is not mounted`,
          mountPoint,
          alreadyUnmounted: true
        };
      }

      let retries = options.retries || 3;
      let success = false;
      let lastError;

      // First try: standard unmount
      for (let attempt = 1; attempt <= 1; attempt++) {
        try {
          let unmountCommand = 'umount';
          if (options.force) {
            unmountCommand += ' -f';
          }
          await execPromise(`${unmountCommand} ${mountPoint}`);
          success = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      // If standard unmount failed, try lazy unmount
      if (!success) {
        // Discrete check which processes are using the mount point
        try {
          await execPromise(`fuser -v ${mountPoint} 2>&1 || true`);
        } catch (error) {
          // Ignore if fuser is not available
        }

        // Second attempt: with lazy unmount (umount -l)
        for (let attempt = 1; attempt <= retries-1; attempt++) {
          try {
            await execPromise(`umount -l ${mountPoint}`);
            success = true;
            break;
          } catch (error) {
            lastError = error;
            // Wait before next attempt
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      }

      if (!success) {
        throw new Error(`Failed to unmount after ${retries} attempts: ${lastError.message}\nHinweis: Der Mount-Punkt wird noch von Prozessen verwendet. Versuche, alle Anwendungen zu schließen, die auf diesen Pool zugreifen.`);
      }

      // Remove directory if requested
      if (options.removeDirectory) {
        try {
          await fs.rmdir(mountPoint);
        } catch (error) {
          // Non-critical error, directory might not be empty - can be ignored
        }
      }

      return {
        success: true,
        message: `Successfully unmounted ${mountPoint}`,
        mountPoint,
        directoryRemoved: options.removeDirectory ? true : false,
        alreadyUnmounted: false
      };
    } catch (error) {
      throw new Error(`Error unmounting ${mountPoint}: ${error.message}`);
    }
  }

  /**
   * Get device space information
   * @param {string} mountPoint - Mount point path
   * @param {Object} user - User object with byte_format preference
   */
  async getDeviceSpace(mountPoint, user = null) {
    try {
      if (!(await this._isMounted(mountPoint))) {
        return {
          mounted: false,
          totalSpace: 0,
          usedSpace: 0,
          freeSpace: 0,
          usagePercent: 0
        };
      }

      // Use timeout to avoid hanging on unavailable remote mounts
      const { stdout } = await execPromise(`timeout 5 df -B1 ${mountPoint} | tail -1`);
      const parts = stdout.trim().split(/\s+/);

      if (parts.length >= 6) {
        const totalSpace = parseInt(parts[1], 10);
        const usedSpace = parseInt(parts[2], 10);
        const freeSpace = parseInt(parts[3], 10);

        return {
          mounted: true,
          totalSpace,
          totalSpace_human: this.formatBytes(totalSpace, user),
          usedSpace,
          usedSpace_human: this.formatBytes(usedSpace, user),
          freeSpace,
          freeSpace_human: this.formatBytes(freeSpace, user),
          usagePercent: Math.round((usedSpace / totalSpace) * 100),
          health: "healthy"
        };
      }

      throw new Error(`Unexpected df output format: ${stdout}`);
    } catch (error) {
      return {
        mounted: false,
        health: "unknown",
        totalSpace: 0,
        usedSpace: 0,
        freeSpace: 0,
        usagePercent: 0,
        error: error.message
      };
    }
  }

  /**
   * Create a single device pool
   * @param {string} name - Pool name
   * @param {string} device - Device path
   * @param {string} filesystem - Filesystem type (optional)
   * @param {Object} options - Additional options
   * @param {Object} options.config - Pool configuration
   * @param {boolean} options.config.encrypted - Enable LUKS encryption
   * @param {boolean} options.config.create_keyfile - Create keyfile for encrypted pool (default: false)
   * @param {string} options.passphrase - Passphrase for encryption (required if encrypted=true)
   */
  async createSingleDevicePool(name, device, filesystem = null, options = {}) {
    let encryptionEnabled = false;
    let luksDevices = null;

    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');
      if (!device) throw new Error('Device path is required');

      // Validate encryption parameters
      if (options.config?.encrypted) {
        if (!options.passphrase || options.passphrase.trim() === '') {
          if (options.config?.create_keyfile) {
            // Generate secure random passphrase if keyfile creation is requested
            options.passphrase = this._generateSecurePassphrase();
            console.log(`Generated secure passphrase for encrypted pool '${name}' (will be stored in keyfile)`);
          } else {
            throw new Error('Passphrase is required for encrypted pools');
          }
        }
        if (options.passphrase.length < 8) {
          throw new Error('Passphrase must be at least 8 characters long for LUKS encryption');
        }
      }

      // Read current pools data
      const pools = await this._readPools();

      // Check if pool with the same name already exists
      const existingPoolIndex = pools.findIndex(p => p.name === name);
      if (existingPoolIndex !== -1) {
        throw new Error(`Pool with name "${name}" already exists`);
      }

      // Check if device is already mounted
      const mountStatus = await this._isDeviceMounted(device);
      if (mountStatus.isMounted) {
        throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before creating a pool.`);
      }

      let actualDevice = device;
      let encryptionEnabled = false;

      // First check device filesystem to determine if partitioning is needed
      let deviceInfo = await this.checkDeviceFilesystem(actualDevice);

      let actualDeviceToUse = deviceInfo.actualDevice || actualDevice;
      const isUsingPartition = deviceInfo.actualDevice && deviceInfo.actualDevice !== actualDevice;

      // Check if device is already LUKS encrypted (only relevant for format=false)
      const isAlreadyLuks = deviceInfo.isFormatted && deviceInfo.filesystem === 'crypto_LUKS';

      // Handle LUKS encryption
      if (options.config?.encrypted || (isAlreadyLuks && options.format === false)) {
        if (isAlreadyLuks && !options.config?.encrypted && options.format === false) {
          // Device is LUKS but user didn't request encryption - need to open it to check filesystem
          console.log(`Device ${actualDeviceToUse} is LUKS encrypted, opening to check filesystem...`);
        } else if (!isAlreadyLuks && options.config?.encrypted && options.format === false) {
          // User wants to encrypt but format=false - cannot encrypt without formatting
          throw new Error(`Cannot encrypt device ${device} without formatting. Use format: true to encrypt.`);
        } else if (isAlreadyLuks && options.format === true && !options.config?.encrypted) {
          // Device is LUKS but format=true without encryption - will destroy LUKS and create new filesystem
          console.log(`Device ${actualDeviceToUse} is LUKS encrypted but will be reformatted without encryption`);
        }

        if (isAlreadyLuks && options.format === false) {
          // Device is already LUKS - need to open it
          console.log(`Device ${actualDeviceToUse} is LUKS encrypted, attempting to open...`);

          // Check if passphrase is provided
          if (!options.passphrase) {
            throw new Error(`Device ${actualDeviceToUse} is LUKS encrypted but no passphrase provided. Please provide a passphrase to unlock the device.`);
          }

          await this._cleanupExistingLuksMappers(name);

          let luksDevices;
          try {
            luksDevices = await this._openLuksDevicesWithSlots([actualDeviceToUse], name, [1], options.passphrase);
          } catch (error) {
            throw new Error(`Failed to open LUKS device ${actualDeviceToUse}: ${error.message}. Please check your passphrase or keyfile.`);
          }

          const luksDevice = luksDevices[0].mappedDevice;

          // Check filesystem inside LUKS container
          const luksFilesystemInfo = await this.checkDeviceFilesystem(luksDevice);

          if (options.format === false) {
            // Import mode - validate filesystem
            if (!luksFilesystemInfo.isFormatted) {
              throw new Error(`LUKS container ${luksDevice} has no filesystem. Use format: true to format.`);
            }
            if (filesystem && filesystem !== luksFilesystemInfo.filesystem) {
              throw new Error(`LUKS container has filesystem ${luksFilesystemInfo.filesystem}, but ${filesystem} was requested. Use format: true to reformat.`);
            }
            filesystem = luksFilesystemInfo.filesystem;
            actualDeviceToUse = luksDevice;
          } else {
            // Format mode - format the LUKS container
            filesystem = filesystem || 'xfs';
            const formatResult = await this.formatDevice(luksDevice, filesystem);
            await this._refreshDeviceSymlinks();
            actualDeviceToUse = formatResult.device;
          }

          // Get UUID from physical device
          const physicalDevice = luksDevices[0].originalDevice;
          const physicalUuid = await this.getDeviceUuid(physicalDevice);

          deviceInfo = {
            isFormatted: true,
            filesystem,
            uuid: physicalUuid,
            actualDevice: physicalDevice
          };

          encryptionEnabled = true;

          // Close LUKS if automount=false
          if (!options.automount) {
            console.log(`Closing LUKS device (automount=false)`);
            const partitionDevice = actualDeviceToUse.split('/').pop();
            const mainDevice = luksDevice.split('/').pop();

            try {
              await execPromise(`cryptsetup luksClose ${partitionDevice}`);
            } catch (error) {
              console.warn(`Failed to close LUKS partition: ${error.message}`);
            }

            try {
              await execPromise(`cryptsetup luksClose ${mainDevice}`);
            } catch (error) {
              console.warn(`Failed to close LUKS main device: ${error.message}`);
              try {
                await execPromise(`dmsetup remove ${mainDevice}`);
              } catch (dmError) {
                console.warn(`Failed to force remove LUKS device: ${dmError.message}`);
              }
            }
          }
        } else if (options.config?.encrypted) {
          // Create new LUKS encryption
          console.log(`Setting up LUKS encryption for single device pool '${name}' on ${actualDeviceToUse}`);
          await this._cleanupExistingLuksMappers(name);
          await this._setupPoolEncryption([actualDeviceToUse], name, options.passphrase, options.config.create_keyfile);

          // Open LUKS devices (use slot 1 for single device)
          const luksDevices = await this._openLuksDevicesWithSlots([actualDeviceToUse], name, [1], options.passphrase);
          const luksDevice = luksDevices[0].mappedDevice;

          // Get UUID from the physical device
          const physicalDevice = luksDevices[0].originalDevice;
          console.log(`Getting UUID from physical device: ${physicalDevice}`);
          const physicalUuid = await this.getDeviceUuid(physicalDevice);
          console.log(`Physical device UUID: ${physicalUuid}`);

          // Format LUKS device only if format=true
          if (options.format === true) {
            filesystem = filesystem || 'xfs';
            const formatResult = await this.formatDevice(luksDevice, filesystem);
            await this._refreshDeviceSymlinks();
            actualDeviceToUse = formatResult.device;
          } else {
            // format=false: Import existing filesystem (no formatting)
            actualDeviceToUse = luksDevice;
          }

          deviceInfo = {
            isFormatted: true,
            filesystem,
            uuid: physicalUuid,
            actualDevice: physicalDevice
          };

          encryptionEnabled = true;

          // If automount is false, close the LUKS device
          if (!options.automount) {
            console.log(`Closing LUKS device (automount=false)`);
            const partitionDevice = actualDeviceToUse.split('/').pop();
            const mainDevice = luksDevice.split('/').pop();

            try {
              await execPromise(`cryptsetup luksClose ${partitionDevice}`);
              console.log(`Closed LUKS partition: ${partitionDevice}`);
            } catch (error) {
              console.warn(`Failed to close LUKS partition ${partitionDevice}: ${error.message}`);
            }

            try {
              await execPromise(`cryptsetup luksClose ${mainDevice}`);
              console.log(`Closed LUKS main device: ${mainDevice}`);
            } catch (error) {
              console.warn(`Failed to close LUKS main device ${mainDevice}: ${error.message}`);
              try {
                await execPromise(`dmsetup remove ${mainDevice}`);
                console.log(`Force removed LUKS device using dmsetup: ${mainDevice}`);
              } catch (dmError) {
                console.warn(`Failed to force remove LUKS device ${dmError.message}`);
              }
            }
          }
        }
      } else {
        // Handle non-encrypted devices
        if (options.format === true) {
          // format=true: Create partition and format
          filesystem = filesystem || 'xfs';
          const formatResult = await this.formatDevice(actualDeviceToUse, filesystem);
          // Refresh device symlinks after formatting
          await this._refreshDeviceSymlinks();
          deviceInfo = {
            isFormatted: true,
            filesystem,
            uuid: formatResult.uuid,
            actualDevice: formatResult.device
          };
          actualDeviceToUse = formatResult.device;
        } else {
          // format=false: Import mode - use existing filesystem as-is
          if (deviceInfo.isFormatted) {
            // Device has filesystem - use it (with or without partition)
            if (filesystem && filesystem !== deviceInfo.filesystem) {
              // Filesystem mismatch - inform user
              const deviceDisplayName = isUsingPartition ? `${device} (partition ${actualDeviceToUse})` : device;
              throw new Error(`Device ${deviceDisplayName} has filesystem ${deviceInfo.filesystem}, but ${filesystem} was requested. Use format: true to reformat.`);
            }
            // Use existing filesystem
            filesystem = deviceInfo.filesystem;
            // actualDeviceToUse is already set correctly (partition or whole disk)
          } else {
            // Device has no filesystem
            throw new Error(`Device ${device} has no filesystem. Use format: true to create partition and format.`);
          }
        }
      }

      // For encrypted pools, skip UUID override since we already have the correct physical device UUID
      if (!encryptionEnabled) {
        // Always ensure we have the correct UUID from the actual device being used
        let finalUuid = await this.getDeviceUuid(actualDeviceToUse);
        if (!finalUuid) {
          // Fallback: try to use UUID from deviceInfo if direct query failed
          finalUuid = deviceInfo.uuid;
        }
        if (!finalUuid) {
          throw new Error(`No filesystem UUID found for device ${actualDeviceToUse}. Device may not be properly formatted.`);
        }

        deviceInfo.uuid = finalUuid;
      }

      // Create mount point
      const mountPoint = path.join(this.mountBasePath, name);

      // Create pool object
      const poolId = generateId();

      // Determine pool type based on filesystem
      let poolType = filesystem;

      // Minimal configuration with sensible default values
      // automount defaults to false, to prevent unexpected mount operations
      const newPool = {
        id: poolId,
        name,
        type: poolType,
        automount: options.automount !== undefined ? options.automount : false,
        comment: options.comment || "",
        index: this._getNextPoolIndex(pools),
        data_devices: [
          {
            slot: "1",
            id: deviceInfo.uuid, // UUID of the physical device/partition
            filesystem,
            spindown: options.spindown || null
          }
        ],
        parity_devices: [],
        config: {
          encrypted: encryptionEnabled,
          ...(options.config || {})
        }
      };

      // Add pool to pools array and save
      pools.push(newPool);
      await this._writePools(pools);

      // Mount the pool if automount is true
      if (newPool.automount) {
        try {
          await this.mountDevice(actualDeviceToUse, mountPoint);
        } catch (mountError) {
          // Mount error is ignored, as automount is optional
        }
      }

      const successMessage = isUsingPartition
        ? `Successfully created single device pool "${name}" using partition ${actualDeviceToUse} from device ${device}`
        : `Successfully created single device pool "${name}"`;

      return {
        success: true,
        message: successMessage,
        pool: newPool,
        deviceInfo: {
          requestedDevice: device,
          actualDevice: actualDeviceToUse,
          isUsingPartition
        }
      };
    } catch (error) {
      // Cleanup LUKS devices if encryption was enabled and pool creation failed
      if (encryptionEnabled && luksDevices) {
        console.log(`Pool creation failed, cleaning up LUKS devices for '${name}'`);
        try {
          await this._closeLuksDevices([device], name);
        } catch (cleanupError) {
          console.warn(`Warning: Could not cleanup LUKS devices: ${cleanupError.message}`);
        }
      }
      throw new Error(`Error creating single device pool: ${error.message}`);
    }
  }

  /**
   * Mount a pool by ID
   * @param {string} poolId - Pool ID
   * @param {Object} options - Mount options
   * @param {string} options.passphrase - Passphrase for encrypted pools (if keyfile missing)
   */
  async mountPoolById(poolId, options = {}) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Ensure device paths are available before mounting
      await this._ensureDevicePaths(pool);

      // Handle LUKS encryption before mounting
      if (pool.config?.encrypted) {
        console.log(`Opening LUKS devices for encrypted pool '${pool.name}'`);

        // Use the device path resolved from UUID
        const physicalDevice = pool.data_devices[0].device;
        const dataDeviceUuid = pool.data_devices[0].id;

        // Check if LUKS device is already mapped by looking for the UUID
        try {
          const mappedDevice = await execPromise(`find /dev/disk/by-uuid/ -name "${dataDeviceUuid}" -exec readlink -f {} \\;`);
          const devicePath = mappedDevice.stdout.trim();

          if (devicePath && devicePath.includes('/dev/mapper/')) {
            console.log(`LUKS device already mapped: ${devicePath}`);
            // Extract the mapper name from the path
            const mapperName = devicePath.replace('/dev/mapper/', '').replace('p1', '');
            pool._luksDevices = [{
              originalDevice: physicalDevice,
              mappedDevice: `/dev/mapper/${mapperName}`,
              uuid: dataDeviceUuid
            }];
          } else {
            throw new Error('Not mapped');
          }
        } catch (error) {
          // Device not mapped, need to open it
          console.log(`LUKS device not mapped, opening ${physicalDevice}...`);

          // Open the LUKS device using the physical device from pools.json with slot-based naming
          const deviceSlot = parseInt(pool.data_devices[0].slot);
          const luksDevices = await this._openLuksDevicesWithSlots([physicalDevice], pool.name, [deviceSlot], options.passphrase || null);
          pool._luksDevices = luksDevices;
        }
      }

      // For single device pools
      if (pool.data_devices && pool.data_devices.length === 1 &&
          ['ext4', 'xfs', 'btrfs'].includes(pool.type)) {
        let device = pool.data_devices[0].device;
        const mountPoint = path.join(this.mountBasePath, pool.name);

        // For LUKS pools, use the mapped device directly (no partition)
        if (pool.config?.encrypted && pool._luksDevices) {
          device = pool._luksDevices[0].mappedDevice;
        }

        // Mount the device with format option
        const mountResult = await this.mountDevice(device, mountPoint, {
          format: options.format,
          filesystem: pool.data_devices[0].filesystem || pool.type,
          mountOptions: options.mountOptions
        });

        // Get space info after successful mount (for response only)
        const spaceInfo = await this.getDeviceSpace(mountPoint);

        return {
          success: true,
          message: `Pool "${pool.name}" (ID: ${poolId}) mounted successfully`,
          pool: {
            id: pool.id,
            name: pool.name,
            status: spaceInfo
          }
        };
      }

      // For multi-device BTRFS pools
      else if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1) {
        return await this._mountMultiDeviceBtrfsPool(pool, options);
      }

      // For MergerFS pools
      else if (pool.type === 'mergerfs') {
        return await this._mountMergerFSPool(pool, options);
      }

      else {
        throw new Error(`Mounting for pool type "${pool.type}" is not implemented yet`);
      }
    } catch (error) {
      throw new Error(`Error mounting pool: ${error.message}`);
    }
  }

  /**
   * Check if the pool mount point is busy using findmnt
   * @param {string} poolName - Name of the pool to check
   * @returns {Promise<Object>} Busy check results
   */
  async _checkPoolBusy(poolName) {
    try {
      const poolMountPath = `/mnt/${poolName}`;
      const mountedPaths = [];

      // Check main pool mount path (/mnt/poolname)
      const { stdout: mainStdout } = await execPromise(`findmnt -R ${poolMountPath} -o TARGET,SOURCE -n 2>/dev/null || true`);

      if (mainStdout.trim()) {
        const lines = mainStdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 1) {
            const target = parts[0];
            const source = parts[1] || 'unknown';

            // Skip the pool mount itself, only check subdirectories
            if (target !== poolMountPath) {
              mountedPaths.push({
                target,
                source,
                description: `Mounted filesystem at ${target}`
              });
            }
          }
        }
      }

      return {
        isBusy: mountedPaths.length > 0,
        mountedPaths,
        poolMountPath
      };

    } catch (error) {
      console.warn('Error checking pool busy status:', error.message);
      return {
        isBusy: false,
        mountedPaths: [],
        error: error.message
      };
    }
  }

  /**
   * Check if any services are using the pool and would be affected by unmounting
   * @param {string} poolName - Name of the pool to check
   * @returns {Promise<Object>} Service dependency check results
   */
  async _checkServiceDependencies(poolName) {
    try {
      // First check if pool is busy using findmnt (more reliable for /mnt paths)
      const busyCheck = await this._checkPoolBusy(poolName);

      if (busyCheck.isBusy) {
        return {
          hasDependencies: true,
          dependencies: busyCheck.mountedPaths.map(mount => ({
            service: 'System',
            type: 'mount',
            path: mount.target,
            description: `Active mount point (${mount.source})`
          })),
          poolMountPath: busyCheck.poolMountPath,
          busyReason: 'active_mounts'
        };
      }

      // Initialize MOS service if not already done
      if (!this.mosService) {
        this.mosService = require('./mos.service');
      }

      const poolMountPath = `/mnt/${poolName}`;
      const mergerfsBasePath = `/var/mergerfs/${poolName}`;
      const dependencies = [];

      /**
       * Helper function to check if a service path uses this pool
       * For /mnt paths: simple startsWith check
       * For /var/mergerfs paths: extract disk and verify it's mounted
       * @param {string} servicePath - The path to check
       * @returns {Promise<boolean>} True if the path is on this pool and accessible
       */
      const isPathOnPool = async (servicePath) => {
        if (!servicePath) return false;

        // Check regular pool mount (/mnt/poolname)
        if (servicePath.startsWith(poolMountPath)) {
          return true;
        }

        // Check MergerFS disk path (/var/mergerfs/poolname/diskN/...)
        if (servicePath.startsWith(mergerfsBasePath)) {
          // Extract the disk path: /var/mergerfs/poolname/diskN
          const relativePath = servicePath.substring(mergerfsBasePath.length);
          const pathParts = relativePath.split('/').filter(p => p);

          if (pathParts.length > 0) {
            const diskName = pathParts[0]; // e.g., 'disk1', 'disk2'
            const diskMountPath = `${mergerfsBasePath}/${diskName}`;

            // Check if this specific disk is mounted
            try {
              const isMounted = await this._isMounted(diskMountPath);
              return isMounted;
            } catch (error) {
              console.warn(`Could not check mount status for ${diskMountPath}:`, error.message);
              return false;
            }
          }
        }

        return false;
      };

      // Get all service statuses
      const serviceStatus = await this.mosService.getAllServiceStatus();

      // Check Docker dependencies
      if (serviceStatus.docker.enabled) {
        try {
          const dockerSettings = await this.mosService.getDockerSettings();

          // Check Docker system directory
          if (await isPathOnPool(dockerSettings.directory)) {
            dependencies.push({
              service: 'Docker',
              type: 'system',
              path: dockerSettings.directory,
              description: 'Docker system directory'
            });
          }

          // Check Docker appdata directory
          if (await isPathOnPool(dockerSettings.appdata)) {
            dependencies.push({
              service: 'Docker',
              type: 'appdata',
              path: dockerSettings.appdata,
              description: 'Docker application data directory'
            });
          }
        } catch (error) {
          console.warn('Could not check Docker settings:', error.message);
        }
      }

      // Check LXC dependencies
      if (serviceStatus.lxc.enabled) {
        try {
          const lxcSettings = await this.mosService.getLxcSettings();

          if (await isPathOnPool(lxcSettings.directory)) {
            dependencies.push({
              service: 'LXC',
              type: 'system',
              path: lxcSettings.directory,
              description: 'LXC container directory'
            });
          }
        } catch (error) {
          console.warn('Could not check LXC settings:', error.message);
        }
      }

      // Check VM dependencies
      if (serviceStatus.vm.enabled) {
        try {
          const vmSettings = await this.mosService.getVmSettings();

          // Check VM libvirt directory
          if (await isPathOnPool(vmSettings.directory)) {
            dependencies.push({
              service: 'VM',
              type: 'libvirt',
              path: vmSettings.directory,
              description: 'VM libvirt directory'
            });
          }

          // Check VM vdisk directory
          if (await isPathOnPool(vmSettings.vdisk_directory)) {
            dependencies.push({
              service: 'VM',
              type: 'vdisk',
              path: vmSettings.vdisk_directory,
              description: 'VM virtual disk directory'
            });
          }
        } catch (error) {
          console.warn('Could not check VM settings:', error.message);
        }
      }


      return {
        hasDependencies: dependencies.length > 0,
        dependencies,
        poolMountPath
      };

    } catch (error) {
      console.warn('Error checking service dependencies:', error.message);
      return {
        hasDependencies: false,
        dependencies: [],
        error: error.message
      };
    }
  }

  /**
   * Unmount a pool by ID
   */
  async unmountPoolById(poolId, options = {}) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Check for service dependencies unless force is used
      if (!options.force) {
        const dependencyCheck = await this._checkServiceDependencies(pool.name);

        if (dependencyCheck.hasDependencies) {
          const serviceList = dependencyCheck.dependencies.map(dep =>
            `- ${dep.service} (${dep.description}: ${dep.path})`
          ).join('\n');

          throw new Error(
            `Cannot unmount pool "${pool.name}" because it is being used by active services:\n\n${serviceList}\n\n` +
            `Please stop the affected services first, or use force=true to override this check.`
          );
        }
      }

      // For single device pools
      if (pool.data_devices && pool.data_devices.length === 1 &&
          ['ext4', 'xfs', 'btrfs'].includes(pool.type)) {
        return await this._unmountSingleDevicePool(pool, options.force);
      }

      // For multi-device BTRFS pools
      else if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1) {
        return await this._unmountMultiDeviceBtrfsPool(pool, options.force);
      }

      // For MergerFS pools
      else if (pool.type === 'mergerfs') {
        return await this._unmountMergerFSPool(pool, options.force);
      }

      else {
        throw new Error(`Unmounting for pool type "${pool.type}" is not implemented yet`);
      }
    } catch (error) {
      throw new Error(`Error unmounting pool: ${error.message}`);
    }
  }

  /**
   * Remove a pool by ID
   */
  async removePoolById(poolId, options = {}) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];

      // Check for service dependencies unless force is used
      if (!options.force) {
        const dependencyCheck = await this._checkServiceDependencies(pool.name);

        if (dependencyCheck.hasDependencies) {
          const serviceList = dependencyCheck.dependencies.map(dep =>
            `- ${dep.service} (${dep.description}: ${dep.path})`
          ).join('\n');

          throw new Error(
            `Cannot delete pool "${pool.name}" because it is being used by active services:\n\n${serviceList}\n\n` +
            `Please stop the affected services first, or use force=true to override this check.`
          );
        }
      }

      // Perform pool-type-specific unmounting
      await this._performCompletePoolUnmount(pool, options);

      // Only remove from pools array AFTER successful unmount
      const removedPool = pools.splice(poolIndex, 1)[0];
      await this._writePools(pools);

      // Clean up SnapRAID config if it was a MergerFS pool
      if (removedPool.type === 'mergerfs') {
        await this.cleanupSnapRAIDConfig(removedPool.name);
      }

      return {
        success: true,
        message: `Pool "${removedPool.name}" (ID: ${poolId}) removed successfully`,
        pool: removedPool
      };
    } catch (error) {
      throw new Error(`Error removing pool: ${error.message}`);
    }
  }

  /**
   * Perform complete unmounting for different pool types
   * @private
   */
  async _performCompletePoolUnmount(pool, options = {}) {
    const { force = false } = options;

    if (pool.type === 'mergerfs') {
      await this._unmountMergerFSPool(pool, force);
    } else if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1) {
      await this._unmountMultiDeviceBtrfsPool(pool, force);
    } else if (['btrfs', 'ext4', 'xfs'].includes(pool.type)) {
      await this._unmountSingleDevicePool(pool, force);
    } else {
      throw new Error(`Unsupported pool type for removal: ${pool.type}`);
    }
  }

  /**
   * Unmount a MergerFS pool completely
   * @private
   */
  async _unmountMergerFSPool(pool, force = false) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const mergerfsBasePath = path.join(this.mergerfsBasePath, pool.name);

    // Ensure device paths are available
    await this._ensureDevicePaths(pool);

    const unmountErrors = [];

    // Step 1: Unmount main MergerFS mount point
    if (await this._isMounted(mountPoint)) {
      try {
        await this.unmountDevice(mountPoint, {
          force,
          removeDirectory: true
        });
      } catch (error) {
        unmountErrors.push(`Main mount point ${mountPoint}: ${error.message}`);
        if (!force) {
          throw new Error(`Failed to unmount main mount point: ${error.message}`);
        }
      }
    }

    // Step 2: Unmount all individual data device mount points
    for (const device of pool.data_devices) {
      const deviceMountPoint = path.join(mergerfsBasePath, `disk${device.slot}`);

      if (await this._isMounted(deviceMountPoint)) {
        try {
          await this.unmountDevice(deviceMountPoint, {
            force,
            removeDirectory: true
          });
        } catch (error) {
          unmountErrors.push(`Data device ${device.device} at ${deviceMountPoint}: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to unmount data device ${device.device}: ${error.message}`);
          }
        }
      }
    }

    // Step 3: Unmount parity devices if they exist
    for (let i = 0; i < (pool.parity_devices || []).length; i++) {
      const parityDevice = pool.parity_devices[i];
      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
      const parityMountPoint = path.join(snapraidPoolPath, `parity${i + 1}`);

      if (await this._isMounted(parityMountPoint)) {
        try {
          await this.unmountDevice(parityMountPoint, {
            force,
            removeDirectory: true
          });
        } catch (error) {
          unmountErrors.push(`Parity device ${parityDevice.device} at ${parityMountPoint}: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to unmount parity device ${parityDevice.device}: ${error.message}`);
          }
        }
      }
    }

    // Step 4: Close LUKS devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for encrypted MergerFS pool '${pool.name}' during removal`);

      // Extract physical device paths from data_devices and parity_devices
      const dataDevicesToClose = pool.data_devices.map(d => d.device);
      const parityDevicesToClose = pool.parity_devices.map(d => d.device);

      // Close data device LUKS mappers using slot numbers
      if (dataDevicesToClose.length > 0) {
        const dataSlots = pool.data_devices.map(d => parseInt(d.slot));
        await this._closeLuksDevicesWithSlots(dataDevicesToClose, pool.name, dataSlots);
      }

      // Close parity device LUKS mappers using slot numbers if they exist
      if (parityDevicesToClose.length > 0) {
        const paritySlots = pool.parity_devices.map(d => parseInt(d.slot));
        await this._closeLuksDevicesWithSlots(parityDevicesToClose, pool.name, paritySlots, true);
      }
    }

    // Step 5: Remove the mergerfs base directory
    try {
      const stats = await fs.stat(mergerfsBasePath);
      if (stats.isDirectory()) {
        // Check if directory is empty before removing
        const dirContents = await fs.readdir(mergerfsBasePath);
        if (dirContents.length === 0) {
          await fs.rmdir(mergerfsBasePath);
        } else if (force) {
          // Force removal of non-empty directory
          await execPromise(`rm -rf ${mergerfsBasePath}`);
        } else {
          unmountErrors.push(`MergerFS base directory ${mergerfsBasePath} is not empty`);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        unmountErrors.push(`Cleanup of base directory ${mergerfsBasePath}: ${error.message}`);
        if (!force) {
          throw new Error(`Failed to cleanup base directory: ${error.message}`);
        }
      }
    }

    // Step 5: Remove the snapraid base directory if it exists and has parity devices
    if (pool.parity_devices && pool.parity_devices.length > 0) {
      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
      try {
        const stats = await fs.stat(snapraidPoolPath);
        if (stats.isDirectory()) {
          // Check if directory is empty before removing
          const dirContents = await fs.readdir(snapraidPoolPath);
          if (dirContents.length === 0) {
            await fs.rmdir(snapraidPoolPath);
          } else if (force) {
            // Force removal of non-empty directory
            await execPromise(`rm -rf ${snapraidPoolPath}`);
          } else {
            unmountErrors.push(`SnapRAID base directory ${snapraidPoolPath} is not empty`);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          unmountErrors.push(`Cleanup of SnapRAID directory ${snapraidPoolPath}: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to cleanup SnapRAID directory: ${error.message}`);
          }
        }
      }
    }

    // Report warnings if force was used and errors occurred
    if (force && unmountErrors.length > 0) {
      console.warn(`Warning: Some unmount operations failed during forced removal:\n${unmountErrors.join('\n')}`);
    }
  }

  /**
   * Unmount a single device pool (BTRFS, XFS, EXT4)
   * @private
   */
  async _unmountSingleDevicePool(pool, force = false) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    if (await this._isMounted(mountPoint)) {
      try {
        await this.unmountDevice(mountPoint, {
          force,
          removeDirectory: true
        });
      } catch (error) {
        throw new Error(`Failed to unmount pool: ${error.message}`);
      }
    }

    // Close LUKS devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for encrypted pool '${pool.name}' during unmount`);

      // For single device pools, we need to get the physical device first
      await this._ensureDevicePaths(pool);
      const physicalDevice = pool.data_devices[0].device;

      console.log(`Single device pool - closing LUKS slot 1 for pool '${pool.name}' with device ${physicalDevice}`);
      await this._closeLuksDevicesWithSlots([physicalDevice], pool.name, [1]);
    }
  }

  /**
   * Close LUKS devices for a pool using specific slot numbers
   * @param {string[]} devices - Array of original device paths
   * @param {string} poolName - Pool name
   * @param {number[]} slots - Array of slot numbers corresponding to devices
   * @param {boolean} isParity - Whether these are parity devices (uses different naming)
   * @private
   */
  async _closeLuksDevicesWithSlots(devices, poolName, slots, isParity = false) {
    for (let i = 0; i < devices.length; i++) {
      const slot = slots[i];

      // Use slot-based naming scheme
      let luksName;
      if (isParity) {
        luksName = `parity_${poolName}_${slot}`;
      } else {
        luksName = `${poolName}_${slot}`;
      }

      const partitionName = `${luksName}p1`;

      // Try to close partition first
      try {
        await execPromise(`cryptsetup luksClose ${partitionName}`);
        console.log(`Closed LUKS partition: ${partitionName}`);
      } catch (error) {
        console.warn(`Warning: Could not close LUKS partition ${partitionName}: ${error.message}`);
      }

      // Then close main device
      try {
        await execPromise(`cryptsetup luksClose ${luksName}`);
        console.log(`Closed LUKS device: ${luksName}`);
      } catch (error) {
        console.warn(`Warning: Could not close LUKS device ${luksName}: ${error.message}`);
        // Try dmsetup as fallback
        try {
          await execPromise(`dmsetup remove ${luksName}`);
          console.log(`Force removed LUKS device using dmsetup: ${luksName}`);
        } catch (dmError) {
          console.warn(`Warning: Could not force remove LUKS device ${luksName}: ${dmError.message}`);
        }
      }
    }
  }

  /**
   * Get underlying physical device from mapper device (for LUKS)
   * @param {string} mapperDevice - Mapper device path (e.g. /dev/mapper/luks-xxx)
   * @returns {Promise<string|null>} Physical device path or null
   * @private
   */
  async _getPhysicalDeviceFromMapper(mapperDevice) {
    try {
      const mapperName = mapperDevice.replace('/dev/mapper/', '');
      const { stdout } = await execPromise(`cryptsetup status ${mapperName} 2>/dev/null || echo ""`);

      if (!stdout.trim()) {
        return null;
      }

      // Parse output for device line (e.g. "device: /dev/sda1")
      const deviceMatch = stdout.match(/device:\s+(.+)/);
      if (deviceMatch) {
        return deviceMatch[1].trim();
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Enrich device information with disk type details (without waking up disks)
   */
  async _enrichDeviceWithDiskTypeInfo(device) {
    try {
      // Lazy import to avoid circular dependency
      // Note: disks.service exports an instance
      const disksService = require('./disks.service');

      // Extract device path, handle both string and object inputs
      let devicePath;
      if (typeof device === 'string') {
        devicePath = device;
      } else if (device && typeof device.device === 'string') {
        devicePath = device.device;
      } else if (device && device.id) {
        // For BTRFS multi-device pools, device path might not be set yet, but we have UUID
        // Try to resolve device path from UUID
        try {
          devicePath = await this.getRealDevicePathFromUuid(device.id);
        } catch (error) {
          // Could not resolve UUID, return unknown
          return {
            ...device,
            diskType: {
              type: 'unknown',
              rotational: null,
              removable: null,
              usbInfo: null
            }
          };
        }
      } else {
        // Invalid device format, return unknown
        return {
          ...device,
          diskType: {
            type: 'unknown',
            rotational: null,
            removable: null,
            usbInfo: null
          }
        };
      }

      // Check if this is a mapper device (LUKS encrypted)
      let physicalDevice = devicePath;
      if (devicePath.startsWith('/dev/mapper/')) {
        const underlying = await this._getPhysicalDeviceFromMapper(devicePath);
        if (underlying) {
          physicalDevice = underlying;
        }
      }

      // Convert partition to base disk (e.g. /dev/sdj1 -> /dev/sdj)
      const baseDisk = this._getBaseDiskFromPartition(physicalDevice);

      // Only static information is collected - NO hdparm or other disk access!
      const diskTypeInfo = await disksService._getEnhancedDiskTypeForPools(baseDisk);

      return {
        ...device,
        diskType: {
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        }
      };
    } catch (error) {
      // On errors return original device information
      const devicePathForLog = (typeof device === 'string') ? device : (device?.device || 'unknown');
      console.warn(`Warning: Could not enrich device ${devicePathForLog} with disk type info: ${error.message}`);
      return {
        ...device,
        diskType: {
          type: 'unknown',
          rotational: null,
          removable: null,
          usbInfo: null
        }
      };
    }
  }

  /**
   * Get df data and create UUID to storage mapping
   */
  async _getDfData() {
    try {
      // Exclude remote filesystems (cifs/nfs) to avoid hanging on unavailable shares
      const { stdout } = await execPromise('df -B1 -x cifs -x nfs');
      const lines = stdout.trim().split('\n').slice(1); // Skip header
      const dfData = {};

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const [filesystem, totalSpace, usedSpace, freeSpace, , mountPoint] = parts;

          dfData[mountPoint] = {
            filesystem,
            totalSpace: parseInt(totalSpace),
            usedSpace: parseInt(usedSpace),
            freeSpace: parseInt(freeSpace),
            usagePercent: Math.round((parseInt(usedSpace) / parseInt(totalSpace)) * 100)
          };
        }
      }

      return dfData;
    } catch (error) {
      console.warn(`Warning: Could not get df data: ${error.message}`);
      return {};
    }
  }

  /**
   * Convert bytes to human readable format
   */
  _bytesToHuman(bytes) {
    if (!bytes || bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
  }

  /**
   * Generate expected mount point for a device based on pool type
   */
  _generateExpectedMountPoint(pool, device, deviceType = 'data') {
    switch(pool.type) {
      case 'mergerfs':
        if (deviceType === 'parity') {
          return `/var/snapraid/${pool.name}/parity${device.slot}`;
        }
        return `/var/mergerfs/${pool.name}/disk${device.slot}`;

      case 'btrfs':
      case 'ext4':
      case 'xfs':
      default:
        return `/mnt/${pool.name}`;
    }
  }

  /**
   * Filter out system devices (root disk, boot partitions, etc.) from device list
   */
  async _filterSystemDevices(devices, configuredDevices = []) {
    const systemDevices = new Set();

    try {
      // Get root filesystem device
      const { stdout: rootDevice } = await execPromise(`df / | tail -1 | awk '{print $1}'`);
      if (rootDevice.trim()) {
        const baseRootDevice = rootDevice.trim().replace(/\d+$/, '').replace(/p\d+$/, '');
        systemDevices.add(baseRootDevice);
      }

      // Get boot filesystem device
      const { stdout: bootDevice } = await execPromise(`df /boot 2>/dev/null | tail -1 | awk '{print $1}' || echo ""`);
      if (bootDevice.trim()) {
        const baseBootDevice = bootDevice.trim().replace(/\d+$/, '').replace(/p\d+$/, '');
        systemDevices.add(baseBootDevice);
      }
    } catch (error) {
      console.warn(`Could not detect system devices: ${error.message}`);
    }

    return devices.filter(dev => {
      // Skip if it's a system device or partition of system device
      const baseDevice = dev.replace(/\d+$/, '').replace(/p\d+$/, '');
      if (systemDevices.has(baseDevice) || systemDevices.has(dev)) {
        return false;
      }

      // Skip if it's a partition of an already configured device
      return !configuredDevices.some(configured => {
        const configuredBase = configured.replace(/\d+$/, '').replace(/p\d+$/, '');
        return dev.startsWith(configuredBase) && dev !== configured;
      });
    });
  }

  /**
   * Inject device paths dynamically by resolving UUIDs (for internal operations)
   * @param {Object} pool - Pool object
   * @private
   */
  async _injectDevicePaths(pool) {
    // Inject UUID-based device paths into data devices (for internal operations)
    for (const device of pool.data_devices || []) {
      if (device.id && !device.device) {
        device.device = await this.getDevicePathFromUuid(device.id);
      }
    }

    // Inject UUID-based device paths into parity devices (for internal operations)
    for (const device of pool.parity_devices || []) {
      if (device.id && !device.device) {
        device.device = await this.getDevicePathFromUuid(device.id);
      }
    }
  }

  /**
   * Inject real device paths into pool devices (for API display)
   * @param {Object} pool - Pool object
   * @private
   */
  async _injectRealDevicePaths(pool) {
    // Skip UUID-based device path injection for non-encrypted multi-device BTRFS pools
    // They will get their device paths from btrfs filesystem show in _injectStorageInfoIntoDevices
    // But encrypted pools need UUID-based device path injection
    if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1 && !pool.config?.encrypted) {
      return;
    }

    // Inject real device paths into data devices (for API display)
    for (const device of pool.data_devices || []) {
      if (device.id) {
        device.device = await this.getRealDevicePathFromUuid(device.id);
      }
    }

    // Inject real device paths into parity devices (for API display)
    for (const device of pool.parity_devices || []) {
      if (device.id) {
        device.device = await this.getRealDevicePathFromUuid(device.id);
      }
    }
  }

  /**
   * Ensure pool has device paths injected
   * @param {Object} pool - Pool object
   * @private
   */
  async _ensureDevicePaths(pool) {
    // Check if device paths are already injected
    const needsInjection = (pool.data_devices && pool.data_devices.some(d => d.id && !d.device)) ||
                          (pool.parity_devices && pool.parity_devices.some(d => d.id && !d.device));

    if (needsInjection) {
      await this._injectDevicePaths(pool);
    }
  }

  /**
   * Inject storage information directly into pool devices (no disk access)
   * @param {Object} pool - Pool object
   * @param {Object} user - User object with byte_format preference
   */
  async _injectStorageInfoIntoDevices(pool, user = null) {
    const dfData = await this._getDfData();

    // For non-encrypted BTRFS multi-device pools, get all physical devices from btrfs filesystem show
    let btrfsDevices = [];
    if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1 && !pool.config?.encrypted) {
      try {
        const mountPoint = this._generateExpectedMountPoint(pool, pool.data_devices[0], 'data');

        // Use the new method to get device paths for multi-device BTRFS pools only
        btrfsDevices = await this.getBtrfsDevicePaths(mountPoint);

        // Update the pool's device paths for display
        if (btrfsDevices.length > 0) {
          for (let i = 0; i < Math.min(pool.data_devices.length, btrfsDevices.length); i++) {
            if (pool.data_devices[i]) {
              // For multi-device BTRFS pools, use device paths from btrfs filesystem show
              pool.data_devices[i].device = btrfsDevices[i];
            }
          }
          // Device paths updated for multi-device BTRFS pool
        }
      } catch (error) {
        console.warn(`Could not get BTRFS device list for pool ${pool.name}: ${error.message}`);
      }
    }

    // Inject storage info into data devices
    for (const device of pool.data_devices || []) {
      const expectedMountPoint = this._generateExpectedMountPoint(pool, device, 'data');
      const storageData = dfData[expectedMountPoint];

      if (storageData) {
        device.storage = {
          totalSpace: storageData.totalSpace,
          totalSpace_human: this.formatBytes(storageData.totalSpace, user),
          usedSpace: storageData.usedSpace,
          usedSpace_human: this.formatBytes(storageData.usedSpace, user),
          freeSpace: storageData.freeSpace,
          freeSpace_human: this.formatBytes(storageData.freeSpace, user),
          usagePercent: storageData.usagePercent
        };
        device.mountPoint = expectedMountPoint;
        device.storageStatus = 'mounted';
      } else {
        device.storage = null;
        device.mountPoint = expectedMountPoint;
        device.storageStatus = 'unmounted_or_not_found';
      }

      // For BTRFS pools, mark as shared storage since all devices share the same filesystem
      device.isSharedStorage = pool.type === 'btrfs';
    }

    // For BTRFS pools, inject missing devices that are part of the filesystem but not in config
    // Skip this for encrypted pools as LUKS mapped devices should not be injected
    if (pool.type === 'btrfs' && btrfsDevices.length > 0 && !pool.config?.encrypted) {
      const configuredDevices = pool.data_devices.map(d => d.device);
      let missingDevices = btrfsDevices.filter(dev => !configuredDevices.includes(dev));

      // Filter out root disk and system partitions
      missingDevices = await this._filterSystemDevices(missingDevices, configuredDevices);

      for (const missingDevice of missingDevices) {
        try {
          const deviceUuid = await this.getDeviceUuid(missingDevice);
          const deviceInfo = await this.checkDeviceFilesystem(missingDevice);

          const injectedDevice = {
            slot: (pool.data_devices.length + missingDevices.indexOf(missingDevice) + 1).toString(),
            id: deviceUuid,
            device: missingDevice,
            filesystem: deviceInfo.filesystem || 'btrfs',
            spindown: null,
            _injected: true, // Mark as dynamically injected
            storage: pool.data_devices[0]?.storage || null, // Share storage info from first device
            mountPoint: this._generateExpectedMountPoint(pool, { device: missingDevice }, 'data'),
            storageStatus: pool.data_devices[0]?.storageStatus || 'mounted',
            isSharedStorage: true
          };

          // Enrich with disk type info
          const enrichedDevice = await this._enrichDeviceWithDiskTypeInfo(injectedDevice);
          pool.data_devices.push(enrichedDevice);
        } catch (error) {
          console.warn(`Could not inject missing BTRFS device ${missingDevice}: ${error.message}`);
        }
      }
    }

    // Inject storage info into parity devices
    for (const device of pool.parity_devices || []) {
      const expectedMountPoint = this._generateExpectedMountPoint(pool, device, 'parity');
      const storageData = dfData[expectedMountPoint];

      if (storageData) {
        device.storage = {
          totalSpace: storageData.totalSpace,
          totalSpace_human: this.formatBytes(storageData.totalSpace, user),
          usedSpace: storageData.usedSpace,
          usedSpace_human: this.formatBytes(storageData.usedSpace, user),
          freeSpace: storageData.freeSpace,
          freeSpace_human: this.formatBytes(storageData.freeSpace, user),
          usagePercent: storageData.usagePercent
        };
        device.mountPoint = expectedMountPoint;
        device.storageStatus = 'mounted';
      } else {
        device.storage = null;
        device.mountPoint = expectedMountPoint;
        device.storageStatus = 'unmounted_or_not_found';
      }

      device.isSharedStorage = false; // Parity devices are always individual
    }
  }

  /**
   * List all pools with optional filtering
   * @param {Object} filters - Optional filters to apply
   * @param {string} filters.type - Filter by pool type (e.g., 'mergerfs', 'btrfs', 'xfs')
   * @param {string} filters.exclude_type - Exclude pools of specific type (e.g., 'mergerfs')
   * @param {Object} user - User object with byte_format preference
   */
  async listPools(filters = {}, user = null) {
    try {
      let pools = await this._readPools();

      // Apply type filtering if specified
      if (filters.type) {
        pools = pools.filter(pool => {
          // Check pool.type first, then fallback to checking filesystem type of first data device
          const poolType = pool.type || (pool.data_devices?.[0]?.filesystem);
          return poolType === filters.type;
        });
      }

      // Apply type exclusion if specified
      if (filters.exclude_type) {
        pools = pools.filter(pool => {
          // Check pool.type first, then fallback to checking filesystem type of first data device
          const poolType = pool.type || (pool.data_devices?.[0]?.filesystem);
          return poolType !== filters.exclude_type;
        });
      }

      // For each pool, update its mounted status and space info
      for (const pool of pools) {
        // Inject real device paths for API display
        await this._injectRealDevicePaths(pool);

        // Enrich device information with disk type details
        if (pool.data_devices && pool.data_devices.length > 0) {
          for (let i = 0; i < pool.data_devices.length; i++) {
            pool.data_devices[i] = await this._enrichDeviceWithDiskTypeInfo(pool.data_devices[i]);
          }
        }

        if (pool.parity_devices && pool.parity_devices.length > 0) {
          for (let i = 0; i < pool.parity_devices.length; i++) {
            pool.parity_devices[i] = await this._enrichDeviceWithDiskTypeInfo(pool.parity_devices[i]);
          }
        }

        // Update mount status and space info
        if (pool.data_devices && pool.data_devices.length > 0) {
          const mountPoint = path.join(this.mountBasePath, pool.name);
          const spaceInfo = await this.getDeviceSpace(mountPoint, user);
          pool.status = spaceInfo;
        }

        // Inject storage information directly into device objects
        await this._injectStorageInfoIntoDevices(pool, user);

        // Inject power status into individual device objects
        await this._injectPowerStatusIntoDevices(pool);

        // Inject disk information into individual device objects
        await this._injectDiskInfoIntoDevices(pool);

        // Inject parity operation status (API-only, not persisted)
        await this._injectParityOperationStatus(pool);
      }

      // Note: We don't write back to pools.json for read-only operations
      // The status and storage info are dynamic and should not be persisted

      return pools;
    } catch (error) {
      throw new Error(`Error listing pools: ${error.message}`);
    }
  }

  /**
   * Get a pool by ID
   * @param {string} poolId - Pool ID
   * @param {Object} user - User object with byte_format preference
   */
  async getPoolById(poolId, user = null) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Inject real device paths for API display
      await this._injectRealDevicePaths(pool);

      // Enrich device information with disk type details
      if (pool.data_devices && pool.data_devices.length > 0) {
        for (let i = 0; i < pool.data_devices.length; i++) {
          pool.data_devices[i] = await this._enrichDeviceWithDiskTypeInfo(pool.data_devices[i]);
        }
      }

      if (pool.parity_devices && pool.parity_devices.length > 0) {
        for (let i = 0; i < pool.parity_devices.length; i++) {
          pool.parity_devices[i] = await this._enrichDeviceWithDiskTypeInfo(pool.parity_devices[i]);
        }
      }

      // Update pool status
      if (pool.data_devices && pool.data_devices.length > 0) {
        const mountPoint = path.join(this.mountBasePath, pool.name);
        const spaceInfo = await this.getDeviceSpace(mountPoint, user);
        pool.status = spaceInfo;

        // Inject storage information directly into device objects
        await this._injectStorageInfoIntoDevices(pool, user);

        // Inject power status into individual device objects
        await this._injectPowerStatusIntoDevices(pool);

        // Inject disk information into individual device objects
        await this._injectDiskInfoIntoDevices(pool);

        // Inject parity operation status (API-only, not persisted)
        await this._injectParityOperationStatus(pool);
      }

      return pool;
    } catch (error) {
      throw new Error(`Error getting pool: ${error.message}`);
    }
  }

  /**
   * Toggle automount for a pool
   */
  async toggleAutomountById(poolId, automount) {
    try {
      if (typeof automount !== 'boolean') {
        throw new Error('Automount value must be a boolean');
      }

      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Update automount setting
      pools[poolIndex].automount = automount;
      await this._writePools(pools);

      return {
        success: true,
        message: `Automount ${automount ? 'enabled' : 'disabled'} for pool "${pools[poolIndex].name}" (ID: ${poolId})`,
        pool: pools[poolIndex]
      };
    } catch (error) {
      throw new Error(`Error toggling automount: ${error.message}`);
    }
  }

  /**
   * Update a pool's comment
   */
  async updatePoolComment(poolId, comment) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Update comment
      pools[poolIndex].comment = comment || "";
      await this._writePools(pools);

      return {
        success: true,
        message: `Comment updated for pool "${pools[poolIndex].name}" (ID: ${poolId})`,
        pool: pools[poolIndex]
      };
    } catch (error) {
      throw new Error(`Error updating pool comment: ${error.message}`);
    }
  }

  /**
   * Update the order of all pools
   * @param {Array} order - Array of objects with {id, index}
   * @returns {Object} Result object with success status
   */
  async updatePoolsOrder(order) {
    try {
      if (!Array.isArray(order)) {
        throw new Error('Order must be an array');
      }

      const pools = await this._readPools();

      // Validate all pool IDs exist
      for (const item of order) {
        if (!item.id || typeof item.index !== 'number') {
          throw new Error('Each order item must have id and index properties');
        }

        const pool = pools.find(p => p.id === item.id);
        if (!pool) {
          throw new Error(`Pool with ID "${item.id}" not found`);
        }
      }

      // Update indices
      for (const item of order) {
        const pool = pools.find(p => p.id === item.id);
        if (pool) {
          pool.index = item.index;
        }
      }

      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully updated order for ${order.length} pool(s)`,
        updatedCount: order.length
      };
    } catch (error) {
      throw new Error(`Error updating pools order: ${error.message}`);
    }
  }

  /**
   * Remove parity devices from a MergerFS pool
   * @param {string} poolId - Pool ID
   * @param {string[]} parityDevices - Array of parity device paths to remove
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Result object
   */
  async removeParityDevicesFromPool(poolId, parityDevices, options = {}) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];

      if (pool.type !== 'mergerfs') {
        throw new Error('Only MergerFS pools support parity devices');
      }

      // Ensure device paths are injected from UUIDs
      await this._ensureDevicePaths(pool);

      // Remove specified parity devices
      const originalParityCount = pool.parity_devices.length;
      pool.parity_devices = pool.parity_devices.filter(
        device => !parityDevices.includes(device.device)
      );

      const removedCount = originalParityCount - pool.parity_devices.length;

      // If no parity devices left, clean up SnapRAID config and sync settings
      if (pool.parity_devices.length === 0) {
        // Remove SnapRAID configuration from pool config
        if (pool.config && pool.config.sync) {
          delete pool.config.sync;
        }

        // Clean up SnapRAID configuration file
        await this.cleanupSnapRAIDConfig(pool.name);

        console.log(`All parity devices removed from pool "${pool.name}". SnapRAID configuration cleaned up.`);
      } else {
        // Update SnapRAID configuration with remaining devices
        await this.updateSnapRAIDConfig(pool);
      }

      // Save updated pool configuration
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully removed ${removedCount} parity device(s) from pool "${pool.name}"${pool.parity_devices.length === 0 ? '. SnapRAID configuration removed.' : ''}`,
        pool,
        snapraidDisabled: pool.parity_devices.length === 0
      };
    } catch (error) {
      throw new Error(`Error removing parity devices: ${error.message}`);
    }
  }

  /**
   * Remove data devices from existing pools (supports both BTRFS and MergerFS)
   * @param {string} poolId - Pool ID
   * @param {string[]} devices - Array of device paths to remove
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Result object
   */
  async removeDevicesFromPool(poolId, devices, options = {}) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];

      // Ensure device paths are injected from UUIDs
      await this._ensureDevicePaths(pool);

      // Handle different pool types
      if (pool.type === 'mergerfs') {
        return this._removeDevicesFromMergerFSPool(pool, devices, options, pools, poolIndex);
      } else if (pool.type === 'btrfs' || pool.type === 'ext4' || pool.type === 'xfs') {
        return this._removeDevicesFromBTRFSPool(pool, devices, options, pools, poolIndex);
      } else {
        throw new Error(`Removing devices from ${pool.type} pools is not supported`);
      }
    } catch (error) {
      throw new Error(`Error removing devices: ${error.message}`);
    }
  }

  /**
   * Remove devices from MergerFS pool
   * @private
   */
  async _removeDevicesFromMergerFSPool(pool, devices, options, pools, poolIndex) {
    const { unmount = true } = options;

    // Check if all devices to remove are actually in the pool
    const existingDevices = pool.data_devices.map(d => d.device);
    const devicesToRemove = devices.filter(device => existingDevices.includes(device));

    if (devicesToRemove.length === 0) {
      throw new Error(`None of the specified devices are part of pool ${pool.name}`);
    }

    if (devicesToRemove.length < devices.length) {
      console.warn(`Warning: Some devices are not part of the pool and will be ignored`);
    }

    // Prevent removing all devices from the pool
    if (devicesToRemove.length >= existingDevices.length) {
      throw new Error(`Cannot remove all devices from the pool. At least one device must remain.`);
    }

    // Get the mount points of the devices to remove for unmounting
    const baseDir = `/var/mergerfs/${pool.name}`;
    const deviceMountPoints = {};

    for (const device of devicesToRemove) {
      const deviceInfo = pool.data_devices.find(d => d.device === device);
      if (deviceInfo) {
        const mountPoint = path.join(baseDir, `disk${deviceInfo.slot}`);
        deviceMountPoints[device] = mountPoint;
      }
    }

    // Unmount the MergerFS pool first if it's mounted
    const mainMountPoint = path.join(this.mountBasePath, pool.name);
    const wasPoolMounted = await this._isMounted(mainMountPoint);
    if (wasPoolMounted) {
      await this.unmountDevice(mainMountPoint);
    }

    // Close LUKS devices for removed devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for removed devices from MergerFS pool '${pool.name}'`);

      // Find original physical devices for the removed mapped devices
      const physicalDevicesToClose = [];
      for (const removedDevice of devicesToRemove) {
        if (pool.devices) {
          // Find the index of this device in data_devices to get corresponding physical device
          const deviceIndex = pool.data_devices.findIndex(d => d.device === removedDevice);
          if (deviceIndex !== -1 && pool.devices[deviceIndex]) {
            physicalDevicesToClose.push(pool.devices[deviceIndex]);
          }
        }
      }

      if (physicalDevicesToClose.length > 0) {
        await this._closeLuksDevices(physicalDevicesToClose, pool.name);

        // Remove physical devices from pool.devices array
        if (pool.devices) {
          pool.devices = pool.devices.filter(device => !physicalDevicesToClose.includes(device));
        }
      }
    }

    // Remove devices from the pool data_devices array
    pool.data_devices = pool.data_devices.filter(d => !devicesToRemove.includes(d.device));

    // Unmount the removed devices if requested
    if (unmount) {
      for (const device of devicesToRemove) {
        const mountPoint = deviceMountPoints[device];
        if (mountPoint) {
          try {
            await this.unmountDevice(mountPoint);
            console.log(`Unmounted device ${device} from ${mountPoint}`);
          } catch (error) {
            console.warn(`Warning: Could not unmount ${device}: ${error.message}`);
          }
        }
      }
    }

    // Remount the MergerFS pool with remaining devices if it was mounted before
    if (wasPoolMounted) {
      try {
        const mountPoints = pool.data_devices.map((_, index) =>
          path.join(baseDir, `disk${pool.data_devices[index].slot}`)
        ).join(':');
        const mergerfsOptions = pool.config.global_options ?
          pool.config.global_options.join(',') :
          'defaults,allow_other,use_ino,cache.files=partial,dropcacheonclose=true,category.create=mfs';

        await execPromise(`mergerfs -o ${mergerfsOptions} ${mountPoints} ${mainMountPoint}`);
      } catch (error) {
        console.warn(`Warning: Could not remount MergerFS pool: ${error.message}`);
      }
    }

    // Update SnapRAID configuration if applicable
    if (pool.parity_devices && pool.parity_devices.length > 0) {
      await this.updateSnapRAIDConfig(pool);
    }

    // Save updated pool configuration
    await this._writePools(pools);

    return {
      success: true,
      message: `Successfully removed ${devicesToRemove.length} device(s) from pool '${pool.name}'`,
      pool
    };
  }

  /**
   * Remove devices from BTRFS pool
   * @private
   */
  async _removeDevicesFromBTRFSPool(pool, devices, options, pools, poolIndex) {
    // Check if pool is mounted
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const isMounted = await this._isMounted(mountPoint);
    if (!isMounted) {
      throw new Error(`Pool ${pool.name} must be mounted to remove devices`);
    }

    // Check if all devices to remove are actually in the pool
    const existingDevices = pool.data_devices.map(d => d.device);
    const devicesToRemove = devices.filter(device => existingDevices.includes(device));

    if (devicesToRemove.length === 0) {
      throw new Error(`None of the specified devices are part of pool ${pool.name}`);
    }

    // Prevent removing all devices from the pool
    if (devicesToRemove.length >= existingDevices.length) {
      throw new Error(`Cannot remove all devices from the pool. At least one device must remain.`);
    }

    // Remove each device from the BTRFS volume
    for (const device of devicesToRemove) {
      try {
        await execPromise(`btrfs device remove ${device} ${mountPoint}`);
        console.log(`Removed device ${device} from BTRFS pool ${pool.name}`);
      } catch (error) {
        throw new Error(`Failed to remove device ${device} from BTRFS pool: ${error.message}`);
      }
    }

    // Close LUKS devices for removed devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for removed devices from pool '${pool.name}'`);

      // Find original physical devices for the removed mapped devices
      const physicalDevicesToClose = [];
      for (const removedDevice of devicesToRemove) {
        if (pool.devices) {
          // Find the index of this device in data_devices to get corresponding physical device
          const deviceIndex = pool.data_devices.findIndex(d => d.device === removedDevice);
          if (deviceIndex !== -1 && pool.devices[deviceIndex]) {
            physicalDevicesToClose.push(pool.devices[deviceIndex]);
          }
        }
      }

      if (physicalDevicesToClose.length > 0) {
        await this._closeLuksDevices(physicalDevicesToClose, pool.name);

        // Remove physical devices from pool.devices array
        if (pool.devices) {
          pool.devices = pool.devices.filter(device => !physicalDevicesToClose.includes(device));
        }
      }
    }

    // Update the pool data structure
    pool.data_devices = pool.data_devices.filter(d => !devicesToRemove.includes(d.device));

    // Don't persist dynamic status info to pools.json
    // Status will be calculated dynamically when pools are retrieved

    // Save updated pool configuration (without status)
    await this._writePools(pools);

    return {
      success: true,
      message: `Successfully removed ${devicesToRemove.length} device(s) from BTRFS pool '${pool.name}'`,
      pool
    };
  }

  /**
   * Replace a device in a pool (remove old, add new)
   * @param {string} poolId - Pool ID
   * @param {string} oldDevice - Device path to replace
   * @param {string} newDevice - New device path
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Result object
   */
  async replaceDeviceInPool(poolId, oldDevice, newDevice, options = {}) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Ensure device paths are injected from UUIDs
      await this._ensureDevicePaths(pool);

      // Check if old device exists in pool
      const oldDeviceExists = pool.data_devices.some(d => d.device === oldDevice);
      if (!oldDeviceExists) {
        throw new Error(`Device ${oldDevice} is not part of pool ${pool.name}`);
      }

      // Check if new device exists
      await fs.access(newDevice).catch(() => {
        throw new Error(`New device ${newDevice} does not exist`);
      });

      // Check if new device is already mounted
      const newDeviceMountStatus = await this._isDeviceMounted(newDevice);
      if (newDeviceMountStatus.isMounted) {
        throw new Error(`New device ${newDevice} is already mounted at ${newDeviceMountStatus.mountPoint}. Please unmount it first before replacing.`);
      }

      // Handle different pool types
      if (pool.type === 'btrfs') {
        return this._replaceBTRFSDevice(pool, oldDevice, newDevice, options);
      } else if (pool.type === 'mergerfs') {
        // For MergerFS, we do remove + add
        await this.removeDevicesFromPool(poolId, [oldDevice], { unmount: true });
        const result = await this.addDevicesToPool(poolId, [newDevice], options);

        return {
          success: true,
          message: `Successfully replaced device ${oldDevice} with ${newDevice} in pool '${pool.name}'`,
          pool: result.pool
        };
      } else {
        throw new Error(`Device replacement for ${pool.type} pools is not supported`);
      }
    } catch (error) {
      throw new Error(`Error replacing device: ${error.message}`);
    }
  }

  /**
   * Replace BTRFS device
   * @private
   */
  async _replaceBTRFSDevice(pool, oldDevice, newDevice, options) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const isMounted = await this._isMounted(mountPoint);

    if (!isMounted) {
      throw new Error(`Pool ${pool.name} must be mounted to replace devices`);
    }

    // Handle LUKS encryption for new device if pool is encrypted
    let actualNewDevice = newDevice;
    let luksDevice = null;

    if (pool.config?.encrypted) {
      console.log(`Setting up LUKS encryption for replacement device in pool '${pool.name}'`);

      // Setup LUKS encryption on new device
      await this._setupPoolEncryption([newDevice], pool.name, options.passphrase, false);

      // Open LUKS device
      const luksDevices = await this._openLuksDevices([newDevice], pool.name, options.passphrase);
      actualNewDevice = luksDevices[0].mappedDevice;
      luksDevice = luksDevices[0];

      console.log(`LUKS device opened for replacement: ${actualNewDevice}`);
    }

    try {
      // BTRFS replace command (use actual device - mapped for LUKS)
      await execPromise(`btrfs replace start ${oldDevice} ${actualNewDevice} ${mountPoint}`);

      // Wait for replace to complete (this could take a while)
      let replaceStatus;
      do {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        try {
          const { stdout } = await execPromise(`btrfs replace status ${mountPoint}`);
          replaceStatus = stdout;
        } catch (error) {
          // Replace might be finished
          break;
        }
      } while (replaceStatus && !replaceStatus.includes('finished'));

      // Get new device UUID (from physical device for encrypted pools)
      let newDeviceUuid;
      if (pool.config?.encrypted) {
        newDeviceUuid = await this.getDeviceUuid(newDevice); // Physical device UUID
      } else {
        newDeviceUuid = await this.getDeviceUuid(actualNewDevice);
      }

      // Update pool data structure
      const deviceIndex = pool.data_devices.findIndex(d => d.device === oldDevice);
      if (deviceIndex !== -1) {
        pool.data_devices[deviceIndex].device = actualNewDevice; // Store mapped device for encrypted pools
        pool.data_devices[deviceIndex].id = newDeviceUuid;

        // Update physical devices array for encrypted pools
        if (pool.config?.encrypted && pool.devices) {
          pool.devices[deviceIndex] = newDevice; // Store physical device
        }
      }

      // Don't persist dynamic status info to pools.json
      // Status will be calculated dynamically when pools are retrieved

      // Save updated pool configuration (without status)
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === pool.id);
      if (poolIndex !== -1) {
        pools[poolIndex] = pool;
        await this._writePools(pools);
      }

      return {
        success: true,
        message: `Successfully replaced device ${oldDevice} with ${newDevice} in BTRFS pool '${pool.name}'`,
        pool
      };
    } catch (error) {
      throw new Error(`BTRFS device replacement failed: ${error.message}`);
    }
  }

  /**
   * Create a MergerFS pool with optional SnapRAID support
   * @param {string} name - Pool name
   * @param {string[]} devices - Array of device paths for data
   * @param {string} filesystem - Filesystem to use for formatting (if needed)
   * @param {Object} options - Additional options including snapraid device
   */
  async createMergerFSPool(name, devices, filesystem = 'xfs', options = {}) {
    let luksDevices = null;
    let encryptionEnabled = false;

    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');
      if (!Array.isArray(devices) || devices.length === 0) {
        throw new Error('At least one data device is required for a MergerFS pool');
      }

      // MergerFS requires at least one device
      if (devices.length < 1) {
        throw new Error('At least one device is required for a MergerFS pool');
      }

      // Validate encryption parameters
      if (options.config?.encrypted) {
        if (!options.passphrase || options.passphrase.trim() === '') {
          if (options.config?.create_keyfile) {
            // Generate secure random passphrase if keyfile creation is requested
            options.passphrase = this._generateSecurePassphrase();
            console.log(`Generated secure passphrase for encrypted pool '${name}' (will be stored in keyfile)`);
          } else {
            throw new Error('Passphrase is required for encrypted pools');
          }
        }
        if (options.passphrase.length < 8) {
          throw new Error('Passphrase must be at least 8 characters long for LUKS encryption');
        }
      }

      // Read current pools data
      const pools = await this._readPools();

      // Check if pool with the same name already exists
      const existingPoolIndex = pools.findIndex(p => p.name === name);
      if (existingPoolIndex !== -1) {
        throw new Error(`Pool with name "${name}" already exists`);
      }

      const mountPoint = path.join(this.mountBasePath, name);
      const mergerfsBasePath = path.join(this.mergerfsBasePath, name);

      // Prepare devices
      console.log('Preparing devices...');
      const preparedDevices = [];

      if (options.format === true) {
        // format=true: Create partitions and format
        for (const device of devices) {
          const preparedDevice = await this._ensurePartition(device);
          preparedDevices.push(preparedDevice);
        }
      } else {
        // format=false: Import mode - use existing filesystems as-is
        for (const device of devices) {
          const isPartition = this._isPartitionPath(device);
          if (!isPartition) {
            // Whole disk - check what's on it
            const deviceInfo = await this.checkDeviceFilesystem(device);
            if (deviceInfo.actualDevice) {
              // Has partition with filesystem - use the partition
              preparedDevices.push(deviceInfo.actualDevice);
            } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
              // Whole disk has filesystem directly (no partition) - use whole disk
              preparedDevices.push(device);
            } else {
              // No usable filesystem found
              throw new Error(`Device ${device} has no usable filesystem. Use format: true to create partition and format.`);
            }
          } else {
            // Already a partition - use as-is
            preparedDevices.push(device);
          }
        }
      }

      // Validate filesystems BEFORE encryption (for format=false)
      let hasLuksDevices = false;
      let actualDevices = [...preparedDevices]; // Initialize with prepared devices
      let luksDevices = null;
      let encryptionEnabled = false;

      if (options.format === false) {
        // Check if any device is already LUKS encrypted (only for format=false)
        const luksDeviceIndices = [];
        for (let i = 0; i < preparedDevices.length; i++) {
          const deviceInfo = await this.checkDeviceFilesystem(preparedDevices[i]);
          if (deviceInfo.isFormatted && deviceInfo.filesystem === 'crypto_LUKS') {
            luksDeviceIndices.push(i);
          }
        }

        hasLuksDevices = luksDeviceIndices.length > 0;

        if (hasLuksDevices && (!options.passphrase || options.passphrase.trim() === '')) {
          throw new Error(`Some devices are LUKS encrypted but no passphrase provided. Please provide a passphrase to unlock the devices.`);
        }

        for (let i = 0; i < devices.length; i++) {
          const preparedDevice = preparedDevices[i];

          // Check if device is already mounted
          const mountStatus = await this._isDeviceMounted(preparedDevice);
          if (mountStatus.isMounted) {
            throw new Error(`Device ${preparedDevice} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before creating a pool.`);
          }

          // Validate filesystem
          const deviceInfo = await this.checkDeviceFilesystem(preparedDevice);

          if (deviceInfo.isFormatted && deviceInfo.filesystem === 'crypto_LUKS') {
            // Device is LUKS - need to open it to check filesystem inside
            console.log(`Device ${preparedDevice} is LUKS encrypted, opening to check filesystem...`);

            await this._cleanupExistingLuksMappers(name);
            let luksDevicesList;
            try {
              luksDevicesList = await this._openLuksDevicesWithSlots([preparedDevice], name, [i + 1], options.passphrase);
            } catch (error) {
              throw new Error(`Failed to open LUKS device ${preparedDevice}: ${error.message}. Please check your passphrase or keyfile.`);
            }

            const luksDevice = luksDevicesList[0].mappedDevice;
            const luksFilesystemInfo = await this.checkDeviceFilesystem(luksDevice);

            if (!luksFilesystemInfo.isFormatted) {
              throw new Error(`LUKS container ${luksDevice} has no filesystem. Use format: true to format.`);
            }
            if (luksFilesystemInfo.filesystem !== filesystem) {
              throw new Error(`LUKS container has filesystem ${luksFilesystemInfo.filesystem}, but ${filesystem} was requested. Use format: true to reformat.`);
            }

            console.log(`LUKS device ${preparedDevice} contains ${filesystem} - will be used as-is`);
            // Replace with LUKS device for mounting
            actualDevices[i] = luksDevice;
            encryptionEnabled = true;
          } else if (!deviceInfo.isFormatted) {
            throw new Error(`Device ${preparedDevice} has no filesystem. Use format: true to create partition and format.`);
          } else if (deviceInfo.filesystem !== filesystem) {
            throw new Error(`Device ${preparedDevice} has filesystem ${deviceInfo.filesystem}, but ${filesystem} was requested. Use format: true to reformat.`);
          }
        }
      }

      // Handle LUKS encryption for data devices (new encryption)
      if (options.config?.encrypted && !hasLuksDevices) {
        console.log(`Setting up LUKS encryption for MergerFS pool '${name}'`);
        // Clean up any existing LUKS mappers with this pool name first
        await this._cleanupExistingLuksMappers(name);
        await this._setupPoolEncryption(preparedDevices, name, options.passphrase, options.config.create_keyfile);
        // Open data devices with slot-based naming (slots 1, 2, 3...)
        const dataSlots = preparedDevices.map((_, i) => i + 1);
        luksDevices = await this._openLuksDevicesWithSlots(preparedDevices, name, dataSlots, options.passphrase);
        actualDevices = luksDevices.map(d => d.mappedDevice);
        encryptionEnabled = true;
      }

      // Handle SnapRAID device if provided
      let snapraidDevice = null;
      let actualSnapraidDevice = null;
      let snapraidLuksDevice = null;
      let preparedSnapraidDevice = null;
      if (options.snapraid && options.snapraid.device) {
        snapraidDevice = options.snapraid.device;

        // Check if snapraid device is also in the data devices list
        if (devices.includes(snapraidDevice)) {
          throw new Error('SnapRAID parity device cannot also be used as a data device');
        }

        // Verify snapraid device size is larger or equal to the largest data device
        const snapraidSize = await this.getDeviceSize(snapraidDevice);

        // Check all data devices and make sure snapraid device is at least as large as the largest
        let largestDataDevice = 0;
        for (const device of devices) {
          const deviceSize = await this.getDeviceSize(device);
          if (deviceSize > largestDataDevice) {
            largestDataDevice = deviceSize;
          }
        }

        if (snapraidSize < largestDataDevice) {
          throw new Error('SnapRAID parity device must be at least as large as the largest data device');
        }

        // Prepare SnapRAID device
        console.log(`Preparing SnapRAID parity device '${snapraidDevice}'...`);
        if (options.format === true) {
          // format=true: Create partition and format
          preparedSnapraidDevice = await this._ensurePartition(snapraidDevice);
        } else {
          // format=false: Import mode - use existing filesystem as-is
          const isSnapraidPartition = this._isPartitionPath(snapraidDevice);
          if (!isSnapraidPartition) {
            // Whole disk - check what's on it
            const snapraidDeviceInfo = await this.checkDeviceFilesystem(snapraidDevice);
            if (snapraidDeviceInfo.actualDevice) {
              // Has partition with filesystem - use the partition
              preparedSnapraidDevice = snapraidDeviceInfo.actualDevice;
            } else if (snapraidDeviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(snapraidDeviceInfo.filesystem)) {
              // Whole disk has filesystem directly (no partition) - use whole disk
              preparedSnapraidDevice = snapraidDevice;
            } else {
              // No usable filesystem found
              throw new Error(`SnapRAID device ${snapraidDevice} has no usable filesystem. Use format: true to create partition and format.`);
            }
          } else {
            // Already a partition - use as-is
            preparedSnapraidDevice = snapraidDevice;
          }
        }

        // Validate SnapRAID filesystem BEFORE encryption (for format=false)
        if (options.format === false) {
          const snapraidMountStatus = await this._isDeviceMounted(preparedSnapraidDevice);
          if (snapraidMountStatus.isMounted) {
            throw new Error(`SnapRAID device ${preparedSnapraidDevice} is already mounted at ${snapraidMountStatus.mountPoint}. Please unmount it first before creating a pool.`);
          }

          const snapraidInfo = await this.checkDeviceFilesystem(preparedSnapraidDevice);
          if (!snapraidInfo.isFormatted) {
            throw new Error(`SnapRAID device ${preparedSnapraidDevice} has no filesystem. Use format: true to create partition and format.`);
          }
          if (snapraidInfo.filesystem !== filesystem) {
            throw new Error(`SnapRAID device ${preparedSnapraidDevice} has filesystem ${snapraidInfo.filesystem}, but ${filesystem} was requested. Use format: true to reformat.`);
          }
        }

        // Handle LUKS encryption for SnapRAID device if encryption is enabled
        if (encryptionEnabled) {
          console.log(`Setting up LUKS encryption for SnapRAID parity device '${preparedSnapraidDevice}'`);
          // Don't create keyfile again - it was already created for data devices
          await this._setupPoolEncryption([preparedSnapraidDevice], name, options.passphrase, false);
          const parityLuksDevices = await this._openLuksDevicesWithSlots([preparedSnapraidDevice], name, [1], options.passphrase, true);
          snapraidLuksDevice = parityLuksDevices[0];
          actualSnapraidDevice = snapraidLuksDevice.mappedDevice;
        } else {
          actualSnapraidDevice = preparedSnapraidDevice;
        }
      }

      // Format devices if format=true (AFTER encryption setup)
      if (options.format === true) {
        // format=true: Format all devices (partitions already created, encryption already setup)
        for (let i = 0; i < devices.length; i++) {
          const actualDevice = actualDevices[i];

          // Check if device is already mounted
          const mountStatus = await this._isDeviceMounted(actualDevice);
          if (mountStatus.isMounted) {
            throw new Error(`Device ${actualDevice} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before creating a pool.`);
          }

          // Format the device (LUKS device if encrypted, partition if not)
          await this.formatDevice(actualDevice, filesystem);
        }

        // Format SnapRAID device if provided
        if (snapraidDevice && actualSnapraidDevice) {
          const snapraidMountStatus = await this._isDeviceMounted(actualSnapraidDevice);
          if (snapraidMountStatus.isMounted) {
            throw new Error(`SnapRAID device ${actualSnapraidDevice} is already mounted at ${snapraidMountStatus.mountPoint}. Please unmount it first before creating a pool.`);
          }
          await this.formatDevice(actualSnapraidDevice, filesystem);
        }
      }
      // Note: format=false validation already done BEFORE encryption

      // Refresh device symlinks after formatting
      await this._refreshDeviceSymlinks();

      // Create mergerFS base directory with proper ownership
      const ownershipOptions = {
        uid: this.defaultOwnership.uid,
        gid: this.defaultOwnership.gid
      };
      await this._createDirectoryWithOwnership(mergerfsBasePath, ownershipOptions);

      // Create mount points for each device and collect device info
      const dataDevices = [];
      let diskIndex = 1;

      for (let i = 0; i < devices.length; i++) {
        const originalDevice = devices[i];
        const actualDevice = actualDevices[i]; // Use mapped device for LUKS
        const diskMountPoint = path.join(mergerfsBasePath, `disk${diskIndex}`);
        await this._createDirectoryWithOwnership(diskMountPoint, ownershipOptions);

        // Mount the device to its individual mount point
        await this.mountDevice(actualDevice, diskMountPoint);

        // Get device UUID from the prepared device (partition)
        // For LUKS: preparedDevice is the physical partition
        // For non-LUKS: preparedDevice is the partition or whole disk
        const preparedDevice = preparedDevices[i];
        const deviceUuid = await this.getDeviceUuid(preparedDevice);

        dataDevices.push({
          slot: diskIndex.toString(),
          id: deviceUuid,
          filesystem,
          spindown: null
        });

        diskIndex++;
      }

      // Handle snapraid device if provided
      let parityDevices = [];
      let snapraidMountPoint = null;
      if (snapraidDevice) {
        const snapraidPoolPath = path.join(this.snapraidBasePath, name);
        snapraidMountPoint = path.join(snapraidPoolPath, 'parity1');
        await this._createDirectoryWithOwnership(snapraidMountPoint, ownershipOptions);

        // Mount the actual snapraid device (encrypted or not)
        await this.mountDevice(actualSnapraidDevice, snapraidMountPoint, ownershipOptions);

        // Get parity device UUID from the prepared physical device/partition
        let parityUuid;
        parityUuid = await this.getDeviceUuid(preparedSnapraidDevice);

        parityDevices.push({
          slot: "1",
          id: parityUuid,
          filesystem,
          spindown: null
        });
      }

      // Create the main mount point with proper ownership
      await this._createDirectoryWithOwnership(mountPoint, ownershipOptions);

      // Build the mergerfs command
      const mountPoints = dataDevices.map(device => path.join(mergerfsBasePath, `disk${device.slot}`)).join(':');

      // Extract policies from options or use defaults
      const createPolicy = options.policies?.create || 'epmfs';
      const readPolicy = options.policies?.read || 'ff';
      const searchPolicy = options.policies?.search || 'ff';

      // Build MergerFS options with custom policies
      const mergerfsOptions = options.mergerfsOptions ||
        `defaults,allow_other,use_ino,cache.files=partial,dropcacheonclose=true,category.create=${createPolicy}`;

      // Mount the mergerfs pool
      await execPromise(`mergerfs -o ${mergerfsOptions} ${mountPoints} ${mountPoint}`);

      // Create pool configuration for MergerFS with provided policies
      const poolConfig = {
        policies: {
          create: createPolicy,
          read: readPolicy,
          search: searchPolicy
        },
        minfreespace: options.minfreespace || "20G",
        moveonenospc: options.moveonenospc !== undefined ? options.moveonenospc : true,
        category: {
          create: createPolicy
        },
        global_options: options.global_options || [
          "cache.files=off",
          "dropcacheonclose=true",
          `category.search=${searchPolicy}`
        ]
      };

      // Add SnapRAID config if applicable
      if (snapraidDevice) {
        poolConfig.sync = {
          enabled: false,
          schedule: "30 0 * * *",
          check: {
            enabled: false,
            schedule: "0 0 * */3 SUN"
          }
        };
      }

      // Create a pool entry
      const pool = {
        id: generateId(),
        name,
        type: 'mergerfs',
        automount: options.automount !== false,
        comment: options.comment || '',
        index: this._getNextPoolIndex(pools),
        data_devices: dataDevices,
        parity_devices: parityDevices,

        config: {
          ...poolConfig,
          encrypted: encryptionEnabled
        }
      };

      // Store original physical devices array for encrypted pools (needed for size checks, etc.)
      if (encryptionEnabled) {
        pool.devices = preparedDevices;
      }

// Add snapraid info if applicable
if (snapraidDevice) {
    // Create snapraid config directory if it doesn't exist
    const snapraidConfigDir = '/boot/config/snapraid';
    await fs.mkdir(snapraidConfigDir, { recursive: true });

    // Generate snapraid configuration file
    const snapraidConfigPath = path.join(snapraidConfigDir, `${name}.conf`);

    // Build the configuration content
    let snapraidConfig = `# SnapRAID configuration for ${name} pool\n`;
    snapraidConfig += `# Generated by MOS API on ${new Date().toISOString()}\n\n`;

    // Add parity file location
    snapraidConfig += `parity ${snapraidMountPoint}/.snapraid.parity\n`;

    // Add content file locations - one for each data disk and one for parity
    dataDevices.forEach((device, index) => {
      const diskMountPoint = path.join(mergerfsBasePath, `disk${index + 1}`);
      snapraidConfig += `content ${diskMountPoint}/.snapraid\n`;
    });
    snapraidConfig += `content ${snapraidMountPoint}/.snapraid.content\n\n`;

    // Add data disks with unique IDs
    dataDevices.forEach((device, index) => {
      const diskId = `d${index + 1}`;
      const diskMountPoint = path.join(mergerfsBasePath, `disk${index + 1}`);
      snapraidConfig += `data ${diskId} ${diskMountPoint}\n`;
    });
    snapraidConfig += '\n';

    // Add standard exclusion patterns
    snapraidConfig += `exclude *.tmp\n`;
    snapraidConfig += `exclude *.temp\n`;
    snapraidConfig += `exclude *.log\n`;
    snapraidConfig += `exclude *.bak\n`;
    snapraidConfig += `exclude Thumbs.db\n`;
    snapraidConfig += `exclude .DS_Store\n`;
    snapraidConfig += `exclude .AppleDouble\n`;
    snapraidConfig += `exclude ._*\n`;
    snapraidConfig += `exclude .Spotlight-V100\n`;
    snapraidConfig += `exclude .Trashes\n`;
    snapraidConfig += `exclude .fseventsd\n`;
    snapraidConfig += `exclude .DocumentRevisions-V100\n`;
    snapraidConfig += `exclude .TemporaryItems\n`;
    snapraidConfig += `exclude lost+found/\n`;
    snapraidConfig += `exclude .recycle/\n`;
    snapraidConfig += `exclude $RECYCLE.BIN/\n`;
    snapraidConfig += `exclude System Volume Information/\n`;
    snapraidConfig += `exclude pagefile.sys\n`;
    snapraidConfig += `exclude hiberfil.sys\n`;
    snapraidConfig += `exclude swapfile.sys\n`;

    // Write the configuration file
    await fs.writeFile(snapraidConfigPath, snapraidConfig);
  }

      // Don't persist dynamic status info to pools.json
      // Status will be calculated dynamically when pools are retrieved

      // Save the pool
      pools.push(pool);
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully created MergerFS pool "${name}"${snapraidDevice ? ' with SnapRAID parity' : ''}`,
        pool
      };
    } catch (error) {
      // Cleanup LUKS devices if encryption was enabled and pool creation failed
      if (encryptionEnabled) {
        console.log(`Pool creation failed, cleaning up LUKS devices for '${name}'`);
        try {
          // Close data device LUKS mappers using slot numbers
          if (luksDevices) {
            const dataSlots = devices.map((_, i) => i + 1);
            await this._closeLuksDevicesWithSlots(devices, name, dataSlots);
          }

          // Close parity device LUKS mappers if they exist
          if (snapraidLuksDevice) {
            await this._closeLuksDevicesWithSlots([snapraidDevice], name, [1], true);
          }
        } catch (cleanupError) {
          console.warn(`Warning: Could not cleanup LUKS devices: ${cleanupError.message}`);
        }
      }
      throw new Error(`Error creating MergerFS pool: ${error.message}`);
    }
  }

  /**
   * Add parity devices to a MergerFS pool
   * @param {string} poolId - Pool ID
   * @param {string[]} parityDevices - Array of parity device paths to add
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Result object
   */
  async addParityDevicesToPool(poolId, parityDevices, options = {}) {
    try {
      if (!poolId) throw new Error('Pool ID is required');
      if (!Array.isArray(parityDevices) || parityDevices.length === 0) {
        throw new Error('At least one parity device is required');
      }

      // Load pools data
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const pool = pools[poolIndex];

      if (pool.type !== 'mergerfs') {
        throw new Error('Only MergerFS pools support parity devices');
      }

      // Ensure device paths are injected from UUIDs
      await this._ensureDevicePaths(pool);

      // Handle LUKS encryption for new parity devices if pool is encrypted
      let actualParityDevices = parityDevices;
      let parityLuksDevices = null;

      if (pool.config?.encrypted) {
        console.log(`Setting up LUKS encryption for new parity devices in MergerFS pool '${pool.name}'`);

        // Validate encryption parameters
        if (!options.passphrase) {
          throw new Error('Passphrase is required for adding parity devices to encrypted pools');
        }

        // Setup LUKS encryption on new parity devices
        await this._setupPoolEncryption(parityDevices, pool.name, options.passphrase, false);

        // Open LUKS devices with proper slot numbering
        const startSlot = pool.parity_devices.length + 1;
        const paritySlots = parityDevices.map((_, i) => startSlot + i);
        parityLuksDevices = await this._openLuksDevicesWithSlots(parityDevices, pool.name, paritySlots, options.passphrase, true);
        actualParityDevices = parityLuksDevices.map(d => d.mappedDevice);

        console.log(`LUKS parity devices opened for adding to pool: ${actualParityDevices.join(', ')}`);
      }

      // Check each new parity device
      for (let i = 0; i < parityDevices.length; i++) {
        const originalDevice = parityDevices[i];
        const deviceToCheck = actualParityDevices[i];

        // Check if device exists
        await fs.access(deviceToCheck).catch(() => {
          throw new Error(`Device ${deviceToCheck} does not exist`);
        });

        // Check if device is already mounted
        const mountStatus = await this._isDeviceMounted(deviceToCheck);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${deviceToCheck} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before adding to pool.`);
        }

        // Check if device is already part of this pool (data or parity)
        const isInPool = pool.data_devices.some(d => d.device === deviceToCheck) ||
                        pool.parity_devices.some(d => d.device === deviceToCheck);
        if (isInPool) {
          throw new Error(`Device ${deviceToCheck} is already part of pool ${pool.name}`);
        }

        // Verify parity device size requirements (use original device for size check)
        const paritySize = await this.getDeviceSize(originalDevice);

        // Check all data devices and make sure parity device is at least as large as the largest
        let largestDataDevice = 0;
        for (let i = 0; i < pool.data_devices.length; i++) {
          const dataDevice = pool.data_devices[i];
          // For encrypted pools, get size from original devices
          const deviceToMeasure = pool.config?.encrypted && pool.devices ?
            pool.devices[i] :
            dataDevice.device;
          const deviceSize = await this.getDeviceSize(deviceToMeasure);
          if (deviceSize > largestDataDevice) {
            largestDataDevice = deviceSize;
          }
        }

        if (paritySize < largestDataDevice) {
          throw new Error(`Parity device ${originalDevice} must be at least as large as the largest data device`);
        }

        // Check device format status
        const deviceInfo = await this.checkDeviceFilesystem(deviceToCheck);
        const expectedFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

        if (!deviceInfo.isFormatted) {
          // Device is not formatted - require explicit format option
          throw new Error(`Device ${deviceToCheck} is not formatted. Use format: true to format the device with ${expectedFilesystem}.`);
        } else if (options.format === true) {
          // Explicit format requested - reformat the device
          const formatResult = await this.formatDevice(deviceToCheck, expectedFilesystem);
          // For encrypted devices, the actualParityDevices array is already updated
        } else if (deviceInfo.filesystem !== expectedFilesystem) {
          throw new Error(`Device ${deviceToCheck} has filesystem ${deviceInfo.filesystem}, expected ${expectedFilesystem}. Use format: true to reformat.`);
        }
      }

      // Mount and add new parity devices
      const newParityDevices = [];
      for (let i = 0; i < parityDevices.length; i++) {
        const originalDevice = parityDevices[i];
        const deviceToMount = actualParityDevices[i];
        const parityIndex = pool.parity_devices.length + i + 1;
        const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
        const parityMountPoint = path.join(snapraidPoolPath, `parity${parityIndex}`);

        // Create mount point with proper ownership and mount the device
        const ownershipOptions = {
          uid: this.defaultOwnership.uid,
          gid: this.defaultOwnership.gid
        };
        await this._createDirectoryWithOwnership(parityMountPoint, ownershipOptions);
        await this.mountDevice(deviceToMount, parityMountPoint, ownershipOptions);

        // Get device UUID from the physical device/partition
        const deviceInfo = await this.checkDeviceFilesystem(originalDevice);
        const deviceToUse = deviceInfo.actualDevice || originalDevice;
        const deviceUuid = await this.getDeviceUuid(deviceToUse);

        const expectedFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

        newParityDevices.push({
          slot: parityIndex.toString(),
          id: deviceUuid,
          filesystem: expectedFilesystem,
          spindown: null
        });
      }

      // Add new parity devices to pool
      pool.parity_devices = [...pool.parity_devices, ...newParityDevices];



      // Add SnapRAID sync config if this is the first parity device
      if (pool.parity_devices.length === newParityDevices.length) {
        pool.config.sync = {
          enabled: false,
          schedule: "30 0 * * *",
          check: {
            enabled: false,
            schedule: "0 0 * */3 SUN"
          }
        };
      }

      // Update SnapRAID configuration
      await this.updateSnapRAIDConfig(pool);

      // Save updated pool configuration
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully added ${newParityDevices.length} parity device(s) to pool "${pool.name}"`,
        pool
      };
    } catch (error) {
      throw new Error(`Error adding parity devices: ${error.message}`);
    }
  }

  /**
   * Replace a parity device in a pool
   * @param {string} poolId - Pool ID
   * @param {string} oldDevice - Current parity device path
   * @param {string} newDevice - New parity device path
   * @param {Object} options - Options including format flag
   * @returns {Promise<Object>} - Operation result
   */
  async replaceParityDeviceInPool(poolId, oldDevice, newDevice, options = {}) {
    try {
      // Load pools data
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const pool = pools[poolIndex];

      // Ensure device paths are injected from UUIDs
      await this._ensureDevicePaths(pool);

      // Find the old parity device
      const oldParityIndex = pool.parity_devices.findIndex(device => device.device === oldDevice);

      if (oldParityIndex === -1) {
        throw new Error(`Parity device ${oldDevice} not found in pool`);
      }

      // Check if new device exists
      await fs.access(newDevice).catch(() => {
        throw new Error(`Device ${newDevice} does not exist`);
      });

      // Check if new device is already part of this pool
      const isInPool = pool.data_devices.some(d => d.device === newDevice) ||
                      pool.parity_devices.some(d => d.device === newDevice);
      if (isInPool) {
        throw new Error(`Device ${newDevice} is already part of pool ${pool.name}`);
      }

      // Verify new parity device size requirements
      const newParitySize = await this.getDeviceSize(newDevice);

      // Check all data devices and make sure new parity device is at least as large as the largest
      let largestDataDevice = 0;
      for (const dataDevice of pool.data_devices) {
        const deviceSize = await this.getDeviceSize(dataDevice.device);
        if (deviceSize > largestDataDevice) {
          largestDataDevice = deviceSize;
        }
      }

      if (newParitySize < largestDataDevice) {
        throw new Error(`New parity device ${newDevice} must be at least as large as the largest data device`);
      }

      // Get the old parity device info for preserving slot number
      const oldParityDevice = pool.parity_devices[oldParityIndex];
      const paritySlot = oldParityDevice.slot;

      // Check/format new device
      const deviceInfo = await this.checkDeviceFilesystem(newDevice);
      const expectedFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

      if (!deviceInfo.isFormatted) {
        // Device is not formatted - require explicit format option
        throw new Error(`Device ${newDevice} is not formatted. Use format: true to format the device with ${expectedFilesystem}.`);
      } else if (options.format === true) {
        // Explicit format requested - reformat the device
        await this.formatDevice(newDevice, expectedFilesystem);
      } else if (deviceInfo.filesystem !== expectedFilesystem) {
        throw new Error(`Device ${newDevice} has filesystem ${deviceInfo.filesystem}, expected ${expectedFilesystem}. Use format: true to reformat.`);
      }

      // Unmount old parity device
      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
      const oldParityMountPoint = path.join(snapraidPoolPath, `parity${paritySlot}`);

      if (await this._isMounted(oldParityMountPoint)) {
        await this.unmountDevice(oldParityMountPoint);
      }

      // Mount new parity device at the same mount point
      await this.mountDevice(newDevice, oldParityMountPoint);

      // Get new device UUID
      const newDeviceUuid = await this.getDeviceUuid(newDevice);

      // Update the parity device in the pool configuration
      pool.parity_devices[oldParityIndex] = {
        slot: paritySlot,
        id: newDeviceUuid,
        filesystem: expectedFilesystem,
        spindown: oldParityDevice.spindown || null
      };

      // Update SnapRAID configuration
      await this.updateSnapRAIDConfig(pool);

      // Save updated pool configuration
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully replaced parity device ${oldDevice} with ${newDevice} in pool '${pool.name}'`,
        pool
      };
    } catch (error) {
      throw new Error(`Error replacing parity device: ${error.message}`);
    }
  }

  /**
   * ===== SIMPLE POOL POWER MANAGEMENT =====
   */

  /**
   * Get disk status by UUID
   * @param {string} poolId - Pool ID
   * @param {string} diskUuid - Disk UUID
   * @returns {Promise<Object>} - Disk status
   */
  async getDiskStatus(poolId, diskUuid) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool ${poolId} not found`);
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      const disk = allDisks.find(d => d.id === diskUuid);

      if (!disk) {
        throw new Error(`Disk ${diskUuid} not found in pool`);
      }

      // Check power status with hdparm
      let powerStatus = 'active';
      try {
        const { stdout } = await execPromise(`hdparm -C ${disk.device} 2>/dev/null`);
        if (stdout.includes('active/idle') || stdout.includes('idle')) powerStatus = 'active';
        else if (stdout.includes('standby')) powerStatus = 'standby';
        else if (stdout.includes('sleeping')) powerStatus = 'standby';
      } catch (error) {
        // If hdparm fails, assume it's wake for NVMe/SSD devices
        powerStatus = (disk.device && (disk.device.includes('nvme') || disk.device.includes('ssd'))) ? 'wake' : 'unknown';
      }

      return {
        poolId,
        poolName: pool.name,
        diskUuid,
        device: disk.device,
        slot: disk.slot,
        diskType: pool.data_devices.some(d => d.id === diskUuid) ? 'data' : 'parity',
        powerStatus
      };

    } catch (error) {
      throw new Error(`Failed to get disk status: ${error.message}`);
    }
  }

  /**
   * Wake or sleep a single disk by UUID
   * @param {string} poolId - Pool ID
   * @param {string} diskUuid - Disk UUID
   * @param {string} action - 'wake', 'standby', or 'sleep'
   * @returns {Promise<Object>} - Operation result
   */
  async controlDisk(poolId, diskUuid, action) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool ${poolId} not found`);
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      const disk = allDisks.find(d => d.id === diskUuid);

      if (!disk) {
        throw new Error(`Disk ${diskUuid} not found in pool`);
      }

      if (action === 'wake') {
        // Wake with dd command
        await execPromise(`dd if=${disk.device} of=/dev/null bs=512 count=1 iflag=direct 2>/dev/null`);
      } else if (action === 'standby' || action === 'sleep') {
        // NVMe devices don't reliably support power management via nvme-cli
        // Many NVMe controllers don't implement the power management features properly
        if (disk.device && disk.device.includes('nvme')) {
          return {
            success: false,
            message: 'NVMe devices do not reliably support standby mode',
            device: disk.device
          };
        } else if (disk.device && disk.device.includes('ssd')) {
          // Regular SSD - try hdparm but don't fail if it doesn't work
          try {
            const command = action === 'sleep' ? `hdparm -Y ${disk.device}` : `hdparm -y ${disk.device}`;
            await execPromise(command);
          } catch (error) {
            return {
              success: false,
              message: 'SSD device does not support standby mode'
            };
          }
        } else {
          // Traditional HDD
          const command = action === 'sleep' ? `hdparm -Y ${disk.device}` : `hdparm -y ${disk.device}`;
          await execPromise(command);
        }
      } else {
        throw new Error('Invalid action. Use wake, standby, or sleep');
      }

      return {
        poolId,
        poolName: pool.name,
        diskUuid,
        device: disk.device,
        slot: disk.slot,
        action,
        message: `Disk ${action} successful`
      };

    } catch (error) {
      throw new Error(`Failed to ${action} disk: ${error.message}`);
    }
  }

  /**
   * Wake or sleep entire pool
   * @param {string} poolId - Pool ID
   * @param {string} action - 'wake', 'standby', or 'sleep'
   * @returns {Promise<Object>} - Operation results
   */
  async controlPool(poolId, action) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool ${poolId} not found`);
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      const results = [];

      for (const disk of allDisks) {
        try {
          const result = await this.controlDisk(poolId, disk.id, action);
          results.push(result);
        } catch (error) {
          results.push({
            success: false,
            diskUuid: disk.id,
            device: disk.device,
            slot: disk.slot,
            action,
            message: error.message
          });
        }
      }

      return results;

    } catch (error) {
      throw new Error(`Failed to ${action} pool: ${error.message}`);
    }
  }

  /**
   * Inject power status information directly into pool devices
   */
  async _injectPowerStatusIntoDevices(pool) {
    // Inject power status into data devices
    for (const device of pool.data_devices || []) {
      if (!device.device) {
        device.powerStatus = 'unknown';
        continue;
      }

      try {
        // Check if this is a mapper device (LUKS encrypted)
        let targetDevice = device.device;
        if (device.device.startsWith('/dev/mapper/')) {
          const underlying = await this._getPhysicalDeviceFromMapper(device.device);
          if (underlying) {
            targetDevice = underlying;
          }
        }

        const { stdout } = await execPromise(`hdparm -C ${targetDevice} 2>/dev/null`);

        let powerStatus = 'active';
        if (stdout.includes('active/idle') || stdout.includes('idle')) {
          powerStatus = 'active';
        } else if (stdout.includes('standby')) {
          powerStatus = 'standby';
        } else if (stdout.includes('sleeping')) {
          powerStatus = 'standby';
        }

        device.powerStatus = powerStatus;
      } catch (error) {
        // If hdparm fails, assume it's active for NVMe/SSD devices (they don't support standby)
        device.powerStatus = (device.device && (device.device.includes('nvme') || device.device.includes('ssd'))) ? 'active' : 'unknown';
      }
    }

    // Inject power status into parity devices
    for (const device of pool.parity_devices || []) {
      if (!device.device) {
        device.powerStatus = 'unknown';
        continue;
      }

      try {
        // Check if this is a mapper device (LUKS encrypted)
        let targetDevice = device.device;
        if (device.device.startsWith('/dev/mapper/')) {
          const underlying = await this._getPhysicalDeviceFromMapper(device.device);
          if (underlying) {
            targetDevice = underlying;
          }
        }

        const { stdout } = await execPromise(`hdparm -C ${targetDevice} 2>/dev/null`);

        let powerStatus = 'active';
        if (stdout.includes('active/idle') || stdout.includes('idle')) {
          powerStatus = 'active';
        } else if (stdout.includes('standby')) {
          powerStatus = 'standby';
        } else if (stdout.includes('sleeping')) {
          powerStatus = 'standby';
        }

        device.powerStatus = powerStatus;
      } catch (error) {
        // If hdparm fails, assume it's active for NVMe/SSD devices (they don't support standby)
        device.powerStatus = (device.device && (device.device.includes('nvme') || device.device.includes('ssd'))) ? 'active' : 'unknown';
      }
    }
  }

  /**
   * Get base disk device from partition
   * E.g. /dev/sdj1 -> /dev/sdj, /dev/nvme2n1p1 -> /dev/nvme2n1
   * @param {string} devicePath - Device path (partition or disk)
   * @returns {string} Base disk device path
   * @private
   */
  _getBaseDiskFromPartition(devicePath) {
    if (!devicePath) return devicePath;

    // NVMe devices: /dev/nvme2n1p1 -> /dev/nvme2n1
    if (devicePath.includes('nvme') && devicePath.match(/p\d+$/)) {
      return devicePath.replace(/p\d+$/, '');
    }

    // MMC devices: /dev/mmcblk0p1 -> /dev/mmcblk0
    if (devicePath.includes('mmcblk') && devicePath.match(/p\d+$/)) {
      return devicePath.replace(/p\d+$/, '');
    }

    // Standard SATA/SAS devices: /dev/sdj1 -> /dev/sdj
    if (devicePath.match(/\d+$/)) {
      return devicePath.replace(/\d+$/, '');
    }

    // If no partition number, return as-is (already a base disk)
    return devicePath;
  }

  /**
   * Inject disk information (name, model, serial) into devices
   * @param {Object} pool - Pool object
   * @private
   */
  async _injectDiskInfoIntoDevices(pool) {
    try {
      // Lazy import to avoid circular dependency
      // Note: disks.service exports an instance
      const disksService = require('./disks.service');

      // Get all disks with their information
      // skipStandby: true ensures that standby disks are not woken up
      // They will still be included in the result with basic info (model, serial) but without partitions
      const allDisks = await disksService.getAllDisks({ skipStandby: true, includePerformance: false });

      // Create a map for quick lookup by device path
      const diskMap = {};
      for (const disk of allDisks) {
        diskMap[disk.device] = {
          diskName: disk.name,
          diskModel: disk.model,
          diskSerial: disk.serial
        };
      }

      // Inject disk info into data devices
      for (const device of pool.data_devices || []) {
        if (!device.device) continue;

        // Check if this is a mapper device (LUKS encrypted)
        let physicalDevice = device.device;
        if (device.device.startsWith('/dev/mapper/')) {
          const underlying = await this._getPhysicalDeviceFromMapper(device.device);
          if (underlying) {
            physicalDevice = underlying;
          }
        }

        // Try to find disk info by converting partition to base disk
        const baseDisk = this._getBaseDiskFromPartition(physicalDevice);
        const diskInfo = diskMap[baseDisk];

        if (diskInfo) {
          device.diskInfo = diskInfo;
        } else {
          // If disk not found, try to extract name from device path
          const deviceName = device.device ? device.device.replace('/dev/', '') : null;
          device.diskInfo = {
            diskName: deviceName || 'unknown',
            diskModel: 'Unknown',
            diskSerial: 'Unknown'
          };
        }
      }

      // Inject disk info into parity devices
      for (const device of pool.parity_devices || []) {
        if (!device.device) continue;

        // Check if this is a mapper device (LUKS encrypted)
        let physicalDevice = device.device;
        if (device.device.startsWith('/dev/mapper/')) {
          const underlying = await this._getPhysicalDeviceFromMapper(device.device);
          if (underlying) {
            physicalDevice = underlying;
          }
        }

        // Try to find disk info by converting partition to base disk
        const baseDisk = this._getBaseDiskFromPartition(physicalDevice);
        const diskInfo = diskMap[baseDisk];

        if (diskInfo) {
          device.diskInfo = diskInfo;
        } else {
          // If disk not found, try to extract name from device path
          const deviceName = device.device ? device.device.replace('/dev/', '') : null;
          device.diskInfo = {
            diskName: deviceName || 'unknown',
            diskModel: 'Unknown',
            diskSerial: 'Unknown'
          };
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not inject disk info into devices: ${error.message}`);
      // Don't throw error, just log warning and continue
    }
  }

  /**
   * Get overall pool power status (wake/standby)
   * @param {string} poolId - Pool ID
   * @returns {Promise<string>} Overall power status: 'wake', 'standby', 'mixed', or 'unknown'
   */
  async _getPoolPowerStatus(poolId) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        return 'unknown';
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      if (allDisks.length === 0) {
        return 'unknown';
      }

      const powerStatuses = [];

      for (const disk of allDisks) {
        try {
          const { stdout } = await execPromise(`hdparm -C ${disk.device} 2>/dev/null`);

          let powerStatus = 'active';
          if (stdout.includes('active/idle') || stdout.includes('idle')) {
            powerStatus = 'active';
          } else if (stdout.includes('standby')) {
            powerStatus = 'standby';
          } else if (stdout.includes('sleeping')) {
            powerStatus = 'standby';
          }

          powerStatuses.push(powerStatus);
        } catch (error) {
          powerStatuses.push('unknown');
        }
      }

      // Determine overall status
      const uniqueStatuses = [...new Set(powerStatuses)];

      if (uniqueStatuses.length === 1) {
        const status = uniqueStatuses[0];
        if (status === 'active') return 'wake';
        if (status === 'standby') return 'standby';
        return 'unknown';
      } else if (uniqueStatuses.includes('active') && uniqueStatuses.includes('standby')) {
        return 'mixed';
      } else {
        return 'unknown';
      }

    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Setup LUKS encryption for pool devices
   * @param {string[]} devices - Array of device paths
   * @param {string} poolName - Pool name
   * @param {string} passphrase - Encryption passphrase
   * @param {boolean} createKeyfile - Whether to create a keyfile (default: false)
   * @private
   */
  async _setupPoolEncryption(devices, poolName, passphrase, createKeyfile = false) {
    const luksKeyDir = '/boot/config/system/luks';
    const keyfilePath = path.join(luksKeyDir, `${poolName}.key`);

    // Remove trailing newlines and whitespace from passphrase
    // This ensures consistency regardless of input method (file, API, user input)
    const cleanPassphrase = passphrase.replace(/[\r\n]+$/, '');

    // Create luks directory
    await fs.mkdir(luksKeyDir, { recursive: true });

    // Create keyfile if requested
    if (createKeyfile) {
      // Store passphrase directly in keyfile (not hashed) - store unescaped
      await fs.writeFile(keyfilePath, cleanPassphrase, { mode: 0o600 });
      console.log(`Created keyfile for pool '${poolName}' at ${keyfilePath}`);
    }

    // Check if keyfile exists (might have been created by previous call)
    let useKeyfile = createKeyfile;
    if (!useKeyfile) {
      try {
        await fs.access(keyfilePath);
        useKeyfile = true;
      } catch (error) {
        useKeyfile = false;
      }
    }

    // Encrypt all devices
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      console.log(`Encrypting device ${device} for pool '${poolName}'`);

      if (useKeyfile) {
        // Use keyfile for LUKS format
        await execPromise(`cryptsetup luksFormat ${device} --type luks2 --key-file ${keyfilePath}`);
      } else {
        // Use passphrase directly for LUKS format via stdin (supports spaces and special characters)
        await this._execCryptsetupWithPassphrase(
          ['luksFormat', device, '--type', 'luks2'],
          cleanPassphrase
        );
      }
    }

    return keyfilePath;
  }



  /**
   * Open LUKS devices for a pool
   * @param {string[]} devices - Array of device paths
   * @param {string} poolName - Pool name
   * @param {string} passphrase - Passphrase for LUKS devices (optional if keyfile exists)
   * @param {Object} options - Options for device naming
   * @param {boolean} options.isParity - Whether these are parity devices (uses different naming)
   * @param {number} options.startSlot - Starting slot number for parity devices
   * @returns {Promise<Object[]>} Array of objects with mappedDevice and uuid
   * @private
   */
  async _openLuksDevices(devices, poolName, passphrase = null, options = {}) {
    const keyfilePath = `/boot/config/system/luks/${poolName}.key`;
    const mappedDevices = [];
    let useKeyfile = false;

    // Remove trailing newlines from passphrase if provided
    const cleanPassphrase = passphrase ? passphrase.replace(/[\r\n]+$/, '') : null;

    // Check if keyfile exists
    try {
      await fs.access(keyfilePath);
      useKeyfile = true;
      console.log(`Using keyfile for LUKS devices: ${keyfilePath}`);
    } catch (error) {
      if (!cleanPassphrase) {
        throw new Error(`No keyfile found at ${keyfilePath} and no passphrase provided`);
      }
      console.log(`No keyfile found, using passphrase for LUKS devices`);
    }

    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];

      // Use different naming scheme for parity devices
      let luksName;
      if (options.isParity) {
        const slotNumber = (options.startSlot || 1) + i;
        luksName = `parity_${poolName}_${slotNumber}`;
      } else {
        luksName = `${poolName}_${i}`;
      }

      const mappedDevice = `/dev/mapper/${luksName}`;

      // Check if LUKS device is already open
      try {
        await fs.access(mappedDevice);
        console.log(`LUKS device ${luksName} is already open`);

        // Get UUID of the mapped device partition
        const partitionDevice = this._getPartitionPath(mappedDevice, 1);
        const mappedDeviceUuid = await this.getDeviceUuid(partitionDevice);

        const deviceInfo = {
          originalDevice: device,
          mappedDevice: mappedDevice,
          uuid: mappedDeviceUuid
        };

        // Add slot info for parity devices
        if (options.isParity) {
          deviceInfo.slot = (options.startSlot || 1) + i;
        }

        mappedDevices.push(deviceInfo);
        continue;
      } catch (error) {
        // Device is not open, proceed to open it
      }

      // Open the LUKS device
      try {
        if (useKeyfile) {
          await execPromise(`cryptsetup luksOpen ${device} ${luksName} --key-file ${keyfilePath}`);
        } else {
          // Use passphrase via stdin (supports spaces and special characters)
          await this._execCryptsetupWithPassphrase(
            ['luksOpen', device, luksName],
            cleanPassphrase
          );
        }

        // Get UUID of the mapped device partition for proper mounting
        const partitionDevice = this._getPartitionPath(mappedDevice, 1);
        const mappedDeviceUuid = await this.getDeviceUuid(partitionDevice);

        const deviceInfo = {
          originalDevice: device,
          mappedDevice: mappedDevice,
          uuid: mappedDeviceUuid
        };

        // Add slot info for parity devices
        if (options.isParity) {
          deviceInfo.slot = (options.startSlot || 1) + i;
        }

        mappedDevices.push(deviceInfo);

        console.log(`Opened LUKS device: ${device} -> ${mappedDevice} (UUID: ${mappedDeviceUuid})`);
      } catch (error) {
        if (error.message.includes('already exists')) {
          // Device is already open, get its partition UUID
          const partitionDevice = this._getPartitionPath(mappedDevice, 1);
          const mappedDeviceUuid = await this.getDeviceUuid(partitionDevice);

          const deviceInfo = {
            originalDevice: device,
            mappedDevice: mappedDevice,
            uuid: mappedDeviceUuid
          };

          // Add slot info for parity devices
          if (options.isParity) {
            deviceInfo.slot = (options.startSlot || 1) + i;
          }

          mappedDevices.push(deviceInfo);
          console.log(`LUKS device ${luksName} was already open`);
        } else {
          throw error;
        }
      }
    }

    return mappedDevices;
  }

  /**
   * Open LUKS devices for a pool using specific slot numbers
   * @param {string[]} devices - Array of device paths
   * @param {string} poolName - Pool name
   * @param {number[]} slots - Array of slot numbers corresponding to devices
   * @param {string} passphrase - Passphrase for LUKS devices (optional if keyfile exists)
   * @param {boolean} isParity - Whether these are parity devices (uses different naming)
   * @returns {Promise<Object[]>} Array of objects with mappedDevice and uuid
   * @private
   */
  async _openLuksDevicesWithSlots(devices, poolName, slots, passphrase = null, isParity = false) {
    const keyfilePath = `/boot/config/system/luks/${poolName}.key`;
    const mappedDevices = [];
    let useKeyfile = false;

    // Remove trailing newlines from passphrase if provided
    const cleanPassphrase = passphrase ? passphrase.replace(/[\r\n]+$/, '') : null;

    // Check if keyfile exists
    try {
      await fs.access(keyfilePath);
      useKeyfile = true;
      console.log(`Using keyfile for LUKS devices: ${keyfilePath}`);
    } catch (error) {
      if (!cleanPassphrase) {
        throw new Error(`No keyfile found at ${keyfilePath} and no passphrase provided`);
      }
      console.log(`No keyfile found, using passphrase for LUKS devices`);
    }

    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      const slot = slots[i];

      // Use slot-based naming scheme
      let luksName;
      if (isParity) {
        luksName = `parity_${poolName}_${slot}`;
      } else {
        luksName = `${poolName}_${slot}`;
      }

      const mappedDevice = `/dev/mapper/${luksName}`;

      // Check if LUKS device is already open
      try {
        await fs.access(mappedDevice);
        console.log(`LUKS device ${luksName} is already open`);

        // Get UUID of the mapped device partition
        const partitionDevice = this._getPartitionPath(mappedDevice, 1);
        const mappedDeviceUuid = await this.getDeviceUuid(partitionDevice);

        const deviceInfo = {
          originalDevice: device,
          mappedDevice: mappedDevice,
          uuid: mappedDeviceUuid,
          slot: slot
        };

        mappedDevices.push(deviceInfo);
        continue;
      } catch (error) {
        // Device is not open, proceed to open it
      }

      // Open the LUKS device
      try {
        if (useKeyfile) {
          await execPromise(`cryptsetup luksOpen ${device} ${luksName} --key-file ${keyfilePath}`);
        } else {
          // Use passphrase via stdin (supports spaces and special characters)
          await this._execCryptsetupWithPassphrase(
            ['luksOpen', device, luksName],
            cleanPassphrase
          );
        }

        // Get UUID of the mapped device partition for proper mounting
        const partitionDevice = this._getPartitionPath(mappedDevice, 1);
        const mappedDeviceUuid = await this.getDeviceUuid(partitionDevice);

        const deviceInfo = {
          originalDevice: device,
          mappedDevice: mappedDevice,
          uuid: mappedDeviceUuid,
          slot: slot
        };

        mappedDevices.push(deviceInfo);

        console.log(`Opened LUKS device: ${device} -> ${mappedDevice} (UUID: ${mappedDeviceUuid}, Slot: ${slot})`);
      } catch (error) {
        if (error.message.includes('already exists')) {
          // Device is already open, get its partition UUID
          const partitionDevice = this._getPartitionPath(mappedDevice, 1);
          const mappedDeviceUuid = await this.getDeviceUuid(partitionDevice);

          const deviceInfo = {
            originalDevice: device,
            mappedDevice: mappedDevice,
            uuid: mappedDeviceUuid,
            slot: slot
          };

          mappedDevices.push(deviceInfo);
          console.log(`LUKS device ${luksName} was already open`);
        } else {
          throw error;
        }
      }
    }

    return mappedDevices;
  }



  /**
   * Mount a multi-device BTRFS pool
   * @param {Object} pool - Pool object
   * @param {Object} options - Mount options
   * @private
   */
  async _mountMultiDeviceBtrfsPool(pool, options = {}) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    // Ensure device paths are available
    await this._ensureDevicePaths(pool);

    // Handle LUKS encryption before mounting
    if (pool.config?.encrypted) {
      console.log(`Opening LUKS devices for encrypted multi-device BTRFS pool '${pool.name}'`);

      // Check if we need to open LUKS devices or if they're already mapped
      let physicalDevices = [];
      let alreadyMapped = false;

      // Check if devices are already LUKS mapped devices (from pool creation)
      if (pool.devices && pool.devices.length > 0) {
        // Use original physical devices for LUKS opening
        physicalDevices = pool.devices;
      } else {
        // Fallback to data_devices (might be physical or already mapped)
        physicalDevices = pool.data_devices.map(d => d.device);

        // Check if first device is already a mapper device
        if (physicalDevices[0].startsWith('/dev/mapper/')) {
          alreadyMapped = true;
          console.log(`LUKS devices appear to be already mapped for pool '${pool.name}'`);
        }
      }

      if (!alreadyMapped) {
        // For multi-device BTRFS pools, use slot-based naming
        if (pool.type === 'btrfs' && pool.data_devices.length > 1) {
          const dataSlots = pool.data_devices.map(d => parseInt(d.slot));
          const luksDevices = await this._openLuksDevicesWithSlots(physicalDevices, pool.name, dataSlots, options.passphrase || null);
          pool._luksDevices = luksDevices;
        } else {
          const luksDevices = await this._openLuksDevices(physicalDevices, pool.name, options.passphrase || null);
          pool._luksDevices = luksDevices;
        }
      } else {
        // Create _luksDevices structure for already mapped devices
        pool._luksDevices = physicalDevices.map((device, index) => ({
          originalDevice: pool.devices ? pool.devices[index] : device,
          mappedDevice: device,
          uuid: pool.data_devices[index].id
        }));
      }
    }

    // For BTRFS, we can mount using any device from the array
    let mountDevice = pool.data_devices[0].device;

    // For LUKS pools, use the first mapped device
    if (pool.config?.encrypted && pool._luksDevices) {
      mountDevice = pool._luksDevices[0].mappedDevice;
    }

    // Mount the BTRFS pool
    const mountResult = await this.mountDevice(mountDevice, mountPoint, {
      format: options.format,
      filesystem: 'btrfs',
      mountOptions: options.mountOptions
    });

    // Get space info after successful mount
    const spaceInfo = await this.getDeviceSpace(mountPoint);

    return {
      success: true,
      message: `Multi-device BTRFS pool "${pool.name}" mounted successfully`,
      pool: {
        id: pool.id,
        name: pool.name,
        status: spaceInfo
      }
    };
  }

  /**
   * Mount a MergerFS pool
   * @param {Object} pool - Pool object
   * @param {Object} options - Mount options
   * @private
   */
  async _mountMergerFSPool(pool, options = {}) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const mergerfsBasePath = path.join(this.mergerfsBasePath, pool.name);

    // Ensure device paths are available
    await this._ensureDevicePaths(pool);

    // Handle LUKS encryption before mounting
    if (pool.config?.encrypted) {
      console.log(`Opening LUKS devices for encrypted MergerFS pool '${pool.name}'`);

      // Extract physical device paths from data_devices and parity_devices
      const dataDevices = pool.data_devices.map(d => d.device);
      const parityDevices = pool.parity_devices.map(d => d.device);

      // Open data device LUKS mappers with slot-based naming
      const dataSlots = pool.data_devices.map(d => parseInt(d.slot));
      const luksDevices = await this._openLuksDevicesWithSlots(dataDevices, pool.name, dataSlots, options.passphrase || null);
      pool._luksDevices = luksDevices;

      // Open parity device LUKS mappers if they exist
      if (parityDevices.length > 0) {
        console.log(`Opening parity LUKS devices for encrypted MergerFS pool '${pool.name}'`);
        const paritySlots = pool.parity_devices.map(d => parseInt(d.slot));
        const parityLuksDevices = await this._openLuksDevicesWithSlots(parityDevices, pool.name, paritySlots, options.passphrase || null, true);
        pool._parityLuksDevices = parityLuksDevices;
      }
    }

    // Create mergerfs base directory
    await this._createDirectoryWithOwnership(mergerfsBasePath);

    // Mount individual data devices
    const mountedDevices = [];
    for (let i = 0; i < pool.data_devices.length; i++) {
      const device = pool.data_devices[i];
      let actualDevice = device.device;

      // For LUKS pools, use the mapped device
      if (pool.config?.encrypted && pool._luksDevices) {
        actualDevice = pool._luksDevices[i].mappedDevice;
      }

      const deviceMountPoint = path.join(mergerfsBasePath, `disk${device.slot}`);

      await this.mountDevice(actualDevice, deviceMountPoint, {
        format: options.format,
        filesystem: device.filesystem || 'xfs',
        mountOptions: options.mountOptions
      });

      mountedDevices.push(deviceMountPoint);
    }

    // Mount parity devices if they exist
    for (let i = 0; i < (pool.parity_devices || []).length; i++) {
      const parityDevice = pool.parity_devices[i];
      let actualParityDevice = parityDevice.device;

      // For encrypted pools, use the mapped parity device
      if (pool.config?.encrypted && pool._parityLuksDevices) {
        const mappedParity = pool._parityLuksDevices.find(d => d.slot === parseInt(parityDevice.slot));
        if (mappedParity) {
          actualParityDevice = mappedParity.mappedDevice;
        }
      }

      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
      const parityMountPoint = path.join(snapraidPoolPath, `parity${parityDevice.slot}`);

      await this.mountDevice(actualParityDevice, parityMountPoint, {
        format: options.format,
        filesystem: parityDevice.filesystem || 'xfs',
        mountOptions: options.mountOptions
      });
    }

    // Create main mount point
    await this._createDirectoryWithOwnership(mountPoint);

    // Mount MergerFS
    const mergerfsOptions = 'defaults,allow_other,use_ino,cache.files=off,dropcacheonclose=true,category.create=mfs';
    const mergerfsCommand = `mergerfs ${mountedDevices.join(':')} ${mountPoint} -o ${mergerfsOptions}`;
    await execPromise(mergerfsCommand);

    // Get space info after successful mount
    const spaceInfo = await this.getDeviceSpace(mountPoint);

    return {
      success: true,
      message: `MergerFS pool "${pool.name}" mounted successfully`,
      pool: {
        id: pool.id,
        name: pool.name,
        status: spaceInfo
      }
    };
  }

  /**
   * Unmount a multi-device BTRFS pool
   * @param {Object} pool - Pool object
   * @param {boolean} force - Force unmount
   * @private
   */
  async _unmountMultiDeviceBtrfsPool(pool, force = false) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    // Check if pool is mounted
    if (await this._isMounted(mountPoint)) {
      // Unmount the BTRFS pool
      await this.unmountDevice(mountPoint, { force, removeDirectory: true });
    }

    // Close LUKS devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for encrypted multi-device BTRFS pool '${pool.name}'`);
      // Ensure device paths are available before closing LUKS
      await this._ensureDevicePaths(pool);
      // Use original physical devices for closing with correct slot numbers
      const physicalDevices = pool.devices || pool.data_devices.map(d => d.device);
      const dataSlots = pool.data_devices.map(d => parseInt(d.slot));
      await this._closeLuksDevicesWithSlots(physicalDevices, pool.name, dataSlots);
    }



    return {
      success: true,
      message: `Multi-device BTRFS pool "${pool.name}" unmounted successfully`,
      pool: {
        id: pool.id,
        name: pool.name,
        status: {
          mounted: false
        }
      }
    };
  }

  /**
   * Generate a secure random passphrase for LUKS encryption
   * @returns {string} - Secure random passphrase
   * @private
   */
  _generateSecurePassphrase() {
    const crypto = require('crypto');
    // Generate 32 random bytes and convert to base64, then remove padding
    return crypto.randomBytes(32).toString('base64').replace(/[=+/]/g, '').substring(0, 32);
  }

  /**
   * Check for and clean up existing LUKS mappers with the pool name
   * @param {string} poolName - Pool name to check for existing mappers
   * @private
   */
  async _cleanupExistingLuksMappers(poolName) {
    try {
      // List all device mapper devices
      const { stdout } = await execPromise('ls /dev/mapper/ 2>/dev/null || true');
      const mappers = stdout.trim().split('\n').filter(line => line.trim());

      // Find mappers that match our pool name pattern exactly
      // Use word boundaries to avoid matching similar pool names
      const poolMappers = mappers.filter(mapper => {
        // Match exact pool name followed by underscore and number (e.g., secure_pool1_0)
        // or exact pool name followed by 'p' and number (e.g., secure_pool1p1)
        // or parity devices with pattern parity_POOLNAME_SLOT (e.g., parity_secure_pool1_1)
        const exactPattern = new RegExp(`^${poolName}_\\d+$|^${poolName}p\\d+$|^parity_${poolName}_\\d+$|^parity_${poolName}_\\d+p\\d+$`);
        return exactPattern.test(mapper);
      });

      if (poolMappers.length > 0) {
        console.log(`Found existing LUKS mappers for pool '${poolName}': ${poolMappers.join(', ')}`);

        // Close each mapper
        for (const mapper of poolMappers) {
          try {
            // Try cryptsetup first
            await execPromise(`cryptsetup luksClose ${mapper}`);
            console.log(`Cleaned up LUKS mapper: ${mapper}`);
          } catch (error) {
            // Fallback to dmsetup
            try {
              await execPromise(`dmsetup remove ${mapper}`);
              console.log(`Cleaned up LUKS mapper with dmsetup: ${mapper}`);
            } catch (dmError) {
              console.warn(`Warning: Could not cleanup LUKS mapper ${mapper}: ${dmError.message}`);
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not check for existing LUKS mappers: ${error.message}`);
    }
  }

  /**
   * Close LUKS devices for a pool
   * @param {string[]} devices - Array of original device paths
   * @param {string} poolName - Pool name
   * @param {Object} options - Options for device naming
   * @param {boolean} options.isParity - Whether these are parity devices (uses different naming)
   * @param {number} options.startSlot - Starting slot number for parity devices
   * @private
   */
  async _closeLuksDevices(devices, poolName, options = {}) {
    for (let i = 0; i < devices.length; i++) {
      // Use different naming scheme for parity devices
      let luksName;
      if (options.isParity) {
        const slotNumber = (options.startSlot || 1) + i;
        luksName = `parity_${poolName}_${slotNumber}`;
      } else {
        luksName = `${poolName}_${i}`;
      }

      const partitionName = `${luksName}p1`;

      // Try to close partition first
      try {
        await execPromise(`cryptsetup luksClose ${partitionName}`);
        console.log(`Closed LUKS partition: ${partitionName}`);
      } catch (error) {
        console.warn(`Warning: Could not close LUKS partition ${partitionName}: ${error.message}`);
      }

      // Then close main device
      try {
        await execPromise(`cryptsetup luksClose ${luksName}`);
        console.log(`Closed LUKS device: ${luksName}`);
      } catch (error) {
        console.warn(`Warning: Could not close LUKS device ${luksName}: ${error.message}`);
        // Try dmsetup as fallback
        try {
          await execPromise(`dmsetup remove ${luksName}`);
          console.log(`Force removed LUKS device using dmsetup: ${luksName}`);
        } catch (dmError) {
          console.warn(`Warning: Could not force remove LUKS device ${luksName}: ${dmError.message}`);
        }
      }
    }
  }



  /**
   * Get power status for all disks in a pool
   * @param {string} poolId - Pool ID
   * @returns {Promise<Object>} Power status for all disks
   */
  async getPoolDisksPowerStatus(poolId) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      const results = [];

      for (const disk of allDisks) {
        try {
          const diskStatus = await this.getDiskStatus(poolId, disk.id);
          results.push(diskStatus);
        } catch (error) {
          results.push({
            success: false,
            poolId,
            poolName: pool.name,
            diskUuid: disk.id,
            device: disk.device,
            slot: disk.slot,
            diskType: pool.data_devices.find(d => d.id === disk.id) ? 'data' : 'parity',
            powerStatus: 'error',
            message: error.message
          });
        }
      }

      return results;

    } catch (error) {
      throw new Error(`Failed to get pool disks power status: ${error.message}`);
    }
  }

}

// Export both the class and a default instance
module.exports = new PoolsService();
module.exports.PoolsService = PoolsService;