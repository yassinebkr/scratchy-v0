'use strict';

const fs = require('fs');
const path = require('path');
const { analyticsEventBus } = require('../event-bus');

const VALID_REASONS = new Set(['idle_timeout', 'explicit_close', 'ws_disconnect', 'error']);
const VALID_FEATURES = new Set(['canvas', 'tts', 'sub_agent', 'widget', 'passkey', 'theme_toggle']);
const SAVE_DEBOUNCE_MS = 30000;
const MS_PER_DAY = 86400000;

class SessionCollector {
  /**
   * @param {object} [eventBus] - Analytics event bus instance
   * @param {object} [opts]
   * @param {string} [opts.historyFile] - Path to persist user history JSON
   */
  constructor(eventBus, opts = {}) {
    this._eventBus = eventBus || analyticsEventBus;

    /** @type {Map<string, { startTs: number, source: string, sessionId: string, userAgent: string }>} */
    this._activeSessions = new Map();

    /** @type {Map<string, { lastSessionEnd: number|null, features: Set<string> }>} */
    this._userHistory = new Map();

    this._historyFile = opts.historyFile || null;
    this._saveTimer = null;
    this._savePending = false;

    if (this._historyFile) {
      this._loadHistory();
    }
  }

  /**
   * Called when a user connects (WS open + auth).
   * If the user already has an active session, ends it first with 'ws_disconnect'.
   * @param {string} userId
   * @param {string} source - e.g. 'webchat', 'whatsapp', 'discord'
   * @param {string} userAgent
   * @param {string} sessionId
   */
  onSessionStart(userId, source, userAgent, sessionId) {
    // Handle duplicate: end previous session first
    if (this._activeSessions.has(userId)) {
      this.onSessionEnd(userId, 'ws_disconnect', 0);
    }

    const returning = this._isReturning(userId);
    const daysSinceLastVisit = this._daysSinceLastVisit(userId);

    this._activeSessions.set(userId, {
      startTs: Date.now(),
      source,
      sessionId,
      userAgent,
    });

    this._eventBus.emitEvent('session', 'session_start', userId, sessionId, {
      source,
      userAgent,
      returning,
      daysSinceLastVisit,
    });
  }

  /**
   * Called when a session ends.
   * @param {string} userId
   * @param {string} reason - One of: 'idle_timeout', 'explicit_close', 'ws_disconnect', 'error'
   * @param {number} messagesExchanged - Total messages exchanged during the session
   */
  onSessionEnd(userId, reason, messagesExchanged) {
    if (!VALID_REASONS.has(reason)) {
      console.warn(`[SessionCollector] Unknown end reason: ${reason}, defaulting to 'error'`);
      reason = 'error';
    }

    const session = this._activeSessions.get(userId);

    if (!session) {
      console.warn(`[SessionCollector] session_end for userId=${userId} with no matching session_start`);
      this._eventBus.emitEvent('session', 'session_end', userId, null, {
        reason,
        durationMs: null,
        messagesExchanged: messagesExchanged || 0,
      });
      this._updateHistoryOnEnd(userId);
      return;
    }

    const durationMs = Date.now() - session.startTs;

    this._eventBus.emitEvent('session', 'session_end', userId, session.sessionId, {
      reason,
      durationMs,
      messagesExchanged: messagesExchanged || 0,
    });

    this._activeSessions.delete(userId);
    this._updateHistoryOnEnd(userId);
  }

  /**
   * Called when a user uses a trackable feature.
   * @param {string} userId
   * @param {string} feature - One of: 'canvas', 'tts', 'sub_agent', 'widget', 'passkey', 'theme_toggle'
   * @param {string} [detail] - Extra context (e.g. 'calendar widget', 'voice: River')
   * @param {string} [sessionId] - Override session id; defaults to active session's id
   */
  onFeatureUse(userId, feature, detail, sessionId) {
    if (!VALID_FEATURES.has(feature)) {
      console.warn(`[SessionCollector] Unknown feature: ${feature}`);
      return;
    }

    const session = this._activeSessions.get(userId);
    const resolvedSessionId = sessionId || (session && session.sessionId) || null;
    const firstUse = this._isFirstUse(userId, feature);
    const action = firstUse ? 'first_use' : 'regular_use';

    this._eventBus.emitEvent('session', 'feature_use', userId, resolvedSessionId, {
      feature,
      action,
      detail: detail || null,
    });
  }

  /**
   * Get count of currently active sessions.
   * @returns {number}
   */
  getActiveSessions() {
    return this._activeSessions.size;
  }

  /**
   * Get active session info for a specific user.
   * @param {string} userId
   * @returns {{ startTs: number, source: string, sessionId: string, userAgent: string }|undefined}
   */
  getSession(userId) {
    return this._activeSessions.get(userId);
  }

  /**
   * Flush history to disk and clean up timers.
   */
  destroy() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveHistory();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * @param {string} userId
   * @returns {boolean}
   */
  _isReturning(userId) {
    const history = this._userHistory.get(userId);
    return !!(history && history.lastSessionEnd !== null);
  }

  /**
   * @param {string} userId
   * @returns {number|null} Days since last visit, rounded, or null if first visit
   */
  _daysSinceLastVisit(userId) {
    const history = this._userHistory.get(userId);
    if (!history || history.lastSessionEnd === null) {
      return null;
    }
    return Math.round((Date.now() - history.lastSessionEnd) / MS_PER_DAY);
  }

  /**
   * Check if this is the first time the user has used a feature.
   * If first use, records it in history.
   * @param {string} userId
   * @param {string} feature
   * @returns {boolean}
   */
  _isFirstUse(userId, feature) {
    let history = this._userHistory.get(userId);
    if (!history) {
      history = { lastSessionEnd: null, features: new Set() };
      this._userHistory.set(userId, history);
    }

    if (history.features.has(feature)) {
      return false;
    }

    history.features.add(feature);
    this._scheduleSave();
    return true;
  }

  /**
   * Update user history after session end.
   * @param {string} userId
   */
  _updateHistoryOnEnd(userId) {
    let history = this._userHistory.get(userId);
    if (!history) {
      history = { lastSessionEnd: null, features: new Set() };
      this._userHistory.set(userId, history);
    }
    history.lastSessionEnd = Date.now();
    this._scheduleSave();
  }

  /**
   * Schedule a debounced save (at most once per SAVE_DEBOUNCE_MS).
   */
  _scheduleSave() {
    if (!this._historyFile) return;
    if (this._saveTimer) {
      this._savePending = true;
      return;
    }

    this._savePending = false;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveHistory();
      if (this._savePending) {
        this._scheduleSave();
      }
    }, SAVE_DEBOUNCE_MS);

    // Don't keep the process alive just for history saving
    if (this._saveTimer && typeof this._saveTimer.unref === 'function') {
      this._saveTimer.unref();
    }
  }

  /**
   * Load user history from disk.
   */
  _loadHistory() {
    if (!this._historyFile) return;

    try {
      const raw = fs.readFileSync(this._historyFile, 'utf8');
      const data = JSON.parse(raw);

      for (const [userId, entry] of Object.entries(data)) {
        this._userHistory.set(userId, {
          lastSessionEnd: entry.lastSessionEnd ?? null,
          features: new Set(entry.features || []),
        });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[SessionCollector] Failed to load history from ${this._historyFile}:`, err.message);
      }
      // ENOENT is fine — first run, no history yet
    }
  }

  /**
   * Save user history to disk atomically (write tmp then rename).
   */
  _saveHistory() {
    if (!this._historyFile) return;

    const serialized = {};
    for (const [userId, entry] of this._userHistory) {
      serialized[userId] = {
        lastSessionEnd: entry.lastSessionEnd,
        features: Array.from(entry.features),
      };
    }

    const tmpFile = this._historyFile + '.tmp.' + process.pid;

    try {
      const dir = path.dirname(this._historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(tmpFile, JSON.stringify(serialized, null, 2), 'utf8');
      fs.renameSync(tmpFile, this._historyFile);
    } catch (err) {
      console.warn(`[SessionCollector] Failed to save history to ${this._historyFile}:`, err.message);
      // Clean up tmp file on failure
      try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Factory function to create a SessionCollector instance.
 * @param {object} [eventBus] - Analytics event bus instance
 * @param {object} [opts]
 * @param {string} [opts.historyFile] - Path to persist user history JSON
 * @returns {SessionCollector}
 */
function createSessionCollector(eventBus, opts) {
  return new SessionCollector(eventBus, opts);
}

module.exports = { SessionCollector, createSessionCollector };
