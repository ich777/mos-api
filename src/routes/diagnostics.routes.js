const express = require('express');
const path = require('path');
const router = express.Router();
const diagnosticsService = require('../services/diagnostics.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * /mos/diag:
 *   get:
 *     tags: [MOS]
 *     summary: Download diagnostics tar.gz bundle
 *     description: |
 *       Collects system config files, command outputs, and API service data
 *       into a tar.gz archive. The archive contains raw config files, processed
 *       API responses, system info, and network details.
 *       If individual collectors fail, their errors are logged in errors.txt.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: tar.gz file download
 *         content:
 *           application/gzip:
 *             schema:
 *               type: string
 *               format: binary
 *       500:
 *         description: Failed to create diagnostics bundle
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.get('/', checkRole(['admin']), async (req, res) => {
  let tempDir = null;

  try {
    tempDir = await diagnosticsService.collect();
    const archivePath = await diagnosticsService.createArchive(tempDir);
    diagnosticsService.cleanup(tempDir);

    const filename = path.basename(archivePath);
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    const stream = diagnosticsService.getArchiveStream(archivePath);
    stream.pipe(res);

    stream.on('error', (err) => {
      console.error('Diagnostics stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream diagnostics bundle' });
      }
    });
  } catch (error) {
    console.error('Diagnostics error:', error.message);
    if (tempDir) {
      diagnosticsService.cleanup(tempDir);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create diagnostics bundle' });
    }
  }
});

module.exports = router;
