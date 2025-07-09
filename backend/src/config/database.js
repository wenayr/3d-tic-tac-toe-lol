/**
 * Database configuration and initialization
 * Uses SQLite for simplicity and portability
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');

class DatabaseManager {
  constructor() {
    this.dbPath = path.join(__dirname, '../../data/game.db');
    this.db = null;
    this.isInitialized = false;
  }

  async initializeDatabase() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.dbPath);
      await fs.mkdir(dataDir, { recursive: true });

      // Create database connection
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          logger.error('Error opening database:', err);
          throw err;
        }
        logger.info(`Connected to SQLite database at ${this.dbPath}`);
      });

      // Enable foreign keys
      await this.run('PRAGMA foreign_keys = ON');
      
      // Create tables
      await this.createTables();
      
      this.isInitialized = true;
      logger.info('Database initialized successfully');
      
    } catch (error) {
      logger.error('Database initialization failed:', error);
      throw error;
    }
  }

  async createTables() {
    const tables = [
      // Players table
      `CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        games_played INTEGER DEFAULT 0,
        games_won INTEGER DEFAULT 0,
        rating INTEGER DEFAULT 1000
      )`,

      // Games table
      `CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        player1_id TEXT NOT NULL,
        player2_id TEXT,
        winner_id TEXT,
        status TEXT DEFAULT 'waiting', -- waiting, playing, finished, abandoned
        board TEXT, -- JSON representation of the board
        moves TEXT, -- JSON array of moves
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        finished_at DATETIME,
        FOREIGN KEY (player1_id) REFERENCES players (id),
        FOREIGN KEY (player2_id) REFERENCES players (id),
        FOREIGN KEY (winner_id) REFERENCES players (id)
      )`,

      // Rooms table
      `CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_private BOOLEAN DEFAULT FALSE,
        password TEXT,
        max_players INTEGER DEFAULT 2,
        current_players INTEGER DEFAULT 0,
        status TEXT DEFAULT 'waiting', -- waiting, playing, finished
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES players (id)
      )`,

      // Chat messages table
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES rooms (id),
        FOREIGN KEY (player_id) REFERENCES players (id)
      )`,

      // Game statistics table
      `CREATE TABLE IF NOT EXISTS game_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        moves_count INTEGER DEFAULT 0,
        time_played INTEGER DEFAULT 0, -- in seconds
        character_used TEXT,
        FOREIGN KEY (game_id) REFERENCES games (id),
        FOREIGN KEY (player_id) REFERENCES players (id)
      )`
    ];

    for (const tableSQL of tables) {
      await this.run(tableSQL);
    }

    // Create indexes for better performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_players_rating ON players (rating DESC)',
      'CREATE INDEX IF NOT EXISTS idx_games_status ON games (status)',
      'CREATE INDEX IF NOT EXISTS idx_games_created_at ON games (created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms (status)',
      'CREATE INDEX IF NOT EXISTS idx_chat_room_timestamp ON chat_messages (room_id, timestamp DESC)'
    ];

    for (const indexSQL of indexes) {
      await this.run(indexSQL);
    }

    logger.info('Database tables and indexes created successfully');
  }

  // Promisified database operations
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          logger.error('Database run error:', err);
          reject(err);
        } else {
          resolve({ id: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          logger.error('Database get error:', err);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          logger.error('Database all error:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // Transaction support
  async transaction(callback) {
    await this.run('BEGIN TRANSACTION');
    try {
      const result = await callback(this);
      await this.run('COMMIT');
      return result;
    } catch (error) {
      await this.run('ROLLBACK');
      throw error;
    }
  }

  // Close database connection
  close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            logger.error('Error closing database:', err);
            reject(err);
          } else {
            logger.info('Database connection closed');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  // Health check
  async healthCheck() {
    try {
      await this.get('SELECT 1');
      return { status: 'healthy', timestamp: new Date().toISOString() };
    } catch (error) {
      return { status: 'unhealthy', error: error.message, timestamp: new Date().toISOString() };
    }
  }
}

// Singleton instance
const dbManager = new DatabaseManager();

// Export functions
async function initializeDatabase() {
  return await dbManager.initializeDatabase();
}

function getDatabase() {
  if (!dbManager.isInitialized) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbManager;
}

module.exports = {
  initializeDatabase,
  getDatabase,
  DatabaseManager
};

