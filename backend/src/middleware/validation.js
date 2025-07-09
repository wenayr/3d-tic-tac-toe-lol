/**
 * Validation middleware for Socket.io events
 * Uses Joi for schema validation
 */

const Joi = require('joi');
const logger = require('../utils/logger');

// Define validation schemas for different socket events
const schemas = {
  'make-move': Joi.object({
    x: Joi.number().integer().min(0).max(2).required()
      .messages({
        'number.base': 'X coordinate must be a number',
        'number.integer': 'X coordinate must be an integer',
        'number.min': 'X coordinate must be between 0 and 2',
        'number.max': 'X coordinate must be between 0 and 2',
        'any.required': 'X coordinate is required'
      }),
    y: Joi.number().integer().min(0).max(2).required()
      .messages({
        'number.base': 'Y coordinate must be a number',
        'number.integer': 'Y coordinate must be an integer',
        'number.min': 'Y coordinate must be between 0 and 2',
        'number.max': 'Y coordinate must be between 0 and 2',
        'any.required': 'Y coordinate is required'
      }),
    roomId: Joi.string().uuid().required()
      .messages({
        'string.base': 'Room ID must be a string',
        'string.guid': 'Room ID must be a valid UUID',
        'any.required': 'Room ID is required'
      })
  }),

  'chat-message': Joi.object({
    message: Joi.string()
      .min(1)
      .max(200)
      .pattern(/^[a-zA-Zа-яА-Я0-9\s.,!?@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]+$/)
      .required()
      .messages({
        'string.base': 'Message must be a string',
        'string.min': 'Message cannot be empty',
        'string.max': 'Message cannot exceed 200 characters',
        'string.pattern.base': 'Message contains invalid characters',
        'any.required': 'Message is required'
      }),
    roomId: Joi.string().uuid().required()
      .messages({
        'string.base': 'Room ID must be a string',
        'string.guid': 'Room ID must be a valid UUID',
        'any.required': 'Room ID is required'
      })
  }),

  'join-room': Joi.object({
    roomId: Joi.string().uuid().required()
      .messages({
        'string.base': 'Room ID must be a string',
        'string.guid': 'Room ID must be a valid UUID',
        'any.required': 'Room ID is required'
      }),
    playerName: Joi.string()
      .min(2)
      .max(20)
      .pattern(/^[a-zA-Zа-яА-Я0-9_-]+$/)
      .required()
      .messages({
        'string.base': 'Player name must be a string',
        'string.min': 'Player name must be at least 2 characters',
        'string.max': 'Player name cannot exceed 20 characters',
        'string.pattern.base': 'Player name can only contain letters, numbers, underscores, and hyphens',
        'any.required': 'Player name is required'
      }),
    password: Joi.string().min(4).max(50).optional()
      .messages({
        'string.base': 'Password must be a string',
        'string.min': 'Password must be at least 4 characters',
        'string.max': 'Password cannot exceed 50 characters'
      })
  }),

  'create-room': Joi.object({
    roomName: Joi.string()
      .min(3)
      .max(30)
      .pattern(/^[a-zA-Zа-яА-Я0-9\s_-]+$/)
      .required()
      .messages({
        'string.base': 'Room name must be a string',
        'string.min': 'Room name must be at least 3 characters',
        'string.max': 'Room name cannot exceed 30 characters',
        'string.pattern.base': 'Room name can only contain letters, numbers, spaces, underscores, and hyphens',
        'any.required': 'Room name is required'
      }),
    isPrivate: Joi.boolean().default(false)
      .messages({
        'boolean.base': 'isPrivate must be a boolean'
      }),
    password: Joi.string().min(4).max(50).when('isPrivate', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional()
    })
      .messages({
        'string.base': 'Password must be a string',
        'string.min': 'Password must be at least 4 characters',
        'string.max': 'Password cannot exceed 50 characters',
        'any.required': 'Password is required for private rooms'
      }),
    maxPlayers: Joi.number().integer().min(2).max(10).default(2)
      .messages({
        'number.base': 'Max players must be a number',
        'number.integer': 'Max players must be an integer',
        'number.min': 'Max players must be at least 2',
        'number.max': 'Max players cannot exceed 10'
      })
  }),

  'leave-room': Joi.object({
    roomId: Joi.string().uuid().required()
      .messages({
        'string.base': 'Room ID must be a string',
        'string.guid': 'Room ID must be a valid UUID',
        'any.required': 'Room ID is required'
      })
  }),

  'spectate-game': Joi.object({
    roomId: Joi.string().uuid().required()
      .messages({
        'string.base': 'Room ID must be a string',
        'string.guid': 'Room ID must be a valid UUID',
        'any.required': 'Room ID is required'
      })
  })
};

/**
 * Validate socket event data against predefined schemas
 * @param {string} eventType - The type of socket event
 * @param {any} data - The data to validate
 * @returns {Object} Validation result with valid flag and data/error
 */
function validateSocketEvent(eventType, data) {
  const schema = schemas[eventType];
  
  if (!schema) {
    logger.warn(`No validation schema found for event: ${eventType}`);
    return { 
      valid: false, 
      error: `Unknown event type: ${eventType}` 
    };
  }

  const { error, value } = schema.validate(data, {
    abortEarly: false, // Return all validation errors
    stripUnknown: true, // Remove unknown properties
    convert: true // Convert types when possible
  });

  if (error) {
    const errorMessage = error.details
      .map(detail => detail.message)
      .join('; ');
    
    logger.security('Validation failed', {
      eventType,
      data,
      errors: error.details
    });

    return { 
      valid: false, 
      error: errorMessage,
      details: error.details
    };
  }

  return { 
    valid: true, 
    data: value 
  };
}

/**
 * Sanitize chat message to prevent XSS and other attacks
 * @param {string} message - The message to sanitize
 * @returns {string} Sanitized message
 */
function sanitizeChatMessage(message) {
  if (typeof message !== 'string') {
    return '';
  }

  // Remove HTML tags
  let sanitized = message.replace(/<[^>]*>/g, '');
  
  // Remove script tags and their content
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  
  // Escape special characters
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');

  // Limit length
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200);
  }

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}

/**
 * Validate player name format
 * @param {string} name - Player name to validate
 * @returns {Object} Validation result
 */
function validatePlayerName(name) {
  const schema = Joi.string()
    .min(2)
    .max(20)
    .pattern(/^[a-zA-Zа-яА-Я0-9_-]+$/)
    .required();

  const { error, value } = schema.validate(name);

  if (error) {
    return {
      valid: false,
      error: 'Player name must be 2-20 characters and contain only letters, numbers, underscores, and hyphens'
    };
  }

  return {
    valid: true,
    data: value
  };
}

/**
 * Validate room ID format
 * @param {string} roomId - Room ID to validate
 * @returns {Object} Validation result
 */
function validateRoomId(roomId) {
  const schema = Joi.string().uuid().required();
  const { error, value } = schema.validate(roomId);

  if (error) {
    return {
      valid: false,
      error: 'Invalid room ID format'
    };
  }

  return {
    valid: true,
    data: value
  };
}

module.exports = {
  validateSocketEvent,
  sanitizeChatMessage,
  validatePlayerName,
  validateRoomId,
  schemas
};

