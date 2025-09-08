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
      
      // Sort by timestamp (newest first)
      return notifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
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
       ['high', 'normal', 'low'].includes(notification.priority))
    );
  }
}

module.exports = new NotificationsService();
