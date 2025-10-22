const express = require('express');
const router = express.Router();
const mosService = require('../services/mos.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: MOS
 *   description: MOS System Configuration and Settings Management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     DockerSettings:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *           description: Enable Docker service
 *           example: true
 *         directory:
 *           type: string
 *           description: Docker data directory
 *           example: "/mnt/pool1/docker"
 *         appdata:
 *           type: string
 *           description: Docker appdata directory
 *           example: "/mnt/pool1/appdata"
 *         docker_net:
 *           type: object
 *           description: Docker network configuration
 *           properties:
 *             mode:
 *               type: string
 *               enum: [macvlan, ipvlan]
 *               description: Docker network mode
 *               example: "ipvlan"
 *             config:
 *               type: array
 *               description: Network configuration entries
 *               items:
 *                 type: object
 *                 properties:
 *                   subnet:
 *                     type: string
 *                     description: Network subnet in CIDR notation
 *                     example: "10.0.0.0/24"
 *                   gateway:
 *                     type: string
 *                     description: Gateway IP address
 *                     example: "10.0.0.5"
 *         filesystem:
 *           type: string
 *           description: Docker filesystem type
 *           example: "btrfs"
 *         start_wait:
 *           type: string
 *           description: Wait time before starting Docker containers
 *           example: "0"
 *         docker_options:
 *           type: string
 *           description: Additional Docker daemon command line arguments
 *           example: "--log-level=info --storage-opt=overlay2.size=10G"
 *         update_check:
 *           type: object
 *           description: Docker update check configuration
 *           properties:
 *             enabled:
 *               type: boolean
 *               description: Enable update checking
 *               example: true
 *             update_check_schedule:
 *               type: string
 *               description: Cron schedule for update checks
 *               example: "0 1 * * *"
 *             auto_update:
 *               type: object
 *               description: Auto-update configuration
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable automatic updates
 *                   example: true
 *                 auto_update_schedule:
 *                   type: string
 *                   description: Cron schedule for auto-updates
 *                   example: "0 2 * * SAT"
 *     LxcSettings:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *           description: Enable LXC service
 *           example: true
 *         directory:
 *           type: string
 *           description: LXC containers directory
 *           example: "/mnt/pool1/lxc"
 *     VmSettings:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *           description: Enable VM service
 *           example: true
 *         directory:
 *           type: string
 *           description: VM storage directory
 *           example: "/mnt/pool1/vm"
 *         vdisk_directory:
 *           type: string
 *           description: Virtual disk directory
 *           example: "/mnt/pool1/vdisk"
 *         start_wait:
 *           type: integer
 *           description: Wait time before starting VMs
 *           example: 30
 *     NetworkSettings:
 *       type: object
 *       properties:
 *         interfaces:
 *           type: array
 *           description: Network interfaces configuration
 *           items:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Interface name
 *                 example: "eth0"
 *               type:
 *                 type: string
 *                 enum: [ethernet, bridged, bridge]
 *                 description: Interface type
 *                 example: "ethernet"
 *               mode:
 *                 type: string
 *                 nullable: true
 *                 description: Interface mode
 *                 example: null
 *               interfaces:
 *                 type: array
 *                 description: Bridge member interfaces (for bridge type)
 *                 items:
 *                   type: string
 *                 example: ["eth0"]
 *               ipv4:
 *                 type: array
 *                 description: IPv4 configuration array
 *                 items:
 *                   type: object
 *                   properties:
 *                     dhcp:
 *                       type: boolean
 *                       description: Enable DHCP for this IPv4 config
 *                       example: true
 *                     address:
 *                       type: string
 *                       description: Static IP address with CIDR (required when dhcp=false)
 *                       example: "10.0.0.1/24"
 *                     gateway:
 *                       type: string
 *                       description: Gateway IP address (optional for static)
 *                       example: "10.0.0.5"
 *                     dns:
 *                       type: array
 *                       description: DNS servers (optional for static)
 *                       items:
 *                         type: string
 *                       example: ["10.0.0.5"]
 *                 example: [{"dhcp": true}]
 *               ipv6:
 *                 type: array
 *                 description: IPv6 configuration array (currently always empty)
 *                 items:
 *                   type: object
 *                 example: []
 *         services:
 *           type: object
 *           properties:
 *             ssh:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable SSH service
 *                   example: true
 *             samba:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable Samba service
 *                   example: true
 *             nfs:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable NFS service
 *                   example: false
 *             nut:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable NUT (Network UPS Tools) service
 *                   example: false
 *             remote_mounting:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable remote mounting functionality (SMB/NFS shares)
 *                   example: true
 *     SystemSettings:
 *       type: object
 *       properties:
 *         hostname:
 *           type: string
 *           description: System hostname
 *           example: "mos-server"
 *         global_spindown:
 *           type: boolean
 *           description: Global disk spindown setting
 *           example: true
 *         notification_sound:
 *           type: object
 *           description: System notification sound settings
 *           properties:
 *             startup:
 *               type: boolean
 *               description: Enable sound notification on system startup
 *               example: true
 *             reboot:
 *               type: boolean
 *               description: Enable sound notification on system reboot
 *               example: true
 *             shutdown:
 *               type: boolean
 *               description: Enable sound notification on system shutdown
 *               example: true
 *     Keymap:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Keymap name
 *           example: "de"
 *         description:
 *           type: string
 *           description: Keymap description
 *           example: "German"
 *     Timezone:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Timezone identifier
 *           example: "Europe/Berlin"
 *         description:
 *           type: string
 *           description: Timezone description
 *           example: "Central European Time"
 *     SettingsUpdateRequest:
 *       type: object
 *       description: Generic settings update request (fields depend on endpoint)
 *       additionalProperties: true
 *       example:
 *         enabled: true
 *         directory: "/mnt/pool1/docker"
 *         docker_options: "--log-level=info"
 */

// Only Admin can access these routes
router.use(checkRole(['admin']));

/**
 * @swagger
 * /mos/settings/docker:
 *   get:
 *     summary: Get Docker settings
 *     description: Retrieve current Docker service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Docker settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DockerSettings'
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
 *       404:
 *         description: Docker settings not found
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
 *   post:
 *     summary: Update Docker settings
 *     description: Update Docker service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           example:
 *             enabled: true
 *             directory: "/mnt/pool1/docker"
 *             appdata: "/mnt/pool1/appdata"
 *             docker_net:
 *               mode: "ipvlan"
 *               config:
 *                 - subnet: "10.0.0.0/24"
 *                   gateway: "10.0.0.5"
 *             filesystem: "btrfs"
 *             start_wait: "0"
 *             docker_options: "--log-level=info --storage-opt=overlay2.size=10G"
 *             update_check:
 *               enabled: true
 *               update_check_schedule: "0 1 * * *"
 *               auto_update:
 *                 enabled: true
 *                 auto_update_schedule: "0 2 * * SAT"
 *     responses:
 *       200:
 *         description: Docker settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DockerSettings'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 */

// GET: Read Docker settings
router.get('/settings/docker', async (req, res) => {
  try {
    const settings = await mosService.getDockerSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update Docker settings (single or multiple fields)
router.post('/settings/docker', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with valid fields.' });
    }
    const updated = await mosService.updateDockerSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/lxc:
 *   get:
 *     summary: Get LXC settings
 *     description: Retrieve current LXC service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: LXC settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LxcSettings'
 *             example:
 *               enabled: true
 *               directory: "/mnt/pool1/lxc"
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
 *       404:
 *         description: LXC settings not found
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
 *   post:
 *     summary: Update LXC settings
 *     description: Update LXC service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           example:
 *             enabled: true
 *             directory: "/mnt/pool1/lxc"
 *     responses:
 *       200:
 *         description: LXC settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LxcSettings'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 */

// GET: Read LXC settings
router.get('/settings/lxc', async (req, res) => {
  try {
    const settings = await mosService.getLxcSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update LXC settings (single or multiple fields)
router.post('/settings/lxc', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with valid fields.' });
    }
    const updated = await mosService.updateLxcSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/vm:
 *   get:
 *     summary: Get VM settings
 *     description: Retrieve current VM service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: VM settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmSettings'
 *             example:
 *               enabled: true
 *               directory: "/mnt/pool1/vm"
 *               vdisk_directory: "/mnt/pool1/vdisk"
 *               start_wait: 30
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
 *       404:
 *         description: VM settings not found
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
 *   post:
 *     summary: Update VM settings
 *     description: Update VM service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           example:
 *             enabled: true
 *             directory: "/mnt/pool1/vm"
 *             vdisk_directory: "/mnt/pool1/vdisk"
 *             start_wait: 45
 *     responses:
 *       200:
 *         description: VM settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmSettings'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 */

// GET: Read VM settings
router.get('/settings/vm', async (req, res) => {
  try {
    const settings = await mosService.getVmSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update VM settings (single or multiple fields)
router.post('/settings/vm', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with valid fields.' });
    }
    const updated = await mosService.updateVmSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/network:
 *   get:
 *     summary: Get network settings
 *     description: Retrieve current network service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Network settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NetworkSettings'
 *             example:
 *               services:
 *                 samba:
 *                   enabled: true
 *                 nfs:
 *                   enabled: false
 *                 nut:
 *                   enabled: false
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
 *       404:
 *         description: Network settings not found
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
 *   post:
 *     summary: Update network settings
 *     description: Update network service configuration and interfaces (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           examples:
 *             services_only:
 *               summary: Update services only
 *               value:
 *                 services:
 *                   samba:
 *                     enabled: true
 *                   nfs:
 *                     enabled: true
 *             ethernet_dhcp:
 *               summary: Ethernet with DHCP
 *               value:
 *                 interfaces:
 *                   - name: "eth0"
 *                     type: "ethernet"
 *                     mode: null
 *                     interfaces: []
 *                     ipv4: [{"dhcp": true}]
 *                     ipv6: []
 *             ethernet_static:
 *               summary: Ethernet with static IP
 *               value:
 *                 interfaces:
 *                   - name: "eth0"
 *                     type: "ethernet"
 *                     mode: null
 *                     interfaces: []
 *                     ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                     ipv6: []
 *             bridge_setup:
 *               summary: Bridge configuration
 *               value:
 *                 interfaces:
 *                   - name: "eth0"
 *                     type: "bridged"
 *                     mode: null
 *                     interfaces: []
 *                     ipv4: []
 *                     ipv6: []
 *                   - name: "br0"
 *                     type: "bridge"
 *                     mode: null
 *                     interfaces: ["eth0"]
 *                     ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                     ipv6: []
 *               nut:
 *                 enabled: false
 *     responses:
 *       200:
 *         description: Network settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NetworkSettings'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 */

// GET: Read network settings
router.get('/settings/network', async (req, res) => {
  try {
    const settings = await mosService.getNetworkSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update network settings (only services.samba, services.nfs, services.nut)
router.post('/settings/network', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object.' });
    }
    const updated = await mosService.updateNetworkSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/system:
 *   get:
 *     summary: Get system settings
 *     description: Retrieve current system configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SystemSettings'
 *             example:
 *               hostname: "mos-server"
 *               global_spindown: true
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
 *       404:
 *         description: System settings not found
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
 *   post:
 *     summary: Update system settings
 *     description: Update system configuration - hostname, global_spindown, and notification_sound allowed (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           example:
 *             hostname: "new-mos-server"
 *             global_spindown: false
 *             notification_sound:
 *               startup: true
 *               reboot: false
 *               shutdown: true
 *     responses:
 *       200:
 *         description: System settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SystemSettings'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 */

// GET: Read system settings
router.get('/settings/system', async (req, res) => {
  try {
    const settings = await mosService.getSystemSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/settings/system:
 *   post:
 *     summary: Update system settings
 *     description: Update system configuration including hostname, global_spindown, keymap, timezone, NTP, notification sounds, and CPU frequency settings (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hostname:
 *                 type: string
 *                 description: System hostname
 *                 example: "my-server"
 *               global_spindown:
 *                 type: integer
 *                 description: Global disk spindown time in minutes (0 = disabled)
 *                 example: 30
 *               keymap:
 *                 type: string
 *                 description: Keyboard layout
 *                 example: "de"
 *               timezone:
 *                 type: string
 *                 description: System timezone
 *                 example: "Europe/Berlin"
 *               ntp:
 *                 type: object
 *                 description: NTP configuration
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                     description: Enable NTP service
 *                     example: true
 *                   mode:
 *                     type: string
 *                     enum: [pool, server]
 *                     description: NTP mode
 *                     example: "pool"
 *                   servers:
 *                     type: array
 *                     items:
 *                       type: string
 *                     description: NTP servers
 *                     example: ["pool.ntp.org", "time.google.com"]
 *               notification_sound:
 *                 type: object
 *                 description: Notification sound settings
 *                 properties:
 *                   startup:
 *                     type: boolean
 *                     description: Play sound on startup
 *                     example: true
 *                   reboot:
 *                     type: boolean
 *                     description: Play sound on reboot
 *                     example: true
 *                   shutdown:
 *                     type: boolean
 *                     description: Play sound on shutdown
 *                     example: true
 *               cpufreq:
 *                 type: object
 *                 description: CPU frequency scaling settings
 *                 properties:
 *                   governor:
 *                     type: string
 *                     description: CPU frequency governor
 *                     example: "ondemand"
 *                   max_speed:
 *                     type: integer
 *                     description: Maximum CPU frequency in kHz (0 = system default)
 *                     example: 3000000
 *                   min_speed:
 *                     type: integer
 *                     description: Minimum CPU frequency in kHz (0 = system default)
 *                     example: 800000
 *     responses:
 *       200:
 *         description: System settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Updated system settings
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 */

// POST: Update system settings
router.post('/settings/system', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with valid fields.' });
    }
    const updated = await mosService.updateSystemSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/update_api:
 *   post:
 *     summary: Update the API service
 *     description: Update the API service immediately - useful after API updates (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: API update initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "API update initiated"
 *                 service:
 *                   type: string
 *                   example: "api"
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
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
 */

// POST: Update the API service
router.post('/update_api', async (req, res) => {
  try {
    // Send response immediately
    res.json({
      success: true,
      message: "API update initiated",
      service: "api",
      timestamp: new Date().toISOString()
    });

    // Update the API service immediately (runs in detached process)
    setImmediate(async () => {
      try {
        await mosService.updateApi();
      } catch (error) {
        console.error('API update error:', error.message);
      }
    });

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/update_ui:
 *   post:
 *     summary: Update the UI service (nginx)
 *     description: Update the UI service (nginx) immediately (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: UI update initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "UI update initiated"
 *                 service:
 *                   type: string
 *                   example: "nginx"
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
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
 */

// POST: Update the UI service (nginx)
router.post('/update_ui', async (req, res) => {
  try {
    // Send response immediately
    res.json({
      success: true,
      message: "UI update initiated",
      service: "nginx",
      timestamp: new Date().toISOString()
    });

    // Update the UI service (nginx) immediately (runs in detached process)
    setImmediate(async () => {
      try {
        await mosService.updateNginx();
      } catch (error) {
        console.error('nginx update error:', error.message);
      }
    });

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/services:
 *   get:
 *     summary: Get all service status
 *     description: Retrieve current status of all MOS services including Docker, LXC, VM and network services in flat structure (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Service status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 docker:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Docker service status
 *                       example: true
 *                 lxc:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: LXC service status
 *                       example: false
 *                 vm:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: VM service status
 *                       example: true
 *                 ssh:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: SSH service status
 *                       example: true
 *                 samba:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Samba service status
 *                       example: true
 *                 nmbd:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: NetBIOS service status
 *                       example: false
 *                 nfs:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: NFS service status
 *                       example: false
 *                 nut:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Network UPS Tools service status
 *                       example: true
 *                 iscsi_target:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: iSCSI Target service status
 *                       example: true
 *                 iscsi_initiator:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: iSCSI Initiator service status
 *                       example: false
 *                 tailscale:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Tailscale VPN service status
 *                       example: false
 *                 netbird:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: NetBird VPN service status
 *                       example: false
 *               additionalProperties:
 *                 type: object
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                 description: Additional network services (dynamically populated)
 *             example:
 *               docker:
 *                 enabled: true
 *               lxc:
 *                 enabled: false
 *               vm:
 *                 enabled: true
 *               ssh:
 *                 enabled: true
 *               samba:
 *                 enabled: true
 *               nmbd:
 *                 enabled: false
 *               nfs:
 *                 enabled: false
 *               nut:
 *                 enabled: true
 *               iscsi_target:
 *                 enabled: true
 *               iscsi_initiator:
 *                 enabled: false
 *               tailscale:
 *                 enabled: false
 *               netbird:
 *                 enabled: false
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
 *
 * @swagger
 * /mos/restart/service:
 *   post:
 *     summary: Restart generic service
 *     description: Restart generic service immediately - supports 'api' and 'nginx' (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - service
 *             properties:
 *               service:
 *                 type: string
 *                 enum: [api, nginx]
 *                 description: Service to restart
 *                 example: "api"
 *           example:
 *             service: "api"
 *     responses:
 *       200:
 *         description: Service restart scheduled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "api restart initiated"
 *                 service:
 *                   type: string
 *                   example: "api"
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request body or service name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 */

// GET: Get all service status
router.get('/services', async (req, res) => {
  try {
    const serviceStatus = await mosService.getAllServiceStatus();
    res.json(serviceStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Generic service restart
router.post('/restart/service', async (req, res) => {
  try {
    const { service } = req.body;

    if (!service) {
      return res.status(400).json({ error: 'service parameter is required' });
    }

    const result = await mosService.restartService(service);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/updateos:
 *   post:
 *     summary: Update MOS
 *     description: Initiate OS update using mos-os_update script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - version
 *               - channel
 *             properties:
 *               version:
 *                 type: string
 *                 description: Version to update to - either "latest" or version number (e.g., 0.0.0, 1.223.1)
 *                 example: "latest"
 *               channel:
 *                 type: string
 *                 enum: [alpha, beta, stable]
 *                 description: Update channel
 *                 example: "stable"
 *               update_kernel:
 *                 type: boolean
 *                 description: Whether to update kernel (default true, omit from script if false)
 *                 example: true
 *           example:
 *             version: "latest"
 *             channel: "stable"
 *             update_kernel: true
 *     responses:
 *       200:
 *         description: OS update initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "OS update initiated successfully"
 *                 version:
 *                   type: string
 *                   example: "latest"
 *                 channel:
 *                   type: string
 *                   example: "stable"
 *                 updateKernel:
 *                   type: boolean
 *                   example: true
 *                 command:
 *                   type: string
 *                   example: "/usr/local/bin/mos-os_update latest stable update_kernel"
 *                 output:
 *                   type: string
 *                   example: "Update process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Version must be 'latest' or a version number (e.g., 0.0.0, 1.223.1)"
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
 */

// POST: OS Update
router.post('/updateos', async (req, res) => {
  try {
    const { version, channel, update_kernel } = req.body;

    if (!version) {
      return res.status(400).json({
        success: false,
        error: 'version parameter is required'
      });
    }

    if (!channel) {
      return res.status(400).json({
        success: false,
        error: 'channel parameter is required'
      });
    }

    // update_kernel is optional and defaults to true
    const updateKernel = update_kernel !== false;

    const result = await mosService.updateOS(version, channel, updateKernel);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/rollbackos:
 *   post:
 *     summary: Rollback MOS
 *     description: Initiate OS rollback using mos-os_update rollback_mos script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               kernel_rollback:
 *                 type: boolean
 *                 description: Whether to rollback kernel (default true, adds 'not_kernel' argument if false)
 *                 example: true
 *           example:
 *             kernel_rollback: true
 *     responses:
 *       200:
 *         description: OS rollback initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "OS rollback initiated successfully"
 *                 kernelRollback:
 *                   type: boolean
 *                   example: true
 *                 command:
 *                   type: string
 *                   example: "/usr/local/bin/mos-os_update rollback_mos"
 *                 output:
 *                   type: string
 *                   example: "Rollback process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request or rollback failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Rollback failed: No previous version available"
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
 */

// POST: OS Rollback
router.post('/rollbackos', async (req, res) => {
  try {
    const { kernel_rollback } = req.body || {};

    // kernel_rollback is optional and defaults to true
    // only if explicitly set to false, "not_kernel" is passed to the script
    const kernelRollback = kernel_rollback !== false;

    const result = await mosService.rollbackOS(kernelRollback);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/getreleases:
 *   get:
 *     summary: Get available MOS releases
 *     description: Retrieve available releases grouped by channel (alpha, beta, stable) using mos-os_get_releases script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Releases grouped by channel
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 alpha:
 *                   type: array
 *                   description: Alpha releases
 *                   items:
 *                     type: object
 *                     properties:
 *                       tag_name:
 *                         type: string
 *                         example: "0.0.1-alpha.2"
 *                       html_url:
 *                         type: string
 *                         example: "https://github.com/ich777/mos-releases/releases/tag/0.0.1-alpha.2"
 *                 beta:
 *                   type: array
 *                   description: Beta releases
 *                   items:
 *                     type: object
 *                     properties:
 *                       tag_name:
 *                         type: string
 *                         example: "0.0.1-beta.1"
 *                       html_url:
 *                         type: string
 *                         example: "https://github.com/ich777/mos-releases/releases/tag/0.0.1-beta.1"
 *                 stable:
 *                   type: array
 *                   description: Stable releases
 *                   items:
 *                     type: object
 *                     properties:
 *                       tag_name:
 *                         type: string
 *                         example: "1.0.0"
 *                       html_url:
 *                         type: string
 *                         example: "https://github.com/ich777/mos-releases/releases/tag/1.0.0"
 *               example:
 *                 alpha:
 *                   - tag_name: "0.0.1-alpha.2"
 *                     html_url: "https://github.com/ich777/mos-releases/releases/tag/0.0.1-alpha.2"
 *                   - tag_name: "0.0.1-alpha.1"
 *                     html_url: "https://github.com/ich777/mos-releases/releases/tag/0.0.1-alpha.1"
 *                 beta: []
 *                 stable: []
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
 *         description: Server error or script execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Available Releases
router.get('/getreleases', async (req, res) => {
  try {
    const releases = await mosService.getReleases();
    res.json(releases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/osinfo:
 *   get:
 *     summary: Get current MOS and CPU information
 *     description: Retrieve current OS release information from /etc/mos-release.json combined with CPU details and hostname (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current OS and CPU information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: OS information object including release info, hostname and CPU details
 *               properties:
 *                 hostname:
 *                   type: string
 *                   nullable: true
 *                   description: System hostname from /boot/config/system.json
 *                   example: "mos-server"
 *                 cpu:
 *                   type: object
 *                   properties:
 *                     manufacturer:
 *                       type: string
 *                       description: CPU manufacturer
 *                       example: "Intel"
 *                     brand:
 *                       type: string
 *                       description: CPU brand/model
 *                       example: "Intel(R) Core(TM) i7-12700K"
 *                     cores:
 *                       type: integer
 *                       description: Total number of CPU cores
 *                       example: 12
 *                     physicalCores:
 *                       type: integer
 *                       description: Number of physical CPU cores
 *                       example: 8
 *                 mos:
 *                   type: object
 *                   description: MOS release information
 *                   properties:
 *                     version:
 *                       type: string
 *                       description: Constructed MOS version (version + channel from release file)
 *                       example: "0.0.1-alpha.4"
 *                     channel:
 *                       type: string
 *                       description: Cleaned release channel (without suffixes like .4)
 *                       example: "alpha"
 *                     running_kernel:
 *                       type: string
 *                       description: Currently running kernel version
 *                       example: "5.15.0-generic"
 *                 build_date:
 *                   type: string
 *                   description: Build date
 *                   example: "2025-08-24"
 *               example:
 *                 hostname: "mos-server"
 *                 cpu:
 *                   manufacturer: "Intel"
 *                   brand: "Intel(R) Core(TM) i7-12700K"
 *                   cores: 12
 *                   physicalCores: 8
 *                 mos:
 *                   version: "0.0.1-alpha.4"
 *                   channel: "alpha"
 *                   running_kernel: "5.15.0-generic"
 *                 build_date: "2025-08-24"
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
 *         description: Server error or file read failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Current OS Information (including CPU details)
router.get('/osinfo', async (req, res) => {
  try {
    const osInfo = await mosService.getCurrentRelease();
    res.json(osInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/getkernel:
 *   get:
 *     summary: Get available kernel releases
 *     description: Retrieve available kernel releases sorted by version (newest first) using mos-kernel_getreleases script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sorted array of kernel releases (newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               description: Array of kernel releases sorted by version (newest first)
 *               items:
 *                 type: object
 *                 properties:
 *                   tag_name:
 *                     type: string
 *                     description: Kernel version tag
 *                     example: "6.17.1-mos"
 *                   html_url:
 *                     type: string
 *                     description: URL to the kernel release
 *                     example: "https://github.com/ich777/kernel-releases/releases/tag/6.17.1-mos"
 *               example:
 *                 - tag_name: "6.17.1-mos"
 *                   html_url: "https://github.com/ich777/kernel-releases/releases/tag/6.17.1-mos"
 *                 - tag_name: "6.17.0-mos"
 *                   html_url: "https://github.com/ich777/kernel-releases/releases/tag/6.17.0-mos"
 *                 - tag_name: "6.1.0"
 *                   html_url: "https://github.com/ich777/kernel-releases/releases/tag/6.1.0"
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
 *         description: Server error or script execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Available Kernel Releases
router.get('/getkernel', async (req, res) => {
  try {
    const releases = await mosService.getKernelReleases();
    res.json(releases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/getdrivers:
 *   get:
 *     summary: Get available driver releases
 *     description: Retrieve available driver releases grouped by category using mos-drivers_get_releases script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: kernelVersion
 *         schema:
 *           type: string
 *         required: false
 *         description: Optional kernel version/uname. If not provided, uses current system kernel (uname -r)
 *         example: "6.17.1-mos"
 *       - in: query
 *         name: excludeinstalled
 *         schema:
 *           type: boolean
 *         required: false
 *         description: Optional. If true, filters out already installed drivers. If not provided, returns all available drivers
 *         example: true
 *     responses:
 *       200:
 *         description: Driver releases grouped by category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Driver releases grouped by category (e.g., dvb, coral), with driver names as keys and version arrays as values
 *               additionalProperties:
 *                 type: object
 *                 additionalProperties:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of available versions for this driver
 *               example:
 *                 dvb:
 *                   dvb-digital-devices: ["20250910-1", "20250911-1"]
 *                   dvb-libreelec: ["1231-1"]
 *                 coral:
 *                   coral: ["20240425-1"]
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
 *         description: Server error or script execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Available Driver Releases
router.get('/getdrivers', async (req, res) => {
  try {
    const { kernelVersion, excludeinstalled } = req.query;
    const excludeInstalledBool = excludeinstalled === 'true' || excludeinstalled === true;
    const releases = await mosService.getDriverReleases(kernelVersion, excludeInstalledBool);
    res.json(releases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/installeddrivers:
 *   get:
 *     summary: Get installed drivers
 *     description: Retrieve installed drivers from /boot/optional/drivers/ for the current running kernel grouped by category (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Installed drivers grouped by category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Installed drivers grouped by category (e.g., dvb, coral), with driver names as keys and version arrays as values
 *               additionalProperties:
 *                 type: object
 *                 additionalProperties:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of installed versions for this driver
 *               example:
 *                 dvb:
 *                   dvb-digital-devices: ["20250910-1"]
 *                 coral:
 *                   coral: ["20240425-1"]
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
 */

// GET: Installed Drivers
router.get('/installeddrivers', async (req, res) => {
  try {
    const installedDrivers = await mosService.getInstalledDrivers();
    res.json(installedDrivers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/drivers:
 *   post:
 *     summary: Download or upgrade drivers
 *     description: Download a specific driver (using complete packagename OR drivername+driverversion) or check for driver updates using mos-driver_download script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             oneOf:
 *               - required:
 *                   - packagename
 *                 properties:
 *                   packagename:
 *                     type: string
 *                     description: Complete driver package filename (e.g., dvb-digital-devices_20250910-1+mos_amd64.deb)
 *                     example: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                   kernelVersion:
 *                     type: string
 *                     description: Optional desired kernel version/uname for the driver
 *                     example: "6.17.1-mos"
 *               - required:
 *                   - drivername
 *                   - driverversion
 *                 properties:
 *                   drivername:
 *                     type: string
 *                     description: Driver name only (e.g., dvb-digital-devices)
 *                     example: "dvb-digital-devices"
 *                   driverversion:
 *                     type: string
 *                     description: Driver version only (e.g., 20250910-1)
 *                     example: "20250910-1"
 *                   kernelVersion:
 *                     type: string
 *                     description: Optional desired kernel version/uname for the driver
 *                     example: "6.17.1-mos"
 *               - required:
 *                   - upgrade
 *                 properties:
 *                   upgrade:
 *                     type: boolean
 *                     description: Set to true to check for driver updates
 *                     example: true
 *           examples:
 *             downloadWithPackageName:
 *               summary: Download using complete package filename
 *               value:
 *                 packagename: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                 kernelVersion: "6.17.1-mos"
 *             downloadWithNameAndVersion:
 *               summary: Download using driver name and version separately
 *               value:
 *                 drivername: "dvb-digital-devices"
 *                 driverversion: "20250910-1"
 *             downloadOnlyNameAndVersion:
 *               summary: Download using name and version without kernel version
 *               value:
 *                 drivername: "dvb-digital-devices"
 *                 driverversion: "20250910-1"
 *             upgradeDrivers:
 *               summary: Check for driver updates
 *               value:
 *                 upgrade: true
 *     responses:
 *       200:
 *         description: Driver download/upgrade initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Operation success status
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Success message
 *                   example: "Driver download initiated successfully"
 *                 upgrade:
 *                   type: boolean
 *                   description: Whether this was an upgrade check
 *                   example: false
 *                 packagename:
 *                   type: string
 *                   nullable: true
 *                   description: Complete driver package filename (if provided or built)
 *                   example: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                 drivername:
 *                   type: string
 *                   nullable: true
 *                   description: Driver name (if provided separately)
 *                   example: "dvb-digital-devices"
 *                 driverversion:
 *                   type: string
 *                   nullable: true
 *                   description: Driver version (if provided separately)
 *                   example: "20250910-1"
 *                 kernelVersion:
 *                   type: string
 *                   nullable: true
 *                   description: Kernel version
 *                   example: "6.17.1-mos"
 *                 command:
 *                   type: string
 *                   description: The executed command
 *                   example: "/usr/local/bin/mos-driver_download \"dvb-digital-devices_20250910-1+mos_amd64.deb\" \"6.17.1-mos\""
 *                 output:
 *                   type: string
 *                   description: Command stdout output
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   description: Command stderr output if any
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Operation timestamp
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 *         description: Server error or script execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// POST: Download or Upgrade Driver
router.post('/drivers', async (req, res) => {
  try {
    const result = await mosService.downloadDriver(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/drivers:
 *   delete:
 *     summary: Delete a driver
 *     description: Delete a specific driver package from /boot/optional/drivers/ (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             oneOf:
 *               - required:
 *                   - packagename
 *                 properties:
 *                   packagename:
 *                     type: string
 *                     description: Complete driver package filename (e.g., dvb-digital-devices_20250910-1+mos_amd64.deb)
 *                     example: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *               - required:
 *                   - drivername
 *                   - driverversion
 *                 properties:
 *                   drivername:
 *                     type: string
 *                     description: Driver name only (e.g., dvb-digital-devices)
 *                     example: "dvb-digital-devices"
 *                   driverversion:
 *                     type: string
 *                     description: Driver version only (e.g., 20250910-1)
 *                     example: "20250910-1"
 *           examples:
 *             deleteWithPackageName:
 *               summary: Delete using complete package filename
 *               value:
 *                 packagename: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *             deleteWithNameAndVersion:
 *               summary: Delete using driver name and version separately
 *               value:
 *                 drivername: "dvb-digital-devices"
 *                 driverversion: "20250910-1"
 *     responses:
 *       200:
 *         description: Driver deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Operation success status
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Success message
 *                   example: "Driver deleted successfully"
 *                 packagename:
 *                   type: string
 *                   description: Complete driver package filename
 *                   example: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                 drivername:
 *                   type: string
 *                   nullable: true
 *                   description: Driver name (if provided separately)
 *                   example: "dvb-digital-devices"
 *                 driverversion:
 *                   type: string
 *                   nullable: true
 *                   description: Driver version (if provided separately)
 *                   example: "20250910-1"
 *                 category:
 *                   type: string
 *                   description: Driver category
 *                   example: "dvb"
 *                 kernelVersion:
 *                   type: string
 *                   description: Kernel version
 *                   example: "6.17.1-mos"
 *                 path:
 *                   type: string
 *                   description: Path to the deleted driver
 *                   example: "/boot/optional/drivers/dvb/6.17.1-mos/dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Operation timestamp
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 *       404:
 *         description: Driver package not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or deletion failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// DELETE: Delete Driver
router.delete('/drivers', async (req, res) => {
  try {
    const result = await mosService.deleteDriver(req.body);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/updatekernel:
 *   post:
 *     summary: Update kernel
 *     description: Initiate kernel update using mos-kernel_update script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - version
 *             properties:
 *               version:
 *                 type: string
 *                 description: Version to update to - either "recommended" or version number (e.g., 6.1.0, 6.17.1-mos)
 *                 example: "recommended"
 *           example:
 *             version: "recommended"
 *     responses:
 *       200:
 *         description: Kernel update initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Kernel update initiated successfully"
 *                 version:
 *                   type: string
 *                   example: "recommended"
 *                 command:
 *                   type: string
 *                   example: "/usr/local/bin/mos-kernel_update recommended"
 *                 output:
 *                   type: string
 *                   example: "Kernel update process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Version must be 'recommended' or a version number (e.g., 6.1.0, 6.17.1-mos)"
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
 */

// POST: Kernel Update
router.post('/updatekernel', async (req, res) => {
  try {
    const { version } = req.body;

    if (!version) {
      return res.status(400).json({
        success: false,
        error: 'version parameter is required'
      });
    }

    const result = await mosService.updateKernel(version);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/rollbackkernel:
 *   post:
 *     summary: Rollback kernel
 *     description: Initiate kernel rollback using mos-kernel_update rollback script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Kernel rollback initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Kernel rollback initiated successfully"
 *                 command:
 *                   type: string
 *                   example: "/usr/local/bin/mos-kernel_update rollback"
 *                 output:
 *                   type: string
 *                   example: "Kernel rollback process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request or rollback failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Kernel rollback failed: No previous kernel available"
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
 */

// POST: Kernel Rollback
router.post('/rollbackkernel', async (req, res) => {
  try {
    const result = await mosService.rollbackKernel();

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/installtodisk:
 *   post:
 *     summary: Install MOS to disk
 *     description: Install MOS to a specified disk with the specified filesystem using mos-install script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - disk
 *               - filesystem
 *             properties:
 *               disk:
 *                 type: string
 *                 description: Disk device path (e.g., /dev/sda, /dev/nvme0n1)
 *                 example: "/dev/sda"
 *               filesystem:
 *                 type: string
 *                 enum: [vfat, ext4, btrfs, xfs]
 *                 description: Filesystem type for the installation
 *                 example: "ext4"
 *           example:
 *             disk: "/dev/sda"
 *             filesystem: "ext4"
 *     responses:
 *       200:
 *         description: MOS installation to disk initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "MOS installation to disk initiated successfully"
 *                 disk:
 *                   type: string
 *                   example: "/dev/sda"
 *                 filesystem:
 *                   type: string
 *                   example: "ext4"
 *                 command:
 *                   type: string
 *                   example: "bash /usr/local/bin/mos-install /dev/sda ext4 quiet"
 *                 output:
 *                   type: string
 *                   example: "Installation process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "filesystem must be one of: vfat, ext4, btrfs, xfs"
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
 */

// POST: Install MOS to disk
router.post('/installtodisk', async (req, res) => {
  try {
    const { disk, filesystem } = req.body;

    if (!disk) {
      return res.status(400).json({
        success: false,
        error: 'disk parameter is required'
      });
    }

    if (!filesystem) {
      return res.status(400).json({
        success: false,
        error: 'filesystem parameter is required'
      });
    }

    const result = await mosService.installToDisk(disk, filesystem);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
