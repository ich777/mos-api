const si = require('systeminformation');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const PoolsService = require('./pools.service');
const fs = require('fs').promises;
const path = require('path');

class DisksService {
  constructor() {
    // Keine Caches mehr

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
   * Extended Disk Typ recognition (don't wake up disks!)
   * Use only static Information from /sys, no direct disk access
   */
  async _getEnhancedDiskType(device, diskInfo = null) {
    try {
      const deviceName = device.replace('/dev/', '');

      // 1. NVMe Erkennung
      if (deviceName.includes('nvme')) {
        return {
          type: 'nvme',
          rotational: false,
          removable: false
        };
      }

      // 2. MMC/eMMC Erkennung
      if (deviceName.includes('mmc')) {
        return {
          type: 'emmc',
          rotational: false,
          removable: false
        };
      }

      // 3. USB-Device Erkennung über sysfs (SAFE)
      const usbCheck = await this._checkIfUSBDeviceSafe(deviceName);
      if (usbCheck.isUSB) {
        return {
          type: 'usb',
          rotational: usbCheck.rotational,
          removable: usbCheck.isRemovable,
          usbInfo: usbCheck.usbInfo
        };
      }

      // 4. SSD vs HDD Erkennung über /sys/block/{device}/queue/rotational (SAFE)
      const rotationalInfo = await this._checkRotationalSafe(deviceName);

      // 5. Removable-Status prüfen (SAFE)
      const removableInfo = await this._checkRemovableSafe(deviceName);

      return {
        type: rotationalInfo.rotational ? 'hdd' : 'ssd',
        rotational: rotationalInfo.rotational,
        removable: removableInfo.removable
      };

    } catch (error) {
      return {
        type: 'unknown',
        interface: 'unknown',
        rotational: null,
        removable: null
      };
    }
  }

  /**
   * Prüft ob Device ein USB-Device ist (SAFE VERSION - weckt keine Disks auf)
   */
  async _checkIfUSBDeviceSafe(deviceName) {
    try {
      // Prüfe /sys/block/{device}/removable für USB-Devices
      const removablePath = `/sys/block/${deviceName}/removable`;
      const removableContent = await fs.readFile(removablePath, 'utf8').catch(() => '0');
      const isRemovable = removableContent.trim() === '1';

      // Prüfe USB-spezifische sysfs Pfade
      const devicePath = `/sys/block/${deviceName}/device`;

      try {
        // Folge dem symbolischen Link um den echten Gerätepfad zu finden
        const realPath = await fs.realpath(devicePath);

        // USB-Devices haben '/usb' im Pfad
        const isUSB = realPath.includes('/usb');

        let usbInfo = null;
        if (isUSB) {
          // Versuche USB-Informationen zu sammeln
          usbInfo = await this._getUSBDeviceInfo(realPath);
        }

        // Zusätzliche Rotational-Info für USB-Devices
        const rotationalPath = `/sys/block/${deviceName}/queue/rotational`;
        const rotationalContent = await fs.readFile(rotationalPath, 'utf8').catch(() => '1');
        const rotational = rotationalContent.trim() === '1';

        return {
          isUSB,
          isRemovable,
          rotational,
          usbInfo
        };

      } catch (error) {
        return {
          isUSB: false,
          isRemovable,
          rotational: true,
          usbInfo: null
        };
      }

    } catch (error) {
      return {
        isUSB: false,
        isRemovable: false,
        rotational: true,
        usbInfo: null
      };
    }
  }

  /**
   * Sammelt USB-Geräteinformationen
   */
  async _getUSBDeviceInfo(devicePath) {
    try {
      const usbInfo = {};

      // Suche nach USB-spezifischen Verzeichnissen
      const pathParts = devicePath.split('/');

      for (let i = 0; i < pathParts.length; i++) {
        if (pathParts[i].match(/^\d+-\d+/)) { // USB-Device Pattern
          const usbDevicePath = pathParts.slice(0, i + 1).join('/');

          try {
            // Versuche Vendor und Product IDs zu lesen
            const idVendor = await fs.readFile(`${usbDevicePath}/idVendor`, 'utf8').catch(() => null);
            const idProduct = await fs.readFile(`${usbDevicePath}/idProduct`, 'utf8').catch(() => null);
            const manufacturer = await fs.readFile(`${usbDevicePath}/manufacturer`, 'utf8').catch(() => null);
            const product = await fs.readFile(`${usbDevicePath}/product`, 'utf8').catch(() => null);
            const speed = await fs.readFile(`${usbDevicePath}/speed`, 'utf8').catch(() => null);

            if (idVendor) usbInfo.vendorId = idVendor.trim();
            if (idProduct) usbInfo.productId = idProduct.trim();
            if (manufacturer) usbInfo.manufacturer = manufacturer.trim();
            if (product) usbInfo.product = product.trim();
            if (speed) usbInfo.speed = speed.trim();

            break;
          } catch (error) {
            // Weiter versuchen
          }
        }
      }

      return Object.keys(usbInfo).length > 0 ? usbInfo : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Prüft ob Device rotational ist (HDD vs SSD) (SAFE VERSION)
   */
  async _checkRotationalSafe(deviceName) {
    try {
      const rotationalPath = `/sys/block/${deviceName}/queue/rotational`;
      const content = await fs.readFile(rotationalPath, 'utf8');
      return { rotational: content.trim() === '1' };
    } catch (error) {
      // Fallback: versuche über Gerätename zu erraten
      const deviceLower = deviceName.toLowerCase();
      if (deviceLower.includes('ssd') || deviceLower.includes('nvme')) {
        return { rotational: false };
      }
      return { rotational: true }; // Default HDD
    }
  }

  /**
   * Ermittelt Device-Interface (SATA, IDE, USB, etc.) (SAFE VERSION)
   */
  async _getDeviceInterfaceSafe(deviceName) {
    try {
      const devicePath = `/sys/block/${deviceName}/device`;
      const realPath = await fs.realpath(devicePath);

      // Bestimme Interface basierend auf sysfs Pfad
      if (realPath.includes('/ata')) {
        // Unterscheide zwischen SATA und PATA
        if (realPath.includes('/host')) {
          return { interface: 'sata', transportType: 'sata' };
        }
        return { interface: 'ata', transportType: 'pata' };
      } else if (realPath.includes('/usb')) {
        return { interface: 'usb', transportType: 'usb' };
      } else if (realPath.includes('/nvme')) {
        return { interface: 'nvme', transportType: 'pcie' };
      } else if (realPath.includes('/mmc')) {
        return { interface: 'mmc', transportType: 'mmc' };
      } else if (realPath.includes('/scsi')) {
        return { interface: 'scsi', transportType: 'scsi' };
      }

      return { interface: 'unknown', transportType: 'unknown' };
    } catch (error) {
      return { interface: 'unknown', transportType: 'unknown' };
    }
  }

  /**
   * Prüft ob Device removable ist (SAFE VERSION)
   */
  async _checkRemovableSafe(deviceName) {
    try {
      const removablePath = `/sys/block/${deviceName}/removable`;
      const content = await fs.readFile(removablePath, 'utf8');
      return { removable: content.trim() === '1' };
    } catch (error) {
      return { removable: false };
    }
  }

  /**
   * Original-Versionen für Legacy-Kompatibilität mit _getDiskPowerStatus
   */
  async _checkIfUSBDevice(deviceName) {
    return await this._checkIfUSBDeviceSafe(deviceName);
  }

  async _checkRotational(deviceName) {
    return await this._checkRotationalSafe(deviceName);
  }

  async _getDeviceInterface(deviceName) {
    return await this._getDeviceInterfaceSafe(deviceName);
  }

  async _checkRemovable(deviceName) {
    return await this._checkRemovableSafe(deviceName);
  }

  /**
   * Extra-sichere Disk-Typ-Erkennung für Pool-Services
   * Garantiert KEINE Disk-Zugriffe, verwendet nur statische sysfs-Informationen
   */
  async _getEnhancedDiskTypeForPools(device) {
    try {
      const deviceName = device.replace('/dev/', '');

      // Extra-Sicherheit: Prüfe zuerst ob das sysfs-Verzeichnis existiert
      const sysPath = `/sys/block/${deviceName}`;
      try {
        await fs.access(sysPath);
      } catch (error) {
        // Disk existiert nicht mehr oder ist nicht verfügbar
        return {
          type: 'unknown',
          rotational: null,
          removable: null,
          usbInfo: null
        };
      }

      // Verwende die gleiche Logik wie _getEnhancedDiskType, aber garantiert safe
      return await this._getEnhancedDiskType(device);

    } catch (error) {
      return {
        type: 'unknown',
        rotational: null,
        removable: null,
        usbInfo: null
      };
    }
  }

  /**
   * LIVE Power-Status Abfrage - KEIN Caching!
   * Diese Methode führt immer eine direkte hdparm -C Abfrage durch
   */
  async _getLiveDiskPowerStatus(device) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
      const deviceName = device.replace('/dev/', '');

      // Hole erweiterte Typ-Informationen (nur für Typ-Bestimmung)
      const diskTypeInfo = await this._getEnhancedDiskType(device);

      // Nur NVMe und eMMC sind wirklich immer aktiv (haben keinen Standby-Modus)
      // ALLE anderen Disks (HDDs, SSDs, USB mit mSATA) können in Standby gehen!
      if (diskTypeInfo.type === 'nvme' || diskTypeInfo.type === 'emmc') {
        return {
          status: 'active',
          active: true,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        };
      }

      // Für ALLE anderen Disks: IMMER direkte hdparm -C Abfrage - KEIN CACHING!
      // Das schließt ein: HDDs, SSDs, USB-Disks mit echten SSDs/HDDs
      try {
        const { stdout } = await execPromise(`hdparm -C ${devicePath}`);

        let status = 'active';
        let active = true;

        if (stdout.includes('standby')) {
          status = 'standby';
          active = false;
        } else if (stdout.includes('active/idle') || stdout.includes('idle')) {
          status = 'active';
          active = true;
        } else if (stdout.includes('sleeping')) {
          status = 'standby'; // sleeping is treated as standby
          active = false;
        }

        return {
          status,
          active,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        };

      } catch (hdparmError) {
        // hdparm failed - device doesn't support power management
        // WICHTIG: USB-Disks mit echten SSDs/HDDs können durchaus Standby unterstützen!
        // Wir geben 'unknown' zurück, anstatt fälschlicherweise 'active' anzunehmen
        console.warn(`hdparm -C failed for ${devicePath}: ${hdparmError.message}`);
        return {
          status: 'unknown', // Ehrlich sein - wir wissen es nicht!
          active: null,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo,
          error: `Power status check not supported: ${hdparmError.message}`
        };
      }

    } catch (error) {
      return {
        status: 'unknown',
        active: null,
        type: 'unknown',
        rotational: null,
        removable: null
      };
    }
  }

  /**
   * Prüft den Power-Status einer Disk ohne sie aufzuwecken
   * WARNUNG: Diese Methode kann bei HDDs trotzdem Zugriffe verursachen!
   * Für Pool-Services verwende _getEnhancedDiskTypeForPools()
   */
  async _getDiskPowerStatus(device) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
      const deviceName = device.replace('/dev/', '');

      // Hole erweiterte Typ-Informationen
      const diskTypeInfo = await this._getEnhancedDiskType(device);

      // NVMe, eMMC und SSDs sind immer aktiv
      if (diskTypeInfo.type === 'nvme' || diskTypeInfo.type === 'emmc' ||
          (!diskTypeInfo.rotational && diskTypeInfo.type === 'ssd')) {
        return {
          status: 'active',
          active: true,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        };
      }

      // Für HDDs und potentielle rotierende USB-Devices: Power-Status prüfen
      try {
        const { stdout } = await execPromise(`hdparm -C ${devicePath}`);

        let status = 'active';
        let active = true;

        if (stdout.includes('standby')) {
          status = 'standby';
          active = false;
        } else if (stdout.includes('active/idle') || stdout.includes('idle')) {
          status = 'active';
          active = true;
        } else if (stdout.includes('sleeping')) {
          status = 'standby'; // sleeping is treated as standby
          active = false;
        }

        return {
          status,
          active,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        };

      } catch (hdparmError) {
        // hdparm failed - probably USB or device doesn't support it
        return {
          status: 'active', // Assume active if we can't check
          active: true,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        };
      }

    } catch (error) {
      return {
        status: 'unknown',
        active: null,
        type: 'unknown',
        rotational: null,
        removable: null
      };
    }
  }

  /**
   * Holt Filesystem-Informationen mit df (weckt keine Disks auf)
   */
  async _getFilesystemInfo(device) {
    try {
      // df kann mit Devices oder Mount-Punkten arbeiten
      // Use timeout to avoid hanging on unavailable mounts
      const { stdout } = await execPromise(`timeout 5 df -B1 ${device} 2>/dev/null || echo "not_mounted"`);

      if (stdout.includes('not_mounted')) {
        return null;
      }

      const lines = stdout.trim().split('\n');
      if (lines.length < 2) return null;

      const dataLine = lines[1].split(/\s+/);
      if (dataLine.length < 6) return null;

      return {
        filesystem: dataLine[0],
        totalBytes: parseInt(dataLine[1]) || 0,
        usedBytes: parseInt(dataLine[2]) || 0,
        availableBytes: parseInt(dataLine[3]) || 0,
        usagePercent: parseInt(dataLine[4]?.replace('%', '')) || 0,
        mountpoint: dataLine[5] || null
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Holt Mount-Informationen aus /proc/mounts
   */
  async _getMountInfo() {
    try {
      const mountData = await fs.readFile('/proc/mounts', 'utf8');
      const mounts = new Map();

      mountData.split('\n').forEach(line => {
        const parts = line.split(' ');
        if (parts.length >= 3 && parts[0].startsWith('/dev/')) {
          const device = parts[0];
          const mountpoint = parts[1];
          const fstype = parts[2];

          mounts.set(device, {
            mountpoint,
            fstype,
            device
          });
        }
      });

      return mounts;
    } catch (error) {
      return new Map();
    }
  }

  /**
   * Prüft ob ein Device zur System-Disk gehört oder anderweitig verwendet wird
   */
  async _isSystemDisk(device) {
    try {
      const mounts = await this._getMountInfo();

      // Prüfe alle Mount-Punkte für diese Disk oder ihre Partitionen
      for (const [mountedDevice, mountInfo] of mounts) {
        // Direkter Mount der ganzen Disk ODER Partition dieser Disk
        if (mountedDevice === device || mountedDevice.startsWith(device)) {
          const mp = mountInfo.mountpoint;

          // System-relevante Mount-Punkte
          if (mp === '/boot' || mp === '/' || mp === '/usr' || mp === '/var' ||
              mp === '/etc' || mp.startsWith('/mnt/system')) {
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
   * Prüft ob ein Device eine Partition eines anderen Devices ist (NVMe-kompatibel)
   */
  _isPartitionOfDevice(partitionDevice, parentDevice) {
    // Standard SATA/SCSI: /dev/sdb1 ist Partition von /dev/sdb
    if (partitionDevice.startsWith(parentDevice) && partitionDevice !== parentDevice) {
      return true;
    }

    // NVMe: /dev/nvme0n1p1 ist Partition von /dev/nvme0n1
    if (parentDevice.includes('nvme') && partitionDevice.startsWith(parentDevice + 'p')) {
      return true;
    }

    return false;
  }

  /**
   * Get UUIDs of all partitions of a device
   */
  /**
   * Get all UUIDs that belong to a device by reading /dev/disk/by-uuid/ symlinks
   */
  async _getDeviceUuidsBySymlinks(device) {
    const uuids = [];
    try {
      // Read all UUID symlinks
      const uuidDir = '/dev/disk/by-uuid';
      const uuidFiles = await fs.readdir(uuidDir);

      for (const uuid of uuidFiles) {
        try {
          const symlinkPath = path.join(uuidDir, uuid);
          const realPath = await fs.realpath(symlinkPath);

          // Check if this UUID points to our device or any of its partitions
          if (realPath.startsWith(device)) {
            uuids.push(uuid);
          }

          // Fallback for encrypted devices: check if this UUID points to a mapper device
          // that could be created from our device
          if (realPath.startsWith('/dev/mapper/')) {
            // Try to find the underlying LUKS device
            try {
              const { stdout } = await execPromise(`cryptsetup status ${path.basename(realPath)} 2>/dev/null || echo ""`);
              if (stdout.includes(device)) {
                uuids.push(uuid);
              }
            } catch (error) {
              // Ignore errors
            }
          }
        } catch (error) {
          // Skip broken symlinks
        }
      }
    } catch (error) {
      // Directory doesn't exist or can't be read
    }

    return uuids;
  }

  async _getDeviceUuids(device) {
    try {
      const uuids = [];

      // Get partitions of this device
      const partitions = await this._getPartitions(device);

      for (const partition of partitions) {
        if (partition.uuid) {
          uuids.push(partition.uuid);
        }
      }

      return uuids;
    } catch (error) {
      return [];
    }
  }

  /**
   * Checks if a disk is already in use (mounted or in pool)
   */
  async _isDiskInUse(device) {
    try {
      // Check pool membership using UUID-based approach
      try {
        const baseService = new PoolsService();
        const pools = await baseService.listPools({});

        // Get all UUIDs that belong to this device by reading /dev/disk/by-uuid/
        const deviceUuids = await this._getDeviceUuidsBySymlinks(device);

        for (const pool of pools) {
          // Check data_devices
          if (pool.data_devices) {
            for (const poolDevice of pool.data_devices) {
              // Skip devices without UUID
              if (!poolDevice.id) {
                continue;
              }

              // Check if any of this device's UUIDs match the pool device UUID
              if (deviceUuids.includes(poolDevice.id)) {
                return {
                  inUse: true,
                  reason: 'in_pool_data',
                  poolName: pool.name || 'unknown',
                  poolDevice: poolDevice.device || poolDevice.id
                };
              }
            }
          }

          // Check parity_devices (SnapRAID)
          if (pool.parity_devices) {
            for (const parityDevice of pool.parity_devices) {
              // Check by device path first (works for both encrypted and non-encrypted)
              if (parityDevice.device === device ||
                  this._isPartitionOfDevice(parityDevice.device, device)) {
                return {
                  inUse: true,
                  reason: 'in_pool_parity',
                  poolName: pool.name || 'unknown',
                  poolDevice: parityDevice.device || parityDevice.id
                };
              }

              // Additional UUID check for encrypted devices (when device path doesn't match)
              if (parityDevice.id && deviceUuids.includes(parityDevice.id)) {
                return {
                  inUse: true,
                  reason: 'in_pool_parity',
                  poolName: pool.name || 'unknown',
                  poolDevice: parityDevice.device || parityDevice.id
                };
              }
            }
          }

          // Legacy: Check old disks structure if present
          if (pool.disks && pool.disks.some(poolDisk =>
            poolDisk.device === device || device.endsWith(poolDisk.name))) {
            return {
              inUse: true,
              reason: 'in_pool_legacy',
              poolName: pool.name || 'unknown'
            };
          }
        }
      } catch (error) {
        // Pools service not available, ignore
      }

      // Erst NACH Pool-Prüfung: Mount-Prüfungen
      const mounts = await this._getMountInfo();

      // Prüfe direkte Mounts der ganzen Disk
      if (mounts.has(device)) {
        return {
          inUse: true,
          reason: 'mounted_whole_disk',
          mountpoint: mounts.get(device).mountpoint,
          filesystem: mounts.get(device).fstype
        };
      }

      // Prüfe Partitions-Mounts (NVMe-kompatibel)
      for (const [mountedDevice, mountInfo] of mounts) {
        if (this._isPartitionOfDevice(mountedDevice, device)) {
          return {
            inUse: true,
            reason: 'mounted_partition',
            partition: mountedDevice,
            mountpoint: mountInfo.mountpoint,
            filesystem: mountInfo.fstype
          };
        }
      }

      // Prüfe BTRFS Multi-Device Detection
      const btrfsUsage = await this._checkBtrfsUsage(device);
      if (btrfsUsage.inUse) {
        return btrfsUsage;
      }

      return { inUse: false };
    } catch (error) {
      return { inUse: false };
    }
  }

  /**
   * Erweiterte BTRFS Multi-Device Erkennung - findet alle Disks mit gleicher BTRFS UUID
   */
  async _getAllBtrfsDevicesWithSameUuid(uuid) {
    try {
      if (!uuid) return [];

      // Hole alle Block-Devices und prüfe ihre UUIDs
      const { stdout } = await execPromise(`blkid -o list | grep btrfs || echo ""`);
      if (!stdout.trim()) return [];

      const btrfsDevices = [];
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          // Parse blkid output: device fs_type label mount uuid
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[4] === uuid) {
            btrfsDevices.push(parts[0]);
          }
        }
      }

      return btrfsDevices;
    } catch (error) {
      return [];
    }
  }

  /**
   * Holt Partitions-Informationen mit lsblk - erweitert um ganze Disk-Erkennung
   */
  async _getPartitions(device) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
      const { stdout } = await execPromise(`lsblk -J -o NAME,SIZE,FSTYPE,MOUNTPOINT,UUID,LABEL ${devicePath}`);
      const data = JSON.parse(stdout);

      if (!data.blockdevices || data.blockdevices.length === 0) {
        return [];
      }

      const disk = data.blockdevices[0];
      const partitions = [];

      // Fall 1: Disk hat Partitionen (normale Behandlung)
      if (disk.children) {
        for (let i = 0; i < disk.children.length; i++) {
          const partition = disk.children[i];
          const partDevice = `/dev/${partition.name}`;

          // Hole Mount-Status (einheitliches Format wie bei Pools)
          const mountStatus = await this._getPartitionMountStatus(partDevice, partition.mountpoint);

          partitions.push({
            number: i + 1,
            device: partDevice,
            size: this._parseSize(partition.size),
            filesystem: partition.fstype || null,
            mountpoint: partition.mountpoint || null,
            uuid: partition.uuid || null,
            label: partition.label || null,
            status: mountStatus
          });
        }
      }
      // Fall 2: Ganze Disk ist direkt formatiert (ohne Partitionen)
      else if (disk.fstype) {
        // Hole Mount-Status für die ganze Disk
        const mountStatus = await this._getPartitionMountStatus(devicePath, disk.mountpoint);

        partitions.push({
          number: 1,
          device: devicePath,
          size: this._parseSize(disk.size),
          filesystem: disk.fstype,
          mountpoint: disk.mountpoint || null,
          uuid: disk.uuid || null,
          label: disk.label || null,
          isWholeDisk: true, // Markierung dass es die ganze Disk ist
          status: mountStatus
        });
      }

      return partitions;
    } catch (error) {
      return [];
    }
  }

  /**
   * Holt Mount-Status einer Partition im einheitlichen Format (wie bei Pools)
   */
  async _getPartitionMountStatus(device, mountpoint) {
    try {
      // Wenn nicht gemountet
      if (!mountpoint) {
        return {
          mounted: false,
          totalSpace: 0,
          usedSpace: 0,
          freeSpace: 0
        };
      }

      // Skip remote mounts to avoid timeouts
      if (mountpoint.startsWith('/mnt/remotes')) {
        return {
          mounted: false,
          totalSpace: 0,
          usedSpace: 0,
          freeSpace: 0
        };
      }

      // Hole Space-Informationen für gemountete Partition
      const fsInfo = await this._getFilesystemInfo(device);

      if (!fsInfo) {
        return {
          mounted: false,
          totalSpace: 0,
          usedSpace: 0,
          freeSpace: 0
        };
      }

      return {
        mounted: true,
        totalSpace: fsInfo.totalBytes,
        usedSpace: fsInfo.usedBytes,
        freeSpace: fsInfo.availableBytes,
        health: "healthy"
      };
    } catch (error) {
      return {
        mounted: false,
        totalSpace: 0,
        usedSpace: 0,
        freeSpace: 0,
        health: "unknown",
        error: error.message
      };
    }
  }

  /**
   * Konvertiert Size-Strings zu Bytes
   */
  _parseSize(sizeStr) {
    if (!sizeStr) return 0;

    const units = {
      'B': 1,
      'K': 1024,
      'M': 1024 * 1024,
      'G': 1024 * 1024 * 1024,
      'T': 1024 * 1024 * 1024 * 1024,
      'P': 1024 * 1024 * 1024 * 1024 * 1024
    };

    const match = sizeStr.match(/^([\d.]+)([KMGTP]?)$/i);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2]?.toUpperCase() || 'B';

    return Math.floor(value * (units[unit] || 1));
  }

  /**
   * Formatiert Bytes zu Human-Readable Format
   */
  _bytesToHumanReadable(bytes) {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));

    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }

  /**
   * Hauptmethode: Alle Disks auflisten
   * @param {Object} options - Options for disk listing
   * @param {Object} user - User object with byte_format preference
   */
  async getAllDisks(options = {}, user = null) {
    const { skipStandby = true, includePerformance = false } = options;

    try {
      // Hole alle Block-Devices
      const blockDevices = await si.blockDevices();
      const disks = [];

      for (const disk of blockDevices) {
        // Nur physische Disks, keine Partitionen oder Loop-Devices
        if (disk.type !== 'disk' || disk.name.includes('loop')) {
          continue;
        }

        const device = `/dev/${disk.name}`;

        // LIVE Power-Status Abfrage - KEIN Caching!
        const powerStatus = await this._getLiveDiskPowerStatus(device);

        // Skip Disks im Standby wenn gewünscht
        if (skipStandby && powerStatus.status === 'standby') {
          disks.push({
            device,
            name: disk.name,
            model: disk.model || 'Unknown',
            serial: disk.serial || 'Unknown',
            size: disk.size || 0,
            size_human: this.formatBytes(disk.size || 0, user),
            powerStatus: powerStatus.status,
            type: powerStatus.type,
            rotational: powerStatus.rotational,
            removable: powerStatus.removable,
            usbInfo: powerStatus.usbInfo,
            partitions: [],
            performance: null,
            standbySkipped: true
          });
          continue;
        }

        // Hole Partitions-Informationen
        const partitions = await this._getPartitions(device);

        // Performance-Daten nur wenn angefordert
        let performance = null;
        if (includePerformance) {
          performance = await this._getDiskIOStats(device);
        }

        disks.push({
          device,
          name: disk.name,
          model: disk.model || 'Unknown',
          serial: disk.serial || 'Unknown',
          size: disk.size || 0,
          size_human: this.formatBytes(disk.size || 0, user),
          powerStatus: powerStatus.status,
          type: powerStatus.type,
          rotational: powerStatus.rotational,
          removable: powerStatus.removable,
          usbInfo: powerStatus.usbInfo,
          partitions,
          performance,
          standbySkipped: false
        });
      }

      return disks;
    } catch (error) {
      throw new Error(`Failed to get disk information: ${error.message}`);
    }
  }

  /**
   * Disk-Usage für bestimmte Partition/Device
   * @param {string} device - Device path
   * @param {Object} user - User object with byte_format preference
   */
  async getDiskUsage(device, user = null) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
      const fsInfo = await this._getFilesystemInfo(devicePath);

      if (!fsInfo) {
        throw new Error('Device not mounted or no filesystem');
      }

      return {
        device: device,
        total: fsInfo.totalBytes,
        used: fsInfo.usedBytes,
        available: fsInfo.availableBytes,
        percentage: fsInfo.usagePercent,
        total_human: this.formatBytes(fsInfo.totalBytes, user),
        used_human: this.formatBytes(fsInfo.usedBytes, user),
        available_human: this.formatBytes(fsInfo.availableBytes, user)
      };
    } catch (error) {
      throw new Error(`Failed to get disk usage: ${error.message}`);
    }
  }

  /**
   * I/O Statistiken
   */
  async _getDiskIOStats(device) {
    try {
      const deviceName = device.replace('/dev/', '');
      const { stdout } = await execPromise(`cat /proc/diskstats | grep " ${deviceName} "`);

      if (!stdout.trim()) {
        return null;
      }

      const stats = stdout.trim().split(/\s+/);
      if (stats.length < 14) {
        return null;
      }

      return {
        reads: parseInt(stats[3]) || 0,
        writes: parseInt(stats[7]) || 0,
        readBytes: (parseInt(stats[5]) || 0) * 512, // sectors to bytes
        writeBytes: (parseInt(stats[9]) || 0) * 512 // sectors to bytes
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Find unassigned disks - improved logic with BTRFS multi-device support
   * @param {Object} options - Options for disk listing
   * @param {Object} user - User object with byte_format preference
   */
  async getUnassignedDisks(options = {}, user = null) {
    try {
      // Ensure skipStandby is true by default to avoid waking up disks
      const diskOptions = { skipStandby: true, ...options };
      const allDisks = await this.getAllDisks(diskOptions, user);
      const unassignedDisks = [];

      // Collect all mounted BTRFS UUIDs
      const mountedBtrfsUuids = new Set();
      const mounts = await this._getMountInfo();

      for (const [mountedDevice, mountInfo] of mounts) {
        // Collect BTRFS UUIDs
        if (mountInfo.fstype === 'btrfs') {
          try {
            const { stdout: blkidOut } = await execPromise(`blkid ${mountedDevice} 2>/dev/null || echo ""`);
            const uuidMatch = blkidOut.match(/UUID="([^"]+)"/);
            if (uuidMatch) {
              mountedBtrfsUuids.add(uuidMatch[1]);
            }
          } catch (error) {
            // Ignore errors for individual devices
          }
        }
      }

      for (const disk of allDisks) {
        // Check if system disk
        const isSystem = await this._isSystemDisk(disk.device);
        if (isSystem) {
          continue; // Skip system disk
        }

        // Check in detail if disk is in use (pools, all mounts, etc.)
        const usageInfo = await this._isDiskInUse(disk.device);

        if (!usageInfo.inUse) {
          // Additional BTRFS check: Is this disk or one of its partitions part of a mounted BTRFS?
          // BUT: Only if the disk is not in standby (blkid would wake it up!)
          let isPartOfMountedBtrfs = false;

          if (!disk.standbySkipped) {
            // 1. Check the whole disk
            try {
              const devicePath = disk.device.startsWith('/dev/') ? disk.device : `/dev/${disk.device}`;
              const { stdout: blkidOut } = await execPromise(`blkid ${devicePath} 2>/dev/null || echo ""`);

              if (blkidOut.trim()) {
                const uuidMatch = blkidOut.match(/UUID="([^"]+)"/);
                const fsTypeMatch = blkidOut.match(/TYPE="([^"]+)"/);

                if (uuidMatch && fsTypeMatch && fsTypeMatch[1] === 'btrfs') {
                  const diskUuid = uuidMatch[1];
                  if (mountedBtrfsUuids.has(diskUuid)) {
                    isPartOfMountedBtrfs = true;
                  }
                }
              }
            } catch (error) {
              // Ignore errors
            }

            // 2. Check all partitions of the disk for BTRFS
            if (!isPartOfMountedBtrfs && disk.partitions) {
              for (const partition of disk.partitions) {
                try {
                  const { stdout: partBlkidOut } = await execPromise(`blkid ${partition.device} 2>/dev/null || echo ""`);

                  if (partBlkidOut.trim()) {
                    const uuidMatch = partBlkidOut.match(/UUID="([^"]+)"/);
                    const fsTypeMatch = partBlkidOut.match(/TYPE="([^"]+)"/);

                    if (uuidMatch && fsTypeMatch && fsTypeMatch[1] === 'btrfs') {
                      const partitionUuid = uuidMatch[1];
                      if (mountedBtrfsUuids.has(partitionUuid)) {
                        isPartOfMountedBtrfs = true;
                        break; // One partition is enough
                      }
                    }
                  }
                } catch (error) {
                  // Ignore errors for individual partitions
                }
              }
            }
          }
          // If disk is in standby, we skip the BTRFS UUID checks to avoid waking it
          // This means standby disks might be shown as unassigned even if they're part of a BTRFS array
          // but this is better than waking them up

          if (!isPartOfMountedBtrfs) {
            // Additionally check if partitions exist but are not mounted
            if (disk.partitions && disk.partitions.length > 0) {
              // Has partitions but not recognized as "in use" - check other mountpoints (not /mnt/disks, not /mnt/remotes)
              const hasOtherMountedPartitions = disk.partitions.some(p =>
                p.mountpoint &&
                p.mountpoint !== '[SWAP]' &&
                !p.mountpoint.startsWith('/mnt/disks/') &&
                !p.mountpoint.startsWith('/mnt/remotes/')
              );

              if (!hasOtherMountedPartitions) {
                // Has partitions but none are mounted elsewhere - consider as unassigned
                unassignedDisks.push({
                  ...disk,
                  reason: 'has_partitions_but_not_mounted'
                });
              }
            } else {
              // No partitions and not in use
              unassignedDisks.push({
                ...disk,
                reason: 'no_partitions_or_filesystem'
              });
            }
          }
        }
      }

      return {
        unassignedDisks,
        unassignedCount: unassignedDisks.length,
        totalDisks: allDisks.length
      };
    } catch (error) {
      throw new Error(`Failed to get unassigned disks: ${error.message}`);
    }
  }

  /**
   * SMART-Informationen
   */
  async getSmartInfo(device) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
      const { stdout } = await execPromise(`smartctl -a ${devicePath}`);

      // Einfache SMART-Parsing
      const lines = stdout.split('\n');
      const smartInfo = {
        device: devicePath,
        smartStatus: 'UNKNOWN',
        temperature: null,
        powerOnHours: null,
        attributes: []
      };

      for (const line of lines) {
        if (line.includes('SMART overall-health')) {
          smartInfo.smartStatus = line.includes('PASSED') ? 'PASSED' : 'FAILED';
        }
        if (line.includes('Temperature_Celsius')) {
          const match = line.match(/\s+(\d+)\s+/);
          if (match) smartInfo.temperature = parseInt(match[1]);
        }
        if (line.includes('Power_On_Hours')) {
          const match = line.match(/\s+(\d+)\s+/);
          if (match) smartInfo.powerOnHours = parseInt(match[1]);
        }
      }

      return smartInfo;
    } catch (error) {
      throw new Error(`Failed to get SMART info: ${error.message}`);
    }
  }

  /**
   * Disk aufwecken
   */
  async wakeDisk(device) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
      const deviceName = device.replace('/dev/', '');

      // Einfache Prüfung: Nur NVMe und eMMC überspringen (ohne komplexe Disk-Typ-Erkennung)
      // Diese einfache Prüfung weckt garantiert keine Disks auf
      if (deviceName.includes('nvme') || deviceName.includes('mmc')) {
        return {
          success: true,
          message: 'NVMe/eMMC device is always active',
          device: device
        };
      }

      // Für alle anderen Disks: Mehrere Wake-Up-Methoden versuchen
      // Das funktioniert für HDDs, SSDs, USB-Disks mit mSATA, etc.

      let wakeMethod = 'unknown';
      let success = false;

      // Methode 1: dd mit Direct I/O (umgeht Cache)
      try {
        await execPromise(`dd if=${devicePath} of=/dev/null bs=512 count=1 iflag=direct 2>/dev/null`);
        wakeMethod = 'dd direct I/O';
        success = true;
      } catch (ddError) {
        console.warn(`dd direct I/O wake-up failed for ${devicePath}: ${ddError.message}`);

        // Methode 2: dd mit randomisiertem Sektor (falls Direct I/O nicht unterstützt wird)
        try {
          const randomSkip = Math.floor(Math.random() * 1000) + 1; // Skip 1-1000 Sektoren
          await execPromise(`dd if=${devicePath} of=/dev/null bs=512 count=1 skip=${randomSkip} 2>/dev/null`);
          wakeMethod = `dd random sector (skip=${randomSkip})`;
          success = true;
        } catch (ddRandomError) {
          console.warn(`dd random sector wake-up failed for ${devicePath}: ${ddRandomError.message}`);

          // Methode 3: hdparm -S 0 (Power Management deaktivieren/reaktivieren)
          try {
            await execPromise(`hdparm -S 0 ${devicePath}`);
            wakeMethod = 'hdparm -S 0';
            success = true;
          } catch (hdparmError) {
            console.warn(`hdparm wake-up failed for ${devicePath}: ${hdparmError.message}`);

            // Methode 4: Einfacher blockdev --rereadpt (Partition Table neu lesen)
            try {
              await execPromise(`blockdev --rereadpt ${devicePath} 2>/dev/null`);
              wakeMethod = 'blockdev rereadpt';
              success = true;
            } catch (blockdevError) {
              console.warn(`blockdev wake-up failed for ${devicePath}: ${blockdevError.message}`);
            }
          }
        }
      }

      if (success) {
        // Prüfe nach dem Wake-Up-Versuch, ob die Disk wirklich aufgewacht ist
        try {
          // Kurz warten, damit die Disk Zeit hat aufzuwachen
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Prüfe den aktuellen Power-Status
          const { stdout: statusCheck } = await execPromise(`hdparm -C ${devicePath}`);
          const isAwake = statusCheck.includes('active/idle');

          if (isAwake) {
            return {
              success: true,
              message: `Disk woken successfully using ${wakeMethod}`,
              device: device,
              method: wakeMethod,
              verified: true
            };
          } else {
            // Wake-Up-Befehl lief durch, aber Disk ist noch im Standby
            return {
              success: false,
              message: `Wake-up command completed but disk is still in standby (${wakeMethod} failed to wake disk)`,
              device: device,
              method: wakeMethod,
              verified: false,
              currentStatus: statusCheck.trim()
            };
          }
        } catch (verifyError) {
          // Konnte Status nicht prüfen - gehe davon aus, dass es funktioniert hat
          return {
            success: true,
            message: `Disk wake-up attempted using ${wakeMethod} (verification failed)`,
            device: device,
            method: wakeMethod,
            verified: false,
            verifyError: verifyError.message
          };
        }
      } else {
        throw new Error(`All wake-up methods failed for ${devicePath}`);
      }
    } catch (error) {
      throw new Error(`Failed to wake disk: ${error.message}`);
    }
  }

  /**
   * Disk in Standby versetzen
   */
  async sleepDisk(device, mode = 'standby') {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;

      // NVMe devices don't reliably support power management via nvme-cli
      // Many NVMe controllers don't implement the power management features properly
      if (device.includes('nvme')) {
        return {
          success: false,
          message: 'NVMe devices do not reliably support standby mode',
          device: device
        };
      } else if (device.includes('ssd')) {
        // Regular SSD - try hdparm but don't fail if it doesn't work
        try {
          const command = mode === 'sleep' ? `hdparm -Y ${devicePath}` : `hdparm -y ${devicePath}`;
          await execPromise(command);
        } catch (error) {
          return {
            success: false,
            message: 'SSD device does not support standby mode',
            device: device
          };
        }
      } else {
        // Traditional HDD
        const command = mode === 'sleep' ? `hdparm -Y ${devicePath}` : `hdparm -y ${devicePath}`;
        await execPromise(command);
      }

      return {
        success: true,
        message: `Disk put to ${mode} successfully`,
        device: device
      };
    } catch (error) {
      throw new Error(`Failed to put disk to ${mode}: ${error.message}`);
    }
  }

  /**
   * Multiple Disks Operations
   */
  async wakeMultipleDisks(devices) {
    const results = [];

    for (const device of devices) {
      try {
        const result = await this.wakeDisk(device);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          message: error.message,
          device: device
        });
      }
    }

    return { results };
  }

  async sleepMultipleDisks(devices, mode = 'standby') {
    const results = [];

    for (const device of devices) {
      try {
        const result = await this.sleepDisk(device, mode);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          message: error.message,
          device: device
        });
      }
    }

    return { results };
  }

  async getMultipleDisksPowerStatus(devices) {
    const results = [];

    for (const device of devices) {
      try {
        // Verwende LIVE Power-Status - KEIN Caching!
        const powerStatus = await this._getLiveDiskPowerStatus(device);
        results.push({
          device: device,
          powerStatus: powerStatus.status,
          active: powerStatus.active,
          type: powerStatus.type,
          rotational: powerStatus.rotational,
          removable: powerStatus.removable,
          usbInfo: powerStatus.usbInfo
        });
      } catch (error) {
        results.push({
          device: device,
          powerStatus: 'error',
          active: null,
          type: 'unknown',
          rotational: null,
          removable: null,
          usbInfo: null,
          error: error.message
        });
      }
    }

    return { results };
  }

  /**
   * Disk formatieren
   */
  async formatDevice(device, filesystem, options = {}) {
    const { partition = true, wipeExisting = true } = options;

    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;

      // Prüfe ob System-Disk
      const isSystem = await this._isSystemDisk(devicePath);
      if (isSystem) {
        throw new Error('Cannot format system disk');
      }

      // Wipe existing data
      if (wipeExisting) {
        await execPromise(`wipefs -a ${devicePath}`);
      }

      // Create partition if requested
      if (partition) {
        await execPromise(`parted -s ${devicePath} mklabel gpt`);
        await execPromise(`parted -s ${devicePath} mkpart primary 1MiB 100%`);

        // Format first partition - handle NVMe naming convention
        const deviceName = device.replace('/dev/', '');
        let partitionPath;
        if (deviceName.includes('nvme') || deviceName.includes('mmc')) {
          // NVMe and MMC devices use 'p' prefix for partitions (e.g., nvme0n1p1, mmcblk0p1)
          partitionPath = `${devicePath}p1`;
        } else {
          // Traditional devices (sda, sdb, etc.)
          partitionPath = `${devicePath}1`;
        }

        // Add force option for btrfs, xfs and ext4 to overwrite existing filesystems
        let forceOption = '';
        if (filesystem === 'btrfs' || filesystem === 'xfs') {
          forceOption = ' -f';
        } else if (filesystem === 'ext4') {
          forceOption = ' -F';
        }
        await execPromise(`mkfs.${filesystem}${forceOption} ${partitionPath}`);
      } else {
        // Format entire device
        let forceOption = '';
        if (filesystem === 'btrfs' || filesystem === 'xfs') {
          forceOption = ' -f';
        } else if (filesystem === 'ext4') {
          forceOption = ' -F';
        }
        await execPromise(`mkfs.${filesystem}${forceOption} ${devicePath}`);
      }

      return {
        success: true,
        message: `Device formatted with ${filesystem} successfully`,
        device: device,
        filesystem: filesystem
      };
    } catch (error) {
      throw new Error(`Failed to format device: ${error.message}`);
    }
  }

  /**
   * Power Management
   */
  async manageDiskPowerSettings(device, options = {}) {
    const { check = true } = options;

    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;

      if (check) {
        // Nur Status abrufen - LIVE ohne Caching!
        const powerStatus = await this._getLiveDiskPowerStatus(devicePath);
        return {
          success: true,
          device: device,
          currentStatus: powerStatus,
          message: 'Power status retrieved successfully'
        };
      }

      // Hier könnten weitere Power-Management Einstellungen implementiert werden

      return {
        success: true,
        device: device,
        message: 'Power management check completed'
      };
    } catch (error) {
      throw new Error(`Failed to manage power settings: ${error.message}`);
    }
  }

  /**
   * Prüft ob ein Mount-Point bereits verwendet wird
   */
  async _isMounted(mountPoint) {
    try {
      const mounts = await this._getMountInfo();
      for (const [device, mountInfo] of mounts) {
        if (mountInfo.mountpoint === mountPoint) {
          return true;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Holt UUID und Label einer Partition/Device
   */
  async _getDeviceUuidAndLabel(device) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
      const { stdout } = await execPromise(`blkid ${devicePath} 2>/dev/null || echo ""`);

      if (!stdout.trim()) {
        return { uuid: null, label: null, filesystem: null };
      }

      const uuidMatch = stdout.match(/UUID="([^"]+)"/);
      const labelMatch = stdout.match(/LABEL="([^"]+)"/);
      const typeMatch = stdout.match(/TYPE="([^"]+)"/);

      return {
        uuid: uuidMatch ? uuidMatch[1] : null,
        label: labelMatch ? labelMatch[1] : null,
        filesystem: typeMatch ? typeMatch[1] : null
      };
    } catch (error) {
      return { uuid: null, label: null, filesystem: null };
    }
  }

  /**
   * Erstellt einen eindeutigen Mount-Point-Namen basierend auf Device-Informationen
   */
  async _generateMountPointName(device) {
    const deviceInfo = await this._getDeviceUuidAndLabel(device);
    const deviceName = device.replace('/dev/', '');

    // Priorität: 1. Label, 2. UUID (kurz), 3. Device-Name
    if (deviceInfo.label) {
      // Sanitize label für Dateisystem
      return deviceInfo.label.replace(/[^a-zA-Z0-9_-]/g, '_');
    } else if (deviceInfo.uuid) {
      // Verwende die ersten 8 Zeichen der UUID
      return deviceInfo.uuid.substring(0, 8);
    } else {
      return deviceName;
    }
  }

  /**
   * Mountet ein Device oder eine Partition mit integrierter Mountability-Prüfung
   */
  async mountDevice(device, options = {}) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;

      // === MOUNTABILITY CHECKS ===

      // 1. Prüfe ob Device existiert
      try {
        await fs.access(devicePath);
      } catch (error) {
        throw new Error(`Device ${devicePath} does not exist`);
      }

      // 2. Prüfe ob System-Disk
      const isSystem = await this._isSystemDisk(devicePath);
      if (isSystem) {
        throw new Error('Cannot mount system disk');
      }

      // 3. Hole Device-Informationen
      const deviceInfo = await this._getDeviceUuidAndLabel(devicePath);

      if (!deviceInfo.filesystem) {
        throw new Error(`Device ${devicePath} has no filesystem. Please format it first.`);
      }

      // 4. Prüfe ob bereits gemountet
      const mounts = await this._getMountInfo();
      if (mounts.has(devicePath)) {
        const existingMount = mounts.get(devicePath);
        return {
          success: true,
          device: device,
          mountPoint: existingMount.mountpoint,
          filesystem: existingMount.fstype,
          alreadyMounted: true,
          message: `Device ${device} is already mounted at ${existingMount.mountpoint}`
        };
      }

      // 5. Spezielle BTRFS Multi-Device Prüfung (weniger restriktiv)
      if (deviceInfo.filesystem === 'btrfs') {
        const btrfsUsage = await this._checkBtrfsUsage(devicePath);
        if (btrfsUsage.inUse) {
          // BTRFS Multi-Device bereits gemountet - verwende bestehenden Mount-Point
          return {
            success: true,
            device: device,
            mountPoint: btrfsUsage.mountpoint,
            filesystem: 'btrfs',
            uuid: btrfsUsage.uuid,
            btrfsMultiDevice: true,
            primaryDevice: btrfsUsage.primaryDevice,
            alreadyMounted: true,
            message: `BTRFS device ${device} is part of multi-device filesystem already mounted at ${btrfsUsage.mountpoint}`
          };
        }

        // Für BTRFS: Versuche degraded mount wenn andere Devices fehlen
        // Dies ist wichtig für RAID1/10 wo einzelne Devices auch alleine mountbar sind
      }

      // 6. Prüfe ob in Pool verwendet (für Non-BTRFS oder nicht-gemountete BTRFS)
      const usageInfo = await this._isDiskInUse(devicePath);
      if (usageInfo.inUse && usageInfo.reason !== 'btrfs_multi_device') {
        throw new Error(`Device is in use: ${usageInfo.reason}`);
      }

      // === MOUNT LOGIC ===

      // Generiere Mount-Point-Namen
      const mountName = await this._generateMountPointName(devicePath);
      const baseMountPoint = `/mnt/disks/${mountName}`;

      // Erstelle Mount-Point-Verzeichnis
      try {
        await fs.mkdir(baseMountPoint, { recursive: true });
      } catch (error) {
        throw new Error(`Failed to create mount point ${baseMountPoint}: ${error.message}`);
      }

      // Prüfe ob Mount-Point bereits verwendet wird
      if (await this._isMounted(baseMountPoint)) {
        throw new Error(`Mount point ${baseMountPoint} is already in use`);
      }

      // Führe Mount durch
      const mountOptions = options.mountOptions || 'defaults';

      // Für BTRFS: spezielle Behandlung mit degraded option für fehlende Devices
      let mountCommand;
      if (deviceInfo.filesystem === 'btrfs') {
        // BTRFS mit degraded option - erlaubt mount auch bei fehlenden RAID-Devices
        mountCommand = `mount -o ${mountOptions},degraded ${devicePath} ${baseMountPoint}`;
      } else {
        mountCommand = `mount -o ${mountOptions} ${devicePath} ${baseMountPoint}`;
      }

      await execPromise(mountCommand);

      // Setze Berechtigungen
      try {
        await execPromise(`chmod 755 ${baseMountPoint}`);
      } catch (error) {
        // Warnung aber kein Fehler
        console.warn(`Could not set permissions on ${baseMountPoint}: ${error.message}`);
      }

      return {
        success: true,
        device: device,
        mountPoint: baseMountPoint,
        filesystem: deviceInfo.filesystem,
        uuid: deviceInfo.uuid,
        label: deviceInfo.label,
        alreadyMounted: false,
        message: `Device ${device} successfully mounted at ${baseMountPoint}`
      };

    } catch (error) {
      throw new Error(`Failed to mount device ${device}: ${error.message}`);
    }
  }

  /**
   * Unmountet ein Device mit automatischem BTRFS Multi-Device Unmount
   */
  async unmountDevice(device, options = {}) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;

      // Finde Mount-Point des Devices
      const mounts = await this._getMountInfo();
      if (!mounts.has(devicePath)) {
        return {
          success: true,
          device: device,
          alreadyUnmounted: true,
          message: `Device ${device} is not mounted`
        };
      }

      const mountInfo = mounts.get(devicePath);
      const mountPoint = mountInfo.mountpoint;

      let unmountedDevices = [devicePath];

      // Spezielle BTRFS Multi-Device Behandlung
      if (mountInfo.fstype === 'btrfs') {
        const deviceInfo = await this._getDeviceUuidAndLabel(devicePath);
        if (deviceInfo.uuid) {
          // Finde alle Devices mit derselben BTRFS UUID
          const allBtrfsDevices = await this._getAllBtrfsDevicesWithSameUuid(deviceInfo.uuid);

          if (allBtrfsDevices.length > 1) {
            console.log(`Unmounting BTRFS multi-device filesystem with ${allBtrfsDevices.length} devices`);

            // Unmount alle anderen BTRFS Devices automatisch
            for (const btrfsDevice of allBtrfsDevices) {
              if (btrfsDevice !== devicePath && mounts.has(btrfsDevice)) {
                try {
                  const btrfsMountInfo = mounts.get(btrfsDevice);
                  if (btrfsMountInfo.mountpoint === mountPoint) {
                    // Gleicher Mount-Point - wird automatisch mit-unmounted
                    unmountedDevices.push(btrfsDevice);
                  }
                } catch (error) {
                  console.warn(`Could not check BTRFS device ${btrfsDevice}: ${error.message}`);
                }
              }
            }
          }
        }
      }

      // Führe Unmount durch
      const forceFlag = options.force ? ' -f' : '';
      const lazyFlag = options.lazy ? ' -l' : '';

      await execPromise(`umount${forceFlag}${lazyFlag} ${mountPoint}`);

      // Entferne leeres Verzeichnis wenn es unter /mnt/disks liegt und leer ist
      if (mountPoint.startsWith('/mnt/disks/')) {
        try {
          // Prüfe ob Verzeichnis leer ist
          const dirContents = await fs.readdir(mountPoint);
          if (dirContents.length === 0) {
            await fs.rmdir(mountPoint);
          }
        } catch (error) {
          // Ignoriere Fehler beim Verzeichnis löschen
          console.warn(`Could not remove mount directory ${mountPoint}: ${error.message}`);
        }
      }

      return {
        success: true,
        device: device,
        mountPoint: mountPoint,
        filesystem: mountInfo.fstype,
        unmountedDevices: unmountedDevices,
        alreadyUnmounted: false,
        message: `Device ${device} successfully unmounted from ${mountPoint}${unmountedDevices.length > 1 ? ` (including ${unmountedDevices.length - 1} additional BTRFS devices)` : ''}`
      };

    } catch (error) {
      throw new Error(`Failed to unmount device ${device}: ${error.message}`);
    }
  }

  /**
   * Prüft verfügbare Dateisysteme für die Formatierung
   */
  async getAvailableFilesystems() {
    const supportedFilesystems = [
      { name: 'ext4', command: 'mkfs.ext4' },
      { name: 'xfs', command: 'mkfs.xfs' },
      { name: 'btrfs', command: 'mkfs.btrfs' },
      { name: 'vfat', command: 'mkfs.vfat' },
      { name: 'zfs', command: 'zfs' }
    ];

    const availableFilesystems = [];

    for (const fs of supportedFilesystems) {
      try {
        // Spezielle Behandlung für ZFS
        if (fs.name === 'zfs') {
          try {
            await execPromise(`which zpool`);
            await execPromise(`which zfs`);
            await execPromise(`modinfo zfs`);
            availableFilesystems.push(fs.name);
          } catch (zfsError) {
            // ZFS nicht verfügbar
          }
        } else {
          // Normale mkfs-Tools prüfen
          await execPromise(`which ${fs.command}`);
          availableFilesystems.push(fs.name);
        }
      } catch (error) {
        // Tool nicht verfügbar - ignorieren
      }
    }

    return availableFilesystems;
  }

  // Dummy-Methoden für Kompatibilität mit bestehenden Routes
  getCacheStatus() {
    return {
      initialized: false,
      message: 'Caching disabled - using live data',
      lastUpdate: null,
      itemCount: 0,
      size: '0B'
    };
  }

  clearCache() {
    return {
      success: true,
      message: 'No cache to clear - using live data',
      cleared: 0
    };
  }

  clearAllCaches() {
    return this.clearCache();
  }

  async initializeStartupCache() {
    return {
      success: true,
      message: 'Cache initialization skipped - using live data'
    };
  }

  async refreshStartupCache() {
    return {
      success: true,
      message: 'Cache refresh skipped - using live data'
    };
  }
}

module.exports = new DisksService(); 