const si = require('systeminformation');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class SystemService {
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
      const dirtyCaches = mem.used - actuallyUsed;

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
      const dirtyCaches = mem.used - actuallyUsed;

      const detailedMemory = {
        ...mem,
        actuallyUsed: actuallyUsed,
        dirtyCaches: dirtyCaches,
        percentage: {
          used: Math.round((mem.used / mem.total) * 100),
          actuallyUsed: Math.round((actuallyUsed / mem.total) * 100),
          dirtyCaches: Math.round((dirtyCaches / mem.total) * 100)
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
   * Get system load and temperature information including per-core metrics, network utilization and memory info
   * @returns {Promise<Object>} Load, temperature, network and memory info
   */
  async getSystemLoad() {
    try {
      const [currentLoad, temp, networkStats, networkInterfaces, mem, cpu] = await Promise.all([
        si.currentLoad(),
        si.cpuTemperature(),
        si.networkStats(),
        si.networkInterfaces(),
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
        const physicalCoreNumber = isPhysical ? index + 1 : Math.floor(index / 2) + 1;

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

      // Helper function to format bytes in human readable format
      const formatBytes = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      };

      // Helper function to format speed in human readable format
      const formatSpeed = (bytesPerSecond) => {
        if (bytesPerSecond === 0) return '0 B/s';
        const k = 1024;
        const sizes = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
        const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
        return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      };

      // Create a map of interface details for quick lookup
      const interfaceMap = {};
      networkInterfaces.forEach(iface => {
        interfaceMap[iface.iface] = {
          type: iface.type,
          speed: iface.speed,
          state: iface.operstate,
          ip4: iface.ip4,
          ip6: iface.ip6,
          mac: iface.mac
        };
      });

      // Process network statistics
      const interfaces = networkStats.map(stat => {
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
              bytes_human: formatBytes(stat.rx_bytes),
              packets: stat.rx_packets,
              errors: stat.rx_errors,
              dropped: stat.rx_dropped,
              speed_bps: stat.rx_sec || 0,
              speed_human: formatSpeed(stat.rx_sec || 0)
            },
            tx: {
              bytes: stat.tx_bytes,
              bytes_human: formatBytes(stat.tx_bytes),
              packets: stat.tx_packets,
              errors: stat.tx_errors,
              dropped: stat.tx_dropped,
              speed_bps: stat.tx_sec || 0,
              speed_human: formatSpeed(stat.tx_sec || 0)
            },
            total: {
              bytes: stat.rx_bytes + stat.tx_bytes,
              bytes_human: formatBytes(stat.rx_bytes + stat.tx_bytes),
              packets: stat.rx_packets + stat.tx_packets,
              speed_bps: (stat.rx_sec || 0) + (stat.tx_sec || 0),
              speed_human: formatSpeed((stat.rx_sec || 0) + (stat.tx_sec || 0))
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

      // Calculate actually used RAM without dirty caches
      const actuallyUsed = mem.total - mem.available;
      const dirtyCaches = mem.used - actuallyUsed;

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
        },
        memory: {
          total: mem.total,
          total_human: formatBytes(mem.total),
          free: mem.available,
          free_human: formatBytes(mem.available),
          used: actuallyUsed,
          used_human: formatBytes(actuallyUsed),
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
        },
        network: {
          interfaces,
          summary: {
            total_interfaces: interfaces.length,
            active_interfaces: interfaces.filter(i => i.state === 'up').length,
            totals: {
              rx: {
                bytes: totals.rx_bytes,
                bytes_human: formatBytes(totals.rx_bytes),
                packets: totals.rx_packets,
                speed_bps: totals.rx_speed,
                speed_human: formatSpeed(totals.rx_speed)
              },
              tx: {
                bytes: totals.tx_bytes,
                bytes_human: formatBytes(totals.tx_bytes),
                packets: totals.tx_packets,
                speed_bps: totals.tx_speed,
                speed_human: formatSpeed(totals.tx_speed)
              },
              combined: {
                bytes: totals.rx_bytes + totals.tx_bytes,
                bytes_human: formatBytes(totals.rx_bytes + totals.tx_bytes),
                packets: totals.rx_packets + totals.tx_packets,
                speed_bps: totals.rx_speed + totals.tx_speed,
                speed_human: formatSpeed(totals.rx_speed + totals.tx_speed)
              }
            }
          }
        }
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
}

module.exports = new SystemService();
