const express = require('express');
const router = express.Router();
const hubService = require('../services/hub.service');

/**
 * @swagger
 * /mos/hub/settings:
 *   get:
 *     summary: Get hub settings
 *     description: Retrieves hub configuration (enabled, initial_update, schedule)
 *     tags: [MOS Hub]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Hub settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 initial_update:
 *                   type: boolean
 *                 schedule:
 *                   type: string
 *                 page_entries:
 *                   type: integer
 *       500:
 *         description: Server error
 */
router.get('/settings', async (req, res) => {
  try {
    const settings = await hubService.getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/hub/settings:
 *   post:
 *     summary: Update hub settings
 *     description: Updates hub configuration (enabled, initial_update, schedule)
 *     tags: [MOS Hub]
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
 *               initial_update:
 *                 type: boolean
 *               schedule:
 *                 type: string
 *                 description: Cron schedule string
 *               page_entries:
 *                 type: integer
 *                 description: Number of entries per page
 *           example:
 *             enabled: true
 *             initial_update: false
 *             schedule: "0 3 * * *"
 *             page_entries: 24
 *     responses:
 *       200:
 *         description: Updated settings
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 */
router.post('/settings', async (req, res) => {
  try {
    const settings = await hubService.setSettings(req.body);
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/hub/repositories:
 *   get:
 *     summary: Get all repository URLs
 *     description: Retrieves list of configured repository URLs
 *     tags: [MOS Hub]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of repository URLs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *             example:
 *               - https://github.com/user/repo1
 *               - https://github.com/user/repo2
 *       500:
 *         description: Server error
 */
router.get('/repositories', async (req, res) => {
  try {
    const repositories = await hubService.getRepositories();
    res.json(repositories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/hub/repositories:
 *   post:
 *     summary: Set repository URLs
 *     description: Replaces all repository URLs with the provided list
 *     tags: [MOS Hub]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: string
 *           example:
 *             - https://github.com/user/repo1
 *             - https://github.com/user/repo2
 *     responses:
 *       200:
 *         description: Repositories saved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *       400:
 *         description: Invalid input
 *       500:
 *         description: Server error
 */
router.post('/repositories', async (req, res) => {
  try {
    const repositories = await hubService.setRepositories(req.body);
    res.json(repositories);
  } catch (error) {
    if (error.message.includes('must be an array')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/hub/update:
 *   post:
 *     summary: Update repositories
 *     description: Downloads all configured repositories via git clone
 *     tags: [MOS Hub]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Update completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       url:
 *                         type: string
 *                       name:
 *                         type: string
 *                 failed:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       url:
 *                         type: string
 *                       name:
 *                         type: string
 *                       error:
 *                         type: string
 *                 total:
 *                   type: integer
 *       400:
 *         description: No repositories configured
 *       500:
 *         description: All downloads failed or server error
 */
router.post('/update', async (req, res) => {
  try {
    const result = await hubService.updateRepositories();
    res.json(result);
  } catch (error) {
    if (error.message.includes('No repositories configured')) {
      res.status(400).json({ error: error.message });
    } else if (error.message.includes('All repository downloads failed')) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/hub/index:
 *   get:
 *     summary: Get template index
 *     description: Returns all templates from all repositories with maintainer info
 *     tags: [MOS Hub]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in name, maintainer, description
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by category
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [docker, compose, plugin]
 *         description: Filter by type
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [name, created, updated]
 *         description: Sort by field - name alphabetically, created/updated by timestamp
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *         description: Sort order - for timestamps desc means newest first
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Max number of results to return
 *       - in: query
 *         name: skip
 *         schema:
 *           type: integer
 *         description: Number of results to skip for pagination
 *     responses:
 *       200:
 *         description: Template index with results and count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       maintainer:
 *                         type: string
 *                       maintainer_donate:
 *                         type: string
 *                       type:
 *                         type: string
 *                         enum: [docker, compose, plugin]
 *                       category:
 *                         type: array
 *                       description:
 *                         type: string
 *                       website:
 *                         type: string
 *                       icon:
 *                         type: string
 *                       repository:
 *                         type: string
 *                       created_at:
 *                         type: integer
 *                         description: Unix timestamp when template was first added
 *                       updated_at:
 *                         type: integer
 *                         description: Unix timestamp when template was last modified
 *                       stack_images:
 *                         type: array
 *                 page_entries:
 *                   type: integer
 *                   description: Configured entries per page
 *                 count:
 *                   type: integer
 *                   description: Total number of templates found
 *       400:
 *         description: No repositories downloaded
 *       500:
 *         description: Server error
 */
router.get('/index', async (req, res) => {
  try {
    const { search, category, type, sort, order, limit, skip } = req.query;
    const result = await hubService.buildIndex({
      search,
      category,
      type,
      sort,
      order,
      limit: limit ? parseInt(limit, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined
    });
    res.json(result);
  } catch (error) {
    if (error.message.includes('No repositories downloaded')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/hub/docker/template:
 *   post:
 *     summary: Get docker template content
 *     description: Returns the raw content of a docker template JSON
 *     tags: [MOS Hub]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - template
 *             properties:
 *               template:
 *                 type: string
 *                 description: Absolute path to template JSON
 *     responses:
 *       200:
 *         description: Template content
 *       400:
 *         description: Invalid or missing path
 *       404:
 *         description: Template not found
 *       500:
 *         description: Server error
 */
router.post('/docker/template', async (req, res) => {
  try {
    const { template } = req.body;
    const content = await hubService.getDockerTemplate(template);
    res.json(content);
  } catch (error) {
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/hub/compose/template:
 *   post:
 *     summary: Get compose files content
 *     description: Returns name, yaml, env, icon and web_ui_url from compose template
 *     tags: [MOS Hub]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - template
 *               - yaml
 *             properties:
 *               template:
 *                 type: string
 *                 description: Absolute path to template.json
 *               yaml:
 *                 type: string
 *                 description: Absolute path to compose.yaml
 *               env:
 *                 type: string
 *                 description: Optional absolute path to .env
 *     responses:
 *       200:
 *         description: File contents
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 yaml:
 *                   type: string
 *                 env:
 *                   type: string
 *                 icon:
 *                   type: string
 *                 web_ui_url:
 *                   type: string
 *       400:
 *         description: Invalid or missing path
 *       404:
 *         description: File not found
 *       500:
 *         description: Server error
 */
router.post('/compose/template', async (req, res) => {
  try {
    const { template, yaml, env } = req.body;
    const content = await hubService.getComposeFiles(template, yaml, env);
    res.json(content);
  } catch (error) {
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/hub/plugin/template:
 *   post:
 *     summary: Get plugin template content
 *     description: Returns the raw content of a plugin template JSON
 *     tags: [MOS Hub]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - template
 *             properties:
 *               template:
 *                 type: string
 *                 description: Absolute path to plugin template JSON
 *     responses:
 *       200:
 *         description: Plugin template content
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 description:
 *                   type: string
 *                 repository:
 *                   type: string
 *                 settings:
 *                   type: boolean
 *                 driver:
 *                   type: boolean
 *                 icon:
 *                   type: string
 *                 author:
 *                   type: string
 *                 homepage:
 *                   type: string
 *                 support:
 *                   type: string
 *       400:
 *         description: Invalid or missing path
 *       404:
 *         description: Template not found
 *       500:
 *         description: Server error
 */
router.post('/plugin/template', async (req, res) => {
  try {
    const { template } = req.body;
    const content = await hubService.getPluginTemplate(template);
    res.json(content);
  } catch (error) {
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

module.exports = router;
