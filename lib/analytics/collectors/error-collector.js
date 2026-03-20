'use strict';

const { analyticsEventBus } = require('../event-bus');

/**
 * ErrorCollector — captures errors from all layers:
 * gateway, WebSocket, widgets, and user-facing.
 */
class ErrorCollector {
  /**
   * @param {object} [eventBus] - Analytics event bus instance
   * @param {object} [opts] - Options (reserved for future use)
   */
  constructor(eventBus, opts = {}) {
    this._eventBus = eventBus || analyticsEventBus;
    this._widgetPrefixMap = {
      'cal-': 'calendar',
      'mail-': 'email',
      'sn-': 'notes',
      'spotify-': 'spotify',
      'youtube-': 'youtube',
      'admin-': 'admin',
      'analytics-': 'analytics'
    };
  }

  /**
   * Called when the gateway returns an error.
   * @param {Error|object} error - The error object or plain object with status/message
   * @param {string} provider - Provider name (e.g. 'openai', 'anthropic')
   * @param {string} model - Model identifier
   * @param {string} userId - User ID
   * @param {string} sessionId - Session ID
   */
  onGatewayError(error, provider, model, userId, sessionId) {
    const { errorCode, errorType, retryable } = this._classifyGatewayError(error);
    const message = this._truncate(
      (error && (error.message || error.msg)) || 'Unknown error',
      500
    );

    this._eventBus.emitEvent('error', 'gateway_error', userId, sessionId, {
      errorCode,
      errorType,
      provider,
      model,
      message,
      retryable
    });
  }

  /**
   * Called on WebSocket error or close.
   * @param {string} errorType - One of: 'disconnect', 'timeout', 'auth_fail', 'protocol'
   * @param {string} userId - User ID
   * @param {number} connectionDurationMs - How long the connection was alive
   * @param {string} sessionId - Session ID
   */
  onWsError(errorType, userId, connectionDurationMs, sessionId) {
    this._eventBus.emitEvent('error', 'ws_error', userId, sessionId, {
      errorType,
      userId,
      connectionDurationMs
    });
  }

  /**
   * Called when a widget action fails.
   * @param {string} action - The widget action that failed (e.g. 'cal-create')
   * @param {Error|object} error - The error
   * @param {string} userId - User ID
   * @param {string} sessionId - Session ID
   */
  onWidgetError(action, error, userId, sessionId) {
    const widget = this._extractWidget(action);
    const message = this._truncate(
      (error && (error.message || error.msg)) || 'Unknown error',
      500
    );
    const errorType = (error && error.type) || (error && error.code) || 'unknown';

    this._eventBus.emitEvent('error', 'widget_error', userId, sessionId, {
      widget,
      action,
      errorType,
      message
    });
  }

  /**
   * Called when displaying an error to the user.
   * @param {string|null} originalErrorId - Reference to the original error event ID
   * @param {string} displayedMessage - The message shown to the user
   * @param {boolean} recoverable - Whether the user can retry
   * @param {string} userId - User ID
   * @param {string} sessionId - Session ID
   */
  onUserFacingError(originalErrorId, displayedMessage, recoverable, userId, sessionId) {
    this._eventBus.emitEvent('error', 'user_facing_error', userId, sessionId, {
      originalError: originalErrorId || null,
      displayedMessage: this._truncate(displayedMessage || '', 500),
      recoverable: !!recoverable
    });
  }

  /**
   * Classify a gateway error into errorCode, errorType, and retryable.
   * @param {Error|object} error
   * @returns {{ errorCode: number|string|null, errorType: string, retryable: boolean }}
   * @private
   */
  _classifyGatewayError(error) {
    if (!error) {
      return { errorCode: null, errorType: 'api_error', retryable: false };
    }

    const code = error.status || error.statusCode || null;
    const errCode = error.code || null;

    // Check for timeout by error code (ETIMEDOUT, ECONNRESET, etc.)
    if (errCode === 'ETIMEDOUT' || errCode === 'ECONNRESET') {
      return { errorCode: errCode, errorType: 'timeout', retryable: true };
    }

    if (typeof code === 'number') {
      if (code === 429) {
        return { errorCode: code, errorType: 'rate_limit', retryable: true };
      }
      if (code === 401 || code === 403) {
        return { errorCode: code, errorType: 'auth', retryable: false };
      }
      if (code === 408) {
        return { errorCode: code, errorType: 'timeout', retryable: true };
      }
      if (code >= 500) {
        return { errorCode: code, errorType: 'internal', retryable: false };
      }
    }

    return { errorCode: code || errCode || null, errorType: 'api_error', retryable: false };
  }

  /**
   * Extract the widget name from an action string via prefix matching.
   * @param {string} action
   * @returns {string}
   * @private
   */
  _extractWidget(action) {
    if (!action || typeof action !== 'string') return 'unknown';

    for (const prefix of Object.keys(this._widgetPrefixMap)) {
      if (action.startsWith(prefix)) {
        return this._widgetPrefixMap[prefix];
      }
    }

    return 'unknown';
  }

  /**
   * Truncate a string to a maximum length.
   * @param {string} str
   * @param {number} max
   * @returns {string}
   * @private
   */
  _truncate(str, max) {
    if (!str || typeof str !== 'string') return '';
    if (str.length <= max) return str;
    return str.slice(0, max);
  }

  /** Clean up resources (no-op for now). */
  destroy() {}
}

/**
 * Factory function to create an ErrorCollector instance.
 * @param {object} [eventBus] - Analytics event bus instance
 * @param {object} [opts] - Options
 * @returns {ErrorCollector}
 */
function createErrorCollector(eventBus, opts) {
  return new ErrorCollector(eventBus, opts);
}

module.exports = { ErrorCollector, createErrorCollector };
