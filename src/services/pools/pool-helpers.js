const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

/**
 * Helper functions for pool operations
 */
class PoolHelpers {
  /**
   * Check if a device path is a partition
   */
  static isPartitionPath(device) {
    // Check if device ends with a number (partition) or has 'p' + number (NVMe/mapper partitions)
    return /\d+$/.test(device) || /p\d+$/.test(device);
  }

  /**
   * Get partition path for a device
   */
  static getPartitionPath(device, partitionNumber) {
    // Handle NVMe devices (e.g., /dev/nvme0n1 -> /dev/nvme0n1p1)
    // Handle LUKS mapped devices (e.g., /dev/mapper/luks_0 -> /dev/mapper/luks_0p1)
    if (device.includes('nvme') || device.includes('/dev/mapper/')) {
      return `${device}p${partitionNumber}`;
    }
    // Handle regular SATA/SCSI devices (e.g., /dev/sdb -> /dev/sdb1)
    return `${device}${partitionNumber}`;
  }

  /**
   * Get base disk from partition path
   */
  static getBaseDiskFromPartition(devicePath) {
    if (!devicePath) return null;

    // Handle NVMe devices: /dev/nvme0n1p1 -> /dev/nvme0n1
    if (devicePath.includes('nvme')) {
      return devicePath.replace(/p\d+$/, '');
    }

    // Handle mapper devices: /dev/mapper/poolname_1p1 -> /dev/mapper/poolname_1
    if (devicePath.includes('/dev/mapper/')) {
      return devicePath.replace(/p\d+$/, '');
    }

    // Handle regular devices: /dev/sda1 -> /dev/sda
    return devicePath.replace(/\d+$/, '');
  }

  /**
   * Generate secure random passphrase
   */
  static generateSecurePassphrase(length = 32) {
    const crypto = require('crypto');
    // Generate random bytes, convert to base64, remove special chars, trim to length
    return crypto.randomBytes(24).toString('base64').replace(/[=+/]/g, '').substring(0, length);
  }

  /**
   * Validate pool name
   */
  static validatePoolName(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('Pool name must be a non-empty string');
    }

    if (name.length > 255) {
      throw new Error('Pool name must not exceed 255 characters');
    }

    // Check for invalid characters (only allow alphanumeric, underscore, hyphen)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('Pool name can only contain letters, numbers, underscores, and hyphens');
    }

    // Reserved pool names that are not allowed
    const reservedNames = ['remotes'];
    if (reservedNames.includes(name.toLowerCase())) {
      throw new Error(`Pool name '${name}' is reserved and cannot be used`);
    }

    return true;
  }

  /**
   * Validate device path
   */
  static validateDevicePath(device) {
    if (!device || typeof device !== 'string') {
      throw new Error('Device path must be a non-empty string');
    }

    if (!device.startsWith('/dev/')) {
      throw new Error('Device path must start with /dev/');
    }

    return true;
  }

  /**
   * Validate RAID level for BTRFS
   */
  static validateRaidLevel(raidLevel, deviceCount) {
    const validRaidLevels = ['raid0', 'raid1', 'raid10', 'single'];

    if (!validRaidLevels.includes(raidLevel)) {
      throw new Error(`Unsupported RAID level: ${raidLevel}. Supported: ${validRaidLevels.join(', ')}`);
    }

    // Validate device count for RAID level
    if (raidLevel === 'raid1' && deviceCount < 2) {
      throw new Error('RAID1 requires at least 2 devices');
    }

    if (raidLevel === 'raid10' && deviceCount < 4) {
      throw new Error('RAID10 requires at least 4 devices');
    }

    return true;
  }

  /**
   * Get next available pool index
   */
  static getNextPoolIndex(pools) {
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
   * Generate pool ID
   */
  static generatePoolId() {
    return Date.now().toString();
  }

  /**
   * Validate encryption options
   */
  static validateEncryptionOptions(options) {
    if (!options.config?.encrypted) {
      return true; // Not encrypted, no validation needed
    }

    // Check if passphrase or keyfile creation is specified
    const hasPassphrase = options.passphrase && options.passphrase.trim() !== '';
    const createKeyfile = options.config?.create_keyfile === true;

    if (!hasPassphrase && !createKeyfile) {
      throw new Error('Passphrase is required for encrypted pools (or set create_keyfile: true to auto-generate)');
    }

    if (hasPassphrase && options.passphrase.length < 8) {
      throw new Error('Passphrase must be at least 8 characters long for LUKS encryption');
    }

    return true;
  }

  /**
   * Merge pool options with defaults
   */
  static mergePoolOptions(options, defaults = {}) {
    return {
      automount: options.automount !== undefined ? options.automount : (defaults.automount || false),
      comment: options.comment || defaults.comment || '',
      format: options.format !== undefined ? options.format : (defaults.format !== false),
      passphrase: options.passphrase || defaults.passphrase || null,
      config: {
        ...defaults.config,
        ...options.config
      }
    };
  }
}

module.exports = PoolHelpers;
