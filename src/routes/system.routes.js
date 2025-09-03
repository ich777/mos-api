const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth.middleware');
const systemService = require('../services/system.service');

/**
 * @swagger
 * tags:
 *   name: System
 *   description: System Information and Management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     MemoryUsage:
 *       type: object
 *       properties:
 *         used:
 *           type: integer
 *           description: Used memory (dirty)
 *           example: 8589934592
 *         actuallyUsed:
 *           type: integer
 *           description: Actually used memory (clean)
 *           example: 4294967296
 *         dirtyCaches:
 *           type: integer
 *           description: Memory used by dirty caches
 *           example: 4294967296
 *     MemoryInfo:
 *       type: object
 *       properties:
 *         total:
 *           type: integer
 *           description: Total memory in bytes
 *           example: 17179869184
 *         free:
 *           type: integer
 *           description: Available memory in bytes
 *           example: 8589934592
 *         used:
 *           type: integer
 *           description: Actually used memory (without dirty caches)
 *           example: 4294967296
 *         dirty:
 *           type: object
 *           properties:
 *             free:
 *               type: integer
 *               description: Free memory (kernel perspective)
 *               example: 2147483648
 *             used:
 *               type: integer
 *               description: Used memory (kernel perspective)
 *               example: 8589934592
 *             dirtyCaches:
 *               type: integer
 *               description: Memory used by dirty caches
 *               example: 4294967296
 *         percentage:
 *           type: object
 *           properties:
 *             used:
 *               type: integer
 *               description: Used memory percentage (dirty)
 *               example: 50
 *             actuallyUsed:
 *               type: integer
 *               description: Actually used memory percentage (clean)
 *               example: 25
 *             dirtyCaches:
 *               type: integer
 *               description: Dirty caches percentage
 *               example: 25
 *     BasicSystemInfo:
 *       type: object
 *       properties:
 *         os:
 *           type: object
 *           properties:
 *             platform:
 *               type: string
 *               example: "linux"
 *             distro:
 *               type: string
 *               example: "Ubuntu"
 *             release:
 *               type: string
 *               example: "22.04.3 LTS"
 *             kernel:
 *               type: string
 *               example: "6.14.11-mos"
 *         cpu:
 *           type: object
 *           properties:
 *             manufacturer:
 *               type: string
 *               example: "Intel"
 *             brand:
 *               type: string
 *               example: "Intel(R) Core(TM) i7-12700K"
 *             cores:
 *               type: integer
 *               example: 12
 *             physicalCores:
 *               type: integer
 *               example: 8
 *         memory:
 *           $ref: '#/components/schemas/MemoryInfo'
 *     DetailedMemoryInfo:
 *       type: object
 *       properties:
 *         memory:
 *           type: object
 *           properties:
 *             total:
 *               type: integer
 *               description: Total memory in bytes
 *               example: 17179869184
 *             free:
 *               type: integer
 *               description: Free memory in bytes
 *               example: 2147483648
 *             available:
 *               type: integer
 *               description: Available memory in bytes
 *               example: 8589934592
 *             used:
 *               $ref: '#/components/schemas/MemoryUsage'
 *             swap:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                   description: Total swap in bytes
 *                   example: 2147483648
 *                 used:
 *                   type: integer
 *                   description: Used swap in bytes
 *                   example: 0
 *                 free:
 *                   type: integer
 *                   description: Free swap in bytes
 *                   example: 2147483648
 *             percentage:
 *               type: object
 *               properties:
 *                 used:
 *                   type: integer
 *                   description: Used memory percentage (dirty)
 *                   example: 50
 *                 actuallyUsed:
 *                   type: integer
 *                   description: Actually used memory percentage (clean)
 *                   example: 25
 *                 dirtyCaches:
 *                   type: integer
 *                   description: Dirty caches percentage
 *                   example: 25
 *     CoreLoad:
 *       type: object
 *       properties:
 *         number:
 *           type: integer
 *           description: Core number
 *           example: 1
 *         load:
 *           type: object
 *           properties:
 *             total:
 *               type: number
 *               description: Core load percentage
 *               example: 45.67
 *         temperature:
 *           type: number
 *           nullable: true
 *           description: Core temperature in Celsius
 *           example: 65.5
 *     SystemLoad:
 *       type: object
 *       properties:
 *         cpu:
 *           type: object
 *           properties:
 *             load:
 *               type: number
 *               description: Overall CPU load percentage
 *               example: 42.35
 *             cores:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/CoreLoad'
 *         temperature:
 *           type: object
 *           properties:
 *             main:
 *               type: number
 *               description: Main CPU temperature
 *               example: 68.2
 *             max:
 *               type: number
 *               description: Maximum core temperature
 *               example: 72.1
 *             min:
 *               type: number
 *               description: Minimum core temperature
 *               example: 61.3
 *             cores:
 *               type: array
 *               items:
 *                 type: number
 *               description: Temperature of each core
 *               example: [65.5, 67.2, 72.1, 61.3]
 *     Service:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Service name
 *           example: "nginx"
 *         running:
 *           type: boolean
 *           description: Service running status
 *           example: true
 *         startmode:
 *           type: string
 *           description: Service start mode
 *           example: "automatic"
 *         pids:
 *           type: array
 *           items:
 *             type: integer
 *           description: Process IDs
 *           example: [1234, 1235]
 *         cpu:
 *           type: number
 *           description: CPU usage percentage
 *           example: 2.5
 *         mem:
 *           type: number
 *           description: Memory usage percentage
 *           example: 1.8
 *     OperationResult:
 *       type: object
 *       properties:
 *         message:
 *           type: string
 *           description: Operation result message
 *           example: "System update completed successfully"
 */

/**
 * @swagger
 * /system/info:
 *   get:
 *     summary: Get basic system information
 *     description: Retrieve basic system information including OS and CPU details (available to all authenticated users)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Basic system information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BasicSystemInfo'
 *             example:
 *               os:
 *                 platform: "linux"
 *                 distro: "Ubuntu"
 *                 release: "22.04.3 LTS"
 *                 kernel: "6.14.11-mos"
 *               cpu:
 *                 manufacturer: "Intel"
 *                 brand: "Intel(R) Core(TM) i7-12700K"
 *                 cores: 12
 *                 physicalCores: 8

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
 *             example:
 *               error: "Error getting basic system info: systeminformation module failed"
 */

// Basic system information (available to all authenticated users)
router.get('/info', async (req, res) => {
  try {
    const info = await systemService.getBasicInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/memory:
 *   get:
 *     summary: Get detailed memory information
 *     description: Retrieve detailed memory information with separate dirty cache tracking (available to all authenticated users)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Detailed memory information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DetailedMemoryInfo'
 *             example:
 *               memory:
 *                 total: 17179869184
 *                 free: 2147483648
 *                 available: 8589934592
 *                 used:
 *                   total: 8589934592
 *                   actuallyUsed: 4294967296
 *                   dirtyCaches: 4294967296
 *                 swap:
 *                   total: 2147483648
 *                   used: 0
 *                   free: 2147483648
 *                 percentage:
 *                   used: 50
 *                   actuallyUsed: 25
 *                   dirtyCaches: 25
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
 *             example:
 *               error: "Error getting detailed memory info: systeminformation module failed"
 */

// Detailed memory information with separate dirty cache tracking
router.get('/memory', async (req, res) => {
  try {
    const memoryInfo = await systemService.getDetailedMemory();
    res.json(memoryInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/detailed:
 *   get:
 *     summary: Get detailed system information
 *     description: Retrieve comprehensive system information including OS, CPU, memory, disks, network and processes (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Detailed system information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 os:
 *                   type: object
 *                   description: Complete OS information
 *                 cpu:
 *                   type: object
 *                   description: Complete CPU information
 *                 memory:
 *                   type: object
 *                   description: Complete memory information with detailed stats
 *                 disks:
 *                   type: array
 *                   description: Filesystem information
 *                   items:
 *                     type: object
 *                 network:
 *                   type: array
 *                   description: Network interfaces information
 *                   items:
 *                     type: object
 *                 processes:
 *                   type: object
 *                   description: Process information
 *             example:
 *               os:
 *                 platform: "linux"
 *                 distro: "Ubuntu 22.04.3 LTS"
 *                 hostname: "server1"
 *                 kernel: "6.14.11-mos"
 *               cpu:
 *                 manufacturer: "Intel"
 *                 brand: "Intel(R) Core(TM) i7-12700K"
 *                 cores: 12
 *                 physicalCores: 8
 *                 speed: 3.6
 *               memory:
 *                 total: 17179869184
 *                 used: 8589934592
 *                 actuallyUsed: 4294967296
 *                 percentage:
 *                   used: 50
 *                   actuallyUsed: 25
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
 *               error: "Error getting detailed system info: systeminformation module failed"
 */

// Detailed system information (admin only)
router.get('/detailed', checkRole(['admin']), async (req, res) => {
  try {
    const detailedInfo = await systemService.getDetailedInfo();
    res.json(detailedInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/load:
 *   get:
 *     summary: Get system load, temperature, memory and network utilization
 *     description: Retrieve current system load, temperature information including per-core metrics, memory usage, and network utilization for all interfaces (available to all authenticated users)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System load, temperature, memory and network information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cpu:
 *                   type: object
 *                   properties:
 *                     load:
 *                       type: number
 *                       description: Overall CPU load percentage
 *                       example: 42.35
 *                     cores:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/CoreLoad'
 *                 temperature:
 *                   type: object
 *                   properties:
 *                     main:
 *                       type: number
 *                       description: Main CPU temperature in Celsius
 *                       example: 68.2
 *                     max:
 *                       type: number
 *                       description: Maximum core temperature
 *                       example: 72.1
 *                     min:
 *                       type: number
 *                       description: Minimum core temperature
 *                       example: 61.3
 *                     cores:
 *                       type: array
 *                       items:
 *                         type: number
 *                       description: Per-core temperatures
 *                       example: [65.5, 67.2, 72.1, 61.3, 69.8, 63.4, 70.1, 64.9]
 *                 memory:
 *                   $ref: '#/components/schemas/MemoryInfo'
 *                 network:
 *                   type: object
 *                   properties:
 *                     interfaces:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           interface:
 *                             type: string
 *                             description: Interface name
 *                             example: "eth0"
 *                           type:
 *                             type: string
 *                             description: Interface type
 *                             example: "wired"
 *                           state:
 *                             type: string
 *                             description: Interface state
 *                             example: "up"
 *                           speed:
 *                             type: integer
 *                             description: Interface speed in Mbps
 *                             example: 1000
 *                           ip4:
 *                             type: string
 *                             description: IPv4 address
 *                             example: "192.168.1.100"
 *                           ip6:
 *                             type: string
 *                             description: IPv6 address
 *                             example: "fe80::1"
 *                           mac:
 *                             type: string
 *                             description: MAC address
 *                             example: "00:11:22:33:44:55"
 *                           statistics:
 *                             type: object
 *                             properties:
 *                               rx:
 *                                 type: object
 *                                 properties:
 *                                   bytes:
 *                                     type: integer
 *                                     description: Received bytes
 *                                     example: 1073741824
 *                                   bytes_human:
 *                                     type: string
 *                                     description: Received bytes in human readable format
 *                                     example: "1.00 GB"
 *                                   packets:
 *                                     type: integer
 *                                     description: Received packets
 *                                     example: 1048576
 *                                   errors:
 *                                     type: integer
 *                                     description: Receive errors
 *                                     example: 0
 *                                   dropped:
 *                                     type: integer
 *                                     description: Dropped received packets
 *                                     example: 0
 *                                   speed_bps:
 *                                     type: integer
 *                                     description: Current receive speed in bytes per second
 *                                     example: 1048576
 *                                   speed_human:
 *                                     type: string
 *                                     description: Current receive speed in human readable format
 *                                     example: "1.00 MB/s"
 *                               tx:
 *                                 type: object
 *                                 properties:
 *                                   bytes:
 *                                     type: integer
 *                                     description: Transmitted bytes
 *                                     example: 536870912
 *                                   bytes_human:
 *                                     type: string
 *                                     description: Transmitted bytes in human readable format
 *                                     example: "512.00 MB"
 *                                   packets:
 *                                     type: integer
 *                                     description: Transmitted packets
 *                                     example: 524288
 *                                   errors:
 *                                     type: integer
 *                                     description: Transmit errors
 *                                     example: 0
 *                                   dropped:
 *                                     type: integer
 *                                     description: Dropped transmitted packets
 *                                     example: 0
 *                                   speed_bps:
 *                                     type: integer
 *                                     description: Current transmit speed in bytes per second
 *                                     example: 524288
 *                                   speed_human:
 *                                     type: string
 *                                     description: Current transmit speed in human readable format
 *                                     example: "512.00 KB/s"
 *                               total:
 *                                 type: object
 *                                 properties:
 *                                   bytes:
 *                                     type: integer
 *                                     description: Total bytes (rx + tx)
 *                                     example: 1610612736
 *                                   bytes_human:
 *                                     type: string
 *                                     description: Total bytes in human readable format
 *                                     example: "1.50 GB"
 *                                   packets:
 *                                     type: integer
 *                                     description: Total packets (rx + tx)
 *                                     example: 1572864
 *                                   speed_bps:
 *                                     type: integer
 *                                     description: Total current speed in bytes per second
 *                                     example: 1572864
 *                                   speed_human:
 *                                     type: string
 *                                     description: Total current speed in human readable format
 *                                     example: "1.50 MB/s"
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_interfaces:
 *                           type: integer
 *                           description: Total number of interfaces
 *                           example: 3
 *                         active_interfaces:
 *                           type: integer
 *                           description: Number of active (up) interfaces
 *                           example: 2
 *                         totals:
 *                           type: object
 *                           properties:
 *                             rx:
 *                               type: object
 *                               properties:
 *                                 bytes:
 *                                   type: integer
 *                                   description: Total received bytes across all interfaces
 *                                   example: 2147483648
 *                                 bytes_human:
 *                                   type: string
 *                                   description: Total received bytes in human readable format
 *                                   example: "2.00 GB"
 *                                 packets:
 *                                   type: integer
 *                                   description: Total received packets
 *                                   example: 2097152
 *                                 speed_bps:
 *                                   type: integer
 *                                   description: Total current receive speed
 *                                   example: 2097152
 *                                 speed_human:
 *                                   type: string
 *                                   description: Total current receive speed in human readable format
 *                                   example: "2.00 MB/s"
 *                             tx:
 *                               type: object
 *                               properties:
 *                                 bytes:
 *                                   type: integer
 *                                   description: Total transmitted bytes across all interfaces
 *                                   example: 1073741824
 *                                 bytes_human:
 *                                   type: string
 *                                   description: Total transmitted bytes in human readable format
 *                                   example: "1.00 GB"
 *                                 packets:
 *                                   type: integer
 *                                   description: Total transmitted packets
 *                                   example: 1048576
 *                                 speed_bps:
 *                                   type: integer
 *                                   description: Total current transmit speed
 *                                   example: 1048576
 *                                 speed_human:
 *                                   type: string
 *                                   description: Total current transmit speed in human readable format
 *                                   example: "1.00 MB/s"
 *                             combined:
 *                               type: object
 *                               properties:
 *                                 bytes:
 *                                   type: integer
 *                                   description: Total combined bytes (rx + tx) across all interfaces
 *                                   example: 3221225472
 *                                 bytes_human:
 *                                   type: string
 *                                   description: Total combined bytes in human readable format
 *                                   example: "3.00 GB"
 *                                 packets:
 *                                   type: integer
 *                                   description: Total combined packets
 *                                   example: 3145728
 *                                 speed_bps:
 *                                   type: integer
 *                                   description: Total combined current speed
 *                                   example: 3145728
 *                                 speed_human:
 *                                   type: string
 *                                   description: Total combined current speed in human readable format
 *                                   example: "3.00 MB/s"
 *             example:
 *               cpu:
 *                 load: 42.35
 *                 cores:
 *                   - number: 1
 *                     load:
 *                       total: 45.67
 *                     temperature: 65.5
 *                   - number: 2
 *                     load:
 *                       total: 38.92
 *                     temperature: 67.2
 *               temperature:
 *                 main: 68.2
 *                 max: 72.1
 *                 min: 61.3
 *                 cores: [65.5, 67.2, 72.1, 61.3, 69.8, 63.4, 70.1, 64.9]
 *               memory:
 *                 total: 17179869184
 *                 total_human: "16.00 GiB"
 *                 free: 8589934592
 *                 free_human: "8.00 GiB"
 *                 used: 4294967296
 *                 used_human: "4.00 GiB"
 *                 dirty:
 *                   free: 2147483648
 *                   used: 8589934592
 *                   dirtyCaches: 4294967296
 *                 percentage:
 *                   used: 50
 *                   actuallyUsed: 25
 *                   dirtyCaches: 25
 *               network:
 *                 interfaces:
 *                   - interface: "eth0"
 *                     type: "wired"
 *                     state: "up"
 *                     speed: 1000
 *                     ip4: "192.168.1.100"
 *                     mac: "00:11:22:33:44:55"
 *                     statistics:
 *                       rx:
 *                         bytes: 1073741824
 *                         bytes_human: "1.00 GiB"
 *                         packets: 1048576
 *                         speed_bps: 1048576
 *                         speed_human: "1.00 MiB/s"
 *                       tx:
 *                         bytes: 536870912
 *                         bytes_human: "512.00 MiB"
 *                         packets: 524288
 *                         speed_bps: 524288
 *                         speed_human: "512.00 KiB/s"
 *                       total:
 *                         bytes: 1610612736
 *                         bytes_human: "1.50 GiB"
 *                         packets: 1572864
 *                         speed_bps: 1572864
 *                         speed_human: "1.50 MiB/s"
 *                 summary:
 *                   total_interfaces: 2
 *                   active_interfaces: 1
 *                   totals:
 *                     rx:
 *                       bytes: 1073741824
 *                       bytes_human: "1.00 GiB"
 *                       packets: 1048576
 *                       speed_bps: 1048576
 *                       speed_human: "1.00 MiB/s"
 *                     tx:
 *                       bytes: 536870912
 *                       bytes_human: "512.00 MiB"
 *                       packets: 524288
 *                       speed_bps: 524288
 *                       speed_human: "512.00 KiB/s"
 *                     combined:
 *                       bytes: 1610612736
 *                       bytes_human: "1.50 GiB"
 *                       packets: 1572864
 *                       speed_bps: 1572864
 *                       speed_human: "1.50 MiB/s"
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
 *             example:
 *               error: "Error getting system load: systeminformation module failed"
 */

// System load (available to all authenticated users)
router.get('/load', async (req, res) => {
  try {
    const loadInfo = await systemService.getSystemLoad();
    res.json(loadInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/services:
 *   get:
 *     summary: Get services status
 *     description: Retrieve status information for all system services (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Services status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Service name
 *                     example: "nginx"
 *                   running:
 *                     type: boolean
 *                     description: Service running status
 *                     example: true
 *                   startmode:
 *                     type: string
 *                     description: Service start mode
 *                     example: "automatic"
 *                   pids:
 *                     type: array
 *                     items:
 *                       type: integer
 *                     description: Process IDs
 *                     example: [1234, 1235]
 *                   cpu:
 *                     type: number
 *                     description: CPU usage percentage
 *                     example: 2.5
 *                   mem:
 *                     type: number
 *                     description: Memory usage percentage
 *                     example: 1.8
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
 *               error: "Error getting services status: systeminformation module failed"
 */

// Services status (admin only)
router.get('/services', checkRole(['admin']), async (req, res) => {
  try {
    const services = await systemService.getServicesStatus();
    res.json(services);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



/**
 * @swagger
 * /system/power/reboot:
 *   post:
 *     summary: Reboot system
 *     description: Perform a system reboot (admin only). The system will shutdown and restart.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reboot initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               message: "System reboot initiated"
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
 *         description: Reboot failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               reboot_failed:
 *                 summary: Reboot command failed
 *                 value:
 *                   error: "System reboot failed: insufficient privileges"
 *               system_busy:
 *                 summary: System too busy to reboot
 *                 value:
 *                   error: "System reboot failed: critical processes running"
 */

// Power Management Endpoints (admin only)
router.post('/power/reboot', checkRole(['admin']), async (req, res) => {
  try {
    const message = await systemService.rebootSystem();
    res.json({ message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/power/shutdown:
 *   post:
 *     summary: Shutdown system
 *     description: Perform a graceful system shutdown (admin only). The system will halt after shutting down all services.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Shutdown initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               message: "System shutdown initiated"
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
 *         description: Shutdown failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               shutdown_failed:
 *                 summary: Shutdown command failed
 *                 value:
 *                   error: "System shutdown failed: insufficient privileges"
 *               system_busy:
 *                 summary: System too busy to shutdown
 *                 value:
 *                   error: "System shutdown failed: critical processes running"
 */

router.post('/power/shutdown', checkRole(['admin']), async (req, res) => {
  try {
    const message = await systemService.shutdownSystem();
    res.json({ message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router; 