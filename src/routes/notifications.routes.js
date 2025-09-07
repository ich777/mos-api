const express = require('express');
const router = express.Router();
const notificationsService = require('../services/notifications.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: System Notifications Management
 *
 * components:
 *   schemas:
 *     Notification:
 *       type: object
 *       properties:
 *         title:
 *           type: string
 *           description: Notification title
 *           example: "chipsServer - test"
 *         message:
 *           type: string
 *           description: Notification message content
 *           example: "hallo"
 *         priority:
 *           type: string
 *           enum: [high, normal, low]
 *           description: Notification priority level
 *           example: "normal"
 *         timestamp:
 *           type: string
 *           format: date-time
 *           description: ISO timestamp when notification was created
 *           example: "2025-09-07T19:16:34.620280755+02:00"
 *     DeleteResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the operation was successful
 *         message:
 *           type: string
 *           description: Result message
 *           example: "Notification deleted successfully"
 *         remainingCount:
 *           type: integer
 *           description: Number of notifications remaining after deletion
 *           example: 4
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 */

// Only Admin can access these routes
router.use(checkRole(['admin']));

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Get all notifications
 *     description: Retrieve all system notifications sorted by timestamp (newest first) - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Notifications retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Notification'
 *             example:
 *               - title: "chipsServer - test"
 *                 message: "hallo2"
 *                 priority: "normal"
 *                 timestamp: "2025-09-07T19:16:35.939580764+02:00"
 *               - title: "chipsServer - test"
 *                 message: "hallo"
 *                 priority: "normal"
 *                 timestamp: "2025-09-07T19:16:34.620280755+02:00"
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
router.get('/', async (req, res) => {
  try {
    const notifications = await notificationsService.getNotifications();
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/**
 * @swagger
 * /notifications/{timestamp}:
 *   delete:
 *     summary: Delete notification by timestamp
 *     description: Delete a specific notification using its timestamp - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: timestamp
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *         description: The timestamp of the notification to delete
 *         example: "2025-09-07T19:16:34.620280755+02:00"
 *     responses:
 *       200:
 *         description: Notification deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteResult'
 *       404:
 *         description: Notification not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteResult'
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
router.delete('/:timestamp', async (req, res) => {
  try {
    const { timestamp } = req.params;
    
    if (!timestamp) {
      return res.status(400).json({ error: 'Timestamp parameter is required' });
    }
    
    const result = await notificationsService.deleteNotification(timestamp);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications:
 *   delete:
 *     summary: Delete all notifications
 *     description: Delete all system notifications - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteResult'
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
router.delete('/', async (req, res) => {
  try {
    const result = await notificationsService.deleteAllNotifications();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
