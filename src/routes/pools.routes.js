const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth.middleware');
const poolsService = require('../services/pools.service');

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
 *           description: Unique pool ID
 *           example: "1746318722394"
 *         name:
 *           type: string
 *           description: Pool name
 *           example: "media"
 *         type:
 *           type: string
 *           enum: ["ext4", "xfs", "btrfs", "mergerfs"]
 *           description: Pool type (filesystem for single-device pools)
 *           example: "mergerfs"
 *         automount:
 *           type: boolean
 *           description: Whether the pool should automount on system boot
 *           example: true
 *         comment:
 *           type: string
 *           description: Optional comment for the pool
 *           example: ""
 *         data_devices:
 *           type: array
 *           description: Array of data devices in the pool
 *           items:
 *             type: object
 *             properties:
 *               slot:
 *                 type: string
 *                 description: Slot number of the device
 *                 example: "1"
 *               id:
 *                 type: string
 *                 description: Device UUID
 *                 example: "247a6f5b-cc00-42e8-8e86-b0f08960d863"
 *               device:
 *                 type: string
 *                 description: Device path
 *                 example: "/dev/sdj"
 *               filesystem:
 *                 type: string
 *                 description: Filesystem type
 *                 example: "xfs"
 *               spindown:
 *                 type: string
 *                 description: Spindown configuration
 *                 example: null
 *               storage:
 *                 type: object
 *                 description: Storage information for the device
 *                 properties:
 *                   totalSpace:
 *                     type: number
 *                     description: Total space in bytes
 *                     example: 2000398934016
 *                   totalSpace_human:
 *                     type: string
 *                     description: Human-readable total space
 *                     example: "1.82 TB"
 *                   usedSpace:
 *                     type: number
 *                     description: Used space in bytes
 *                     example: 500000000000
 *                   usedSpace_human:
 *                     type: string
 *                     description: Human-readable used space
 *                     example: "465.66 GB"
 *                   freeSpace:
 *                     type: number
 *                     description: Free space in bytes
 *                     example: 1500398934016
 *                   freeSpace_human:
 *                     type: string
 *                     description: Human-readable free space
 *                     example: "1.36 TB"
 *                   usagePercent:
 *                     type: number
 *                     description: Usage percentage
 *                     example: 25.0
 *               mountPoint:
 *                 type: string
 *                 description: Expected mount point for the device
 *                 example: "/var/mergerfs/media/disk1"
 *               storageStatus:
 *                 type: string
 *                 enum: ["mounted", "unmounted_or_not_found"]
 *                 description: Storage status of the device
 *                 example: "mounted"
 *               isSharedStorage:
 *                 type: boolean
 *                 description: Whether the device shares storage with other devices (e.g., BTRFS RAID)
 *                 example: false
 *               _injected:
 *                 type: boolean
 *                 description: Whether this device was dynamically injected (for BTRFS multi-device pools)
 *                 example: false
 *         parity_devices:
 *           type: array
 *           description: Array of parity devices for SnapRAID
 *           items:
 *             type: object
 *             properties:
 *               slot:
 *                 type: string
 *                 description: Slot number of the device
 *                 example: "1"
 *               id:
 *                 type: string
 *                 description: Device UUID
 *                 example: "a814b889-746a-4298-bc9f-836878bddb4a"
 *               device:
 *                 type: string
 *                 description: Device path
 *                 example: "/dev/sdc"
 *               filesystem:
 *                 type: string
 *                 description: Filesystem type
 *                 example: "xfs"
 *               spindown:
 *                 type: string
 *                 description: Spindown configuration
 *                 example: null
 *               storage:
 *                 type: object
 *                 description: Storage information for the device
 *                 properties:
 *                   totalSpace:
 *                     type: number
 *                     description: Total space in bytes
 *                     example: 2000398934016
 *                   totalSpace_human:
 *                     type: string
 *                     description: Human-readable total space
 *                     example: "1.82 TB"
 *                   usedSpace:
 *                     type: number
 *                     description: Used space in bytes
 *                     example: 500000000000
 *                   usedSpace_human:
 *                     type: string
 *                     description: Human-readable used space
 *                     example: "465.66 GB"
 *                   freeSpace:
 *                     type: number
 *                     description: Free space in bytes
 *                     example: 1500398934016
 *                   freeSpace_human:
 *                     type: string
 *                     description: Human-readable free space
 *                     example: "1.36 TB"
 *                   usagePercent:
 *                     type: number
 *                     description: Usage percentage
 *                     example: 25.0
 *               mountPoint:
 *                 type: string
 *                 description: Expected mount point for the device
 *                 example: "/var/snapraid/media/parity1"
 *               storageStatus:
 *                 type: string
 *                 enum: ["mounted", "unmounted_or_not_found"]
 *                 description: Storage status of the device
 *                 example: "mounted"
 *               isSharedStorage:
 *                 type: boolean
 *                 description: Whether the device shares storage with other devices (e.g., BTRFS RAID)
 *                 example: false

 *         config:
 *           type: object
 *           properties:
 *             policies:
 *               type: object
 *               properties:
 *                 create:
 *                   type: string
 *                   description: Policy for creating new files
 *                   example: "epmfs"
 *                 read:
 *                   type: string
 *                   description: Policy for reading files
 *                   example: "ff"
 *                 search:
 *                   type: string
 *                   description: Policy for searching files
 *                   example: "ff"
 *             minfreespace:
 *               type: string
 *               description: Minimum free space required
 *               example: "20G"
 *             moveonenospc:
 *               type: boolean
 *               description: Move files when no space is available
 *               example: true
 *             category:
 *               type: object
 *               properties:
 *                 create:
 *                   type: string
 *                   description: Category for file creation
 *                   example: "mfs"
 *             sync:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Whether SnapRAID sync is enabled
 *                   example: false
 *                 schedule:
 *                   type: string
 *                   description: Cron schedule for sync
 *                   example: "30 0 1 * *"
 *                 check:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Whether SnapRAID check is enabled
 *                       example: false
 *                     schedule:
 *                       type: string
 *                       description: Cron schedule for check
 *                       example: "0 0 1 1 0"
 *             path_rules:
 *               type: array
 *               description: Rules for specific paths
 *               items:
 *                 type: object
 *                 properties:
 *                   path:
 *                     type: string
 *                     description: Path to apply rule to
 *                     example: "/Filme"
 *                   target_devices:
 *                     type: array
 *                     description: Devices to target for this path
 *                     items:
 *                       type: number
 *                     example: [1, 2]
 *             global_options:
 *               type: array
 *               description: Global MergerFS options
 *               items:
 *                 type: string
 *               example: ["cache.files=off", "dropcacheonclose=true", "category.search=ff"]
 *         status:
 *           type: object
 *           properties:
 *             mounted:
 *               type: boolean
 *               description: Whether the pool is currently mounted
 *               example: false
 *             health:
 *               type: string
 *               description: Health status of the pool
 *               example: "unknown"
 *             totalSpace:
 *               type: number
 *               description: Total space in bytes
 *               example: 0
 *             totalSpace_human:
 *               type: string
 *               description: Human-readable total space
 *               example: "2.73 TB"
 *             usedSpace:
 *               type: number
 *               description: Used space in bytes
 *               example: 0
 *             usedSpace_human:
 *               type: string
 *               description: Human-readable used space
 *               example: "1.2 TB"
 *             freeSpace:
 *               type: number
 *               description: Free space in bytes
 *               example: 0
 *             freeSpace_human:
 *               type: string
 *               description: Human-readable free space
 *               example: "1.53 TB"
 *     CreateSingleDevicePoolRequest:
 *       type: object
 *       required:
 *         - name
 *         - device
 *       properties:
 *         name:
 *           type: string
 *           description: Name for the new pool
 *           example: "data_pool"
 *         device:
 *           type: string
 *           description: Path to the device to use
 *           example: "/dev/sdb"
 *         filesystem:
 *           type: string
 *           enum: ["ext4", "xfs", "btrfs"]
 *           description: Filesystem to format the device with
 *           default: "xfs"
 *           example: "xfs"
 *         format:
 *           type: boolean
 *           description: Whether to force format the device. If false and device has no filesystem, will error. If not provided, only formats if no filesystem exists.
 *           example: false
 *         options:
 *           type: object
 *           properties:
 *             automount:
 *               type: boolean
 *               description: Whether to automatically mount the pool
 *               default: true
 *               example: true
 *     CreateMultiDevicePoolRequest:
 *       type: object
 *       required:
 *         - name
 *         - devices
 *         - raidLevel
 *       properties:
 *         name:
 *           type: string
 *           description: Name for the new pool
 *           example: "data_raid1"
 *         devices:
 *           type: array
 *           description: Array of device paths to use in the pool
 *           items:
 *             type: string
 *             example: "/dev/sdb"
 *           example: ["/dev/sdb", "/dev/sdc"]
 *         raidLevel:
 *           type: string
 *           enum: ["single", "raid0", "raid1", "raid10"]
 *           description: BTRFS RAID level for the pool
 *           example: "raid1"
 *         format:
 *           type: boolean
 *           description: Whether to force format the devices. If false and devices have no filesystem, will error. If not provided, only formats if no filesystem exists.
 *           example: true
 *         options:
 *           type: object
 *           properties:
 *             automount:
 *               type: boolean
 *               description: Whether to automatically mount the pool
 *               default: true
 *               example: true
 */

/**
 * @swagger
 * /pools:
 *   get:
 *     summary: List all storage pools
 *     description: Retrieve all storage pools with status information, with optional filtering by type
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [mergerfs, btrfs, xfs, ext4]
 *         description: Filter pools by type (e.g., 'mergerfs', 'btrfs', 'xfs', 'ext4')
 *         example: mergerfs
 *       - in: query
 *         name: exclude_type
 *         schema:
 *           type: string
 *           enum: [mergerfs, btrfs, xfs, ext4]
 *         description: Exclude pools of specific type (e.g., 'mergerfs')
 *         example: mergerfs
 *     responses:
 *       200:
 *         description: A list of pools with their status (filtered if parameters provided)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Pool'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// List all pools with optional filtering
router.get('/', async (req, res) => {
  try {
    const { type, exclude_type } = req.query;

    // Build filters object
    const filters = {};
    if (type) {
      filters.type = type;
    }
    if (exclude_type) {
      filters.exclude_type = exclude_type;
    }

    const pools = await poolsService.listPools(filters);
    res.json(pools);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}:
 *   get:
 *     summary: Get storage pool by ID
 *     description: Retrieve a specific storage pool by its ID with updated status
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
 *         description: Pool details with status
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
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Get pool by ID
router.get('/:id', async (req, res) => {
  try {
    const pool = await poolsService.getPoolById(req.params.id);
    res.json(pool);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/single:
 *   post:
 *     summary: Create single device pool
 *     description: Create a new storage pool using a single device (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateSingleDevicePoolRequest'
 *     responses:
 *       200:
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
 *                   example: "Pool 'data_pool' created successfully"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Bad request - validation failed
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
// Create single device pool (admin only)
router.post('/single', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      device,
      filesystem = null, // optional, can be null if we accept the existing filesystem
      format,            // optional, controls formatting behavior
      options = {},      // All other options
      automount          // Direct automount parameter for simple access
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!device) {
      return res.status(400).json({ error: 'Device path is required' });
    }

    // make sure device is explicitly passed as string
    const devicePath = String(device || '');

    // Add automount to options if specified
    const poolOptions = {...options};
    if (automount !== undefined) {
      poolOptions.automount = automount;
    }

    // Pass format flag and combined options
    const result = await poolsService.createSingleDevicePool(
      name,
      devicePath,
      filesystem,  // Can be null, will be handled in service
      {...poolOptions, format: format}
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
 *     summary: Create a MergerFS pool with optional SnapRAID parity
 *     description: Creates a new MergerFS pool using multiple devices with optional SnapRAID parity protection.
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
 *                 example: "data_mergerfs"
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of device paths for data devices
 *                 example: ["/dev/sdb", "/dev/sdc"]
 *               filesystem:
 *                 type: string
 *                 enum: ["ext4", "xfs"]
 *                 description: Filesystem to format the devices with
 *                 default: "xfs"
 *                 example: "xfs"
 *               format:
 *                 type: boolean
 *                 description: Whether to force format devices
 *                 default: false
 *                 example: false
 *               policies:
 *                 type: object
 *                 description: MergerFS policies for file operations
 *                 properties:
 *                   create:
 *                     type: string
 *                     description: Policy for creating new files (mfs, epmfs, ff, etc.)
 *                     default: "mfs"
 *                     example: "epmfs"
 *                   read:
 *                     type: string
 *                     description: Policy for reading files
 *                     default: "ff"
 *                     example: "ff"
 *                   search:
 *                     type: string
 *                     description: Policy for searching files
 *                     default: "ff"
 *                     example: "ff"
 *               options:
 *                 type: object
 *                 properties:
 *                   automount:
 *                     type: boolean
 *                     description: Whether to automatically mount the pool
 *                     default: true
 *                     example: true
 *                   comment:
 *                     type: string
 *                     description: Optional comment for the pool
 *                     example: "My MergerFS data pool with SnapRAID protection"
 *                   minfreespace:
 *                     type: string
 *                     description: Minimum free space required on branches
 *                     default: "20G"
 *                     example: "20G"
 *                   moveonenospc:
 *                     type: boolean
 *                     description: Move files when no space is available
 *                     default: true
 *                     example: true
 *                   global_options:
 *                     type: array
 *                     description: Additional global MergerFS options
 *                     items:
 *                       type: string
 *                     example: ["cache.files=off", "dropcacheonclose=true"]
 *                   mergerfsOptions:
 *                     type: string
 *                     description: Custom MergerFS mount options (overrides policies if set)
 *                     example: "defaults,allow_other,use_ino,cache.files=partial,dropcacheonclose=true,category.create=epmfs"
 *                   snapraid:
 *                     type: object
 *                     description: Optional SnapRAID configuration
 *                     properties:
 *                       device:
 *                         type: string
 *                         description: Device to use as SnapRAID parity device
 *                         example: "/dev/sdd"
 *     responses:
 *       201:
 *         description: MergerFS pool created successfully
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
 *                   example: "Successfully created MergerFS pool 'data_mergerfs' with SnapRAID parity"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters
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
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Create MergerFS pool with optional SnapRAID parity (admin only)
router.post('/mergerfs', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      devices,
      filesystem = 'xfs',
      format,
      policies = {},
      options = {}
    } = req.body;

    // Validate required fields
    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required for a MergerFS pool' });
    }

    // Create the pool
    const result = await poolsService.createMergerFSPool(
      name,
      devices,
      filesystem,
      {
        ...options,
        policies: policies,
        format: format
      }
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
 *     summary: Create a multi-device BTRFS pool with RAID support
 *     description: Creates a new storage pool using multiple devices with BTRFS RAID support (raid0, raid1, raid10 or single).
 *       Single-device pools (with filesystem type as pool type) can later be upgraded to multi-device using the add devices endpoint.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateMultiDevicePoolRequest'
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
 *                   example: Successfully created multi-device BTRFS pool "data" with RAID1 mirroring
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Bad request
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
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Create multi-device pool with RAID support (admin only)
router.post('/multi', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      devices,
      raid_level = 'raid1',  // default is raid1 (Mirroring)
      format,
      options = {},
      automount
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!Array.isArray(devices) || devices.length < 2) {
      return res.status(400).json({ error: 'At least two devices are required for a multi-device pool' });
    }

    // make sure all devices are passed as strings
    const devicePaths = devices.map(dev => String(dev || ''));

    // Add automount and format to options
    const poolOptions = {...options};
    if (automount !== undefined) {
      poolOptions.automount = automount;
    }
    if (format !== undefined) {
      poolOptions.format = format;
    }

    // RAID level can be 'raid0' (Striping), 'raid1' (Mirroring) or 'raid10' (Combination)
    const result = await poolsService.createMultiDevicePool(
      name,
      devicePaths,
      raid_level,
      poolOptions
    );

    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
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
 *                   example: "Successfully added 2 device(s) to pool 'data_pool'"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters or pool type not supported
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
// Add devices to an existing pool (admin only)
router.post('/:id/devices/add', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, format = false } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    const result = await poolsService.addDevicesToPool(req.params.id, devices, { format });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/raid-level:
 *   put:
 *     summary: Change RAID level of a BTRFS pool
 *     description: "Changes the RAID level of an existing BTRFS pool. Supported levels are 'raid0' (striping), 'raid1' (mirroring), 'raid10' (striped mirrors), and 'single' (data on a single device). Converting from RAID 0 to RAID 1 requires at least 50% free space. Converting to 'single' keeps all devices physically in the pool but uses only the first device for data. RAID 10 requires at least 4 devices. Note that converting between certain RAID levels can be time-consuming operations depending on pool size."
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
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
 *               raid_level:
 *                 type: string
 *                 enum: [single, raid0, raid1, raid10]
 *                 example: raid1
 *     responses:
 *       200:
 *         description: RAID level changed successfully
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
 *                   example: Successfully changed pool data to RAID level raid1
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Change RAID level of a BTRFS pool (admin only)
router.put('/:id/raid-level', checkRole(['admin']), async (req, res) => {
  try {
    const { id: poolId } = req.params;
    const { raid_level } = req.body;

    if (!raid_level) {
      return res.status(400).json({ error: 'RAID level is required' });
    }

    const result = await poolsService.changePoolRaidLevel(poolId, raid_level);
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
  }
});


// Format device (admin only)
router.post('/format-device', checkRole(['admin']), async (req, res) => {
  try {
    const { device, filesystem = 'xfs' } = req.body;

    if (!device) {
      return res.status(400).json({ error: 'Device path is required' });
    }

    const result = await poolsService.formatDevice(device, filesystem);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Check device filesystem (admin only)
router.get('/device-filesystem/:device', checkRole(['admin']), async (req, res) => {
  try {
    const device = req.params.device;
    if (!device) {
      return res.status(400).json({ error: 'Device path is required' });
    }

    // URL decode the device parameter in case it contains slashes
    const decodedDevice = decodeURIComponent(device);
    const result = await poolsService.checkDeviceFilesystem(decodedDevice);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/mount:
 *   post:
 *     summary: Mount a storage pool
 *     description: Mount a storage pool by its ID. Can optionally format if needed (admin only)
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
 *               format:
 *                 type: boolean
 *                 description: Whether to format the device if needed. If false and device has no filesystem, will error. If not provided, only formats if no filesystem exists.
 *                 example: false
 *               mountOptions:
 *                 type: string
 *                 description: Additional mount options
 *                 example: "defaults,noatime"
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
 *                 mountPoint:
 *                   type: string
 *                   example: "/mnt/data_pool"
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
// Mount pool by ID (admin only)
router.post('/:id/mount', checkRole(['admin']), async (req, res) => {
  try {
    const { format, mountOptions } = req.body;
    const result = await poolsService.mountPoolById(req.params.id, {
      format,
      mountOptions
    });
    res.json(result);
  } catch (error) {
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
 *                 example: ["/dev/sdc"]
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
 *                   example: "Successfully removed 1 device from pool 'data_mergerfs'"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters
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
 *         description: Pool not found or device not in pool
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

    const result = await poolsService.removeDevicesFromPool(req.params.id, devices, { unmount });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/devices/replace:
 *   post:
 *     summary: Replace a device in a pool
 *     description: Replace a device in an existing pool (admin only). For BTRFS pools, uses native BTRFS replace functionality. For MergerFS pools, removes old device and adds new device.
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
 *               - oldDevice
 *               - newDevice
 *             properties:
 *               oldDevice:
 *                 type: string
 *                 description: Device path to replace
 *                 example: "/dev/sdc"
 *               newDevice:
 *                 type: string
 *                 description: New device path
 *                 example: "/dev/sdd"
 *               format:
 *                 type: boolean
 *                 description: Whether to format the new device (MergerFS only)
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Device replaced successfully
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
 *                   example: "Successfully replaced device /dev/sdc with /dev/sdd in pool 'data_pool'"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters
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
 *         description: Pool not found or device not in pool
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

// Replace a device in an existing pool (admin only)
router.post('/:id/devices/replace', checkRole(['admin']), async (req, res) => {
  try {
    const { oldDevice, newDevice, format = false } = req.body;

    if (!oldDevice || !newDevice) {
      return res.status(400).json({ error: 'Both oldDevice and newDevice are required' });
    }

    if (oldDevice === newDevice) {
      return res.status(400).json({ error: 'Old and new device cannot be the same' });
    }

    const result = await poolsService.replaceDeviceInPool(req.params.id, oldDevice, newDevice, { format });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/unmount:
 *   post:
 *     summary: Unmount a storage pool
 *     description: Unmount a storage pool by its ID (admin only)
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
 *                 description: Force unmount even if device is busy
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
// Unmount pool by ID (admin only)
router.post('/:id/unmount', checkRole(['admin']), async (req, res) => {
  try {
    const { force = false, removeDirectory = false } = req.body;
    const result = await poolsService.unmountPoolById(req.params.id, {
      force,
      removeDirectory
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}:
 *   delete:
 *     summary: Remove a storage pool
 *     description: Remove a storage pool by its ID. This unmounts the pool and removes its mount directory, but does not erase any data (admin only).
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
 *                 description: Force unmount if needed
 *                 default: false
 *                 example: false
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
 *                   example: "Pool 'data_pool' (ID: 1723456984525) removed successfully"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
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
// Remove pool by ID (admin only)
router.delete('/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await poolsService.removePoolById(req.params.id, { force });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
// Toggle automount by ID (admin only)
router.post('/:id/automount', checkRole(['admin']), async (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'enabled parameter must be a boolean'
      });
    }

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
 *                 description: New comment for the pool
 *                 example: "Updated media storage pool with additional capacity"
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
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Comment updated for pool 'media' (ID: 1746318722394)"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters
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
// Update pool comment
router.patch('/:id/comment', checkRole(['admin']), async (req, res) => {
  try {
    const { comment } = req.body;
    const result = await poolsService.updatePoolComment(req.params.id, comment);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
 *                   example: "Successfully added 2 parity device(s) to pool 'data_mergerfs'"
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

// Add parity devices to an existing MergerFS pool (admin only)
router.post('/:id/parity/add', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, format = false } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one parity device is required' });
    }

    const result = await poolsService.addParityDevicesToPool(req.params.id, devices, { format });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
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

// Remove parity devices from an existing MergerFS pool (admin only)
router.post('/:id/parity/remove', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, unmount = true } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one parity device is required' });
    }

    const result = await poolsService.removeParityDevicesFromPool(req.params.id, devices, { unmount });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/parity/replace:
 *   post:
 *     summary: Replace a parity device in a MergerFS pool
 *     description: Replace an existing parity device with a new one in a MergerFS pool (admin only). The new device will be mounted at the same mount point and the SnapRAID configuration will be updated.
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
 *               - oldDevice
 *               - newDevice
 *             properties:
 *               oldDevice:
 *                 type: string
 *                 description: Parity device path to replace
 *                 example: "/dev/sdd"
 *               newDevice:
 *                 type: string
 *                 description: New parity device path
 *                 example: "/dev/sde"
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the new device
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Parity device replaced successfully
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
 *                   example: "Successfully replaced parity device /dev/sdd with /dev/sde in pool 'data_mergerfs'"
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
 *         description: Pool not found or parity device not in pool
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

// Replace a parity device in an existing MergerFS pool (admin only)
router.post('/:id/parity/replace', checkRole(['admin']), async (req, res) => {
  try {
    const { oldDevice, newDevice, format = false } = req.body;

    if (!oldDevice || !newDevice) {
      return res.status(400).json({ error: 'Both oldDevice and newDevice are required' });
    }

    if (oldDevice === newDevice) {
      return res.status(400).json({ error: 'Old and new device cannot be the same' });
    }

    const result = await poolsService.replaceParityDeviceInPool(req.params.id, oldDevice, newDevice, { format });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/disk/{uuid}/power:
 *   get:
 *     summary: Get disk power status by UUID
 *     description: Get power status and info for a specific disk in a pool using its UUID
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
 *       - name: uuid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Disk UUID
 *     responses:
 *       200:
 *         description: Disk power status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 poolId:
 *                   type: string
 *                 poolName:
 *                   type: string
 *                 diskUuid:
 *                   type: string
 *                 device:
 *                   type: string
 *                 slot:
 *                   type: string
 *                 diskType:
 *                   type: string
 *                   enum: [data, parity]
 *                 powerStatus:
 *                   type: string
 *                   enum: [active, standby, sleeping, unknown]
 *       404:
 *         description: Pool or disk not found
 *       500:
 *         description: Server error
 */
router.get('/:id/disk/:uuid/power', async (req, res) => {
  try {
    const result = await poolsService.getDiskStatus(req.params.id, req.params.uuid);
    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/disk/{uuid}/wake:
 *   post:
 *     summary: Wake up a single disk in pool
 *     description: Wake up a specific disk in a pool using its UUID (admin only)
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
 *       - name: uuid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Disk UUID
 *     responses:
 *       200:
 *         description: Disk wake operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 poolId:
 *                   type: string
 *                 poolName:
 *                   type: string
 *                 diskUuid:
 *                   type: string
 *                 device:
 *                   type: string
 *                 slot:
 *                   type: string
 *                 action:
 *                   type: string
 *                 message:
 *                   type: string
 *       404:
 *         description: Pool or disk not found
 *       500:
 *         description: Server error
 */
router.post('/:id/disk/:uuid/wake', checkRole(['admin']), async (req, res) => {
  try {
    const result = await poolsService.controlDisk(req.params.id, req.params.uuid, 'wake');
    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/disk/{uuid}/sleep:
 *   post:
 *     summary: Put a single disk in pool to sleep
 *     description: Put a specific disk in a pool to standby/sleep using its UUID (admin only)
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
 *       - name: uuid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Disk UUID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [standby, sleep]
 *                 default: standby
 *                 description: Sleep mode
 *     responses:
 *       200:
 *         description: Disk sleep operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 poolId:
 *                   type: string
 *                 poolName:
 *                   type: string
 *                 diskUuid:
 *                   type: string
 *                 device:
 *                   type: string
 *                 slot:
 *                   type: string
 *                 action:
 *                   type: string
 *                 message:
 *                   type: string
 *       404:
 *         description: Pool or disk not found
 *       500:
 *         description: Server error
 */
router.post('/:id/disk/:uuid/sleep', checkRole(['admin']), async (req, res) => {
  try {
    const { mode = 'standby' } = req.body || {};
    const result = await poolsService.controlDisk(req.params.id, req.params.uuid, mode);
    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/wake:
 *   post:
 *     summary: Wake up entire pool
 *     description: Wake up all disks in a pool (admin only)
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
 *     responses:
 *       200:
 *         description: Pool wake operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 poolId:
 *                   type: string
 *                 poolName:
 *                   type: string
 *                 action:
 *                   type: string
 *                 totalDisks:
 *                   type: number
 *                 successCount:
 *                   type: number
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                 message:
 *                   type: string
 *       404:
 *         description: Pool not found
 *       500:
 *         description: Server error
 */
router.post('/:id/wake', checkRole(['admin']), async (req, res) => {
  try {
    const result = await poolsService.controlPool(req.params.id, 'wake');
    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/sleep:
 *   post:
 *     summary: Put entire pool to sleep
 *     description: Put all disks in a pool to standby/sleep (admin only)
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
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [standby, sleep]
 *                 default: standby
 *                 description: Sleep mode for all disks
 *     responses:
 *       200:
 *         description: Pool sleep operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 poolId:
 *                   type: string
 *                 poolName:
 *                   type: string
 *                 action:
 *                   type: string
 *                 totalDisks:
 *                   type: number
 *                 successCount:
 *                   type: number
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                 message:
 *                   type: string
 *       404:
 *         description: Pool not found
 *       500:
 *         description: Server error
 */
router.post('/:id/sleep', checkRole(['admin']), async (req, res) => {
  try {
    const { mode = 'standby' } = req.body || {};
    const result = await poolsService.controlPool(req.params.id, mode);
    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/power:
 *   get:
 *     summary: Get power status for all disks in pool
 *     description: Get power status and info for all disks in a pool
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
 *     responses:
 *       200:
 *         description: Pool disks power status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 poolId:
 *                   type: string
 *                 poolName:
 *                   type: string
 *                 totalDisks:
 *                   type: number
 *                 successCount:
 *                   type: number
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       poolId:
 *                         type: string
 *                       poolName:
 *                         type: string
 *                       diskUuid:
 *                         type: string
 *                       device:
 *                         type: string
 *                       slot:
 *                         type: string
 *                       diskType:
 *                         type: string
 *                         enum: [data, parity]
 *                       powerStatus:
 *                         type: string
 *                         enum: [active, standby, sleeping, unknown, error]
 *                       message:
 *                         type: string
 *                 message:
 *                   type: string
 *       404:
 *         description: Pool not found
 *       500:
 *         description: Server error
 */
router.get('/:id/power', async (req, res) => {
  try {
    const result = await poolsService.getPoolDisksPowerStatus(req.params.id);
    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
