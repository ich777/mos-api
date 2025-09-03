const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

/**
 * VM Service
 * Provides functionality to manage virtual machines using libvirt/qemu
 */
class VmService {
  /**
   * List all virtual machines with detailed information
   * @returns {Promise<Array>} List of VMs with their status, disk info and VNC port
   */
  async listVms() {
    try {
      // List running VMs
      const { stdout: runningStdout } = await execPromise('virsh list --name');
      const runningVms = runningStdout.trim().split('\n').filter(name => name.trim());

      // List all VMs including inactive ones
      const { stdout: allStdout } = await execPromise('virsh list --all --name');
      const allVms = allStdout.trim().split('\n').filter(name => name.trim());

      // Get detailed information for each VM
      const vmsPromises = allVms.map(async (name) => {
        const vmInfo = {
          name,
          state: runningVms.includes(name) ? 'running' : 'stopped',
          disks: [],
          vncPort: null
        };

        try {
          // Get disk information
          const { stdout: diskStdout } = await execPromise(`virsh domblklist ${name}`);
          const diskLines = diskStdout.trim().split('\n').slice(2); // Skip header lines

          for (const line of diskLines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2 && parts[1] && parts[1] !== '-') {
              vmInfo.disks.push({
                target: parts[0],
                source: parts[1]
              });
            }
          }

          // Get VNC port information if VM is running
          if (vmInfo.state === 'running') {
            try {
              const { stdout: vncStdout } = await execPromise(`virsh vncdisplay ${name}`);
              const vncDisplay = vncStdout.trim();
              if (vncDisplay) {
                // VNC display format is usually :0, :1, etc.
                // Convert to actual port (5900 + display number)
                const displayNumber = parseInt(vncDisplay.replace(':', ''), 10);
                if (!isNaN(displayNumber)) {
                  vmInfo.vncPort = 5900 + displayNumber;
                }
              }
            } catch (vncError) {
              // VM might not have VNC configured
              vmInfo.vncPort = null;
            }
          }
        } catch (detailError) {
          // If we can't get details, just return basic info
          console.error(`Error getting details for VM ${name}: ${detailError.message}`);
        }

        return vmInfo;
      });

      return Promise.all(vmsPromises);
    } catch (error) {
      throw new Error(`Failed to list virtual machines: ${error.message}`);
    }
  }

  /**
   * Start a virtual machine
   * @param {string} vmName - Name of the VM to start
   * @returns {Promise<Object>} Result of the operation
   */
  async startVm(vmName) {
    try {
      await execPromise(`virsh start ${vmName}`);
      return { success: true, message: `VM ${vmName} started successfully` };
    } catch (error) {
      throw new Error(`Failed to start VM ${vmName}: ${error.message}`);
    }
  }

  /**
   * Stop a virtual machine (graceful shutdown)
   * @param {string} vmName - Name of the VM to stop
   * @returns {Promise<Object>} Result of the operation
   */
  async stopVm(vmName) {
    try {
      await execPromise(`virsh shutdown ${vmName}`);
      return { success: true, message: `VM ${vmName} shutdown initiated` };
    } catch (error) {
      throw new Error(`Failed to stop VM ${vmName}: ${error.message}`);
    }
  }

  /**
   * Force kill a virtual machine
   * @param {string} vmName - Name of the VM to kill
   * @returns {Promise<Object>} Result of the operation
   */
  async killVm(vmName) {
    try {
      await execPromise(`virsh destroy ${vmName}`);
      return { success: true, message: `VM ${vmName} forcefully stopped` };
    } catch (error) {
      throw new Error(`Failed to kill VM ${vmName}: ${error.message}`);
    }
  }
}

module.exports = new VmService();
