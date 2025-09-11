const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const path = require('path');
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
const lxcRoutes = require('./routes/lxc.routes');
const vmRoutes = require('./routes/vm.routes');
const mosRoutes = require('./routes/mos.routes');
const sharesRoutes = require('./routes/shares.routes');
const iscsiRoutes = require('./routes/iscsi.routes');
const iscsiInitiatorRoutes = require('./routes/iscsi-initiator.routes');
const usersRoutes = require('./routes/users.routes');
const cronRoutes = require('./routes/cron.routes');
const terminalRoutes = require('./routes/terminal.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const poolsWebSocketRoutes = require('./routes/pools.websocket.routes');
const systemWebSocketRoutes = require('./routes/system.websocket.routes');
const terminalWebSocketRoutes = require('./routes/terminal.websocket.routes');

// Middleware
const { authenticateToken } = require('./middleware/auth.middleware');
const errorHandler = require('./middleware/error.middleware');

async function startServer() {
  // Load configuration
  await config.load();

  // Logger Configuration
  let logger;
  if (config.loggingEnabled) {
    logger = winston.createLogger({
      level: config.loggingLevel,
      format: winston.format.json(),
      transports: [
        new winston.transports.File({
          filename: path.join(config.loggingPath, 'api')
        })
      ]
    });

    if (process.env.NODE_ENV !== 'production') {
      logger.add(new winston.transports.Console({
        format: winston.format.simple()
      }));
    }
  } else {
    logger = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {}
    };
  }

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
  app.use('/api/v1/docker', authenticateToken, dockerRoutes);
  app.use('/api/v1/lxc', authenticateToken, lxcRoutes);
  app.use('/api/v1/vm', authenticateToken, vmRoutes);
  app.use('/api/v1/mos', authenticateToken, mosRoutes);
  app.use('/api/v1/shares', authenticateToken, sharesRoutes);
  app.use('/api/v1/iscsi', authenticateToken, iscsiRoutes);
  app.use('/api/v1/iscsi/initiator', authenticateToken, iscsiInitiatorRoutes);
  app.use('/api/v1/users', authenticateToken, usersRoutes);
  app.use('/api/v1/cron', authenticateToken, cronRoutes);
  app.use('/api/v1/terminal', authenticateToken, terminalRoutes);
  app.use('/api/v1/notifications', authenticateToken, notificationsRoutes);
  app.use('/api/v1/pools', poolsWebSocketRoutes);
  app.use('/api/v1/system', systemWebSocketRoutes);
  app.use('/api/v1/terminal', terminalWebSocketRoutes);

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
    path: "/socket.io/",
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Setup Socket.io handlers
  const terminalService = require('./services/terminal.service');
  const poolsService = require('./services/pools.service');
  const { PoolsService } = poolsService;
  const systemService = require('./services/system.service');
  const PoolWebSocketManager = require('./websockets/pools.websocket');
  const SystemLoadWebSocketManager = require('./websockets/system.websocket');
  const TerminalWebSocketManager = require('./websockets/terminal.websocket');

  // Initialize event emitter for service communication
  const EventEmitter = require('events');
  const serviceEventEmitter = new EventEmitter();

  // Create separate namespaces to avoid interference
  const poolsNamespace = io.of('/api/v1/pools');
  const systemNamespace = io.of('/api/v1/system');
  const terminalNamespace = io.of('/api/v1/terminal');

  // Initialize pool WebSocket manager with pools namespace
  const poolsServiceInstance = new PoolsService(serviceEventEmitter);
  const poolWebSocketManager = new PoolWebSocketManager(poolsNamespace, poolsServiceInstance);

  // Initialize system load WebSocket manager with system namespace
  const systemLoadWebSocketManager = new SystemLoadWebSocketManager(systemNamespace, systemService);

  // Initialize terminal WebSocket manager with terminal namespace
  const terminalWebSocketManager = new TerminalWebSocketManager(terminalNamespace, terminalService);

  // Make WebSocket managers available to routes
  app.locals.poolWebSocketManager = poolWebSocketManager;
  app.locals.systemLoadWebSocketManager = systemLoadWebSocketManager;
  app.locals.terminalWebSocketManager = terminalWebSocketManager;

  // Setup namespace handlers
  poolsNamespace.on('connection', (socket) => {
    logger.info(`Pools WebSocket client connected: ${socket.id}`);
    poolWebSocketManager.handleConnection(socket);
  });

  systemNamespace.on('connection', (socket) => {
    logger.info(`System Load WebSocket client connected: ${socket.id}`);
    systemLoadWebSocketManager.handleConnection(socket);
  });

  // Terminal namespace for terminal connections
  terminalNamespace.on('connection', (socket) => {
    logger.info(`Terminal WebSocket client connected: ${socket.id}`);
    terminalWebSocketManager.handleConnection(socket);
  });

  server.listen(PORT, '0.0.0.0', async () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`WebSocket Terminal available at: ws://localhost:${PORT}/`);
    logger.info(`Swagger Documentation available at: http://localhost:${PORT}/api-docs`);

    // Initialisiere Startup-Caches nach dem Server-Start
    try {
      const disksService = require('./services/disks.service');
      logger.info('Initialisiere Disk Startup-Cache...');
      await disksService.initializeStartupCache({ wakeStandbyDisks: false });
      logger.info('Disk Startup-Cache erfolgreich initialisiert');
    } catch (error) {
      logger.error(`Fehler beim Initialisieren des Disk Startup-Cache: ${error.message}`);
      // Nicht kritisch - API kann trotzdem laufen
    }

    // Pool-Service wurde auf neue Version umgestellt
    try {
      const poolsService = require('./services/pools.service');
      logger.info('Initialisiere Pools...');
      await poolsService.listPools();
      logger.info('Pools erfolgreich initialisiert');
    } catch (error) {
      logger.error(`Fehler beim Initialisieren der Pools: ${error.message}`);
      // Nicht kritisch - API kann trotzdem laufen
    }
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});

// Graceful shutdown - Terminal-Sessions beenden
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
