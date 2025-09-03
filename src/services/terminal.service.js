const pty = require('node-pty');
const fs = require('fs').promises;
const path = require('path');

class TerminalService {
  constructor() {
    this.sessions = new Map(); // sessionId -> { ptyProcess, options, startTime }
    this.sessionTimeout = 30 * 60 * 1000; // 30 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupSessions();
    }, 10 * 60 * 1000); // Cleanup every 10 minutes
  }

  /**
   * Create a new terminal session
   * @param {string} sessionId - Unique session ID
   * @param {Object} options - Terminal options
   * @returns {Object} Session information
   */
  async createSession(sessionId, options = {}) {
    try {
      // Standard options
      const defaultOptions = {
        readOnly: false,    // Only for logs/output, no input
        cols: 80,
        rows: 24,
        shell: '/bin/bash',
        cwd: '/',
        env: { ...process.env, TERM: 'xterm-256color' }
      };

      const config = { ...defaultOptions, ...options };
      let ptyProcess;

      // Flexible terminal - can execute anything
      if (config.command) {
        // Arbitrary command with arguments
        const args = config.args || [];
        ptyProcess = pty.spawn(config.command, args, {
          name: 'xterm-color',
          cols: config.cols,
          rows: config.rows,
          cwd: config.cwd,
          env: config.env
        });
      } else {
        // Standard Shell
        ptyProcess = pty.spawn(config.shell, [], {
          name: 'xterm-color',
          cols: config.cols,
          rows: config.rows,
          cwd: config.cwd,
          env: config.env
        });
      }

      // Error handling for PTY process
      ptyProcess.on('error', (error) => {
        console.error(`Terminal process error for session ${sessionId}:`, error.message);
      });

      ptyProcess.on('exit', (code, signal) => {
        console.log(`Terminal process exited for session ${sessionId}: code=${code}, signal=${signal}`);
        // Session is automatically cleaned up by socket handler
      });

      // Session saved
      const session = {
        ptyProcess,
        options: config,
        startTime: new Date(),
        lastActivity: new Date()
      };

      this.sessions.set(sessionId, session);

      return {
        sessionId,
        command: config.command || config.shell,
        args: config.args || [],
        readOnly: config.readOnly,
        cols: config.cols,
        rows: config.rows,
        cwd: config.cwd,
        created: session.startTime
      };

    } catch (error) {
      throw new Error(`Failed to create terminal session: ${error.message}`);
    }
  }

  /**
   * Get session
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Session or null
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Send data to terminal
   * @param {string} sessionId - Session ID
   * @param {string} data - Data to send
   */
  writeToSession(sessionId, data) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.options.readOnly) {
      throw new Error('Session is read-only');
    }

    session.ptyProcess.write(data);
    session.lastActivity = new Date();
  }

  /**
   * Resize terminal
   * @param {string} sessionId - Session ID
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  resizeSession(sessionId, cols, rows) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    session.ptyProcess.resize(cols, rows);
    session.options.cols = cols;
    session.options.rows = rows;
    session.lastActivity = new Date();
  }

  /**
   * End session
   * @param {string} sessionId - Session ID
   */
  killSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return false;
    }

    try {
      session.ptyProcess.kill();
    } catch (error) {
      console.warn(`Warning killing session ${sessionId}:`, error.message);
    }

    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * List all sessions
   * @returns {Array} Array of session information
   */
  listSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      sessions.push({
        sessionId,
        command: session.options.command || session.options.shell,
        args: session.options.args || [],
        readOnly: session.options.readOnly,
        startTime: session.startTime,
        lastActivity: session.lastActivity,
        cols: session.options.cols,
        rows: session.options.rows,
        cwd: session.options.cwd
      });
    }
    return sessions;
  }

  /**
   * Clean up inactive sessions
   */
  cleanupSessions() {
    const now = new Date();
    for (const [sessionId, session] of this.sessions.entries()) {
      const inactive = now - session.lastActivity;
      if (inactive > this.sessionTimeout) {
        console.log(`Cleaning up inactive terminal session: ${sessionId}`);
        this.killSession(sessionId);
      }
    }
  }

  /**
   * Service shutdown - close all sessions
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    for (const sessionId of this.sessions.keys()) {
      this.killSession(sessionId);
    }
  }


}

module.exports = new TerminalService(); 