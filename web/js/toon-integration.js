// ============================================
// Scratchy — TOON Integration
// ============================================
// Provides block extraction and streaming parser for scratchy-toon blocks.
// Depends on window.ToonParser (toon-parser.js) for actual TOON→JSON parsing.
// Designed to work alongside existing scratchy-canvas parsing.
//
// Usage:
//   // Full-message parse (after streaming completes)
//   var result = ToonIntegration.parseBlocks(messageText);
//   // result.ops   — Array of canvas ops (JSON objects)
//   // result.cleanText — message text with scratchy-toon blocks stripped
//
//   // Streaming parse (during SSE streaming)
//   var sp = ToonIntegration.createStreamParser({ onOp: function(op) { ... } });
//   sp.feed(accumulatedText);   // call on each delta
//   sp.finalize();              // call when stream ends
//

(function() {
  "use strict";

  // ── Regex for scratchy-toon fenced blocks ──
  var BLOCK_RE = /```scratchy-toon\s*\n([\s\S]*?)```/g;

  // ── Opening fence (for streaming detection) ──
  var FENCE_OPEN  = "```scratchy-toon";
  var FENCE_CLOSE = "```";

  // ── Op separator inside a block ──
  var OP_SEP = "---";

  // ── Helpers ──

  /**
   * Build a dedup hash for a canvas op.
   * Matches the pattern used by StreamCanvasParser in app.js.
   * @param {Object} op - Canvas operation object
   * @returns {string} Hash string
   */
  function hashOp(op) {
    return (op.op || "") + "|" + (op.id || "") + "|" + JSON.stringify(op.data || {});
  }

  /**
   * Safely call ToonParser.parseOps on a full block body (may contain multiple ops
   * separated by ---). Returns an array of parsed op objects.
   * @param {string} blockContent - Raw TOON text (everything between the fences)
   * @returns {Array<Object>} Parsed canvas operations
   */
  function parseBlockContent(blockContent) {
    if (typeof window.ToonParser === "undefined" || typeof window.ToonParser.parseOps !== "function") {
      console.warn("[ToonIntegration] ToonParser.parseOps not available");
      return [];
    }
    try {
      var ops = window.ToonParser.parseOps(blockContent);
      return Array.isArray(ops) ? ops : [];
    } catch (e) {
      console.error("[ToonIntegration] parseOps error:", e);
      return [];
    }
  }

  /**
   * Safely call ToonParser.parse on a single op's TOON text.
   * @param {string} opText - Raw TOON text for one operation
   * @returns {Object|null} Parsed canvas operation or null
   */
  function parseSingleOp(opText) {
    if (typeof window.ToonParser === "undefined" || typeof window.ToonParser.parse !== "function") {
      console.warn("[ToonIntegration] ToonParser.parse not available");
      return null;
    }
    try {
      return window.ToonParser.parse(opText);
    } catch (e) {
      console.error("[ToonIntegration] parse error:", e);
      return null;
    }
  }

  // ── parseBlocks ──

  /**
   * Extract all scratchy-toon blocks from a full message, parse them into
   * canvas ops, and return the cleaned text with blocks removed.
   *
   * @param {string} text - Full message text
   * @returns {{ ops: Array<Object>, cleanText: string }}
   */
  function parseBlocks(text) {
    if (!text || typeof text !== "string") {
      return { ops: [], cleanText: text || "" };
    }

    var allOps = [];
    var match;

    // Reset regex state
    BLOCK_RE.lastIndex = 0;

    while ((match = BLOCK_RE.exec(text)) !== null) {
      var blockBody = match[1];
      var ops = parseBlockContent(blockBody);
      for (var i = 0; i < ops.length; i++) {
        allOps.push(ops[i]);
      }
    }

    // Strip all scratchy-toon blocks from the text
    var cleanText = text.replace(BLOCK_RE, "").trim();

    return { ops: allOps, cleanText: cleanText };
  }

  // ── createStreamParser ──

  /**
   * Create a streaming parser for incremental TOON block parsing during SSE
   * streaming. Mirrors the design of StreamCanvasParser in app.js.
   *
   * @param {Object} [options]
   * @param {function(Object): void} [options.onOp] - Callback invoked with each
   *   parsed canvas op as soon as it's complete.
   * @returns {{ feed: function(string): void, finalize: function(): void, getOps: function(): Array<Object> }}
   */
  function createStreamParser(options) {
    options = options || {};
    var onOp = typeof options.onOp === "function" ? options.onOp : null;

    // State
    var _inBlock = false;        // currently inside a scratchy-toon fence
    var _lastScanPos = 0;        // resume position in accumulated text
    var _currentOpLines = [];    // accumulated lines for the current op
    var _appliedHashes = {};     // dedup: hash → true
    var _emittedOps = [];        // all emitted ops (for getOps)

    /**
     * Emit a single parsed op (with dedup).
     * @param {Object} op
     */
    function emitOp(op) {
      if (!op || !op.op) return;
      var h = hashOp(op);
      if (_appliedHashes[h]) return;
      _appliedHashes[h] = true;
      _emittedOps.push(op);
      if (onOp) {
        try { onOp(op); } catch (e) {
          console.error("[ToonIntegration] onOp callback error:", e);
        }
      }
    }

    /**
     * Flush accumulated op lines — parse them as a single TOON op and emit.
     */
    function flushCurrentOp() {
      if (_currentOpLines.length === 0) return;
      var text = _currentOpLines.join("\n");
      _currentOpLines = [];

      var op = parseSingleOp(text);
      if (op) {
        emitOp(op);
      }
    }

    /**
     * Feed accumulated text (not just delta — full accumulated text so far).
     * Scans from where it left off, detecting block boundaries and op separators.
     *
     * @param {string} text - Full accumulated message text so far
     */
    function feed(text) {
      if (!text || typeof text !== "string") return;

      var pos = _lastScanPos;

      while (pos < text.length) {
        // Find next complete line
        var nlIdx = text.indexOf("\n", pos);
        if (nlIdx === -1) break; // no complete line yet — wait for more data

        var line = text.substring(pos, nlIdx);
        var trimmed = line.trim();
        pos = nlIdx + 1;

        if (!_inBlock) {
          // Look for opening fence
          if (trimmed === FENCE_OPEN) {
            _inBlock = true;
            _currentOpLines = [];
          }
          // Otherwise ignore — not our block
        } else {
          // Inside a scratchy-toon block
          if (trimmed === FENCE_CLOSE) {
            // Block closed — flush any pending op
            flushCurrentOp();
            _inBlock = false;
          } else if (trimmed === OP_SEP) {
            // Op separator — flush current op and start next
            flushCurrentOp();
          } else {
            // Accumulate line (preserve original indentation for TOON parsing)
            _currentOpLines.push(line);
          }
        }
      }

      _lastScanPos = pos;
    }

    /**
     * Finalize the stream — flush any remaining op and reset state.
     * Should be called when the message stream ends.
     */
    function finalize() {
      // If we're still inside a block, flush whatever we have
      if (_inBlock) {
        flushCurrentOp();
      }
      _inBlock = false;
      _lastScanPos = 0;
      _currentOpLines = [];
      _appliedHashes = {};
    }

    /**
     * Get all ops emitted so far (for inspection/debugging).
     * @returns {Array<Object>}
     */
    function getOps() {
      return _emittedOps.slice();
    }

    return {
      feed: feed,
      finalize: finalize,
      getOps: getOps
    };
  }

  // ── Expose on window ──

  window.ToonIntegration = {
    parseBlocks: parseBlocks,
    createStreamParser: createStreamParser,
    /** @internal Exposed for testing */
    _hashOp: hashOp
  };

})();
