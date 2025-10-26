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
   * Helper function to format memory bytes - ALWAYS uses binary units (GiB)
   * Memory should always be displayed in binary units regardless of user preference
   * @param {number} bytes - Bytes to format
   * @returns {string} Human readable format in binary units
   */
  formatMemoryBytes(bytes) {
    if (bytes === 0) return '0 B';

    const k = 1024; // Always binary for memory
    const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

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
          total_human: this.formatMemoryBytes(mem.total),
          free: mem.available,
          free_human: this.formatMemoryBytes(mem.available),
          used: actuallyUsed,
          used_human: this.formatMemoryBytes(actuallyUsed),
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
   * Get system uptime in seconds (ultra-fast /proc/uptime read)
   * @returns {Promise<number>} Uptime in seconds
   */
  async getUptime() {
    try {
      const fs = require('fs').promises;
      const uptimeData = await fs.readFile('/proc/uptime', 'utf8');
      const uptime = parseFloat(uptimeData.split(' ')[0]);
      return Math.floor(uptime);
    } catch (error) {
      // Fallback to si.time() if /proc/uptime fails
      const timeData = await si.time();
      return timeData.uptime;
    }
  }

  /**
   * Get system load and temperature information including per-core metrics, network utilization and memory info
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object>} Load, temperature, network and memory info
   */
  async getSystemLoad(user = null) {
    try {
      // Combine CPU/Memory, Network data and Uptime
      const [cpuMemoryData, networkData, uptime] = await Promise.all([
        this.getCpuMemoryLoad(user),
        this.getNetworkLoad(user),
        this.getUptime()
      ]);

      return {
        ...cpuMemoryData,
        ...networkData,
        uptime: uptime
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

  /**
   * Get proxy settings from /boot/config/system/proxy.json
   * @returns {Object} Proxy settings or empty object if file doesn't exist
   */
  async getProxySettings() {
    const fs = require('fs').promises;
    const path = require('path');

    try {
      const proxyPath = '/boot/config/system/proxy.json';

      try {
        const content = await fs.readFile(proxyPath, 'utf8');
        return JSON.parse(content);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, return empty object
          return {};
        }
        throw error;
      }
    } catch (error) {
      throw new Error(`Error reading proxy settings: ${error.message}`);
    }
  }

  /**
   * Update proxy settings in /boot/config/system/proxy.json
   * @param {Object} proxyData - Proxy configuration data
   * @returns {Object} Updated proxy settings
   */
  async updateProxySettings(proxyData) {
    const fs = require('fs').promises;
    const path = require('path');

    try {
      const proxyPath = '/boot/config/system/proxy.json';
      const proxyDir = path.dirname(proxyPath);

      // Ensure directory exists
      await fs.mkdir(proxyDir, { recursive: true });

      // Get current settings
      let currentSettings = {};
      try {
        const content = await fs.readFile(proxyPath, 'utf8');
        currentSettings = JSON.parse(content);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // File doesn't exist, start with empty object
      }

      // Merge with new data (partial updates supported)
      const updatedSettings = { ...currentSettings, ...proxyData };

      // Validate proxy URLs if provided
      const validFields = ['http_proxy', 'https_proxy', 'ftp_proxy', 'no_proxy'];
      for (const field of Object.keys(proxyData)) {
        if (!validFields.includes(field)) {
          throw new Error(`Invalid proxy field: ${field}. Allowed fields: ${validFields.join(', ')}`);
        }
      }

      // Write updated settings
      await fs.writeFile(proxyPath, JSON.stringify(updatedSettings, null, 2), { mode: 0o600 });

      return updatedSettings;
    } catch (error) {
      throw new Error(`Error updating proxy settings: ${error.message}`);
    }
  }

  /**
   * List all log files in /var/log recursively (excludes empty files)
   * @returns {Promise<Array>} Simple array of log file paths
   */
  async listLogFiles() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const logDir = '/var/log';

      /**
       * Recursively scan directory for log files
       * @param {string} dir - Directory to scan
       * @param {string} relativePath - Relative path from /var/log
       * @returns {Promise<Array>} Array of file paths
       */
      async function scanDirectory(dir, relativePath = '') {
        const files = [];

        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relPath = path.join(relativePath, entry.name);

            try {
              const stats = await fs.stat(fullPath);

              if (entry.isDirectory()) {
                // Recursively scan subdirectories
                const subFiles = await scanDirectory(fullPath, relPath);
                files.push(...subFiles);
              } else if (entry.isFile() && stats.size > 0) {
                // Only include files with content (size > 0)
                files.push(relPath);
              }
            } catch (statError) {
              // Skip files/directories we can't access
              continue;
            }
          }
        } catch (readError) {
          // Skip directories we can't read
        }

        return files;
      }

      const logFiles = await scanDirectory(logDir);

      // Sort alphabetically for better readability
      logFiles.sort();

      return logFiles;
    } catch (error) {
      throw new Error(`Error listing log files: ${error.message}`);
    }
  }

  /**
   * Read content of a specific log file
   * @param {string} logPath - Relative path to log file from /var/log
   * @param {number} lines - Number of lines to read (default: 100, max: 1000000)
   * @param {boolean} tail - Read from end of file (default: true)
   * @returns {Promise<Object>} Log file content and metadata
   */
  async readLogFile(logPath, lines = 100, tail = true) {
    try {
      const fs = require('fs').promises;
      const path = require('path');

      // Security: Prevent path traversal
      const normalizedPath = path.normalize(logPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.join('/var/log', normalizedPath);

      // Ensure the path is within /var/log
      if (!fullPath.startsWith('/var/log/')) {
        throw new Error('Invalid log path: Path must be within /var/log');
      }

      // Check if file exists and is a file
      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) {
        throw new Error('Path is not a file');
      }

      // Limit lines
      const maxLines = Math.min(Math.max(1, lines), 1000000);

      // Read file content
      let content;
      if (tail) {
        // Use tail command for efficient reading from end
        // Increase maxBuffer to 50MB to handle large log files
        const { stdout } = await execAsync(`tail -n ${maxLines} "${fullPath}"`, { maxBuffer: 50 * 1024 * 1024 });
        content = stdout;
      } else {
        // Use head command for reading from start
        // Increase maxBuffer to 50MB to handle large log files
        const { stdout } = await execAsync(`head -n ${maxLines} "${fullPath}"`, { maxBuffer: 50 * 1024 * 1024 });
        content = stdout;
      }

      const contentLines = content.split('\n').filter(line => line.trim() !== '');

      return {
        path: normalizedPath,
        full_path: fullPath,
        size: stats.size,
        size_human: this.formatBytes(stats.size),
        modified: stats.mtime,
        lines_requested: maxLines,
        lines_returned: contentLines.length,
        content: contentLines
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('Log file not found');
      } else if (error.code === 'EACCES') {
        throw new Error('Permission denied to read log file');
      }
      throw new Error(`Error reading log file: ${error.message}`);
    }
  }

  /**
   * Parse lspci -vmm output for basic device information
   * @param {string} slot - PCI slot to parse
   * @returns {Object} Basic device information
   * @private
   */
  _parseLspciVmm(vmmOutput, slot) {
    const lines = vmmOutput.split('\n');
    const device = { slot: slot };

    let currentSlot = null;
    for (const line of lines) {
      if (line.startsWith('Slot:')) {
        currentSlot = line.split('\t')[1]?.trim();
        if (currentSlot === slot) {
          continue;
        } else {
          currentSlot = null;
        }
      }

      if (currentSlot !== slot) continue;

      const [key, ...valueParts] = line.split('\t');
      const value = valueParts.join('\t').trim();

      if (key === 'Class:') {
        // "VGA compatible controller [0300]"
        const match = value.match(/^(.+?)\s*\[([0-9a-f]{4})\]$/i);
        if (match) {
          device.class = match[1].trim();
          device.class_id = match[2];
        } else {
          device.class = value;
        }
      } else if (key === 'Vendor:') {
        // "NVIDIA Corporation [10de]"
        const match = value.match(/^(.+?)\s*\[([0-9a-f]{4})\]$/i);
        if (match) {
          device.vendor = match[1].trim();
          device.vendor_id = match[2];
        } else {
          device.vendor = value;
        }
      } else if (key === 'Device:') {
        // "TU117GLM [Quadro T400 Mobile] [1fb2]"
        const match = value.match(/^(.+?)\s*\[([0-9a-f]{4})\]$/i);
        if (match) {
          device.name = match[1].trim();
          device.device_id = match[2];
        } else {
          device.name = value;
        }
      } else if (key === 'SVendor:') {
        const match = value.match(/^(.+?)\s*\[([0-9a-f]{4})\]$/i);
        if (match) {
          device.subsystem_vendor = match[1].trim();
          device.subsystem_vendor_id = match[2];
        }
      } else if (key === 'SDevice:') {
        const match = value.match(/^(.+?)\s*\[([0-9a-f]{4})\]$/i);
        if (match) {
          device.subsystem = match[1].trim();
          device.subsystem_device_id = match[2];
        }
      } else if (key === 'Rev:') {
        device.revision = value;
      } else if (key === 'ProgIf:') {
        device.prog_if = value;
      }
    }

    // Build subsystem_id from parts
    if (device.subsystem_vendor_id && device.subsystem_device_id) {
      device.subsystem_id = `${device.subsystem_vendor_id}:${device.subsystem_device_id}`;
    }

    return device;
  }

  /**
   * Measure indentation level of a line
   * @param {string} line - Line to measure
   * @returns {number} Indentation level (number of leading spaces/tabs)
   * @private
   */
  _getIndentLevel(line) {
    if (!line) return 0;

    let indent = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ' ') {
        indent++;
      } else if (line[i] === '\t') {
        // Treat tab as 2 spaces (or adjust as needed)
        indent += 2;
      } else {
        break;
      }
    }

    return indent;
  }

  /**
   * Parse hierarchical data - simple approach: just collect sections and their content
   * @param {Array} lines - Lines to parse
   * @returns {Object} Parsed data with sections as keys and content as strings
   * @private
   */
  _parseHierarchicalDetails(lines) {
    if (lines.length === 0) return {};

    const result = {};
    let currentSection = null;
    let currentLines = [];

    for (let i = 1; i < lines.length; i++) { // Skip first line (slot info)
      const line = lines[i];
      if (!line.trim()) continue;

      const indent = this._getIndentLevel(line);
      const trimmedLine = line.trim();

      // Check if this is a new section (0-1 indent level and ends with ":")
      if (indent <= 1 && trimmedLine.endsWith(':')) {
        // Save previous section
        if (currentSection) {
          result[currentSection] = currentLines.join('\n');
        }

        // Start new section
        currentSection = trimmedLine.slice(0, -1); // Remove trailing ":"
        currentLines = [];
      } else if (currentSection) {
        // Add line to current section (preserve original formatting)
        currentLines.push(line);
      }
    }

    // Save last section
    if (currentSection) {
      result[currentSection] = currentLines.join('\n');
    }

    return result;
  }

  /**
   * Parse lspci -vv output for a device block - generic parsing
   * @param {Array} lines - Lines of the device block
   * @returns {Object} Parsed device details
   * @private
   */
  _parseLspciVv(lines) {
    const details = {};

    for (let i = 1; i < lines.length; i++) { // Skip first line
      const line = lines[i];
      if (!line.trim()) continue;

      const trimmed = line.trim();
      const colonIndex = trimmed.indexOf(':');

      if (colonIndex > 0) {
        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();

        // If key already exists, convert to array
        if (details.hasOwnProperty(key)) {
          if (!Array.isArray(details[key])) {
            details[key] = [details[key]];
          }
          details[key].push(value);
        } else {
          details[key] = value;
        }
      }
    }

    return details;
  }

  /**
   * Get PCI devices information using lspci -vmm and -vv
   * Combines structured machine-readable format with parsed detailed output
   * @returns {Promise<Array>} Array of PCI devices with detailed information
   */
  async getPciDevices() {
    try {
      // Get structured basic info and detailed info in parallel
      const [vmmResult, vvResult] = await Promise.all([
        execAsync('lspci -vmm -nn'),
        execAsync('lspci -vv -nn')
      ]);

      const vmmOutput = vmmResult.stdout;
      const vvOutput = vvResult.stdout;

      // Split vv output into device blocks (separated by empty lines)
      const deviceBlocks = vvOutput.split('\n\n').filter(block => block.trim());

      const devices = [];

      for (const block of deviceBlocks) {
        const lines = block.split('\n');
        if (lines.length === 0) continue;

        // Extract slot from first line
        const firstLine = lines[0];
        const slotMatch = firstLine.match(/^([0-9a-f:.]+)\s+/);
        if (!slotMatch) continue;

        const slot = slotMatch[1];

        // Parse basic info from vmm format
        const device = this._parseLspciVmm(vmmOutput, slot);

        // Parse detailed info from vv format
        const details = this._parseLspciVv(lines);
        device.details = details;

        devices.push(device);
      }

      return devices;
    } catch (error) {
      throw new Error(`Error getting PCI devices: ${error.message}`);
    }
  }

  /**
   * Get USB devices information using lsusb
   * @returns {Promise<Array>} Array of USB devices with detailed information
   */
  async getUsbDevices() {
    try {
      // Get basic list and detailed info in parallel
      const [listResult, detailResult] = await Promise.all([
        execAsync('lsusb'),
        execAsync('lsusb -v')
      ]);

      const listOutput = listResult.stdout;
      const detailOutput = detailResult.stdout;

      // Parse basic list first
      const basicDevices = [];
      const listLines = listOutput.split('\n').filter(line => line.trim());

      for (const line of listLines) {
        // Format: "Bus 002 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub"
        const match = line.match(/Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s+(.+)/i);
        if (match) {
          basicDevices.push({
            bus: match[1],
            device: match[2],
            vendor_id: match[3],
            product_id: match[4],
            description: match[5].trim()
          });
        }
      }

      // Parse detailed output - split by device blocks
      const deviceBlocks = detailOutput.split(/\n\nBus\s+/);

      const devices = [];

      for (const basicDevice of basicDevices) {
        const device = { ...basicDevice };

        // Find matching detailed block
        const blockPrefix = `${basicDevice.bus} Device ${basicDevice.device}:`;
        let matchingBlock = null;

        for (let i = 0; i < deviceBlocks.length; i++) {
          const block = i === 0 ? deviceBlocks[i] : 'Bus ' + deviceBlocks[i];
          if (block.startsWith('Bus ' + blockPrefix)) {
            matchingBlock = block;
            break;
          }
        }

        if (matchingBlock) {
          // Parse hierarchical details
          const lines = matchingBlock.split('\n');
          const details = this._parseHierarchicalDetails(lines);
          device.details = details;
        }

        devices.push(device);
      }

      return devices;
    } catch (error) {
      throw new Error(`Error getting USB devices: ${error.message}`);
    }
  }

  /**
   * Get GPU information using mos-get_gpus
   * @returns {Promise<Object>} GPU information grouped by vendor
   */
  async getGpus() {
    try {
      const { stdout } = await execAsync('/usr/local/bin/mos-get_gpus');
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Error getting GPUs: ${error.message}`);
    }
  }
}

module.exports = new SystemService();
