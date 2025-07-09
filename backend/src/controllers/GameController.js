/**
 * Game Controller
 * Handles game logic and move validation
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const GameService = require('../services/GameService');
const { getDatabase } = require('../config/database');

class GameController {
  constructor(io) {
    this.io = io;
    this.gameService = new GameService();
    this.activeGames = new Map(); // In-memory game states for fast access
    
    logger.info('GameController initialized');
  }

  /**
   * Handle a player's move
   * @param {Object} socket - Socket.io socket object
   * @param {Object} data - Move data {x, y, roomId}
   */
  async makeMove(socket, data) {
    const { x, y, roomId } = data;
    const playerId = socket.playerId || socket.id;

    try {
      logger.gameEvent('move_attempt', { playerId, x, y, roomId });

      // Get current game state
      let gameState = this.activeGames.get(roomId);
      
      if (!gameState) {
        // Try to load from database
        gameState = await this.loadGameFromDatabase(roomId);
        
        if (!gameState) {
          socket.emit('game-error', { 
            message: 'Game not found',
            code: 'GAME_NOT_FOUND'
          });
          return;
        }
        
        this.activeGames.set(roomId, gameState);
      }

      // Validate the move
      const validation = this.gameService.validateMove(gameState, playerId, x, y);
      
      if (!validation.valid) {
        socket.emit('move-rejected', {
          reason: validation.reason,
          message: validation.message
        });
        
        logger.gameEvent('move_rejected', { 
          playerId, 
          x, 
          y, 
          roomId, 
          reason: validation.reason 
        });
        return;
      }

      // Apply the move
      const moveResult = this.gameService.makeMove(gameState, playerId, x, y);
      
      if (!moveResult.success) {
        socket.emit('move-rejected', {
          reason: moveResult.reason,
          message: moveResult.message
        });
        return;
      }

      // Update game state
      gameState = moveResult.gameState;
      this.activeGames.set(roomId, gameState);

      // Save to database
      await this.saveGameToDatabase(gameState);

      // Broadcast game state update to all players in the room
      this.io.to(roomId).emit('game-state-update', {
        board: gameState.board,
        currentPlayer: gameState.currentPlayer,
        status: gameState.status,
        winner: gameState.winner,
        lastMove: {
          playerId,
          x,
          y,
          timestamp: Date.now()
        }
      });

      // Log successful move
      logger.gameEvent('move_made', { 
        playerId, 
        x, 
        y, 
        roomId, 
        gameStatus: gameState.status 
      });

      // Handle game end
      if (gameState.status === 'finished' || gameState.status === 'draw') {
        await this.handleGameEnd(gameState);
      }

    } catch (error) {
      logger.error('Error making move:', error);
      socket.emit('game-error', { 
        message: 'Failed to make move',
        code: 'MOVE_ERROR'
      });
    }
  }

  /**
   * Start a new game
   * @param {string} roomId - Room ID
   * @param {Array} players - Array of player objects
   */
  async startGame(roomId, players) {
    try {
      if (players.length !== 2) {
        throw new Error('Game requires exactly 2 players');
      }

      const gameState = this.gameService.createGame(roomId, players);
      this.activeGames.set(roomId, gameState);

      // Save to database
      await this.saveGameToDatabase(gameState);

      // Notify players that game has started
      this.io.to(roomId).emit('game-started', {
        gameId: gameState.id,
        players: gameState.players,
        currentPlayer: gameState.currentPlayer,
        board: gameState.board
      });

      logger.gameEvent('game_started', { 
        roomId, 
        gameId: gameState.id, 
        players: players.map(p => p.id) 
      });

      return gameState;

    } catch (error) {
      logger.error('Error starting game:', error);
      throw error;
    }
  }

  /**
   * Handle game end (win/draw)
   * @param {Object} gameState - Current game state
   */
  async handleGameEnd(gameState) {
    try {
      // Update player statistics
      await this.updatePlayerStats(gameState);

      // Broadcast game end
      this.io.to(gameState.roomId).emit('game-ended', {
        winner: gameState.winner,
        status: gameState.status,
        finalBoard: gameState.board,
        gameStats: {
          duration: Date.now() - gameState.startedAt,
          totalMoves: gameState.moveHistory.length
        }
      });

      // Clean up active game after a delay
      setTimeout(() => {
        this.activeGames.delete(gameState.roomId);
      }, 30000); // Keep for 30 seconds for any late requests

      logger.gameEvent('game_ended', {
        roomId: gameState.roomId,
        winner: gameState.winner,
        status: gameState.status,
        duration: Date.now() - gameState.startedAt
      });

    } catch (error) {
      logger.error('Error handling game end:', error);
    }
  }

  /**
   * Get current game state
   * @param {string} roomId - Room ID
   * @returns {Object|null} Game state or null if not found
   */
  async getGameState(roomId) {
    let gameState = this.activeGames.get(roomId);
    
    if (!gameState) {
      gameState = await this.loadGameFromDatabase(roomId);
      if (gameState) {
        this.activeGames.set(roomId, gameState);
      }
    }
    
    return gameState;
  }

  /**
   * Load game from database
   * @param {string} roomId - Room ID
   * @returns {Object|null} Game state or null if not found
   */
  async loadGameFromDatabase(roomId) {
    try {
      const db = getDatabase();
      const gameData = await db.get(
        'SELECT * FROM games WHERE room_id = ? AND status IN (?, ?)',
        [roomId, 'waiting', 'playing']
      );

      if (!gameData) {
        return null;
      }

      return {
        id: gameData.id,
        roomId: gameData.room_id,
        board: JSON.parse(gameData.board || '[[null,null,null],[null,null,null],[null,null,null]]'),
        players: {
          player1: { id: gameData.player1_id },
          player2: gameData.player2_id ? { id: gameData.player2_id } : null
        },
        currentPlayer: 'player1', // Will be updated based on move history
        status: gameData.status,
        winner: gameData.winner_id,
        moveHistory: JSON.parse(gameData.moves || '[]'),
        createdAt: new Date(gameData.created_at).getTime(),
        startedAt: gameData.started_at ? new Date(gameData.started_at).getTime() : null
      };

    } catch (error) {
      logger.error('Error loading game from database:', error);
      return null;
    }
  }

  /**
   * Save game to database
   * @param {Object} gameState - Game state to save
   */
  async saveGameToDatabase(gameState) {
    try {
      const db = getDatabase();
      
      await db.run(`
        INSERT OR REPLACE INTO games (
          id, room_id, player1_id, player2_id, winner_id, status, 
          board, moves, created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        gameState.id,
        gameState.roomId,
        gameState.players.player1?.id,
        gameState.players.player2?.id,
        gameState.winner,
        gameState.status,
        JSON.stringify(gameState.board),
        JSON.stringify(gameState.moveHistory),
        new Date(gameState.createdAt).toISOString(),
        gameState.startedAt ? new Date(gameState.startedAt).toISOString() : null,
        (gameState.status === 'finished' || gameState.status === 'draw') ? new Date().toISOString() : null
      ]);

    } catch (error) {
      logger.error('Error saving game to database:', error);
      throw error;
    }
  }

  /**
   * Update player statistics after game end
   * @param {Object} gameState - Finished game state
   */
  async updatePlayerStats(gameState) {
    try {
      const db = getDatabase();
      
      for (const [playerKey, player] of Object.entries(gameState.players)) {
        if (!player) continue;

        const isWinner = gameState.winner === player.id;
        const isDraw = gameState.status === 'draw';

        await db.run(`
          UPDATE players 
          SET games_played = games_played + 1,
              games_won = games_won + ?,
              last_seen = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [isWinner ? 1 : 0, player.id]);

        // Update rating (simple ELO-like system)
        if (!isDraw) {
          const ratingChange = isWinner ? 25 : -15;
          await db.run(`
            UPDATE players 
            SET rating = MAX(100, rating + ?)
            WHERE id = ?
          `, [ratingChange, player.id]);
        }
      }

    } catch (error) {
      logger.error('Error updating player stats:', error);
    }
  }

  /**
   * Clean up inactive games
   */
  cleanupInactiveGames() {
    const now = Date.now();
    const maxInactiveTime = 30 * 60 * 1000; // 30 minutes

    for (const [roomId, gameState] of this.activeGames.entries()) {
      const lastActivity = gameState.moveHistory.length > 0 
        ? gameState.moveHistory[gameState.moveHistory.length - 1].timestamp
        : gameState.createdAt;

      if (now - lastActivity > maxInactiveTime) {
        this.activeGames.delete(roomId);
        logger.info(`Cleaned up inactive game: ${roomId}`);
      }
    }
  }

  /**
   * Get game statistics
   * @returns {Object} Game statistics
   */
  getStats() {
    return {
      activeGames: this.activeGames.size,
      gamesInMemory: Array.from(this.activeGames.values()).map(game => ({
        roomId: game.roomId,
        status: game.status,
        players: Object.keys(game.players).length,
        moves: game.moveHistory.length
      }))
    };
  }
}

module.exports = GameController;

