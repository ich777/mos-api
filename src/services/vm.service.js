const { exec, spawn } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const net = require('net');
const https = require('https');
const execPromise = util.promisify(exec);

// Import mosService for VM settings
let mosService = null;
const getMosService = () => {
  if (!mosService) {
    mosService = require('./mos.service');
  }
  return mosService;
};

// Define MOS notify socket path
const MOS_NOTIFY_SOCKET = '/var/run/mos-notify.sock';

// VirtIO constants
const VIRTIO_ARCHIVE_URL = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/';
const VIRTIO_ISO_DIR = '/etc/libvirt/virtio-isos';

/**
 * VM Service
 * Provides functionality to manage virtual machines using libvirt/qemu
 */
class VmService {
  constructor() {
    // QEMU/KVM paths
    this.QEMU_PATH = '/usr/bin/qemu-system-x86_64';
    this.LIBVIRT_QEMU_PATH = '/etc/libvirt/qemu';

    // BIOS/Firmware paths
    this.BIOS_PATHS = {
      seabios: '/usr/share/qemu/bios.bin',
      ovmf: '/usr/share/qemu/OVMF/OVMF_CODE.fd',
      ovmf_tpm: '/usr/share/qemu/OVMF/OVMF_CODE-TPM.fd'
    };

    // OVMF VARS template path (needed for UEFI)
    this.OVMF_VARS_TEMPLATE = '/usr/share/qemu/OVMF/OVMF_VARS.fd';

    // NVRAM storage path for UEFI VMs
    this.NVRAM_PATH = '/etc/libvirt/qemu/nvram';

    // Valid configuration options
    this.VALID_BIOS_TYPES = ['seabios', 'ovmf', 'ovmf-tpm'];
    this.VALID_DISK_BUSES = ['virtio', 'sata', 'usb', 'scsi', 'ide'];
    this.VALID_DISK_FORMATS = ['qcow2', 'raw'];
    this.VALID_NETWORK_TYPES = ['bridge', 'macvtap', 'network'];
    this.VALID_NETWORK_MODELS = ['virtio', 'e1000', 'rtl8139'];
    this.VALID_GRAPHICS_TYPES = ['vnc', 'spice', 'none'];
  }

  // ============================================================
  // Byte Formatting Helpers
  // ============================================================

  /**
   * Format bytes in human readable format
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
   * Parse size string with unit to MiB
   * Supports: 512M, 512MB, 512MiB, 4G, 4GB, 4GiB, 1T, 1TB, 1TiB
   * Also accepts plain numbers (assumed to be MiB)
   * @param {string|number} size - Size with optional unit
   * @returns {number} Size in MiB
   */
  _parseSizeToMiB(size) {
    if (typeof size === 'number') {
      return size;
    }

    const sizeStr = String(size).trim().toUpperCase();
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(M|MB|MIB|G|GB|GIB|T|TB|TIB)?$/i);

    if (!match) {
      throw new Error(`Invalid size format: ${size}. Use format like 4G, 4GB, 512M, 512MB`);
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] || 'M').toUpperCase();

    switch (unit) {
      case 'M':
      case 'MB':
      case 'MIB':
        return Math.floor(value);
      case 'G':
      case 'GB':
      case 'GIB':
        return Math.floor(value * 1024);
      case 'T':
      case 'TB':
      case 'TIB':
        return Math.floor(value * 1024 * 1024);
      default:
        return Math.floor(value);
    }
  }

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
          vncPort: null,
          autostart: false
        };

        try {
          // Get autostart information
          try {
            const { stdout: autostartStdout } = await execPromise(`virsh dominfo ${name}`);
            const autostartLine = autostartStdout.split('\n').find(line => line.includes('Autostart:'));
            if (autostartLine) {
              vmInfo.autostart = autostartLine.includes('enable');
            }
          } catch (autostartError) {
            // If we can't get autostart info, default to false
            vmInfo.autostart = false;
          }

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

  /**
   * Restart a virtual machine (graceful reboot)
   * @param {string} vmName - Name of the VM to restart
   * @returns {Promise<Object>} Result of the operation
   */
  async restartVm(vmName) {
    try {
      await execPromise(`virsh reboot ${vmName}`);
      return { success: true, message: `VM ${vmName} restart initiated` };
    } catch (error) {
      throw new Error(`Failed to restart VM ${vmName}: ${error.message}`);
    }
  }

  /**
   * Reset a virtual machine (hard reset)
   * @param {string} vmName - Name of the VM to reset
   * @returns {Promise<Object>} Result of the operation
   */
  async resetVm(vmName) {
    try {
      await execPromise(`virsh reset ${vmName}`);
      return { success: true, message: `VM ${vmName} reset successfully` };
    } catch (error) {
      throw new Error(`Failed to reset VM ${vmName}: ${error.message}`);
    }
  }

  /**
   * Get autostart status of a virtual machine
   * @param {string} vmName - Name of the VM
   * @returns {Promise<Object>} Autostart status
   */
  async getAutostartStatus(vmName) {
    try {
      const { stdout } = await execPromise(`virsh dominfo ${vmName}`);
      const autostartLine = stdout.split('\n').find(line => line.includes('Autostart:'));
      const autostart = autostartLine ? autostartLine.includes('enable') : false;
      return { vmName, autostart };
    } catch (error) {
      throw new Error(`Failed to get autostart status for VM ${vmName}: ${error.message}`);
    }
  }

  /**
   * Set autostart status for a virtual machine
   * @param {string} vmName - Name of the VM
   * @param {boolean} enabled - Enable or disable autostart
   * @returns {Promise<Object>} Result of the operation
   */
  async setAutostart(vmName, enabled) {
    try {
      const command = enabled
        ? `virsh autostart ${vmName}`
        : `virsh autostart ${vmName} --disable`;
      await execPromise(command);
      const status = enabled ? 'enabled' : 'disabled';
      return {
        success: true,
        message: `Autostart ${status} for VM ${vmName}`,
        autostart: enabled
      };
    } catch (error) {
      throw new Error(`Failed to set autostart for VM ${vmName}: ${error.message}`);
    }
  }

  // ============================================================
  // QEMU Capabilities & System Info
  // ============================================================

  /**
   * Get available QEMU machine types
   * Parses output of: qemu-system-x86_64 -machine help
   * Returns only pc-i440fx and pc-q35 types, sorted with i440fx first then q35, both descending by version
   * @returns {Promise<Array>} List of machine types with name and description
   */
  async getQemuMachines() {
    try {
      const { stdout } = await execPromise(`${this.QEMU_PATH} -machine help`);
      const lines = stdout.trim().split('\n');

      const i440fxMachines = [];
      const q35Machines = [];
      let i440fxAlias = null;
      let q35Alias = null;

      for (const line of lines) {
        // Skip header lines
        if (line.startsWith('Supported') || line.trim() === '') continue;

        // Parse: "machine-name    description text"
        const match = line.match(/^(\S+)\s+(.+)$/);
        if (match) {
          const name = match[1].trim();
          const description = match[2].trim();

          // Capture the "pc" alias and rename to "i440fx"
          if (name === 'pc') {
            i440fxAlias = { name: 'i440fx', description };
          }
          // Capture the "q35" alias
          else if (name === 'q35') {
            q35Alias = { name: 'q35', description };
          }
          // Include pc-i440fx types
          else if (name.startsWith('pc-i440fx')) {
            i440fxMachines.push({ name, description });
          }
          // Include pc-q35 types
          else if (name.startsWith('pc-q35')) {
            q35Machines.push({ name, description });
          }
          // Skip all other types (none, microvm, etc.)
        }
      }

      // Extract version number for sorting (e.g., pc-i440fx-9.2 -> 9.2)
      const extractVersion = (name) => {
        const match = name.match(/-(\d+)\.(\d+)$/);
        if (match) {
          return parseFloat(`${match[1]}.${match[2]}`);
        }
        return 0;
      };

      // Sort descending by version
      i440fxMachines.sort((a, b) => extractVersion(b.name) - extractVersion(a.name));
      q35Machines.sort((a, b) => extractVersion(b.name) - extractVersion(a.name));

      // Add alias at the beginning of each group
      if (i440fxAlias) i440fxMachines.unshift(i440fxAlias);
      if (q35Alias) q35Machines.unshift(q35Alias);

      // Return flat array: i440fx first, then q35
      return [...i440fxMachines, ...q35Machines];
    } catch (error) {
      throw new Error(`Failed to get QEMU machines: ${error.message}`);
    }
  }

  /**
   * Get available network options for VM networking
   * @returns {Promise<Object>} Available bridges and libvirt networks
   */
  async getNetworkInterfaces() {
    try {
      // Get all network interfaces
      const { stdout: ifOutput } = await execPromise('ls /sys/class/net');
      const allInterfaces = ifOutput.trim().split('\n').filter(i => i);

      // Get bridges - find directories that have a 'bridge' subdirectory
      // Filter out Docker bridges (docker0, br-*) as they are not for VM use
      const bridges = [];
      try {
        const { stdout: brOutput } = await execPromise('ls -d /sys/class/net/*/bridge 2>/dev/null | xargs -I{} dirname {} | xargs -I{} basename {}');
        const allBridges = brOutput.trim().split('\n').filter(b => b);
        bridges.push(...allBridges.filter(b => !b.startsWith('br-') && b !== 'docker0'));
      } catch (e) {
        // No bridges found
      }

      // Get physical interfaces for macvtap (eth*, enp*, eno*, ens*, em* and VLANs)
      const interfaces = allInterfaces.filter(iface => {
        if (iface === 'lo') return false;
        if (iface.startsWith('docker') || iface.startsWith('veth') || iface.startsWith('br-')) return false;
        if (iface.startsWith('tun') || iface.startsWith('tap')) return false;
        if (iface.includes('-nic')) return false;
        if (bridges.includes(iface)) return false;
        return /^(eth|enp|eno|ens|em)\d/.test(iface) || iface.includes('.');
      });

      // Get libvirt networks
      const libvirtNetworks = [];
      try {
        const { stdout: netOutput } = await execPromise('virsh net-list --name --all');
        libvirtNetworks.push(...netOutput.trim().split('\n').filter(n => n));
      } catch (e) {
        // virsh not available or no networks
      }

      return {
        bridges,         // For type: bridge
        interfaces,      // For type: macvtap
        libvirtNetworks  // For type: network
      };
    } catch (error) {
      throw new Error(`Failed to get network interfaces: ${error.message}`);
    }
  }

  /**
   * Get VM capabilities (available resources, BIOS paths, etc.)
   * @returns {Promise<Object>} VM capabilities and available resources
   */
  async getVmCapabilities() {
    try {
      const [machines, networks, virtioVersions] = await Promise.all([
        this.getQemuMachines(),
        this.getNetworkInterfaces(),
        this.getInstalledVirtioVersions().catch(() => [])
      ]);

      // Check which BIOS files exist
      const biosAvailable = {};
      for (const [key, filePath] of Object.entries(this.BIOS_PATHS)) {
        try {
          await fs.access(filePath);
          biosAvailable[key] = { available: true, path: filePath };
        } catch (e) {
          biosAvailable[key] = { available: false, path: filePath };
        }
      }

      // Build VirtIO ISOs list with paths
      const virtioIsos = virtioVersions.map(version => ({
        version,
        path: path.join(VIRTIO_ISO_DIR, `${version}.iso`)
      }));

      return {
        qemuPath: this.QEMU_PATH,
        libvirtPath: this.LIBVIRT_QEMU_PATH,
        biosTypes: this.VALID_BIOS_TYPES,
        biosFiles: biosAvailable,
        diskBuses: this.VALID_DISK_BUSES,
        diskFormats: this.VALID_DISK_FORMATS,
        networkTypes: this.VALID_NETWORK_TYPES,
        networkModels: this.VALID_NETWORK_MODELS,
        graphicsTypes: this.VALID_GRAPHICS_TYPES,
        machines,
        networks,
        virtioIsos
      };
    } catch (error) {
      throw new Error(`Failed to get VM capabilities: ${error.message}`);
    }
  }

  // ============================================================
  // XML Generation
  // ============================================================

  /**
   * Generate a random UUID for VM
   * @returns {string} UUID v4
   */
  _generateUuid() {
    const hex = () => Math.floor(Math.random() * 16).toString(16);
    const hexN = (n) => Array.from({ length: n }, hex).join('');
    return `${hexN(8)}-${hexN(4)}-4${hexN(3)}-${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${hexN(3)}-${hexN(12)}`;
  }

  /**
   * Generate a random MAC address for VM network interface
   * Uses QEMU's OUI prefix: 52:54:00
   * @returns {string} Random MAC address
   */
  _generateMacAddress() {
    const randomHex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    return `52:54:00:${randomHex()}:${randomHex()}:${randomHex()}`;
  }

  /**
   * Generate libvirt XML for a virtual machine
   * @param {Object} config - VM configuration
   * @returns {string} Generated XML string
   */
  generateVmXml(config) {
    const {
      name,
      uuid = null,
      memory = 1024,
      cpus = 1,
      cpuPins = null,
      platform = 'q35',
      bios = 'ovmf',
      disks = [],
      cdroms = [],
      networks = [],
      graphics = { type: 'vnc', port: null, listen: '0.0.0.0' },
      hostdevices = [],
      usbdevices = []
    } = config;

    // Validate required fields
    if (!name || typeof name !== 'string') {
      throw new Error('VM name is required');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('VM name can only contain letters, numbers, underscores and hyphens');
    }

    // Parse memory - supports "4G", "4GB", "4096" (MiB), etc.
    const memoryMiB = this._parseSizeToMiB(memory);

    // Auto-calculate cpus from cpuPins if provided
    const effectiveCpus = (cpuPins && Array.isArray(cpuPins) && cpuPins.length > 0)
      ? cpuPins.length
      : cpus;

    // Validate boot_order - check for duplicates across disks and cdroms
    const bootOrders = [];
    [...disks, ...cdroms].forEach((item, idx) => {
      if (item.boot_order !== null && item.boot_order !== undefined) {
        if (bootOrders.includes(item.boot_order)) {
          throw new Error(`Duplicate boot_order ${item.boot_order} found. Each boot_order must be unique.`);
        }
        bootOrders.push(item.boot_order);
      }
    });

    // Validate bios
    if (!this.VALID_BIOS_TYPES.includes(bios)) {
      throw new Error(`Invalid BIOS type. Must be one of: ${this.VALID_BIOS_TYPES.join(', ')}`);
    }

    // Build machine type string
    // - "i440fx" maps to "pc" (alias for latest i440fx)
    // - "q35" stays as "q35" (alias for latest q35)
    // - Specific versions like "pc-i440fx-9.2" are used directly
    let machineType;
    if (platform === 'i440fx') {
      machineType = 'pc';
    } else if (platform === 'q35') {
      machineType = 'q35';
    } else if (platform.startsWith('pc-i440fx') || platform.startsWith('pc-q35')) {
      machineType = platform;
    } else {
      throw new Error(`Invalid platform. Must be 'i440fx', 'q35', or a specific version like 'pc-q35-9.2'`);
    }

    // Generate UUID if not provided
    const vmUuid = uuid || this._generateUuid();

    // Start building XML
    let xml = `<domain type='kvm'>
  <name>${this._escapeXml(name)}</name>
  <uuid>${vmUuid}</uuid>
  <memory unit='MiB'>${memoryMiB}</memory>
  <vcpu placement='static'>${effectiveCpus}</vcpu>`;

    // CPU pinning - map vCPUs to specific host cores
    if (cpuPins && Array.isArray(cpuPins) && cpuPins.length > 0) {
      xml += `
  <cputune>`;
      cpuPins.forEach((hostCpu, vcpuIndex) => {
        xml += `
    <vcpupin vcpu='${vcpuIndex}' cpuset='${hostCpu}'/>`;
      });
      xml += `
  </cputune>`;
    }

    // Check if per-device boot order is used (can't mix with os/boot)
    const hasPerDeviceBoot = [...disks, ...cdroms].some(item =>
      item.boot_order !== null && item.boot_order !== undefined
    );

    xml += `
  <os>
    <type arch='x86_64' machine='${machineType}'>hvm</type>`;

    // BIOS/UEFI configuration with NVRAM
    if (bios === 'ovmf' || bios === 'ovmf-tpm') {
      const biosPath = bios === 'ovmf-tpm' ? this.BIOS_PATHS.ovmf_tpm : this.BIOS_PATHS.ovmf;
      const nvramPath = `${this.NVRAM_PATH}/${vmUuid}_VARS.fd`;
      xml += `
    <loader readonly='yes' type='pflash'>${biosPath}</loader>
    <nvram template='${this.OVMF_VARS_TEMPLATE}'>${nvramPath}</nvram>`;
    }

    // Only add os/boot if no per-device boot order is specified
    if (!hasPerDeviceBoot) {
      xml += `
    <boot dev='hd'/>`;
    }

    xml += `
  </os>
  <features>
    <acpi/>
    <apic/>`;

    if (platform === 'q35') {
      xml += `
    <smm state='on'/>`;
    }

    xml += `
  </features>
  <cpu mode='host-passthrough' check='none' migratable='on'/>
  <clock offset='utc'>
    <timer name='rtc' tickpolicy='catchup'/>
    <timer name='pit' tickpolicy='delay'/>
    <timer name='hpet' present='no'/>
  </clock>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <emulator>${this.QEMU_PATH}</emulator>`;

    // TPM for OVMF-TPM
    if (bios === 'ovmf-tpm') {
      xml += `
    <tpm model='tpm-tis'>
      <backend type='emulator' version='2.0' persistent_state='yes'/>
    </tpm>`;
    }

    // Add disks
    disks.forEach((disk, index) => {
      xml += this._generateDiskXml(disk, index);
    });

    // Add CD-ROMs (pass disks array to calculate correct device offsets per bus type)
    cdroms.forEach((cdrom, index) => {
      xml += this._generateCdromXml(cdrom, index, disks);
    });

    // Add networks
    networks.forEach((network) => {
      xml += this._generateNetworkXml(network);
    });

    // Add graphics
    if (graphics && graphics.type !== 'none') {
      xml += this._generateGraphicsXml(graphics);
    }

    // Add USB controller (for input devices)
    xml += `
    <controller type='usb' model='qemu-xhci' ports='15'/>
    <input type='tablet' bus='usb'/>
    <input type='keyboard' bus='usb'/>`;

    // Add host devices (PCI passthrough)
    hostdevices.forEach((device) => {
      xml += this._generateHostdeviceXml(device);
    });

    // Add USB devices
    usbdevices.forEach((device) => {
      xml += this._generateUsbdeviceXml(device);
    });

    // Add console/serial
    xml += `
    <serial type='pty'>
      <target port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>`;

    // Close devices and domain
    xml += `
  </devices>
</domain>`;

    return xml;
  }

  /**
   * Generate disk XML section
   * @private
   */
  _generateDiskXml(disk, index) {
    const {
      type = 'virtio',
      source,
      format = 'qcow2',
      boot_order = null
    } = disk;

    if (!source) {
      throw new Error(`Disk ${index}: source path is required`);
    }

    // Determine target device name based on bus type
    let targetDev;
    switch (type) {
      case 'virtio':
        targetDev = `vd${String.fromCharCode(97 + index)}`; // vda, vdb, vdc...
        break;
      case 'sata':
      case 'scsi':
        targetDev = `sd${String.fromCharCode(97 + index)}`; // sda, sdb, sdc...
        break;
      case 'ide':
        targetDev = `hd${String.fromCharCode(97 + index)}`; // hda, hdb...
        break;
      default:
        targetDev = `vd${String.fromCharCode(97 + index)}`;
    }

    let xml = `
    <disk type='file' device='disk'>
      <driver name='qemu' type='${format}' cache='writeback' discard='unmap'/>
      <source file='${this._escapeXml(source)}'/>
      <target dev='${targetDev}' bus='${type === 'virtio' ? 'virtio' : type}'/>`;

    if (boot_order !== null) {
      xml += `
      <boot order='${boot_order}'/>`;
    }

    xml += `
    </disk>`;

    return xml;
  }

  /**
   * Generate network XML section
   * @private
   */
  _generateNetworkXml(network) {
    const {
      type = 'bridge',
      source,
      model = 'virtio',
      mac = null
    } = network;

    if (!source) {
      throw new Error('Network source is required');
    }

    const macAddress = mac || this._generateMacAddress();

    let xml = `
    <interface type='${type}'>
      <mac address='${macAddress}'/>`;

    if (type === 'bridge') {
      xml += `
      <source bridge='${this._escapeXml(source)}'/>`;
    } else if (type === 'network') {
      xml += `
      <source network='${this._escapeXml(source)}'/>`;
    } else if (type === 'macvtap') {
      xml += `
      <source dev='${this._escapeXml(source)}' mode='bridge'/>`;
    }

    xml += `
      <model type='${model}'/>
    </interface>`;

    return xml;
  }

  /**
   * Generate graphics XML section
   * @private
   */
  _generateGraphicsXml(graphics) {
    const {
      type = 'vnc',
      port = null,
      listen = '0.0.0.0',
      password = null
    } = graphics;

    // null or -1 means autoport
    const effectivePort = (port === null || port === -1) ? -1 : port;
    const autoport = (port === null || port === -1) ? 'yes' : 'no';

    let xml = `
    <graphics type='${type}' port='${effectivePort}' autoport='${autoport}' listen='${listen}'`;

    if (password) {
      xml += ` passwd='${this._escapeXml(password)}'`;
    }

    xml += `>
      <listen type='address' address='${listen}'/>
    </graphics>`;

    // Add video device
    xml += `
    <video>
      <model type='${type === 'spice' ? 'qxl' : 'virtio'}' heads='1' primary='yes'/>
    </video>`;

    return xml;
  }

  /**
   * Generate CD-ROM XML section
   * @private
   */
  _generateCdromXml(cdrom, index, disks = []) {
    const {
      source = null,
      bus = 'sata',
      boot_order = null
    } = cdrom;

    // CD-ROM target device naming based on bus type
    // Count how many disks use the same bus type to avoid conflicts
    let diskOffset = 0;
    if (bus === 'ide') {
      diskOffset = disks.filter(d => d.type === 'ide').length;
    } else if (bus === 'sata' || bus === 'scsi') {
      diskOffset = disks.filter(d => d.type === 'sata' || d.type === 'scsi').length;
    }

    const cdromOffset = diskOffset + index;
    let targetDev;
    switch (bus) {
      case 'ide':
        targetDev = `hd${String.fromCharCode(97 + cdromOffset)}`; // hda, hdb...
        break;
      case 'sata':
      case 'scsi':
      default:
        targetDev = `sd${String.fromCharCode(97 + cdromOffset)}`; // sda, sdb...
        break;
    }

    let xml = `
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>`;

    if (source) {
      xml += `
      <source file='${this._escapeXml(source)}'/>`;
    }

    xml += `
      <target dev='${targetDev}' bus='${bus}'/>
      <readonly/>`;

    if (boot_order !== null) {
      xml += `
      <boot order='${boot_order}'/>`;
    }

    xml += `
    </disk>`;

    return xml;
  }

  /**
   * Generate hostdevice (PCI passthrough) XML section
   * @private
   */
  _generateHostdeviceXml(device) {
    const { type = 'pci', address } = device;

    if (!address) {
      throw new Error('Host device address is required');
    }

    // Parse PCI address format: 0000:01:00.0
    const match = address.match(/^([0-9a-f]{4}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-9a-f])$/i);
    if (!match) {
      throw new Error(`Invalid PCI address format: ${address}. Expected format: 0000:01:00.0`);
    }

    const [, domain, bus, slot, func] = match;

    return `
    <hostdev mode='subsystem' type='pci' managed='yes'>
      <source>
        <address domain='0x${domain}' bus='0x${bus}' slot='0x${slot}' function='0x${func}'/>
      </source>
    </hostdev>`;
  }

  /**
   * Generate USB device passthrough XML section
   * @private
   */
  _generateUsbdeviceXml(device) {
    const { vendor, product } = device;

    if (!vendor || !product) {
      throw new Error('USB device requires vendor and product ID');
    }

    // Normalize vendor/product IDs - remove 0x prefix if present, then add it
    const normalizeId = (id) => {
      const str = String(id).toLowerCase().replace(/^0x/, '');
      return `0x${str}`;
    };

    return `
    <hostdev mode='subsystem' type='usb' managed='yes'>
      <source>
        <vendor id='${normalizeId(vendor)}'/>
        <product id='${normalizeId(product)}'/>
      </source>
    </hostdev>`;
  }

  /**
   * Escape special XML characters
   * @private
   */
  _escapeXml(str) {
    if (typeof str !== 'string') return str;
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // ============================================================
  // XML Validation
  // ============================================================

  /**
   * Validate VM XML using virsh
   * Checks if libvirt would accept this XML configuration
   * @param {string} xml - XML string to validate
   * @returns {Promise<Object>} Validation result
   */
  async validateVmXml(xml) {
    try {
      // Create unique temporary name and UUID to avoid conflicts with existing VMs
      const tempVmName = `_validate_temp_${Date.now()}`;
      const tempUuid = this._generateUuid();

      // Replace VM name and UUID to avoid conflicts
      let modifiedXml = xml.replace(/<name>[^<]+<\/name>/, `<name>${tempVmName}</name>`);
      modifiedXml = modifiedXml.replace(/<uuid>[^<]+<\/uuid>/, `<uuid>${tempUuid}</uuid>`);

      // Write modified XML to temp file
      const tempFile = `/tmp/vm-validate-${Date.now()}.xml`;
      await fs.writeFile(tempFile, modifiedXml, 'utf8');

      try {
        // Use virsh to validate - this checks if libvirt would accept the XML
        await execPromise(`virsh define --validate ${tempFile}`);

        // Always undefine the temporary VM
        try {
          await execPromise(`virsh undefine ${tempVmName} --keep-nvram`);
        } catch (e) {
          // Ignore undefine errors
        }

        return { valid: true, message: 'XML is valid and accepted by libvirt' };
      } catch (error) {
        return {
          valid: false,
          message: 'XML validation failed',
          error: error.stderr || error.message
        };
      } finally {
        // Clean up temp file
        try {
          await fs.unlink(tempFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      throw new Error(`Failed to validate VM XML: ${error.message}`);
    }
  }

  // ============================================================
  // VM Creation & Deletion
  // ============================================================

  /**
   * Create a new virtual machine
   * @param {Object} config - VM configuration
   * @returns {Promise<Object>} Created VM info
   */
  async createVm(config) {
    try {
      // Check if VM already exists
      const vms = await this.listVms();
      if (vms.some(vm => vm.name === config.name)) {
        throw new Error(`VM "${config.name}" already exists`);
      }

      // Auto-create disks that don't exist
      if (config.disks && config.disks.length > 0) {
        for (const disk of config.disks) {
          if (disk.source && disk.size) {
            // Check if disk file exists
            try {
              await fs.access(disk.source);
            } catch (e) {
              // Disk doesn't exist, create it
              await this.createDisk(disk.source, disk.size, disk.format || 'qcow2');
            }
          }
        }
      }

      // Generate XML
      const xml = this.generateVmXml(config);

      // Write XML to libvirt directory
      const xmlPath = path.join(this.LIBVIRT_QEMU_PATH, `${config.name}.xml`);
      await fs.writeFile(xmlPath, xml, 'utf8');

      try {
        // Define the VM using virsh
        await execPromise(`virsh define ${xmlPath}`);

        return {
          success: true,
          message: `VM "${config.name}" created successfully`,
          name: config.name,
          xmlPath
        };
      } catch (error) {
        // Clean up XML file on failure
        try {
          await fs.unlink(xmlPath);
        } catch (e) {
          // Ignore cleanup errors
        }
        throw error;
      }
    } catch (error) {
      throw new Error(`Failed to create VM: ${error.message}`);
    }
  }

  /**
   * Get the allowed vdisk_directory from VM settings
   * @private
   */
  async _getVdiskDirectory() {
    try {
      const settings = await getMosService().getVmSettings();
      return settings.vdisk_directory || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Delete a virtual machine
   * @param {string} vmName - Name of VM to delete
   * @param {Object} options - Delete options
   * @param {boolean} options.removeDisks - Whether to remove associated disk files (ONLY from vdisk_directory!)
   * @param {boolean} options.removeNvram - Whether to remove NVRAM (default: false, keeps NVRAM for TPM/UEFI VMs)
   * @returns {Promise<Object>} Deletion result
   */
  async deleteVm(vmName, options = {}) {
    const { removeDisks = false, removeNvram = false } = options;

    try {
      // Check VM state
      const vms = await this.listVms();
      const vm = vms.find(v => v.name === vmName);

      if (!vm) {
        throw new Error(`VM "${vmName}" not found`);
      }

      // Stop VM if running
      if (vm.state === 'running') {
        await this.killVm(vmName);
      }

      // Get VM UUID and disk paths before undefining
      let vmUuid = null;
      try {
        const { stdout } = await execPromise(`virsh domuuid ${vmName}`);
        vmUuid = stdout.trim();
      } catch (e) {
        // Ignore - VM might not have UUID
      }

      const allDiskPaths = vm.disks.map(d => d.source).filter(Boolean);
      const disksRemoved = [];
      const disksSkipped = [];
      let tpmRemoved = false;

      // Build undefine command - NEVER use --remove-all-storage for safety
      let undefineCmd = `virsh undefine ${vmName}`;

      if (!removeNvram) {
        // Keep NVRAM by default (important for TPM/UEFI VMs)
        undefineCmd += ' --keep-nvram';
      } else {
        // Explicitly remove NVRAM
        undefineCmd += ' --nvram';
      }

      await execPromise(undefineCmd);

      // Remove swtpm TPM state if removeNvram is true and VM had a UUID
      if (removeNvram && vmUuid) {
        const tpmStatePath = `/etc/libvirt/qemu/swtpm-localca/tpm-states/${vmUuid}`;
        try {
          // Check if path exists before attempting removal
          await fs.access(tpmStatePath);
          await fs.rm(tpmStatePath, { recursive: true });
          tpmRemoved = true;
        } catch (e) {
          // TPM state doesn't exist or can't be removed - ignore
        }
      }

      // Manually remove disks only if they are in the allowed vdisk_directory
      if (removeDisks && allDiskPaths.length > 0) {
        const vdiskDirectory = await this._getVdiskDirectory();

        if (!vdiskDirectory) {
          // No vdisk_directory configured - skip all disk removal for safety
          disksSkipped.push(...allDiskPaths);
        } else {
          // Normalize the vdisk directory path
          const normalizedVdiskDir = path.resolve(vdiskDirectory);

          for (const diskPath of allDiskPaths) {
            const normalizedDiskPath = path.resolve(diskPath);

            // SAFETY CHECK: Only delete if disk is inside vdisk_directory
            if (normalizedDiskPath.startsWith(normalizedVdiskDir + path.sep)) {
              try {
                await fs.unlink(normalizedDiskPath);
                disksRemoved.push(diskPath);

                // Try to remove parent directory if empty (VM-specific folder)
                const parentDir = path.dirname(normalizedDiskPath);
                if (parentDir.startsWith(normalizedVdiskDir + path.sep)) {
                  try {
                    const files = await fs.readdir(parentDir);
                    if (files.length === 0) {
                      await fs.rmdir(parentDir);
                    }
                  } catch (e) {
                    // Ignore - directory not empty or other error
                  }
                }
              } catch (e) {
                // Disk file doesn't exist or can't be deleted
                disksSkipped.push(diskPath);
              }
            } else {
              // Disk is outside vdisk_directory - DO NOT DELETE
              disksSkipped.push(diskPath);
            }
          }
        }
      }

      return {
        success: true,
        message: `VM "${vmName}" deleted successfully`,
        disksRemoved,
        disksSkipped: disksSkipped.length > 0 ? disksSkipped : undefined,
        nvramRemoved: removeNvram,
        tpmRemoved
      };
    } catch (error) {
      throw new Error(`Failed to delete VM: ${error.message}`);
    }
  }

  // ============================================================
  // XML Read/Write
  // ============================================================

  /**
   * Get raw XML for a virtual machine
   * @param {string} vmName - Name of the VM
   * @returns {Promise<string>} Raw XML string
   */
  async getVmXml(vmName) {
    try {
      const { stdout } = await execPromise(`virsh dumpxml ${vmName}`);
      return stdout;
    } catch (error) {
      throw new Error(`Failed to get VM XML: ${error.message}`);
    }
  }

  /**
   * Update VM XML directly
   * @param {string} vmName - Name of the VM
   * @param {string} xml - New XML content
   * @param {boolean} validate - Whether to validate XML first
   * @returns {Promise<Object>} Update result
   */
  async updateVmXml(vmName, xml, validate = true) {
    try {
      // Check VM exists
      const vms = await this.listVms();
      const vm = vms.find(v => v.name === vmName);

      if (!vm) {
        throw new Error(`VM "${vmName}" not found`);
      }

      // Check if VM is running (can't update running VM's XML directly)
      if (vm.state === 'running') {
        throw new Error('Cannot update XML of a running VM. Please stop the VM first.');
      }

      // Validate XML if requested
      if (validate) {
        const validationResult = await this.validateVmXml(xml);
        if (!validationResult.valid) {
          throw new Error(`XML validation failed: ${validationResult.error}`);
        }
      }

      // Write to temp file and redefine
      const tempFile = `/tmp/vm-update-${vmName}-${Date.now()}.xml`;
      await fs.writeFile(tempFile, xml, 'utf8');

      try {
        await execPromise(`virsh define ${tempFile}`);

        return {
          success: true,
          message: `VM "${vmName}" XML updated successfully`
        };
      } finally {
        // Clean up temp file
        try {
          await fs.unlink(tempFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      throw new Error(`Failed to update VM XML: ${error.message}`);
    }
  }

  // ============================================================
  // Simplified Config (Read/Update)
  // ============================================================

  /**
   * Parse VM XML and extract simplified configuration
   * @param {string} vmName - Name of the VM
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object>} Simplified VM configuration
   */
  async getVmConfig(vmName, user = null) {
    try {
      const xml = await this.getVmXml(vmName);

      // Parse basic info
      const name = this._extractXmlValue(xml, 'name');
      const memory = parseInt(this._extractXmlValue(xml, 'memory')) || 0;
      const memoryUnit = this._extractXmlAttr(xml, 'memory', 'unit') || 'KiB';
      const vcpu = parseInt(this._extractXmlValue(xml, 'vcpu')) || 1;

      // Convert memory to bytes for formatting, then to MiB for raw value
      let memoryBytes = memory;
      if (memoryUnit === 'KiB') memoryBytes = memory * 1024;
      else if (memoryUnit === 'MiB') memoryBytes = memory * 1024 * 1024;
      else if (memoryUnit === 'GiB') memoryBytes = memory * 1024 * 1024 * 1024;

      const memoryMiB = Math.floor(memoryBytes / (1024 * 1024));
      const memoryHuman = this.formatBytes(memoryBytes, user);

      // Parse machine type and platform
      const machineType = this._extractXmlAttr(xml, 'type[^>]*machine', 'machine') || '';
      const platform = machineType.includes('q35') ? 'q35' : 'i440fx';

      // Determine BIOS type
      let bios = 'seabios';
      if (xml.includes('<loader')) {
        bios = xml.includes('TPM') ? 'ovmf-tpm' : 'ovmf';
      }
      if (xml.includes('<tpm')) {
        bios = 'ovmf-tpm';
      }

      // Parse CPU pins (which host cores are assigned)
      const cpuPins = this._parseCpuPinsFromXml(xml);

      // Parse disks with size info
      const disks = await this._parseDisksFromXml(xml, user);

      // Parse CD-ROMs
      const cdroms = this._parseCdromsFromXml(xml);

      // Parse networks
      const networks = this._parseNetworksFromXml(xml);

      // Parse graphics
      const graphics = this._parseGraphicsFromXml(xml);

      // Parse USB passthrough devices
      const usbDevices = this._parseUsbDevicesFromXml(xml);

      // Parse PCI passthrough devices
      const pciDevices = this._parsePciDevicesFromXml(xml);

      // Extract UUID
      const vmUuid = this._extractXmlValue(xml, 'uuid');

      return {
        name,
        uuid: vmUuid,
        memory: memoryMiB,
        memoryHuman,
        cpus: vcpu,
        cpuPins,
        platform,
        bios,
        disks,
        cdroms,
        networks,
        graphics,
        usbDevices,
        pciDevices
      };
    } catch (error) {
      throw new Error(`Failed to get VM config: ${error.message}`);
    }
  }

  /**
   * Update VM with simplified configuration
   * @param {string} vmName - Name of the VM
   * @param {Object} updates - Configuration updates
   * @returns {Promise<Object>} Update result
   */
  async updateVmConfig(vmName, updates) {
    try {
      // Get current config
      const currentConfig = await this.getVmConfig(vmName);

      // Merge updates with current config
      const newConfig = {
        ...currentConfig,
        ...updates,
        // Handle arrays properly
        disks: updates.disks || currentConfig.disks,
        cdroms: updates.cdroms || currentConfig.cdroms,
        networks: updates.networks || currentConfig.networks,
        graphics: updates.graphics || currentConfig.graphics
      };

      // Generate new XML
      const xml = this.generateVmXml(newConfig);

      // Update VM
      return await this.updateVmXml(vmName, xml);
    } catch (error) {
      throw new Error(`Failed to update VM config: ${error.message}`);
    }
  }

  /**
   * Extract value from XML element
   * @private
   */
  _extractXmlValue(xml, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag.split('[')[0]}>`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  }

  /**
   * Extract attribute from XML element
   * @private
   */
  _extractXmlAttr(xml, tag, attr) {
    const regex = new RegExp(`<${tag}[^>]*${attr}=['"]([^'"]+)['"]`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  }

  /**
   * Parse CPU pins from XML (vcpupin elements)
   * @private
   */
  _parseCpuPinsFromXml(xml) {
    const pins = [];
    const pinRegex = /<vcpupin\s+vcpu='(\d+)'\s+cpuset='([^']+)'/g;
    let match;

    while ((match = pinRegex.exec(xml)) !== null) {
      pins.push(parseInt(match[2])); // Just collect the host CPU numbers
    }

    return pins.length > 0 ? pins : null;
  }

  /**
   * Parse disks from XML with size information
   * Supports both file-based and block device disks
   * @private
   */
  async _parseDisksFromXml(xml, user = null) {
    const disks = [];
    // Match both type='file' and type='block' disks
    const diskRegex = /<disk[^>]*type='(file|block)'[^>]*device='disk'[^>]*>[\s\S]*?<\/disk>/g;
    let match;

    while ((match = diskRegex.exec(xml)) !== null) {
      const diskXml = match[0];
      const diskType = match[1]; // 'file' or 'block'

      // Get source based on disk type
      const source = diskType === 'file'
        ? this._extractXmlAttr(diskXml, 'source', 'file')
        : this._extractXmlAttr(diskXml, 'source', 'dev');

      const format = this._extractXmlAttr(diskXml, 'driver', 'type') || 'raw';
      const target = this._extractXmlAttr(diskXml, 'target', 'dev');
      const bus = this._extractXmlAttr(diskXml, 'target', 'bus') || 'virtio';
      const bootOrder = this._extractXmlAttr(diskXml, 'boot', 'order');

      if (source) {
        const disk = {
          source,
          format,
          target,
          diskType,  // 'file' or 'block'
          bus: bus === 'virtio' ? 'virtio' : bus,
          boot_order: bootOrder ? parseInt(bootOrder) : null,
          size: null,
          sizeHuman: null,
          actualSize: null,
          actualSizeHuman: null
        };

        // Get disk size
        try {
          if (diskType === 'file') {
            // File-based disk: use qemu-img info
            const { stdout } = await execPromise(`qemu-img info --output=json "${source}"`);
            const info = JSON.parse(stdout);
            disk.size = info['virtual-size'] || null;
            disk.sizeHuman = disk.size ? this.formatBytes(disk.size, user) : null;
            disk.actualSize = info['actual-size'] || null;
            disk.actualSizeHuman = disk.actualSize ? this.formatBytes(disk.actualSize, user) : null;
          } else {
            // Block device: use blockdev to get size
            const { stdout } = await execPromise(`blockdev --getsize64 "${source}"`);
            const size = parseInt(stdout.trim());
            disk.size = size || null;
            disk.sizeHuman = disk.size ? this.formatBytes(disk.size, user) : null;
            // For block devices, actual size = virtual size
            disk.actualSize = disk.size;
            disk.actualSizeHuman = disk.sizeHuman;
          }
        } catch (e) {
          // Disk might not exist or command not available
        }

        disks.push(disk);
      }
    }

    return disks;
  }

  /**
   * Parse CD-ROMs from XML
   * @private
   */
  _parseCdromsFromXml(xml) {
    const cdroms = [];
    const cdromRegex = /<disk[^>]*device='cdrom'[^>]*>[\s\S]*?<\/disk>/g;
    let match;

    while ((match = cdromRegex.exec(xml)) !== null) {
      const cdromXml = match[0];
      const source = this._extractXmlAttr(cdromXml, 'source', 'file');
      const target = this._extractXmlAttr(cdromXml, 'target', 'dev');
      const bus = this._extractXmlAttr(cdromXml, 'target', 'bus') || 'sata';
      const bootOrder = this._extractXmlAttr(cdromXml, 'boot', 'order');

      cdroms.push({
        source: source || null,
        target,
        bus,
        boot_order: bootOrder ? parseInt(bootOrder) : null
      });
    }

    return cdroms;
  }

  /**
   * Parse networks from XML
   * @private
   */
  _parseNetworksFromXml(xml) {
    const networks = [];
    const ifaceRegex = /<interface[^>]*type='([^']+)'[^>]*>[\s\S]*?<\/interface>/g;
    let match;

    while ((match = ifaceRegex.exec(xml)) !== null) {
      const ifaceXml = match[0];
      const type = match[1];
      const mac = this._extractXmlAttr(ifaceXml, 'mac', 'address');
      const model = this._extractXmlAttr(ifaceXml, 'model', 'type') || 'virtio';

      let source;
      if (type === 'bridge') {
        source = this._extractXmlAttr(ifaceXml, 'source', 'bridge');
      } else if (type === 'network') {
        source = this._extractXmlAttr(ifaceXml, 'source', 'network');
      } else if (type === 'direct') {
        source = this._extractXmlAttr(ifaceXml, 'source', 'dev');
      }

      networks.push({ type, source, model, mac });
    }

    return networks;
  }

  /**
   * Parse graphics from XML
   * @private
   */
  _parseGraphicsFromXml(xml) {
    const graphicsMatch = xml.match(/<graphics[^>]*type='([^']+)'[^>]*/);
    if (!graphicsMatch) {
      return { type: 'none', port: null, listen: null };
    }

    const graphicsXml = graphicsMatch[0];
    const portStr = this._extractXmlAttr(graphicsXml, 'graphics', 'port');
    const port = portStr ? parseInt(portStr) : null;

    return {
      type: graphicsMatch[1],
      port: (port === -1) ? null : port,  // Convert -1 (autoport) to null
      listen: this._extractXmlAttr(graphicsXml, 'listen', 'address') || '0.0.0.0'
    };
  }

  /**
   * Parse USB passthrough devices from XML
   * @private
   */
  _parseUsbDevicesFromXml(xml) {
    const devices = [];
    const hostdevRegex = /<hostdev[^>]*type='usb'[^>]*>[\s\S]*?<\/hostdev>/g;
    let match;

    while ((match = hostdevRegex.exec(xml)) !== null) {
      const hostdevXml = match[0];

      // Extract vendor and product IDs
      const vendorMatch = hostdevXml.match(/<vendor\s+id='([^']+)'/);
      const productMatch = hostdevXml.match(/<product\s+id='([^']+)'/);

      if (vendorMatch && productMatch) {
        devices.push({
          vendor: vendorMatch[1],
          product: productMatch[1]
        });
      }
    }

    return devices.length > 0 ? devices : null;
  }

  /**
   * Parse PCI passthrough devices from XML
   * @private
   */
  _parsePciDevicesFromXml(xml) {
    const devices = [];
    const hostdevRegex = /<hostdev[^>]*type='pci'[^>]*>[\s\S]*?<\/hostdev>/g;
    let match;

    while ((match = hostdevRegex.exec(xml)) !== null) {
      const hostdevXml = match[0];

      // Extract PCI address components
      const domainMatch = hostdevXml.match(/<address[^>]*domain='([^']+)'/);
      const busMatch = hostdevXml.match(/<address[^>]*bus='([^']+)'/);
      const slotMatch = hostdevXml.match(/<address[^>]*slot='([^']+)'/);
      const functionMatch = hostdevXml.match(/<address[^>]*function='([^']+)'/);

      if (busMatch && slotMatch) {
        const domain = domainMatch ? domainMatch[1] : '0x0000';
        const bus = busMatch[1];
        const slot = slotMatch[1];
        const func = functionMatch ? functionMatch[1] : '0x0';

        // Format as standard PCI address (e.g., "0000:01:00.0")
        const pciAddress = `${domain.replace('0x', '')}:${bus.replace('0x', '')}:${slot.replace('0x', '')}.${func.replace('0x', '')}`;

        devices.push({
          address: pciAddress,
          domain,
          bus,
          slot,
          function: func
        });
      }
    }

    return devices.length > 0 ? devices : null;
  }

  // ============================================================
  // Disk Management
  // ============================================================

  /**
   * Create a new virtual disk image
   * @param {string} diskPath - Full path for the disk file
   * @param {string} size - Disk size (e.g., "50G", "100G")
   * @param {string} format - Disk format (qcow2 or raw)
   * @returns {Promise<Object>} Creation result
   */
  async createDisk(diskPath, size, format = 'qcow2') {
    try {
      if (!this.VALID_DISK_FORMATS.includes(format)) {
        throw new Error(`Invalid disk format. Must be one of: ${this.VALID_DISK_FORMATS.join(', ')}`);
      }

      // Ensure parent directory exists
      const dir = path.dirname(diskPath);
      await fs.mkdir(dir, { recursive: true });

      // Create disk with qemu-img
      await execPromise(`qemu-img create -f ${format} "${diskPath}" ${size}`);

      return {
        success: true,
        message: `Disk created successfully`,
        path: diskPath,
        size,
        format
      };
    } catch (error) {
      throw new Error(`Failed to create disk: ${error.message}`);
    }
  }

  // ============================================================
  // VirtIO Driver Management
  // ============================================================

  /**
   * Send notification via mos-notify socket
   * @private
   */
  _sendNotification(title, message, priority = 'normal') {
    return new Promise((resolve) => {
      const client = net.createConnection(MOS_NOTIFY_SOCKET, () => {
        const payload = JSON.stringify({ title, message, priority });
        client.write(payload);
        client.end();
        resolve(true);
      });
      client.on('error', () => {
        // Ignore notification errors - non-critical
        resolve(false);
      });
    });
  }

  /**
   * Fetch HTML content from URL
   * @private
   */
  _fetchUrl(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  /**
   * Get available VirtIO versions from Fedora archive
   * @returns {Promise<Array>} List of available versions
   */
  async getVirtioVersions() {
    try {
      const html = await this._fetchUrl(VIRTIO_ARCHIVE_URL);

      // Parse directory listing - extract virtio-win-X.X.XXX-X folders
      const versionRegex = /href="virtio-win-([\d.]+-\d+)\/"/g;
      const versions = [];
      let match;

      while ((match = versionRegex.exec(html)) !== null) {
        versions.push(match[1]);
      }

      // Sort versions descending (newest first)
      versions.sort((a, b) => {
        const parseVersion = (v) => {
          const parts = v.split(/[.-]/).map(Number);
          return parts;
        };
        const aParts = parseVersion(a);
        const bParts = parseVersion(b);
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const diff = (bParts[i] || 0) - (aParts[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });

      return versions;
    } catch (error) {
      throw new Error(`Failed to fetch VirtIO versions: ${error.message}`);
    }
  }

  /**
   * Get installed VirtIO ISOs
   * @returns {Promise<Array>} List of installed versions
   */
  async getInstalledVirtioVersions() {
    try {
      // Ensure directory exists
      try {
        await fs.mkdir(VIRTIO_ISO_DIR, { recursive: true });
      } catch (e) {
        // Ignore
      }

      const files = await fs.readdir(VIRTIO_ISO_DIR);
      const versions = files
        .filter(f => f.endsWith('.iso'))
        .map(f => f.replace('.iso', ''))
        .sort((a, b) => {
          const parseVersion = (v) => v.split(/[.-]/).map(Number);
          const aParts = parseVersion(a);
          const bParts = parseVersion(b);
          for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            const diff = (bParts[i] || 0) - (aParts[i] || 0);
            if (diff !== 0) return diff;
          }
          return 0;
        });

      return versions;
    } catch (error) {
      throw new Error(`Failed to get installed VirtIO versions: ${error.message}`);
    }
  }

  /**
   * Download a VirtIO ISO
   * @param {string} version - Version to download (e.g., "0.1.271-1")
   * @returns {Promise<Object>} Download status
   */
  async downloadVirtioIso(version) {
    try {
      // Validate version format
      if (!/^[\d.]+-\d+$/.test(version)) {
        throw new Error('Invalid version format. Expected format: X.X.XXX-X (e.g., 0.1.271-1)');
      }

      // Ensure directory exists
      await fs.mkdir(VIRTIO_ISO_DIR, { recursive: true });

      const isoPath = path.join(VIRTIO_ISO_DIR, `${version}.iso`);

      // URL structure: folder is virtio-win-0.1.285-1, but ISO is virtio-win-0.1.285.iso (without build number)
      // Version format: 0.1.285-1 -> baseVersion: 0.1.285, buildNumber: 1
      const lastDashIndex = version.lastIndexOf('-');
      const baseVersion = version.substring(0, lastDashIndex);
      const downloadUrl = `${VIRTIO_ARCHIVE_URL}virtio-win-${version}/virtio-win-${baseVersion}.iso`;

      // Check if already exists
      let redownload = false;
      try {
        await fs.access(isoPath);
        redownload = true;
      } catch (e) {
        // File doesn't exist
      }

      // Start download in background using wget
      const downloadProcess = spawn('wget', [
        '-q',
        '-O', isoPath,
        downloadUrl
      ], {
        detached: true,
        stdio: 'ignore'
      });

      downloadProcess.unref();

      // Monitor download completion in background
      downloadProcess.on('close', async (code) => {
        if (code === 0) {
          await this._sendNotification(
            'VMs',
            `Download of VirtIO ISO ${version} finished`,
            'normal'
          );
        } else {
          // Clean up failed download
          try {
            await fs.unlink(isoPath);
          } catch (e) {
            // Ignore
          }
          await this._sendNotification(
            'VMs',
            `Download of VirtIO ISO ${version} failed`,
            'warning'
          );
        }
      });

      return {
        success: true,
        message: redownload
          ? `Redownloading VirtIO ISO ${version}`
          : `Download of VirtIO ISO ${version} started`,
        version,
        path: isoPath
      };
    } catch (error) {
      throw new Error(`Failed to download VirtIO ISO: ${error.message}`);
    }
  }

  /**
   * Cleanup old VirtIO ISOs - keeps only the newest version
   * @returns {Promise<Object>} Cleanup result
   */
  async cleanupVirtioIsos() {
    try {
      const versions = await this.getInstalledVirtioVersions();

      if (versions.length === 0) {
        return {
          success: true,
          message: 'No VirtIO ISOs installed',
          kept: null,
          deleted: []
        };
      }

      if (versions.length === 1) {
        return {
          success: true,
          message: 'Only one VirtIO ISO installed, nothing to cleanup',
          kept: versions[0],
          deleted: []
        };
      }

      // Versions are already sorted newest first
      const newest = versions[0];
      const toDelete = versions.slice(1);
      const deleted = [];

      for (const version of toDelete) {
        const isoPath = path.join(VIRTIO_ISO_DIR, `${version}.iso`);
        try {
          await fs.unlink(isoPath);
          deleted.push(version);
        } catch (e) {
          // Ignore deletion errors
        }
      }

      return {
        success: true,
        message: `Cleanup completed, kept ${newest}`,
        kept: newest,
        deleted
      };
    } catch (error) {
      throw new Error(`Failed to cleanup VirtIO ISOs: ${error.message}`);
    }
  }
}

module.exports = new VmService();
