'use strict';

const { analyticsEventBus } = require('../event-bus');

/** Maximum bytes to stringify for result size calculation (1MB) */
const MAX_STRINGIFY_BYTES = 1024 * 1024;

/**
 * Collects analytics events for tool usage — starts, completions, and errors.
 * Tracks duration, success/failure rates, and result sizes.
 */
class ToolCollector {
  /**
   * @param {object} [eventBus] - Analytics event bus instance. Defaults to the shared analyticsEventBus.
   * @param {object} [opts]
   * @param {RegExp[]} [opts.sensitivePatterns] - Patterns to redact from argument previews.
   */
  constructor(eventBus, opts = {}) {
    this._eventBus = eventBus || analyticsEventBus;
    this._pendingCalls = new Map();
    this._sensitivePatterns = opts.sensitivePatterns || [
      /(?:api[_-]?key|token|password|secret|authorization)["\s:=]+["']?[\w\-\.]{8,}/gi,
      /Bearer\s+[\w\-\.]{8,}/gi,
      /sk-[a-zA-Z0-9]{8,}/gi,
      /re_[a-zA-Z0-9]{8,}/gi
    ];
  }

  /**
   * Record the start of a tool call.
   * @param {string} callId - Unique identifier for this tool invocation.
   * @param {string} toolName - Name of the tool being called.
   * @param {*} args - Arguments passed to the tool.
   * @param {string} userId - ID of the user who initiated the call.
   * @param {string} sessionId - Current session ID.
   */
  onToolStart(callId, toolName, args, userId, sessionId) {
    this._pendingCalls.set(callId, {
      toolName,
      startTs: Date.now(),
      userId,
      sessionId
    });

    const argsPreview = this._sanitizeArgs(args);

    this._eventBus.emitEvent('tool', 'tool_start', userId, sessionId, {
      toolName,
      callId,
      argsPreview
    });
  }

  /**
   * Record the successful completion of a tool call.
   * @param {string} callId - Unique identifier for this tool invocation.
   * @param {*} result - The result returned by the tool.
   * @param {string} userId - ID of the user who initiated the call.
   * @param {string} sessionId - Current session ID.
   */
  onToolEnd(callId, result, userId, sessionId) {
    const elapsed = this._getElapsed(callId);

    if (!elapsed) {
      console.warn(`[ToolCollector] tool_end received for unknown callId: ${callId}`);
    }

    const toolName = elapsed ? elapsed.toolName : 'unknown';
    const durationMs = elapsed ? elapsed.durationMs : null;

    // Calculate result size, capping stringify to avoid OOM
    let resultSizeBytes = 0;
    let truncated = false;
    try {
      const json = JSON.stringify(result);
      if (json && json.length > MAX_STRINGIFY_BYTES) {
        resultSizeBytes = Buffer.byteLength(json.slice(0, MAX_STRINGIFY_BYTES), 'utf8');
        truncated = true;
      } else {
        resultSizeBytes = json ? Buffer.byteLength(json, 'utf8') : 0;
      }
    } catch (_) {
      resultSizeBytes = 0;
    }

    // Also check if the tool itself flagged truncation
    if (result && result.truncated === true) {
      truncated = true;
    }

    this._eventBus.emitEvent('tool', 'tool_end', userId || (elapsed && elapsed.userId), sessionId || (elapsed && elapsed.sessionId), {
      toolName,
      callId,
      durationMs,
      success: true,
      resultSizeBytes,
      truncated
    });
  }

  /**
   * Record a failed tool call.
   * @param {string} callId - Unique identifier for this tool invocation.
   * @param {Error|object} error - The error that occurred.
   * @param {string} userId - ID of the user who initiated the call.
   * @param {string} sessionId - Current session ID.
   */
  onToolError(callId, error, userId, sessionId) {
    const elapsed = this._getElapsed(callId);

    if (!elapsed) {
      console.warn(`[ToolCollector] tool_error received for unknown callId: ${callId}`);
    }

    const toolName = elapsed ? elapsed.toolName : 'unknown';
    const durationMs = elapsed ? elapsed.durationMs : null;
    const errorType = this._classifyError(error);
    const errorMessage = (error && (error.message || String(error))) || 'Unknown error';

    this._eventBus.emitEvent('tool', 'tool_error', userId || (elapsed && elapsed.userId), sessionId || (elapsed && elapsed.sessionId), {
      toolName,
      callId,
      durationMs,
      errorType,
      errorMessage: errorMessage.slice(0, 500)
    });
  }

  /**
   * Sanitize tool arguments for safe logging.
   * JSON-stringifies, redacts sensitive patterns, and truncates to 100 chars.
   * @param {*} args
   * @returns {string}
   * @private
   */
  _sanitizeArgs(args) {
    let str;
    try {
      str = JSON.stringify(args) || '';
    } catch (_) {
      str = '[unserializable]';
    }

    // Redact sensitive patterns
    for (const pattern of this._sensitivePatterns) {
      // Reset lastIndex since patterns may have the global flag
      pattern.lastIndex = 0;
      str = str.replace(pattern, '[REDACTED]');
    }

    // Truncate to 100 characters
    if (str.length > 100) {
      str = str.slice(0, 100) + '…';
    }

    return str;
  }

  /**
   * Classify an error into one of the known error type categories.
   * @param {Error|object} error
   * @returns {'timeout'|'permission'|'crash'|'validation'|'unknown'}
   * @private
   */
  _classifyError(error) {
    const msg = ((error && (error.message || error.code || String(error))) || '').toLowerCase();

    if (/timeout|timed?\s*out|etimedout|deadline/i.test(msg)) {
      return 'timeout';
    }
    if (/permission|forbidden|eacces|unauthorized|access denied/i.test(msg)) {
      return 'permission';
    }
    if (/syntax|validation|invalid|schema|type error|typeerror/i.test(msg)) {
      return 'validation';
    }
    if (/segfault|sigsegv|sigabrt|fatal|crash/i.test(msg)) {
      return 'crash';
    }

    return 'unknown';
  }

  /**
   * Retrieve elapsed time and metadata for a pending call, then remove it.
   * @param {string} callId
   * @returns {{ durationMs: number, toolName: string, userId: string, sessionId: string }|null}
   * @private
   */
  _getElapsed(callId) {
    const pending = this._pendingCalls.get(callId);
    if (!pending) {
      return null;
    }

    this._pendingCalls.delete(callId);

    return {
      durationMs: Date.now() - pending.startTs,
      toolName: pending.toolName,
      userId: pending.userId,
      sessionId: pending.sessionId
    };
  }

  /**
   * Clean up internal state. Call when the collector is no longer needed.
   */
  destroy() {
    this._pendingCalls.clear();
  }
}

/**
 * Factory function to create a new ToolCollector instance.
 * @param {object} [eventBus] - Analytics event bus instance.
 * @param {object} [opts] - Options passed to the ToolCollector constructor.
 * @returns {ToolCollector}
 */
function createToolCollector(eventBus, opts) {
  return new ToolCollector(eventBus, opts);
}

module.exports = { ToolCollector, createToolCollector };
