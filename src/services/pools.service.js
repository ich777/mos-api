const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
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
      return stdout.includes(` ${mountPath} `);
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
   */
  async createMultiDevicePool(name, devices, raidLevel = 'raid1', options = {}) {
    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');

      // Prüfen, ob es wirklich ein Multi-Device-Pool ist
      if (!Array.isArray(devices)) {
        throw new Error('Devices must be an array of device paths');
      }

      // Wenn nur ein Gerät übergeben wird, zur Single-Device-Methode umleiten
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

      // Create mount point
      const mountPoint = path.join(this.mountBasePath, name);
      await fs.mkdir(mountPoint, { recursive: true });

      // Prepare devices for BTRFS formatting (create partitions if needed)
      const preparedDevices = [];
      for (const device of devices) {
        const isPartition = this._isPartitionPath(device);
        if (!isPartition) {
          // Create partition table and partition for whole disks
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
            console.warn(`partprobe failed: ${error.message}`);
          }

          // Determine partition path
          const partitionPath = this._getPartitionPath(device, 1);
          preparedDevices.push(partitionPath);
          console.log(`Created partition: ${partitionPath}`);
        } else {
          preparedDevices.push(device);
        }
      }

      // Format with BTRFS and specified RAID level using prepared devices (partitions)
      let deviceArgs = preparedDevices.join(' ');
      let formatCommand = `mkfs.btrfs -f -d ${raidLevel} -m ${raidLevel} -L "${name}" ${deviceArgs}`;

      // Check if any device is already formatted and user didn't specify format: true
      let needsFormatting = false;
      let allDevicesAreBtrfs = true;

      if (options.format === true) {
        needsFormatting = true;
      } else {
        for (const preparedDevice of preparedDevices) {
          const deviceInfo = await this.checkDeviceFilesystem(preparedDevice);
          if (deviceInfo.isFormatted) {
            // If the device is already formatted with BTRFS, it's OK for a BTRFS pool
            if (deviceInfo.filesystem !== 'btrfs') {
              throw new Error(`Device ${preparedDevice} is already formatted with ${deviceInfo.filesystem}, but BTRFS is required for multi-device pools. Use format: true to overwrite.`);
            }
            // Device is already formatted with BTRFS - perfect for a BTRFS pool
            console.log(`Device ${preparedDevice} is already formatted with BTRFS - will be used as-is`);
          } else {
            // At least one device is not formatted
            allDevicesAreBtrfs = false;
            needsFormatting = true;
          }
        }
      }

      // Execute format command only if needed
      if (needsFormatting) {
        if (!allDevicesAreBtrfs) {
          // If not all devices are BTRFS, we need to format all of them
          await execPromise(formatCommand);
        } else {
          // All devices are already BTRFS, but format=true was explicitly set
          await execPromise(formatCommand);
        }
      } else {
        console.log(`All devices are already formatted with BTRFS - skipping formatting`);
      }

      // Create pool object with multiple devices - get UUIDs after formatting
      const poolId = Date.now().toString();
      const dataDevices = [];

      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        const actualDevice = preparedDevices[i]; // Use the prepared device (partition)
        const deviceUuid = await this.getDeviceUuid(actualDevice);

        dataDevices.push({
          slot: (i + 1).toString(),
          id: deviceUuid,
          device: actualDevice, // Store the actual partition path
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
        data_devices: dataDevices,
        parity_devices: [],
        config: {
          raid_level: raidLevel
        },
        status: {
          mounted: false,
          health: "unknown",
          totalSpace: 0,
          usedSpace: 0,
          freeSpace: 0,
          usagePercent: 0
        }
      };

      // Add pool to pools array and save
      pools.push(newPool);
      await this._writePools(pools);

      // Mount the pool if automount is true
      if (newPool.automount) {
        try {
          // Use the first prepared device (partition) for mounting BTRFS
          await this.mountDevice(preparedDevices[0], mountPoint, { mountOptions: `device=${preparedDevices[0]}` });

          // Update status after mounting
          const spaceInfo = await this.getDeviceSpace(mountPoint);
          newPool.status = spaceInfo;

          // Update the pool data in the file
          const updatedPools = await this._readPools();
          const poolIndex = updatedPools.findIndex(p => p.id === poolId);
          if (poolIndex !== -1) {
            updatedPools[poolIndex].status = spaceInfo;
            await this._writePools(updatedPools);
          }
        } catch (mountError) {
          // Mount error is ignored, as automount is optional
        }
      }

      return {
        success: true,
        message: `Successfully created multi-device BTRFS pool "${name}" with ${raidLevel} configuration`,
        pool: newPool
      };
    } catch (error) {
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

    // Check each new device
    for (const device of newDevices) {
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
      if (options.format !== true) {
        const deviceInfo = await this.checkDeviceFilesystem(device);
        if (deviceInfo.isFormatted) {
          throw new Error(`Device ${device} is already formatted. Use format: true to overwrite.`);
        }
      }
    }

    // Add each device to the BTRFS volume
    for (const device of newDevices) {
      await execPromise(`btrfs device add ${device} ${mountPoint}`);
    }

    // Update the pool data structure - get UUIDs for new devices
    const newDataDevices = [];
    for (let i = 0; i < newDevices.length; i++) {
      const device = newDevices[i];
      const deviceUuid = await this.getDeviceUuid(device);

      newDataDevices.push({
        slot: (pool.data_devices.length + i + 1).toString(),
        id: deviceUuid,
        device,
        filesystem: 'btrfs',
        spindown: null
      });
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

    // Check and format new devices if needed
    const formattedDevices = [];
    for (const device of newDevices) {
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
      const isInPool = pool.data_devices.some(d => d.device === device) ||
                      pool.parity_devices.some(d => d.device === device);
      if (isInPool) {
        throw new Error(`Device ${device} is already part of pool ${pool.name}`);
      }

      // Check/format device
      const deviceInfo = await this.checkDeviceFilesystem(device);
      const actualDeviceToUse = deviceInfo.actualDevice || device;
      const isUsingPartition = deviceInfo.actualDevice && deviceInfo.actualDevice !== device;



      let actualDevice = device;
      if (!deviceInfo.isFormatted || options.format === true) {
        const formatResult = await this.formatDevice(device, existingFilesystem);
        actualDevice = formatResult.device; // Use the partition created by formatDevice
        const uuid = await this.getDeviceUuid(actualDevice);
        formattedDevices.push({
          device: actualDevice,
          filesystem: existingFilesystem,
          uuid,
          isUsingPartition: actualDevice !== device
        });
      } else if (deviceInfo.filesystem !== existingFilesystem) {
        const deviceDisplayName = isUsingPartition ? `${device} (partition ${actualDeviceToUse})` : device;
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
          device: actualDeviceToUse,
          filesystem: deviceInfo.filesystem,
          uuid,
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



      // Create mount point and mount device
      await fs.mkdir(diskMountPoint, { recursive: true });
      await this.mountDevice(device, diskMountPoint); // Mount the actual device (partition)

      // Ensure we get the correct UUID from the actual device being used
      let finalUuid = uuid;
      if (!finalUuid) {
        finalUuid = await this.getDeviceUuid(device);
      }

      newDataDevices.push({
        slot: diskIndex.toString(),
        id: finalUuid, // UUID of the actual partition/device being used
        device: device, // The actual device/partition path
        filesystem,
        spindown: null
      });
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

      // Don't persist dynamic status info to pools.json
      // Status will be calculated dynamically when pools are retrieved

      // Write updated pool data (without status)
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
    return /\/dev\/(sd[a-z]+\d+|nvme\d+n\d+p\d+|hd[a-z]+\d+|vd[a-z]+\d+)$/.test(device);
  }

  /**
   * Get the partition path for a device and partition number
   */
  _getPartitionPath(device, partitionNumber) {
    // Handle NVMe devices (e.g., /dev/nvme0n1 -> /dev/nvme0n1p1)
    if (device.includes('nvme')) {
      return `${device}p${partitionNumber}`;
    }
    // Handle regular SATA/SCSI devices (e.g., /dev/sdb -> /dev/sdb1)
    return `${device}${partitionNumber}`;
  }

  /**
   * Format a device with the specified filesystem
   * Creates a partition first if device is a whole disk
   */
  async formatDevice(device, filesystem = 'xfs') {
    console.log(`Formatting ${device} with ${filesystem}...`);

    try {
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
        message: `Device ${device} successfully ${!isPartition ? 'partitioned and ' : ''}formatted with ${filesystem}`,
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

      // Create mount point if it doesn't exist
      try {
        await fs.access(mountPoint);
      } catch {
        await fs.mkdir(mountPoint, { recursive: true });
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
          // Non-critical error, directory might not be empty - kann ignoriert werden
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
   */
  async getDeviceSpace(mountPoint) {
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

      const { stdout } = await execPromise(`df -B1 ${mountPoint} | tail -1`);
      const parts = stdout.trim().split(/\s+/);

      if (parts.length >= 6) {
        const totalSpace = parseInt(parts[1], 10);
        const usedSpace = parseInt(parts[2], 10);
        const freeSpace = parseInt(parts[3], 10);

        return {
          mounted: true,
          totalSpace,
          totalSpace_human: this._bytesToHuman(totalSpace),
          usedSpace,
          usedSpace_human: this._bytesToHuman(usedSpace),
          freeSpace,
          freeSpace_human: this._bytesToHuman(freeSpace),
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
   */
  async createSingleDevicePool(name, device, filesystem = null, options = {}) {
    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');
      if (!device) throw new Error('Device path is required');

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

      // Check device filesystem
      let deviceInfo = await this.checkDeviceFilesystem(device);

      // Determine the actual device to use (could be a partition)
      let actualDeviceToUse = deviceInfo.actualDevice || device;
      const isUsingPartition = deviceInfo.actualDevice && deviceInfo.actualDevice !== device;

      // Format the device if it is not formatted or if the filesystem does not match
      if (deviceInfo.isFormatted) {
        // Device is already formatted
        if (filesystem && deviceInfo.filesystem !== filesystem) {
          // Warning: The existing filesystem does not match the specified one
          if (options.format === true) {
            // Only format if explicitly requested
            const formatResult = await this.formatDevice(device, filesystem);
            deviceInfo = {
              isFormatted: true,
              filesystem,
              uuid: formatResult.uuid,
              actualDevice: formatResult.device // Use the actual formatted device (partition)
            };
            actualDeviceToUse = formatResult.device;
          } else {
            // Otherwise cancel to prevent data loss
            const deviceDisplayName = isUsingPartition ? `${device} (partition ${actualDeviceToUse})` : device;
            throw new Error(`Device ${deviceDisplayName} is already formatted with ${deviceInfo.filesystem}, not with ${filesystem}. Use format: true to format.`);
          }
        } else {
          // If no filesystem is specified or matches, use the existing one
          filesystem = deviceInfo.filesystem;
        }
      } else {
        // Device is not formatted
        if (options.format === false) {
          throw new Error(`Device ${device} is not formatted and format=false was specified.`);
        } else {
          // Format with specified or default filesystem (xfs as default if nothing specified)
          filesystem = filesystem || 'xfs';
          const formatResult = await this.formatDevice(device, filesystem);
          deviceInfo = {
            isFormatted: true,
            filesystem,
            uuid: formatResult.uuid,
            actualDevice: formatResult.device // Use the actual formatted device (partition)
          };
          actualDeviceToUse = formatResult.device;
        }
      }

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
        data_devices: [
          {
            slot: "1",
            id: deviceInfo.uuid, // UUID of the actual device/partition being used
            device: actualDeviceToUse, // Use the actual device/partition that has the filesystem
            filesystem,
            spindown: options.spindown || null
          }
        ],
        parity_devices: [],
        config: {},
        status: {
          mounted: false,
          health: "unknown",
          totalSpace: 0,
          usedSpace: 0,
          freeSpace: 0,
          usagePercent: 0
        }
      };

      // Add pool to pools array and save
      pools.push(newPool);
      await this._writePools(pools);

      // Mount the pool if automount is true
      if (newPool.automount) {
        try {
          await this.mountDevice(actualDeviceToUse, mountPoint);

          // Update status after mounting
          const spaceInfo = await this.getDeviceSpace(mountPoint);
          newPool.status = spaceInfo;

          // Update the pool data in the file
          const updatedPools = await this._readPools();
          const poolIndex = updatedPools.findIndex(p => p.id === poolId);
          if (poolIndex !== -1) {
            updatedPools[poolIndex].status = spaceInfo;
            await this._writePools(updatedPools);
          }
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
      throw new Error(`Error creating single device pool: ${error.message}`);
    }
  }

  /**
   * Mount a pool by ID
   */
  async mountPoolById(poolId, options = {}) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // For single device pools
      if (pool.data_devices && pool.data_devices.length === 1 &&
          ['ext4', 'xfs', 'btrfs'].includes(pool.type)) {
        const device = pool.data_devices[0].device;
        const mountPoint = path.join(this.mountBasePath, pool.name);

        // Mount the device with format option
        const mountResult = await this.mountDevice(device, mountPoint, {
          format: options.format,
          filesystem: pool.data_devices[0].filesystem || pool.type,
          mountOptions: options.mountOptions
        });

        // Don't persist dynamic status info to pools.json
        // Status will be calculated dynamically when pools are retrieved

        // Update in file
        const poolIndex = pools.findIndex(p => p.id === poolId);
        if (poolIndex !== -1) {
          pools[poolIndex].status = spaceInfo;
          await this._writePools(pools);
        }

        return {
          success: true,
          message: `Pool "${pool.name}" (ID: ${poolId}) mounted successfully`,
          pool: {
            id: pool.id,
            name: pool.name,
            status: spaceInfo
          }
        };
      } else {
        // Other pool types will be implemented later
        throw new Error(`Mounting for pool type "${pool.type}" is not implemented yet`);
      }
    } catch (error) {
      throw new Error(`Error mounting pool: ${error.message}`);
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

      // For single device pools
      if (pool.data_devices && pool.data_devices.length === 1 &&
          ['ext4', 'xfs', 'btrfs'].includes(pool.type)) {
        const mountPoint = path.join(this.mountBasePath, pool.name);

        // Unmount the device
        const unmountResult = await this.unmountDevice(mountPoint, {
          force: options.force || false,
          removeDirectory: options.removeDirectory || false
        });

        // Update status
        pool.status.mounted = false;

        // Update in file
        const poolIndex = pools.findIndex(p => p.id === poolId);
        if (poolIndex !== -1) {
          pools[poolIndex].status.mounted = false;
          await this._writePools(pools);
        }

        return {
          success: true,
          message: `Pool "${pool.name}" (ID: ${poolId}) unmounted successfully`,
          pool: {
            id: pool.id,
            name: pool.name,
            status: {
              mounted: false
            }
          }
        };
      } else {
        // Other pool types will be implemented later
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

    // Step 4: Remove the mergerfs base directory
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
  }

  /**
   * Enrich device information with disk type details (without waking up disks)
   */
  async _enrichDeviceWithDiskTypeInfo(device) {
    try {
      // Lazy import to avoid circular dependency
      const disksService = require('./disks.service');

      const devicePath = device.device || device;
      const deviceName = devicePath.replace('/dev/', '');

      // Only static information is collected - NO hdparm or other disk access!
      const diskTypeInfo = await disksService._getEnhancedDiskTypeForPools(devicePath);

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
      const { stdout } = await execPromise('df -B1');
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
   * Inject storage information directly into pool devices (no disk access)
   */
  async _injectStorageInfoIntoDevices(pool) {
    const dfData = await this._getDfData();

    // For BTRFS pools, get all physical devices from btrfs filesystem show
    let btrfsDevices = [];
    if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 0) {
      try {
        const mountPoint = this._generateExpectedMountPoint(pool, pool.data_devices[0], 'data');
        const { stdout } = await execPromise(`btrfs filesystem show ${mountPoint} 2>/dev/null || echo ""`);

        // Parse btrfs filesystem show output to get all devices
        const deviceMatches = stdout.match(/devid\s+\d+\s+size\s+[\d.]+[KMGT]iB\s+used\s+[\d.]+[KMGT]iB\s+path\s+(\/dev\/[^\s]+)/g);
        if (deviceMatches) {
          btrfsDevices = deviceMatches.map(match => {
            const pathMatch = match.match(/path\s+(\/dev\/[^\s]+)/);
            return pathMatch ? pathMatch[1] : null;
          }).filter(Boolean);

          // Cross-reference with df output to get the actual mounted partitions
          const dfData = await this._getDfData();
          const mountedDevices = Object.values(dfData).map(data => data.device).filter(Boolean);

          // Replace whole disk devices with their mounted partitions if they exist
          btrfsDevices = btrfsDevices.map(device => {
            // Check if there's a mounted partition for this device
            const matchingMountedDevice = mountedDevices.find(mounted =>
              mounted.startsWith(device) && mounted !== device
            );
            return matchingMountedDevice || device;
          });
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
          totalSpace_human: this._bytesToHuman(storageData.totalSpace),
          usedSpace: storageData.usedSpace,
          usedSpace_human: this._bytesToHuman(storageData.usedSpace),
          freeSpace: storageData.freeSpace,
          freeSpace_human: this._bytesToHuman(storageData.freeSpace),
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
    if (pool.type === 'btrfs' && btrfsDevices.length > 0) {
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
          totalSpace_human: this._bytesToHuman(storageData.totalSpace),
          usedSpace: storageData.usedSpace,
          usedSpace_human: this._bytesToHuman(storageData.usedSpace),
          freeSpace: storageData.freeSpace,
          freeSpace_human: this._bytesToHuman(storageData.freeSpace),
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
   */
  async listPools(filters = {}) {
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
          const spaceInfo = await this.getDeviceSpace(mountPoint);
          pool.status = spaceInfo;
        }

        // Inject storage information directly into device objects
        await this._injectStorageInfoIntoDevices(pool);

        // Inject power status into individual device objects
        await this._injectPowerStatusIntoDevices(pool);
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
   */
  async getPoolById(poolId) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

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
        const spaceInfo = await this.getDeviceSpace(mountPoint);
        pool.status = spaceInfo;

        // Note: We don't write back status to pools.json for read-only operations
        // The status info is dynamic and should not be persisted
      }

      // Inject storage information directly into device objects
      await this._injectStorageInfoIntoDevices(pool);

      // Inject power status into individual device objects
      await this._injectPowerStatusIntoDevices(pool);

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

    try {
      // BTRFS replace command
      await execPromise(`btrfs replace start ${oldDevice} ${newDevice} ${mountPoint}`);

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

      // Get new device UUID
      const newDeviceUuid = await this.getDeviceUuid(newDevice);

      // Update pool data structure
      const deviceIndex = pool.data_devices.findIndex(d => d.device === oldDevice);
      if (deviceIndex !== -1) {
        pool.data_devices[deviceIndex].device = newDevice;
        pool.data_devices[deviceIndex].id = newDeviceUuid;
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

      // Read current pools data
      const pools = await this._readPools();

      // Check if pool with the same name already exists
      const existingPoolIndex = pools.findIndex(p => p.name === name);
      if (existingPoolIndex !== -1) {
        throw new Error(`Pool with name "${name}" already exists`);
      }

      const mountPoint = path.join(this.mountBasePath, name);
      const mergerfsBasePath = path.join(this.mergerfsBasePath, name);

      // Handle SnapRAID device if provided
      let snapraidDevice = null;
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
      }

      // Check if all devices are formatted with the correct filesystem
      const formatDevices = [];
      const invalidDevices = [];

      for (const device of devices) {
        // Check if device is already mounted
        const mountStatus = await this._isDeviceMounted(device);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before creating a pool.`);
        }

        const deviceInfo = await this.checkDeviceFilesystem(device);

        if (deviceInfo.isFormatted) {
          if (deviceInfo.filesystem !== filesystem) {
            if (options.format === true) {
              formatDevices.push(device);
            } else {
              invalidDevices.push({
                device,
                currentFs: deviceInfo.filesystem,
                expectedFs: filesystem
              });
            }
          }
        } else {
          if (options.format === false) {
            invalidDevices.push({
              device,
              currentFs: null,
              expectedFs: filesystem
            });
          } else {
            formatDevices.push(device);
          }
        }
      }

      // Check snapraid device if provided
      if (snapraidDevice) {
        // Check if snapraid device is already mounted
        const snapraidMountStatus = await this._isDeviceMounted(snapraidDevice);
        if (snapraidMountStatus.isMounted) {
          throw new Error(`SnapRAID device ${snapraidDevice} is already mounted at ${snapraidMountStatus.mountPoint}. Please unmount it first before creating a pool.`);
        }

        const snapraidInfo = await this.checkDeviceFilesystem(snapraidDevice);

        if (snapraidInfo.isFormatted) {
          if (snapraidInfo.filesystem !== filesystem) {
            if (options.format === true) {
              formatDevices.push(snapraidDevice);
            } else {
              invalidDevices.push({
                device: snapraidDevice,
                currentFs: snapraidInfo.filesystem,
                expectedFs: filesystem
              });
            }
          }
        } else {
          if (options.format === false) {
            invalidDevices.push({
              device: snapraidDevice,
              currentFs: null,
              expectedFs: filesystem
            });
          } else {
            formatDevices.push(snapraidDevice);
          }
        }
      }

      // If there are invalid devices, throw error
      if (invalidDevices.length > 0) {
        throw new Error(
          `Some devices have incompatible filesystems: ${JSON.stringify(invalidDevices)}. ` +
          `Use format option to reformat them.`
        );
      }

      // Format devices if needed
      for (const device of formatDevices) {
        await this.formatDevice(device, filesystem);
      }

      // Create mergerFS base directory
      await fs.mkdir(mergerfsBasePath, { recursive: true });

      // Create mount points for each device and collect device info
      const dataDevices = [];
      let diskIndex = 1;

      for (const device of devices) {
        const diskMountPoint = path.join(mergerfsBasePath, `disk${diskIndex}`);
        await fs.mkdir(diskMountPoint, { recursive: true });

        // Check if filesystem is on device or partition
        const deviceInfo = await this.checkDeviceFilesystem(device);
        const actualDeviceToUse = deviceInfo.actualDevice || device;
        const isUsingPartition = deviceInfo.actualDevice && deviceInfo.actualDevice !== device;


        // Mount the device to its individual mount point
        await this.mountDevice(device, diskMountPoint);

        // Get device UUID from the actual device/partition
        const deviceUuid = await this.getDeviceUuid(actualDeviceToUse);



        dataDevices.push({
          slot: diskIndex.toString(),
          id: deviceUuid,
          device: actualDeviceToUse, // Use the actual device/partition
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
        await fs.mkdir(snapraidMountPoint, { recursive: true });
        await this.mountDevice(snapraidDevice, snapraidMountPoint);

        // Get parity device UUID
        const parityUuid = await this.getDeviceUuid(snapraidDevice);

        parityDevices.push({
          slot: "1",
          id: parityUuid,
          device: snapraidDevice,
          filesystem,
          spindown: null
        });
      }

      // Create the main mount point
      await fs.mkdir(mountPoint, { recursive: true });

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
        data_devices: dataDevices,
        parity_devices: parityDevices,
        config: poolConfig,
        status: {
          mounted: true,
          health: "unknown",
          totalSpace: 0,
          usedSpace: 0,
          freeSpace: 0,
          usagePercent: 0
        }
      };

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

      // Check each new parity device
      for (const device of parityDevices) {
        // Check if device exists
        await fs.access(device).catch(() => {
          throw new Error(`Device ${device} does not exist`);
        });

        // Check if device is already mounted
        const mountStatus = await this._isDeviceMounted(device);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before adding to pool.`);
        }

        // Check if device is already part of this pool (data or parity)
        const isInPool = pool.data_devices.some(d => d.device === device) ||
                        pool.parity_devices.some(d => d.device === device);
        if (isInPool) {
          throw new Error(`Device ${device} is already part of pool ${pool.name}`);
        }

        // Verify parity device size requirements
        const paritySize = await this.getDeviceSize(device);

        // Check all data devices and make sure parity device is at least as large as the largest
        let largestDataDevice = 0;
        for (const dataDevice of pool.data_devices) {
          const deviceSize = await this.getDeviceSize(dataDevice.device);
          if (deviceSize > largestDataDevice) {
            largestDataDevice = deviceSize;
          }
        }

        if (paritySize < largestDataDevice) {
          throw new Error(`Parity device ${device} must be at least as large as the largest data device`);
        }

        // Check device format status
        const deviceInfo = await this.checkDeviceFilesystem(device);
        const expectedFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

        let actualDevice = device;
        if (!deviceInfo.isFormatted || options.format === true) {
          const formatResult = await this.formatDevice(device, expectedFilesystem);
          actualDevice = formatResult.device; // Use the partition created by formatDevice
        } else if (deviceInfo.filesystem !== expectedFilesystem) {
          throw new Error(`Device ${device} has filesystem ${deviceInfo.filesystem}, expected ${expectedFilesystem}. Use format: true to reformat.`);
        }
      }

      // Mount and add new parity devices
      const newParityDevices = [];
      for (let i = 0; i < parityDevices.length; i++) {
        const device = parityDevices[i];
        const parityIndex = pool.parity_devices.length + i + 1;
        const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
        const parityMountPoint = path.join(snapraidPoolPath, `parity${parityIndex}`);

        // Get the actual device (partition) to use
        let actualDevice = device;
        const deviceInfo = await this.checkDeviceFilesystem(device);
        const expectedFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

        if (!deviceInfo.isFormatted || options.format === true) {
          const formatResult = await this.formatDevice(device, expectedFilesystem);
          actualDevice = formatResult.device; // Use the partition created by formatDevice
        }

        // Create mount point and mount the actual device (partition)
        await fs.mkdir(parityMountPoint, { recursive: true });
        await this.mountDevice(actualDevice, parityMountPoint);

        // Get device UUID from the actual device (partition)
        const deviceUuid = await this.getDeviceUuid(actualDevice);

        newParityDevices.push({
          slot: parityIndex.toString(),
          id: deviceUuid,
          device: actualDevice, // Store the partition path
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

      if (!deviceInfo.isFormatted || options.format === true) {
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
        device: newDevice,
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
      let powerStatus = 'unknown';
      try {
        const { stdout } = await execPromise(`hdparm -C ${disk.device} 2>/dev/null`);
        if (stdout.includes('active/idle')) powerStatus = 'wake';
        else if (stdout.includes('standby')) powerStatus = 'standby';
        else if (stdout.includes('sleeping')) powerStatus = 'standby';
      } catch (error) {
        // If hdparm fails, assume it's wake for NVMe/SSD devices
        powerStatus = disk.device.includes('nvme') || disk.device.includes('ssd') ? 'wake' : 'unknown';
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
        if (disk.device.includes('nvme')) {
          return {
            success: false,
            message: 'NVMe devices do not reliably support standby mode',
            device: disk.device
          };
        } else if (disk.device.includes('ssd')) {
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
      try {
        const { stdout } = await execPromise(`hdparm -C ${device.device} 2>/dev/null`);

        let powerStatus = 'unknown';
        if (stdout.includes('active/idle')) {
          powerStatus = 'wake';
        } else if (stdout.includes('standby')) {
          powerStatus = 'standby';
        } else if (stdout.includes('sleeping')) {
          powerStatus = 'standby';
        }

        device.powerStatus = powerStatus;
      } catch (error) {
        // If hdparm fails, assume it's wake for NVMe/SSD devices
        device.powerStatus = device.device.includes('nvme') || device.device.includes('ssd') ? 'wake' : 'unknown';
      }
    }

    // Inject power status into parity devices
    for (const device of pool.parity_devices || []) {
      try {
        const { stdout } = await execPromise(`hdparm -C ${device.device} 2>/dev/null`);

        let powerStatus = 'unknown';
        if (stdout.includes('active/idle')) {
          powerStatus = 'wake';
        } else if (stdout.includes('standby')) {
          powerStatus = 'standby';
        } else if (stdout.includes('sleeping')) {
          powerStatus = 'standby';
        }

        device.powerStatus = powerStatus;
      } catch (error) {
        // If hdparm fails, assume it's wake for NVMe/SSD devices
        device.powerStatus = device.device.includes('nvme') || device.device.includes('ssd') ? 'wake' : 'unknown';
      }
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

          let powerStatus = 'unknown';
          if (stdout.includes('active/idle')) {
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