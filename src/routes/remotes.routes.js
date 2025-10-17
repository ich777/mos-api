const express = require('express');
const router = express.Router();
const RemotesService = require('../services/remotes.service');
const { authenticateToken, checkRole } = require('../middleware/auth.middleware');

const remotesService = new RemotesService();

/**
 * @swagger
 * components:
 *   schemas:
 *     Remote:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the remote
 *           example: "1695123456789"
 *         name:
 *           type: string
 *           description: User-friendly name for the remote
 *           example: "NAS Media Share"
 *         type:
 *           type: string
 *           enum: [smb, nfs]
 *           description: Type of remote share
 *           example: "smb"
 *         server:
 *           type: string
 *           description: Server IP address or hostname
 *           example: "192.168.1.100"
 *         share:
 *           type: string
 *           description: Share name
 *           example: "media"
 *         username:
 *           type: string
 *           description: Username for authentication
 *           example: "nasuser"
 *         password:
 *           type: string
 *           description: Masked password (always shows 'SECRET' in GET responses)
 *           example: "SECRET"
 *         domain:
 *           type: string
 *           description: SMB domain (optional)
 *           example: "WORKGROUP"
 *         version:
 *           type: string
 *           description: SMB version
 *           example: "3.0"
 *         uid:
 *           type: integer
 *           nullable: true
 *           description: User ID for mount (null means root)
 *           example: 500
 *         gid:
 *           type: integer
 *           nullable: true
 *           description: Group ID for mount (null means root)
 *           example: 500
 *         auto_mount:
 *           type: boolean
 *           description: Whether to auto-mount on boot
 *           example: true
 *         status:
 *           type: string
 *           enum: [mounted, unmounted, error]
 *           description: Current mount status
 *           example: "mounted"
 *       required:
 *         - name
 *         - type
 *         - server
 *         - share
 *         - username
 *         - password
 *
 *     RemoteInput:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: User-friendly name for the remote
 *           example: "NAS Media Share"
 *         type:
 *           type: string
 *           enum: [smb, nfs]
 *           description: Type of remote share
 *           example: "smb"
 *         server:
 *           type: string
 *           description: Server IP address or hostname
 *           example: "192.168.1.100"
 *         share:
 *           type: string
 *           description: Share name
 *           example: "media"
 *         username:
 *           type: string
 *           description: Username for authentication (optional for SMB guest access, not used for NFS)
 *           example: "nasuser"
 *         password:
 *           type: string
 *           description: Plain text password (will be encrypted, optional for SMB guest access, not used for NFS)
 *           example: "mypassword"
 *         domain:
 *           type: string
 *           description: SMB domain (optional)
 *           example: "WORKGROUP"
 *         version:
 *           type: string
 *           description: SMB version
 *           example: "3.0"
 *         uid:
 *           type: integer
 *           nullable: true
 *           description: User ID for mount (null means root)
 *           example: 500
 *         gid:
 *           type: integer
 *           nullable: true
 *           description: Group ID for mount (null means root)
 *           example: 500
 *         auto_mount:
 *           type: boolean
 *           description: Whether to auto-mount on boot
 *           example: true
 *       required:
 *         - name
 *         - type
 *         - server
 *         - share
 *
 *     ConnectionTestResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the connection test succeeded
 *           example: true
 *         message:
 *           type: string
 *           description: Result message
 *           example: "Successfully connected to SMB share //192.168.1.100/media"
 *         type:
 *           type: string
 *           description: Remote type that was tested
 *           example: "smb"
 *
 *     MountResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the operation succeeded
 *           example: true
 *         message:
 *           type: string
 *           description: Result message
 *           example: "Remote 'NAS Media Share' mounted successfully"
 *         mountPath:
 *           type: string
 *           description: Mount path (only for mount operations)
 *           example: "/mnt/remotes/192.168.1.100/media"
 */

/**
 * @swagger
 * tags:
 *   name: Remotes
 *   description: Remote share management
 */

/**
 * @swagger
 * /remotes:
 *   get:
 *     summary: List all remote shares
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of remote shares
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Remote'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       500:
 *         description: Internal server error
 */
router.get('/', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const remotes = await remotesService.listRemotes();
    res.json(remotes);
  } catch (error) {
    console.error('Error listing remotes:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /remotes/{id}:
 *   get:
 *     summary: Get remote share by ID
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Remote ID
 *     responses:
 *       200:
 *         description: Remote share details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Remote'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       404:
 *         description: Remote not found
 *       500:
 *         description: Internal server error
 */
router.get('/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const remote = await remotesService.getRemoteById(req.params.id);
    res.json(remote);
  } catch (error) {
    console.error('Error getting remote:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /remotes:
 *   post:
 *     summary: Create new remote share
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RemoteInput'
 *           examples:
 *             smb_share:
 *               summary: SMB Share Example
 *               value:
 *                 name: "NAS Media Share"
 *                 type: "smb"
 *                 server: "192.168.1.100"
 *                 share: "media"
 *                 username: "nasuser"
 *                 password: "mypassword"
 *                 domain: "WORKGROUP"
 *                 version: "3.0"
 *                 uid: 500
 *                 gid: 500
 *                 auto_mount: true
 *             nfs_share:
 *               summary: NFS Share Example
 *               value:
 *                 name: "NFS Storage"
 *                 type: "nfs"
 *                 server: "192.168.1.200"
 *                 share: "storage"
 *                 username: "nfsuser"
 *                 password: "nfspass"
 *                 uid: null
 *                 gid: null
 *                 auto_mount: false
 *     responses:
 *       201:
 *         description: Remote share created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Remote'
 *       400:
 *         description: Bad request - Invalid input data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       409:
 *         description: Conflict - Remote with same name already exists
 *       500:
 *         description: Internal server error
 */
router.post('/', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const remote = await remotesService.createRemote(req.body);
    res.status(201).json(remote);
  } catch (error) {
    console.error('Error creating remote:', error);
    if (error.message.includes('already exists')) {
      res.status(409).json({ error: error.message });
    } else if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /remotes/{id}:
 *   put:
 *     summary: Update remote share
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Remote ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RemoteInput'
 *           examples:
 *             update_name:
 *               summary: Update Name Only
 *               value:
 *                 name: "Updated NAS Share"
 *             update_credentials:
 *               summary: Update Credentials
 *               value:
 *                 username: "newuser"
 *                 password: "newpassword"
 *             update_multiple:
 *               summary: Update Multiple Fields
 *               value:
 *                 name: "Updated Share"
 *                 auto_mount: false
 *                 version: "2.0"
 *                 uid: 1000
 *                 gid: 1000
 *     responses:
 *       200:
 *         description: Remote share updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Remote'
 *       400:
 *         description: Bad request - Invalid input data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       404:
 *         description: Remote not found
 *       409:
 *         description: Conflict - Cannot update mounted remote or duplicate name
 *       500:
 *         description: Internal server error
 */
router.put('/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const remote = await remotesService.updateRemote(req.params.id, req.body);
    res.json(remote);
  } catch (error) {
    console.error('Error updating remote:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('already exists') || error.message.includes('Cannot update')) {
      res.status(409).json({ error: error.message });
    } else if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /remotes/{id}:
 *   delete:
 *     summary: Delete remote share
 *     description: Delete a remote share. If the remote is currently mounted, it will be automatically unmounted before deletion.
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Remote ID
 *     responses:
 *       200:
 *         description: Remote share deleted successfully (automatically unmounted if it was mounted)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Remote'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       404:
 *         description: Remote not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const remote = await remotesService.deleteRemote(req.params.id);
    res.json(remote);
  } catch (error) {
    console.error('Error deleting remote:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /remotes/{id}/mount:
 *   post:
 *     summary: Mount remote share
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Remote ID
 *     responses:
 *       200:
 *         description: Remote share mounted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MountResult'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       404:
 *         description: Remote not found
 *       409:
 *         description: Conflict - Remote already mounted
 *       500:
 *         description: Internal server error
 */
router.post('/:id/mount', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const result = await remotesService.mountRemote(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error mounting remote:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('already mounted')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /remotes/{id}/unmount:
 *   post:
 *     summary: Unmount remote share
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Remote ID
 *     responses:
 *       200:
 *         description: Remote share unmounted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MountResult'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       404:
 *         description: Remote not found
 *       409:
 *         description: Conflict - Remote not mounted
 *       500:
 *         description: Internal server error
 */
router.post('/:id/unmount', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const result = await remotesService.unmountRemote(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error unmounting remote:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('not mounted')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /remotes/{id}/status:
 *   get:
 *     summary: Get remote share mount status
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Remote ID
 *     responses:
 *       200:
 *         description: Remote share status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   example: "1695123456789"
 *                 name:
 *                   type: string
 *                   example: "NAS Media Share"
 *                 status:
 *                   type: string
 *                   enum: [mounted, unmounted, error]
 *                   example: "mounted"
 *                 mountPath:
 *                   type: string
 *                   example: "/mnt/remotes/192.168.1.100/media"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       404:
 *         description: Remote not found
 *       500:
 *         description: Internal server error
 */
router.get('/:id/status', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const remote = await remotesService.getRemoteById(req.params.id);
    const mountPath = remotesService._generateMountPath(remote.server, remote.share);

    res.json({
      id: remote.id,
      name: remote.name,
      status: remote.status,
      mountPath: mountPath
    });
  } catch (error) {
    console.error('Error getting remote status:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /remotes/listshares:
 *   post:
 *     summary: List all available shares from a server
 *     description: Discover all available shares from a remote server without saving credentials. For SMB, username and password are optional (uses guest access if not provided). For NFS, only server address is needed.
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - server
 *               - type
 *             properties:
 *               server:
 *                 type: string
 *                 description: Server IP address or hostname
 *                 example: "192.168.1.100"
 *               type:
 *                 type: string
 *                 enum: [smb, nfs]
 *                 description: Type of remote share
 *                 example: "smb"
 *               username:
 *                 type: string
 *                 description: Username for authentication (optional for SMB, uses guest if not provided)
 *                 example: "nasuser"
 *               password:
 *                 type: string
 *                 description: Password for authentication (optional for SMB, uses guest if not provided)
 *                 example: "mypassword"
 *               domain:
 *                 type: string
 *                 description: SMB domain (optional)
 *                 example: "WORKGROUP"
 *           examples:
 *             smb_list_authenticated:
 *               summary: List SMB Shares (Authenticated)
 *               value:
 *                 server: "192.168.1.100"
 *                 type: "smb"
 *                 username: "nasuser"
 *                 password: "mypassword"
 *                 domain: "WORKGROUP"
 *             smb_list_guest:
 *               summary: List SMB Shares (Guest Access)
 *               value:
 *                 server: "192.168.1.100"
 *                 type: "smb"
 *             nfs_list:
 *               summary: List NFS Exports
 *               value:
 *                 server: "192.168.1.200"
 *                 type: "nfs"
 *     responses:
 *       200:
 *         description: List of available shares
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *               example: ["media", "backup", "documents", "photos"]
 *       400:
 *         description: Bad request - Invalid input data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       500:
 *         description: Internal server error
 */
router.post('/listshares', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { server, type, username, password, domain } = req.body;
    const result = await remotesService.listServerShares(server, type, username, password, domain);
    res.json(result);
  } catch (error) {
    console.error('Error listing server shares:', error);
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /remotes/connectiontest:
 *   post:
 *     summary: Test connection to remote share without saving
 *     description: Test connection to a remote share.
 *     tags: [Remotes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - server
 *               - share
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [smb, nfs]
 *                 description: Type of remote share
 *                 example: "smb"
 *               server:
 *                 type: string
 *                 description: Server IP address or hostname
 *                 example: "192.168.1.100"
 *               share:
 *                 type: string
 *                 description: Share name
 *                 example: "media"
 *               username:
 *                 type: string
 *                 description: Username for authentication (optional for SMB guest access, not used for NFS)
 *                 example: "testuser"
 *               password:
 *                 type: string
 *                 description: Plain text password (optional for SMB guest access, not used for NFS)
 *                 example: "testpass"
 *               domain:
 *                 type: string
 *                 description: SMB domain (optional)
 *                 example: "WORKGROUP"
 *           examples:
 *             smb_test:
 *               summary: Test SMB Connection
 *               value:
 *                 type: "smb"
 *                 server: "192.168.1.100"
 *                 share: "media"
 *                 username: "testuser"
 *                 password: "testpass"
 *                 domain: "WORKGROUP"
 *             nfs_test:
 *               summary: Test NFS Connection
 *               value:
 *                 type: "nfs"
 *                 server: "192.168.1.200"
 *                 share: "storage"
 *     responses:
 *       200:
 *         description: Connection test result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ConnectionTestResult'
 *       400:
 *         description: Bad request - Invalid input data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       500:
 *         description: Internal server error
 */
router.post('/connectiontest', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const result = await remotesService.connectiontest(req.body);
    res.json(result);
  } catch (error) {
    console.error('Error testing connection:', error);
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

module.exports = router;
