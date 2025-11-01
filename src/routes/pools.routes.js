const express = require('express');
const router = express.Router();
const { checkRole, authenticateToken } = require('../middleware/auth.middleware');
const PoolsService = require('../services/pools.service');

// Initialize pools service for all operations
const poolsService = new PoolsService();

/**
 * @swagger
 * tags:
 *   name: Pools
 *   description: Storage Pool Management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *           example: "Pool not found"
 *     Pool:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Pool ID
 *           example: "1234567890"
 *         name:
 *           type: string
 *           description: Pool name
 *           example: "data_pool"
 *         type:
 *           type: string
 *           description: Pool type
 *           example: "btrfs"
 *         automount:
 *           type: boolean
 *           description: Whether pool is automatically mounted
 *           example: true
 *         comment:
 *           type: string
 *           description: Pool comment
 *           example: "My data pool"
 *         data_devices:
 *           type: array
 *           description: Data devices in the pool
 *           items:
 *             type: object
 *         parity_devices:
 *           type: array
 *           description: Parity devices in the pool
 *           items:
 *             type: object
 *         config:
 *           type: object
 *           description: Pool configuration
 *           properties:
 *             encrypted:
 *               type: boolean
 *               description: Whether pool is encrypted
 *               example: false
 */

/**
 * @swagger
 * /pools:
 *   get:
 *     summary: List all pools
 *     description: Get a list of all storage pools with optional filtering
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter pools by type
 *       - in: query
 *         name: exclude_type
 *         schema:
 *           type: string
 *         description: Exclude pools of specific type
 *     responses:
 *       200:
 *         description: List of pools
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Pool'
 *       500:
 *         description: Server error
 */
// List all pools
router.get('/', authenticateToken, async (req, res) => {
  try {
    const filters = {
      type: req.query.type,
      exclude_type: req.query.exclude_type
    };

    // Remove undefined filters
    Object.keys(filters).forEach(key => filters[key] === undefined && delete filters[key]);

    const pools = await poolsService.listPools(filters, req.user);
    res.json(pools);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}:
 *   get:
 *     summary: Get pool by ID
 *     description: Get a specific pool by its ID
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Pool'
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Get pool by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    res.json(pool);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/status:
 *   get:
 *     summary: Get pool status
 *     description: Get the status of a specific pool by its ID
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 */
// Get pool status
router.get('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: 'Pool not found' });
    }

    return res.json(pool.status || {});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/automount:
 *   post:
 *     summary: Toggle automount setting for a pool
 *     description: Enable or disable automatic mounting of a pool on system boot (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
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
 *                 description: Whether to enable or disable automount
 *                 example: true
 *     responses:
 *       200:
 *         description: Automount setting updated successfully
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
 *                   example: "Automount enabled for pool 'data_pool' (ID: 1746318722394)"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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
      return res.status(400).json({
        error: 'enabled parameter must be a boolean'
      });
    }

    // Use pools service directly
    const result = await poolsService.toggleAutomountById(req.params.id, enabled);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/comment:
 *   patch:
 *     summary: Update pool comment
 *     description: Update the comment/description for a storage pool (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - comment
 *             properties:
 *               comment:
 *                 type: string
 *                 description: Pool comment
 *                 example: "My storage pool"
 *     responses:
 *       200:
 *         description: Comment updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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
// Update pool comment
router.patch('/:id/comment', checkRole(['admin']), async (req, res) => {
  try {
    const { comment } = req.body;

    // Get the appropriate service
    const result = await poolsService.updatePoolComment(req.params.id, comment);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/order:
 *   put:
 *     summary: Update order of all pools
 *     description: Update the display order for multiple pools at once by providing an array of pool IDs with their new index values (admin only)
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
 *                     index:
 *                       type: integer
 *     responses:
 *       200:
 *         description: Order updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request
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
// Update pools order
router.put('/order', checkRole(['admin']), async (req, res) => {
  try {
    const { order } = req.body;

    if (!Array.isArray(order)) {
      return res.status(400).json({
        error: 'Order must be an array'
      });
    }

    // Use base service for this operation
    const result = await poolsService.updatePoolsOrder(order);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/single:
 *   post:
 *     summary: Create single device pool
 *     description: Create a new single device pool
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
 *               - device
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new pool
 *                 example: "data_pool"
 *               device:
 *                 type: string
 *                 description: Path to the device to use
 *                 example: "/dev/sdb"
 *               filesystem:
 *                 type: string
 *                 description: Filesystem to format the device with
 *                 enum: [ext4, xfs, btrfs]
 *                 default: xfs
 *                 example: xfs
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the device
 *                 example: false
 *               config:
 *                 type: object
 *                 properties:
 *                   encrypted:
 *                     type: boolean
 *                     description: Enable LUKS encryption
 *                     default: false
 *                     example: false
 *                   create_keyfile:
 *                     type: boolean
 *                     description: Create keyfile for automatic mounting
 *                     default: false
 *                     example: false
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required if encrypted=true)
 *                 example: "my_secure_password"
 *               options:
 *                 type: object
 *                 properties:
 *                   automount:
 *                     type: boolean
 *                     description: Whether to automatically mount the pool
 *                     default: false
 *                     example: true
 *                   comment:
 *                     type: string
 *                     description: Optional comment for the pool
 *                     example: "My data pool"
 *     responses:
 *       201:
 *         description: Pool created successfully
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
 *                   example: "Successfully created single device pool 'data_pool'"
 *                 pool:
 *                   type: object
 *                   description: Created pool object
 *       400:
 *         description: Bad request
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
// Create single device pool (admin only)
router.post('/single', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      device,
      filesystem = null,
      format,
      options = {},
      automount,
      config = {},
      passphrase
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!device) {
      return res.status(400).json({ error: 'Device path is required' });
    }

    // Prepare pool options
    const poolOptions = { ...options };
    if (automount !== undefined) {
      poolOptions.automount = automount;
    }
    if (config && Object.keys(config).length > 0) {
      poolOptions.config = config;
    }
    if (config.encrypted) {
      poolOptions.passphrase = passphrase || '';
    }

    // Get the appropriate service and create the pool
    // Use poolsService directly
    const result = await poolsService.createSingleDevicePool(
      name,
      device,
      filesystem,
      { ...poolOptions, format: format }
    );

    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/multi:
 *   post:
 *     summary: Create multi-device BTRFS pool
 *     description: Create a new multi-device BTRFS pool
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
 *               - devices
 *               - raidLevel
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new pool
 *                 example: "data_raid1"
 *               devices:
 *                 type: array
 *                 description: Array of device paths to use in the pool
 *                 items:
 *                   type: string
 *                 example: ["/dev/sdb", "/dev/sdc"]
 *               raidLevel:
 *                 type: string
 *                 description: BTRFS RAID level for the pool
 *                 enum: [single, raid0, raid1, raid10]
 *                 example: raid1
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices
 *                 example: true
 *               config:
 *                 type: object
 *                 properties:
 *                   encrypted:
 *                     type: boolean
 *                     description: Enable LUKS encryption
 *                     default: false
 *                     example: false
 *                   create_keyfile:
 *                     type: boolean
 *                     description: Create keyfile for automatic mounting
 *                     default: false
 *                     example: false
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required if encrypted=true)
 *                 example: "my_secure_password"
 *               options:
 *                 type: object
 *                 properties:
 *                   automount:
 *                     type: boolean
 *                     description: Whether to automatically mount the pool
 *                     default: false
 *                     example: true
 *                   comment:
 *                     type: string
 *                     description: Optional comment for the pool
 *                     example: "My RAID1 pool"
 *     responses:
 *       201:
 *         description: Pool created successfully
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
 *                   example: "Successfully created multi-device BTRFS pool 'data_raid1' with raid1 configuration"
 *                 pool:
 *                   type: object
 *                   description: Created pool object
 *       400:
 *         description: Bad request
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
// Create multi-device pool (admin only)
router.post('/multi', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      devices,
      raidLevel = 'raid1',
      format,
      options = {},
      config = {},
      passphrase
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Prepare pool options
    const poolOptions = { ...options };
    if (config && Object.keys(config).length > 0) {
      poolOptions.config = config;
    }
    if (config.encrypted) {
      poolOptions.passphrase = passphrase || '';
    }

    // Get the appropriate service and create the pool
    // Use poolsService directly
    const result = await poolsService.createMultiDevicePool(
      name,
      devices,
      raidLevel,
      { ...poolOptions, format: format }
    );

    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/mergerfs:
 *   post:
 *     summary: Create MergerFS pool
 *     description: Create a new MergerFS pool
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
 *               - devices
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new pool
 *                 example: "mergerfs_pool"
 *               devices:
 *                 type: array
 *                 description: Array of device paths to use in the pool
 *                 items:
 *                   type: string
 *                 example: ["/dev/sdb", "/dev/sdc"]
 *               filesystem:
 *                 type: string
 *                 description: Filesystem to format individual devices with
 *                 enum: [ext4, xfs, btrfs]
 *                 default: xfs
 *                 example: xfs
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices
 *                 example: true
 *               config:
 *                 type: object
 *                 properties:
 *                   encrypted:
 *                     type: boolean
 *                     description: Enable LUKS encryption
 *                     default: false
 *                     example: false
 *                   create_keyfile:
 *                     type: boolean
 *                     description: Create keyfile for automatic mounting
 *                     default: false
 *                     example: false
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required if encrypted=true)
 *                 example: "my_secure_password"
 *               options:
 *                 type: object
 *                 properties:
 *                   automount:
 *                     type: boolean
 *                     description: Whether to automatically mount the pool
 *                     default: false
 *                     example: true
 *                   comment:
 *                     type: string
 *                     description: Optional comment for the pool
 *                     example: "My MergerFS pool"
 *                   mergerfsOptions:
 *                     type: string
 *                     description: MergerFS mount options
 *                     default: "defaults,allow_other,direct_io=auto,moveonenospc=true,category.create=mfs,minfree=5G"
 *                     example: "defaults,allow_other,direct_io=auto"
 *     responses:
 *       201:
 *         description: Pool created successfully
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
 *                   example: "Successfully created MergerFS pool 'mergerfs_pool' with 2 device(s)"
 *                 pool:
 *                   type: object
 *                   description: Created pool object
 *       400:
 *         description: Bad request
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
// Create MergerFS pool (admin only)
router.post('/mergerfs', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      devices,
      filesystem = 'xfs',
      format,
      options = {},
      config = {},
      passphrase
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Prepare pool options
    const poolOptions = { ...options };
    if (config && Object.keys(config).length > 0) {
      poolOptions.config = config;
    }
    if (config.encrypted) {
      poolOptions.passphrase = passphrase || '';
    }

    // Get the appropriate service and create the pool
    // Use poolsService directly
    const result = await poolsService.createMergerFSPool(
      name,
      devices,
      filesystem,
      { ...poolOptions, format: format }
    );

    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/mount:
 *   post:
 *     summary: Mount pool by ID
 *     description: Mount a storage pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (if required)
 *                 example: "my_secure_password"
 *               mountOptions:
 *                 type: string
 *                 description: Additional mount options
 *                 example: "noatime"
 *     responses:
 *       200:
 *         description: Pool mounted successfully
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
 *                   example: "Pool 'data_pool' mounted successfully"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Mount pool
router.post('/:id/mount', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { passphrase, mountOptions } = req.body;

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get the appropriate service and mount the pool
    const result = await poolsService.mountPoolById(id, {
      passphrase,
      mountOptions,
      ...req.body
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/unmount:
 *   post:
 *     summary: Unmount pool by ID
 *     description: Unmount a storage pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 description: Force unmount
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Pool unmounted successfully
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
 *                   example: "Pool 'data_pool' unmounted successfully"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Unmount pool
router.post('/:id/unmount', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { force = false } = req.body;

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get the appropriate service and unmount the pool
    const result = await poolsService.unmountPoolById(id, {
      force,
      ...req.body
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}:
 *   delete:
 *     summary: Remove pool by ID
 *     description: Remove a storage pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool removed successfully
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
 *                   example: "Pool 'data_pool' removed successfully"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Remove pool (admin only)
router.delete('/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get the appropriate service and remove the pool
    const result = await poolsService.removePoolById(id, req.body);

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/devices:
 *   post:
 *     summary: Add devices to pool
 *     description: Add new devices to an existing pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 description: Array of device paths to add
 *                 items:
 *                   type: string
 *                 example: ["/dev/sdd", "/dev/sde"]
 *               format:
 *                 type: boolean
 *                 description: Whether to format the devices
 *                 example: true
 *     responses:
 *       200:
 *         description: Devices added successfully
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
 *                   example: "Successfully added 2 device(s) to pool"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Add devices to pool (admin only)
router.post('/:id/devices', checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { devices, format } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get the appropriate service and add devices
    const result = await poolsService.addDevicesToPool(id, devices, { format });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/status:
 *   get:
 *     summary: Get pool status
 *     description: Get the current status of a pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 mounted:
 *                   type: boolean
 *                   example: true
 *                 mountPoint:
 *                   type: string
 *                   example: "/mnt/storage/data_pool"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Get pool status
router.get('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the pool first
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get pool status using base service
    const status = await poolsService._getPoolStatus(pool);

    res.json(status);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/parity/add:
 *   post:
 *     summary: Add parity devices to a MergerFS pool
 *     description: Add one or more parity devices to an existing MergerFS pool for SnapRAID protection (admin only). Devices will be formatted if needed and SnapRAID configuration will be updated.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of parity device paths to add
 *                 example: ["/dev/sdd", "/dev/sde"]
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices before adding
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Parity devices added successfully
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
 *                   example: "Successfully added 2 parity device(s) to pool 'media'"
 *                 pool:
 *                   type: object
 *                   description: Updated pool object
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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

// Add parity devices to an existing MergerFS pool (admin only)
router.post('/:id/parity/add', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, format = false } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one parity device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    if (pool.type !== 'mergerfs') {
      return res.status(400).json({ error: 'Parity devices can only be added to MergerFS pools' });
    }

    // Get the appropriate service and add parity devices
    const result = await poolsService.addParityDevicesToPool(req.params.id, devices, { format });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// Replace parity device in pool (admin only)
router.post('/:id/parity/replace', checkRole(['admin']), async (req, res) => {
  try {
    const { oldDevice, newDevice, format = false } = req.body;

    if (!oldDevice || !newDevice) {
      return res.status(400).json({ error: 'Both oldDevice and newDevice are required' });
    }

    const options = {
      format,
      passphrase: req.body.passphrase
    };

    const result = await poolsService.replaceParityDeviceInPool(req.params.id, oldDevice, newDevice, options);
    res.json(result);
  } catch (error) {
    console.error('Error replacing parity device:', error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/parity/remove:
 *   post:
 *     summary: Remove parity devices from a MergerFS pool
 *     description: Remove one or more parity devices from an existing MergerFS pool (admin only). If all parity devices are removed, SnapRAID configuration will be cleaned up.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of parity device paths to remove
 *                 example: ["/dev/sdd"]
 *               unmount:
 *                 type: boolean
 *                 description: Whether to unmount the devices after removing them
 *                 default: true
 *                 example: true
 *     responses:
 *       200:
 *         description: Parity devices removed successfully
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
 *                   example: "Successfully removed 1 parity device(s) from pool 'data_mergerfs'. SnapRAID configuration removed."
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *                 snapraidDisabled:
 *                   type: boolean
 *                   description: Whether SnapRAID was disabled due to no remaining parity devices
 *                   example: true
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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

// Remove parity devices from an existing MergerFS pool (admin only)
router.post('/:id/parity/remove', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, unmount = true } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one parity device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    if (pool.type !== 'mergerfs') {
      return res.status(400).json({ error: 'Parity devices can only be removed from MergerFS pools' });
    }

    // Get the appropriate service and remove parity devices
    const result = await poolsService.removeParityDevicesFromPool(req.params.id, devices, { unmount });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/devices/remove:
 *   post:
 *     summary: Remove devices from an existing MergerFS pool
 *     description: Remove one or more devices from an existing MergerFS pool (admin only). Will update SnapRAID config if pool has SnapRAID configured.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of device paths to remove
 *                 example: ["/dev/sdd", "/dev/sde"]
 *               unmount:
 *                 type: boolean
 *                 description: Whether to unmount the devices after removing them
 *                 default: true
 *                 example: true
 *     responses:
 *       200:
 *         description: Devices removed successfully
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
 *                   example: "Successfully removed 2 device(s) from MergerFS pool 'data_mergerfs'"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters or device requirements not met
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized
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
 *         description: Pool not found
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

// Remove devices from an existing MergerFS pool (admin only)
router.post('/:id/devices/remove', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, unmount = true } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    // Get the appropriate service and remove devices
    const result = await poolsService.removeDevicesFromPool(req.params.id, devices, { unmount });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/devices/add:
 *   post:
 *     summary: Add devices to an existing pool
 *     description: |
 *       Add one or more devices to an existing pool (admin only).
 *
 *       **BTRFS Pools:**
 *       - Single-device pools (type 'btrfs') will automatically be converted to multi-device with raid1 configuration
 *       - Uses native BTRFS device addition functionality
 *       - Pool must be mounted for the operation
 *
 *       **MergerFS Pools:**
 *       - Devices will be mounted individually and added to the MergerFS union
 *       - Will format devices if needed and update SnapRAID config if pool has SnapRAID configured
 *       - Pool will be remounted automatically after device addition
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of device paths to add
 *                 example: ["/dev/sdd", "/dev/sde"]
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices before adding
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Devices added successfully
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
 *                   example: "Successfully added 2 device(s) to pool 'data_mergerfs'"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters or device requirements not met
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized
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
 *         description: Pool not found
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

// Replace device in pool (admin only)
router.post('/:id/devices/replace', checkRole(['admin']), async (req, res) => {
  try {
    const { oldDevice, newDevice, format = false } = req.body;

    if (!oldDevice || !newDevice) {
      return res.status(400).json({ error: 'Both oldDevice and newDevice are required' });
    }

    const options = {
      format,
      passphrase: req.body.passphrase
    };

    const result = await poolsService.replaceDeviceInPool(req.params.id, oldDevice, newDevice, options);
    res.json(result);
  } catch (error) {
    console.error('Error replacing device:', error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// Add devices to an existing pool (admin only)
router.post('/:id/devices/add', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, format = false } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    // Get the appropriate service and add devices
    const result = await poolsService.addDevicesToPool(req.params.id, devices, { format });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/parity:
 *   post:
 *     summary: Execute SnapRAID operation on a MergerFS pool
 *     description: Execute SnapRAID operations (sync, check, scrub, fix, status) on a MergerFS pool with parity devices (admin only). Validates that the pool is MergerFS type, has parity devices, and no operation is currently running.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - operation
 *             properties:
 *               operation:
 *                 type: string
 *                 description: SnapRAID operation to execute
 *                 enum: [sync, check, scrub, fix, status, force_stop]
 *                 example: "sync"
 *     responses:
 *       200:
 *         description: SnapRAID operation executed successfully
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
 *                   example: "SnapRAID sync operation started for pool 'data_mergerfs'"
 *                 operation:
 *                   type: string
 *                   example: "sync"
 *                 pool:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     parity_devices:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Invalid request parameters or operation requirements not met
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   examples:
 *                     invalid_operation:
 *                       value: "Invalid operation. Supported operations: sync, check, scrub, fix, status, force_stop"
 *                     operation_running:
 *                       value: "SnapRAID operation is already running for pool 'data_mergerfs'. Socket file exists: /run/snapraid/data_mergerfs.socket"
 *                     no_parity:
 *                       value: "Pool does not have any SnapRAID parity devices configured"
 *                     wrong_type:
 *                       value: "SnapRAID operations are only supported for MergerFS pools"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Execute SnapRAID operation on a MergerFS pool (admin only)
router.post('/:id/parity', checkRole(['admin']), async (req, res) => {
  try {
    const { operation } = req.body;

    if (!operation) {
      return res.status(400).json({ error: 'Operation is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    if (pool.type !== 'mergerfs') {
      return res.status(400).json({ error: 'SnapRAID operations are only supported for MergerFS pools' });
    }

    // Get the appropriate service and execute SnapRAID operation
    const result = await poolsService.executeSnapRAIDOperation(req.params.id, operation);

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('already running') ||
        error.message.includes('Invalid operation') ||
        error.message.includes('only supported for MergerFS') ||
        error.message.includes('does not have any SnapRAID') ||
        error.message.includes('No SnapRAID operation is currently running')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
