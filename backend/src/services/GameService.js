/**
 * Game Service
 * Contains core game logic for Tic-Tac-Toe
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class GameService {
  constructor() {
    this.BOARD_SIZE = 3;
    this.WINNING_COMBINATIONS = [
      // Rows
      [[0, 0], [0, 1], [0, 2]],
      [[1, 0], [1, 1], [1, 2]],
      [[2, 0], [2, 1], [2, 2]],
      // Columns
      [[0, 0], [1, 0], [2, 0]],
      [[0, 1], [1, 1], [2, 1]],
      [[0, 2], [1, 2], [2, 2]],
      // Diagonals
      [[0, 0], [1, 1], [2, 2]],
      [[0, 2], [1, 1], [2, 0]]
    ];
  }

  /**
   * Create a new game
   * @param {string} roomId - Room ID
   * @param {Array} players - Array of player objects
   * @returns {Object} Initial game state
   */
  createGame(roomId, players) {
    if (players.length !== 2) {
      throw new Error('Game requires exactly 2 players');
    }

    const gameState = {
      id: uuidv4(),
      roomId,
      board: this.createEmptyBoard(),
      players: {
        player1: {
          id: players[0].id,
          name: players[0].name,
          character: 'fire_warrior', // Default character
          symbol: 'X'
        },
        player2: {
          id: players[1].id,
          name: players[1].name,
          character: 'ice_guardian', // Default character
          symbol: 'O'
        }
      },
      currentPlayer: 'player1',
      status: 'playing', // waiting, playing, finished, draw, abandoned
      winner: null,
      moveHistory: [],
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastMoveAt: Date.now()
    };

    logger.gameEvent('game_created', {
      gameId: gameState.id,
      roomId,
      players: players.map(p => ({ id: p.id, name: p.name }))
    });

    return gameState;
  }

  /**
   * Create an empty 3x3 board
   * @returns {Array} Empty board matrix
   */
  createEmptyBoard() {
    return Array(this.BOARD_SIZE).fill().map(() => Array(this.BOARD_SIZE).fill(null));
  }

  /**
   * Validate a move
   * @param {Object} gameState - Current game state
   * @param {string} playerId - ID of the player making the move
   * @param {number} x - X coordinate (0-2)
   * @param {number} y - Y coordinate (0-2)
   * @returns {Object} Validation result
   */
  validateMove(gameState, playerId, x, y) {
    // Check if game is in playing state
    if (gameState.status !== 'playing') {
      return {
        valid: false,
        reason: 'GAME_NOT_ACTIVE',
        message: 'Game is not currently active'
      };
    }

    // Check if it's the player's turn
    const currentPlayerId = gameState.players[gameState.currentPlayer]?.id;
    if (playerId !== currentPlayerId) {
      return {
        valid: false,
        reason: 'NOT_YOUR_TURN',
        message: 'It is not your turn'
      };
    }

    // Check coordinates are valid
    if (!this.isValidCoordinate(x, y)) {
      return {
        valid: false,
        reason: 'INVALID_COORDINATES',
        message: 'Invalid board coordinates'
      };
    }

    // Check if cell is empty
    if (gameState.board[x][y] !== null) {
      return {
        valid: false,
        reason: 'CELL_OCCUPIED',
        message: 'Cell is already occupied'
      };
    }

    return {
      valid: true
    };
  }

  /**
   * Make a move
   * @param {Object} gameState - Current game state
   * @param {string} playerId - ID of the player making the move
   * @param {number} x - X coordinate (0-2)
   * @param {number} y - Y coordinate (0-2)
   * @returns {Object} Move result with updated game state
   */
  makeMove(gameState, playerId, x, y) {
    // Validate the move first
    const validation = this.validateMove(gameState, playerId, x, y);
    if (!validation.valid) {
      return {
        success: false,
        reason: validation.reason,
        message: validation.message
      };
    }

    // Create a copy of the game state to avoid mutations
    const newGameState = JSON.parse(JSON.stringify(gameState));

    // Apply the move
    const currentPlayerKey = newGameState.currentPlayer;
    const playerSymbol = newGameState.players[currentPlayerKey].symbol;
    
    newGameState.board[x][y] = currentPlayerKey;
    newGameState.lastMoveAt = Date.now();

    // Add to move history
    newGameState.moveHistory.push({
      playerId,
      playerKey: currentPlayerKey,
      x,
      y,
      timestamp: Date.now(),
      moveNumber: newGameState.moveHistory.length + 1
    });

    // Check for win condition
    const winner = this.checkWinner(newGameState.board);
    if (winner) {
      newGameState.status = 'finished';
      newGameState.winner = newGameState.players[winner].id;
      newGameState.finishedAt = Date.now();
      
      logger.gameEvent('game_won', {
        gameId: newGameState.id,
        winner: newGameState.winner,
        moves: newGameState.moveHistory.length
      });
    } else if (this.isBoardFull(newGameState.board)) {
      // Check for draw
      newGameState.status = 'draw';
      newGameState.finishedAt = Date.now();
      
      logger.gameEvent('game_draw', {
        gameId: newGameState.id,
        moves: newGameState.moveHistory.length
      });
    } else {
      // Switch to next player
      newGameState.currentPlayer = currentPlayerKey === 'player1' ? 'player2' : 'player1';
    }

    return {
      success: true,
      gameState: newGameState
    };
  }

  /**
   * Check if coordinates are valid
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @returns {boolean} Whether coordinates are valid
   */
  isValidCoordinate(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && 
           x >= 0 && x < this.BOARD_SIZE && 
           y >= 0 && y < this.BOARD_SIZE;
  }

  /**
   * Check for winner
   * @param {Array} board - Game board
   * @returns {string|null} Winner player key or null
   */
  checkWinner(board) {
    for (const combination of this.WINNING_COMBINATIONS) {
      const [pos1, pos2, pos3] = combination;
      const cell1 = board[pos1[0]][pos1[1]];
      const cell2 = board[pos2[0]][pos2[1]];
      const cell3 = board[pos3[0]][pos3[1]];

      if (cell1 && cell1 === cell2 && cell2 === cell3) {
        return cell1; // Return the player key (player1 or player2)
      }
    }

    return null;
  }

  /**
   * Check if board is full
   * @param {Array} board - Game board
   * @returns {boolean} Whether board is full
   */
  isBoardFull(board) {
    for (let x = 0; x < this.BOARD_SIZE; x++) {
      for (let y = 0; y < this.BOARD_SIZE; y++) {
        if (board[x][y] === null) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Get winning combination if game is won
   * @param {Array} board - Game board
   * @returns {Array|null} Winning combination coordinates or null
   */
  getWinningCombination(board) {
    for (const combination of this.WINNING_COMBINATIONS) {
      const [pos1, pos2, pos3] = combination;
      const cell1 = board[pos1[0]][pos1[1]];
      const cell2 = board[pos2[0]][pos2[1]];
      const cell3 = board[pos3[0]][pos3[1]];

      if (cell1 && cell1 === cell2 && cell2 === cell3) {
        return combination;
      }
    }

    return null;
  }

  /**
   * Get available moves
   * @param {Array} board - Game board
   * @returns {Array} Array of available move coordinates
   */
  getAvailableMoves(board) {
    const moves = [];
    
    for (let x = 0; x < this.BOARD_SIZE; x++) {
      for (let y = 0; y < this.BOARD_SIZE; y++) {
        if (board[x][y] === null) {
          moves.push({ x, y });
        }
      }
    }

    return moves;
  }

  /**
   * Calculate game statistics
   * @param {Object} gameState - Game state
   * @returns {Object} Game statistics
   */
  calculateGameStats(gameState) {
    const duration = gameState.finishedAt 
      ? gameState.finishedAt - gameState.startedAt 
      : Date.now() - gameState.startedAt;

    const player1Moves = gameState.moveHistory.filter(move => move.playerKey === 'player1').length;
    const player2Moves = gameState.moveHistory.filter(move => move.playerKey === 'player2').length;

    return {
      duration,
      totalMoves: gameState.moveHistory.length,
      player1Moves,
      player2Moves,
      averageTimePerMove: gameState.moveHistory.length > 0 ? duration / gameState.moveHistory.length : 0,
      status: gameState.status,
      winner: gameState.winner
    };
  }

  /**
   * Simulate AI move (for future AI opponent feature)
   * @param {Array} board - Game board
   * @param {string} playerKey - AI player key
   * @returns {Object|null} Best move coordinates or null
   */
  getAIMove(board, playerKey) {
    // Simple AI: try to win, then block opponent, then take center, then corners, then edges
    const opponent = playerKey === 'player1' ? 'player2' : 'player1';

    // Try to win
    const winMove = this.findWinningMove(board, playerKey);
    if (winMove) return winMove;

    // Try to block opponent
    const blockMove = this.findWinningMove(board, opponent);
    if (blockMove) return blockMove;

    // Take center if available
    if (board[1][1] === null) {
      return { x: 1, y: 1 };
    }

    // Take corners
    const corners = [[0, 0], [0, 2], [2, 0], [2, 2]];
    for (const [x, y] of corners) {
      if (board[x][y] === null) {
        return { x, y };
      }
    }

    // Take edges
    const edges = [[0, 1], [1, 0], [1, 2], [2, 1]];
    for (const [x, y] of edges) {
      if (board[x][y] === null) {
        return { x, y };
      }
    }

    return null;
  }

  /**
   * Find winning move for a player
   * @param {Array} board - Game board
   * @param {string} playerKey - Player key
   * @returns {Object|null} Winning move coordinates or null
   */
  findWinningMove(board, playerKey) {
    for (let x = 0; x < this.BOARD_SIZE; x++) {
      for (let y = 0; y < this.BOARD_SIZE; y++) {
        if (board[x][y] === null) {
          // Try this move
          board[x][y] = playerKey;
          
          if (this.checkWinner(board) === playerKey) {
            board[x][y] = null; // Undo move
            return { x, y };
          }
          
          board[x][y] = null; // Undo move
        }
      }
    }
    
    return null;
  }

  /**
   * Validate game state integrity
   * @param {Object} gameState - Game state to validate
   * @returns {Object} Validation result
   */
  validateGameState(gameState) {
    const errors = [];

    // Check required fields
    if (!gameState.id) errors.push('Missing game ID');
    if (!gameState.roomId) errors.push('Missing room ID');
    if (!gameState.board) errors.push('Missing board');
    if (!gameState.players) errors.push('Missing players');

    // Check board structure
    if (gameState.board && !Array.isArray(gameState.board)) {
      errors.push('Board must be an array');
    } else if (gameState.board && gameState.board.length !== this.BOARD_SIZE) {
      errors.push(`Board must be ${this.BOARD_SIZE}x${this.BOARD_SIZE}`);
    }

    // Check players
    if (gameState.players) {
      if (!gameState.players.player1) errors.push('Missing player1');
      if (!gameState.players.player2) errors.push('Missing player2');
    }

    // Check current player
    if (gameState.currentPlayer && !['player1', 'player2'].includes(gameState.currentPlayer)) {
      errors.push('Invalid current player');
    }

    // Check status
    if (gameState.status && !['waiting', 'playing', 'finished', 'draw', 'abandoned'].includes(gameState.status)) {
      errors.push('Invalid game status');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = GameService;

