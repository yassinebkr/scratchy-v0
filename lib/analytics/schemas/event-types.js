/**
 * @module event-types
 * @description Canonical event type definitions and validation for the analytics system.
 * Defines all valid event types, subtypes, meta schemas, and provides
 * factory/validation functions for creating well-formed analytics events.
 */

'use strict';

const { randomUUID } = require('crypto');

/**
 * Valid event types mapped to their allowed subtypes.
 * @type {Record<string, string[]>}
 */
const EVENT_TYPES = {
  conversation: ['user_message', 'assistant_response', 'session_summary'],
  tool: ['tool_start', 'tool_end', 'tool_error'],
  error: ['gateway_error', 'ws_error', 'widget_error', 'user_facing_error'],
  session: ['session_start', 'session_end', 'feature_use'],
  system: ['startup', 'shutdown', 'config_change'],
};

/**
 * Enum constants for constrained fields.
 */
const ENUMS = {
  toolErrorType: ['timeout', 'permission', 'crash', 'validation', 'unknown'],
  gatewayErrorType: ['api_error', 'rate_limit', 'auth', 'timeout', 'internal'],
  wsErrorType: ['disconnect', 'timeout', 'auth_fail', 'protocol'],
  sessionEndReason: ['idle_timeout', 'explicit_close', 'ws_disconnect', 'error'],
  feature: ['canvas', 'tts', 'sub_agent', 'widget', 'passkey', 'theme_toggle'],
  featureAction: ['first_use', 'regular_use'],
};

/**
 * @typedef {Object} FieldDef
 * @property {'string'|'number'|'boolean'|'array'|'object'} type
 * @property {boolean} [required=true]
 * @property {string[]} [enum] - Allowed values for enum-constrained fields
 */

/**
 * Meta schemas keyed by "type:subtype". Each value describes the expected
 * meta fields with their types, whether they are required, and optional enum constraints.
 * @type {Record<string, Record<string, FieldDef>>}
 */
const META_SCHEMAS = {
  // -- conversation --
  'conversation:user_message': {
    length:        { type: 'number', required: true },
    wordCount:     { type: 'number', required: true },
    hasAttachment: { type: 'boolean', required: true },
    source:        { type: 'string', required: true },
  },
  'conversation:assistant_response': {
    length:           { type: 'number', required: true },
    wordCount:        { type: 'number', required: true },
    responseTimeMs:   { type: 'number', required: true },
    totalTimeMs:      { type: 'number', required: true },
    model:            { type: 'string', required: true },
    provider:         { type: 'string', required: true },
    inputTokens:      { type: 'number', required: false },
    outputTokens:     { type: 'number', required: false },
    cacheReadTokens:  { type: 'number', required: false },
    cacheWriteTokens: { type: 'number', required: false },
    cost:             { type: 'number', required: false },
    hasCanvasOps:     { type: 'boolean', required: false },
    canvasOpCount:    { type: 'number', required: false },
    toolCallCount:    { type: 'number', required: false },
  },
  'conversation:session_summary': {
    durationMs:          { type: 'number', required: true },
    messageCount:        { type: 'number', required: true },
    userMessages:        { type: 'number', required: true },
    assistantMessages:   { type: 'number', required: true },
    avgUserLength:       { type: 'number', required: false },
    avgAssistantLength:  { type: 'number', required: false },
    backAndForthDepth:   { type: 'number', required: false },
    totalCost:           { type: 'number', required: false },
    modelsUsed:          { type: 'array', required: false },
    toolsUsed:           { type: 'array', required: false },
    canvasOpsTotal:      { type: 'number', required: false },
    satisfactionSignal:  { type: 'string', required: false },
  },

  // -- tool --
  'tool:tool_start': {
    toolName:    { type: 'string', required: true },
    callId:      { type: 'string', required: true },
    argsPreview: { type: 'string', required: false },
  },
  'tool:tool_end': {
    toolName:        { type: 'string', required: true },
    callId:          { type: 'string', required: true },
    durationMs:      { type: 'number', required: true },
    success:         { type: 'boolean', required: true },
    resultSizeBytes: { type: 'number', required: false },
    truncated:       { type: 'boolean', required: false },
  },
  'tool:tool_error': {
    toolName:     { type: 'string', required: true },
    callId:       { type: 'string', required: true },
    durationMs:   { type: 'number', required: true },
    errorType:    { type: 'string', required: true, enum: ENUMS.toolErrorType },
    errorMessage: { type: 'string', required: true },
  },

  // -- error --
  'error:gateway_error': {
    errorCode: { type: 'number', required: true },
    errorType: { type: 'string', required: true, enum: ENUMS.gatewayErrorType },
    provider:  { type: 'string', required: true },
    model:     { type: 'string', required: true },
    message:   { type: 'string', required: true },
    retryable: { type: 'boolean', required: true },
  },
  'error:ws_error': {
    errorType:            { type: 'string', required: true, enum: ENUMS.wsErrorType },
    userId:               { type: 'string', required: false },
    connectionDurationMs: { type: 'number', required: false },
  },
  'error:widget_error': {
    widget:    { type: 'string', required: true },
    action:    { type: 'string', required: true },
    errorType: { type: 'string', required: true },
    message:   { type: 'string', required: true },
  },
  'error:user_facing_error': {
    originalError:    { type: 'string', required: true },
    displayedMessage: { type: 'string', required: true },
    recoverable:      { type: 'boolean', required: true },
  },

  // -- session --
  'session:session_start': {
    source:            { type: 'string', required: true },
    userAgent:         { type: 'string', required: false },
    returning:         { type: 'boolean', required: false },
    daysSinceLastVisit: { type: 'number', required: false },
  },
  'session:session_end': {
    reason:             { type: 'string', required: true, enum: ENUMS.sessionEndReason },
    durationMs:         { type: 'number', required: true },
    messagesExchanged:  { type: 'number', required: false },
  },
  'session:feature_use': {
    feature: { type: 'string', required: true, enum: ENUMS.feature },
    action:  { type: 'string', required: true, enum: ENUMS.featureAction },
    detail:  { type: 'string', required: false },
  },

  // -- system --
  'system:startup': {
    version: { type: 'string', required: true },
    uptime:  { type: 'number', required: false },
  },
  'system:shutdown': {
    reason: { type: 'string', required: true },
    uptime: { type: 'number', required: false },
  },
  'system:config_change': {
    key:      { type: 'string', required: true },
    oldValue: { type: 'string', required: false },
    newValue: { type: 'string', required: true },
  },
};

/**
 * Check if a JS value matches the expected type string.
 * @param {*} value
 * @param {'string'|'number'|'boolean'|'array'|'object'} expected
 * @returns {boolean}
 */
function matchesType(value, expected) {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === expected;
}

/**
 * Validate an analytics event object.
 * Checks the top-level structure (type, subtype) and validates meta fields
 * against the corresponding schema including type checks and enum constraints.
 *
 * @param {Object} event - The event to validate.
 * @param {string} event.type - Event type (e.g. 'conversation').
 * @param {string} event.subtype - Event subtype (e.g. 'user_message').
 * @param {Object} [event.meta] - Event metadata payload.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['Event must be a non-null object'] };
  }

  const { type, subtype, meta } = event;

  // -- type --
  if (!type || typeof type !== 'string') {
    errors.push('Missing or invalid "type"');
  } else if (!EVENT_TYPES[type]) {
    errors.push(`Unknown event type "${type}". Valid types: ${Object.keys(EVENT_TYPES).join(', ')}`);
  }

  // -- subtype --
  if (!subtype || typeof subtype !== 'string') {
    errors.push('Missing or invalid "subtype"');
  } else if (EVENT_TYPES[type] && !EVENT_TYPES[type].includes(subtype)) {
    errors.push(`Unknown subtype "${subtype}" for type "${type}". Valid: ${EVENT_TYPES[type].join(', ')}`);
  }

  // If type/subtype are bad we can't validate meta further
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const schemaKey = `${type}:${subtype}`;
  const schema = META_SCHEMAS[schemaKey];

  if (!schema) {
    errors.push(`No meta schema defined for "${schemaKey}"`);
    return { valid: false, errors };
  }

  const metaObj = meta || {};

  // Check required fields and types
  for (const [field, def] of Object.entries(schema)) {
    const value = metaObj[field];
    const isPresent = value !== undefined && value !== null;

    if (def.required && !isPresent) {
      errors.push(`Missing required meta field "${field}"`);
      continue;
    }

    if (isPresent) {
      if (!matchesType(value, def.type)) {
        errors.push(`Meta field "${field}" must be of type ${def.type}, got ${typeof value}`);
      } else if (def.enum && !def.enum.includes(value)) {
        errors.push(`Meta field "${field}" must be one of [${def.enum.join(', ')}], got "${value}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create a validated analytics event with auto-generated id and timestamp.
 *
 * @param {string} type - Event type (e.g. 'conversation').
 * @param {string} subtype - Event subtype (e.g. 'user_message').
 * @param {string|null} userId - User identifier (nullable for system events).
 * @param {string|null} sessionId - Session identifier (nullable for system events).
 * @param {Object} [meta={}] - Event metadata payload.
 * @returns {Object} The complete event object with id, ts, type, subtype, userId, sessionId, meta.
 * @throws {Error} If the event fails validation.
 */
function createEvent(type, subtype, userId, sessionId, meta = {}) {
  const event = {
    id: randomUUID(),
    ts: Date.now(),
    type,
    subtype,
    userId: userId || null,
    sessionId: sessionId || null,
    meta,
  };

  const { valid, errors } = validateEvent(event);
  if (!valid) {
    throw new Error(`Invalid event (${type}:${subtype}): ${errors.join('; ')}`);
  }

  return event;
}

module.exports = {
  EVENT_TYPES,
  ENUMS,
  META_SCHEMAS,
  validateEvent,
  createEvent,
};
