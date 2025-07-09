/**
 * Room Controller
 * Handles room management, player connections, and chat
 */

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const logger = require('../utils/logger');
const { getDatabase } = require('../config/database');
const { sanitizeChatMessage } = require('../middleware/validation');

class RoomController {
  constructor(io) {
    this.io = io;
    this.activeRooms = new Map(); // In-memory room states
    this.playerRooms = new Map(); // Track which room each player is in
    
    logger.info('RoomController initialized');
  }

  /**
   * Create a new room
   * @param {Object} socket - Socket.io socket object
   * @param {Object} data - Room creation data
   */
  async createRoom(socket, data) {
    const { roomName, isPrivate = false, password, maxPlayers = 2 } = data;
    const playerId = socket.playerId || socket.id;
    const playerName = socket.playerName || `Player_${socket.id.substring(0, 6)}`;

    try {
      const roomId = uuidv4();
      const hashedPassword = password ? await bcrypt.hash(password, 10) : null;

      // Create room object
      const room = {
        id: roomId,
        name: roomName,
        isPrivate,
        password: hashedPassword,
        maxPlayers,
        currentPlayers: 1,
        status: 'waiting',
        createdBy: playerId,
        createdAt: Date.now(),
        players: new Map([[playerId, {
          id: playerId,
          name: playerName,
          socketId: socket.id,
          joinedAt: Date.now(),
          isReady: false
        }]]),
        spectators: new Map(),
        chatHistory: []
      };

      // Store room
      this.activeRooms.set(roomId, room);
      this.playerRooms.set(playerId, roomId);

      // Save to database
      await this.saveRoomToDatabase(room);

      // Join socket to room
      socket.join(roomId);
      socket.playerId = playerId;
      socket.playerName = playerName;
      socket.roomId = roomId;

      // Notify client
      socket.emit('room-created', {
        roomId,
        roomName,
        isPrivate,
        maxPlayers,
        currentPlayers: 1,
        players: Array.from(room.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          isReady: p.isReady
        }))
      });

      // Broadcast room list update
      this.broadcastRoomListUpdate();

      logger.info(`Room created: ${roomId} by ${playerId}`);

    } catch (error) {
      logger.error('Error creating room:', error);
      socket.emit('room-error', { 
        message: 'Failed to create room',
        code: 'CREATE_ROOM_ERROR'
      });
    }
  }

  /**
   * Join an existing room
   * @param {Object} socket - Socket.io socket object
   * @param {Object} data - Join room data
   */
  async joinRoom(socket, data) {
    const { roomId, playerName, password } = data;
    const playerId = socket.playerId || socket.id;

    try {
      // Get room
      let room = this.activeRooms.get(roomId);
      
      if (!room) {
        room = await this.loadRoomFromDatabase(roomId);
        if (!room) {
          socket.emit('room-error', { 
            message: 'Room not found',
            code: 'ROOM_NOT_FOUND'
          });
          return;
        }
        this.activeRooms.set(roomId, room);
      }

      // Check if room is full
      if (room.currentPlayers >= room.maxPlayers) {
        socket.emit('room-error', { 
          message: 'Room is full',
          code: 'ROOM_FULL'
        });
        return;
      }

      // Check password for private rooms
      if (room.isPrivate && room.password) {
        if (!password) {
          socket.emit('room-error', { 
            message: 'Password required',
            code: 'PASSWORD_REQUIRED'
          });
          return;
        }

        const passwordValid = await bcrypt.compare(password, room.password);
        if (!passwordValid) {
          socket.emit('room-error', { 
            message: 'Invalid password',
            code: 'INVALID_PASSWORD'
          });
          return;
        }
      }

      // Check if player is already in another room
      const currentRoom = this.playerRooms.get(playerId);
      if (currentRoom && currentRoom !== roomId) {
        await this.leaveRoom(socket, { roomId: currentRoom });
      }

      // Add player to room
      const player = {
        id: playerId,
        name: playerName,
        socketId: socket.id,
        joinedAt: Date.now(),
        isReady: false
      };

      room.players.set(playerId, player);
      room.currentPlayers = room.players.size;
      this.playerRooms.set(playerId, roomId);

      // Join socket to room
      socket.join(roomId);
      socket.playerId = playerId;
      socket.playerName = playerName;
      socket.roomId = roomId;

      // Update database
      await this.saveRoomToDatabase(room);

      // Notify all players in room
      this.io.to(roomId).emit('player-joined', {
        player: {
          id: player.id,
          name: player.name,
          isReady: player.isReady
        },
        currentPlayers: room.currentPlayers,
        maxPlayers: room.maxPlayers
      });

      // Send room state to joining player
      socket.emit('room-joined', {
        roomId,
        roomName: room.name,
        players: Array.from(room.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          isReady: p.isReady
        })),
        currentPlayers: room.currentPlayers,
        maxPlayers: room.maxPlayers,
        chatHistory: room.chatHistory.slice(-50) // Last 50 messages
      });

      // Check if we can start the game
      if (room.currentPlayers === 2 && room.status === 'waiting') {
        await this.checkGameStart(room);
      }

      // Broadcast room list update
      this.broadcastRoomListUpdate();

      logger.info(`Player ${playerId} joined room ${roomId}`);

    } catch (error) {
      logger.error('Error joining room:', error);
      socket.emit('room-error', { 
        message: 'Failed to join room',
        code: 'JOIN_ROOM_ERROR'
      });
    }
  }

  /**
   * Leave a room
   * @param {Object} socket - Socket.io socket object
   * @param {Object} data - Leave room data
   */
  async leaveRoom(socket, data) {
    const { roomId } = data;
    const playerId = socket.playerId || socket.id;

    try {
      const room = this.activeRooms.get(roomId);
      if (!room) {
        return; // Room doesn't exist, nothing to do
      }

      // Remove player from room
      room.players.delete(playerId);
      room.currentPlayers = room.players.size;
      this.playerRooms.delete(playerId);

      // Leave socket room
      socket.leave(roomId);

      // Notify other players
      this.io.to(roomId).emit('player-left', {
        playerId,
        playerName: socket.playerName,
        currentPlayers: room.currentPlayers
      });

      // If room is empty, clean it up
      if (room.currentPlayers === 0) {
        this.activeRooms.delete(roomId);
        await this.deleteRoomFromDatabase(roomId);
      } else {
        // Update database
        await this.saveRoomToDatabase(room);
      }

      // Broadcast room list update
      this.broadcastRoomListUpdate();

      logger.info(`Player ${playerId} left room ${roomId}`);

    } catch (error) {
      logger.error('Error leaving room:', error);
    }
  }

  /**
   * Handle chat message
   * @param {Object} socket - Socket.io socket object
   * @param {Object} data - Chat message data
   */
  async handleChatMessage(socket, data) {
    const { message, roomId } = data;
    const playerId = socket.playerId || socket.id;
    const playerName = socket.playerName || `Player_${socket.id.substring(0, 6)}`;

    try {
      const room = this.activeRooms.get(roomId);
      if (!room) {
        socket.emit('chat-error', { 
          message: 'Room not found',
          code: 'ROOM_NOT_FOUND'
        });
        return;
      }

      // Check if player is in the room
      if (!room.players.has(playerId) && !room.spectators.has(playerId)) {
        socket.emit('chat-error', { 
          message: 'You are not in this room',
          code: 'NOT_IN_ROOM'
        });
        return;
      }

      // Sanitize message
      const sanitizedMessage = sanitizeChatMessage(message);
      if (!sanitizedMessage) {
        socket.emit('chat-error', { 
          message: 'Invalid message',
          code: 'INVALID_MESSAGE'
        });
        return;
      }

      // Create chat message object
      const chatMessage = {
        id: uuidv4(),
        playerId,
        playerName,
        message: sanitizedMessage,
        timestamp: Date.now(),
        roomId
      };

      // Add to room chat history
      room.chatHistory.push(chatMessage);
      
      // Keep only last 100 messages
      if (room.chatHistory.length > 100) {
        room.chatHistory = room.chatHistory.slice(-100);
      }

      // Save to database
      await this.saveChatMessageToDatabase(chatMessage);

      // Broadcast to all players in room
      this.io.to(roomId).emit('chat-message', {
        id: chatMessage.id,
        playerId,
        playerName,
        message: sanitizedMessage,
        timestamp: chatMessage.timestamp
      });

      logger.info(`Chat message in room ${roomId} from ${playerId}: ${sanitizedMessage.substring(0, 50)}`);

    } catch (error) {
      logger.error('Error handling chat message:', error);
      socket.emit('chat-error', { 
        message: 'Failed to send message',
        code: 'CHAT_ERROR'
      });
    }
  }

  /**
   * Get list of available rooms
   * @param {Object} socket - Socket.io socket object
   */
  async getRoomList(socket) {
    try {
      const rooms = Array.from(this.activeRooms.values())
        .filter(room => !room.isPrivate && room.status === 'waiting')
        .map(room => ({
          id: room.id,
          name: room.name,
          currentPlayers: room.currentPlayers,
          maxPlayers: room.maxPlayers,
          status: room.status,
          createdAt: room.createdAt
        }));

      socket.emit('room-list', { rooms });

    } catch (error) {
      logger.error('Error getting room list:', error);
      socket.emit('room-error', { 
        message: 'Failed to get room list',
        code: 'ROOM_LIST_ERROR'
      });
    }
  }

  /**
   * Spectate a game
   * @param {Object} socket - Socket.io socket object
   * @param {Object} data - Spectate data
   */
  async spectateGame(socket, data) {
    const { roomId } = data;
    const spectatorId = socket.id;

    try {
      const room = this.activeRooms.get(roomId);
      if (!room) {
        socket.emit('room-error', { 
          message: 'Room not found',
          code: 'ROOM_NOT_FOUND'
        });
        return;
      }

      // Add as spectator
      room.spectators.set(spectatorId, {
        id: spectatorId,
        socketId: socket.id,
        joinedAt: Date.now()
      });

      // Join socket to room
      socket.join(roomId);
      socket.isSpectator = true;
      socket.roomId = roomId;

      // Send current game state
      socket.emit('spectating-started', {
        roomId,
        roomName: room.name,
        players: Array.from(room.players.values()).map(p => ({
          id: p.id,
          name: p.name
        })),
        spectatorCount: room.spectators.size
      });

      logger.info(`Spectator ${spectatorId} joined room ${roomId}`);

    } catch (error) {
      logger.error('Error spectating game:', error);
      socket.emit('room-error', { 
        message: 'Failed to spectate game',
        code: 'SPECTATE_ERROR'
      });
    }
  }

  /**
   * Handle player disconnect
   * @param {Object} socket - Socket.io socket object
   */
  async handleDisconnect(socket) {
    const playerId = socket.playerId || socket.id;
    const roomId = this.playerRooms.get(playerId);

    if (roomId) {
      await this.leaveRoom(socket, { roomId });
    }

    // Remove from spectators if applicable
    for (const [id, room] of this.activeRooms.entries()) {
      if (room.spectators.has(socket.id)) {
        room.spectators.delete(socket.id);
        break;
      }
    }
  }

  /**
   * Check if game can start
   * @param {Object} room - Room object
   */
  async checkGameStart(room) {
    if (room.currentPlayers === 2 && room.status === 'waiting') {
      room.status = 'playing';
      
      // Get GameController and start game
      const GameController = require('./GameController');
      const gameController = new GameController(this.io);
      
      const players = Array.from(room.players.values());
      await gameController.startGame(room.id, players);
      
      await this.saveRoomToDatabase(room);
    }
  }

  /**
   * Broadcast room list update to all clients
   */
  broadcastRoomListUpdate() {
    const rooms = Array.from(this.activeRooms.values())
      .filter(room => !room.isPrivate && room.status === 'waiting')
      .map(room => ({
        id: room.id,
        name: room.name,
        currentPlayers: room.currentPlayers,
        maxPlayers: room.maxPlayers,
        status: room.status,
        createdAt: room.createdAt
      }));

    this.io.emit('room-list-update', { rooms });
  }

  /**
   * Clean up empty rooms
   */
  cleanupEmptyRooms() {
    const now = Date.now();
    const maxEmptyTime = 5 * 60 * 1000; // 5 minutes

    for (const [roomId, room] of this.activeRooms.entries()) {
      if (room.currentPlayers === 0 && (now - room.createdAt) > maxEmptyTime) {
        this.activeRooms.delete(roomId);
        this.deleteRoomFromDatabase(roomId);
        logger.info(`Cleaned up empty room: ${roomId}`);
      }
    }
  }

  // Database operations
  async saveRoomToDatabase(room) {
    try {
      const db = getDatabase();
      await db.run(`
        INSERT OR REPLACE INTO rooms (
          id, name, is_private, password, max_players, current_players, 
          status, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        room.id,
        room.name,
        room.isPrivate,
        room.password,
        room.maxPlayers,
        room.currentPlayers,
        room.status,
        room.createdBy,
        new Date(room.createdAt).toISOString()
      ]);
    } catch (error) {
      logger.error('Error saving room to database:', error);
    }
  }

  async loadRoomFromDatabase(roomId) {
    try {
      const db = getDatabase();
      const roomData = await db.get('SELECT * FROM rooms WHERE id = ?', [roomId]);
      
      if (!roomData) {
        return null;
      }

      return {
        id: roomData.id,
        name: roomData.name,
        isPrivate: roomData.is_private,
        password: roomData.password,
        maxPlayers: roomData.max_players,
        currentPlayers: 0, // Will be updated when players reconnect
        status: roomData.status,
        createdBy: roomData.created_by,
        createdAt: new Date(roomData.created_at).getTime(),
        players: new Map(),
        spectators: new Map(),
        chatHistory: []
      };
    } catch (error) {
      logger.error('Error loading room from database:', error);
      return null;
    }
  }

  async deleteRoomFromDatabase(roomId) {
    try {
      const db = getDatabase();
      await db.run('DELETE FROM rooms WHERE id = ?', [roomId]);
    } catch (error) {
      logger.error('Error deleting room from database:', error);
    }
  }

  async saveChatMessageToDatabase(chatMessage) {
    try {
      const db = getDatabase();
      await db.run(`
        INSERT INTO chat_messages (room_id, player_id, message, timestamp)
        VALUES (?, ?, ?, ?)
      `, [
        chatMessage.roomId,
        chatMessage.playerId,
        chatMessage.message,
        new Date(chatMessage.timestamp).toISOString()
      ]);
    } catch (error) {
      logger.error('Error saving chat message to database:', error);
    }
  }
}

module.exports = RoomController;

