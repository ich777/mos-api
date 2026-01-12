const express = require('express');
const router = express.Router();
const mosService = require('../services/mos.service');
const zramService = require('../services/zram.service');
const swapService = require('../services/swap.service');
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
 *     SensorValue:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Sensor ID
 *           example: "1735303800123"
 *         index:
 *           type: integer
 *           description: Sort index within group
 *           example: 0
 *         name:
 *           type: string
 *           description: Display name
 *           example: "Front Fan"
 *         manufacturer:
 *           type: string
 *           nullable: true
 *           description: Hardware manufacturer
 *           example: "Corsair"
 *         model:
 *           type: string
 *           nullable: true
 *           description: Hardware model
 *           example: "HX750i"
 *         subtype:
 *           type: string
 *           nullable: true
 *           description: Sensor subtype for more specific categorization
 *           enum: [voltage, wattage, amperage, speed, flow, temperature, rpm, percentage, null]
 *           example: "voltage"
 *         value:
 *           type: number
 *           nullable: true
 *           description: Current sensor value
 *           example: 30.5
 *         unit:
 *           type: string
 *           description: Value unit
 *           example: "%"
 *     SensorConfig:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           example: "1735303800123"
 *         index:
 *           type: integer
 *           example: 0
 *         name:
 *           type: string
 *           example: "Front Fan"
 *         manufacturer:
 *           type: string
 *           nullable: true
 *           description: Hardware manufacturer
 *           example: "Corsair"
 *         model:
 *           type: string
 *           nullable: true
 *           description: Hardware model
 *           example: "HX750i"
 *         subtype:
 *           type: string
 *           nullable: true
 *           description: Sensor subtype
 *           enum: [voltage, wattage, amperage, speed, flow, temperature, rpm, percentage, null]
 *         source:
 *           type: string
 *           description: Dot notation path to sensor value
 *           example: "nct6798-isa-0290.pwm1.pwm1"
 *         unit:
 *           type: string
 *           example: "%"
 *         multiplier:
 *           type: number
 *           nullable: true
 *           description: Multiplier for voltage dividers (applied before other transforms). Cannot be used together with divisor.
 *           example: 6
 *         divisor:
 *           type: number
 *           nullable: true
 *           description: Divisor for sensors that output scaled values (applied before other transforms). Cannot be used together with multiplier.
 *           example: 1000
 *         value_range:
 *           type: object
 *           nullable: true
 *           properties:
 *             min:
 *               type: number
 *             max:
 *               type: number
 *         transform:
 *           type: string
 *           nullable: true
 *           enum: [percentage, null]
 *         enabled:
 *           type: boolean
 *           example: true
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
 *         lxc_registry:
 *           type: string
 *           nullable: true
 *           description: Custom LXC container registry server (without protocol prefix). When set, containers are downloaded from this server instead of the default. Example format - my.lxc.org (not https://my.lxc.org)
 *           example: "images.linuxcontainers.org"
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
     *         timezone:
     *           type: string
     *           description: System timezone
     *           example: "Europe/Berlin"
     *         display:
     *           type: object
     *           description: Display settings
     *           properties:
     *             timeout:
     *               type: integer
     *               description: Display timeout in seconds
     *               example: 30
     *             powersave:
     *               type: string
     *               description: Display power save mode (on, vsync, powerdown, off)
     *               example: "on"
     *             powerdown:
     *               type: integer
     *               description: Display power down timeout in seconds
     *               example: 60
     *         persist_history:
     *           type: boolean
     *           description: Persist command history
     *           example: false
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
     *         swapfile:
     *           type: object
     *           description: Swapfile configuration
     *           properties:
     *             enabled:
     *               type: boolean
     *               description: Enable swapfile
     *               example: false
     *             path:
     *               type: string
     *               nullable: true
     *               description: Directory path for swapfile (must be on mounted pool under /mnt/)
     *               example: "/mnt/pool1"
     *             size:
     *               type: string
     *               description: Swapfile size (e.g., "10G", "1024M")
     *               example: "10G"
     *             priority:
     *               type: integer
     *               description: Swap priority (default -2)
     *               example: -2
     *             config:
     *               type: object
     *               description: Zswap configuration
     *               properties:
     *                 zswap:
     *                   type: boolean
     *                   description: Enable zswap (compressed swap cache)
     *                   example: false
     *                 shrinker:
     *                   type: boolean
     *                   description: Enable zswap shrinker
     *                   example: true
     *                 max_pool_percent:
     *                   type: integer
     *                   description: Maximum pool size as percentage of RAM
     *                   example: 20
     *                 compressor:
     *                   type: string
     *                   description: Compression algorithm (zstd, lz4, lzo, etc.)
     *                   example: "zstd"
     *                 accept_threshold_percent:
     *                   type: integer
     *                   description: Accept threshold percentage
     *                   example: 90
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
 *             lxc_registry: "images.linuxcontainers.org"
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
 * /mos/settings/network/interfaces:
 *   get:
 *     summary: Get network interfaces
 *     description: Retrieve current network interfaces configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Network interfaces retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *             example:
 *               - name: "eth0"
 *                 type: "ethernet"
 *                 mode: null
 *                 interfaces: []
 *                 ipv4: [{"dhcp": true}]
 *                 ipv6: []
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
 *   post:
 *     summary: Update network interfaces
 *     description: Update network interfaces configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *           examples:
 *             ethernet_dhcp:
 *               summary: Ethernet with DHCP
 *               value:
 *                 - name: "eth0"
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": true}]
 *                   ipv6: []
 *             ethernet_static:
 *               summary: Ethernet with static IP
 *               value:
 *                 - name: "eth0"
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                   ipv6: []
 *             bridge_setup:
 *               summary: Bridge configuration
 *               value:
 *                 - name: "eth0"
 *                   type: "bridged"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: []
 *                   ipv6: []
 *                 - name: "br0"
 *                   type: "bridge"
 *                   mode: null
 *                   interfaces: ["eth0"]
 *                   ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                   ipv6: []
 *     responses:
 *       200:
 *         description: Network interfaces updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
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

// GET: Read network interfaces
router.get('/settings/network/interfaces', async (req, res) => {
  try {
    const interfaces = await mosService.getNetworkInterfaces();
    res.json(interfaces);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update network interfaces
router.post('/settings/network/interfaces', async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an array of interfaces.' });
    }
    const updated = await mosService.updateNetworkInterfaces(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/network/services:
 *   get:
 *     summary: Get network services
 *     description: Retrieve current network services configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Network services retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *             example:
 *               ssh:
 *                 enabled: true
 *               samba:
 *                 enabled: true
 *               nfs:
 *                 enabled: false
 *               nut:
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
 *   post:
 *     summary: Update network services
 *     description: Update network services configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *           example:
 *             samba:
 *               enabled: true
 *             nfs:
 *               enabled: true
 *             nut:
 *               enabled: false
 *     responses:
 *       200:
 *         description: Network services updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
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

// GET: Read network services
router.get('/settings/network/services', async (req, res) => {
  try {
    const services = await mosService.getNetworkServices();
    res.json(services);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update network services
router.post('/settings/network/services', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with service configurations.' });
    }
    const updated = await mosService.updateNetworkServices(req.body);
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
 *               timezone: "Europe/Berlin"
 *               display:
 *                 timeout: 30
 *                 powersave: "on"
 *                 powerdown: 60
 *               persist_history: false
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
 *             timezone: "Europe/Berlin"
 *             display:
 *               timeout: 60
 *               powersave: "off"
 *               powerdown: 120
 *             persist_history: true
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
 *               display:
 *                 type: object
 *                 description: Display settings
 *                 properties:
 *                   timeout:
 *                     type: integer
 *                     description: Display timeout in seconds
 *                     example: 30
 *                   powersave:
 *                     type: string
 *                     description: Display power save mode (on, vsync, powerdown, off)
 *                     example: "on"
 *                   powerdown:
 *                     type: integer
 *                     description: Display power down timeout in seconds
 *                     example: 60
 *               persist_history:
 *                 type: boolean
 *                 description: Persist command history
 *                 example: false
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
 *               swapfile:
 *                 type: object
 *                 description: Swapfile configuration. Path must be on mounted pool under /mnt/. BTRFS RAID pools are not supported.
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                     description: Enable or disable swapfile
 *                     example: true
 *                   path:
 *                     type: string
 *                     description: Directory path for swapfile (must be on mounted pool under /mnt/)
 *                     example: "/mnt/pool1"
 *                   size:
 *                     type: string
 *                     description: Swapfile size (e.g., "10G", "1024M"). Changing size recreates the swapfile.
 *                     example: "10G"
 *                   priority:
 *                     type: integer
 *                     description: Swap priority (default -2). Changing priority recreates the swapfile.
 *                     example: -2
 *                   config:
 *                     type: object
 *                     description: Zswap configuration (compressed swap cache)
 *                     properties:
 *                       zswap:
 *                         type: boolean
 *                         description: Enable zswap
 *                         example: false
 *                       shrinker:
 *                         type: boolean
 *                         description: Enable zswap shrinker (default true)
 *                         example: true
 *                       max_pool_percent:
 *                         type: integer
 *                         description: Maximum pool size as percentage of RAM (default 20)
 *                         example: 20
 *                       compressor:
 *                         type: string
 *                         description: Compression algorithm (default zstd)
 *                         example: "zstd"
 *                       accept_threshold_percent:
 *                         type: integer
 *                         description: Accept threshold percentage (default 90)
 *                         example: 90
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
 *                       description: Docker service enabled in config
 *                       example: true
 *                     running:
 *                       type: boolean
 *                       description: Docker daemon is actually running (socket responding)
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
 *                       description: VM service enabled in config
 *                       example: true
 *                     running:
 *                       type: boolean
 *                       description: libvirt daemon is actually running (PID check)
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
 *                 running: true
 *               lxc:
 *                 enabled: false
 *               vm:
 *                 enabled: true
 *                 running: true
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
 *                 uptime:
 *                   type: object
 *                   description: System uptime information
 *                   properties:
 *                     pretty:
 *                       type: string
 *                       nullable: true
 *                       description: Human-readable uptime (without "up" prefix and leading spaces)
 *                       example: "2 hours, 34 minutes"
 *                     since:
 *                       type: string
 *                       nullable: true
 *                       description: System boot timestamp
 *                       example: "2025-10-26 10:30:00"
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
 *                 uptime:
 *                   pretty: "2 hours, 34 minutes"
 *                   since: "2025-10-26 10:30:00"
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
 *               extra_partition:
 *                 type: boolean
 *                 description: Whether to create an extra partition
 *                 default: false
 *                 example: false
 *           example:
 *             disk: "/dev/sda"
 *             filesystem: "ext4"
 *             extra_partition: false
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
 *                 extra_partition:
 *                   type: boolean
 *                   example: false
 *                 command:
 *                   type: string
 *                   example: "bash /usr/local/bin/mos-install /dev/sda ext4 quiet false"
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
    const { disk, filesystem, extra_partition = false } = req.body;

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

    const result = await mosService.installToDisk(disk, filesystem, extra_partition);

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
 * /mos/dashboard:
 *   get:
 *     summary: Get dashboard layout
 *     description: Retrieve current dashboard card layout configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard layout retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 left:
 *                   type: array
 *                   description: Cards in the left column
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         description: Unique card identifier
 *                         example: "C1"
 *                       name:
 *                         type: string
 *                         description: Card display name
 *                         example: "Card1"
 *                 right:
 *                   type: array
 *                   description: Cards in the right column
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         description: Unique card identifier
 *                         example: "C2"
 *                       name:
 *                         type: string
 *                         description: Card display name
 *                         example: "Card2"
 *                 visibility:
 *                   type: object
 *                   description: Visibility state for each card (key is card name, value is boolean)
 *                   additionalProperties:
 *                     type: boolean
 *                   example:
 *                     Card1: true
 *                     Card2: false
 *             example:
 *               left:
 *                 - id: "C1"
 *                   name: "Card1"
 *               right:
 *                 - id: "C2"
 *                   name: "Card2"
 *               visibility:
 *                 Card1: true
 *                 Card2: false
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
 *   post:
 *     summary: Update dashboard layout
 *     description: Update dashboard card layout configuration (admin only)
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
 *               - left
 *               - right
 *               - visibility
 *             properties:
 *               left:
 *                 type: array
 *                 description: Cards in the left column
 *                 items:
 *                   type: object
 *                   required:
 *                     - id
 *                     - name
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Unique card identifier
 *                       example: "C1"
 *                     name:
 *                       type: string
 *                       description: Card display name
 *                       example: "Card1"
 *               right:
 *                 type: array
 *                 description: Cards in the right column
 *                 items:
 *                   type: object
 *                   required:
 *                     - id
 *                     - name
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Unique card identifier
 *                       example: "C2"
 *                     name:
 *                       type: string
 *                       description: Card display name
 *                       example: "Card2"
 *               visibility:
 *                 type: object
 *                 description: Visibility state for each card (key is card name, value is boolean)
 *                 additionalProperties:
 *                   type: boolean
 *           example:
 *             left:
 *               - id: "C1"
 *                 name: "Card1"
 *             right:
 *               - id: "C2"
 *                 name: "Card2"
 *             visibility:
 *               Card1: true
 *               Card2: false
 *     responses:
 *       200:
 *         description: Dashboard layout updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 left:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                 right:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                 visibility:
 *                   type: object
 *                   additionalProperties:
 *                     type: boolean
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

/**
 * @swagger
 * /mos/readfile:
 *   get:
 *     summary: Read a file from the filesystem
 *     description: Read the content of any file on the filesystem
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Absolute path to the file to read
 *         example: "/etc/config.txt"
 *     responses:
 *       200:
 *         description: File content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 path:
 *                   type: string
 *                   example: "/etc/config.txt"
 *                 content:
 *                   type: string
 *                   description: The file content as a string
 *                   example: "file content here"
 *                 size:
 *                   type: integer
 *                   description: Size of the file in bytes
 *                   example: 1024
 *       400:
 *         description: Bad request - missing path parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: File not found
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

// GET: Read a file from the filesystem
router.get('/readfile', checkRole(['admin']), async (req, res) => {
  try {
    const { path } = req.query;

    if (!path) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const result = await mosService.readFile(path);
    res.json(result);
  } catch (error) {
    if (error.message.includes('File does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/editfile:
 *   post:
 *     summary: Edit a file on the filesystem
 *     description: Edit any file on the filesystem. Creates a backup with .backup extension if create_backup is true
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
 *               - path
 *               - content
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file to edit
 *                 example: "/etc/config.txt"
 *               content:
 *                 type: string
 *                 description: New content for the file
 *                 example: "new file content"
 *               create_backup:
 *                 type: boolean
 *                 description: Whether to create a backup file with .backup extension
 *                 example: true
 *                 default: false
 *     responses:
 *       200:
 *         description: File edited successfully
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
 *                   example: "File edited successfully"
 *                 backupPath:
 *                   type: string
 *                   nullable: true
 *                   description: Path to the backup file if create_backup was true
 *                   example: "/etc/config.txt.backup"
 *       400:
 *         description: Bad request - missing required parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: File not found
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

// POST: Edit a file on the filesystem
router.post('/editfile', checkRole(['admin']), async (req, res) => {
  try {
    const { path, content, create_backup = false } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    if (content === undefined) {
      return res.status(400).json({ error: 'content parameter is required' });
    }

    const result = await mosService.editFile(path, content, create_backup);
    res.json(result);
  } catch (error) {
    if (error.message.includes('File does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/createfile:
 *   post:
 *     summary: Create a new file on the filesystem
 *     description: Create a new file with optional content and ownership/permission settings
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
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file to create
 *                 example: "/mnt/pool1/newfile.txt"
 *               content:
 *                 type: string
 *                 description: Content for the new file (default empty)
 *                 example: "file content here"
 *                 default: ""
 *               user:
 *                 type: string
 *                 description: User ID or username for file ownership
 *                 example: "500"
 *                 default: "500"
 *               group:
 *                 type: string
 *                 description: Group ID or group name for file ownership
 *                 example: "500"
 *                 default: "500"
 *               permissions:
 *                 type: string
 *                 description: File permissions in octal format
 *                 example: "777"
 *                 default: "777"
 *     responses:
 *       200:
 *         description: File created successfully
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
 *                   example: "File created successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/newfile.txt"
 *                 user:
 *                   type: string
 *                   example: "500"
 *                 group:
 *                   type: string
 *                   example: "500"
 *                 permissions:
 *                   type: string
 *                   example: "777"
 *       400:
 *         description: Bad request - missing path or file already exists
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

// POST: Create a new file on the filesystem
router.post('/createfile', checkRole(['admin']), async (req, res) => {
  try {
    const { path, content = '', user = '500', group = '500', permissions = '777' } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.createFile(path, content, { user, group, permissions });
    res.json(result);
  } catch (error) {
    if (error.message.includes('already exists') || error.message.includes('Path already exists')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/createfolder:
 *   post:
 *     summary: Create a new folder on the filesystem
 *     description: Create a new folder with optional ownership/permission settings
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
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the folder to create
 *                 example: "/mnt/pool1/newfolder"
 *               user:
 *                 type: string
 *                 description: User ID or username for folder ownership
 *                 example: "500"
 *                 default: "500"
 *               group:
 *                 type: string
 *                 description: Group ID or group name for folder ownership
 *                 example: "500"
 *                 default: "500"
 *               permissions:
 *                 type: string
 *                 description: Folder permissions in octal format
 *                 example: "777"
 *                 default: "777"
 *     responses:
 *       200:
 *         description: Folder created successfully
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
 *                   example: "Folder created successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/newfolder"
 *                 user:
 *                   type: string
 *                   example: "500"
 *                 group:
 *                   type: string
 *                   example: "500"
 *                 permissions:
 *                   type: string
 *                   example: "777"
 *       400:
 *         description: Bad request - missing path or folder already exists
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

// POST: Create a new folder on the filesystem
router.post('/createfolder', checkRole(['admin']), async (req, res) => {
  try {
    const { path, user = '500', group = '500', permissions = '777' } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.createFolder(path, { user, group, permissions });
    res.json(result);
  } catch (error) {
    if (error.message.includes('already exists') || error.message.includes('not a directory')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/delete:
 *   post:
 *     summary: Delete a file or folder from the filesystem
 *     description: |
 *       Delete a file or folder with optional force and recursive flags.
 *       - For files: deletes the file directly
 *       - For empty folders: deletes without recursive flag
 *       - For non-empty folders: requires recursive=true
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
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file or folder to delete
 *                 example: "/mnt/pool1/oldfile.txt"
 *               force:
 *                 type: boolean
 *                 description: Force deletion (ignore nonexistent files)
 *                 example: true
 *                 default: true
 *               recursive:
 *                 type: boolean
 *                 description: Recursively delete directories (required for non-empty folders)
 *                 example: false
 *                 default: false
 *     responses:
 *       200:
 *         description: Item deleted successfully
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
 *                   example: "File deleted successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/oldfile.txt"
 *                 type:
 *                   type: string
 *                   enum: [file, directory]
 *                   example: "file"
 *                 recursive:
 *                   type: boolean
 *                   example: false
 *                 force:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Bad request - missing path or directory not empty
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Path not found (when force=false)
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

// POST: Delete a file or folder from the filesystem
router.post('/delete', checkRole(['admin']), async (req, res) => {
  try {
    const { path, force = true, recursive = false } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.deleteItem(path, { force, recursive });
    res.json(result);
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('not empty')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/chown:
 *   post:
 *     summary: Change ownership of a file or folder
 *     description: Change the user and group ownership of a file or folder, optionally recursive
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
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file or folder
 *                 example: "/mnt/pool1/myfile.txt"
 *               user:
 *                 type: string
 *                 description: User ID or username for ownership
 *                 example: "500"
 *                 default: "500"
 *               group:
 *                 type: string
 *                 description: Group ID or group name for ownership
 *                 example: "500"
 *                 default: "500"
 *               recursive:
 *                 type: boolean
 *                 description: Apply ownership change recursively
 *                 example: false
 *                 default: false
 *     responses:
 *       200:
 *         description: Ownership changed successfully
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
 *                   example: "Ownership changed successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/myfile.txt"
 *                 user:
 *                   type: string
 *                   example: "500"
 *                 group:
 *                   type: string
 *                   example: "500"
 *                 recursive:
 *                   type: boolean
 *                   example: false
 *       400:
 *         description: Bad request - missing path
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Path not found
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

// POST: Change ownership of a file or folder
router.post('/chown', checkRole(['admin']), async (req, res) => {
  try {
    const { path, user = '500', group = '500', recursive = false } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.chown(path, { user, group, recursive });
    res.json(result);
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/chmod:
 *   post:
 *     summary: Change permissions of a file or folder
 *     description: Change the permissions of a file or folder, optionally recursive
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
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file or folder
 *                 example: "/mnt/pool1/myfile.txt"
 *               permissions:
 *                 type: string
 *                 description: Permissions in octal format
 *                 example: "777"
 *                 default: "777"
 *               recursive:
 *                 type: boolean
 *                 description: Apply permission change recursively
 *                 example: false
 *                 default: false
 *     responses:
 *       200:
 *         description: Permissions changed successfully
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
 *                   example: "Permissions changed successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/myfile.txt"
 *                 permissions:
 *                   type: string
 *                   example: "777"
 *                 recursive:
 *                   type: boolean
 *                   example: false
 *       400:
 *         description: Bad request - missing path
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Path not found
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

// POST: Change permissions of a file or folder
router.post('/chmod', checkRole(['admin']), async (req, res) => {
  try {
    const { path, permissions = '777', recursive = false } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.chmod(path, { permissions, recursive });
    res.json(result);
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET: Read dashboard layout
router.get('/dashboard', async (req, res) => {
  try {
    const layout = await mosService.getDashboardLayout();
    res.json(layout);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Update dashboard layout
router.post('/dashboard', async (req, res) => {
  try {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with left, right, and visibility properties.' });
    }

    const updatedLayout = await mosService.updateDashboardLayout(req.body);
    res.json(updatedLayout);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/fsnavigator:
 *   get:
 *     summary: Browse filesystem with directory/file picker
 *     description: |
 *       Navigate directories and files with optional virtual root.
 *       - Without `roots` parameter: Full filesystem access (real `/` with all directories)
 *       - With `roots` parameter: Virtual root showing only specified directories
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: false
 *         schema:
 *           type: string
 *           default: "/"
 *         description: Path to browse
 *         examples:
 *           root:
 *             value: "/"
 *             summary: Browse root directory
 *           mnt:
 *             value: "/mnt"
 *             summary: Browse /mnt directory
 *           nested:
 *             value: "/mnt/nvme/appdata"
 *             summary: Browse nested directory
 *       - in: query
 *         name: type
 *         required: false
 *         schema:
 *           type: string
 *           enum: [directories, all]
 *           default: directories
 *         description: Type of items to return - "directories" shows only folders, "all" shows folders and files
 *         examples:
 *           directories:
 *             value: "directories"
 *             summary: Show only directories
 *           all:
 *             value: "all"
 *             summary: Show directories and files
 *       - in: query
 *         name: roots
 *         required: false
 *         schema:
 *           type: string
 *         description: |
 *           Optional comma-separated list of allowed root directories for virtual root.
 *           When specified with path="/", creates a virtual root showing only these directories.
 *           Without this parameter, full filesystem access is granted.
 *         examples:
 *           restricted:
 *             value: "/mnt,/var/mergerfs"
 *             summary: Virtual root with only /mnt and /var/mergerfs
 *           single:
 *             value: "/mnt"
 *             summary: Restrict to /mnt only
 *     responses:
 *       200:
 *         description: Directory listing with navigation info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isVirtualRoot:
 *                   type: boolean
 *                   description: True if showing virtual root
 *                   example: false
 *                 currentPath:
 *                   type: string
 *                   description: Current directory path
 *                   example: "/mnt/nvme"
 *                 parentPath:
 *                   type: string
 *                   nullable: true
 *                   description: Parent directory path (null if at virtual root)
 *                   example: "/mnt"
 *                 canGoUp:
 *                   type: boolean
 *                   description: Whether user can navigate to parent
 *                   example: true
 *                 items:
 *                   type: array
 *                   description: List of directories and/or files
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         description: Item name
 *                         example: "appdata"
 *                       path:
 *                         type: string
 *                         description: Full path to item
 *                         example: "/mnt/nvme/appdata"
 *                       type:
 *                         type: string
 *                         enum: [directory, file]
 *                         description: Item type
 *                         example: "directory"
 *                       size:
 *                         type: integer
 *                         nullable: true
 *                         description: File size in bytes (null for directories)
 *                         example: null
 *                       modified:
 *                         type: string
 *                         format: date-time
 *                         description: Last modified timestamp
 *                         example: "2024-11-25T14:30:00.000Z"
 *             examples:
 *               virtualRoot:
 *                 summary: Virtual root response
 *                 value:
 *                   isVirtualRoot: true
 *                   currentPath: "/"
 *                   parentPath: null
 *                   canGoUp: false
 *                   items:
 *                     - name: "mnt"
 *                       path: "/mnt"
 *                       type: "directory"
 *                       displayPath: "/mnt"
 *                     - name: "mergerfs"
 *                       path: "/var/mergerfs"
 *                       type: "directory"
 *                       displayPath: "/var/mergerfs"
 *               normalDirectory:
 *                 summary: Normal directory response
 *                 value:
 *                   isVirtualRoot: false
 *                   currentPath: "/mnt/nvme"
 *                   parentPath: "/mnt"
 *                   canGoUp: true
 *                   items:
 *                     - name: "appdata"
 *                       path: "/mnt/nvme/appdata"
 *                       type: "directory"
 *                       size: null
 *                       modified: "2024-11-25T14:30:00.000Z"
 *                     - name: "backup"
 *                       path: "/mnt/nvme/backup"
 *                       type: "directory"
 *                       size: null
 *                       modified: "2024-11-20T10:15:00.000Z"
 *       400:
 *         description: Invalid type parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Invalid type. Must be 'directories' or 'all'"
 *       403:
 *         description: Path outside allowed directories
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Path outside allowed directories"
 *       404:
 *         description: Path does not exist
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Path does not exist"
 *       401:
 *         description: Not authenticated
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

// GET: Filesystem Navigator - Browse directories and files
router.get('/fsnavigator', async (req, res) => {
  try {
    const { path = '/', type = 'directories', roots } = req.query;

    // Validate type parameter
    if (type !== 'directories' && type !== 'all') {
      return res.status(400).json({
        error: 'Invalid type. Must be "directories" or "all"'
      });
    }

    // Parse roots parameter (comma-separated list)
    let allowedRoots = null;
    if (roots) {
      allowedRoots = roots.split(',').map(r => r.trim()).filter(r => r.length > 0);

      // Validate that roots are absolute paths
      for (const root of allowedRoots) {
        if (!root.startsWith('/')) {
          return res.status(400).json({
            error: `Invalid root path "${root}". Root paths must be absolute (start with /)`
          });
        }
      }
    }

    const result = await mosService.browseFilesystem(path, type, allowedRoots);
    res.json(result);
  } catch (error) {
    if (error.message.includes('outside allowed directories')) {
      res.status(403).json({ error: error.message });
    } else if (error.message.includes('does not exist')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('not a directory')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ============================================================
// SENSOR MAPPING ENDPOINTS
// ============================================================

/**
 * @swagger
 * /mos/sensors:
 *   get:
 *     summary: Get mapped sensor values
 *     description: Returns sensor values grouped by type (fan, temperature, power, voltage, psu, other)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Grouped sensor values
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fan:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 temperature:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 power:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 voltage:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 psu:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 other:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *             example:
 *               fan:
 *                 - id: "1735303800123"
 *                   index: 0
 *                   name: "Front Fan"
 *                   value: 30.5
 *                   unit: "%"
 *               temperature:
 *                 - id: "1735303801456"
 *                   index: 0
 *                   name: "CPU Temperature"
 *                   value: 45.2
 *                   unit: "°C"
 *               power: []
 *               voltage: []
 *               psu: []
 *               other: []
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/sensors', async (req, res) => {
  try {
    const sensors = await mosService.getMappedSensors();
    res.json(sensors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/unmapped:
 *   get:
 *     summary: Get unmapped sensors
 *     description: Returns sensor data in the same structure as /system/sensors, but with already mapped sources removed. Empty adapters (with no remaining sensors) are also removed.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sensor data structure with mapped entries removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: object
 *                 description: Adapter with its sensors
 *             example:
 *               coretemp-isa-0000:
 *                 Adapter: "ISA adapter"
 *                 Package id 0:
 *                   temp1_input: 32
 *                   temp1_max: 80
 *               nct6798-isa-0290:
 *                 Adapter: "ISA adapter"
 *                 fan1:
 *                   fan1_input: 1200
 *                   fan1_min: 0
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/sensors/unmapped', checkRole(['admin']), async (req, res) => {
  try {
    const unmapped = await mosService.getUnmappedSensors();
    res.json(unmapped);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/config:
 *   get:
 *     summary: Get sensor mapping configuration
 *     description: Returns full configuration for all sensor mappings grouped by type
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Grouped sensor configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fan:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 temperature:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 power:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 voltage:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 psu:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 other:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *             example:
 *               fan:
 *                 - id: "1735303800123"
 *                   index: 0
 *                   name: "Front Fan"
 *                   source: "nct6798-isa-0290.pwm1.pwm1"
 *                   unit: "%"
 *                   value_range:
 *                     min: 0
 *                     max: 255
 *                   transform: "percentage"
 *                   enabled: true
 *               temperature:
 *                 - id: "1735303801456"
 *                   index: 0
 *                   name: "CPU Temperature"
 *                   source: "nct6798-isa-0290.CPUTIN.temp2_input"
 *                   unit: "°C"
 *                   value_range: null
 *                   transform: null
 *                   enabled: true
 *               power: []
 *               voltage: []
 *               psu: []
 *               other: []
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/sensors/config', async (req, res) => {
  try {
    const config = await mosService.getSensorsConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/view:
 *   get:
 *     summary: Get sensors view settings
 *     description: Returns UI visibility settings for sensor columns
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: View settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 index:
 *                   type: boolean
 *                 name:
 *                   type: boolean
 *                 type:
 *                   type: boolean
 *                 subtype:
 *                   type: boolean
 *                 manufacturer:
 *                   type: boolean
 *                 model:
 *                   type: boolean
 *                 value:
 *                   type: boolean
 *                 unit:
 *                   type: boolean
 *                 actions:
 *                   type: boolean
 *             example:
 *               index: true
 *               name: true
 *               type: true
 *               subtype: true
 *               manufacturer: true
 *               model: true
 *               value: true
 *               unit: true
 *               actions: true
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/sensors/view', checkRole(['admin']), async (req, res) => {
  try {
    const view = await mosService.getSensorsView();
    res.json(view);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/view:
 *   post:
 *     summary: Update sensors view settings
 *     description: Update UI visibility settings for sensor columns
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
 *               index:
 *                 type: boolean
 *               name:
 *                 type: boolean
 *               type:
 *                 type: boolean
 *               subtype:
 *                 type: boolean
 *               manufacturer:
 *                 type: boolean
 *               model:
 *                 type: boolean
 *               value:
 *                 type: boolean
 *               unit:
 *                 type: boolean
 *               actions:
 *                 type: boolean
 *           example:
 *             index: false
 *             name: true
 *             manufacturer: true
 *             model: true
 *             value: true
 *             unit: true
 *             actions: true
 *     responses:
 *       200:
 *         description: Updated view settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post('/sensors/view', checkRole(['admin']), async (req, res) => {
  try {
    const view = await mosService.updateSensorsView(req.body);
    res.json(view);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors:
 *   post:
 *     summary: Create sensor mapping(s)
 *     description: Create one or multiple sensor mappings. Request body must be an array of sensor objects.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               required:
 *                 - name
 *                 - type
 *                 - source
 *                 - unit
 *               properties:
 *                 name:
 *                   type: string
 *                   description: Display name for the sensor
 *                 manufacturer:
 *                   type: string
 *                   nullable: true
 *                   description: Hardware manufacturer (optional)
 *                 model:
 *                   type: string
 *                   nullable: true
 *                   description: Hardware model (optional)
 *                 subtype:
 *                   type: string
 *                   nullable: true
 *                   description: Sensor subtype (optional)
 *                   enum: [voltage, wattage, amperage, speed, flow, temperature, rpm, percentage]
 *                 type:
 *                   type: string
 *                   enum: [fan, temperature, power, voltage, psu, other]
 *                 source:
 *                   type: string
 *                   description: Dot notation path to sensor value. Use \\. to escape literal dots in key names
 *                 unit:
 *                   type: string
 *                   description: Display unit
 *                 multiplier:
 *                   type: number
 *                   nullable: true
 *                   description: Multiplier for voltage dividers. Cannot be used with divisor.
 *                 divisor:
 *                   type: number
 *                   nullable: true
 *                   description: Divisor for scaled values. Cannot be used with multiplier.
 *                 value_range:
 *                   type: object
 *                   nullable: true
 *                   description: Value range for percentage transformation
 *                   properties:
 *                     min:
 *                       type: number
 *                     max:
 *                       type: number
 *                 transform:
 *                   type: string
 *                   nullable: true
 *                   enum: [percentage]
 *                   description: Value transformation type
 *                 enabled:
 *                   type: boolean
 *                   default: true
 *           examples:
 *             singleSensor:
 *               summary: Single sensor in array
 *               value:
 *                 - name: "Front Fan"
 *                   type: "fan"
 *                   source: "nct6798-isa-0290.pwm1.pwm1"
 *                   unit: "%"
 *                   value_range:
 *                     min: 0
 *                     max: 255
 *                   transform: "percentage"
 *             multipleSensors:
 *               summary: Multiple sensors
 *               value:
 *                 - name: "PSU Input Voltage"
 *                   manufacturer: "Corsair"
 *                   model: "HX750i"
 *                   subtype: "voltage"
 *                   type: "psu"
 *                   source: "corsairpsu-hid-3-2.v_in.in0_input"
 *                   unit: "V"
 *                 - name: "CPU Temperature"
 *                   type: "temperature"
 *                   source: "nct6798-isa-0290.CPUTIN.temp2_input"
 *                   unit: "°C"
 *             voltageWithMultiplier:
 *               summary: Voltage with multiplier (for voltage dividers)
 *               value:
 *                 - name: "12V Rail"
 *                   type: "voltage"
 *                   subtype: "voltage"
 *                   source: "nct6798-isa-0290.in7.in7_input"
 *                   unit: "V"
 *                   multiplier: 6
 *             powerWithDivisor:
 *               summary: Power with divisor (for sensors outputting milliwatts)
 *               value:
 *                 - name: "CPU Power"
 *                   type: "power"
 *                   subtype: "wattage"
 *                   source: "some-sensor.power.power1_input"
 *                   unit: "W"
 *                   divisor: 1000000
 *     responses:
 *       201:
 *         description: All sensors created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 created:
 *                   type: array
 *                   description: Successfully created sensors
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 errors:
 *                   type: array
 *                   description: Empty array when all succeeded
 *                   items:
 *                     type: object
 *             example:
 *               created:
 *                 - id: "1735403800123"
 *                   index: 0
 *                   name: "PSU Input Voltage"
 *                   manufacturer: "Corsair"
 *                   model: "HX750i"
 *                   subtype: "voltage"
 *                   type: "psu"
 *                   source: "corsairpsu-hid-3-2.v_in.in0_input"
 *                   unit: "V"
 *               errors: []
 *       207:
 *         description: Partial success - some sensors created, some failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 created:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       index:
 *                         type: integer
 *                       name:
 *                         type: string
 *                       error:
 *                         type: string
 *       400:
 *         description: All sensors failed to create
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post('/sensors', checkRole(['admin']), async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an array of sensors' });
    }
    const sensorsToCreate = req.body;

    const created = [];
    const errors = [];

    for (let i = 0; i < sensorsToCreate.length; i++) {
      try {
        const sensor = await mosService.createSensorMapping(sensorsToCreate[i]);
        created.push(sensor);
      } catch (err) {
        errors.push({ index: i, name: sensorsToCreate[i].name || `Sensor ${i}`, error: err.message });
      }
    }

    const status = errors.length === 0 ? 201 : (created.length > 0 ? 207 : 400);
    res.status(status).json({ created, errors });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/{id}:
 *   patch:
 *     summary: Update an existing sensor mapping
 *     description: Partially update fields of an existing sensor mapping. Changing type will move sensor to new group.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Sensor ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               manufacturer:
 *                 type: string
 *                 nullable: true
 *               model:
 *                 type: string
 *                 nullable: true
 *               subtype:
 *                 type: string
 *                 nullable: true
 *                 enum: [voltage, wattage, amperage, speed, flow, temperature, rpm, percentage]
 *               type:
 *                 type: string
 *                 enum: [fan, temperature, power, voltage, psu, other]
 *                 description: Changing type moves sensor to new group
 *               source:
 *                 type: string
 *               unit:
 *                 type: string
 *               multiplier:
 *                 type: number
 *                 nullable: true
 *                 description: Multiplier for voltage dividers. Cannot be used with divisor.
 *               divisor:
 *                 type: number
 *                 nullable: true
 *                 description: Divisor for scaled values. Cannot be used with multiplier.
 *               value_range:
 *                 type: object
 *                 nullable: true
 *               transform:
 *                 type: string
 *                 nullable: true
 *               enabled:
 *                 type: boolean
 *               index:
 *                 type: integer
 *                 description: New position index within group
 *     responses:
 *       200:
 *         description: Sensor mapping updated successfully
 *       400:
 *         description: Invalid input or source already defined
 *       404:
 *         description: Sensor not found
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.patch('/sensors/:id', checkRole(['admin']), async (req, res) => {
  try {
    const sensor = await mosService.updateSensorMapping(req.params.id, req.body);
    res.json(sensor);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('Invalid type') ||
               error.message.includes('Invalid source') ||
               error.message.includes('Cannot validate source') ||
               error.message.includes('Source already defined')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/sensors:
 *   put:
 *     summary: Replace all sensor mappings
 *     description: Replace the entire sensor configuration. Useful for bulk reordering or replacing all sensors at once. Existing sensors not in the new config will be deleted.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Grouped sensor configuration
 *             properties:
 *               fan:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               temperature:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               power:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               voltage:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               psu:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               other:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *     responses:
 *       200:
 *         description: Sensor configuration replaced successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Updated grouped sensor configuration
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.put('/sensors', checkRole(['admin']), async (req, res) => {
  try {
    const config = await mosService.replaceSensorsConfig(req.body);
    res.json(config);
  } catch (error) {
    if (error.message.includes('Invalid') || error.message.includes('must be')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/sensors/{id}:
 *   delete:
 *     summary: Delete a sensor mapping
 *     description: Delete a sensor mapping and reindex remaining sensors
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Sensor ID
 *     responses:
 *       200:
 *         description: Sensor mapping deleted successfully
 *       404:
 *         description: Sensor not found
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.delete('/sensors/:id', checkRole(['admin']), async (req, res) => {
  try {
    const sensor = await mosService.deleteSensorMapping(req.params.id);
    res.json(sensor);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/tokens:
 *   get:
 *     summary: Get all tokens
 *     description: Retrieve all tokens (github, dockerhub, etc.) decrypted from /boot/config/system/tokens.json (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tokens retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 github:
 *                   type: string
 *                   nullable: true
 *                   description: Decrypted GitHub token or null if not set
 *                 dockerhub:
 *                   type: string
 *                   nullable: true
 *                   description: Decrypted Docker Hub credentials (format username:token) or null if not set
 *             example:
 *               github: "ghp_1234567890abcdef"
 *               dockerhub: "myuser:dckr_pat_xyz123"
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *   post:
 *     summary: Update tokens (partial updates supported)
 *     description: Update one or more tokens (encrypted with JWT_SECRET) in /boot/config/system/tokens.json. Only provided tokens will be updated. (admin only)
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
 *               github:
 *                 type: string
 *                 nullable: true
 *                 description: GitHub token to save (will be encrypted)
 *               dockerhub:
 *                 type: string
 *                 nullable: true
 *                 description: Docker Hub credentials (format username:token) to save (will be encrypted). Used for pulling private images from Docker Hub.
 *           examples:
 *             update_github_only:
 *               summary: Update only GitHub token
 *               value:
 *                 github: "ghp_1234567890abcdef"
 *             update_both:
 *               summary: Update both tokens
 *               value:
 *                 github: "ghp_1234567890abcdef"
 *                 dockerhub: "myuser:dckr_pat_xyz123"
 *             remove_token:
 *               summary: Remove a token
 *               value:
 *                 github: null
 *     responses:
 *       200:
 *         description: Tokens updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 updated:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: List of token keys that were updated
 *             example:
 *               success: true
 *               message: "Tokens updated successfully"
 *               updated: ["github"]
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// GET: Read all tokens
router.get('/tokens', checkRole(['admin']), async (req, res) => {
  try {
    const result = await mosService.getTokens();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Update tokens (partial update supported)
router.post('/tokens', checkRole(['admin']), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with token fields (github, dockerhub, etc.).' });
    }

    // Validate dockerhub format: must be "username:token" if provided
    if (req.body.dockerhub && req.body.dockerhub !== null) {
      if (!req.body.dockerhub.includes(':')) {
        return res.status(400).json({ error: 'Docker Hub token must be in format "username:token"' });
      }
    }

    const result = await mosService.updateTokens(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ZRAM ENDPOINTS
// ============================================================

/**
 * @swagger
 * /mos/zram:
 *   get:
 *     summary: Get ZRAM configuration and status
 *     description: Retrieve current ZRAM configuration including module status (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: ZRAM configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Whether ZRAM is globally enabled
 *                 zram_devices:
 *                   type: integer
 *                   description: Number of configured ZRAM devices
 *                 module_loaded:
 *                   type: boolean
 *                   description: Whether the ZRAM kernel module is loaded
 *                 devices:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ZramDevice'
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *   post:
 *     summary: Update ZRAM configuration
 *     description: Update ZRAM settings. Changing enabled from false to true loads the module and activates devices. Changing from true to false checks for mounted ramdisks and unloads the module (admin only)
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
 *               enabled:
 *                 type: boolean
 *               zram_devices:
 *                 type: integer
 *                 description: Number of ZRAM devices (must match devices array length)
 *               devices:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/ZramDevice'
 *           example:
 *             enabled: true
 *             zram_devices: 2
 *             devices:
 *               - name: "ZRAM Swap"
 *                 enabled: true
 *                 index: 0
 *                 algorithm: "zstd"
 *                 size: "5G"
 *                 type: "swap"
 *                 config:
 *                   priority: -2
 *                   uuid: null
 *                   filesystem: null
 *               - name: "Temp Ramdisk"
 *                 enabled: false
 *                 index: 1
 *                 algorithm: "lz4"
 *                 size: "2G"
 *                 type: "ramdisk"
 *                 config:
 *                   priority: null
 *                   uuid: null
 *                   filesystem: "ext4"
 *     responses:
 *       200:
 *         description: ZRAM configuration updated successfully
 *       400:
 *         description: Invalid configuration or mounted ramdisks prevent disable
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *
 * components:
 *   schemas:
 *     ZramDevice:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique device ID (timestamp-based)
 *         name:
 *           type: string
 *           description: User-defined device name
 *         enabled:
 *           type: boolean
 *           description: Whether this device should be activated
 *         index:
 *           type: integer
 *           description: ZRAM device index (0 = /dev/zram0)
 *         algorithm:
 *           type: string
 *           enum: [zstd, lz4, lzo, lzo-rle]
 *           description: Compression algorithm
 *         size:
 *           type: string
 *           description: Device size (e.g., "4G", "512M")
 *         type:
 *           type: string
 *           enum: [swap, ramdisk]
 *           description: Device type
 *         config:
 *           type: object
 *           properties:
 *             priority:
 *               type: integer
 *               nullable: true
 *               description: Swap priority (required for enabled swap type, can be null if disabled)
 *             uuid:
 *               type: string
 *               nullable: true
 *               description: Filesystem UUID (auto-generated if not provided for ramdisk type)
 *             filesystem:
 *               type: string
 *               nullable: true
 *               enum: [ext4, xfs, btrfs]
 *               description: Filesystem type (required for enabled ramdisk type, can be null if disabled)
 */

// GET: Read ZRAM configuration
router.get('/zram', async (req, res) => {
  try {
    const config = await zramService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Update ZRAM configuration
router.post('/zram', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object.' });
    }
    const result = await zramService.updateConfig(req.body);
    res.json(result);
  } catch (error) {
    if (error.message.includes('mounted') || error.message.includes('Unmount')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/zram/algorithms:
 *   get:
 *     summary: Get available compression algorithms
 *     description: Returns list of compression algorithms supported by the kernel for ZRAM
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available algorithms
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *             example: ["lzo", "lzo-rle", "lz4", "lz4hc", "zstd", "deflate", "842"]
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

// GET: Available compression algorithms
router.get('/zram/algorithms', async (req, res) => {
  try {
    const algorithms = await zramService.getAlgorithms();
    res.json(algorithms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/zram/status:
 *   get:
 *     summary: Get ZRAM device status
 *     description: Get detailed status of all ZRAM devices including compression stats (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: ZRAM status retrieved successfully
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// GET: ZRAM device status
router.get('/zram/status', async (req, res) => {
  try {
    const status = await zramService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/zram/devices:
 *   post:
 *     summary: Add a new ZRAM device
 *     description: Add a new ZRAM device configuration. For swap type, config.priority is required. For ramdisk type, config.filesystem is required and config.uuid will be auto-generated if not provided (admin only)
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
 *               - name
 *               - type
 *             properties:
 *               name:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *                 default: false
 *               algorithm:
 *                 type: string
 *                 default: zstd
 *               size:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [swap, ramdisk]
 *               config:
 *                 type: object
 *           examples:
 *             swap_device:
 *               summary: Create enabled swap device
 *               value:
 *                 name: "ZRAM Swap"
 *                 enabled: true
 *                 algorithm: "zstd"
 *                 size: "5G"
 *                 type: "swap"
 *                 config:
 *                   priority: -2
 *             ramdisk_device_enabled:
 *               summary: Create enabled ramdisk device (uuid auto-generated)
 *               value:
 *                 name: "Temp Ramdisk"
 *                 enabled: true
 *                 algorithm: "lz4"
 *                 size: "2G"
 *                 type: "ramdisk"
 *                 config:
 *                   filesystem: "ext4"
 *             ramdisk_device_disabled:
 *               summary: Create disabled ramdisk device (config can be null)
 *               value:
 *                 name: "Reserved Ramdisk"
 *                 enabled: false
 *                 type: "ramdisk"
 *                 config:
 *                   filesystem: null
 *                   uuid: null
 *     responses:
 *       200:
 *         description: Device created successfully
 *       400:
 *         description: Invalid device configuration
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// POST: Add new ZRAM device
router.post('/zram/devices', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object.' });
    }
    const device = await zramService.addDevice(req.body);
    res.json(device);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/zram/devices/{id}:
 *   post:
 *     summary: Update a ZRAM device
 *     description: Update an existing ZRAM device configuration. Disabling a device will reset it (swap will be disabled, ramdisk must not be mounted) (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Device ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Device updated successfully
 *       400:
 *         description: Invalid update or device is mounted
 *       404:
 *         description: Device not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *   delete:
 *     summary: Delete a ZRAM device
 *     description: Delete a ZRAM device configuration. Device will be deactivated first (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Device ID
 *     responses:
 *       200:
 *         description: Device deleted successfully
 *       400:
 *         description: Device is mounted and cannot be deleted
 *       404:
 *         description: Device not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// POST: Update ZRAM device
router.post('/zram/devices/:id', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object.' });
    }
    const device = await zramService.updateDevice(req.params.id, req.body);
    res.json(device);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('mounted') || error.message.includes('Unmount')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// DELETE: Delete ZRAM device
router.delete('/zram/devices/:id', async (req, res) => {
  try {
    const deleted = await zramService.deleteDevice(req.params.id);
    res.json({ success: true, deleted });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('mounted') || error.message.includes('Unmount')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ============================================================
// ZSWAP ENDPOINTS
// ============================================================

/**
 * @swagger
 * /mos/zswap/algorithms:
 *   get:
 *     summary: Get available zswap compression algorithms
 *     description: Returns list of compression algorithms supported by the kernel for zswap
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available algorithms
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *               example: ["lzo", "lz4", "lz4hc", "zstd", "deflate", "842"]
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

// GET: Available zswap compression algorithms
router.get('/zswap/algorithms', (req, res) => {
  try {
    const algorithms = swapService.getAlgorithms();
    res.json(algorithms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/zswap/status:
 *   get:
 *     summary: Get swap and zswap status
 *     description: Returns current swap status including active swaps, zswap configuration, and any pending operations
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Swap status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 swaps:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filename:
 *                         type: string
 *                       type:
 *                         type: string
 *                       size:
 *                         type: integer
 *                       used:
 *                         type: integer
 *                       priority:
 *                         type: integer
 *                 zswap:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                     compressor:
 *                       type: string
 *                     max_pool_percent:
 *                       type: integer
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

// GET: Swap and zswap status
router.get('/zswap/status', async (req, res) => {
  try {
    const status = await swapService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
