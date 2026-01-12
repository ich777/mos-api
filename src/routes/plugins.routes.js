const express = require('express');
const router = express.Router();
const pluginsService = require('../services/plugins.service');

/**
 * @swagger
 * tags:
 *   name: MOS Plugins
 *   description: MOS Plugin management
 *
 * components:
 *   schemas:
 *     Plugin:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Plugin identifier
 *           example: "example-plugin"
 *         displayName:
 *           type: string
 *           description: Human-readable plugin name
 *           example: "Example Plugin"
 *         description:
 *           type: string
 *           description: Plugin description
 *           example: "An example plugin for MOS"
 *         version:
 *           type: string
 *           description: Plugin version
 *           example: "1.0.0"
 *         icon:
 *           type: string
 *           description: MDI icon name
 *           example: "mdi-puzzle"
 *         author:
 *           type: string
 *           description: Plugin author
 *           example: ""
 *         homepage:
 *           type: string
 *           description: Plugin homepage URL
 *           example: ""
 *     PluginsResponse:
 *       type: object
 *       properties:
 *         results:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Plugin'
 *         count:
 *           type: integer
 *           description: Total number of plugins
 */

/**
 * @swagger
 * /mos/plugins:
 *   get:
 *     summary: List all installed plugins
 *     description: Returns a list of all installed plugins with their manifest data
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of plugins
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PluginsResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.get('/', async (req, res) => {
  try {
    const result = await pluginsService.getPlugins();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `Error listing plugins: ${error.message}` });
  }
});

module.exports = router;
