/**
 * Rate limiting middleware for Socket.io events
 * Prevents spam and abuse of socket connections
 */

const logger = require('../utils/logger');

class SocketRateLimiter {
  constructor() {
    this.clients = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Cleanup every minute
    
    // Define rate limits for different event types (events per minute)
    this.limits = {
      'make-move': 30,        // 30 moves per minute (0.5 per second)
      'chat-message': 20,     // 20 messages per minute
      'join-room': 10,        // 10 room joins per minute
      'create-room': 5,       // 5 room creations per minute
      'leave-room': 10,       // 10 room leaves per minute
      'spectate-game': 10,    // 10 spectate requests per minute
      'get-room-list': 30,    // 30 room list requests per minute
      'default': 60           // Default limit for unlisted events
    };

    // Define burst limits (events per 10 seconds)
    this.burstLimits = {
      'make-move': 10,        // Max 10 moves in 10 seconds
      'chat-message': 5,      // Max 5 messages in 10 seconds
      'join-room': 3,         // Max 3 room joins in 10 seconds
      'create-room': 2,       // Max 2 room creations in 10 seconds
      'default': 20           // Default burst limit
    };

    logger.info('Socket rate limiter initialized');
  }

  /**
   * Check if a client can perform an action based on rate limits
   * @param {string} socketId - Socket ID of the client
   * @param {string} eventType - Type of event being performed
   * @returns {boolean} Whether the action is allowed
   */
  checkLimit(socketId, eventType) {
    const now = Date.now();
    const clientData = this.clients.get(socketId) || { 
      events: [], 
      lastSeen: now,
      warnings: 0 
    };

    // Update last seen
    clientData.lastSeen = now;

    // Clean old events (older than 1 minute)
    clientData.events = clientData.events.filter(
      event => now - event.timestamp < 60000
    );

    // Get limits for this event type
    const minuteLimit = this.limits[eventType] || this.limits.default;
    const burstLimit = this.burstLimits[eventType] || this.burstLimits.default;

    // Count events in the last minute
    const eventsInMinute = clientData.events.filter(
      event => event.type === eventType
    ).length;

    // Count events in the last 10 seconds (burst detection)
    const eventsInBurst = clientData.events.filter(
      event => event.type === eventType && now - event.timestamp < 10000
    ).length;

    // Check minute limit
    if (eventsInMinute >= minuteLimit) {
      this.handleRateLimit(socketId, eventType, 'minute', eventsInMinute, minuteLimit);
      return false;
    }

    // Check burst limit
    if (eventsInBurst >= burstLimit) {
      this.handleRateLimit(socketId, eventType, 'burst', eventsInBurst, burstLimit);
      return false;
    }

    // Add the new event
    clientData.events.push({
      type: eventType,
      timestamp: now
    });

    // Update client data
    this.clients.set(socketId, clientData);

    return true;
  }

  /**
   * Handle rate limit violations
   * @param {string} socketId - Socket ID of the violating client
   * @param {string} eventType - Type of event that was rate limited
   * @param {string} limitType - Type of limit that was exceeded ('minute' or 'burst')
   * @param {number} currentCount - Current event count
   * @param {number} limit - The limit that was exceeded
   */
  handleRateLimit(socketId, eventType, limitType, currentCount, limit) {
    const clientData = this.clients.get(socketId);
    
    if (clientData) {
      clientData.warnings = (clientData.warnings || 0) + 1;
      this.clients.set(socketId, clientData);
    }

    logger.security('Rate limit exceeded', {
      socketId,
      eventType,
      limitType,
      currentCount,
      limit,
      warnings: clientData?.warnings || 0
    });

    // If too many warnings, consider this suspicious behavior
    if (clientData && clientData.warnings > 10) {
      logger.security('Suspicious activity detected', {
        socketId,
        warnings: clientData.warnings,
        eventType
      });
    }
  }

  /**
   * Get current rate limit status for a client
   * @param {string} socketId - Socket ID to check
   * @returns {Object} Rate limit status
   */
  getStatus(socketId) {
    const clientData = this.clients.get(socketId);
    
    if (!clientData) {
      return {
        exists: false,
        events: 0,
        warnings: 0
      };
    }

    const now = Date.now();
    const recentEvents = clientData.events.filter(
      event => now - event.timestamp < 60000
    );

    return {
      exists: true,
      events: recentEvents.length,
      warnings: clientData.warnings || 0,
      lastSeen: clientData.lastSeen,
      eventsByType: this.getEventCountsByType(recentEvents)
    };
  }

  /**
   * Get event counts grouped by type
   * @param {Array} events - Array of events
   * @returns {Object} Event counts by type
   */
  getEventCountsByType(events) {
    const counts = {};
    
    events.forEach(event => {
      counts[event.type] = (counts[event.type] || 0) + 1;
    });

    return counts;
  }

  /**
   * Clean up old client data
   * @param {string} socketId - Optional specific socket ID to clean up
   */
  cleanup(socketId = null) {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    if (socketId) {
      // Clean up specific client
      this.clients.delete(socketId);
      return;
    }

    // Clean up all old clients
    let cleanedCount = 0;
    
    for (const [id, clientData] of this.clients.entries()) {
      if (now - clientData.lastSeen > maxAge) {
        this.clients.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} old rate limiter entries`);
    }
  }

  /**
   * Reset rate limits for a specific client
   * @param {string} socketId - Socket ID to reset
   */
  reset(socketId) {
    this.clients.delete(socketId);
    logger.info(`Rate limits reset for client: ${socketId}`);
  }

  /**
   * Get statistics about rate limiting
   * @returns {Object} Rate limiting statistics
   */
  getStats() {
    const now = Date.now();
    let totalEvents = 0;
    let totalWarnings = 0;
    let activeClients = 0;

    for (const [id, clientData] of this.clients.entries()) {
      // Count recent events (last minute)
      const recentEvents = clientData.events.filter(
        event => now - event.timestamp < 60000
      );
      
      totalEvents += recentEvents.length;
      totalWarnings += clientData.warnings || 0;
      
      if (recentEvents.length > 0) {
        activeClients++;
      }
    }

    return {
      totalClients: this.clients.size,
      activeClients,
      totalEvents,
      totalWarnings,
      limits: this.limits,
      burstLimits: this.burstLimits
    };
  }

  /**
   * Update rate limits dynamically
   * @param {string} eventType - Event type to update
   * @param {number} minuteLimit - New minute limit
   * @param {number} burstLimit - New burst limit
   */
  updateLimits(eventType, minuteLimit, burstLimit) {
    this.limits[eventType] = minuteLimit;
    this.burstLimits[eventType] = burstLimit;
    
    logger.info(`Updated rate limits for ${eventType}: ${minuteLimit}/min, ${burstLimit}/10s`);
  }

  /**
   * Destroy the rate limiter and clean up resources
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.clients.clear();
    logger.info('Socket rate limiter destroyed');
  }
}

module.exports = SocketRateLimiter;

