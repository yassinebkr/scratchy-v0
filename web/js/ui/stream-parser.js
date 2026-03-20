// ============================================
// Scratchy — StreamParser (Placeholder)
// ============================================
// IIFE pattern — will expose window.ScratchyStreamParser
//
// This is a placeholder documenting the interface for the StreamParser
// that will be extracted from app.js's StreamCanvasParser.
//
// DO NOT use this yet — the actual implementation lives in app.js.
// This file exists to define the contract for future extraction.
//
// ── Interface ──
//
//   var parser = new ScratchyStreamParser(options);
//
//   // Feed a streaming text delta (incremental chunk from SSE)
//   parser.push(deltaText);
//
//   // Get current parsed state
//   var state = parser.getState();
//   // Returns: {
//   //   text: string,         — accumulated plain text (canvas ops stripped)
//   //   canvasOps: CanvasOp[] — parsed canvas operations
//   // }
//
//   // Reset parser state (new message)
//   parser.reset();
//
// ── CanvasOp format ──
//
//   {
//     type: "create" | "update" | "replace" | "delete",
//     target: string,       — canvas element ID or selector
//     content: string,      — HTML/text content for the op
//     language: string,     — optional language hint
//     metadata: object      — optional extra data
//   }
//
// ── Events (emitted on window.ScratchyBus if available) ──
//
//   "canvas:op"  — { op: CanvasOp }  — fired when a complete canvas op is parsed
//
// ── Dependencies ──
//
//   - window.ScratchyBus (optional) — event bus for canvas:op events
//
// ── Migration plan ──
//
//   1. Extract StreamCanvasParser from app.js into this file
//   2. Adapt to emit events on ScratchyBus instead of direct DOM manipulation
//   3. MessageRenderer.renderStreamingDelta() will consume parser.getState().text
//   4. Canvas component will listen for "canvas:op" events
//

(function() {
  "use strict";

  // Stub — not yet implemented
  function StreamParser() {
    this._buffer = "";
    this._canvasOps = [];
    console.warn("[StreamParser] Using placeholder — real implementation is still in app.js");
  }

  StreamParser.prototype = {
    push: function(delta) {
      this._buffer += delta;
      // TODO: parse canvas operations from buffer
    },
    getState: function() {
      return {
        text: this._buffer,
        canvasOps: this._canvasOps.slice()
      };
    },
    reset: function() {
      this._buffer = "";
      this._canvasOps = [];
    }
  };

  window.ScratchyStreamParser = StreamParser;
})();
