/**
 * toon-encoder.js — Server-side TOON encoder for Scratchy canvas ops.
 *
 * Uses the official @toon-format/toon package for core encoding/decoding,
 * plus Scratchy-specific helpers for canvas ops, state, and widget context.
 *
 * TOON (Token-Oriented Object Notation) saves ~30-40% tokens vs JSON
 * when encoding structured data for LLM prompts.
 */

'use strict';

const { encode, decode, encodeLines } = require('@toon-format/toon');

// ── Core encode/decode (re-exported from official package) ──────────────

/**
 * Encode any JS value to TOON format.
 * @param {*} obj - Value to encode
 * @param {object} [opts] - Options
 * @param {number} [opts.indent=0] - Starting indentation level (each level = 2 spaces)
 * @returns {string} TOON-encoded string
 */
function toonEncode(obj, opts = {}) {
  const encoded = encode(obj);
  const indent = opts.indent || 0;
  if (indent === 0) return encoded;
  const prefix = '  '.repeat(indent);
  return encoded.split('\n').map(line => line ? prefix + line : line).join('\n');
}

/**
 * Decode a TOON string back to a JS value.
 * @param {string} toon - TOON string
 * @returns {*} Decoded value
 */
function toonDecode(toon) {
  // Split on --- separator for multi-op blocks
  const blocks = toon.split(/\n---\n/);
  if (blocks.length === 1) {
    return decode(toon);
  }
  // Decode each block independently — isolate failures per block
  const results = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    try {
      results.push(decode(trimmed));
    } catch (e) {
      // Skip bad block but continue decoding remaining blocks
      console.error('[TOON] Block decode error (skipping):', e.message);
    }
  }
  return results;
}

// ── Scratchy canvas op encoding ─────────────────────────────────────────

/**
 * Encode a single canvas op object to TOON.
 * Strips undefined/null optional fields for compactness.
 * @param {object} op - Canvas op {op, id, type, data, layout}
 * @returns {string}
 */
function encodeOp(op) {
  // Build a clean object with only defined fields, in canonical order
  const clean = {};
  if (op.op != null) clean.op = op.op;
  if (op.id != null) clean.id = op.id;
  if (op.type != null) clean.type = op.type;
  if (op.data != null) clean.data = op.data;
  if (op.layout != null) clean.layout = op.layout;
  if (op.mode != null) clean.mode = op.mode; // for layout ops
  return encode(clean);
}

/**
 * Encode an array of Scratchy canvas ops into TOON with `---` separators.
 * @param {object[]} opsArray - Array of canvas op objects
 * @returns {string} TOON blocks separated by ---
 */
function toonEncodeOps(opsArray) {
  if (!Array.isArray(opsArray) || opsArray.length === 0) return '';
  return opsArray.map(encodeOp).join('\n---\n');
}

// ── Canvas state encoding ───────────────────────────────────────────────

/**
 * Encode the server's canvas state (Map or object) into a compact TOON
 * summary suitable for LLM context injection.
 *
 * @param {Map|object} serverCanvasState - Map<id, {type, data, layout}> or plain object
 * @returns {string} Compact TOON summary
 */
function toonEncodeCanvasState(serverCanvasState) {
  if (!serverCanvasState) return '';

  // Normalise: accept Map or plain object
  const entries = serverCanvasState instanceof Map
    ? Array.from(serverCanvasState.entries())
    : Object.entries(serverCanvasState);

  if (entries.length === 0) return '';

  const blocks = entries.map(([id, component]) => {
    const obj = { id };
    if (component.type) obj.type = component.type;
    if (component.data) obj.data = component.data;
    if (component.layout) obj.layout = component.layout;
    return encode(obj);
  });

  return blocks.join('\n---\n');
}

// ── Widget action context encoding ──────────────────────────────────────

/**
 * Encode widget action context for LLM input.
 * Typical shape: { action, widgetId, widgetType, value, formData, ... }
 *
 * @param {object} context - Widget action context
 * @returns {string} TOON-encoded context
 */
function toonEncodeWidgetContext(context) {
  if (!context || typeof context !== 'object') return '';
  return encode(context);
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  // Core
  toonEncode,
  toonDecode,
  encode,   // re-export official encode
  decode,   // re-export official decode

  // Scratchy-specific
  toonEncodeOps,
  toonEncodeCanvasState,
  toonEncodeWidgetContext,
};
