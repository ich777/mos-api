const express = require('express');
const router = express.Router();
const vmService = require('../services/vm.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: VM
 *   description: Virtual Machine Management (Admin only)
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     VmDisk:
 *       type: object
 *       properties:
 *         target:
 *           type: string
 *           description: Target device name
 *           example: "vda"
 *         source:
 *           type: string
 *           description: Source disk path
 *           example: "/var/lib/libvirt/images/myvm.qcow2"
 *     VirtualMachine:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Virtual machine name
 *           example: "ubuntu-server"
 *         state:
 *           type: string
 *           enum: [running, stopped]
 *           description: Current VM state
 *           example: "running"
 *         disks:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/VmDisk'
 *           description: List of attached disks
 *           example:
 *             - target: "vda"
 *               source: "/var/lib/libvirt/images/ubuntu-server.qcow2"
 *             - target: "vdb"
 *               source: "/var/lib/libvirt/images/data-disk.qcow2"
 *         vncPort:
 *           type: integer
 *           nullable: true
 *           description: VNC port number (5900 + display number) if VM is running and has VNC enabled
 *           example: 5900
 *         autostart:
 *           type: boolean
 *           description: Whether the VM is configured to start automatically on system boot
 *           example: true
 *     VmOperationResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *           example: true
 *         message:
 *           type: string
 *           description: Operation status message
 *           example: "VM ubuntu-server started successfully"
 */

// All routes in this file require admin role
router.use(checkRole(['admin']));

/**
 * @swagger
 * /vm/machines:
 *   get:
 *     summary: List all virtual machines
 *     description: Retrieve a list of all virtual machines with their status, disk information and VNC ports (admin only)
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all virtual machines retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/VirtualMachine'
 *             example:
 *               - name: "ubuntu-server"
 *                 state: "running"
 *                 disks:
 *                   - target: "vda"
 *                     source: "/var/lib/libvirt/images/ubuntu-server.qcow2"
 *                 vncPort: 5900
 *                 autostart: true
 *               - name: "windows-10"
 *                 state: "stopped"
 *                 disks:
 *                   - target: "vda"
 *                     source: "/var/lib/libvirt/images/windows.qcow2"
 *                   - target: "vdb"
 *                     source: "/var/lib/libvirt/images/data.qcow2"
 *                 vncPort: null
 *                 autostart: false
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Failed to list virtual machines: libvirt connection failed"
 */

// List all VMs
router.get('/machines', async (req, res) => {
  try {
    const vms = await vmService.listVms();
    res.json(vms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/start:
 *   post:
 *     summary: Start a virtual machine
 *     description: Start a stopped virtual machine by name (admin only)
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Virtual machine name
 *         example: "ubuntu-server"
 *     responses:
 *       200:
 *         description: Virtual machine started successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmOperationResult'
 *             example:
 *               success: true
 *               message: "VM ubuntu-server started successfully"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error starting virtual machine
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               vm_already_running:
 *                 summary: VM is already running
 *                 value:
 *                   error: "Failed to start VM ubuntu-server: domain is already running"
 *               vm_not_found:
 *                 summary: VM does not exist
 *                 value:
 *                   error: "Failed to start VM ubuntu-server: Domain not found"
 *               resource_error:
 *                 summary: Insufficient resources
 *                 value:
 *                   error: "Failed to start VM ubuntu-server: insufficient memory"
 */

// Start a VM
router.post('/machines/:name/start', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await vmService.startVm(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/stop:
 *   post:
 *     summary: Stop a virtual machine (graceful shutdown)
 *     description: Gracefully shutdown a running virtual machine by sending ACPI shutdown signal (admin only)
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Virtual machine name
 *         example: "ubuntu-server"
 *     responses:
 *       200:
 *         description: Virtual machine shutdown initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmOperationResult'
 *             example:
 *               success: true
 *               message: "VM ubuntu-server shutdown initiated"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error stopping virtual machine
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               vm_not_running:
 *                 summary: VM is not running
 *                 value:
 *                   error: "Failed to stop VM ubuntu-server: domain is not running"
 *               vm_not_found:
 *                 summary: VM does not exist
 *                 value:
 *                   error: "Failed to stop VM ubuntu-server: Domain not found"
 *               shutdown_failed:
 *                 summary: Shutdown command failed
 *                 value:
 *                   error: "Failed to stop VM ubuntu-server: guest agent not available"
 */

// Stop a VM (graceful shutdown)
router.post('/machines/:name/stop', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await vmService.stopVm(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/kill:
 *   post:
 *     summary: Kill a virtual machine (force stop)
 *     description: Forcefully terminate a running virtual machine without graceful shutdown (admin only). Use this when normal stop doesn't work.
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Virtual machine name
 *         example: "ubuntu-server"
 *     responses:
 *       200:
 *         description: Virtual machine killed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmOperationResult'
 *             example:
 *               success: true
 *               message: "VM ubuntu-server killed successfully"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error killing virtual machine
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               vm_not_running:
 *                 summary: VM is not running
 *                 value:
 *                   error: "Failed to kill VM ubuntu-server: domain is not running"
 *               vm_not_found:
 *                 summary: VM does not exist
 *                 value:
 *                   error: "Failed to kill VM ubuntu-server: Domain not found"
 *               kill_failed:
 *                 summary: Force stop command failed
 *                 value:
 *                   error: "Failed to kill VM ubuntu-server: operation failed"
 */

// Kill a VM (force stop)
router.post('/machines/:name/kill', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await vmService.killVm(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/restart:
 *   post:
 *     summary: Restart a virtual machine (graceful reboot)
 *     description: Gracefully reboot a running virtual machine by sending ACPI reboot signal (admin only)
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Virtual machine name
 *         example: "ubuntu-server"
 *     responses:
 *       200:
 *         description: Virtual machine restart initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmOperationResult'
 *             example:
 *               success: true
 *               message: "VM ubuntu-server restart initiated"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error restarting virtual machine
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               vm_not_running:
 *                 summary: VM is not running
 *                 value:
 *                   error: "Failed to restart VM ubuntu-server: domain is not running"
 *               vm_not_found:
 *                 summary: VM does not exist
 *                 value:
 *                   error: "Failed to restart VM ubuntu-server: Domain not found"
 *               restart_failed:
 *                 summary: Restart command failed
 *                 value:
 *                   error: "Failed to restart VM ubuntu-server: guest agent not available"
 */

// Restart a VM (graceful reboot)
router.post('/machines/:name/restart', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await vmService.restartVm(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/reset:
 *   post:
 *     summary: Reset a virtual machine (hard reset)
 *     description: Forcefully reset a running virtual machine without graceful shutdown, like pressing the reset button (admin only)
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Virtual machine name
 *         example: "ubuntu-server"
 *     responses:
 *       200:
 *         description: Virtual machine reset successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmOperationResult'
 *             example:
 *               success: true
 *               message: "VM ubuntu-server reset successfully"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error resetting virtual machine
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               vm_not_running:
 *                 summary: VM is not running
 *                 value:
 *                   error: "Failed to reset VM ubuntu-server: domain is not running"
 *               vm_not_found:
 *                 summary: VM does not exist
 *                 value:
 *                   error: "Failed to reset VM ubuntu-server: Domain not found"
 *               reset_failed:
 *                 summary: Reset command failed
 *                 value:
 *                   error: "Failed to reset VM ubuntu-server: operation failed"
 */

// Reset a VM (hard reset)
router.post('/machines/:name/reset', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await vmService.resetVm(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/autostart:
 *   get:
 *     summary: Get autostart status of a virtual machine
 *     description: Retrieve whether a virtual machine is configured to start automatically on system boot (admin only)
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Virtual machine name
 *         example: "ubuntu-server"
 *     responses:
 *       200:
 *         description: Autostart status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vmName:
 *                   type: string
 *                   description: Virtual machine name
 *                   example: "ubuntu-server"
 *                 autostart:
 *                   type: boolean
 *                   description: Whether autostart is enabled
 *                   example: true
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error retrieving autostart status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Failed to get autostart status for VM ubuntu-server: Domain not found"
 */

// Get autostart status
router.get('/machines/:name/autostart', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await vmService.getAutostartStatus(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/autostart:
 *   put:
 *     summary: Set autostart status for a virtual machine
 *     description: Enable or disable automatic startup of a virtual machine on system boot (admin only)
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Virtual machine name
 *         example: "ubuntu-server"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - enabled
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 description: Enable or disable autostart
 *                 example: true
 *           examples:
 *             enable:
 *               summary: Enable autostart
 *               value:
 *                 enabled: true
 *             disable:
 *               summary: Disable autostart
 *               value:
 *                 enabled: false
 *     responses:
 *       200:
 *         description: Autostart status updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Operation successful
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Operation status message
 *                   example: "Autostart enabled for VM ubuntu-server"
 *                 autostart:
 *                   type: boolean
 *                   description: Current autostart status
 *                   example: true
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "enabled field is required and must be a boolean"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error setting autostart status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Failed to set autostart for VM ubuntu-server: Domain not found"
 */

// Set autostart status
router.put('/machines/:name/autostart', async (req, res) => {
  try {
    const { name } = req.params;
    const { enabled } = req.body;

    // Validate request body
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled field is required and must be a boolean' });
    }

    const result = await vmService.setAutostart(name, enabled);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// QEMU Capabilities & System Info
// ============================================================

/**
 * @swagger
 * /vm/machinetypes:
 *   get:
 *     summary: Get available QEMU machine types
 *     description: |
 *       Returns list of available machine types (pc-i440fx and pc-q35 only).
 *       Sorted with i440fx alias first, then i440fx versions descending, then q35 alias, then q35 versions descending.
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available QEMU machine types
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Machine type name (use this in platform field when creating VM)
 *                     example: "i440fx"
 *                   description:
 *                     type: string
 *                     example: "Standard PC (i440FX + PIIX, 1996) (alias of pc-i440fx-10.1)"
 */
router.get('/machinetypes', async (req, res) => {
  try {
    const machines = await vmService.getQemuMachines();
    res.json(machines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/capabilities:
 *   get:
 *     summary: Get VM capabilities
 *     description: Returns available BIOS types, disk options, network options, and machine types
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: VM capabilities and available resources
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 qemuPath:
 *                   type: string
 *                   example: "/usr/bin/qemu-system-x86_64"
 *                 libvirtPath:
 *                   type: string
 *                   example: "/etc/libvirt/qemu"
 *                 biosTypes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["seabios", "ovmf", "ovmf-tpm"]
 *                 biosFiles:
 *                   type: object
 *                   description: BIOS file availability
 *                 diskBuses:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["virtio", "sata", "usb", "scsi", "ide"]
 *                 diskFormats:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["qcow2", "raw"]
 *                 networkTypes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["bridge", "macvtap", "network"]
 *                 networkModels:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["virtio", "e1000", "rtl8139"]
 *                 graphicsTypes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["vnc", "spice", "none"]
 *                 machines:
 *                   type: array
 *                   description: Available QEMU machine types
 *                 networks:
 *                   type: object
 *                   properties:
 *                     bridges:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["br0", "docker0"]
 *                     libvirtNetworks:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["default"]
 */
router.get('/capabilities', async (req, res) => {
  try {
    const capabilities = await vmService.getVmCapabilities();
    res.json(capabilities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// VM Creation & Deletion
// ============================================================

/**
 * @swagger
 * /vm/machines:
 *   post:
 *     summary: Create a new virtual machine
 *     description: Create a new VM with the specified configuration. Disks are automatically created if they don't exist and a size is specified.
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: VM name (letters, numbers, underscores, hyphens only)
 *               memory:
 *                 type: string
 *                 description: Memory size. Supports units like "4G", "4GB", "4GiB", "512M", "512MB" or plain number in MiB
 *                 example: "4G"
 *                 default: 1024
 *               cpus:
 *                 type: integer
 *                 description: Number of vCPUs
 *                 default: 1
 *               cpuPins:
 *                 type: array
 *                 description: Host CPU cores to pin each vCPU to (e.g., [0, 10, 2, 12] pins vCPU0->core0, vCPU1->core10, etc.)
 *                 items:
 *                   type: integer
 *                 example: [0, 10, 2, 12]
 *               platform:
 *                 type: string
 *                 description: Machine type - use 'i440fx' or 'q35' for latest version, or specific like 'pc-q35-9.2'. Note - q35 is recommended for modern systems.
 *                 default: q35
 *               bios:
 *                 type: string
 *                 enum: [seabios, ovmf, ovmf-tpm]
 *                 description: BIOS type. Note - q35 platform should use 'ovmf' or 'ovmf-tpm', not seabios. Use seabios only with i440fx.
 *                 default: ovmf
 *               disks:
 *                 type: array
 *                 description: Disks are auto-created if source doesn't exist and size is provided
 *                 items:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [virtio, sata, usb, scsi, ide]
 *                     source:
 *                       type: string
 *                       description: Path to disk file
 *                     size:
 *                       type: string
 *                       description: Disk size (e.g., "50G") - only needed if disk should be created
 *                     format:
 *                       type: string
 *                       enum: [qcow2, raw]
 *                     boot_order:
 *                       type: integer
 *               cdroms:
 *                 type: array
 *                 description: CD-ROM/ISO drives
 *                 items:
 *                   type: object
 *                   properties:
 *                     source:
 *                       type: string
 *                       description: Path to ISO file (optional - can be empty for ejected drive)
 *                     bus:
 *                       type: string
 *                       enum: [sata, ide]
 *                       default: sata
 *                     boot_order:
 *                       type: integer
 *               networks:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [bridge, macvtap, network]
 *                     source:
 *                       type: string
 *                     model:
 *                       type: string
 *                       enum: [virtio, e1000, rtl8139]
 *                     mac:
 *                       type: string
 *               graphics:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [vnc, spice, none]
 *                   port:
 *                     type: integer
 *                     nullable: true
 *                     description: VNC/Spice port. Use null for autoport (recommended).
 *                     default: null
 *                   listen:
 *                     type: string
 *                     default: "0.0.0.0"
 *               hostdevices:
 *                 type: array
 *                 description: PCI passthrough devices
 *                 items:
 *                   type: object
 *                   properties:
 *                     address:
 *                       type: string
 *                       description: PCI address (e.g., "0000:01:00.0")
 *                       example: "0000:01:00.0"
 *               usbdevices:
 *                 type: array
 *                 description: USB passthrough devices
 *                 items:
 *                   type: object
 *                   properties:
 *                     vendor:
 *                       type: string
 *                       description: USB vendor ID with 0x prefix
 *                       example: "0x8564"
 *                     product:
 *                       type: string
 *                       description: USB product ID with 0x prefix
 *                       example: "0x1000"
 *     responses:
 *       200:
 *         description: VM created successfully
 *       400:
 *         description: Invalid configuration
 *       500:
 *         description: Failed to create VM
 */
router.post('/machines', async (req, res) => {
  try {
    const config = req.body;

    if (!config.name) {
      return res.status(400).json({ error: 'VM name is required' });
    }

    const result = await vmService.createVm(config);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}:
 *   delete:
 *     summary: Delete a virtual machine
 *     description: Delete a VM and optionally remove its disk files. NVRAM is kept by default to preserve TPM/UEFI state.
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: removeDisks
 *         schema:
 *           type: boolean
 *         description: Whether to remove associated disk files
 *       - in: query
 *         name: removeNvram
 *         schema:
 *           type: boolean
 *         description: Whether to remove NVRAM (default false - keeps NVRAM for TPM/UEFI VMs)
 *     responses:
 *       200:
 *         description: VM deleted successfully
 *       500:
 *         description: Failed to delete VM
 */
router.delete('/machines/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const options = {
      removeDisks: req.query.removeDisks === 'true',
      removeNvram: req.query.removeNvram === 'true'
    };
    const result = await vmService.deleteVm(name, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// XML Management
// ============================================================

/**
 * @swagger
 * /vm/machines/{name}/xml:
 *   get:
 *     summary: Get raw VM XML
 *     description: Returns the libvirt XML configuration for a VM wrapped in JSON
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: VM XML wrapped in JSON
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 xml:
 *                   type: string
 */
router.get('/machines/:name/xml', async (req, res) => {
  try {
    const { name } = req.params;
    const xml = await vmService.getVmXml(name);
    res.json({ xml });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/xml:
 *   put:
 *     summary: Update VM XML directly
 *     description: Replace the VM's XML configuration. VM must be stopped.
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: validate
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Whether to validate XML before applying
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - xml
 *             properties:
 *               xml:
 *                 type: string
 *                 description: The VM XML configuration
 *     responses:
 *       200:
 *         description: XML updated successfully
 *       400:
 *         description: VM is running or XML is invalid
 *       500:
 *         description: Failed to update XML
 */
router.put('/machines/:name/xml', async (req, res) => {
  try {
    const { name } = req.params;
    const validate = req.query.validate !== 'false';
    const { xml } = req.body;

    if (!xml) {
      return res.status(400).json({ error: 'xml field is required in request body' });
    }

    const result = await vmService.updateVmXml(name, xml, validate);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/xml/validate:
 *   post:
 *     summary: Validate VM XML
 *     description: Validate XML without applying it
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - xml
 *             properties:
 *               xml:
 *                 type: string
 *                 description: The VM XML to validate
 *     responses:
 *       200:
 *         description: Validation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                 message:
 *                   type: string
 */
router.post('/xml/validate', async (req, res) => {
  try {
    const { xml } = req.body;

    if (!xml) {
      return res.status(400).json({ error: 'xml field is required in request body' });
    }

    const result = await vmService.validateVmXml(xml);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Simplified Config
// ============================================================

/**
 * @swagger
 * /vm/machines/{name}/config:
 *   get:
 *     summary: Get simplified VM configuration
 *     description: Returns parsed VM configuration in a simplified format
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Simplified VM configuration
 */
router.get('/machines/:name/config', async (req, res) => {
  try {
    const { name } = req.params;
    const config = await vmService.getVmConfig(name, req.user);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /vm/machines/{name}/config:
 *   put:
 *     summary: Update VM with simplified configuration
 *     description: Update VM configuration using simplified format. VM must be stopped.
 *     tags: [VM]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               memory:
 *                 type: integer
 *               cpus:
 *                 type: integer
 *               platform:
 *                 type: string
 *               bios:
 *                 type: string
 *               disks:
 *                 type: array
 *               networks:
 *                 type: array
 *               graphics:
 *                 type: object
 *     responses:
 *       200:
 *         description: Configuration updated successfully
 *       500:
 *         description: Failed to update configuration
 */
router.put('/machines/:name/config', async (req, res) => {
  try {
    const { name } = req.params;
    const updates = req.body;
    const result = await vmService.updateVmConfig(name, updates);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
