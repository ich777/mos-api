const fs = require('fs').promises;
const path = require('path');

class NotificationsService {
  constructor() {
    this.notificationsPath = '/var/mos/notify/notifications.json';
  }

  /**
   * Reads all notifications from the notifications.json file
   * @returns {Promise<Array>} Array of notification objects
   */
  async getNotifications() {
    try {
      const data = await fs.readFile(this.notificationsPath, 'utf8');
      const notifications = JSON.parse(data);

      // Ensure it's an array
      if (!Array.isArray(notifications)) {
        throw new Error('Notifications file does not contain a valid array');
      }

      // Ensure all notifications have a 'read' field (default: false)
      const notificationsWithRead = notifications.map(notification => ({
        ...notification,
        read: notification.read !== undefined ? notification.read : false
      }));

      // Sort by timestamp (newest first)
      return notificationsWithRead.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty array
        return [];
      }
      throw new Error(`Error reading notifications: ${error.message}`);
    }
  }

  /**
   * Deletes a notification by timestamp
   * @param {string} timestamp - The timestamp of the notification to delete
   * @returns {Promise<Object>} Result object with success status and message
   */
  async deleteNotification(timestamp) {
    try {
      const notifications = await this.getNotifications();

      // Find the notification with the matching timestamp
      const initialLength = notifications.length;
      const filteredNotifications = notifications.filter(notification =>
        notification.timestamp !== timestamp
      );

      if (filteredNotifications.length === initialLength) {
        return {
          success: false,
          message: `Notification with timestamp ${timestamp} not found`
        };
      }

      // Write the filtered notifications back to the file
      await this._writeNotifications(filteredNotifications);

      return {
        success: true,
        message: `Notification with timestamp ${timestamp} deleted successfully`,
        remainingCount: filteredNotifications.length
      };
    } catch (error) {
      throw new Error(`Error deleting notification: ${error.message}`);
    }
  }

  /**
   * Deletes all notifications
   * @returns {Promise<Object>} Result object with success status and message
   */
  async deleteAllNotifications() {
    try {
      await this._writeNotifications([]);

      return {
        success: true,
        message: 'All notifications deleted successfully',
        remainingCount: 0
      };
    } catch (error) {
      throw new Error(`Error deleting all notifications: ${error.message}`);
    }
  }

  /**
   * Marks a single notification as read by timestamp
   * @param {string} timestamp - The timestamp of the notification to mark as read
   * @returns {Promise<Object>} Result object with success status and message
   */
  async markNotificationAsRead(timestamp) {
    try {
      const notifications = await this.getNotifications();

      // Find and update the notification
      let notificationFound = false;
      const updatedNotifications = notifications.map(notification => {
        if (notification.timestamp === timestamp) {
          notificationFound = true;
          return { ...notification, read: true };
        }
        return notification;
      });

      if (!notificationFound) {
        return {
          success: false,
          message: `Notification with timestamp ${timestamp} not found`
        };
      }

      // Write the updated notifications back to the file
      await this._writeNotifications(updatedNotifications);

      return {
        success: true,
        message: `Notification with timestamp ${timestamp} marked as read`,
        totalCount: updatedNotifications.length
      };
    } catch (error) {
      throw new Error(`Error marking notification as read: ${error.message}`);
    }
  }

  /**
   * Marks multiple notifications as read by timestamps
   * @param {Array<string>} timestamps - Array of timestamps to mark as read
   * @returns {Promise<Object>} Result object with success status and details
   */
  async markMultipleNotificationsAsRead(timestamps) {
    try {
      if (!Array.isArray(timestamps) || timestamps.length === 0) {
        return {
          success: false,
          message: 'Invalid timestamps array provided'
        };
      }

      const notifications = await this.getNotifications();
      const timestampSet = new Set(timestamps);
      let markedCount = 0;

      // Update notifications that match the provided timestamps
      const updatedNotifications = notifications.map(notification => {
        if (timestampSet.has(notification.timestamp) && !notification.read) {
          markedCount++;
          return { ...notification, read: true };
        }
        return notification;
      });

      if (markedCount === 0) {
        return {
          success: false,
          message: 'No matching unread notifications found for the provided timestamps'
        };
      }

      // Write the updated notifications back to the file
      await this._writeNotifications(updatedNotifications);

      return {
        success: true,
        message: `${markedCount} notification(s) marked as read`,
        markedCount,
        totalCount: updatedNotifications.length
      };
    } catch (error) {
      throw new Error(`Error marking multiple notifications as read: ${error.message}`);
    }
  }

  /**
   * Marks all notifications as read
   * @returns {Promise<Object>} Result object with success status and message
   */
  async markAllNotificationsAsRead() {
    try {
      const notifications = await this.getNotifications();
      let markedCount = 0;

      // Mark all unread notifications as read
      const updatedNotifications = notifications.map(notification => {
        if (!notification.read) {
          markedCount++;
          return { ...notification, read: true };
        }
        return notification;
      });

      if (markedCount === 0) {
        return {
          success: true,
          message: 'All notifications are already marked as read',
          markedCount: 0,
          totalCount: notifications.length
        };
      }

      // Write the updated notifications back to the file
      await this._writeNotifications(updatedNotifications);

      return {
        success: true,
        message: `All ${markedCount} unread notification(s) marked as read`,
        markedCount,
        totalCount: updatedNotifications.length
      };
    } catch (error) {
      throw new Error(`Error marking all notifications as read: ${error.message}`);
    }
  }

  /**
   * Gets notification statistics including read/unread counts
   * @returns {Promise<Object>} Statistics object
   */
  async getNotificationStats() {
    try {
      const notifications = await this.getNotifications();

      const stats = {
        total: notifications.length,
        read: 0,
        unread: 0,
        priorities: {
          high: 0,
          normal: 0,
          low: 0
        }
      };

      notifications.forEach(notification => {
        // Count read/unread
        if (notification.read) {
          stats.read++;
        } else {
          stats.unread++;
        }

        // Count priorities
        const priority = notification.priority || 'normal';
        if (stats.priorities[priority] !== undefined) {
          stats.priorities[priority]++;
        }
      });

      return stats;
    } catch (error) {
      throw new Error(`Error getting notification statistics: ${error.message}`);
    }
  }


  /**
   * Writes notifications array to the file
   * @private
   * @param {Array} notifications - Array of notifications to write
   */
  async _writeNotifications(notifications) {
    try {
      // Ensure the directory exists
      const dir = path.dirname(this.notificationsPath);
      await fs.mkdir(dir, { recursive: true });

      // Write the notifications to the file
      await fs.writeFile(
        this.notificationsPath,
        JSON.stringify(notifications, null, 2),
        'utf8'
      );
    } catch (error) {
      throw new Error(`Error writing notifications file: ${error.message}`);
    }
  }

  /**
   * Validates notification object structure
   * @private
   * @param {Object} notification - Notification object to validate
   * @returns {boolean} True if valid
   */
  _validateNotification(notification) {
    return (
      notification &&
      typeof notification === 'object' &&
      typeof notification.title === 'string' &&
      typeof notification.message === 'string' &&
      typeof notification.timestamp === 'string' &&
      (notification.priority === undefined ||
       ['high', 'normal', 'low'].includes(notification.priority)) &&
      (notification.read === undefined || typeof notification.read === 'boolean')
    );
  }
}

module.exports = new NotificationsService();
