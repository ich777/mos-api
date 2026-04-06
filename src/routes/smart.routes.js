const express = require('express');
const router = express.Router();
const smartService = require('../services/smart.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: SMART
 *   description: SMART Monitoring Configuration and Status
 *
 * components:
 *   schemas:
 *     SmartConfig:
 *       type: object
 *       properties:
 *         defaults:
 *           type: object
 *           properties:
 *             temperatureLimits:
 *               type: object
 *               properties:
 *                 hdd:
 *                   type: object
 *                   properties:
 *                     warning:
 *                       type: integer
 *                       example: 45
 *                     critical:
 *                       type: integer
 *                       example: 55
 *                 ssd:
 *                   type: object
 *                   properties:
 *                     warning:
 *                       type: integer
 *                       example: 55
 *                     critical:
 *                       type: integer
 *                       example: 70
 *                 nvme:
 *                   type: object
 *                   properties:
 *                     warning:
 *                       type: integer
 *                       example: 65
 *                     critical:
 *                       type: integer
 *                       example: 80
 *             monitoredAttributes:
 *               type: array
 *               items:
 *                 type: integer
 *               example: [5, 187, 198, 199]
 *             attributeNotificationCooldown:
 *               type: integer
 *               description: Cooldown in seconds between attribute notifications per disk
 *               example: 300
 *             bootCheck:
 *               type: boolean
 *               description: Send notifications for non-zero monitored attributes on API startup
 *               example: true
 *         smartdOptions:
 *           type: object
 *           properties:
 *             quietMode:
 *               type: string
 *               enum: [errorsonly, nodev, ""]
 *               description: smartd syslog quiet mode
 *               example: "errorsonly"
 *         disks:
 *           type: object
 *           additionalProperties:
 *             $ref: '#/components/schemas/SmartDiskConfig'
 *         orphaned:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/SmartOrphan'
 *     SmartDiskConfig:
 *       type: object
 *       properties:
 *         temperatureWarning:
 *           type: integer
 *           description: Warning temperature threshold in Celsius
 *           example: 45
 *         temperatureCritical:
 *           type: integer
 *           description: Critical temperature threshold in Celsius
 *           example: 55
 *         monitoredAttributes:
 *           type: array
 *           items:
 *             type: integer
 *           description: SMART attribute IDs to monitor for changes
 *           example: [5, 187, 198, 199]
 *         attributeNotificationCooldown:
 *           type: integer
 *           description: Cooldown in seconds between attribute notifications
 *           example: 300
 *         lastSeen:
 *           type: string
 *           format: date-time
 *           description: Last time this disk was seen
 *         model:
 *           type: string
 *           description: Disk model name
 *           example: "WDC WD120EDAZ-11F3RA0"
 *         diskType:
 *           type: string
 *           enum: [hdd, ssd, nvme, unknown]
 *           example: "hdd"
 *         warning:
 *           type: boolean
 *           readOnly: true
 *           description: Computed field - true if any monitored attribute has a non-zero raw value
 *           example: false
 *     SmartOrphan:
 *       type: object
 *       description: |
 *         A disk that was previously configured but is no longer detected in the system.
 *         Created automatically when a disk disappears during _syncDisks (e.g. disk removed,
 *         cable unplugged, or device replaced). Contains the last known metadata from the
 *         active disk config before it was moved to orphaned status.
 *       properties:
 *         serial:
 *           type: string
 *           description: Serial number of the orphaned disk (was the config key in disks)
 *           example: "5PJJ26DF"
 *         lastSeen:
 *           type: string
 *           format: date-time
 *           description: Timestamp when the disk was last detected in the system
 *           example: "2026-04-05T17:13:48.918Z"
 *         model:
 *           type: string
 *           description: Model name of the orphaned disk
 *           example: "WDC WD120EDAZ-11F3RA0"
 *         diskType:
 *           type: string
 *           enum: [hdd, ssd, nvme, unknown]
 *           description: Type of disk as detected at last sync
 *           example: "hdd"
 */

/**
 * @swagger
 * /disks/smart/config:
 *   get:
 *     summary: Get SMART monitoring configuration
 *     description: Retrieve the complete SMART monitoring configuration including defaults, per-disk settings, and orphaned entries
 *     tags: [SMART]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: SMART configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SmartConfig'
 *       500:
 *         description: Server error
 */
router.get('/config', async (req, res) => {
  try {
    const config = smartService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/smart/config:
 *   put:
 *     summary: Update global SMART configuration
 *     description: |
 *       Update global SMART settings (defaults, smartdOptions). Supports partial updates via deep merge -
 *       only send the fields you want to change. After update, smartd.conf is regenerated and smartd reloaded.
 *       Note: Use the per-disk endpoints to manage individual disk configurations.
 *     tags: [SMART]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               defaults:
 *                 type: object
 *                 description: Partial defaults to merge
 *               smartdOptions:
 *                 type: object
 *                 description: Partial smartd options to merge
 *           examples:
 *             changeHddWarning:
 *               summary: Change only HDD warning temperature
 *               value:
 *                 defaults:
 *                   temperatureLimits:
 *                     hdd:
 *                       warning: 50
 *             changeCooldown:
 *               summary: Change attribute notification cooldown
 *               value:
 *                 defaults:
 *                   attributeNotificationCooldown: 7200
 *             disableBootCheck:
 *               summary: Disable boot check notifications
 *               value:
 *                 defaults:
 *                   bootCheck: false
 *     responses:
 *       200:
 *         description: Configuration updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SmartConfig'
 *       400:
 *         description: Invalid request body
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.put('/config', checkRole(['admin']), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const config = await smartService.updateConfig(req.body);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/smart/config/disks/{device}:
 *   get:
 *     summary: Get SMART config for a specific disk
 *     description: Retrieve the monitoring configuration for a disk by device name (e.g. sda) or serial number
 *     tags: [SMART]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g. sda, nvme0n1) or serial number
 *         example: "sda"
 *     responses:
 *       200:
 *         description: Disk configuration retrieved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SmartDiskConfig'
 *       404:
 *         description: Disk not found in configuration
 *       500:
 *         description: Server error
 */
router.get('/config/disks/:device', async (req, res) => {
  try {
    const serial = smartService.resolveToSerial(req.params.device);
    if (!serial) {
      return res.status(404).json({ error: `Disk ${req.params.device} not found` });
    }
    const config = smartService.getDiskConfig(serial);
    if (!config) {
      return res.status(404).json({ error: `Disk ${req.params.device} not found in configuration` });
    }
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/smart/config/disks/{device}:
 *   put:
 *     summary: Update SMART config for a specific disk
 *     description: |
 *       Update monitoring settings for a specific disk by device name or serial.
 *       Supports partial updates - only send the fields you want to change.
 *       After update, smartd.conf is regenerated.
 *     tags: [SMART]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g. sda, nvme0n1) or serial number
 *         example: "sda"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               temperatureWarning:
 *                 type: integer
 *               temperatureCritical:
 *                 type: integer
 *               monitoredAttributes:
 *                 type: array
 *                 items:
 *                   type: integer
 *               attributeNotificationCooldown:
 *                 type: integer
 *           examples:
 *             customTemperature:
 *               summary: Set custom temperature limits
 *               value:
 *                 temperatureWarning: 50
 *                 temperatureCritical: 60
 *     responses:
 *       200:
 *         description: Disk configuration updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SmartDiskConfig'
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Disk not found
 *       500:
 *         description: Server error
 */
router.put('/config/disks/:device', checkRole(['admin']), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const serial = smartService.resolveToSerial(req.params.device);
    if (!serial) {
      return res.status(404).json({ error: `Disk ${req.params.device} not found` });
    }
    const config = await smartService.updateDiskConfig(serial, req.body);
    res.json(config);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/smart/config/disks/{device}:
 *   delete:
 *     summary: Delete disk SMART config
 *     description: |
 *       Remove custom configuration for a disk by device name or serial.
 *       The disk will be re-added with default settings on the next sync if still present.
 *     tags: [SMART]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g. sda, nvme0n1) or serial number
 *     responses:
 *       200:
 *         description: Disk configuration deleted
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Disk not found
 *       500:
 *         description: Server error
 */
router.delete('/config/disks/:device', checkRole(['admin']), async (req, res) => {
  try {
    const serial = smartService.resolveToSerial(req.params.device);
    if (!serial) {
      return res.status(404).json({ error: `Disk ${req.params.device} not found` });
    }
    const result = await smartService.deleteDiskConfig(serial);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/smart/config/orphaned:
 *   get:
 *     summary: List orphaned disk entries
 *     description: Get all disk configurations that were previously known but the disk is no longer physically present
 *     tags: [SMART]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Orphaned entries retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SmartOrphan'
 *       500:
 *         description: Server error
 */
router.get('/config/orphaned', async (req, res) => {
  try {
    res.json(smartService.getOrphaned());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/smart/config/orphaned:
 *   delete:
 *     summary: Delete all orphaned entries
 *     description: Remove all orphaned disk configuration entries at once
 *     tags: [SMART]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All orphaned entries deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 count:
 *                   type: integer
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.delete('/config/orphaned', checkRole(['admin']), async (req, res) => {
  try {
    const result = await smartService.deleteAllOrphans();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/smart/config/orphaned/{serial}:
 *   delete:
 *     summary: Delete a specific orphaned entry
 *     description: Remove a single orphaned disk configuration entry by serial number
 *     tags: [SMART]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serial
 *         required: true
 *         schema:
 *           type: string
 *         description: Serial number of the orphaned disk
 *     responses:
 *       200:
 *         description: Orphaned entry deleted
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Orphaned entry not found
 *       500:
 *         description: Server error
 */
router.delete('/config/orphaned/:serial', checkRole(['admin']), async (req, res) => {
  try {
    const result = await smartService.deleteOrphan(req.params.serial);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
