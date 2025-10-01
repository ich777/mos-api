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
 *         id:
 *           type: string
 *           description: Unique notification ID (millisecond timestamp)
 *           example: "1727725946123"
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
 *         read:
 *           type: boolean
 *           description: Whether the notification has been read
 *           example: false
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
 *     ReadResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the operation was successful
 *         message:
 *           type: string
 *           description: Result message
 *           example: "Notification marked as read"
 *         markedCount:
 *           type: integer
 *           description: Number of notifications marked as read
 *           example: 1
 *         totalCount:
 *           type: integer
 *           description: Total number of notifications
 *           example: 5
 *     NotificationStats:
 *       type: object
 *       properties:
 *         total:
 *           type: integer
 *           description: Total number of notifications
 *           example: 10
 *         read:
 *           type: integer
 *           description: Number of read notifications
 *           example: 3
 *         unread:
 *           type: integer
 *           description: Number of unread notifications
 *           example: 7
 *         priorities:
 *           type: object
 *           properties:
 *             high:
 *               type: integer
 *               example: 2
 *             normal:
 *               type: integer
 *               example: 6
 *             low:
 *               type: integer
 *               example: 2
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
 *     description: Retrieve all system notifications with optional filtering by read status, limit, and sort order - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: read
 *         schema:
 *           type: boolean
 *         description: Filter by read status (true for read, false for unread)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Limit the number of notifications returned
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort order by timestamp (asc = oldest first, desc = newest first)
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
 *               - id: "1727725946123"
 *                 title: "chipsServer - test"
 *                 message: "hallo2"
 *                 priority: "normal"
 *                 timestamp: "2025-09-07T19:16:35.939580764+02:00"
 *                 read: false
 *               - id: "1727725946122"
 *                 title: "chipsServer - test"
 *                 message: "hallo"
 *                 priority: "normal"
 *                 timestamp: "2025-09-07T19:16:34.620280755+02:00"
 *                 read: true
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
    const { read, limit, order } = req.query;

    const options = {};

    // Parse read parameter
    if (read !== undefined) {
      options.read = read === 'true' || read === true;
    }

    // Parse limit parameter
    if (limit !== undefined) {
      const parsedLimit = parseInt(limit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        options.limit = parsedLimit;
      }
    }

    // Parse order parameter (default: desc)
    if (order !== undefined) {
      options.order = order === 'asc' ? 'asc' : 'desc';
    }

    const notifications = await notificationsService.getNotifications(options);
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/**
 * @swagger
 * /notifications/{id}:
 *   delete:
 *     summary: Delete notification by ID
 *     description: Delete a specific notification using its ID - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the notification to delete
 *         example: "1727725946123"
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
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'ID parameter is required' });
    }

    const result = await notificationsService.deleteNotification(id);

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

/**
 * @swagger
 * /notifications/stats:
 *   get:
 *     summary: Get notification statistics
 *     description: Get statistics about notifications including read/unread counts and priority breakdown - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NotificationStats'
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
router.get('/stats', async (req, res) => {
  try {
    const stats = await notificationsService.getNotificationStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications/{id}/read:
 *   put:
 *     summary: Mark notification as read
 *     description: Mark a specific notification as read using its ID - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the notification to mark as read
 *         example: "1727725946123"
 *     responses:
 *       200:
 *         description: Notification marked as read successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
 *       404:
 *         description: Notification not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
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
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'ID parameter is required' });
    }

    const result = await notificationsService.markNotificationAsRead(id);

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
 * /notifications/read/multiple:
 *   put:
 *     summary: Mark multiple notifications as read
 *     description: Mark multiple notifications as read using their IDs - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of notification IDs to mark as read
 *                 example: ["1727725946123", "1727725946122"]
 *             required:
 *               - ids
 *     responses:
 *       200:
 *         description: Notifications marked as read successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: No matching notifications found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
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
router.put('/read/multiple', async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: 'ids array is required in request body' });
    }

    const result = await notificationsService.markMultipleNotificationsAsRead(ids);

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
 * /notifications/read/all:
 *   put:
 *     summary: Mark all notifications as read
 *     description: Mark all notifications as read - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
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
router.put('/read/all', async (req, res) => {
  try {
    const result = await notificationsService.markAllNotificationsAsRead();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;