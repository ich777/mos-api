/**
 * VNC Proxy Service
 * Manages VNC tokens and session tracking for noVNC WebSocket connections
 */

const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class VncService {
  constructor() {
    // token → { vmName, vncPort, userId, createdAt, expiresAt, connected }
    this.sessions = new Map();

    // Cleanup expired tokens every 60s
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Generate a VNC access token for a VM
   * @param {string} vmName - VM name
   * @param {string} userId - User ID requesting access
   * @returns {Promise<{token: string, wsPath: string, vncPort: number}>}
   */
  async generateToken(vmName, userId) {
    // Validate VM exists and is running
    const vncPort = await this.getVncPort(vmName);
    if (!vncPort) {
      throw new Error(`VM "${vmName}" is not running or has no VNC configured`);
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');

    // Store session (60s TTL until connected)
    this.sessions.set(token, {
      vmName,
      vncPort,
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000, // 60s to connect
      connected: false
    });

    return {
      token,
      wsPath: `/api/v1/vm/vnc/ws/${token}`,
      vncPort
    };
  }

  /**
   * Validate a token and return session data
   * @param {string} token - VNC access token
   * @returns {object|null} Session data or null if invalid
   */
  validateToken(token) {
    const session = this.sessions.get(token);
    if (!session) {
      return null;
    }

    // Check expiry only if not yet connected
    if (!session.connected && Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }

    return session;
  }

  /**
   * Mark a session as connected (removes expiry)
   * @param {string} token - VNC access token
   */
  markConnected(token) {
    const session = this.sessions.get(token);
    if (session) {
      session.connected = true;
      session.connectedAt = Date.now();
    }
  }

  /**
   * End a session
   * @param {string} token - VNC access token
   */
  endSession(token) {
    const session = this.sessions.get(token);
    if (session) {
      console.log(`VNC session ended for VM "${session.vmName}" (user: ${session.userId})`);
      this.sessions.delete(token);
    }
  }

  /**
   * Get VNC port for a running VM
   * @param {string} vmName - VM name
   * @returns {Promise<number|null>} VNC port or null
   */
  async getVncPort(vmName) {
    try {
      const { stdout } = await execPromise(`virsh vncdisplay "${vmName}"`);
      const vncDisplay = stdout.trim();
      if (vncDisplay) {
        // VNC display format is :0, :1, etc.
        const displayNumber = parseInt(vncDisplay.replace(':', ''), 10);
        if (!isNaN(displayNumber)) {
          return 5900 + displayNumber;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get all active sessions (for admin view)
   * @returns {Array} Active sessions
   */
  getSessions() {
    const sessions = [];
    for (const [token, session] of this.sessions.entries()) {
      sessions.push({
        tokenPrefix: token.substring(0, 8) + '...',
        vmName: session.vmName,
        userId: session.userId,
        connected: session.connected,
        createdAt: session.createdAt,
        connectedAt: session.connectedAt || null
      });
    }
    return sessions;
  }

  /**
   * Get session count per VM
   * @returns {object} VM name → connection count
   */
  getSessionCounts() {
    const counts = {};
    for (const session of this.sessions.values()) {
      if (session.connected) {
        counts[session.vmName] = (counts[session.vmName] || 0) + 1;
      }
    }
    return counts;
  }

  /**
   * Cleanup expired unconnected sessions
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, session] of this.sessions.entries()) {
      if (!session.connected && now > session.expiresAt) {
        this.sessions.delete(token);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`VNC service: cleaned up ${cleaned} expired tokens`);
    }
  }

  /**
   * Shutdown service
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
  }
}

// Export singleton
module.exports = new VncService();
