const express = require('express');
const router = express.Router();
const terminalService = require('../services/terminal.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     TerminalSession:
 *       type: object
 *       properties:
 *         sessionId:
 *           type: string
 *           description: Eindeutige Session-ID
 *           example: "terminal-1704123456789-x8f9g2k3l"
 *         command:
 *           type: string
 *           description: Ausgeführter Befehl oder Shell
 *           example: "docker"
 *         args:
 *           type: array
 *           items:
 *             type: string
 *           description: Befehl-Argumente
 *           example: ["exec", "-it", "nginx", "/bin/sh"]
 *         readOnly:
 *           type: boolean
 *           description: Ob das Terminal nur lesend ist
 *           example: false
 *         cols:
 *           type: integer
 *           description: Anzahl Spalten
 *           example: 80
 *         rows:
 *           type: integer
 *           description: Anzahl Zeilen
 *           example: 24
 *         cwd:
 *           type: string
 *           description: Arbeitsverzeichnis
 *           example: "/"
 *         created:
 *           type: string
 *           format: date-time
 *           description: Erstellungszeit
 *
 *     TerminalConfig:
 *       type: object
 *       properties:
 *         command:
 *           type: string
 *           description: |
 *             Auszuführender Befehl (optional, ohne command wird shell verwendet)
 *
 *             Beispiele:
 *             - "docker" für Container-Zugriff
 *             - "tail" für Log-Viewing
 *             - "lxc-attach" für LXC Container
 *             - "watch" für Monitoring
 *           example: "docker"
 *         args:
 *           type: array
 *           items:
 *             type: string
 *           description: |
 *             Befehl-Argumente
 *
 *             Beispiele:
 *             - ["exec", "-it", "nginx", "/bin/sh"] für Docker
 *             - ["-f", "-n", "100", "/var/log/syslog"] für tail
 *             - ["-n", "ubuntu"] für lxc-attach
 *           example: ["exec", "-it", "nginx", "/bin/sh"]
 *         shell:
 *           type: string
 *           default: "/bin/bash"
 *           description: Standard-Shell (nur wenn kein command angegeben)
 *           example: "/bin/bash"
 *         cols:
 *           type: integer
 *           minimum: 20
 *           maximum: 200
 *           default: 80
 *           description: Terminal-Breite in Spalten
 *         rows:
 *           type: integer
 *           minimum: 10
 *           maximum: 50
 *           default: 24
 *           description: Terminal-Höhe in Zeilen
 *         cwd:
 *           type: string
 *           default: "/"
 *           description: Arbeitsverzeichnis für den Befehl
 *           example: "/home/user"
 *         readOnly:
 *           type: boolean
 *           default: false
 *           description: |
 *             Terminal nur lesend (empfohlen für Logs/Monitoring)
 *
 *             Bei readOnly=true können keine Eingaben gemacht werden
 *           example: true
 */

/**
 * @swagger
 * /terminal/sessions:
 *   get:
 *     summary: Liste alle Terminal-Sessions
 *     description: |
 *       Zeigt alle aktiven Terminal-Sessions mit Details (admin only)
 *
 *       Hilfreich für Monitoring und Session-Management.
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste der Terminal-Sessions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sessionId:
 *                         type: string
 *                       command:
 *                         type: string
 *                       args:
 *                         type: array
 *                         items:
 *                           type: string
 *                       readOnly:
 *                         type: boolean
 *                       startTime:
 *                         type: string
 *                         format: date-time
 *                       lastActivity:
 *                         type: string
 *                         format: date-time
 *                       cols:
 *                         type: integer
 *                       rows:
 *                         type: integer
 *                       cwd:
 *                         type: string
 *             example:
 *               sessions:
 *                 - sessionId: "terminal-1704123456789-x8f9g2k3l"
 *                   command: "docker"
 *                   args: ["exec", "-it", "nginx", "/bin/sh"]
 *                   readOnly: false
 *                   startTime: "2024-01-01T12:00:00.000Z"
 *                   lastActivity: "2024-01-01T12:05:00.000Z"
 *                   cols: 120
 *                   rows: 40
 *                   cwd: "/"
 *                 - sessionId: "terminal-1704123456790-y7h8j3m2p"
 *                   command: "tail"
 *                   args: ["-f", "/var/log/syslog"]
 *                   readOnly: true
 *                   startTime: "2024-01-01T11:30:00.000Z"
 *                   lastActivity: "2024-01-01T12:04:00.000Z"
 *                   cols: 80
 *                   rows: 24
 *                   cwd: "/"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/sessions', checkRole('admin'), (req, res) => {
  try {
    const sessions = terminalService.listSessions();
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /terminal/create:
 *   post:
 *     summary: Erstelle neue Terminal-Session
 *     description: |
 *       Erstellt eine neue Terminal-Session mit flexiblen Optionen (admin only)
 *
 *       **Verwendungsbeispiele:**
 *
 *       **Root Shell:**
 *       ```json
 *       {
 *         "shell": "/bin/bash",
 *         "cwd": "/",
 *         "cols": 120,
 *         "rows": 40
 *       }
 *       ```
 *
 *       **Docker Container:**
 *       ```json
 *       {
 *         "command": "docker",
 *         "args": ["exec", "-it", "nginx", "/bin/sh"]
 *       }
 *       ```
 *
 *       **LXC Container:**
 *       ```json
 *       {
 *         "command": "lxc-attach",
 *         "args": ["-n", "ubuntu", "--", "/bin/bash"]
 *       }
 *       ```
 *
 *       **Log Viewing (Read-Only):**
 *       ```json
 *       {
 *         "command": "tail",
 *         "args": ["-f", "-n", "200", "/var/log/syslog"],
 *         "readOnly": true
 *       }
 *       ```
 *
 *       **Docker Logs:**
 *       ```json
 *       {
 *         "command": "docker",
 *         "args": ["logs", "-f", "--tail", "100", "nginx"],
 *         "readOnly": true
 *       }
 *       ```
 *
 *       **System Monitoring:**
 *       ```json
 *       {
 *         "command": "htop"
 *       }
 *       ```
 *
 *       Nach der Erstellung verbinden Sie sich via WebSocket mit der Session-ID.
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TerminalConfig'
 *           examples:
 *             shell:
 *               summary: Root Shell
 *               description: Standard Bash Shell
 *               value:
 *                 shell: "/bin/bash"
 *                 cwd: "/"
 *                 cols: 120
 *                 rows: 40
 *             docker:
 *               summary: Docker Container
 *               description: Zugriff auf Docker Container
 *               value:
 *                 command: "docker"
 *                 args: ["exec", "-it", "nginx", "/bin/sh"]
 *             logs:
 *               summary: Log Viewer
 *               description: Read-Only Log Viewing
 *               value:
 *                 command: "tail"
 *                 args: ["-f", "-n", "100", "/var/log/syslog"]
 *                 readOnly: true
 *             lxc:
 *               summary: LXC Container
 *               description: LXC Container Attach
 *               value:
 *                 command: "lxc-attach"
 *                 args: ["-n", "ubuntu"]
 *     responses:
 *       201:
 *         description: Terminal-Session erfolgreich erstellt
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalSession'
 *             example:
 *               sessionId: "terminal-1704123456789-x8f9g2k3l"
 *               command: "docker"
 *               args: ["exec", "-it", "nginx", "/bin/sh"]
 *               readOnly: false
 *               cols: 80
 *               rows: 24
 *               cwd: "/"
 *               created: "2024-01-01T12:00:00.000Z"
 *       400:
 *         description: Ungültige Konfiguration oder Command nicht verfügbar
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               invalid_shell:
 *                 summary: Shell nicht verfügbar
 *                 value:
 *                   error: "Failed to create terminal session: spawn /bin/invalid ENOENT"
 *               docker_error:
 *                 summary: Docker Container nicht verfügbar
 *                 value:
 *                   error: "Failed to create terminal session: docker exec failed"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       500:
 *         $ref: '#/components/responses/InternalServerError'
 */
router.post('/create', checkRole('admin'), async (req, res) => {
  try {
    const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const session = await terminalService.createSession(sessionId, req.body);
    res.status(201).json(session);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /terminal/{sessionId}:
 *   get:
 *     summary: Terminal-Session Info
 *     description: Zeigt Informationen über eine spezifische Terminal-Session (admin only)
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal Session-ID
 *     responses:
 *       200:
 *         description: Session-Informationen
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalSession'
 *       404:
 *         description: Session nicht gefunden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/:sessionId', checkRole('admin'), (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = terminalService.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      sessionId,
      command: session.options.command || session.options.shell,
      args: session.options.args || [],
      readOnly: session.options.readOnly,
      cols: session.options.cols,
      rows: session.options.rows,
      cwd: session.options.cwd,
      startTime: session.startTime,
      lastActivity: session.lastActivity
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /terminal/{sessionId}/resize:
 *   post:
 *     summary: Terminal-Größe ändern
 *     description: Ändert die Terminal-Größe für eine Session (admin only)
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal Session-ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cols, rows]
 *             properties:
 *               cols:
 *                 type: integer
 *                 minimum: 20
 *                 maximum: 200
 *               rows:
 *                 type: integer
 *                 minimum: 10
 *                 maximum: 50
 *     responses:
 *       200:
 *         description: Terminal-Größe erfolgreich geändert
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 cols:
 *                   type: integer
 *                 rows:
 *                   type: integer
 *       400:
 *         description: Ungültige Parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Session nicht gefunden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.post('/:sessionId/resize', checkRole('admin'), (req, res) => {
  try {
    const { sessionId } = req.params;
    const { cols, rows } = req.body;

    if (!cols || !rows || cols < 20 || cols > 200 || rows < 10 || rows > 50) {
      return res.status(400).json({ error: 'Invalid cols/rows values' });
    }

    terminalService.resizeSession(sessionId, cols, rows);
    res.json({ success: true, cols, rows });
  } catch (error) {
    if (error.message === 'Session not found') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /terminal/{sessionId}:
 *   delete:
 *     summary: Terminal-Session beenden
 *     description: Beendet eine Terminal-Session (admin only)
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal Session-ID
 *     responses:
 *       200:
 *         description: Session erfolgreich beendet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       404:
 *         description: Session nicht gefunden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.delete('/:sessionId', checkRole('admin'), (req, res) => {
  try {
    const { sessionId } = req.params;
    const killed = terminalService.killSession(sessionId);

    if (!killed) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ success: true, message: 'Session terminated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



module.exports = router; 