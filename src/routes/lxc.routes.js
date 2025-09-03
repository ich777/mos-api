const express = require('express');
const router = express.Router();
const lxcService = require('../services/lxc.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: LXC
 *   description: LXC Container Management (Admin only)
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     Container:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Container Name (1-64 characters, only letters, numbers, hyphens, underscores)
 *         state:
 *           type: string
 *           enum: [running, stopped, frozen]
 *           description: Container Status
 *         autostart:
 *           type: boolean
 *           description: Autostart enabled
 *         ipv4:
 *           type: array
 *           items:
 *             type: string
 *           description: IPv4 Addresses
 *         ipv6:
 *           type: array
 *           items:
 *             type: string
 *           description: IPv6 Addresses
 *         unprivileged:
 *           type: boolean
 *           description: Unprivileged container
 *         distribution:
 *           type: string
 *           nullable: true
 *           description: Linux distribution (e.g., ubuntu, debian)
 *         description:
 *           type: string
 *           nullable: true
 *           description: Container description (allowed characters: letters, numbers, spaces, . - _ : ? ! &)
 *         custom_icon:
 *           type: boolean
 *           description: Whether a custom icon exists for this container
 *     ContainerCreateRequest:
 *       type: object
 *       required:
 *         - name
 *         - distribution
 *         - release
 *       properties:
 *         name:
 *           type: string
 *           description: Container name (1-64 characters, only letters, numbers, hyphens, underscores; must not start/end with - or _)
 *           example: "my-ubuntu-container"
 *         distribution:
 *           type: string
 *           description: Linux distribution
 *           example: "ubuntu"
 *         release:
 *           type: string
 *           description: Distribution release
 *           example: "xenial"
 *         arch:
 *           type: string
 *           description: Architecture (defaults to amd64)
 *           default: "amd64"
 *           example: "amd64"
 *         autostart:
 *           type: boolean
 *           description: Whether container should autostart (defaults to false)
 *           default: false
 *           example: true
 *         description:
 *           type: string
 *           description: Optional description for the container (allowed characters: letters, numbers, spaces, . - _ : ? ! &)
 *           example: "My web server container"
 *         start_after_creation:
 *           type: boolean
 *           description: Whether to start the container immediately after creation (defaults to false)
 *           default: false
 *           example: true
 *     ImageInfo:
 *       type: object
 *       properties:
 *         architectures:
 *           type: array
 *           items:
 *             type: string
 *           description: Available architectures
 *           example: ["amd64", "arm64"]
 *         variants:
 *           type: array
 *           items:
 *             type: string
 *           description: Available variants
 *           example: ["cloud", "default"]
 *     AvailableImagesResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *         cached:
 *           type: boolean
 *           description: Whether data was loaded from cache
 *         lastUpdated:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 *         distributions:
 *           type: object
 *           additionalProperties:
 *             type: object
 *             additionalProperties:
 *               $ref: '#/components/schemas/ImageInfo'
 *           description: Available distributions with releases and architectures (amd64 only)
 *         filtered:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               distribution:
 *                 type: string
 *                 description: Distribution name
 *               release:
 *                 type: string
 *                 description: Release version
 *               architecture:
 *                 type: string
 *                 description: Architecture (non-amd64)
 *               variant:
 *                 type: string
 *                 nullable: true
 *                 description: Variant name (if available)
 *           description: Non-amd64 architectures that were filtered out
 *     OperationResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *         message:
 *           type: string
 *           description: Operation status message
 */

// All routes in this file require admin role
router.use(checkRole(['admin']));

/**
 * @swagger
 * /lxc/containers:
 *   get:
 *     summary: List all LXC Containers
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all containers
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Container'
 *             example:
 *               - name: "web-server"
 *                 state: "running"
 *                 autostart: true
 *                 ipv4: ["192.168.1.100"]
 *                 ipv6: ["::1"]
 *               - name: "database"
 *                 state: "stopped"
 *                 autostart: false
 *                 ipv4: []
 *                 ipv6: []
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
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
router.get('/containers', async (req, res) => {
  try {
    const containers = await lxcService.listContainers();
    res.json(containers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/{name}/start:
 *   post:
 *     summary: Start a container
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Container Name
 *         example: "web-server"
 *     responses:
 *       200:
 *         description: Container successfully started
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container web-server successfully started"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error starting container
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/containers/:name/start', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await lxcService.startContainer(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/{name}/stop:
 *   post:
 *     summary: Stop a container
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Container Name
 *         example: "web-server"
 *     responses:
 *       200:
 *         description: Container successfully stopped
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container web-server successfully stopped"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error stopping container
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/containers/:name/stop', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await lxcService.stopContainer(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/{name}/restart:
 *   post:
 *     summary: Restart a container
 *     description: Stops the container, waits 1 second, then starts it again
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Container Name
 *         example: "web-server"
 *     responses:
 *       200:
 *         description: Container successfully restarted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container web-server restarted successfully"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error restarting container
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/containers/:name/restart', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await lxcService.restartContainer(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/{name}/kill:
 *   post:
 *     summary: Forcefully stop a container (kill)
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Container Name
 *         example: "web-server"
 *     responses:
 *       200:
 *         description: Container successfully stopped
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container web-server erfolgreich beendet"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error stopping container
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/containers/:name/kill', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await lxcService.killContainer(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/{name}/freeze:
 *   post:
 *     summary: Freeze (pause) a container
 *     description: Pauses all processes in the container. The container must be running.
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Container Name
 *         example: "web-server"
 *     responses:
 *       200:
 *         description: Container successfully frozen
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container web-server frozen successfully"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error freezing container
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/containers/:name/freeze', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await lxcService.freezeContainer(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/{name}/unfreeze:
 *   post:
 *     summary: Unfreeze (resume) a container
 *     description: Resumes all processes in a frozen container.
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Container Name
 *         example: "web-server"
 *     responses:
 *       200:
 *         description: Container successfully unfrozen
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container web-server unfrozen successfully"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error unfreezing container
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/containers/:name/unfreeze', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await lxcService.unfreezeContainer(name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/create:
 *   post:
 *     summary: Create a new LXC container
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ContainerCreateRequest'
 *           example:
 *             name: "my-ubuntu-container"
 *             distribution: "ubuntu"
 *             release: "xenial"
 *             arch: "amd64"
 *             autostart: true
 *             description: "My production web server"
 *             start_after_creation: true
 *     responses:
 *       200:
 *         description: Container successfully created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container my-ubuntu-container created successfully with ubuntu xenial (amd64) and started successfully"
 *               autostart: true
 *               description: "My production web server"
 *               started: true
 *       400:
 *         description: Invalid request or container already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Container my-ubuntu-container already exists"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error creating container
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/containers/create', async (req, res) => {
  try {
    const { name, distribution, release, arch, autostart, description, start_after_creation } = req.body;

    // Validate required fields
    if (!name || !distribution || !release) {
      return res.status(400).json({ error: 'Name, distribution and release are required' });
    }

    const result = await lxcService.createContainer(name, distribution, release, arch, autostart, description, start_after_creation);
    res.json(result);
  } catch (error) {
    // Check for specific validation errors
    if (error.message.includes('Invalid container name')) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message.includes('Invalid characters in description')) {
      return res.status(400).json({ error: error.message });
    }
    // Check if it's a "container already exists" error
    if (error.message.includes('already exists')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/images:
 *   get:
 *     summary: Get available container images/distributions
 *     description: Lists all available distributions, their releases and supported architectures. Data is cached for 1 hour.
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Available container images
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AvailableImagesResponse'
 *             example:
 *               success: true
 *               cached: false
 *               lastUpdated: "2024-01-20T10:30:00.000Z"
 *               distributions:
 *                 ubuntu:
 *                   jammy:
 *                     architectures: ["amd64"]
 *                     variants: ["cloud", "default", "desktop"]
 *                   noble:
 *                     architectures: ["amd64"]
 *                     variants: ["cloud", "default", "desktop"]
 *                 debian:
 *                   bookworm:
 *                     architectures: ["amd64"]
 *                     variants: ["cloud", "default"]
 *                   bullseye:
 *                     architectures: ["amd64"]
 *                     variants: ["cloud", "default"]
 *                 alpine:
 *                   "3.20":
 *                     architectures: ["amd64"]
 *                     variants: ["cloud", "default", "tinycloud"]
 *               filtered:
 *                 - distribution: "ubuntu"
 *                   release: "jammy"
 *                   architecture: "arm64"
 *                   variant: "cloud"
 *                 - distribution: "ubuntu"
 *                   release: "jammy"
 *                   architecture: "armhf"
 *                   variant: "default"
 *                 - distribution: "debian"
 *                   release: "bookworm"
 *                   architecture: "arm64"
 *                   variant: "cloud"
 *                 - distribution: "alpine"
 *                   release: "3.20"
 *                   architecture: "riscv64"
 *                   variant: null
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error fetching available images
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/images', async (req, res) => {
  try {
    const result = await lxcService.getAvailableImages();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/{name}:
 *   delete:
 *     summary: Destroy (delete) a container
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Container Name
 *         example: "my-ubuntu-container"
 *     responses:
 *       200:
 *         description: Container successfully destroyed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container my-ubuntu-container destroyed successfully"
 *       400:
 *         description: Container does not exist
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Container my-ubuntu-container does not exist"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error destroying container
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *   put:
 *     summary: Update container configuration
 *     description: Update autostart and/or description settings for an existing container
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Container Name
 *         example: "my-ubuntu-container"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               autostart:
 *                 type: boolean
 *                 description: Whether container should autostart
 *                 example: true
 *               description:
 *                 type: string
 *                 description: Container description (allowed characters: letters, numbers, spaces, . - _ : ? ! &; set to null or empty string to remove)
 *                 example: "My updated web server container"
 *           example:
 *             autostart: true
 *             description: "My updated web server container"
 *     responses:
 *       200:
 *         description: Container configuration successfully updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 updates:
 *                   type: object
 *                   description: Applied updates
 *             example:
 *               success: true
 *               message: "Container my-ubuntu-container configuration updated successfully"
 *               updates:
 *                 autostart: true
 *                 description: "My updated web server container"
 *       400:
 *         description: Container does not exist or invalid request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Container my-ubuntu-container does not exist"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error updating container configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/containers/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await lxcService.destroyContainer(name);
    res.json(result);
  } catch (error) {
    // Check if it's a "container does not exist" error
    if (error.message.includes('does not exist')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/containers/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { autostart, description } = req.body;

    // Validate that at least one field is provided
    if (typeof autostart !== 'boolean' && description === undefined) {
      return res.status(400).json({ error: 'At least one field (autostart or description) must be provided' });
    }

    const options = {};
    if (typeof autostart === 'boolean') {
      options.autostart = autostart;
    }
    if (description !== undefined) {
      options.description = description;
    }

    const result = await lxcService.updateContainerConfig(name, options);
    res.json(result);
  } catch (error) {
    // Check if it's a "container does not exist" error
    if (error.message.includes('does not exist')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/containers/usage:
 *   get:
 *     summary: Get resource usage for all containers
 *     description: Returns detailed resource usage information including CPU percentage, memory usage, and IP addresses for all containers. Data is sorted by container name. CPU and memory data is only collected for running containers.
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Container resource usage information
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Container name
 *                   state:
 *                     type: string
 *                     description: Container state (running, stopped, etc.)
 *                   autostart:
 *                     type: boolean
 *                     description: Autostart enabled
 *                   unprivileged:
 *                     type: boolean
 *                     description: Unprivileged container
 *                   cpu:
 *                     type: object
 *                     properties:
 *                       usage:
 *                         type: number
 *                         description: CPU usage percentage (0 for stopped containers)
 *                       unit:
 *                         type: string
 *                         description: Unit for CPU usage
 *                   memory:
 *                     type: object
 *                     properties:
 *                       bytes:
 *                         type: integer
 *                         description: Memory usage in bytes (0 for stopped containers)
 *                       formatted:
 *                         type: string
 *                         description: Human readable memory usage
 *                   network:
 *                     type: object
 *                     properties:
 *                       ipv4:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: IPv4 addresses
 *                       ipv6:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: IPv6 addresses
 *                       docker:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: Docker network IPs (172.x.x.x)
 *                       all:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: All IP addresses combined
 *             example:
 *               - name: "database"
 *                 state: "running"
 *                 autostart: true
 *                 unprivileged: false
 *                 cpu:
 *                   usage: 25.5
 *                   unit: "%"
 *                 memory:
 *                   bytes: 1073741824
 *                   formatted: "1.00 GiB"
 *                 network:
 *                   ipv4: ["192.168.1.100"]
 *                   ipv6: ["2001:db8::1"]
 *                   docker: ["172.17.0.2"]
 *                   all: ["192.168.1.100", "172.17.0.2", "2001:db8::1"]
 *               - name: "webserver"
 *                 state: "stopped"
 *                 autostart: false
 *                 unprivileged: true
 *                 cpu:
 *                   usage: 0
 *                   unit: "%"
 *                 memory:
 *                   bytes: 0
 *                   formatted: "0 Bytes"
 *                 network:
 *                   ipv4: []
 *                   ipv6: []
 *                   docker: []
 *                   all: []
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error getting container resource usage
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/containers/usage', async (req, res) => {
  try {
    const result = await lxcService.getContainerResourceUsage();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /lxc/mos/containers:
 *   get:
 *     summary: Get container startup order
 *     description: Retrieves the current startup order, autostart setting, and description for all LXC containers. Containers are sorted by their index value.
 *     tags: [LXC]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Container information successfully retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Container name
 *                   index:
 *                     type: integer
 *                     nullable: true
 *                     description: Container startup index (null if no index is set)
 *                   autostart:
 *                     type: boolean
 *                     description: Whether container starts automatically
 *                   description:
 *                     type: string
 *                     nullable: true
 *                     description: Container description (null if no description is set)
 *             example:
 *               - name: "database"
 *                 index: 1
 *                 autostart: true
 *                 description: "MySQL database server"
 *               - name: "webserver"
 *                 index: 2
 *                 autostart: true
 *                 description: "Apache web server"
 *               - name: "proxy"
 *                 index: 3
 *                 autostart: false
 *                 description: null
 *               - name: "unordered-container"
 *                 index: null
 *                 autostart: false
 *                 description: "Test container"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error getting container information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *   post:
 *     summary: Update container startup order
 *     description: Updates the startup order, autostart setting, and/or description for multiple LXC containers. Modifies #container_order=, lxc.start.auto=, and #container_description= lines in their config files. All fields are optional except name.
 *     tags: [LXC]
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
 *               properties:
 *                 name:
 *                   type: string
 *                   description: Container name
 *                   example: "database"
 *                 index:
 *                   type: integer
 *                   minimum: 1
 *                   description: Container startup index (optional, must be positive integer starting from 1)
 *                   example: 1
 *                 autostart:
 *                   type: boolean
 *                   description: Whether container should start automatically (optional)
 *                   example: true
 *                 description:
 *                   type: string
 *                   nullable: true
 *                   maxLength: 65
 *                   pattern: "^[a-zA-Z0-9\\s.\\-_,]*$"
 *                   description: Container description (optional, max 65 chars, only letters/numbers/spaces and . - _ , allowed, set to null or empty string to remove)
 *                   example: "MySQL database server"
 *           example:
 *             - name: "database"
 *               index: 1
 *               autostart: true
 *               description: "MySQL database server"
 *             - name: "webserver"
 *               index: 2
 *               autostart: true
 *               description: "Apache web server"
 *             - name: "proxy"
 *               autostart: false
 *     responses:
 *       200:
 *         description: Container information successfully updated
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Container name
 *                   index:
 *                     type: integer
 *                     description: Updated index value (only present if index was updated)
 *                   autostart:
 *                     type: boolean
 *                     description: Updated autostart value (only present if autostart was updated)
 *                   description:
 *                     type: string
 *                     nullable: true
 *                     description: Updated description value (only present if description was updated)
 *             example:
 *               - name: "database"
 *                 index: 1
 *                 autostart: true
 *                 description: "MySQL database server"
 *               - name: "webserver"
 *                 index: 2
 *                 autostart: true
 *                 description: "Apache web server"
 *               - name: "proxy"
 *                 autostart: false
 *       400:
 *         description: Invalid request data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing_name:
 *                 summary: Missing container name
 *                 value:
 *                   error: "Each container must have a name"
 *               invalid_index:
 *                 summary: Invalid index value
 *                 value:
 *                   error: "Invalid index for container database. Index must be a positive integer starting from 1."
 *               invalid_autostart:
 *                 summary: Invalid autostart value
 *                 value:
 *                   error: "Invalid autostart value for container webserver. Autostart must be a boolean."
 *               invalid_description:
 *                 summary: Invalid description format
 *                 value:
 *                   error: "Invalid description for container proxy. Must be max 65 characters and only contain letters, numbers, spaces and these special characters: . - _ ,"
 *               duplicate_index:
 *                 summary: Duplicate index values
 *                 value:
 *                   error: "Duplicate index values are not allowed"
 *               container_not_found:
 *                 summary: Container does not exist
 *                 value:
 *                   error: "Container nonexistent does not exist"
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: No admin permission
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error updating container information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/mos/containers', async (req, res) => {
  try {
    const result = await lxcService.getAllContainerIndices();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/mos/containers', async (req, res) => {
  try {
    const containers = req.body;

    // Validate that we have an array
    if (!Array.isArray(containers)) {
      return res.status(400).json({ error: 'Request body must be an array of containers' });
    }

    // Validate that array is not empty
    if (containers.length === 0) {
      return res.status(400).json({ error: 'At least one container must be provided' });
    }

    const result = await lxcService.updateContainerIndices(containers);
    res.json(result);
  } catch (error) {
    // Check for validation errors that should return 400
    if (error.message.includes('must have a name') ||
        error.message.includes('must be a positive integer') ||
        error.message.includes('must be a boolean') ||
        error.message.includes('Invalid characters in description') ||
        error.message.includes('Duplicate index values') ||
        error.message.includes('does not exist') ||
        error.message.includes('must be an array')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
