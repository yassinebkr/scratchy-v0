'use strict';

const { analyticsEventBus } = require('../event-bus');

const GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Collects conversation analytics: user messages, assistant responses,
 * and session summaries emitted on idle timeout.
 */
class ConversationCollector {
  /**
   * @param {object} [eventBus] - Analytics event bus instance
   * @param {object} [opts]
   * @param {number} [opts.idleTimeoutMs=1800000] - Idle timeout before session summary (default 30 min)
   */
  constructor(eventBus, opts = {}) {
    this._eventBus = eventBus || analyticsEventBus;
    this._idleTimeoutMs = opts.idleTimeoutMs || 30 * 60 * 1000;

    /** @type {Map<string, object>} userId → session state */
    this._sessions = new Map();
  }

  /**
   * Initialise or retrieve the tracking state for a user.
   * @param {string} userId
   * @param {string} sessionId
   * @returns {object} session state
   */
  _ensureSession(userId, sessionId) {
    if (!this._sessions.has(userId)) {
      const now = Date.now();
      this._sessions.set(userId, {
        sessionId,
        startTs: now,
        lastActivityTs: now,
        messages: [],
        idleTimer: null,
        userMsgTimestamp: null,
        firstTokenTs: null,
        modelsUsed: new Set(),
        toolsUsed: new Set(),
        totalCost: 0,
        canvasOpsTotal: 0,
      });
    }
    return this._sessions.get(userId);
  }

  /**
   * Called by serve.js when a user sends a message.
   * @param {string} userId
   * @param {object} message - { text, attachment }
   * @param {string} source - Channel: 'webchat', 'whatsapp', 'discord', 'signal', etc.
   * @param {string} sessionId
   */
  onUserMessage(userId, message, source, sessionId) {
    const session = this._ensureSession(userId, sessionId);
    const now = Date.now();
    const text = (message && message.text) || '';
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const hasAttachment = !!(message && message.attachment);

    const meta = {
      length: text.length,
      wordCount,
      hasAttachment,
      source: source || 'unknown',
    };

    this._eventBus.emitEvent('conversation', 'user_message', userId, sessionId, meta);

    session.userMsgTimestamp = now;
    session.firstTokenTs = null;
    session.lastActivityTs = now;
    session.messages.push({
      role: 'user',
      ts: now,
      length: text.length,
    });

    this._resetIdleTimer(userId);
  }

  /**
   * Called by serve.js when the AI response completes (after streaming).
   * @param {string} userId
   * @param {object} response - { text, firstTokenTs }
   * @param {object} usage - { model, provider, input, output, cacheRead, cacheWrite, cost, toolCalls }
   * @param {string} sessionId
   */
  onAssistantResponse(userId, response, usage, sessionId) {
    const session = this._ensureSession(userId, sessionId);
    const now = Date.now();
    const text = (response && response.text) || '';
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const firstTokenTs = (response && response.firstTokenTs) || now;

    const responseTimeMs = session.userMsgTimestamp
      ? firstTokenTs - session.userMsgTimestamp
      : 0;
    const totalTimeMs = session.userMsgTimestamp
      ? now - session.userMsgTimestamp
      : 0;

    // Count canvas ops by matching {"op": patterns
    const canvasBlockRe = /scratchy-canvas|scratchy-toon/g;
    const hasCanvasOps = canvasBlockRe.test(text);
    const canvasOpMatches = text.match(/\{"op":/g);
    const canvasOpCount = canvasOpMatches ? canvasOpMatches.length : 0;

    const usageData = usage || {};
    const toolCallCount = Array.isArray(usageData.toolCalls)
      ? usageData.toolCalls.length
      : (typeof usageData.toolCalls === 'number' ? usageData.toolCalls : 0);

    const meta = {
      length: text.length,
      wordCount,
      responseTimeMs,
      totalTimeMs,
      model: usageData.model || null,
      provider: usageData.provider || null,
      inputTokens: usageData.input || 0,
      outputTokens: usageData.output || 0,
      cacheReadTokens: usageData.cacheRead || 0,
      cacheWriteTokens: usageData.cacheWrite || 0,
      cost: usageData.cost || 0,
      hasCanvasOps,
      canvasOpCount,
      toolCallCount,
    };

    this._eventBus.emitEvent('conversation', 'assistant_response', userId, sessionId, meta);

    // Accumulate session-level stats
    if (usageData.model) session.modelsUsed.add(usageData.model);
    if (Array.isArray(usageData.toolCalls)) {
      for (const tc of usageData.toolCalls) {
        if (tc && tc.name) session.toolsUsed.add(tc.name);
      }
    }
    session.totalCost += usageData.cost || 0;
    session.canvasOpsTotal += canvasOpCount;
    session.lastActivityTs = now;
    session.messages.push({
      role: 'assistant',
      ts: now,
      length: text.length,
    });

    this._resetIdleTimer(userId);
  }

  /**
   * Called when a WebSocket disconnects or session explicitly ends.
   * @param {string} userId
   * @param {string} [reason='disconnect']
   */
  onSessionEnd(userId, reason) {
    if (!this._sessions.has(userId)) return;
    this._emitSessionSummary(userId, reason || 'disconnect');
  }

  /**
   * Reset the idle timer for a user. Fires session_summary on expiry.
   * @param {string} userId
   * @private
   */
  _resetIdleTimer(userId) {
    const session = this._sessions.get(userId);
    if (!session) return;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    session.idleTimer = setTimeout(() => {
      this._emitSessionSummary(userId, 'idle');
    }, this._idleTimeoutMs);
  }

  /**
   * Compute and emit a session_summary event, then clean up session state.
   * @param {string} userId
   * @param {string} reason - 'idle' | 'disconnect' | custom
   * @private
   */
  _emitSessionSummary(userId, reason) {
    const session = this._sessions.get(userId);
    if (!session) return;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    const msgs = session.messages;
    const userMsgs = msgs.filter(m => m.role === 'user');
    const assistantMsgs = msgs.filter(m => m.role === 'assistant');
    const durationMs = msgs.length > 0
      ? (session.lastActivityTs - session.startTs)
      : 0;

    const avgUserLength = userMsgs.length > 0
      ? Math.round(userMsgs.reduce((s, m) => s + m.length, 0) / userMsgs.length)
      : 0;
    const avgAssistantLength = assistantMsgs.length > 0
      ? Math.round(assistantMsgs.reduce((s, m) => s + m.length, 0) / assistantMsgs.length)
      : 0;

    // backAndForthDepth: consecutive user→assistant pairs without a >5 min gap
    let backAndForthDepth = 0;
    let currentDepth = 0;
    for (let i = 1; i < msgs.length; i++) {
      const gap = msgs[i].ts - msgs[i - 1].ts;
      if (gap > GAP_THRESHOLD_MS) {
        currentDepth = 0;
      }
      if (msgs[i - 1].role === 'user' && msgs[i].role === 'assistant') {
        currentDepth++;
        if (currentDepth > backAndForthDepth) {
          backAndForthDepth = currentDepth;
        }
      }
    }

    const meta = {
      durationMs,
      messageCount: msgs.length,
      userMessages: userMsgs.length,
      assistantMessages: assistantMsgs.length,
      avgUserLength,
      avgAssistantLength,
      backAndForthDepth,
      totalCost: session.totalCost,
      modelsUsed: [...session.modelsUsed],
      toolsUsed: [...session.toolsUsed],
      canvasOpsTotal: session.canvasOpsTotal,
      satisfactionSignal: null,
    };

    this._eventBus.emitEvent('conversation', 'session_summary', userId, session.sessionId, meta);
    this._sessions.delete(userId);
  }

  /**
   * Clean up all tracked sessions and timers.
   */
  destroy() {
    for (const [userId, session] of this._sessions) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
    }
    this._sessions.clear();
  }
}

/**
 * Factory function to create a ConversationCollector.
 * @param {object} [eventBus] - Analytics event bus instance
 * @param {object} [opts] - Options ({ idleTimeoutMs })
 * @returns {ConversationCollector}
 */
function createConversationCollector(eventBus, opts) {
  return new ConversationCollector(eventBus, opts);
}

module.exports = { ConversationCollector, createConversationCollector };
