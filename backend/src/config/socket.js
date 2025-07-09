/**
 * Socket.io configuration and event handlers
 * Manages real-time communication between clients
 */

const socketIo = require('socket.io');
const logger = require('../utils/logger');
const GameController = require('../controllers/GameController');
const RoomController = require('../controllers/RoomController');
const { validateSocketEvent } = require('../middleware/validation');
const SocketRateLimiter = require('../middleware/socketRateLimiter');

function setupSocket(server) {
  const io = socketIo(server, {
    // Performance optimizations
    transports: ['websocket'], // Only WebSocket, no polling fallback
    pingTimeout: 60000,
    pingInterval: 25000,
    
    // Enable compression
    compression: true,
    
    // Limit message size
    maxHttpBufferSize: 1e6, // 1MB
    
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  // Initialize controllers
  const gameController = new GameController(io);
  const roomController = new RoomController(io);
  const rateLimiter = new SocketRateLimiter();

  // Connection handling
  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id} from ${socket.handshake.address}`);

    // Rate limiting middleware for socket events
    socket.use((packet, next) => {
      const [eventName] = packet;
      
      if (!rateLimiter.checkLimit(socket.id, eventName)) {
        logger.warn(`Rate limit exceeded for ${socket.id} on event ${eventName}`);
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }
      
      next();
    });

    // Validation middleware for socket events
    socket.use((packet, next) => {
      const [eventName, data] = packet;
      
      // Skip validation for certain events
      const skipValidation = ['disconnect', 'ping', 'pong'];
      if (skipValidation.includes(eventName)) {
        return next();
      }

      const validation = validateSocketEvent(eventName, data);
      if (!validation.valid) {
        logger.warn(`Validation failed for ${socket.id}: ${validation.error}`);
        socket.emit('validation-error', { 
          event: eventName, 
          error: validation.error 
        });
        return;
      }
      
      // Replace original data with validated data
      packet[1] = validation.data;
      next();
    });

    // Game events
    socket.on('join-room', async (data) => {
      try {
        await roomController.joinRoom(socket, data);
      } catch (error) {
        logger.error(`Error joining room for ${socket.id}:`, error);
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    socket.on('create-room', async (data) => {
      try {
        await roomController.createRoom(socket, data);
      } catch (error) {
        logger.error(`Error creating room for ${socket.id}:`, error);
        socket.emit('error', { message: 'Failed to create room' });
      }
    });

    socket.on('leave-room', async (data) => {
      try {
        await roomController.leaveRoom(socket, data);
      } catch (error) {
        logger.error(`Error leaving room for ${socket.id}:`, error);
        socket.emit('error', { message: 'Failed to leave room' });
      }
    });

    socket.on('make-move', async (data) => {
      try {
        await gameController.makeMove(socket, data);
      } catch (error) {
        logger.error(`Error making move for ${socket.id}:`, error);
        socket.emit('error', { message: 'Failed to make move' });
      }
    });

    socket.on('chat-message', async (data) => {
      try {
        await roomController.handleChatMessage(socket, data);
      } catch (error) {
        logger.error(`Error sending chat message for ${socket.id}:`, error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    socket.on('get-room-list', async () => {
      try {
        await roomController.getRoomList(socket);
      } catch (error) {
        logger.error(`Error getting room list for ${socket.id}:`, error);
        socket.emit('error', { message: 'Failed to get room list' });
      }
    });

    socket.on('spectate-game', async (data) => {
      try {
        await roomController.spectateGame(socket, data);
      } catch (error) {
        logger.error(`Error spectating game for ${socket.id}:`, error);
        socket.emit('error', { message: 'Failed to spectate game' });
      }
    });

    // Connection management
    socket.on('disconnect', (reason) => {
      logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
      
      // Clean up player from all rooms
      roomController.handleDisconnect(socket);
      rateLimiter.cleanup(socket.id);
    });

    socket.on('error', (error) => {
      logger.error(`Socket error for ${socket.id}:`, error);
    });

    // Send welcome message
    socket.emit('connected', {
      message: 'Connected to game server',
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });
  });

  // Server-wide events
  io.engine.on('connection_error', (err) => {
    logger.error('Connection error:', err);
  });

  // Periodic cleanup
  setInterval(() => {
    rateLimiter.cleanup();
    roomController.cleanupEmptyRooms();
  }, 60000); // Every minute

  logger.info('Socket.io event handlers configured');
  return io;
}

module.exports = { setupSocket };

