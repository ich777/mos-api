const si = require('systeminformation');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class SystemService {
  constructor() {
    // Cache for network speed calculation
    this.networkSpeedCache = new Map();
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
   * Get basic system information
   * @returns {Promise<Object>} Basic system info
   */
  async getBasicInfo() {
    try {
      const [osInfo, cpu] = await Promise.all([
        si.osInfo(),
        si.cpu()
      ]);

      return {
        os: {
          platform: osInfo.platform,
          distro: osInfo.distro,
          release: osInfo.release,
          kernel: osInfo.kernel
        },
        cpu: {
          manufacturer: cpu.manufacturer,
          brand: cpu.brand,
          cores: cpu.cores,
          physicalCores: cpu.physicalCores
        }
      };
    } catch (error) {
      throw new Error(`Error getting basic system info: ${error.message}`);
    }
  }

  /**
   * Get detailed memory information with separate dirty cache tracking
   * @returns {Promise<Object>} Detailed memory info
   */
  async getDetailedMemory() {
    try {
      const mem = await si.mem();

      // Calculate actually used RAM without dirty caches
      const actuallyUsed = mem.total - mem.available;
      const dirtyCaches = Math.max(0, mem.used - actuallyUsed);

      return {
        memory: {
          total: mem.total,
          free: mem.free,
          available: mem.available,
          used: {
            total: mem.used,
            actuallyUsed: actuallyUsed,
            dirtyCaches: dirtyCaches
          },
          swap: {
            total: mem.swaptotal,
            used: mem.swapused,
            free: mem.swapfree
          },
          percentage: {
            used: Math.round((mem.used / mem.total) * 100),
            actuallyUsed: Math.round((actuallyUsed / mem.total) * 100),
            dirtyCaches: Math.round((dirtyCaches / mem.total) * 100)
          }
        }
      };
    } catch (error) {
      throw new Error(`Error getting detailed memory info: ${error.message}`);
    }
  }

  /**
   * Get detailed system information (admin only)
   * @returns {Promise<Object>} Detailed system info
   */
  async getDetailedInfo() {
    try {
      const [
        osInfo,
        cpu,
        mem,
        disk,
        network,
        processes
      ] = await Promise.all([
        si.osInfo(),
        si.cpu(),
        si.mem(),
        si.fsSize(),
        si.networkInterfaces(),
        si.processes()
      ]);

      // Calculate actually used RAM without dirty caches
      const actuallyUsed = mem.total - mem.available;
      const dirtyCaches = Math.max(0, mem.used - actuallyUsed);

      const detailedMemory = {
        ...mem,
        actuallyUsed: actuallyUsed,
        dirtyCaches: dirtyCaches,
        percentage: {
          used: Math.round((mem.used / mem.total) * 100),
          actuallyUsed: Math.round((actuallyUsed / mem.total) * 100),
          dirtyCaches: Math.round((dirtyCaches / mem.total) * 100),
          free: Math.round((mem.free / mem.total) * 100),
          actuallyFree: Math.round((mem.available / mem.total) * 100)
        }
      };

      return {
        os: osInfo,
        cpu: cpu,
        memory: detailedMemory,
        disks: disk,
        network: network,
        processes: processes
      };
    } catch (error) {
      throw new Error(`Error getting detailed system info: ${error.message}`);
    }
  }

  /**
   * Get CPU and temperature information only (fastest - no memory or network)
   * @returns {Promise<Object>} CPU and temperature info
   */
  async getCpuLoad() {
    try {
      const [currentLoad, temp, cpu] = await Promise.all([
        si.currentLoad(),
        si.cpuTemperature(),
        si.cpu()
      ]);

      // Get detailed CPU information for core types
      const cpuFlags = await si.cpuFlags();

      // Prepare core-specific information with enhanced details
      const coreLoads = currentLoad.cpus.map((core, index) => {
        // Determine core type information
        const isPhysical = index < cpu.physicalCores;
        const isHyperThreaded = index >= cpu.physicalCores;
        const physicalCoreNumber = isPhysical ? index + 1 : (index - cpu.physicalCores) + 1;

        // Try to detect Performance vs Efficiency cores (mainly for Intel 12th gen+)
        let coreArchitecture = 'Standard';
        if (cpu.brand && cpu.brand.toLowerCase().includes('intel')) {
          const totalCores = cpu.cores;
          const physicalCores = cpu.physicalCores;

          // Heuristic: If we have more logical than physical cores and it's a modern Intel CPU
          if (totalCores > physicalCores && cpu.brand.match(/1[2-9]th|[2-9][0-9]th/)) {
            // Assume first cores are Performance cores, later ones might be Efficiency
            const estimatedPCores = Math.floor(physicalCores * 0.6); // Rough estimate
            coreArchitecture = index < estimatedPCores ? 'Performance' : 'Mixed/Efficiency';
          }
        }

        return {
          number: index + 1,
          load: {
            total: Math.round(core.load * 100) / 100,
          },
          temperature: temp.cores[index] !== undefined ? temp.cores[index] : null,
          isPhysical: isPhysical,
          isHyperThreaded: isHyperThreaded,
          physicalCoreNumber: physicalCoreNumber,
          coreArchitecture: coreArchitecture
        };
      });

      return {
        cpu: {
          load: Math.round(currentLoad.currentLoad * 100) / 100,
          info: {
            brand: cpu.brand,
            manufacturer: cpu.manufacturer,
            totalCores: cpu.cores,
            physicalCores: cpu.physicalCores,
            logicalCores: cpu.cores,
            hyperThreadingEnabled: cpu.cores > cpu.physicalCores,
            architecture: cpu.family ? `Family ${cpu.family}, Model ${cpu.model}` : 'Unknown'
          },
          cores: coreLoads
        },
        temperature: {
          main: temp.main,
          max: Math.max(...temp.cores.filter(t => t !== null)),
          min: Math.min(...temp.cores.filter(t => t !== null)),
          cores: temp.cores
        }
      };
    } catch (error) {
      throw new Error(`Error getting CPU load: ${error.message}`);
    }
  }

  /**
   * Get memory information only
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object>} Memory info
   */
  async getMemoryLoad(user = null) {
    try {
      const mem = await si.mem();

      // Calculate actually used RAM without dirty caches
      const actuallyUsed = mem.total - mem.available;
      const dirtyCaches = Math.max(0, mem.used - actuallyUsed);

      return {
        memory: {
          total: mem.total,
          total_human: this.formatBytes(mem.total, user),
          free: mem.available,
          free_human: this.formatBytes(mem.available, user),
          used: actuallyUsed,
          used_human: this.formatBytes(actuallyUsed, user),
          dirty: {
            free: mem.free,
            used: mem.used,
            dirtyCaches: dirtyCaches
          },
          percentage: {
            used: Math.round((mem.used / mem.total) * 100),
            actuallyUsed: Math.round((actuallyUsed / mem.total) * 100),
            dirtyCaches: Math.round((dirtyCaches / mem.total) * 100)
          }
        }
      };
    } catch (error) {
      throw new Error(`Error getting memory load: ${error.message}`);
    }
  }

  /**
   * Get CPU, memory and temperature information (fast - no network stats)
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object>} CPU, memory and temperature info
   */
  async getCpuMemoryLoad(user = null) {
    try {
      const [currentLoad, temp, mem, cpu] = await Promise.all([
        si.currentLoad(),
        si.cpuTemperature(),
        si.mem(),
        si.cpu()
      ]);

      // Get detailed CPU information for core types
      const cpuFlags = await si.cpuFlags();

      // Prepare core-specific information with enhanced details
      const coreLoads = currentLoad.cpus.map((core, index) => {
        // Determine core type information
        const isPhysical = index < cpu.physicalCores;
        const isHyperThreaded = index >= cpu.physicalCores;
        const physicalCoreNumber = isPhysical ? index + 1 : (index - cpu.physicalCores) + 1;

        // Try to detect Performance vs Efficiency cores (mainly for Intel 12th gen+)
        let coreArchitecture = 'Standard';
        if (cpu.brand && cpu.brand.toLowerCase().includes('intel')) {
          const totalCores = cpu.cores;
          const physicalCores = cpu.physicalCores;

          // Heuristic: If we have more logical than physical cores and it's a modern Intel CPU
          if (totalCores > physicalCores && cpu.brand.match(/1[2-9]th|[2-9][0-9]th/)) {
            // Assume first cores are Performance cores, later ones might be Efficiency
            const estimatedPCores = Math.floor(physicalCores * 0.6); // Rough estimate
            coreArchitecture = index < estimatedPCores ? 'Performance' : 'Mixed/Efficiency';
          }
        }

        return {
          number: index + 1,
          load: {
            total: Math.round(core.load * 100) / 100,
          },
          temperature: temp.cores[index] !== undefined ? temp.cores[index] : null,
          isPhysical: isPhysical,
          isHyperThreaded: isHyperThreaded,
          physicalCoreNumber: physicalCoreNumber,
          coreArchitecture: coreArchitecture
        };
      });

      // Calculate actually used RAM without dirty caches
      const actuallyUsed = mem.total - mem.available;
      const dirtyCaches = Math.max(0, mem.used - actuallyUsed);

      // Combine CPU and Memory data
      const [cpuData, memoryData] = await Promise.all([
        this.getCpuLoad(),
        this.getMemoryLoad(user)
      ]);

      return {
        ...cpuData,
        ...memoryData
      };
    } catch (error) {
      throw new Error(`Error getting CPU/memory load: ${error.message}`);
    }
  }

  /**
   * Get network statistics (ultra-optimized - pure filesystem parsing)
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object>} Network statistics
   */
  async getNetworkLoad(user = null) {
    try {
      // Get current network counters and interface details in parallel
      const [networkCounters, interfaceDetails] = await Promise.all([
        this.getNetworkCountersOnly(),
        this.getNetworkInterfaceDetails()
      ]);
      const currentTime = Date.now();


      // Create a map of interface details for quick lookup
      const interfaceMap = {};
      interfaceDetails.forEach(iface => {
        interfaceMap[iface.name] = iface;
      });


      // Calculate speeds using cached previous values
      const calculateSpeed = (iface, currentRx, currentTx) => {
        const cacheKey = iface;
        const cached = this.networkSpeedCache.get(cacheKey);

        let rxSpeed = 0;
        let txSpeed = 0;

        if (cached) {
          const timeDiff = (currentTime - cached.timestamp) / 1000; // Convert to seconds

          // Only calculate if time difference is reasonable (1-5 seconds)
          if (timeDiff >= 1 && timeDiff <= 5) {
            const rxDiff = Math.max(0, currentRx - cached.rx_bytes);
            const txDiff = Math.max(0, currentTx - cached.tx_bytes);

            rxSpeed = Math.floor(rxDiff / timeDiff);
            txSpeed = Math.floor(txDiff / timeDiff);
          } else if (cached.rxSpeed !== undefined && cached.txSpeed !== undefined) {
            // Use cached speeds if time difference is unreasonable
            rxSpeed = cached.rxSpeed;
            txSpeed = cached.txSpeed;
          }
        }

        // Update cache with current values and calculated speeds
        this.networkSpeedCache.set(cacheKey, {
          rx_bytes: currentRx,
          tx_bytes: currentTx,
          timestamp: currentTime,
          rxSpeed: rxSpeed,
          txSpeed: txSpeed
        });

        return { rxSpeed, txSpeed };
      };

      // Process network statistics - no filtering needed as interfaces are pre-filtered
      const interfaces = networkCounters
        .map(stat => {
          const { rxSpeed, txSpeed } = calculateSpeed(stat.iface, stat.rx_bytes, stat.tx_bytes);
          const interfaceInfo = interfaceMap[stat.iface] || {};

          return {
            interface: stat.iface,
            type: interfaceInfo.type || 'unknown',
            state: interfaceInfo.state || 'unknown',
            speed: interfaceInfo.speed || null,
            ip4: interfaceInfo.ip4 || null,
            ip6: interfaceInfo.ip6 || null,
            mac: interfaceInfo.mac || null,
            statistics: {
              rx: {
                bytes: stat.rx_bytes,
                bytes_human: this.formatBytes(stat.rx_bytes, user),
                packets: stat.rx_packets,
                errors: stat.rx_errors,
                dropped: stat.rx_dropped,
                speed_bps: rxSpeed,
                speed_human: this.formatSpeed(rxSpeed, user)
              },
              tx: {
                bytes: stat.tx_bytes,
                bytes_human: this.formatBytes(stat.tx_bytes, user),
                packets: stat.tx_packets,
                errors: stat.tx_errors,
                dropped: stat.tx_dropped,
                speed_bps: txSpeed,
                speed_human: this.formatSpeed(txSpeed, user)
              },
              total: {
                bytes: stat.rx_bytes + stat.tx_bytes,
                bytes_human: this.formatBytes(stat.rx_bytes + stat.tx_bytes, user),
                packets: stat.rx_packets + stat.tx_packets,
                speed_bps: rxSpeed + txSpeed,
                speed_human: this.formatSpeed(rxSpeed + txSpeed, user)
              }
            }
          };
        });

      // Calculate totals across all interfaces
      const totals = interfaces.reduce((acc, iface) => {
        acc.rx_bytes += iface.statistics.rx.bytes;
        acc.tx_bytes += iface.statistics.tx.bytes;
        acc.rx_packets += iface.statistics.rx.packets;
        acc.tx_packets += iface.statistics.tx.packets;
        acc.rx_speed += iface.statistics.rx.speed_bps;
        acc.tx_speed += iface.statistics.tx.speed_bps;
        return acc;
      }, {
        rx_bytes: 0,
        tx_bytes: 0,
        rx_packets: 0,
        tx_packets: 0,
        rx_speed: 0,
        tx_speed: 0
      });

      return {
        network: {
          interfaces,
          summary: {
            total_interfaces: interfaces.length,
            active_interfaces: interfaces.filter(i => i.state === 'up').length,
            totals: {
              rx: {
                bytes: totals.rx_bytes,
                bytes_human: this.formatBytes(totals.rx_bytes, user),
                packets: totals.rx_packets,
                speed_bps: totals.rx_speed,
                speed_human: this.formatSpeed(totals.rx_speed, user)
              },
              tx: {
                bytes: totals.tx_bytes,
                bytes_human: this.formatBytes(totals.tx_bytes, user),
                packets: totals.tx_packets,
                speed_bps: totals.tx_speed,
                speed_human: this.formatSpeed(totals.tx_speed, user)
              },
              combined: {
                bytes: totals.rx_bytes + totals.tx_bytes,
                bytes_human: this.formatBytes(totals.rx_bytes + totals.tx_bytes, user),
                packets: totals.rx_packets + totals.tx_packets,
                speed_bps: totals.rx_speed + totals.tx_speed,
                speed_human: this.formatSpeed(totals.rx_speed + totals.tx_speed, user)
              }
            }
          }
        }
      };
    } catch (error) {
      throw new Error(`Error getting network load: ${error.message}`);
    }
  }

  /**
   * Get network interface details from /sys filesystem (ultra-fast)
   * @returns {Promise<Array>} Network interface details
   */
  async getNetworkInterfaceDetails() {
    try {
      const fs = require('fs').promises;
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Get all network interfaces from /sys/class/net and filter immediately
      const allInterfaces = await fs.readdir('/sys/class/net');

      // Helper function to check if interface is relevant (moved here for efficiency)
      const isRelevantInterface = (ifaceName) => {
        const name = ifaceName.toLowerCase();
        // Only process main interfaces, exclude Docker bridges and virtual interfaces
        return (name.startsWith('eth') ||   // Physical Ethernet
                name.startsWith('bond') ||  // Bonding
                name === 'br0') &&          // Main bridge only
               !name.includes('docker') &&  // Exclude Docker interfaces
               !name.startsWith('veth') &&  // Exclude virtual ethernet
               !name.startsWith('br-');     // Exclude Docker bridges (br-xxxxx)
      };

      // Filter interfaces before processing
      const relevantInterfaces = allInterfaces.filter(isRelevantInterface);

      // Smart interface priority: br0 > bond* > eth*
      const prioritizeInterfaces = (interfaces) => {
        const hasBridge = interfaces.some(name => name === 'br0');
        const hasBond = interfaces.some(name => name.startsWith('bond'));

        if (hasBridge) {
          return interfaces.filter(name => name === 'br0');
        } else if (hasBond) {
          return interfaces.filter(name => name.startsWith('bond'));
        } else {
          return interfaces.filter(name => name.startsWith('eth'));
        }
      };

      const prioritizedInterfaces = prioritizeInterfaces(relevantInterfaces);
      const interfaceDetails = [];

      for (const ifaceName of prioritizedInterfaces) {
        try {
          const basePath = `/sys/class/net/${ifaceName}`;

          // Read basic interface information
          const [operstate, type, address, speed] = await Promise.all([
            fs.readFile(`${basePath}/operstate`, 'utf8').catch(() => 'unknown'),
            fs.readFile(`${basePath}/type`, 'utf8').catch(() => '1'),
            fs.readFile(`${basePath}/address`, 'utf8').catch(() => ''),
            fs.readFile(`${basePath}/speed`, 'utf8').catch(() => '0')
          ]);

          // Get IP addresses using ip command (faster than complex parsing)
          let ip4 = null;
          let ip6 = null;
          try {
            const { stdout } = await execAsync(`ip addr show ${ifaceName} 2>/dev/null`);
            const ip4Match = stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
            const ip6Match = stdout.match(/inet6 ([a-f0-9:]+)/);
            ip4 = ip4Match ? ip4Match[1] : null;
            ip6 = ip6Match ? ip6Match[1] : null;
          } catch (e) {
            // Ignore IP detection errors
          }

          // Determine interface type based on type number and name
          const typeNum = parseInt(type.trim());
          let interfaceType = 'unknown';
          if (typeNum === 1) interfaceType = 'ethernet';
          else if (typeNum === 772) interfaceType = 'loopback';
          else if (ifaceName.startsWith('br')) interfaceType = 'bridge';
          else if (ifaceName.startsWith('bond')) interfaceType = 'bond';
          else if (ifaceName.startsWith('wlan')) interfaceType = 'wireless';

          interfaceDetails.push({
            name: ifaceName,
            type: interfaceType,
            state: operstate.trim(),
            speed: parseInt(speed.trim()) || null,
            mac: address.trim() || null,
            ip4: ip4,
            ip6: ip6
          });
        } catch (error) {
          // Skip interfaces that can't be read
          interfaceDetails.push({
            name: ifaceName,
            type: 'unknown',
            state: 'unknown',
            speed: null,
            mac: null,
            ip4: null,
            ip6: null
          });
        }
      }

      return interfaceDetails;
    } catch (error) {
      console.error('Error reading network interface details:', error);
      return [];
    }
  }

  /**
   * Get network counters with error stats from /proc/net/dev (ultra-fast, pre-filtered)
   * @returns {Promise<Array>} Network counters with error statistics
   */
  async getNetworkCountersOnly() {
    try {
      const fs = require('fs').promises;
      const data = await fs.readFile('/proc/net/dev', 'utf8');
      const lines = data.split('\n').slice(2); // Skip header lines

      // Helper function to check if interface is relevant (same logic as getNetworkInterfaceDetails)
      const isRelevantInterface = (ifaceName) => {
        const name = ifaceName.toLowerCase();
        return (name.startsWith('eth') ||   // Physical Ethernet
                name.startsWith('bond') ||  // Bonding
                name === 'br0') &&          // Main bridge only
               !name.includes('docker') &&  // Exclude Docker interfaces
               !name.startsWith('veth') &&  // Exclude virtual ethernet
               !name.startsWith('br-');     // Exclude Docker bridges (br-xxxxx)
      };

      const allInterfaces = [];

      for (const line of lines) {
        if (line.trim()) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 17) {
            const iface = parts[0].replace(':', '');

            // Filter interfaces here to avoid processing unwanted ones
            if (isRelevantInterface(iface)) {
              allInterfaces.push({
                iface: iface,
                rx_bytes: parseInt(parts[1]) || 0,
                rx_packets: parseInt(parts[2]) || 0,
                rx_errors: parseInt(parts[3]) || 0,
                rx_dropped: parseInt(parts[4]) || 0,
                tx_bytes: parseInt(parts[9]) || 0,
                tx_packets: parseInt(parts[10]) || 0,
                tx_errors: parseInt(parts[11]) || 0,
                tx_dropped: parseInt(parts[12]) || 0
              });
            }
          }
        }
      }

      // Smart interface priority: br0 > bond* > eth*
      const prioritizeInterfaces = (interfaces) => {
        const hasBridge = interfaces.some(iface => iface.iface === 'br0');
        const hasBond = interfaces.some(iface => iface.iface.startsWith('bond'));

        if (hasBridge) {
          return interfaces.filter(iface => iface.iface === 'br0');
        } else if (hasBond) {
          return interfaces.filter(iface => iface.iface.startsWith('bond'));
        } else {
          return interfaces.filter(iface => iface.iface.startsWith('eth'));
        }
      };

      return prioritizeInterfaces(allInterfaces);
    } catch (error) {
      console.error('Error reading /proc/net/dev, falling back to si.networkStats()');
      // Fallback to systeminformation if /proc/net/dev fails
      const networkStats = await si.networkStats();
      return networkStats.map(stat => ({
        iface: stat.iface,
        rx_bytes: stat.rx_bytes,
        rx_packets: stat.rx_packets,
        rx_errors: stat.rx_errors || 0,
        rx_dropped: stat.rx_dropped || 0,
        tx_bytes: stat.tx_bytes,
        tx_packets: stat.tx_packets,
        tx_errors: stat.tx_errors || 0,
        tx_dropped: stat.tx_dropped || 0
      }));
    }
  }

  /**
   * Get system load and temperature information including per-core metrics, network utilization and memory info
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object>} Load, temperature, network and memory info
   */
  async getSystemLoad(user = null) {
    try {
      // Combine CPU/Memory and Network data
      const [cpuMemoryData, networkData] = await Promise.all([
        this.getCpuMemoryLoad(user),
        this.getNetworkLoad(user)
      ]);

      return {
        ...cpuMemoryData,
        ...networkData
      };
    } catch (error) {
      throw new Error(`Error getting system load: ${error.message}`);
    }
  }

  /**
   * Get services status
   * @returns {Promise<Array>} Services status
   */
  async getServicesStatus() {
    try {
      const services = await si.services('*');
      return services;
    } catch (error) {
      throw new Error(`Error getting services status: ${error.message}`);
    }
  }





  /**
   * Reboot system
   * @returns {Promise<string>} Reboot message
   */
  async rebootSystem() {
    try {
      await execAsync('/sbin/reboot');
      return 'System reboot initiated';
    } catch (error) {
      throw new Error(`Error rebooting system: ${error.message}`);
    }
  }

  /**
   * Shutdown system
   * @returns {Promise<string>} Shutdown message
   */
  async shutdownSystem() {
    try {
      await execAsync('/sbin/poweroff');
      return 'System shutdown initiated';
    } catch (error) {
      throw new Error(`Error shutting down system: ${error.message}`);
    }
  }

  /**
   * Get current format settings
   * @returns {Object} Current format settings
   */
  getFormatSettings() {
    return {
      byte_format: process.env.BYTE_FORMAT_TYPE || 'binary'
    };
  }

  /**
   * Update format settings
   * @param {Object} settings - New format settings
   * @returns {Promise<Object>} Updated settings
   */
  async updateFormatSettings(settings) {
    try {
      const fs = require('fs').promises;
      const path = require('path');

      // Validate format type
      if (settings.byte_format && !['binary', 'decimal'].includes(settings.byte_format)) {
        throw new Error('Invalid byte_format. Must be "binary" or "decimal"');
      }

      // Update environment variable
      if (settings.byte_format) {
        process.env.BYTE_FORMAT_TYPE = settings.byte_format;
      }

      // Update .env file
      const envPath = path.join(process.cwd(), '.env');
      let envContent = '';

      try {
        envContent = await fs.readFile(envPath, 'utf8');
      } catch (error) {
        // File doesn't exist, create new content
        envContent = '';
      }

      // Update or add BYTE_FORMAT_TYPE
      const lines = envContent.split('\n');
      let found = false;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('BYTE_FORMAT_TYPE=')) {
          lines[i] = `BYTE_FORMAT_TYPE=${settings.byte_format}`;
          found = true;
          break;
        }
      }

      if (!found) {
        lines.push(`BYTE_FORMAT_TYPE=${settings.byte_format}`);
      }

      // Write back to file
      await fs.writeFile(envPath, lines.join('\n'), { mode: 0o600 });

      return this.getFormatSettings();
    } catch (error) {
      throw new Error(`Error updating format settings: ${error.message}`);
    }
  }
}

module.exports = new SystemService();
