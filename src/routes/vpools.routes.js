const express = require('express');
const router = express.Router();
const { checkRole, authenticateToken } = require('../middleware/auth.middleware');
const VpoolsService = require('../services/vpools.service');

// Initialize vpools service for all operations
const vpoolsService = new VpoolsService();

/**
 * @swagger
 * components:
 *   schemas:
 *     Vpool:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier (timestamp-based)
 *           example: "1719158400123"
 *         name:
 *           type: string
 *           description: Vpool name
 *           example: "mediapath"
 *         type:
 *           type: string
 *           enum: [vpool]
 *           example: "vpool"
 *         index:
 *           type: integer
 *           description: Display order index
 *           example: 1
 *         automount:
 *           type: boolean
 *           description: Whether the vpool is mounted on creation
 *           example: true
 *         comment:
 *           type: string
 *           example: ""
 *         paths:
 *           type: array
 *           description: Source paths that are unioned via mergerfs, in branch order
 *           items:
 *             type: string
 *           example: ["/mnt/disk1/media", "/mnt/disk2/media"]
 *         config:
 *           type: object
 *           properties:
 *             policies:
 *               type: object
 *               properties:
 *                 create:
 *                   type: string
 *                   description: "MergerFS create policy (e.g. mspmfs, pfrd, mfs, ff, lfs, eppfrd, epmfs, ...)"
 *                   example: "mspmfs"
 *                 search:
 *                   type: string
 *                   description: "MergerFS search policy (e.g. ff, all, newest)"
 *                   example: "ff"
 *             shared:
 *               type: boolean
 *               example: false
 *         status:
 *           type: object
 *           description: Runtime mount status and storage info from the union mount (API-only)
 *           properties:
 *             mounted:
 *               type: boolean
 *               example: true
 *             totalSpace:
 *               type: integer
 *               example: 1000000000000
 *             totalSpace_human:
 *               type: string
 *               example: "931 GiB"
 *             usedSpace:
 *               type: integer
 *               example: 250000000000
 *             usedSpace_human:
 *               type: string
 *               example: "233 GiB"
 *             freeSpace:
 *               type: integer
 *               example: 750000000000
 *             freeSpace_human:
 *               type: string
 *               example: "699 GiB"
 *             usagePercent:
 *               type: integer
 *               example: 25
 *         mountPoint:
 *           type: string
 *           description: Present only when mounted
 *           example: "/mnt/mediapath"
 */

/**
 * @swagger
 * /pools/vpools:
 *   get:
 *     summary: List all vpools (MergerFS Path Pools)
 *     description: |
 *       List all MergerFS Path Pools with mount status and storage info. Storage is
 *       reported from a single df on the mergerfs union mount, like regular pools.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of vpools
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Vpool'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// List all vpools
router.get('/', authenticateToken, async (req, res) => {
  try {
    const vpools = await vpoolsService.listVpools({}, req.user);
    res.json(vpools);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/vpools/order:
 *   put:
 *     summary: Update vpool display order
 *     description: Update the display order (index) of vpools (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - order
 *             properties:
 *               order:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "1719158400123"
 *                     index:
 *                       type: integer
 *                       example: 1
 *     responses:
 *       200:
 *         description: Order updated successfully
 *       400:
 *         description: Invalid request
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
// Update vpools order (admin only) - must be defined before /:id routes
router.put('/order', checkRole(['admin']), async (req, res) => {
  try {
    const { order } = req.body;

    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'Order must be an array' });
    }

    const result = await vpoolsService.updateVpoolsOrder(order);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/vpools:
 *   post:
 *     summary: Create a vpool (MergerFS Path Pool)
 *     description: |
 *       Create a new MergerFS Path Pool by unioning existing filesystem paths under
 *       /mnt/{name}. The name must be globally unique (across pools and vpools) and
 *       must not be a reserved name. When automount is enabled (default), the pool is
 *       mounted immediately; all configured paths must exist as directories.
 *     tags: [Pools]
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
 *               - paths
 *             properties:
 *               name:
 *                 type: string
 *                 example: "mediapath"
 *               paths:
 *                 type: array
 *                 description: Source directory paths to union, in branch order
 *                 items:
 *                   type: string
 *                 example: ["/mnt/disk1/media", "/mnt/disk2/media"]
 *               automount:
 *                 type: boolean
 *                 example: true
 *               comment:
 *                 type: string
 *                 example: ""
 *               config:
 *                 type: object
 *                 properties:
 *                   policies:
 *                     type: object
 *                     properties:
 *                       create:
 *                         type: string
 *                         example: "mspmfs"
 *                       search:
 *                         type: string
 *                         example: "ff"
 *                   shared:
 *                     type: boolean
 *                     example: false
 *     responses:
 *       201:
 *         description: Vpool created successfully
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
 *                 pool:
 *                   $ref: '#/components/schemas/Vpool'
 *       400:
 *         description: Invalid request (bad name, reserved/duplicate name, missing/invalid paths)
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
 */
// Create vpool (admin only)
router.post('/', checkRole(['admin']), async (req, res) => {
  try {
    const { name, paths, automount, comment, config } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'At least one path is required' });
    }

    const result = await vpoolsService.createVpool(name, paths, { automount, comment, config });
    res.status(201).json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/vpools/{id}:
 *   get:
 *     summary: Get a vpool by ID
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Vpool ID
 *     responses:
 *       200:
 *         description: Vpool details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Vpool'
 *       404:
 *         description: Vpool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Get vpool by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const vpool = await vpoolsService.getVpoolById(req.params.id, req.user);
    res.json(vpool);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/vpools/{id}/mount:
 *   post:
 *     summary: Mount a vpool by ID
 *     description: |
 *       Mount the mergerfs union at /mnt/{name}. All configured source paths are
 *       validated first; if any path is missing or not a directory, the mount is
 *       aborted with an error.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Vpool ID
 *     responses:
 *       200:
 *         description: Vpool mounted successfully
 *       400:
 *         description: Mount failed (e.g. a path does not exist)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Vpool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Mount vpool
router.post('/:id/mount', authenticateToken, async (req, res) => {
  try {
    const result = await vpoolsService.mountVpoolById(req.params.id, req.user);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/vpools/{id}/unmount:
 *   post:
 *     summary: Unmount a vpool by ID
 *     description: Unmount the mergerfs union at /mnt/{name}. Source paths are left untouched.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Vpool ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 description: Force lazy unmount, bypassing dependency checks
 *                 example: false
 *     responses:
 *       200:
 *         description: Vpool unmounted successfully
 *       400:
 *         description: Unmount failed (e.g. in use)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Vpool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Unmount vpool
router.post('/:id/unmount', authenticateToken, async (req, res) => {
  try {
    const { force = false } = req.body || {};
    const result = await vpoolsService.unmountVpoolById(req.params.id, { force });
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/vpools/{id}/automount:
 *   post:
 *     summary: Toggle automount for a vpool
 *     description: Enable or disable automount (flag only, does not mount/unmount) (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Vpool ID
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
 *                 example: true
 *     responses:
 *       200:
 *         description: Automount toggled successfully
 *       400:
 *         description: Invalid request
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
// Toggle automount by ID (admin only)
router.post('/:id/automount', checkRole(['admin']), async (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled parameter must be a boolean' });
    }

    const result = await vpoolsService.toggleAutomountById(req.params.id, enabled);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/vpools/{id}:
 *   delete:
 *     summary: Delete a vpool by ID
 *     description: |
 *       Unmount (if mounted) and remove the vpool from vpools.json. Source paths are
 *       never deleted. Fails if the pool is in use unless force is set (admin only).
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Vpool ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 example: false
 *     responses:
 *       200:
 *         description: Vpool removed successfully
 *       400:
 *         description: Removal failed (e.g. in use)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Vpool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Remove vpool (admin only)
router.delete('/:id', checkRole(['admin']), async (req, res) => {
  try {
    const result = await vpoolsService.removeVpoolById(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
