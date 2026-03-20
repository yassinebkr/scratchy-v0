'use strict';

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

/** Valid analytics event types */
const EVENT_TYPES = ['conversation', 'tool', 'error', 'session', 'system'];

/**
 * AnalyticsEventBus — in-process EventEmitter that decouples analytics
 * event collection from storage/aggregation.
 *
 * Singleton: use the exported `analyticsEventBus` instance.
 * The class is also exported for testing.
 */
class AnalyticsEventBus extends EventEmitter {
  constructor() {
    super();
    this._stats = {
      totalEmitted: 0,
      byType: Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])),
      lastEventTs: null,
    };
    this._debug = process.env.ANALYTICS_DEBUG === '1';
  }

  /**
   * Override emit to auto-fill envelope fields and guard listeners.
   * For internal EventEmitter events (error, newListener, etc.) we
   * fall through to the default behaviour.
   *
   * @param {string} type  - event type (must be one of EVENT_TYPES)
   * @param {object} payload - event payload
   * @returns {boolean}
   */
  emit(type, payload) {
    // Pass-through for non-analytics events (e.g. 'newListener', 'removeListener')
    if (!EVENT_TYPES.includes(type)) {
      return super.emit(type, payload);
    }

    if (!payload || typeof payload !== 'object') {
      process.stderr.write(`[AnalyticsEventBus] rejected event: payload must be an object\n`);
      return false;
    }

    if (!payload.subtype) {
      process.stderr.write(`[AnalyticsEventBus] rejected event: missing subtype\n`);
      return false;
    }

    // Auto-fill envelope
    const event = {
      id: payload.id || randomUUID(),
      type,
      subtype: payload.subtype,
      ts: payload.ts || Date.now(),
      userId: payload.userId || null,
      sessionId: payload.sessionId || null,
      meta: payload.meta || {},
      ...payload,
    };

    // Stats
    this._stats.totalEmitted++;
    this._stats.byType[type] = (this._stats.byType[type] || 0) + 1;
    this._stats.lastEventTs = event.ts;

    // Debug logging
    if (this._debug) {
      console.log('[AnalyticsEventBus]', JSON.stringify(event));
    }

    // Safe emit — listener errors must never crash the bus
    const listeners = this.listeners(type);
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        process.stderr.write(
          `[AnalyticsEventBus] listener error on "${type}": ${err && err.stack ? err.stack : err}\n`
        );
      }
    }
    return listeners.length > 0;
  }

  /**
   * Convenience method to emit a fully-formed analytics event.
   *
   * @param {string} type      - one of EVENT_TYPES
   * @param {string} subtype   - event subtype (e.g. 'user_message')
   * @param {string} userId    - user identifier
   * @param {string} sessionId - session identifier
   * @param {object} [meta={}] - arbitrary metadata
   * @returns {boolean}
   */
  emitEvent(type, subtype, userId, sessionId, meta = {}) {
    return this.emit(type, { subtype, userId, sessionId, meta });
  }

  /**
   * Returns aggregate stats about emitted events.
   *
   * @returns {{ totalEmitted: number, byType: Record<string, number>, lastEventTs: number|null }}
   */
  getStats() {
    return { ...this._stats, byType: { ...this._stats.byType } };
  }

  /** Resets internal stats (useful in tests). */
  resetStats() {
    this._stats.totalEmitted = 0;
    this._stats.byType = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0]));
    this._stats.lastEventTs = null;
  }
}

// Singleton instance
const analyticsEventBus = new AnalyticsEventBus();

module.exports = { AnalyticsEventBus, analyticsEventBus, EVENT_TYPES };
