const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth.middleware');
const dockerComposeService = require('../services/dockercompose.service');

/**
 * @swagger
 * tags:
 *   name: Docker Compose
 *   description: Docker Compose Stack Management (Admin only)
 *
 * components:
 *   schemas:
 *     ComposeStack:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Stack name
 *           example: "wordpress"
 *         services:
 *           type: array
 *           items:
 *             type: string
 *           description: Service names in the stack
 *           example: ["web", "db"]
 *         containers:
 *           type: array
 *           items:
 *             type: string
 *           description: Container names
 *           example: ["wordpress_web_1", "wordpress_db_1"]
 *         iconUrl:
 *           type: string
 *           nullable: true
 *           description: Icon URL
 *           example: "https://example.com/icon.png"
 *         running:
 *           type: boolean
 *           description: Whether stack is running
 *           example: true
 */

// Only admin can access these routes
router.use(checkRole(['admin']));

/**
 * @swagger
 * /docker/mos/compose/stacks:
 *   get:
 *     summary: Get all compose stacks
 *     description: Retrieve all Docker Compose stacks (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of stacks
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ComposeStack'
 *             example:
 *               - name: "wordpress"
 *                 services: ["web", "db"]
 *                 containers: ["wordpress_web_1", "wordpress_db_1"]
 *                 iconUrl: "https://example.com/icon.png"
 *                 running: true
 *               - name: "nextcloud"
 *                 services: ["app", "db", "redis"]
 *                 containers: ["nextcloud_app_1", "nextcloud_db_1", "nextcloud_redis_1"]
 *                 iconUrl: null
 *                 running: false
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.get('/stacks', async (req, res) => {
  try {
    const stacks = await dockerComposeService.getStacks();
    res.json(stacks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}:
 *   get:
 *     summary: Get a specific compose stack
 *     description: Retrieve details of a specific Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *         example: "wordpress"
 *     responses:
 *       200:
 *         description: Stack details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 yaml:
 *                   type: string
 *                   description: Content of compose.yaml
 *                 env:
 *                   type: string
 *                   nullable: true
 *                   description: Content of .env file
 *                 services:
 *                   type: array
 *                   items:
 *                     type: string
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *                 iconUrl:
 *                   type: string
 *                   nullable: true
 *                 running:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.get('/stacks/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const stack = await dockerComposeService.getStack(name);
    res.json(stack);
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
 * /docker/mos/compose/stacks:
 *   post:
 *     summary: Create a new compose stack
 *     description: Create and deploy a new Docker Compose stack (admin only)
 *     tags: [Docker Compose]
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
 *               - yaml
 *             properties:
 *               name:
 *                 type: string
 *                 description: Stack name (alphanumeric, hyphens, underscores only)
 *                 example: "wordpress"
 *               yaml:
 *                 type: string
 *                 description: compose.yaml content
 *                 example: "version: '3.8'\nservices:\n  web:\n    image: wordpress\n  db:\n    image: mysql:8.0\n"
 *               env:
 *                 type: string
 *                 nullable: true
 *                 description: .env file content (optional)
 *                 example: "MYSQL_ROOT_PASSWORD=secret\nMYSQL_DATABASE=wordpress"
 *               icon:
 *                 type: string
 *                 nullable: true
 *                 description: Icon URL (PNG only, optional)
 *                 example: "https://example.com/wordpress.png"
 *     responses:
 *       201:
 *         description: Stack created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 stack:
 *                   type: string
 *                   example: "wordpress"
 *                 services:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["web", "db"]
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["wordpress_web_1", "wordpress_db_1"]
 *                 iconPath:
 *                   type: string
 *                   nullable: true
 *                   example: "/var/lib/docker/mos/icons/compose/wordpress.png"
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.post('/stacks', async (req, res) => {
  try {
    const { name, yaml, env, icon } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Stack name is required' });
    }

    if (!yaml) {
      return res.status(400).json({ error: 'compose.yaml content is required' });
    }

    const result = await dockerComposeService.createStack(name, yaml, env, icon);
    res.status(201).json(result);
  } catch (error) {
    if (error.message.includes('already exists')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}:
 *   put:
 *     summary: Update a compose stack
 *     description: Update an existing Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - yaml
 *             properties:
 *               yaml:
 *                 type: string
 *                 description: New compose.yaml content
 *                 example: "version: '3.8'\nservices:\n  web:\n    image: wordpress:latest\n  db:\n    image: mysql:8.0\n"
 *               env:
 *                 type: string
 *                 nullable: true
 *                 description: New .env file content (optional)
 *                 example: "MYSQL_ROOT_PASSWORD=newsecret\nMYSQL_DATABASE=wordpress"
 *               icon:
 *                 type: string
 *                 nullable: true
 *                 description: New icon URL (PNG only, optional)
 *                 example: "https://example.com/wordpress-new.png"
 *     responses:
 *       200:
 *         description: Stack updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 services:
 *                   type: array
 *                   items:
 *                     type: string
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *                 iconPath:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.put('/stacks/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { yaml, env, icon } = req.body;

    if (!yaml) {
      return res.status(400).json({ error: 'compose.yaml content is required' });
    }

    const result = await dockerComposeService.updateStack(name, yaml, env, icon);
    res.json(result);
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
 * /docker/mos/compose/stacks/{name}:
 *   delete:
 *     summary: Delete a compose stack
 *     description: Stop and delete a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Stack deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.delete('/stacks/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.deleteStack(name);
    res.json(result);
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
 * /docker/mos/compose/stacks/{name}/start:
 *   post:
 *     summary: Start a compose stack
 *     description: Start all services in a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Stack started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/start', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.startStack(name);
    res.json(result);
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
 * /docker/mos/compose/stacks/{name}/stop:
 *   post:
 *     summary: Stop a compose stack
 *     description: Stop all services in a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Stack stopped successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 message:
 *                   type: string
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/stop', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.stopStack(name);
    res.json(result);
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
 * /docker/mos/compose/stacks/{name}/restart:
 *   post:
 *     summary: Restart a compose stack
 *     description: Restart all services in a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Stack restarted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/restart', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.restartStack(name);
    res.json(result);
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
 * /docker/mos/compose/stacks/{name}/pull:
 *   post:
 *     summary: Pull images for a compose stack
 *     description: Pull latest images for all services in a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Images pulled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 output:
 *                   type: string
 *                   description: Docker compose pull output
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/pull', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.pullStack(name);
    res.json(result);
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
 * /docker/mos/compose/removed:
 *   get:
 *     summary: Get all removed (deleted) compose stacks
 *     description: List all compose stacks that have been deleted (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of removed stacks
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Stack name
 *                     example: "wordpress"
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.get('/removed', async (req, res) => {
  try {
    const stacks = await dockerComposeService.getRemovedStacks();
    res.json(stacks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/compose/removed/{name}:
 *   get:
 *     summary: Get details of a removed compose stack
 *     description: Retrieve YAML, env, and icon details of a removed stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *         example: "wordpress"
 *     responses:
 *       200:
 *         description: Removed stack details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                   example: "wordpress"
 *                 yaml:
 *                   type: string
 *                   nullable: true
 *                   description: compose.yaml content
 *                 env:
 *                   type: string
 *                   nullable: true
 *                   description: .env file content
 *                 iconUrl:
 *                   type: string
 *                   nullable: true
 *                   description: Icon URL
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Removed stack not found
 *       500:
 *         description: Server error
 */
router.get('/removed/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const details = await dockerComposeService.getRemovedStackDetails(name);
    res.json(details);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

module.exports = router;
