/**
 * ToonStreamParser — incremental streaming parser for scratchy-toon blocks.
 *
 * Mirrors StreamCanvasParser (app.js) but handles TOON format instead of
 * JSON-per-line.  Each op is a TOON document separated by `---`.
 *
 * Depends on: ToonParser (toon-parser.js) — must be loaded first.
 *
 * Usage:
 *   ToonStreamParser.onOp = function(op) { canvasState.apply(op); };
 *   // during streaming:
 *   ToonStreamParser.feed(accumulatedText);
 *   // when stream ends:
 *   ToonStreamParser.finalize();
 */
var ToonStreamParser = (function () {
  'use strict';

  var _inBlock = false;       // inside a ```scratchy-toon block
  var _accumulator = '';      // accumulated TOON lines for the current op
  var _appliedHashes = {};    // dedup: hash → true
  var _lastScanPos = 0;       // resume position in accumulated text
  var _onOp = null;           // callback: function(op)

  /**
   * Simple hash for dedup — same logic as StreamCanvasParser._hashOp.
   */
  function _hashOp(op) {
    return (op.op || '') + '|' + (op.id || '') + '|' + JSON.stringify(op.data || {});
  }

  /**
   * Parse accumulated TOON text into a JSON op and emit it (deduped).
   */
  function _emitOp(toonText) {
    var trimmed = toonText.trim();
    if (!trimmed) return;

    // Use the global ToonParser if available, otherwise bail
    var parser = (typeof ToonParser !== 'undefined') ? ToonParser : null;
    if (!parser) {
      // eslint-disable-next-line no-console
      console.warn('[ToonStreamParser] ToonParser not loaded — cannot parse toon block');
      return;
    }

    var op;
    try {
      op = parser.parseBlock(trimmed);
    } catch (e) {
      // Malformed TOON — skip silently (may be partial during streaming)
      return;
    }

    if (!op || typeof op !== 'object') return;

    // Dedup
    var h = _hashOp(op);
    if (_appliedHashes[h]) return;
    _appliedHashes[h] = true;

    if (_onOp) {
      _onOp(op);
    }
  }

  /**
   * Feed the full accumulated message text (called on every streaming chunk).
   * Scans from _lastScanPos forward, line by line.
   */
  function feed(text) {
    var pos = _lastScanPos;

    while (pos < text.length) {
      var nlIdx = text.indexOf('\n', pos);
      if (nlIdx === -1) break; // no complete line yet — wait for more data
      var line = text.substring(pos, nlIdx);
      var trimmedLine = line.trim();
      pos = nlIdx + 1;

      if (!_inBlock) {
        // Look for block opener
        if (trimmedLine === '```scratchy-toon') {
          _inBlock = true;
          _accumulator = '';
        }
      } else {
        // Inside a toon block
        if (trimmedLine === '```') {
          // Block closer — emit whatever is accumulated, then exit
          _emitOp(_accumulator);
          _accumulator = '';
          _inBlock = false;
        } else if (trimmedLine === '---') {
          // Op separator — emit accumulated op, start fresh
          _emitOp(_accumulator);
          _accumulator = '';
        } else {
          // Accumulate line (preserve original indentation for TOON parsing)
          if (_accumulator) {
            _accumulator += '\n' + line;
          } else {
            _accumulator = line;
          }
        }
      }
    }

    _lastScanPos = pos;
  }

  /**
   * Called when the stream ends. Resets all state for the next message.
   */
  function finalize() {
    // If we're still inside a block with accumulated text, emit it
    if (_inBlock && _accumulator.trim()) {
      _emitOp(_accumulator);
    }
    _inBlock = false;
    _accumulator = '';
    _appliedHashes = {};
    _lastScanPos = 0;
  }

  var api = {
    feed: feed,
    finalize: finalize,
    set onOp(fn) { _onOp = fn; },
    get onOp() { return _onOp; }
  };

  // Expose globally (browser) + CommonJS (Node.js testing)
  if (typeof window !== 'undefined') window.ToonStreamParser = api;
  if (typeof globalThis !== 'undefined') globalThis.ToonStreamParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  return api;
})();
