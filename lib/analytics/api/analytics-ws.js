'use strict';

/**
 * Analytics WebSocket Real-time Push
 * 
 * Manages real-time analytics data streaming to admin clients via WebSocket:
 * - Live counters (updated every 30s)
 * - Insight notifications from the insight engine
 * - Rollup completion notifications
 * - Session subscription management
 */

/**
 * Create analytics WebSocket manager
 * @param {Object} deps - Dependencies object
 * @param {EventStore} deps.eventStore - Event storage interface
 * @param {RollupStore} deps.rollupStore - Rollup data interface
 * @param {AnalyticsEventBus} deps.eventBus - Event bus interface
 * @param {Object} deps.aggregators - Aggregator instances
 * @param {Map} deps.wsSessions - WebSocket sessions map
 * @returns {Object} WebSocket manager interface
 */
function createAnalyticsWs(deps) {
  const { eventStore, rollupStore, eventBus, aggregators, wsSessions } = deps;
  
  // Set to track subscribed sessions for analytics updates
  const analyticsSubscribers = new Set();
  
  // Interval ID for live updates
  let liveUpdateInterval = null;

  /**
   * Send data to all subscribed analytics sessions
   * @param {Object} payload - Data to send
   */
  function _sendToSubscribers(payload) {
    const message = JSON.stringify(payload);
    const deadSessions = [];

    for (const sessionId of analyticsSubscribers) {
      const session = wsSessions.get(sessionId);
      
      if (!session || !session.clientWs || session.clientWs.readyState !== 1) {
        // Mark dead session for removal
        deadSessions.push(sessionId);
        continue;
      }

      try {
        session.clientWs.send(message);
      } catch (error) {
        console.error('[Analytics] Failed to send to session', sessionId, error.message);
        deadSessions.push(sessionId);
      }
    }

    // Clean up dead sessions
    for (const sessionId of deadSessions) {
      analyticsSubscribers.delete(sessionId);
    }
  }

  /**
   * Query recent events for live counters
   * @param {number} minutesBack - Minutes to look back
   * @returns {Array} Recent events
   */
  function _queryRecentEvents(minutesBack = 5) {
    try {
      const now = Date.now();
      const cutoff = now - (minutesBack * 60 * 1000);
      const today = new Date().toISOString().split('T')[0];

      // Query all events for today
      const events = eventStore.query({
        dateFrom: today,
        dateTo: today,
        limit: 10000
      });

      // Filter to recent events
      return events.filter(event => event.ts > cutoff);
    } catch (error) {
      console.error('[Analytics] Error querying recent events:', error);
      return [];
    }
  }

  /**
   * Calculate live metrics from recent events
   * @param {Array} recentEvents - Events from last 5 minutes
   * @returns {Object} Live metrics
   */
  function _calculateLiveMetrics(recentEvents) {
    const conversationEvents = recentEvents.filter(e => e.type === 'conversation');
    const errorEvents = recentEvents.filter(e => e.type === 'error');
    
    // Count active users (unique user IDs in recent events)
    const activeUserIds = new Set(
      recentEvents
        .filter(e => e.userId)
        .map(e => e.userId)
    );

    // Calculate conversation metrics
    const messagesLast5min = conversationEvents.length;
    const costLast5min = conversationEvents
      .reduce((sum, event) => sum + ((event.meta && event.meta.cost) || 0), 0);
    
    // Calculate average response time from meta.responseTimeMs
    const responseEvents = conversationEvents.filter(
      e => e.meta && typeof e.meta.responseTimeMs === 'number' && e.meta.responseTimeMs > 0
    );
    const avgResponseMsLast5min = responseEvents.length > 0 
      ? responseEvents.reduce((sum, e) => sum + e.meta.responseTimeMs, 0) / responseEvents.length
      : 0;

    return {
      activeUsers: activeUserIds.size,
      messagesLast5min,
      costLast5min: Math.round(costLast5min * 100) / 100, // Round to 2 decimal places
      errorsLast5min: errorEvents.length,
      avgResponseMsLast5min: Math.round(avgResponseMsLast5min)
    };
  }

  /**
   * Handle admin subscription to analytics updates
   * @param {Object} session - WebSocket session
   */
  function handleSubscribe(session) {
    if (!session || !session.id) {
      console.error('[Analytics] Invalid session for subscribe');
      return;
    }

    // Verify admin access
    if (!session.authResult || 
        (!session.authResult.isLegacy && 
         (!session.authResult.user || session.authResult.user.role !== 'admin'))) {
      console.error('[Analytics] Non-admin attempted to subscribe to analytics');
      return;
    }

    analyticsSubscribers.add(session.id);
    console.log(`[Analytics] Session ${session.id} subscribed (${analyticsSubscribers.size} total)`);

    // Send immediate update to new subscriber
    try {
      const recentEvents = _queryRecentEvents(5);
      const liveData = _calculateLiveMetrics(recentEvents);
      
      if (session.clientWs && session.clientWs.readyState === 1) {
        session.clientWs.send(JSON.stringify({
          type: 'analytics:live',
          data: liveData
        }));
      }
    } catch (error) {
      console.error('[Analytics] Error sending immediate update to new subscriber:', error);
    }
  }

  /**
   * Handle admin unsubscription from analytics updates
   * @param {Object} session - WebSocket session
   */
  function handleUnsubscribe(session) {
    if (!session || !session.id) {
      return;
    }

    if (analyticsSubscribers.delete(session.id)) {
      console.log(`[Analytics] Session ${session.id} unsubscribed (${analyticsSubscribers.size} total)`);
    }
  }

  /**
   * Push live update to all subscribers (called every 30s)
   */
  function pushLiveUpdate() {
    if (analyticsSubscribers.size === 0) {
      return; // No subscribers, skip processing
    }

    try {
      const recentEvents = _queryRecentEvents(5);
      const liveData = _calculateLiveMetrics(recentEvents);

      _sendToSubscribers({
        type: 'analytics:live',
        data: liveData
      });

    } catch (error) {
      console.error('[Analytics] Error in pushLiveUpdate:', error);
    }
  }

  /**
   * Push insight notification to subscribers
   * @param {Object} insight - Insight data
   * @param {string} insight.id - Insight ID
   * @param {string} insight.severity - Severity level (info, warning, error)
   * @param {string} insight.title - Insight title
   * @param {string} insight.message - Insight message
   */
  function pushInsight(insight) {
    if (analyticsSubscribers.size === 0) {
      return; // No subscribers
    }

    if (!insight || !insight.id || !insight.title || !insight.message) {
      console.error('[Analytics] Invalid insight data:', insight);
      return;
    }

    try {
      _sendToSubscribers({
        type: 'analytics:insight',
        data: {
          id: insight.id,
          severity: insight.severity || 'info',
          title: insight.title,
          message: insight.message
        }
      });

    } catch (error) {
      console.error('[Analytics] Error pushing insight:', error);
    }
  }

  /**
   * Push rollup completion notification to subscribers
   * @param {Object} rollup - Completed rollup data
   */
  function pushRollupComplete(rollup) {
    if (analyticsSubscribers.size === 0) {
      return; // No subscribers
    }

    if (!rollup || !rollup.hourKey) {
      console.error('[Analytics] Invalid rollup data:', rollup);
      return;
    }

    try {
      // Extract summary from rollup aggregations
      const summary = {
        messages: 0,
        cost: 0,
        errors: 0
      };

      if (rollup.aggregations) {
        if (rollup.aggregations.conversation) {
          summary.messages = rollup.aggregations.conversation.totalMessages || 0;
          summary.cost = rollup.aggregations.conversation.totalCost || 0;
        }
        if (rollup.aggregations.error) {
          summary.errors = rollup.aggregations.error.totalErrors || 0;
        }
      }

      _sendToSubscribers({
        type: 'analytics:rollup',
        data: {
          hourKey: rollup.hourKey,
          summary
        }
      });

    } catch (error) {
      console.error('[Analytics] Error pushing rollup complete:', error);
    }
  }

  /**
   * Start the live update interval (30s)
   */
  function start() {
    if (liveUpdateInterval) {
      console.log('[Analytics] Live update interval already running');
      return;
    }

    liveUpdateInterval = setInterval(() => {
      pushLiveUpdate();
    }, 30 * 1000); // 30 seconds

    console.log('[Analytics] Started live update interval (30s)');
  }

  /**
   * Stop the live update interval
   */
  function stop() {
    if (liveUpdateInterval) {
      clearInterval(liveUpdateInterval);
      liveUpdateInterval = null;
      console.log('[Analytics] Stopped live update interval');
    }
  }

  /**
   * Get the number of active subscribers
   * @returns {number} Number of subscribed sessions
   */
  function getSubscriberCount() {
    return analyticsSubscribers.size;
  }

  /**
   * Clean up dead sessions (can be called periodically)
   */
  function _cleanupDeadSessions() {
    const deadSessions = [];

    for (const sessionId of analyticsSubscribers) {
      const session = wsSessions.get(sessionId);
      
      if (!session || !session.clientWs || session.clientWs.readyState !== 1) {
        deadSessions.push(sessionId);
      }
    }

    for (const sessionId of deadSessions) {
      analyticsSubscribers.delete(sessionId);
    }

    if (deadSessions.length > 0) {
      console.log(`[Analytics] Cleaned up ${deadSessions.length} dead sessions`);
    }
  }

  // Return the public interface
  return {
    handleSubscribe,
    handleUnsubscribe,
    pushLiveUpdate,
    pushInsight,
    pushRollupComplete,
    start,
    stop,
    getSubscriberCount,
    
    // Internal methods for testing/debugging
    _sendToSubscribers,
    _calculateLiveMetrics,
    _queryRecentEvents,
    _cleanupDeadSessions
  };
}

module.exports = { createAnalyticsWs };