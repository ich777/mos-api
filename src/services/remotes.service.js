const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const crypto = require('crypto');

// Timestamp-basierter ID-Generator
const generateId = () => Date.now().toString();

class RemotesService {
  constructor() {
    this.remotesFile = '/boot/config/remotes.json';
    this.mountBasePath = '/mnt/remotes';
  }

  /**
   * Check if remote mounting is enabled in network settings
   * @returns {Promise<boolean>} True if remote mounting is enabled
   * @private
   */
  async _isRemoteMountingEnabled() {
    try {
      const MosService = require('./mos.service');
      const mosService = new MosService();
      const networkSettings = await mosService.getNetworkSettings();

      // Return the actual enabled status from services section
      return networkSettings.services?.remote_mounting?.enabled === true;
    } catch (error) {
      console.warn('Failed to check remote mounting setting, defaulting to disabled:', error.message);
      return false; // Default to disabled if we can't read settings
    }
  }

  /**
   * Encrypt password using JWT_SECRET
   * @param {string} plainPassword - Plain text password
   * @returns {string} Encrypted password in format "iv:authTag:encrypted"
   * @private
   */
  _encryptPassword(plainPassword) {
    if (!plainPassword) return '';

    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(process.env.JWT_SECRET, 'remotes-salt', 32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipher(algorithm, key);
    cipher.setAAD(Buffer.from('remotes-auth'));

    let encrypted = cipher.update(plainPassword, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt password using JWT_SECRET
   * @param {string} encryptedPassword - Encrypted password in format "iv:authTag:encrypted"
   * @returns {string} Plain text password
   * @private
   */
  _decryptPassword(encryptedPassword) {
    if (!encryptedPassword) return '';

    try {
      const [ivHex, authTagHex, encrypted] = encryptedPassword.split(':');
      if (!ivHex || !authTagHex || !encrypted) {
        throw new Error('Invalid encrypted password format');
      }

      const algorithm = 'aes-256-gcm';
      const key = crypto.scryptSync(process.env.JWT_SECRET, 'remotes-salt', 32);
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipher(algorithm, key);
      decipher.setAuthTag(authTag);
      decipher.setAAD(Buffer.from('remotes-auth'));

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(`Failed to decrypt password: ${error.message}`);
    }
  }

  /**
   * Generate mount path for remote share
   * @param {string} server - Server IP or hostname
   * @param {string} share - Share name
   * @returns {string} Mount path
   * @private
   */
  _generateMountPath(server, share) {
    // Sanitize server and share names for filesystem
    const cleanServer = server.replace(/[^a-zA-Z0-9.-]/g, '_');
    const cleanShare = share.replace(/[^a-zA-Z0-9_-]/g, '_');

    return path.join(this.mountBasePath, cleanServer, cleanShare);
  }

  /**
   * Validate remote data
   * @param {Object} data - Remote data to validate
   * @throws {Error} If validation fails
   * @private
   */
  _validateRemoteData(data) {
    const required = ['name', 'type', 'server', 'share', 'username', 'password'];

    for (const field of required) {
      if (!data[field] || data[field].toString().trim() === '') {
        throw new Error(`Field '${field}' is required`);
      }
    }

    if (!['smb', 'nfs'].includes(data.type)) {
      throw new Error("Type must be 'smb' or 'nfs'");
    }

    if (data.type === 'smb' && data.version && !['1.0', '2.0', '3.0'].includes(data.version)) {
      throw new Error("SMB version must be '1.0', '2.0', or '3.0'");
    }

    // Validate uid/gid if provided
    if (data.uid !== undefined && data.uid !== null && (!Number.isInteger(data.uid) || data.uid < 0)) {
      throw new Error('UID must be a positive integer or null');
    }

    if (data.gid !== undefined && data.gid !== null && (!Number.isInteger(data.gid) || data.gid < 0)) {
      throw new Error('GID must be a positive integer or null');
    }

    // Validate server format (IP or hostname)
    const serverRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^[a-zA-Z0-9.-]+$/;
    if (!serverRegex.test(data.server)) {
      throw new Error('Invalid server format');
    }
  }

  /**
   * Create mount point directory
   * @param {string} mountPath - Path to create
   * @private
   */
  async _createMountPoint(mountPath) {
    try {
      await fs.mkdir(mountPath, { recursive: true });
      console.log(`Created mount point: ${mountPath}`);
    } catch (error) {
      throw new Error(`Failed to create mount point ${mountPath}: ${error.message}`);
    }
  }

  /**
   * Check if path is mounted
   * @param {string} mountPath - Path to check
   * @returns {boolean} True if mounted
   * @private
   */
  async _isMounted(mountPath) {
    try {
      const { stdout } = await execPromise('cat /proc/mounts');
      const lines = stdout.split('\n');

      for (const line of lines) {
        const fields = line.split(' ');
        if (fields.length >= 2 && fields[1] === mountPath) {
          return true;
        }
      }
      return false;
    } catch (error) {
      console.warn(`Warning: Could not check mount status for ${mountPath}: ${error.message}`);
      return false;
    }
  }

  /**
   * Load remotes from JSON file
   * @returns {Array} Array of remote objects
   * @private
   */
  async _loadRemotes() {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.remotesFile), { recursive: true });

      const data = await fs.readFile(this.remotesFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty array
        return [];
      }
      throw new Error(`Failed to load remotes: ${error.message}`);
    }
  }

  /**
   * Save remotes to JSON file
   * @param {Array} remotes - Array of remote objects
   * @private
   */
  async _saveRemotes(remotes) {
    try {
      await fs.mkdir(path.dirname(this.remotesFile), { recursive: true });
      await fs.writeFile(this.remotesFile, JSON.stringify(remotes, null, 2));
    } catch (error) {
      throw new Error(`Failed to save remotes: ${error.message}`);
    }
  }

  /**
   * List all remotes
   * @returns {Array} Array of remote objects with current status and masked password
   */
  async listRemotes() {
    try {
      const remotes = await this._loadRemotes();

      // Update status and mask password for each remote
      for (const remote of remotes) {
        const mountPath = this._generateMountPath(remote.server, remote.share);
        const isMounted = await this._isMounted(mountPath);
        remote.status = isMounted ? 'mounted' : 'unmounted';
        remote.password = 'SECRET'; // Mask password in responses
      }

      return remotes;
    } catch (error) {
      throw new Error(`Failed to list remotes: ${error.message}`);
    }
  }

  /**
   * Get remote by ID
   * @param {string} id - Remote ID
   * @returns {Object} Remote object with current status and masked password
   */
  async getRemoteById(id) {
    try {
      const remotes = await this._loadRemotes();
      const remote = remotes.find(r => r.id === id);

      if (!remote) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      // Update status and mask password
      const mountPath = this._generateMountPath(remote.server, remote.share);
      const isMounted = await this._isMounted(mountPath);
      remote.status = isMounted ? 'mounted' : 'unmounted';
      remote.password = 'SECRET'; // Mask password in responses

      return remote;
    } catch (error) {
      throw new Error(`Failed to get remote: ${error.message}`);
    }
  }

  /**
   * Create a new remote share configuration
   * @param {Object} data - Remote share data
   * @returns {Object} Created remote
   */
  async createRemote(data) {
    // Check if remote mounting is enabled
    const remoteMountingEnabled = await this._isRemoteMountingEnabled();
    if (!remoteMountingEnabled) {
      throw new Error('Remote mounting is disabled in network settings');
    }

    try {
      // Validate input data
      this._validateRemoteData(data);

      const remotes = await this._loadRemotes();

      // Check for duplicate names
      if (remotes.some(r => r.name === data.name)) {
        throw new Error(`Remote with name '${data.name}' already exists`);
      }

      // Create new remote object (status is dynamic, not stored)
      const remote = {
        id: generateId(),
        name: data.name.trim(),
        type: data.type,
        server: data.server.trim(),
        share: data.share.trim(),
        username: data.username.trim(),
        password: this._encryptPassword(data.password),
        domain: data.domain ? data.domain.trim() : null,
        version: data.version || (data.type === 'smb' ? '3.0' : null),
        uid: data.uid !== undefined ? data.uid : null,
        gid: data.gid !== undefined ? data.gid : null,
        auto_mount: data.auto_mount || false
      };

      remotes.push(remote);
      await this._saveRemotes(remotes);

      console.log(`Created remote: ${remote.name} (${remote.id})`);
      return remote;
    } catch (error) {
      throw new Error(`Failed to create remote: ${error.message}`);
    }
  }

  /**
   * Update remote
   * @param {string} id - Remote ID
   * @param {Object} updateData - Data to update
   * @returns {Object} Updated remote object
   */
  async updateRemote(id, updateData) {
    try {
      const remotes = await this._loadRemotes();
      const remoteIndex = remotes.findIndex(r => r.id === id);

      if (remoteIndex === -1) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      const remote = remotes[remoteIndex];

      // Check if remote is mounted - prevent updates to critical fields
      const mountPath = this._generateMountPath(remote.server, remote.share);
      const isMounted = await this._isMounted(mountPath);

      if (isMounted && (updateData.server || updateData.share || updateData.type)) {
        throw new Error('Cannot update server, share, or type while remote is mounted. Unmount first.');
      }

      // Validate updated data
      const updatedRemote = { ...remote, ...updateData };
      this._validateRemoteData(updatedRemote);

      // Check for duplicate names (excluding current remote)
      if (updateData.name && remotes.some(r => r.id !== id && r.name === updateData.name)) {
        throw new Error(`Remote with name '${updateData.name}' already exists`);
      }

      // Update fields
      if (updateData.name) remote.name = updateData.name.trim();
      if (updateData.type) remote.type = updateData.type;
      if (updateData.server) remote.server = updateData.server.trim();
      if (updateData.share) remote.share = updateData.share.trim();
      if (updateData.username) remote.username = updateData.username.trim();
      if (updateData.password) remote.password = this._encryptPassword(updateData.password);
      if (updateData.domain !== undefined) remote.domain = updateData.domain ? updateData.domain.trim() : null;
      if (updateData.version) remote.version = updateData.version;
      if (updateData.uid !== undefined) remote.uid = updateData.uid;
      if (updateData.gid !== undefined) remote.gid = updateData.gid;
      if (updateData.auto_mount !== undefined) remote.auto_mount = updateData.auto_mount;

      remotes[remoteIndex] = remote;
      await this._saveRemotes(remotes);

      console.log(`Updated remote: ${remote.name} (${remote.id})`);
      return remote;
    } catch (error) {
      throw new Error(`Failed to update remote: ${error.message}`);
    }
  }

  /**
   * Delete remote
   * @param {string} id - Remote ID
   * @returns {Object} Deleted remote object
   */
  async deleteRemote(id) {
    try {
      const remotes = await this._loadRemotes();
      const remoteIndex = remotes.findIndex(r => r.id === id);

      if (remoteIndex === -1) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      const remote = remotes[remoteIndex];

      // Check if remote is mounted
      const mountPath = this._generateMountPath(remote.server, remote.share);
      const isMounted = await this._isMounted(mountPath);

      if (isMounted) {
        throw new Error('Cannot delete mounted remote. Unmount first.');
      }

      // Remove from array
      remotes.splice(remoteIndex, 1);
      await this._saveRemotes(remotes);

      // Clean up empty mount point directory
      try {
        await fs.rmdir(mountPath);
        console.log(`Removed empty mount point: ${mountPath}`);
      } catch (error) {
        // Ignore errors - directory might not be empty or not exist
      }

      console.log(`Deleted remote: ${remote.name} (${remote.id})`);
      return remote;
    } catch (error) {
      throw new Error(`Failed to delete remote: ${error.message}`);
    }
  }

  /**
   * Mount a remote share
   * @param {string} id - Remote ID
   * @returns {Object} Mount result
   */
  async mountRemote(id) {
    // Check if remote mounting is enabled
    const remoteMountingEnabled = await this._isRemoteMountingEnabled();
    if (!remoteMountingEnabled) {
      throw new Error('Remote mounting is disabled in network settings');
    }

    try {
      const remotes = await this._loadRemotes();
      const remote = remotes.find(r => r.id === id);

      if (!remote) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      const mountPath = this._generateMountPath(remote.server, remote.share);

      // Check if already mounted
      if (await this._isMounted(mountPath)) {
        throw new Error('Remote is already mounted');
      }

      // Create mount point
      await this._createMountPoint(mountPath);

      // Decrypt password
      const password = this._decryptPassword(remote.password);

      let mountCommand;

      if (remote.type === 'smb') {
        // Build SMB mount command
        const server = remote.server;
        const share = remote.share;
        const username = remote.username;
        const domain = remote.domain;
        const version = remote.version || '3.0';

        let options = `username=${username},password=${password},vers=${version}`;
        if (domain) {
          options += `,domain=${domain}`;
        }

        // Add uid/gid if specified (null means root)
        if (remote.uid !== null) {
          options += `,uid=${remote.uid}`;
        }
        if (remote.gid !== null) {
          options += `,gid=${remote.gid}`;
        }

        mountCommand = `mount -t cifs //${server}/${share} "${mountPath}" -o ${options}`;
      } else if (remote.type === 'nfs') {
        // Build NFS mount command
        const server = remote.server;
        const share = remote.share;

        let options = 'vers=4,rsize=1048576,wsize=1048576,hard,intr,timeo=600';

        // Add uid/gid if specified (null means root)
        if (remote.uid !== null) {
          options += `,uid=${remote.uid}`;
        }
        if (remote.gid !== null) {
          options += `,gid=${remote.gid}`;
        }

        mountCommand = `mount -t nfs ${server}:/${share} "${mountPath}" -o ${options}`;
      } else {
        throw new Error(`Unsupported remote type: ${remote.type}`);
      }

      console.log(`Mounting remote: ${remote.name}`);
      await execPromise(mountCommand);

      console.log(`Successfully mounted remote: ${remote.name} at ${mountPath}`);
      return {
        success: true,
        message: `Remote '${remote.name}' mounted successfully`,
        mountPath: mountPath
      };
    } catch (error) {
      throw new Error(`Failed to mount remote: ${error.message}`);
    }
  }

  /**
   * Unmount remote share
   * @param {string} id - Remote ID
   * @returns {Object} Unmount result
   */
  async unmountRemote(id) {
    try {
      const remotes = await this._loadRemotes();
      const remote = remotes.find(r => r.id === id);

      if (!remote) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      const mountPath = this._generateMountPath(remote.server, remote.share);

      // Check if mounted
      if (!(await this._isMounted(mountPath))) {
        throw new Error('Remote is not mounted');
      }

      console.log(`Unmounting remote: ${remote.name}`);
      await execPromise(`umount "${mountPath}"`);

      console.log(`Successfully unmounted remote: ${remote.name}`);
      return {
        success: true,
        message: `Remote '${remote.name}' unmounted successfully`
      };
    } catch (error) {
      throw new Error(`Failed to unmount remote: ${error.message}`);
    }
  }

  /**
   * Unmount all mounted remotes
   * @returns {Promise<Object>} Result with unmounted remotes count
   */
  async unmountAllRemotes() {
    try {
      const remotes = await this.listRemotes();
      const mountedRemotes = remotes.filter(remote => remote.status === 'mounted');

      let unmountedCount = 0;
      const errors = [];

      for (const remote of mountedRemotes) {
        try {
          await this.unmountRemote(remote.id);
          unmountedCount++;
          console.log(`Unmounted remote: ${remote.name} (${remote.server}/${remote.share})`);
        } catch (error) {
          errors.push(`Failed to unmount ${remote.name}: ${error.message}`);
        }
      }

      return {
        success: true,
        message: `Unmounted ${unmountedCount} of ${mountedRemotes.length} remotes`,
        unmountedCount,
        totalMounted: mountedRemotes.length,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      throw new Error(`Failed to unmount all remotes: ${error.message}`);
    }
  }

  /**
   * Test connection to remote share without mounting
   * @param {Object} data - Remote connection data
   * @returns {Object} Test result
   */
  async connectiontest(data) {
    try {
      // Validate input data
      this._validateRemoteData(data);

      if (data.type === 'smb') {
        // Test SMB connection using smbclient
        const server = data.server;
        const share = data.share;
        const username = data.username;
        const password = data.password;
        const domain = data.domain || '';

        let smbCommand = `smbclient //${server}/${share} -U ${username}%${password} -c "ls" 2>/dev/null`;
        if (domain) {
          smbCommand = `smbclient //${server}/${share} -U ${domain}/${username}%${password} -c "ls" 2>/dev/null`;
        }

        console.log(`Testing SMB connection to ${server}/${share}`);
        await execPromise(smbCommand);

        return {
          success: true,
          message: `Successfully connected to SMB share //${server}/${share}`,
          type: 'smb'
        };
      } else if (data.type === 'nfs') {
        // Test NFS connection using showmount to check available exports
        const server = data.server;
        const share = data.share;

        console.log(`Testing NFS connection to ${server}/${share}`);

        try {
          // First check if server is reachable
          await execPromise(`ping -c 1 -W 5 ${server}`);

          // Then check if the specific share is exported
          const { stdout } = await execPromise(`showmount -e ${server} 2>/dev/null`);
          const exports = stdout.split('\n');

          // Check if our share is in the exports list
          const shareFound = exports.some(line => {
            const exportPath = line.split(/\s+/)[0];
            return exportPath === `/${share}` || exportPath === share;
          });

          if (!shareFound) {
            throw new Error(`Share '/${share}' not found in NFS exports`);
          }

          return {
            success: true,
            message: `Successfully connected to NFS share ${server}:/${share}`,
            type: 'nfs'
          };
        } catch (showmountError) {
          // Fallback to basic ping test if showmount fails
          console.warn(`showmount failed, falling back to ping test: ${showmountError.message}`);
          await execPromise(`ping -c 1 -W 5 ${server}`);

          return {
            success: true,
            message: `NFS server ${server} is reachable (share availability not verified)`,
            type: 'nfs'
          };
        }
      } else {
        throw new Error(`Unsupported remote type: ${data.type}`);
      }
    } catch (error) {
      return {
        success: false,
        message: `Connection test failed: ${error.message}`,
        type: data.type || 'unknown'
      };
    }
  }
}

module.exports = RemotesService;
