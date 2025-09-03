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
 *               - name: "windows-10"
 *                 state: "stopped"
 *                 disks:
 *                   - target: "vda"
 *                     source: "/var/lib/libvirt/images/windows.qcow2"
 *                   - target: "vdb"
 *                     source: "/var/lib/libvirt/images/data.qcow2"
 *                 vncPort: null
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

module.exports = router;
