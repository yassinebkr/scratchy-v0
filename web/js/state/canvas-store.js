// ============================================
// Scratchy — CanvasStore (reactive state store)
// ============================================
// Extracted from canvas-state.js with op log, version tracking,
// per-op listeners, and ScratchyBus integration.
// IIFE pattern — exposes window.canvasStore (+ window.canvasState alias).

(function() {
  "use strict";

  var OP_LOG_MAX = 100;

  function CanvasStore() {
    this.components = {};    // id -> component object
    this.layout = "auto";    // "auto" | "dashboard" | "focus" | "columns" | "rows"
    this.version = 0;
    this.sessionKey = null;

    this._listeners = [];    // legacy onChange listeners: (type, data) => void
    this._opListeners = [];  // per-op listeners: (entry) => void
    this._opLog = [];        // last N ops: { op, component, version, ts }
  }

  // ── Op log helpers ──

  CanvasStore.prototype._logOp = function(op, component) {
    var entry = {
      op: op,
      component: component || null,
      version: this.version,
      ts: Date.now()
    };
    this._opLog.push(entry);
    if (this._opLog.length > OP_LOG_MAX) {
      this._opLog.shift();
    }
    // Notify op listeners
    for (var i = 0; i < this._opListeners.length; i++) {
      try { this._opListeners[i](entry); } catch(e) {
        console.error("[CanvasStore] onOp listener error:", e);
      }
    }
    // Emit on bus
    this._busEmit("canvas:op:applied", entry);
    return entry;
  };

  CanvasStore.prototype._busEmit = function(event, data) {
    if (window.ScratchyBus && typeof window.ScratchyBus.emit === "function") {
      window.ScratchyBus.emit(event, data);
    }
  };

  // ── Public: subscribe to individual ops ──

  CanvasStore.prototype.onOp = function(fn) {
    if (typeof fn === "function") this._opListeners.push(fn);
  };

  // ── Public: get op log ──

  CanvasStore.prototype.getOpLog = function() {
    return this._opLog.slice();
  };

  // ── Core apply (same logic as original CanvasState) ──

  CanvasStore.prototype.apply = function(op) {
    if (!op || !op.op) return false;

    var changed = false;
    var now = Date.now();

    switch (op.op) {
      case "upsert": {
        var id = op.id, type = op.type, data = op.data, layout = op.layout;
        if (!id || !type) return false;

        var existing = this.components[id];
        var defaultLayout = { zone: "auto", order: 0 };

        if (existing) {
          this.components[id] = {
            id: existing.id,
            type: type,
            data: data || existing.data,
            layout: layout || existing.layout,
            createdAt: existing.createdAt,
            updatedAt: now
          };
        } else {
          this.components[id] = {
            id: id,
            type: type,
            data: data || {},
            layout: layout || defaultLayout,
            createdAt: now,
            updatedAt: now
          };
        }
        this._notify("upsert", this.components[id]);
        changed = true;
        break;
      }

      case "patch": {
        var comp = this.components[op.id];
        if (comp && op.data) {
          comp.data = this._deepMerge(comp.data || {}, op.data);
          comp.updatedAt = now;
          this._notify("patch", comp);
          changed = true;
        }
        break;
      }

      case "remove": {
        if (this.components[op.id]) {
          var removed = { id: op.id };
          delete this.components[op.id];
          this._notify("remove", removed);
          changed = true;
        }
        break;
      }

      case "clear": {
        this.components = {};
        this._notify("clear", {});
        this._busEmit("canvas:cleared", { version: this.version + 1 });
        changed = true;
        break;
      }

      case "layout": {
        if (op.mode && this.layout !== op.mode) {
          this.layout = op.mode;
          this._notify("layout", { mode: op.mode });
          changed = true;
        }
        break;
      }

      case "move": {
        var mc = this.components[op.id];
        if (mc && op.layout) {
          for (var k in op.layout) {
            if (Object.prototype.hasOwnProperty.call(op.layout, k)) {
              if (!mc.layout) mc.layout = {};
              mc.layout[k] = op.layout[k];
            }
          }
          mc.updatedAt = now;
          this._notify("move", mc);
          changed = true;
        }
        break;
      }
    }

    if (changed) {
      this.version++;
      this._logOp(op, op.id ? this.components[op.id] || { id: op.id } : null);
    }

    return changed;
  };

  // ── Snapshot loading ──

  CanvasStore.prototype.loadSnapshot = function(state) {
    if (!state) return;
    this.components = state.components || {};
    this.layout = state.layout || "auto";
    this.version = state.version || 0;
    if (state.sessionKey) this.sessionKey = state.sessionKey;

    this._notify("reset", this.getAll());
    this._busEmit("canvas:snapshot", {
      version: this.version,
      count: Object.keys(this.components).length
    });
  };

  // ── Convenience methods ──

  CanvasStore.prototype.clear = function() {
    this.apply({ op: "clear" });
  };

  CanvasStore.prototype.switchSession = function(sessionKey) {
    this.sessionKey = sessionKey;
    this.clear();
    this.version = 0;
    this._opLog = [];
  };

  CanvasStore.prototype.get = function(id) {
    return this.components[id];
  };

  CanvasStore.prototype.getAll = function() {
    return Object.values(this.components).sort(function(a, b) {
      var orderA = (a.layout && a.layout.order) || 0;
      var orderB = (b.layout && b.layout.order) || 0;
      return orderA - orderB;
    });
  };

  // ── Legacy onChange ──

  CanvasStore.prototype.onChange = function(fn) {
    this._listeners.push(fn);
  };

  CanvasStore.prototype._notify = function(type, data) {
    for (var i = 0; i < this._listeners.length; i++) {
      try { this._listeners[i](type, data); } catch(e) {
        console.error("[CanvasStore] listener error:", e);
      }
    }
  };

  // ── Deep merge helper ──

  CanvasStore.prototype._deepMerge = function(target, source) {
    if (typeof target !== "object" || target === null) return source;
    if (typeof source !== "object" || source === null) return source;

    var output = {};
    var k;
    for (k in target) {
      if (Object.prototype.hasOwnProperty.call(target, k)) {
        output[k] = target[k];
      }
    }
    for (k in source) {
      if (Object.prototype.hasOwnProperty.call(source, k)) {
        if (source[k] && typeof source[k] === "object" && !Array.isArray(source[k])) {
          output[k] = this._deepMerge(target[k], source[k]);
        } else {
          output[k] = source[k];
        }
      }
    }
    return output;
  };

  // ── Expose globally ──
  // Use CanvasStore as the constructor so app.js can do `new CanvasState()` or `new CanvasStore()`
  window.CanvasStore = CanvasStore;
  window.CanvasState = CanvasStore; // backward compat — same constructor

  // Singleton instance (app.js currently does `new CanvasState()` then `window.canvasState = ...`)
  // We pre-create the singleton so it's available immediately
  if (!window.canvasStore) {
    window.canvasStore = new CanvasStore();
    window.canvasState = window.canvasStore; // alias
  }

})();
