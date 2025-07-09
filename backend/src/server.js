/**
 * Main server file for 3D Tic-Tac-Toe game
 * Handles Express.js server setup and Socket.io integration
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { setupSocket } = require('./config/socket');
const { initializeDatabase } = require('./config/database');
const logger = require('./utils/logger');

class GameServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.port = process.env.PORT || 3001;
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocket();
    this.initializeDatabase();
  }

  setupMiddleware() {
    // Security middleware
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "ws:", "wss:"],
        },
      },
    }));

    // CORS configuration for frontend-backend communication
    this.app.use(cors({
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true
    }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // limit each IP to 100 requests per windowMs
      message: 'Too many requests from this IP, please try again later.'
    });
    this.app.use(limiter);

    // Body parsing middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.env.npm_package_version || '1.0.0'
      });
    });

    // API routes
    this.app.get('/api/stats', (req, res) => {
      // TODO: Implement game statistics endpoint
      res.json({
        totalGames: 0,
        activeGames: 0,
        totalPlayers: 0,
        onlinePlayers: 0
      });
    });

    // Serve static files in production
    if (process.env.NODE_ENV === 'production') {
      this.app.use(express.static('public'));
      
      this.app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '../public/index.html'));
      });
    }

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Route not found',
        path: req.originalUrl
      });
    });

    // Error handling middleware
    this.app.use((err, req, res, next) => {
      logger.error('Server error:', err);
      
      res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' 
          ? 'Internal server error' 
          : err.message,
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
      });
    });
  }

  setupSocket() {
    this.io = setupSocket(this.server);
    logger.info('Socket.io configured successfully');
  }

  async initializeDatabase() {
    try {
      await initializeDatabase();
      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error('Database initialization failed:', error);
      process.exit(1);
    }
  }

  start() {
    this.server.listen(this.port, '0.0.0.0', () => {
      logger.info(`🚀 Game server running on port ${this.port}`);
      logger.info(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`📊 Process ID: ${process.pid}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down gracefully');
      this.server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      logger.info('SIGINT received, shutting down gracefully');
      this.server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }
}

// Start server if this file is run directly
if (require.main === module) {
  const server = new GameServer();
  server.start();
}

module.exports = GameServer;

