const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./config/swagger');
const config = require('./config');
const http = require('http');
const { Server } = require('socket.io');

// Routes
const authRoutes = require('./routes/auth.routes');
const systemRoutes = require('./routes/system.routes');
const disksRoutes = require('./routes/disks.routes');
const poolsRoutes = require('./routes/pools.routes');
const dockerRoutes = require('./routes/docker.routes');
const dockerComposeRoutes = require('./routes/dockercompose.routes');
const lxcRoutes = require('./routes/lxc.routes');
const vmRoutes = require('./routes/vm.routes');
const mosRoutes = require('./routes/mos.routes');
const sharesRoutes = require('./routes/shares.routes');
const remotesRoutes = require('./routes/remotes.routes');
const iscsiRoutes = require('./routes/iscsi.routes');
const iscsiInitiatorRoutes = require('./routes/iscsi-initiator.routes');
const usersRoutes = require('./routes/users.routes');
const cronRoutes = require('./routes/cron.routes');
const terminalRoutes = require('./routes/terminal.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const hubRoutes = require('./routes/hub.routes');
const poolsWebSocketRoutes = require('./routes/websocket/pools.websocket.routes');
const systemWebSocketRoutes = require('./routes/websocket/system.websocket.routes');
const terminalWebSocketRoutes = require('./routes/websocket/terminal.websocket.routes');
const dockerWebSocketRoutes = require('./routes/websocket/docker.websocket.routes');
const disksWebSocketRoutes = require('./routes/websocket/disks.websocket.routes');

// Middleware
const { authenticateToken } = require('./middleware/auth.middleware');
const errorHandler = require('./middleware/error.middleware');

async function startServer() {
  // Load configuration
  await config.load();

  const app = express();

  // Trust proxy settings for local Nginx only
  app.set('trust proxy', '127.0.0.1');

  // Basic Middleware
  app.use(cors());
  app.use(express.json());

  // Rate Limiting
  const limiter = rateLimit({
    windowMs: (process.env.RATE_LIMIT_WINDOW || 1) * 1000,
    max: process.env.RATE_LIMIT_MAX || 20,
    // Use X-Real-IP from Nginx as it's more reliable in our setup
    keyGenerator: (req) => req.headers['x-real-ip'] || req.ip,
    standardHeaders: true,
    legacyHeaders: false
  });
  app.use(limiter);

  // Swagger Documentation Route
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'MOS API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true
    }
  }));

  /**
   * @swagger
   * /swagger.json:
   *   get:
   *     summary: Swagger JSON Specification
   *     description: Get the raw OpenAPI 3.0 JSON specification for this API
   *     tags: [API]
   *     responses:
   *       200:
   *         description: OpenAPI 3.0 JSON specification
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               description: Complete OpenAPI 3.0 specification
   *               properties:
   *                 openapi:
   *                   type: string
   *                   example: "3.0.0"
   *                 info:
   *                   type: object
   *                   properties:
   *                     title:
   *                       type: string
   *                       example: "MOS API"
   *                     version:
   *                       type: string
   *                       example: "1.0.0"
   *                 paths:
   *                   type: object
   *                   description: All API endpoints
   *                 components:
   *                   type: object
   *                   description: Reusable components (schemas, responses, etc.)
   */

  // Swagger JSON endpoint
  app.get('/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpecs);
  });

  // Routes
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/system', authenticateToken, systemRoutes);
  app.use('/api/v1/disks', authenticateToken, disksRoutes);
  app.use('/api/v1/pools', authenticateToken, poolsRoutes);
  app.use('/api/v1/docker/mos/compose', authenticateToken, dockerComposeRoutes);
  app.use('/api/v1/docker', authenticateToken, dockerRoutes);
  app.use('/api/v1/lxc', authenticateToken, lxcRoutes);
  app.use('/api/v1/vm', authenticateToken, vmRoutes);
  app.use('/api/v1/mos', authenticateToken, mosRoutes);
  app.use('/api/v1/mos/hub', authenticateToken, hubRoutes);
  app.use('/api/v1/shares', authenticateToken, sharesRoutes);
  app.use('/api/v1/remotes', authenticateToken, remotesRoutes);
  app.use('/api/v1/iscsi', authenticateToken, iscsiRoutes);
  app.use('/api/v1/iscsi/initiator', authenticateToken, iscsiInitiatorRoutes);
  app.use('/api/v1/users', authenticateToken, usersRoutes);
  app.use('/api/v1/cron', authenticateToken, cronRoutes);
  app.use('/api/v1/terminal', authenticateToken, terminalRoutes);
  app.use('/api/v1/notifications', authenticateToken, notificationsRoutes);
  app.use('/api/v1/pools', poolsWebSocketRoutes);
  app.use('/api/v1/system', systemWebSocketRoutes);
  app.use('/api/v1/terminal', terminalWebSocketRoutes);
  app.use('/api/v1/docker', dockerWebSocketRoutes);
  app.use('/api/v1/disks', disksWebSocketRoutes);

  // Error Handling
  app.use(errorHandler);

  /**
   * @swagger
   * tags:
   *   name: API
   *   description: Core API endpoints and utilities
   *
   * components:
   *   schemas:
   *     HealthCheck:
   *       type: object
   *       properties:
   *         status:
   *           type: string
   *           description: API health status
   *           example: "OK"
   *         timestamp:
   *           type: string
   *           format: date-time
   *           description: Current server timestamp
   *           example: "2024-01-20T10:30:00.000Z"
   *         documentation:
   *           type: string
   *           description: Link to API documentation
   *           example: "/api-docs"
   */

  /**
   * @swagger
   * /:
   *   get:
   *     summary: API Documentation Redirect
   *     description: Redirects to the Swagger API documentation interface
   *     tags: [API]
   *     responses:
   *       302:
   *         description: Redirect to API documentation
   *         headers:
   *           Location:
   *             schema:
   *               type: string
   *               example: "/api-docs"
   */

  // Root redirect zu API-Dokumentation
  app.get('/', (req, res) => {
    res.redirect('/api-docs');
  });

  /**
   * @swagger
   * /health:
   *   get:
   *     summary: Health Check
   *     description: Check API server health and availability
   *     tags: [API]
   *     responses:
   *       200:
   *         description: API is healthy and operational
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthCheck'
   *             example:
   *               status: "OK"
   *               timestamp: "2024-01-20T10:30:00.000Z"
   *               documentation: "/api-docs"
   *       500:
   *         description: API server error
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   example: "ERROR"
   *                 error:
   *                   type: string
   *                   example: "Internal server error"
   */

  // Health Check
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      documentation: '/api-docs'
    });
  });

  const PORT = process.env.PORT || 3000;

  // Create HTTP server for Socket.io
  const server = http.createServer(app);

  // Initialize Socket.io
  const io = new Server(server, {
    path: "/api/v1/socket.io/",
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Setup Socket.io handlers
  const terminalService = require('./services/terminal.service');
  const systemService = require('./services/system.service');
  const dockerService = require('./services/docker.service');
  const dockerComposeService = require('./services/dockercompose.service');
  const PoolWebSocketManager = require('./websockets/pools.websocket');
  const SystemLoadWebSocketManager = require('./websockets/system.websocket');
  const TerminalWebSocketManager = require('./websockets/terminal.websocket');
  const DockerWebSocketManager = require('./websockets/docker.websocket');
  const DisksWebSocketManager = require('./websockets/disks.websocket');

  // Initialize event emitter for service communication
  const EventEmitter = require('events');
  const serviceEventEmitter = new EventEmitter();

  // Create separate namespaces to avoid interference
  const poolsNamespace = io.of('/pools');
  const systemNamespace = io.of('/system');
  const terminalNamespace = io.of('/terminal');
  const dockerNamespace = io.of('/docker');
  const disksNamespace = io.of('/disks');

  // Initialize pool WebSocket manager with pools namespace
  const PoolsService = require('./services/pools.service');

  // Create a simple wrapper for WebSocket compatibility
  class PoolsServiceWebSocketWrapper {
    constructor(eventEmitter) {
      this.poolsService = new PoolsService(eventEmitter);
    }

    async listPools(filters = {}) {
      return await this.poolsService.listPools(filters);
    }

    async getPoolById(id) {
      const pools = await this.listPools();
      return pools.find(p => p.id === id);
    }

    async getPoolStatus(poolId) {
      const pool = await this.getPoolById(poolId);
      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }
      return await this.poolsService._getPoolStatus(pool);
    }
  }

  // Initialize Disks service (shared between pool and disks WebSocket managers)
  // Note: disks.service exports a singleton instance, not a class
  const disksServiceInstance = require('./services/disks.service');

  const poolsServiceInstance = new PoolsServiceWebSocketWrapper(serviceEventEmitter);
  // Pass disksService to pool WebSocket manager for performance monitoring
  const poolWebSocketManager = new PoolWebSocketManager(poolsNamespace, poolsServiceInstance, disksServiceInstance);

  // Initialize system load WebSocket manager with system namespace
  // Pass poolsService and disksService for dashboard pools performance monitoring
  const systemLoadWebSocketManager = new SystemLoadWebSocketManager(
    systemNamespace,
    systemService,
    poolsServiceInstance,
    disksServiceInstance
  );

  // Initialize terminal WebSocket manager with terminal namespace
  const terminalWebSocketManager = new TerminalWebSocketManager(terminalNamespace, terminalService);

  // Initialize Docker WebSocket manager with docker namespace
  const dockerWebSocketManager = new DockerWebSocketManager(dockerNamespace, dockerService, dockerComposeService);

  // Initialize Disks WebSocket manager with disks namespace
  const disksWebSocketManager = new DisksWebSocketManager(disksNamespace, disksServiceInstance);

  // Make WebSocket managers available to routes
  app.locals.poolWebSocketManager = poolWebSocketManager;
  app.locals.systemLoadWebSocketManager = systemLoadWebSocketManager;
  app.locals.terminalWebSocketManager = terminalWebSocketManager;
  app.locals.dockerWebSocketManager = dockerWebSocketManager;
  app.locals.disksWebSocketManager = disksWebSocketManager;

  // Setup namespace handlers
  poolsNamespace.on('connection', (socket) => {
    console.info(`Pools WebSocket client connected: ${socket.id}`);
    poolWebSocketManager.handleConnection(socket);
  });

  systemNamespace.on('connection', (socket) => {
    console.info(`System Load WebSocket client connected: ${socket.id}`);
    systemLoadWebSocketManager.handleConnection(socket);
  });

  // Terminal namespace for terminal connections
  terminalNamespace.on('connection', (socket) => {
    console.info(`Terminal WebSocket client connected: ${socket.id}`);
    terminalWebSocketManager.handleConnection(socket);
  });

  // Docker namespace for Docker operations
  dockerNamespace.on('connection', (socket) => {
    console.info(`Docker WebSocket client connected: ${socket.id}`);
    dockerWebSocketManager.handleConnection(socket);
  });

  // Disks namespace for disk I/O and temperature monitoring
  disksNamespace.on('connection', (socket) => {
    console.info(`Disks WebSocket client connected: ${socket.id}`);
    disksWebSocketManager.handleConnection(socket);
  });

  server.listen(PORT, '0.0.0.0', async () => {
    console.info(`API running on port ${PORT}`);

    // Initialize Startup-Caches after server start
    try {
      const disksService = require('./services/disks.service');
      await disksService.initializeStartupCache({ wakeStandbyDisks: false });
    } catch (error) {
      console.error(`Error initializing Disk Startup-Cache: ${error.message}`);
    }

    // Initialize Pools after server start
    try {
      const PoolsService = require('./services/pools.service');
      const poolsService = new PoolsService();
      await poolsService.listPools();
    } catch (error) {
      console.error(`Error initializing Pools: ${error.message}`);
    }
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});

// Graceful shutdown - end Terminal-Sessions
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  const terminalService = require('./services/terminal.service');
  terminalService.shutdown();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  const terminalService = require('./services/terminal.service');
  terminalService.shutdown();
  process.exit(0);
});
