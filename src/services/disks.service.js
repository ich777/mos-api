const si = require('systeminformation');
const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');
const net = require('net');

// MOS notify socket path
const MOS_NOTIFY_SOCKET = '/var/run/mos-notify.sock';

// Preclear log directory
const PRECLEAR_LOG_DIR = '/var/log/preclear';
const PRECLEAR_LOG_MAX_SIZE = 5 * 1024 * 1024; // 5MB

class DisksService {
  constructor() {
    // Cache für Power-Status (verhindert mehrfache smartctl-Aufrufe innerhalb kurzer Zeit)
    this.powerStatusCache = new Map();
    this.powerStatusCacheTTL = 10000; // 10 Sekunden Cache

    // Background I/O Stats Sampling
    this.diskStatsHistory = new Map(); // device -> { timestamp, readBytes, writeBytes, readSpeed, writeSpeed }
    this.diskStatsSamplingInterval = null;
    this.diskStatsSamplingRate = 2000; // 2 seconds

    // Temperature cache (separate from power status)
    this.temperatureCache = new Map(); // device -> { temperature, timestamp }
    this.temperatureCacheTTL = 12000;

    // Preclear tracking
    this.preclearRunning = new Map(); // device -> { algorithm, currentPass, totalPasses, startedAt }
    this.preclearProcesses = new Map(); // device -> { process, aborted }
  }

  // ============================================================
  // BACKGROUND I/O STATS SAMPLING
  // ============================================================

  /**
   * Start background sampling of disk I/O statistics
   * Reads /proc/diskstats every 2 seconds and calculates throughput
   * @param {number} intervalMs - Sampling interval in milliseconds (default: 2000)
   */
  startDiskStatsSampling(intervalMs = 2000) {
    if (this.diskStatsSamplingInterval) {
      return; // Already running
    }

    this.diskStatsSamplingRate = intervalMs;
    // Initial sample
    this._sampleDiskStats();

    // Start interval
    this.diskStatsSamplingInterval = setInterval(() => {
      this._sampleDiskStats();
    }, intervalMs);
  }

  /**
   * Stop background sampling of disk I/O statistics
   */
  stopDiskStatsSampling() {
    if (this.diskStatsSamplingInterval) {
      clearInterval(this.diskStatsSamplingInterval);
      this.diskStatsSamplingInterval = null;
      this.diskStatsHistory.clear();
      console.log('[DisksService] Stopped disk I/O stats sampling');
    }
  }

  /**
   * Check if disk stats sampling is active
   * @returns {boolean}
   */
  isDiskStatsSamplingActive() {
    return this.diskStatsSamplingInterval !== null;
  }

  /**
   * Internal: Sample all disk stats from /proc/diskstats
   * @private
   */
  async _sampleDiskStats() {
    try {
      const statsContent = await fs.readFile('/proc/diskstats', 'utf8');
      const lines = statsContent.trim().split('\n');
      const now = Date.now();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 14) continue;

        const deviceName = parts[2];

        // Skip partitions, loop devices, dm-devices, etc.
        // Only track physical disks: sd*, nvme*n*, mmc*, md*
        if (!deviceName.match(/^(sd[a-z]+|nvme\d+n\d+|mmc\w+|md\d+)$/)) {
          continue;
        }

        const readBytes = (parseInt(parts[5]) || 0) * 512; // sectors to bytes
        const writeBytes = (parseInt(parts[9]) || 0) * 512;

        const prev = this.diskStatsHistory.get(deviceName);

        let readSpeed = 0;
        let writeSpeed = 0;

        if (prev) {
          const timeDiffSeconds = (now - prev.timestamp) / 1000;
          if (timeDiffSeconds > 0) {
            readSpeed = Math.max(0, (readBytes - prev.readBytes) / timeDiffSeconds);
            writeSpeed = Math.max(0, (writeBytes - prev.writeBytes) / timeDiffSeconds);
          }
        }

        this.diskStatsHistory.set(deviceName, {
          timestamp: now,
          readBytes,
          writeBytes,
          readSpeed,
          writeSpeed
        });
      }
    } catch (error) {
      console.error('[DisksService] Error sampling disk stats:', error.message);
    }
  }

  /**
   * Get current throughput for a specific disk
   * @param {string} device - Device path or name (e.g., '/dev/sda1' or 'sda')
   * @param {Object} user - User object with byte_format preference
   * @returns {Object|null} Throughput data or null if not available
   */
  getDiskThroughput(device, user = null) {
    if (!device) return null;
    // Map partition to base disk (e.g., sdj1 -> sdj, nvme0n1p1 -> nvme0n1)
    const baseDiskPath = this._getBaseDisk(device);
    const baseDisk = baseDiskPath.replace('/dev/', '');
    const stats = this.diskStatsHistory.get(baseDisk);

    if (!stats) {
      return null;
    }

    return {
      readSpeed: stats.readSpeed,
      writeSpeed: stats.writeSpeed,
      readSpeed_human: this.formatSpeed(stats.readSpeed, user),
      writeSpeed_human: this.formatSpeed(stats.writeSpeed, user),
      readBytes_total: stats.readBytes,
      writeBytes_total: stats.writeBytes,
      readBytes_total_human: this.formatBytes(stats.readBytes, user),
      writeBytes_total_human: this.formatBytes(stats.writeBytes, user),
      timestamp: stats.timestamp
    };
  }

  /**
   * Get current throughput for all tracked disks
   * @param {Object} user - User object with byte_format preference
   * @returns {Array} Array of throughput data for all disks
   */
  getAllDisksThroughput(user = null) {
    const result = [];

    for (const [deviceName, stats] of this.diskStatsHistory) {
      result.push({
        device: deviceName,
        readSpeed: stats.readSpeed,
        writeSpeed: stats.writeSpeed,
        readSpeed_human: this.formatSpeed(stats.readSpeed, user),
        writeSpeed_human: this.formatSpeed(stats.writeSpeed, user),
        readBytes_total: stats.readBytes,
        writeBytes_total: stats.writeBytes,
        readBytes_total_human: this.formatBytes(stats.readBytes, user),
        writeBytes_total_human: this.formatBytes(stats.writeBytes, user),
        timestamp: stats.timestamp
      });
    }

    return result;
  }

  /**
   * Get cumulative throughput for a pool (sum of all disk speeds)
   * @param {Array<string>} devices - Array of device paths or names
   * @param {Object} user - User object with byte_format preference
   * @returns {Object} Cumulative throughput for the pool
   */
  getPoolThroughput(devices, user = null) {
    let totalReadSpeed = 0;
    let totalWriteSpeed = 0;
    let totalReadBytes = 0;
    let totalWriteBytes = 0;
    const diskStats = [];
    const processedDisks = new Set(); // Avoid counting same disk twice

    for (const device of devices) {
      // _getBaseDisk returns /dev/sdj, we need just 'sdj' for the history lookup
      const baseDiskPath = this._getBaseDisk(device);
      const baseDisk = baseDiskPath.replace('/dev/', '');

      // Skip if we already processed this base disk
      if (processedDisks.has(baseDisk)) continue;
      processedDisks.add(baseDisk);

      const stats = this.diskStatsHistory.get(baseDisk);

      if (stats) {
        totalReadSpeed += stats.readSpeed;
        totalWriteSpeed += stats.writeSpeed;
        totalReadBytes += stats.readBytes;
        totalWriteBytes += stats.writeBytes;

        diskStats.push({
          device: baseDisk,
          readSpeed: stats.readSpeed,
          writeSpeed: stats.writeSpeed,
          readSpeed_human: this.formatSpeed(stats.readSpeed, user),
          writeSpeed_human: this.formatSpeed(stats.writeSpeed, user)
        });
      }
    }

    return {
      readSpeed: totalReadSpeed,
      writeSpeed: totalWriteSpeed,
      readSpeed_human: this.formatSpeed(totalReadSpeed, user),
      writeSpeed_human: this.formatSpeed(totalWriteSpeed, user),
      readBytes_total: totalReadBytes,
      writeBytes_total: totalWriteBytes,
      readBytes_total_human: this.formatBytes(totalReadBytes, user),
      writeBytes_total_human: this.formatBytes(totalWriteBytes, user),
      disks: diskStats,
      timestamp: Date.now()
    };
  }

  // ============================================================
  // DISK TEMPERATURE (with standby-safe check)
  // ============================================================

  /**
   * Get disk temperature without waking up standby disks
   * Uses smartctl -n standby to check power state first
   * @param {string} device - Device path or name
   * @returns {Object} Temperature data or null/standby status
   */
  async getDiskTemperature(device) {
    if (!device) return { device: null, temperature: null, status: 'unknown' };
    const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
    const deviceName = device.replace('/dev/', '');

    // Check cache first
    const cached = this.temperatureCache.get(deviceName);
    if (cached && (Date.now() - cached.timestamp) < this.temperatureCacheTTL) {
      return cached.data;
    }

    try {
      // NVMe, eMMC, md devices - always active, can query directly
      if (deviceName.includes('nvme') || deviceName.includes('mmc') || deviceName.match(/^md\d+$/)) {
        const temp = await this._getSmartTemperature(devicePath);
        const result = {
          device: deviceName,
          temperature: temp,
          status: 'active',
          timestamp: Date.now()
        };
        this.temperatureCache.set(deviceName, { data: result, timestamp: Date.now() });
        return result;
      }

      // For other disks: Use smartctl -n standby to check without waking
      // This returns temperature if disk is active, or standby status if not
      const { stdout } = await execPromise(
        `smartctl -n standby -A ${devicePath} 2>&1 || echo "EXIT_CODE:$?"`
      );

      // Check if disk is in standby
      if (stdout.includes('Device is in STANDBY mode') || stdout.includes('EXIT_CODE:2')) {
        const result = {
          device: deviceName,
          temperature: null,
          status: 'standby',
          timestamp: Date.now()
        };
        this.temperatureCache.set(deviceName, { data: result, timestamp: Date.now() });
        return result;
      }

      // Parse temperature from output
      let temperature = null;
      const lines = stdout.split('\n');
      for (const line of lines) {
        // Standard SATA: "Temperature_Celsius" or "Airflow_Temperature"
        // SMART format columns: ID# ATTRIBUTE_NAME FLAG VALUE WORST THRESH TYPE UPDATED WHEN_FAILED RAW_VALUE
        // Example: "194 Temperature_Celsius 0x0002 004 004 000 Old_age Always - 25 (Min/Max 18/47)"
        // RAW_VALUE is column 10 (index 9), extract first number from it
        if (line.includes('Temperature_Celsius') || line.includes('Airflow_Temperature')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10) {
            // RAW_VALUE is at index 9, extract first number (ignore Min/Max suffix)
            const rawValue = parts[9];
            const temp = parseInt(rawValue);
            // Sanity check: temperature should be reasonable (0-100°C)
            if (!isNaN(temp) && temp >= 0 && temp <= 100) {
              temperature = temp;
              break;
            }
          }
        }
        // NVMe style: "Temperature:" followed by Celsius
        if (line.includes('Temperature:') && line.includes('Celsius')) {
          const match = line.match(/(\d+)\s*Celsius/);
          if (match) {
            temperature = parseInt(match[1]);
            break;
          }
        }
      }

      const result = {
        device: deviceName,
        temperature,
        status: 'active',
        timestamp: Date.now()
      };
      this.temperatureCache.set(deviceName, { data: result, timestamp: Date.now() });
      return result;

    } catch (error) {
      const result = {
        device: deviceName,
        temperature: null,
        status: 'error',
        error: error.message,
        timestamp: Date.now()
      };
      this.temperatureCache.set(deviceName, { data: result, timestamp: Date.now() });
      return result;
    }
  }

  /**
   * Get temperatures for multiple disks
   * @param {Array<string>} devices - Array of device paths or names
   * @returns {Promise<Array>} Array of temperature data
   */
  async getMultipleDisksTemperature(devices) {
    const results = await Promise.all(
      devices.map(device => this.getDiskTemperature(device))
    );
    return results;
  }

  /**
   * Internal: Get temperature via smartctl (for always-active devices)
   * @private
   */
  async _getSmartTemperature(devicePath) {
    try {
      const { stdout } = await execPromise(`smartctl -A ${devicePath} 2>&1`);
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (line.includes('Temperature_Celsius') || line.includes('Airflow_Temperature')) {
          // SMART format: RAW_VALUE is column 10 (index 9)
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10) {
            const temp = parseInt(parts[9]);
            if (!isNaN(temp) && temp >= 0 && temp <= 100) return temp;
          }
        }
        if (line.includes('Temperature:') && line.includes('Celsius')) {
          const match = line.match(/(\d+)\s*Celsius/);
          if (match) return parseInt(match[1]);
        }
      }
      return null;
    } catch {
      return null;
    }
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

      // 3. md/nmd (Software RAID) Erkennung
      if (deviceName.match(/^(n)?md\d+/)) {
        return {
          type: 'md',
          rotational: null, // kann aus HDD oder SSD bestehen
          removable: false
        };
      }

      // 4. USB-Device Erkennung über sysfs (SAFE)
      const usbCheck = await this._checkIfUSBDeviceSafe(deviceName);
      if (usbCheck.isUSB) {
        return {
          type: 'usb',
          rotational: usbCheck.rotational,
          removable: usbCheck.isRemovable,
          usbInfo: usbCheck.usbInfo
        };
      }

      // 5. SSD vs HDD Erkennung über /sys/block/{device}/queue/rotational (SAFE)
      const rotationalInfo = await this._checkRotationalSafe(deviceName);

      // 6. Removable-Status prüfen (SAFE)
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
   * LIVE Power-Status Abfrage mit kurzem Cache (10s)
   * Diese Methode verwendet smartctl -n standby um den Power-Status zu prüfen
   * OHNE die Disk aufzuwecken (im Gegensatz zu hdparm -C)
   */
  async _getLiveDiskPowerStatus(device) {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
      const deviceName = device.replace('/dev/', '');

      // Prüfe Cache (verhindert mehrfache Abfragen derselben Disk innerhalb von 10s)
      const cacheKey = devicePath;
      const cachedEntry = this.powerStatusCache.get(cacheKey);
      if (cachedEntry && (Date.now() - cachedEntry.timestamp < this.powerStatusCacheTTL)) {
        return cachedEntry.data;
      }

      // Helper-Funktion um Result zu cachen
      const cacheAndReturn = (result) => {
        this.powerStatusCache.set(cacheKey, {
          data: result,
          timestamp: Date.now()
        });
        return result;
      };

      // Hole erweiterte Typ-Informationen (nur für Typ-Bestimmung)
      const diskTypeInfo = await this._getEnhancedDiskType(device);

      // Nur NVMe, eMMC, md und nmd sind wirklich immer aktiv (haben keinen Standby-Modus)
      // ALLE anderen Disks (HDDs, SSDs, USB mit mSATA) können in Standby gehen!
      if (diskTypeInfo.type === 'nvme' || diskTypeInfo.type === 'emmc' || diskTypeInfo.type === 'md') {
        return cacheAndReturn({
          status: 'active',
          active: true,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        });
      }

      // Zusätzliche Prüfung: nmd und Partitionen
      // nmd (Network Block Device) unterstützt auch kein Power Management
      if (deviceName.match(/^nmd\d+/) || devicePath.includes('/dev/nmd')) {
        return cacheAndReturn({
          status: 'active',
          active: true,
          type: 'nmd',
          rotational: null,
          removable: false,
          usbInfo: null
        });
      }

      // Partitionen können nicht in Standby gehen (nur ganze Disks)
      // Bei Partitionen: Prüfe die zugrunde liegende Basis-Disk!
      // NVMe Partitionen: nvme0n1p1 -> nvme0n1, SATA/SCSI Partitionen: sda1 -> sda
      const endsWithDigit = deviceName.match(/\d+$/);
      const isSpecialDevice = deviceName.match(/^(nvme\d+n\d+|md\d+|nmd\d+)$/);

      if (endsWithDigit && !isSpecialDevice) {
        // Das ist eine Partition - ermittle die Basis-Disk und prüfe deren Status
        // Ermittle Basis-Disk:
        // NVMe: nvme0n1p1 -> nvme0n1 (remove p\d+)
        // SATA/SCSI: sda1 -> sda (remove \d+)
        let baseDisk;
        if (deviceName.match(/^nvme\d+n\d+p\d+$/)) {
          // NVMe Partition
          baseDisk = deviceName.replace(/p\d+$/, '');
        } else {
          // SATA/SCSI Partition
          baseDisk = deviceName.replace(/\d+$/, '');
        }

        // Rekursiv die Basis-Disk prüfen (nutzt automatisch den Cache für die Basis-Disk)
        const baseDiskStatus = await this._getLiveDiskPowerStatus(baseDisk);

        return cacheAndReturn({
          status: baseDiskStatus.status,
          active: baseDiskStatus.active,
          type: 'partition',
          baseDisk: baseDisk,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        });
      }

      // Für ALLE anderen Disks: smartctl -n standby (weckt die Disk NICHT auf!)
      // Das schließt ein: HDDs, SSDs, USB-Disks mit echten SSDs/HDDs
      try {
        // smartctl -n standby: Prüft Power-Status OHNE die Disk aufzuwecken
        // Exit Code 0: Disk ist active/idle
        // Exit Code 2: Disk ist in STANDBY (und wurde NICHT aufgeweckt)
        // Andere: Fehler oder nicht unterstützt
        const { stdout, stderr } = await execPromise(
          `smartctl -n standby -i ${devicePath} 2>&1 || echo "EXIT_CODE:$?"`
        );

        let status = 'active';
        let active = true;

        // Parse smartctl output
        const output = stdout + stderr;

        // Check for standby mode (exit code 2 oder Text-Meldung)
        if (output.includes('Device is in STANDBY mode') ||
            output.includes('EXIT_CODE:2')) {
          status = 'standby';
          active = false;
        }
        // Check for active/idle mode
        else if (output.includes('Device is in ACTIVE or IDLE mode') ||
                 output.includes('ACTIVE') ||
                 output.includes('IDLE')) {
          status = 'active';
          active = true;
        }
        // Check for sleep mode
        else if (output.includes('SLEEP')) {
          status = 'standby'; // treat sleep as standby
          active = false;
        }
        // Device doesn't support power mode check
        else if (output.includes('does not support') ||
                 output.includes('Unable to detect') ||
                 output.includes('Unknown USB bridge')) {
          // Annahme: Wenn nicht unterstützt, ist die Disk wahrscheinlich aktiv
          // (z.B. SSDs die kein Power-Management haben)
          status = 'active';
          active = true;
        }

        return cacheAndReturn({
          status,
          active,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        });

      } catch (smartctlError) {
        // smartctl failed completely - device doesn't support SMART or other error
        console.warn(`smartctl -n standby failed for ${devicePath}: ${smartctlError.message}`);
        return cacheAndReturn({
          status: 'unknown',
          active: null,
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo,
          error: `Power status check not supported: ${smartctlError.message}`
        });
      }

    } catch (error) {
      // Bei generellen Fehlern NICHT cachen, da das ein temporäres Problem sein könnte
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
   * Verwendet smartctl -n standby (weckt die Disk NICHT auf)
   * Für Pool-Services verwende _getEnhancedDiskTypeForPools()
   */
  async _getDiskPowerStatus(device) {
    // Diese Methode verwendet jetzt die gleiche Logik wie _getLiveDiskPowerStatus
    return await this._getLiveDiskPowerStatus(device);
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
   * Prüft ob eine einzelne Partition eine System-Partition ist
   * @param {string} partitionDevice - Partition device path (z.B. /dev/sda1)
   * @param {Map} mounts - Pre-loaded mounts map (optional)
   * @returns {Promise<boolean>} true wenn System-Partition
   */
  async _isSystemPartition(partitionDevice, mounts = null) {
    try {
      if (!mounts) {
        mounts = await this._getMountInfo();
      }

      const mountInfo = mounts.get(partitionDevice);
      if (!mountInfo) {
        return false; // Nicht gemountet = keine System-Partition
      }

      const mp = mountInfo.mountpoint;

      // System-relevante Mount-Punkte
      if (mp === '/boot' || mp === '/' || mp === '/usr' || mp === '/var' ||
          mp === '/etc' || mp.startsWith('/mnt/system') || mp === '/boot/efi') {
        return true;
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
   * Resolve device mapper to underlying physical device(s) - SAFE VERSION
   * Uses /sys/block/dm-X/slaves/ to find the underlying devices WITHOUT waking up disks
   * @param {string} device - Device mapper path (e.g., /dev/mapper/luks-xyz or /dev/dm-0)
   * @returns {Promise<Array>} Array of underlying device paths
   */
  async _resolveDeviceMapperToPhysical(device) {
    try {
      let dmName;

      // Handle both /dev/mapper/name and /dev/dm-X formats
      if (device.includes('/dev/mapper/')) {
        // For /dev/mapper/name, we need to find the corresponding dm-X
        const mapperName = device.replace('/dev/mapper/', '');

        // Read /sys/block/ to find the dm-X that corresponds to this mapper name
        try {
          const blockDevices = await fs.readdir('/sys/block');
          for (const blockDev of blockDevices) {
            if (blockDev.startsWith('dm-')) {
              // Check if this dm-X has the same name
              const namePath = `/sys/block/${blockDev}/dm/name`;
              try {
                const name = (await fs.readFile(namePath, 'utf8')).trim();
                if (name === mapperName) {
                  dmName = blockDev;
                  break;
                }
              } catch (error) {
                // Continue searching
              }
            }
          }
        } catch (error) {
          return [];
        }

        if (!dmName) {
          return [];
        }
      } else if (device.includes('/dev/dm-')) {
        // Direct dm-X format
        dmName = device.replace('/dev/', '');
      } else {
        // Not a device mapper
        return [];
      }

      // Read slaves directory to find underlying devices
      const slavesPath = `/sys/block/${dmName}/slaves`;
      const slaves = await fs.readdir(slavesPath);

      // Convert slave names to full device paths
      const physicalDevices = slaves.map(slave => `/dev/${slave}`);

      return physicalDevices;

    } catch (error) {
      // Not a device mapper or error reading slaves
      return [];
    }
  }

  /**
   * Check if a device is the underlying physical device of a device mapper - SAFE VERSION
   * @param {string} physicalDevice - Physical device to check (e.g., /dev/sda1)
   * @param {string} mapperDevice - Device mapper to check (e.g., /dev/mapper/luks-xyz)
   * @returns {Promise<boolean>} True if physicalDevice is underlying mapperDevice
   */
  async _isPhysicalDeviceOfMapper(physicalDevice, mapperDevice) {
    try {
      const underlyingDevices = await this._resolveDeviceMapperToPhysical(mapperDevice);
      return underlyingDevices.includes(physicalDevice);
    } catch (error) {
      return false;
    }
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
   * @param {string} device - Device to check
   * @param {Array} pools - Pre-loaded pools list (optional, will load if not provided)
   * @param {Map} mounts - Pre-loaded mounts map (optional, will load if not provided)
   */
  async _isDiskInUse(device, pools = null, mounts = null) {
    try {
      // Check pool membership using UUID-based approach
      try {
        // Use provided pools or load them
        if (!pools) {
          const PoolsServiceClass = require('./pools.service');
          const poolsService = new PoolsServiceClass();
          pools = await poolsService.listPools({});
        }

        // Get all UUIDs that belong to this device by reading /dev/disk/by-uuid/
        const deviceUuids = await this._getDeviceUuidsBySymlinks(device);

        for (const pool of pools) {
          // Check data_devices
          if (pool.data_devices) {
            for (const poolDevice of pool.data_devices) {
              // Check by device path first (catches partitions like /dev/sdf1 from /dev/sdf)
              if (poolDevice.device &&
                  (poolDevice.device === device || this._isPartitionOfDevice(poolDevice.device, device))) {
                return {
                  inUse: true,
                  reason: 'in_pool_data',
                  poolName: pool.name || 'unknown',
                  poolDevice: poolDevice.device
                };
              }

              // Skip UUID check if no ID
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

              // NEW: Check if pool device is a device mapper and our device is the underlying physical device
              if (poolDevice.device &&
                  (poolDevice.device.includes('/dev/mapper/') || poolDevice.device.includes('/dev/dm-'))) {
                const isUnderlying = await this._isPhysicalDeviceOfMapper(device, poolDevice.device);
                if (isUnderlying) {
                  return {
                    inUse: true,
                    reason: 'in_pool_data_via_mapper',
                    poolName: pool.name || 'unknown',
                    poolDevice: poolDevice.device,
                    mapperDevice: poolDevice.device,
                    physicalDevice: device
                  };
                }

                // Also check if any partition of our device is the underlying physical device
                const devicePartitions = await this._getPartitions(device);
                for (const partition of devicePartitions) {
                  const isPartitionUnderlying = await this._isPhysicalDeviceOfMapper(partition.device, poolDevice.device);
                  if (isPartitionUnderlying) {
                    return {
                      inUse: true,
                      reason: 'in_pool_data_via_mapper',
                      poolName: pool.name || 'unknown',
                      poolDevice: poolDevice.device,
                      mapperDevice: poolDevice.device,
                      physicalDevice: partition.device
                    };
                  }
                }
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

              // NEW: Check if parity device is a device mapper and our device is the underlying physical device
              if (parityDevice.device &&
                  (parityDevice.device.includes('/dev/mapper/') || parityDevice.device.includes('/dev/dm-'))) {
                const isUnderlying = await this._isPhysicalDeviceOfMapper(device, parityDevice.device);
                if (isUnderlying) {
                  return {
                    inUse: true,
                    reason: 'in_pool_parity_via_mapper',
                    poolName: pool.name || 'unknown',
                    poolDevice: parityDevice.device,
                    mapperDevice: parityDevice.device,
                    physicalDevice: device
                  };
                }

                // Also check if any partition of our device is the underlying physical device
                const devicePartitions = await this._getPartitions(device);
                for (const partition of devicePartitions) {
                  const isPartitionUnderlying = await this._isPhysicalDeviceOfMapper(partition.device, parityDevice.device);
                  if (isPartitionUnderlying) {
                    return {
                      inUse: true,
                      reason: 'in_pool_parity_via_mapper',
                      poolName: pool.name || 'unknown',
                      poolDevice: parityDevice.device,
                      mapperDevice: parityDevice.device,
                      physicalDevice: partition.device
                    };
                  }
                }
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
      // Use provided mounts or load them
      if (!mounts) {
        mounts = await this._getMountInfo();
      }

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

      // NEW: Check if any mounted device is a device mapper and our device (or its partitions) is the underlying physical device
      for (const [mountedDevice, mountInfo] of mounts) {
        if (mountedDevice.includes('/dev/mapper/') || mountedDevice.includes('/dev/dm-')) {
          // Check if the whole disk is the underlying device
          const isUnderlying = await this._isPhysicalDeviceOfMapper(device, mountedDevice);
          if (isUnderlying) {
            return {
              inUse: true,
              reason: 'mounted_via_mapper',
              mapperDevice: mountedDevice,
              physicalDevice: device,
              mountpoint: mountInfo.mountpoint,
              filesystem: mountInfo.fstype
            };
          }

          // Check if any partition of our device is the underlying device
          const devicePartitions = await this._getPartitions(device);
          for (const partition of devicePartitions) {
            const isPartitionUnderlying = await this._isPhysicalDeviceOfMapper(partition.device, mountedDevice);
            if (isPartitionUnderlying) {
              return {
                inUse: true,
                reason: 'mounted_partition_via_mapper',
                mapperDevice: mountedDevice,
                physicalDevice: partition.device,
                mountpoint: mountInfo.mountpoint,
                filesystem: mountInfo.fstype
              };
            }
          }
        }
      }

      // Note: BTRFS multi-device detection is now handled in getUnassignedDisks via blkidCache

      return { inUse: false };
    } catch (error) {
      return { inUse: false };
    }
  }

  /**
   * Check if a device is part of a mounted BTRFS multi-device filesystem
   * @param {string} device - Device path to check
   * @returns {Promise<Object>} Usage information
   */
  async _checkBtrfsUsage(device) {
    try {
      // Get device UUID and filesystem type
      const { stdout: blkidOut } = await execPromise(`blkid ${device} 2>/dev/null || echo ""`);

      if (!blkidOut.trim()) {
        return { inUse: false };
      }

      const uuidMatch = blkidOut.match(/UUID="([^"]+)"/);
      const typeMatch = blkidOut.match(/TYPE="([^"]+)"/);

      // Not a BTRFS device
      if (!typeMatch || typeMatch[1] !== 'btrfs') {
        return { inUse: false };
      }

      if (!uuidMatch) {
        return { inUse: false };
      }

      const deviceUuid = uuidMatch[1];

      // Check if this BTRFS UUID is mounted somewhere
      const mounts = await this._getMountInfo();

      for (const [mountedDevice, mountInfo] of mounts) {
        if (mountInfo.fstype === 'btrfs') {
          try {
            const { stdout: mountedBlkidOut } = await execPromise(`blkid ${mountedDevice} 2>/dev/null || echo ""`);
            const mountedUuidMatch = mountedBlkidOut.match(/UUID="([^"]+)"/);

            if (mountedUuidMatch && mountedUuidMatch[1] === deviceUuid) {
              // Found a mounted device with the same BTRFS UUID
              return {
                inUse: true,
                reason: 'btrfs_multi_device',
                uuid: deviceUuid,
                mountpoint: mountInfo.mountpoint,
                primaryDevice: mountedDevice,
                filesystem: 'btrfs'
              };
            }
          } catch (error) {
            // Ignore errors for individual devices
          }
        }
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
        // Only physical disks, no partitions, loop devices, md partitions or ZRAM (ZRAM handled separately)
        if (disk.type !== 'disk' || disk.name.includes('loop') || disk.name.match(/md\d+p\d+/) || disk.name.match(/^zram\d+/)) {
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
            standbySkipped: true,
            preclearRunning: this.isPreclearRunning(device)
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
          standbySkipped: false,
          preclearRunning: this.isPreclearRunning(device)
        });
      }

      // Add ZRAM ramdisks (not swaps) to the list
      const zramRamdisks = await this.getZramRamdisks(user);
      for (const ramdisk of zramRamdisks) {
        disks.push({
          device: ramdisk.device,
          name: ramdisk.device.replace('/dev/', ''),
          model: ramdisk.name,
          serial: ramdisk.id,
          size: ramdisk.size,
          size_human: ramdisk.sizeHuman,
          powerStatus: 'active',
          type: 'ramdisk',
          rotational: false,
          removable: false,
          partitions: [],
          performance: null,
          standbySkipped: false,
          isZram: true,
          zramConfig: {
            algorithm: ramdisk.algorithm,
            filesystem: ramdisk.filesystem,
            uuid: ramdisk.uuid
          },
          preclearRunning: false // ZRAM devices cannot have preClear
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
   * Get all physical block devices from /dev/disk/by-diskseq/
   * This is SAFE - only reads symlinks, doesn't access disks
   * @returns {Promise<Set<string>>} Set of device paths (e.g., /dev/sda, /dev/nvme0n1)
   * @private
   */
  async _getAllPhysicalDevices() {
    const devices = new Set();

    try {
      const diskseqDir = '/dev/disk/by-diskseq';
      const diskseqFiles = await fs.readdir(diskseqDir);

      for (const file of diskseqFiles) {
        try {
          const symlinkPath = path.join(diskseqDir, file);
          const realPath = await fs.realpath(symlinkPath);

          // Extract device name (e.g., sda, nvme0n1)
          const deviceName = path.basename(realPath);

          // Filter out unwanted devices (only symlinks, no disk access!)
          // Exclude: loop devices, ram disks, dm-devices, CD-ROMs, etc.
          if (deviceName.match(/^loop\d+$/)) continue;        // loop0, loop1, ...
          if (deviceName.match(/^ram\d+$/)) continue;         // ram0, ram1, ...
          if (deviceName.match(/^dm-\d+$/)) continue;         // dm-0, dm-1, ... (device mapper)
          if (deviceName.match(/^sr\d+$/)) continue;          // sr0, sr1, ... (CD-ROM)
          if (deviceName.match(/^zram\d+$/)) continue;        // zram0, zram1, ...
          if (deviceName.match(/^nbd\d+$/)) continue;         // nbd0, nbd1, ... (network block device)
          if (deviceName.match(/^nmd\d+$/)) continue;         // nmd0, nmd1, ... (nonraid md device)

          // Only include physical disks: sd*, nvme*, mmc*, md*
          if (deviceName.match(/^(sd[a-z]+|nvme\d+n\d+|mmc\w+|md\d+)$/)) {
            devices.add(realPath);
          }
        } catch (error) {
          // Skip broken symlinks or inaccessible devices
          continue;
        }
      }
    } catch (error) {
      // /dev/disk/by-diskseq/ might not exist on older systems
      console.warn('Could not read /dev/disk/by-diskseq/:', error.message);
    }

    return devices;
  }

  /**
   * Find unassigned disks
   * @param {Object} options - Options for disk listing
   * @param {Object} user - User object with byte_format preference
   */
  async getUnassignedDisks(options = {}, user = null) {
    try {
      // Ensure skipStandby is true by default to avoid waking up disks
      const diskOptions = { skipStandby: true, ...options };
      const allDisks = await this.getAllDisks(diskOptions, user);
      const unassignedDisks = [];

      // Load pools once - listPools() automatically injects real device paths via symlinks (no disk access)
      let pools = [];
      try {
        const PoolsServiceClass = require('./pools.service');
        const poolsService = new PoolsServiceClass();
        pools = await poolsService.listPools({});
      } catch (error) {
        console.warn('Failed to load pools:', error.message);
      }

      // Load active ZRAM swaps to filter them out
      const zramSwaps = new Set();
      try {
        const { stdout } = await execPromise('cat /proc/swaps');
        const lines = stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/^(\/dev\/zram\d+)/);
          if (match) {
            zramSwaps.add(match[1]);
          }
        }
      } catch {
        // Ignore errors
      }

      // Load mounts once
      const mounts = await this._getMountInfo();

      // Build set of devices used in pools (both original device AND base disk)
      const poolDisks = new Set();

      // Load ZFS pool devices (native zpool, not managed by pools.json)
      try {
        const { stdout: zpoolList } = await execPromise('zpool list -H -o name 2>/dev/null || true');
        const zpoolNames = zpoolList.trim().split('\n').filter(name => name);

        for (const zpoolName of zpoolNames) {
          try {
            // Get devices from zpool status - parse the VDEV tree
            const { stdout: zpoolStatus } = await execPromise(`zpool status -P ${zpoolName} 2>/dev/null || true`);
            const lines = zpoolStatus.split('\n');

            for (const line of lines) {
              // Match device paths like /dev/sda, /dev/sdb1, /dev/disk/by-id/...
              const deviceMatch = line.match(/^\s+(\/dev\/\S+)/);
              if (deviceMatch) {
                let device = deviceMatch[1];

                // Resolve symlinks (e.g., /dev/disk/by-id/... -> /dev/sda)
                try {
                  const { stdout: realPath } = await execPromise(`readlink -f "${device}"`);
                  device = realPath.trim();
                } catch {
                  // Keep original path if readlink fails
                }

                // Add both the device and its base disk
                poolDisks.add(device);
                poolDisks.add(this._getBaseDisk(device));
              }
            }
          } catch {
            // Ignore errors for individual pools
          }
        }
      } catch {
        // ZFS not installed or no pools - ignore
      }
      for (const pool of pools) {
        // Collect data devices
        if (pool.data_devices) {
          for (const device of pool.data_devices) {
            if (device.device) {
              // Add both the actual device (e.g., /dev/sdb3) AND the base disk (e.g., /dev/sdb)
              poolDisks.add(device.device);
              poolDisks.add(this._getBaseDisk(device.device));
            }
          }
        }
        // Collect parity devices
        if (pool.parity_devices) {
          for (const device of pool.parity_devices) {
            if (device.device) {
              // Add both the actual device AND the base disk
              poolDisks.add(device.device);
              poolDisks.add(this._getBaseDisk(device.device));
            }
          }
        }
      }

      // Check each disk
      for (const disk of allDisks) {
        // Skip ZRAM devices (handled separately - swaps filtered, ramdisks via pools)
        if (this.isZramDevice(disk.device)) {
          continue;
        }

        // Check if disk is a system disk
        const isSystem = await this._isSystemDisk(disk.device);

        if (isSystem) {
          // System disk - check for 3rd partition (or higher) that could be used as storage
          // Typical layout: p1 = EFI/boot, p2 = root, p3+ = extra storage
          if (disk.partitions && disk.partitions.length >= 3) {
            for (const partition of disk.partitions) {
              // Extract partition number from device name
              // sda3 -> 3, nvme0n1p3 -> 3
              const partNumMatch = partition.device.match(/(\d+)$/);
              if (!partNumMatch) continue;
              const partNum = parseInt(partNumMatch[1]);

              // Only consider partition 3 or higher
              if (partNum < 3) {
                continue;
              }

              // Skip system partitions (just in case p3 is used for /var or similar)
              const isSystemPartition = await this._isSystemPartition(partition.device, mounts);
              if (isSystemPartition) {
                continue;
              }

              // Skip swap partitions
              if (partition.mountpoint === '[SWAP]') {
                continue;
              }

              // Skip partitions already in a pool
              if (poolDisks.has(partition.device)) {
                continue;
              }

              // Skip partitions mounted at pool-related paths
              if (partition.mountpoint &&
                  (partition.mountpoint.startsWith('/mnt/disks/') ||
                   partition.mountpoint.startsWith('/mnt/remotes/'))) {
                continue;
              }

              // This is partition 3+ on the boot disk - add as unassigned
              unassignedDisks.push({
                device: partition.device,
                name: partition.device.replace('/dev/', ''),
                size: partition.size,
                size_human: this.formatBytes(partition.size, user),
                type: disk.type,
                rotational: disk.rotational,
                removable: disk.removable,
                model: disk.model,
                serial: disk.serial,
                powerStatus: disk.powerStatus,
                partitions: [],
                filesystem: partition.filesystem,
                uuid: partition.uuid,
                label: partition.label,
                isPartition: true,
                parentDisk: disk.device
              });
            }
          }
          continue;
        }

        // Check if disk is in a pool
        if (poolDisks.has(disk.device)) {
          continue;
        }

        // Check if disk has partitions mounted outside of pools
        if (disk.partitions && disk.partitions.length > 0) {
          const hasOtherMounts = disk.partitions.some(p =>
            p.mountpoint &&
            p.mountpoint !== '[SWAP]' &&
            !p.mountpoint.startsWith('/mnt/disks/') &&
            !p.mountpoint.startsWith('/mnt/remotes/')
          );

          if (hasOtherMounts) {
            continue;
          }

          // Has partitions but not mounted elsewhere - unassigned
          unassignedDisks.push({
            ...disk
          });
        } else {
          // No partitions and not in use - unassigned
          unassignedDisks.push({
            ...disk
          });
        }
      }

      // Add unmounted ZRAM ramdisks to unassigned
      const zramRamdisks = await this.getZramRamdisks(user);
      for (const ramdisk of zramRamdisks) {
        // Check if already in a pool
        const isInPool = pools.some(pool =>
          pool.data_devices?.some(d => d.device === ramdisk.device)
        );
        if (isInPool) continue;

        // Check if mounted
        try {
          const { stdout } = await execPromise('cat /proc/mounts');
          if (stdout.includes(ramdisk.device)) continue;
        } catch {
          // Ignore errors
        }

        // Not in pool and not mounted - add as unassigned
        unassignedDisks.push({
          device: ramdisk.device,
          name: ramdisk.device.replace('/dev/', ''),
          model: ramdisk.name,
          serial: ramdisk.id,
          size: ramdisk.size,
          size_human: ramdisk.sizeHuman,
          powerStatus: 'active',
          type: 'ramdisk',
          rotational: false,
          removable: false,
          partitions: [],
          filesystem: ramdisk.filesystem,
          uuid: ramdisk.uuid,
          isZram: true,
          zramConfig: {
            algorithm: ramdisk.algorithm,
            filesystem: ramdisk.filesystem,
            uuid: ramdisk.uuid
          }
        });
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
   * Helper to get base disk from partition
   * @param {string} device - Device path
   * @returns {string} Base disk path
   * @private
   */
  _getBaseDisk(device) {
    const deviceName = device.replace('/dev/', '');

    // NVMe: nvme0n1p1 -> nvme0n1
    if (deviceName.match(/^nvme\d+n\d+p\d+$/)) {
      return '/dev/' + deviceName.replace(/p\d+$/, '');
    }

    // SATA/SCSI: sda1 -> sda
    if (deviceName.match(/^[a-z]+\d+$/)) {
      return '/dev/' + deviceName.replace(/\d+$/, '');
    }

    // Not a partition or unknown format
    return device;
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

      // Einfache Prüfung: Nur NVMe, eMMC, md und nmd überspringen (ohne komplexe Disk-Typ-Erkennung)
      // Diese einfache Prüfung weckt garantiert keine Disks auf
      if (deviceName.includes('nvme') || deviceName.includes('mmc') ||
          devicePath.includes('/dev/md') || devicePath.includes('/dev/nmd')) {
        return {
          success: true,
          message: 'NVMe/eMMC/md device is always active',
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

          // Prüfe den aktuellen Power-Status mit smartctl
          const powerStatus = await this._getLiveDiskPowerStatus(devicePath);
          const isAwake = powerStatus.status === 'active';

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
              currentStatus: powerStatus.status
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
   * Wait for disk to go to standby (timeout 12s)
   */
  async sleepDisk(device, mode = 'standby') {
    try {
      const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;

      // NVMe, md und nmd devices don't reliably support power management via nvme-cli
      // Many NVMe controllers don't implement the power management features properly
      // md/nmd devices sind Software RAID und haben kein Power Management
      if (device.includes('nvme') || device.includes('/dev/md') || device.includes('/dev/nmd')) {
        return {
          success: false,
          message: 'NVMe/md/nmd devices do not reliably support standby mode',
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

      // Wait for standby confirmation (max 12s, poll every 1s)
      this.powerStatusCache.delete(devicePath);
      const startTime = Date.now();

      while (Date.now() - startTime < 12000) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        this.powerStatusCache.delete(devicePath);

        const powerStatus = await this._getLiveDiskPowerStatus(devicePath);
        if (powerStatus.status === 'standby' || powerStatus.active === false) {
          break;
        }
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

  // ============================================================
  // PRECLEAR OPERATIONS
  // ============================================================

  /**
   * Send notification via mos-notify socket
   * @private
   */
  async _sendNotification(title, message, priority = 'normal', delayMs = 1000) {
    return new Promise((resolve) => {
      const client = net.createConnection(MOS_NOTIFY_SOCKET, () => {
        const payload = JSON.stringify({ title, message, priority });
        client.write(payload);
        client.end();
        // Add delay after sending to ensure proper ordering
        setTimeout(() => resolve(true), delayMs);
      });
      client.on('error', () => {
        // Ignore notification errors - non-critical
        setTimeout(() => resolve(false), delayMs);
      });
    });
  }

  /**
   * Check if preClear is running on a device
   * @param {string} device - Device path or name
   * @returns {boolean}
   */
  isPreclearRunning(device) {
    const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
    return this.preclearRunning.has(devicePath);
  }

  /**
   * Get preClear status for a device
   * @param {string} device - Device path or name
   * @returns {Object|null}
   */
  getPreclearStatus(device) {
    const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
    return this.preclearRunning.get(devicePath) || null;
  }

  /**
   * Abort preClear operation on a device
   * @param {string} device - Device path or name
   * @returns {Object} Result
   */
  async abortPreClear(device) {
    const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
    const deviceName = devicePath.replace('/dev/', '');

    if (!this.preclearRunning.has(devicePath)) {
      throw new Error(`No preClear operation running on ${devicePath}`);
    }

    const processInfo = this.preclearProcesses.get(devicePath);
    if (processInfo && processInfo.process) {
      processInfo.aborted = true;
      processInfo.process.kill('SIGTERM');

      // Wait a bit and force kill if still running
      setTimeout(() => {
        if (processInfo.process && !processInfo.process.killed) {
          processInfo.process.kill('SIGKILL');
        }
      }, 2000);
    }

    // Clean up
    this.preclearRunning.delete(devicePath);
    this.preclearProcesses.delete(devicePath);

    // Send notification
    await this._sendNotification(
      'Preclear',
      `Preclear aborted on ${deviceName}`,
      'normal'
    );

    return {
      success: true,
      message: `Preclear operation on ${devicePath} aborted`,
      device: devicePath
    };
  }

  /**
   * Execute a single wipe pass on a device
   * @private
   * @param {string} devicePath - Device path
   * @param {string} algorithm - 'zero', 'ff', or 'random'
   * @returns {Promise<boolean>} Success
   */
  async _executeWipePass(devicePath, algorithm) {
    return new Promise((resolve, reject) => {
      let ddProcess;
      const processInfo = this.preclearProcesses.get(devicePath);

      if (processInfo && processInfo.aborted) {
        return reject(new Error('Operation aborted'));
      }

      // Build dd command based on algorithm
      if (algorithm === 'zero') {
        // Write zeros
        ddProcess = spawn('dd', [
          'if=/dev/zero',
          `of=${devicePath}`,
          'bs=1M',
          'status=none'
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
      } else if (algorithm === 'ff') {
        // Write 0xFF (all ones) using tr to convert zeros to 0xFF
        ddProcess = spawn('sh', [
          '-c',
          `tr '\\0' '\\377' < /dev/zero | dd of=${devicePath} bs=1M status=none`
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
      } else if (algorithm === 'random') {
        // Write random data
        ddProcess = spawn('dd', [
          'if=/dev/urandom',
          `of=${devicePath}`,
          'bs=1M',
          'status=none'
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
      } else {
        return reject(new Error(`Unknown algorithm: ${algorithm}`));
      }

      // Store process for abort capability
      if (processInfo) {
        processInfo.process = ddProcess;
      }

      let stderrData = '';
      ddProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
      });

      ddProcess.on('close', (code) => {
        // dd returns 0 on success, but also returns non-zero when disk is full (expected)
        // Check if it was aborted
        if (processInfo && processInfo.aborted) {
          return reject(new Error('Operation aborted'));
        }

        // dd exits with code 1 when it reaches end of disk (no space left), which is expected
        if (code === 0 || stderrData.includes('No space left')) {
          resolve(true);
        } else {
          reject(new Error(`dd failed with code ${code}: ${stderrData}`));
        }
      });

      ddProcess.on('error', (err) => {
        reject(new Error(`Failed to start dd: ${err.message}`));
      });
    });
  }

  /**
   * Execute read check to verify all sectors are zero
   * @private
   * @param {string} devicePath - Device path
   * @param {boolean} enableLog - Whether to log bad sectors
   * @returns {Promise<Object>} Result with success and badSectors count
   */
  async _executeReadCheck(devicePath, enableLog) {
    const deviceName = devicePath.replace('/dev/', '');
    let logFile = null;
    let logSize = 0;
    let logTruncated = false;
    const badOffsets = [];

    // Create log directory and file if logging enabled
    if (enableLog) {
      try {
        await fs.mkdir(PRECLEAR_LOG_DIR, { recursive: true });
        const logPath = path.join(PRECLEAR_LOG_DIR, `${deviceName}.log`);
        logFile = await fs.open(logPath, 'w');
        await logFile.write(`# Preclear ReadCheck Log for ${devicePath}\n`);
        await logFile.write(`# Started: ${new Date().toISOString()}\n`);
        await logFile.write(`# Non-zero byte offsets:\n`);
        logSize = 100;
      } catch (err) {
        console.error(`Failed to create preclear log: ${err.message}`);
        logFile = null;
      }
    }

    const processInfo = this.preclearProcesses.get(devicePath);

    return new Promise((resolve, reject) => {
      // Use cmp to compare device with /dev/zero - this is MUCH faster
      // cmp -l outputs: byte_offset decimal_value_in_file decimal_value_expected
      // We limit output to prevent massive logs
      const cmpProcess = spawn('sh', [
        '-c',
        `cmp -l ${devicePath} /dev/zero 2>/dev/null | head -n 10000`
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      // Store process for abort capability
      if (processInfo) {
        processInfo.process = cmpProcess;
      }

      let outputData = '';

      cmpProcess.stdout.on('data', (data) => {
        outputData += data.toString();
      });

      cmpProcess.on('close', async (code) => {
        // Check if aborted
        if (processInfo && processInfo.aborted) {
          if (logFile) await logFile.close();
          return reject(new Error('Operation aborted'));
        }

        // Parse output - each line is: offset byte1 byte2
        const lines = outputData.trim().split('\n').filter(l => l.trim());
        const badCount = lines.length;

        // Log bad offsets if logging enabled
        if (logFile && badCount > 0) {
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts[0]) {
              const offset = parts[0];
              if (!logTruncated) {
                const logEntry = `${offset}\n`;
                if (logSize + logEntry.length < PRECLEAR_LOG_MAX_SIZE) {
                  await logFile.write(logEntry);
                  logSize += logEntry.length;
                } else {
                  logTruncated = true;
                  await logFile.write(`\n# Log file size limit (5MB) exceeded. Further offsets not recorded.\n`);
                }
              }
            }
          }
        }

        // Finalize log
        if (logFile) {
          await logFile.write(`\n# Completed: ${new Date().toISOString()}\n`);
          await logFile.write(`# Total non-zero bytes found: ${badCount}${badCount >= 10000 ? '+' : ''}\n`);
          await logFile.close();
        }

        // code 0 = identical, code 1 = different, code 2 = error
        // If we got output, there are differences
        resolve({
          success: badCount === 0,
          badBlocks: badCount,
          logTruncated
        });
      });

      cmpProcess.on('error', async (err) => {
        if (logFile) await logFile.close();
        reject(new Error(`ReadCheck failed: ${err.message}`));
      });
    });
  }

  /**
   * Execute preClear operation on a device
   * @param {string} device - Device path or name
   * @param {Object} options - Preclear options
   * @returns {Promise<Object>} Result
   */
  async preClearDisk(device, options = {}) {
    const { wipes = 1, algorithm = 'zero', readCheck = false, log = false } = options;
    const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
    const deviceName = devicePath.replace('/dev/', '');

    // Validate
    if (this.preclearRunning.has(devicePath)) {
      throw new Error(`Preclear already running on ${devicePath}`);
    }

    const validAlgorithms = ['zero', 'ff', 'random', 'one-zero'];
    if (!validAlgorithms.includes(algorithm)) {
      throw new Error(`Invalid algorithm. Must be one of: ${validAlgorithms.join(', ')}`);
    }

    const effectiveWipes = Math.min(Math.max(1, wipes), 4); // 1-4

    // one-zero requires even number of wipes
    if (algorithm === 'one-zero' && effectiveWipes % 2 !== 0) {
      throw new Error('Algorithm one-zero requires an even number of wipes (2 or 4)');
    }

    // readCheck only valid for zero or one-zero (ends with zero)
    if (readCheck && algorithm !== 'zero' && algorithm !== 'one-zero') {
      throw new Error('readCheck is only available for algorithms zero and one-zero');
    }

    // Check if system disk
    const isSystem = await this._isSystemDisk(devicePath);
    if (isSystem) {
      throw new Error('Cannot preClear system disk');
    }

    // Algorithm display names for notifications
    const algorithmNames = {
      'zero': 'All Zeros',
      'ff': 'All Ones',
      'random': 'Random',
      'one-zero': 'One-Zero'
    };
    const algorithmDisplayName = algorithmNames[algorithm] || algorithm;

    // Initialize tracking
    this.preclearRunning.set(devicePath, {
      algorithm,
      currentPass: 0,
      totalPasses: effectiveWipes,
      readCheck,
      startedAt: new Date().toISOString()
    });
    this.preclearProcesses.set(devicePath, { process: null, aborted: false });

    // Send start notification
    await this._sendNotification(
      'Preclear',
      `Preclear started on ${deviceName} (${algorithmDisplayName}, ${effectiveWipes} pass${effectiveWipes > 1 ? 'es' : ''})`,
      'normal'
    );

    // Run wipe passes
    try {
      for (let pass = 1; pass <= effectiveWipes; pass++) {
        // Update status
        const status = this.preclearRunning.get(devicePath);
        if (status) {
          status.currentPass = pass;
        }

        // Determine algorithm for this pass
        let passAlgorithm = algorithm;
        let passAlgorithmDisplay = algorithmDisplayName;
        if (algorithm === 'one-zero') {
          // Odd passes: ff (All Ones), Even passes: zero (All Zeros)
          passAlgorithm = (pass % 2 === 1) ? 'ff' : 'zero';
          passAlgorithmDisplay = (pass % 2 === 1) ? 'All Ones' : 'All Zeros';
        }

        // Send pass start notification
        await this._sendNotification(
          'Preclear',
          `Pass ${pass}/${effectiveWipes} started on ${deviceName} (${passAlgorithmDisplay})`,
          'normal'
        );

        // Execute wipe
        await this._executeWipePass(devicePath, passAlgorithm);

        // Send pass complete notification
        await this._sendNotification(
          'Preclear',
          `Pass ${pass}/${effectiveWipes} completed on ${deviceName}`,
          'normal'
        );
      }

      // Execute read check if requested
      let readCheckResult = null;
      if (readCheck) {
        await this._sendNotification(
          'Preclear',
          `ReadCheck started on ${deviceName}`,
          'normal'
        );

        readCheckResult = await this._executeReadCheck(devicePath, log);

        if (readCheckResult.success) {
          await this._sendNotification(
            'Preclear',
            `ReadCheck completed on ${deviceName}: OK`,
            'normal'
          );
        } else {
          await this._sendNotification(
            'Preclear',
            `ReadCheck failed on ${deviceName}: ${readCheckResult.badSectors} bad sector(s)`,
            'alert'
          );

          // Clean up and throw error
          this.preclearRunning.delete(devicePath);
          this.preclearProcesses.delete(devicePath);

          throw new Error(`ReadCheck failed: ${readCheckResult.badSectors} bad sector(s) found`);
        }
      }

      // Clean up
      this.preclearRunning.delete(devicePath);
      this.preclearProcesses.delete(devicePath);

      // Note: Final notification is sent by _runPreClearAndFormat after format completes
      // If preClearDisk is called standalone, no completion notification is sent here

      return {
        success: true,
        device: devicePath,
        algorithm,
        passes: effectiveWipes,
        readCheck: readCheckResult
      };

    } catch (error) {
      // Clean up on error
      this.preclearRunning.delete(devicePath);
      this.preclearProcesses.delete(devicePath);

      // Check if it was an abort
      const processInfo = this.preclearProcesses.get(devicePath);
      if (processInfo && processInfo.aborted) {
        throw new Error('Preclear operation was aborted');
      }

      // Send error notification
      await this._sendNotification(
        'Preclear',
        `Preclear failed on ${deviceName}: ${error.message}`,
        'alert'
      );

      throw error;
    }
  }

  /**
   * Run preClear and format in sequence (async helper)
   * @private
   */
  async _runPreClearAndFormat(devicePath, filesystem, options) {
    const { partition, wipeExisting, preClear } = options;
    const deviceName = devicePath.replace('/dev/', '');

    try {
      // Run preClear
      await this.preClearDisk(devicePath, preClear);

      // preClear successful - now format (no notification here, only at the end)
      // Wipe existing data (wipefs)
      if (wipeExisting) {
        await execPromise(`wipefs -a ${devicePath}`);
      }

      // Create partition if requested
      if (partition) {
        await execPromise(`parted -s ${devicePath} mklabel gpt`);
        await execPromise(`parted -s ${devicePath} mkpart primary 1MiB 100%`);
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
          await execPromise(`partprobe ${devicePath}`);
        } catch (error) {
          console.warn(`partprobe failed: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1500));

        // Determine partition path
        let partitionPath;
        if (deviceName.includes('nvme') || deviceName.includes('mmc')) {
          partitionPath = `${devicePath}p1`;
        } else {
          partitionPath = `${devicePath}1`;
        }

        // Verify partition exists
        let partitionExists = false;
        for (let retry = 0; retry < 5; retry++) {
          try {
            await fs.access(partitionPath);
            partitionExists = true;
            break;
          } catch (error) {
            if (retry < 4) {
              await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)));
            }
          }
        }

        if (!partitionExists) {
          throw new Error(`Partition ${partitionPath} was not created`);
        }

        // Format partition
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

      // Send success notification
      await this._sendNotification(
        'Preclear',
        `Preclear finished, disk ${devicePath} ready`,
        'normal'
      );

    } catch (error) {
      // Only send notification for format errors, not preClear errors
      // (preClearDisk already sends its own error notification)
      if (!error.message.includes('Preclear') && !error.message.includes('ReadCheck') && !error.message.includes('aborted')) {
        await this._sendNotification(
          'Preclear',
          `Format failed on ${devicePath}: ${error.message}`,
          'alert'
        );
      }
      throw error;
    }
  }

  /**
   * Disk formatieren
   * @param {string} device - Device path or name
   * @param {string} filesystem - Filesystem type
   * @param {Object} options - Format options
   * @param {boolean} options.partition - Create partition table (default: true)
   * @param {boolean} options.wipeExisting - Wipe existing signatures (default: true)
   * @param {Object} options.preClear - Preclear options (optional)
   * @param {number} options.preClear.wipes - Number of wipe passes (1-4)
   * @param {string} options.preClear.algorithm - Algorithm: zero, ff, random, one-zero
   * @param {boolean} options.preClear.readCheck - Verify all sectors are zero after wipe
   * @param {boolean} options.preClear.log - Log bad sectors to file
   */
  async formatDevice(device, filesystem, options = {}) {
    const { partition = true, wipeExisting = true, preClear = null } = options;
    const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
    const deviceName = devicePath.replace('/dev/', '');

    try {
      // Check if device is system disk
      const isSystem = await this._isSystemDisk(devicePath);
      if (isSystem) {
        throw new Error('Cannot format system disk');
      }

      // Check if preClear is requested and has wipes > 0
      if (preClear && preClear.wipes && preClear.wipes > 0) {
        // Validate preClear options
        const { wipes = 1, algorithm = 'zero', readCheck = false, log = false } = preClear;

        // Start preClear async and return immediately
        // The preClear will handle formatting after completion
        this._runPreClearAndFormat(devicePath, filesystem, {
          partition,
          wipeExisting,
          preClear: { wipes, algorithm, readCheck, log }
        }).catch(err => {
          console.error(`Preclear/Format failed for ${devicePath}: ${err.message}`);
        });

        return {
          success: true,
          message: `Preclear started on ${deviceName}. Format will proceed after completion.`,
          device: device,
          filesystem: filesystem,
          preclearStarted: true
        };
      }

      // No preClear - proceed with normal formatting
      // Wipe existing data
      if (wipeExisting) {
        await execPromise(`wipefs -a ${devicePath}`);
      }

      // Create partition if requested
      if (partition) {
        await execPromise(`parted -s ${devicePath} mklabel gpt`);
        await execPromise(`parted -s ${devicePath} mkpart primary 1MiB 100%`);

        // Wait a moment for the partition to be recognized by the kernel
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Inform kernel about partition table changes
        try {
          await execPromise(`partprobe ${devicePath}`);
        } catch (error) {
          // partprobe might fail on some systems, but that's usually not critical
          console.warn(`partprobe failed: ${error.message}`);
        }

        // Wait again after partprobe (important for USB devices and slow controllers)
        await new Promise(resolve => setTimeout(resolve, 1500));

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

        // Verify partition exists before formatting (retry mechanism for slow devices)
        let partitionExists = false;
        for (let retry = 0; retry < 5; retry++) {
          try {
            await fs.access(partitionPath);
            partitionExists = true;
            break;
          } catch (error) {
            if (retry < 4) {
              // Wait before retry (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)));
            }
          }
        }

        if (!partitionExists) {
          throw new Error(`Partition ${partitionPath} was not created. This can happen with slow devices or controllers.`);
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
   * @param {string} pooltype - Optional: Filter für Pool-Typ ('multi', 'nonraid', 'single', 'mergerfs')
   *                            Bei 'multi' werden nur btrfs und zfs zurückgegeben
   *                            Bei 'mergerfs' und 'nonraid' wird vfat ausgeschlossen (keine POSIX-Unterstützung)
   *                            Bei 'single' oder ohne Parameter werden alle zurückgegeben
   */
  async getAvailableFilesystems(pooltype = null) {
    const supportedFilesystems = [
      { name: 'ext4', command: 'mkfs.ext4' },
      { name: 'xfs', command: 'mkfs.xfs' },
      { name: 'btrfs', command: 'mkfs.btrfs' },
      { name: 'vfat', command: 'mkfs.vfat' },
      { name: 'zfs', command: 'zfs' }
    ];

    // Bei pooltype=multi nur btrfs und zfs prüfen
    const multiPoolFilesystems = ['btrfs', 'zfs'];
    const filesystemsToCheck = pooltype === 'multi'
      ? supportedFilesystems.filter(fs => multiPoolFilesystems.includes(fs.name))
      : supportedFilesystems;

    const availableFilesystems = [];

    for (const fs of filesystemsToCheck) {
      try {
        // Spezielle Behandlung für ZFS (deaktiviert für jetzt)
        // if (fs.name === 'zfs') {
        //   try {
        //     await execPromise(`which zpool`);
        //     await execPromise(`which zfs`);
        //     await execPromise(`modinfo zfs`);
        //     availableFilesystems.push(fs.name);
        //   } catch (zfsError) {
        //     // ZFS nicht verfügbar
        //   }
        // } else {
        //   // Normale mkfs-Tools prüfen
        //   await execPromise(`which ${fs.command}`);
        //   availableFilesystems.push(fs.name);
        // }

        // Ohne ZFS - nur normale mkfs-Tools prüfen
        if (fs.name === 'zfs') continue;
        // vfat bei mergerfs und nonraid ausschließen
        if (fs.name === 'vfat' && (pooltype === 'mergerfs' || pooltype === 'nonraid')) continue;
        await execPromise(`which ${fs.command}`);
        availableFilesystems.push(fs.name);
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

  // ============================================================
  // ZRAM HELPERS
  // ============================================================

  /**
   * Check if a device is a ZRAM device
   * @param {string} device - Device path or name
   * @returns {boolean}
   */
  isZramDevice(device) {
    const name = device.replace('/dev/', '');
    return /^zram\d+/.test(name);
  }

  /**
   * Get ZRAM device info from zram.service config
   * @param {string} device - Device path (e.g., /dev/zram0 or /dev/zram0p1)
   * @returns {Promise<Object|null>} ZRAM device config or null if not found/not ZRAM
   */
  async getZramDeviceInfo(device) {
    if (!this.isZramDevice(device)) return null;

    try {
      const ZramService = require('./zram.service');
      const config = await ZramService.loadConfig();

      // Extract zram index from device name (handles both /dev/zram0 and /dev/zram0p1)
      const match = device.match(/zram(\d+)/);
      if (!match) return null;
      const index = parseInt(match[1]);

      const zramDevice = config.devices.find(d => d.index === index);
      if (zramDevice) {
        return {
          ...zramDevice,
          isZram: true,
          zramType: zramDevice.type // 'swap' or 'ramdisk'
        };
      }
    } catch {
      // ZRAM service not available
    }
    return null;
  }

  /**
   * Get all ZRAM ramdisk devices (for pools)
   * @param {Object} user - User object for formatting
   * @returns {Promise<Array>} Array of ZRAM ramdisk devices
   */
  async getZramRamdisks(user = null) {
    try {
      const ZramService = require('./zram.service');
      const config = await ZramService.loadConfig();

      if (!config.enabled) return [];

      const ramdisks = [];
      for (const device of config.devices) {
        if (device.type === 'ramdisk' && device.enabled) {
          // Get size from sysfs
          let sizeBytes = 0;
          try {
            const { stdout } = await execPromise(`cat /sys/block/zram${device.index}/disksize`);
            sizeBytes = parseInt(stdout.trim()) || 0;
          } catch {
            // Device might not be active
          }

          ramdisks.push({
            device: `/dev/zram${device.index}`,
            name: device.name,
            id: device.id,
            index: device.index,
            size: sizeBytes,
            sizeHuman: this.formatBytes(sizeBytes, user),
            type: 'ramdisk',
            algorithm: device.algorithm,
            filesystem: device.config.filesystem,
            uuid: device.config.uuid,
            isZram: true
          });
        }
      }

      return ramdisks;
    } catch {
      return [];
    }
  }
}

module.exports = new DisksService();