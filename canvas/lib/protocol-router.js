/**
 * ProtocolRouter — Routes envelope messages to registered handlers by type.
 */

class ProtocolRouter {
  /**
   * @param {object} [validator] - Optional MessageValidator instance with a validate(envelope) method.
   */
  constructor(validator) {
    this._validator = validator || null;
    this._handlers = new Map();
  }

  /**
   * Register a handler for a message type.
   * @param {'a2ui'|'ag-ui'|'chat'|'v1'} type
   * @param {function(envelope, context): void} handler
   */
  on(type, handler) {
    this._handlers.set(type, handler);
  }

  /**
   * Route an envelope to the appropriate handler.
   * @param {object} envelope - Normalized envelope with {type, payload}.
   * @param {object} context  - {ws, sessionKey, ...}
   * @returns {{routed: boolean, errors: string[]}}
   */
  route(envelope, context) {
    const errors = [];

    // Validate if we have a validator
    if (this._validator && typeof this._validator.validate === 'function') {
      const result = this._validator.validate(envelope);
      if (result && result.errors && result.errors.length > 0) {
        return { routed: false, errors: result.errors };
      }
    }

    const handler = this._handlers.get(envelope.type);
    if (!handler) {
      return { routed: false, errors: [`No handler registered for type: ${envelope.type}`] };
    }

    try {
      handler(envelope, context);
    } catch (err) {
      return { routed: false, errors: [err.message] };
    }

    return { routed: true, errors: [] };
  }

  /**
   * Wrap a payload in a typed envelope with timestamp.
   * @param {string} type
   * @param {object} payload
   * @returns {{type: string, payload: object, ts: number}}
   */
  static wrap(type, payload) {
    return { type, payload, ts: Date.now() };
  }

  /**
   * Normalize an incoming message into an envelope.
   * - If it already has a `type` and `payload`, return as-is.
   * - If it's an array (raw v1 ops), wrap as {type:'v1', payload:{ops}}.
   * @param {object|array} message
   * @returns {object} envelope
   */
  static normalize(message) {
    if (Array.isArray(message)) {
      return { type: 'v1', payload: { ops: message } };
    }
    if (message && typeof message.type === 'string' && message.payload !== undefined) {
      return message;
    }
    // Unknown format — wrap as v1 if it has an ops property
    if (message && Array.isArray(message.ops)) {
      return { type: 'v1', payload: { ops: message.ops } };
    }
    return message;
  }
}

module.exports = { ProtocolRouter };
