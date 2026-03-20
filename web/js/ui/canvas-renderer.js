// ============================================
// Scratchy — CanvasRenderer (tile grid)
// ============================================
// Extracted from app.js: tile DOM creation, FLIP animation,
// skeleton placeholders, staggered entrance, view transitions.
// IIFE pattern — exposes window.DashRenderer.

(function() {
  "use strict";

  // ── Span classification ──
  var SPAN_MAP = {
    small:  ["sparkline","gauge","progress","status","rating","toggle","slider"],
    medium: ["card","stats","alert","checklist","kv","buttons","link-card","chips",
             "input","form-strip","streak","stacked-bar","chart-pie","tags","weather"],
    wide:   ["chart-bar","chart-line","table","code","tabs","accordion"],
    full:   ["hero","form","timeline"]
  };

  function spanOf(type) {
    for (var s in SPAN_MAP) {
      if (SPAN_MAP[s].indexOf(type) !== -1) return s;
    }
    return "medium";
  }

  // ── Constructor ──

  function DashRenderer(gridEl, emptyEl) {
    this.grid = gridEl;
    this.empty = emptyEl;
    this._els = {};           // componentId -> DOM element
    this._liveInstances = {}; // componentId -> { el, update }
    this._skeletonIds = [];
    this._pendingOps = [];
    this._flipRAF = null;
    this._flipDuration = 250;
    this._batching = false;

    // Subscribe to bus events for reactive updates
    if (window.ScratchyBus) {
      var self = this;
      window.ScratchyBus.on("canvas:op:applied", function(entry) {
        // Op already applied to store — we just need to render
        // The onChange listener in app.js calls queueOp, but if someone
        // wants purely bus-driven rendering they can use this.
      });
    }
  }

  // ── Skeleton placeholders ──

  var SKELETON_SHAPES = [
    '<div style="padding:16px;"><div class="skeleton-bar wide"></div><div class="skeleton-bar medium"></div><div class="skeleton-bar narrow"></div></div>',
    '<div style="padding:16px;display:flex;gap:12px;align-items:center;"><div class="skeleton-bar circle"></div><div style="flex:1;"><div class="skeleton-bar wide"></div><div class="skeleton-bar medium"></div></div></div>',
    '<div style="padding:16px;"><div class="skeleton-bar narrow"></div><div style="display:flex;gap:8px;margin-top:8px;"><div class="skeleton-bar" style="height:60px;width:33%;"></div><div class="skeleton-bar" style="height:60px;width:33%;"></div><div class="skeleton-bar" style="height:60px;width:33%;"></div></div></div>'
  ];

  DashRenderer.prototype.showSkeletons = function(count) {
    if (!this.grid) return;
    this.clearSkeletons();
    count = count || 3;
    for (var i = 0; i < count; i++) {
      var tile = document.createElement("div");
      tile.className = "dash-tile dash-sm skeleton shimmer";
      tile.dataset.componentId = "_skeleton_" + i;
      tile.innerHTML = '<div class="tile-inner">' + SKELETON_SHAPES[i % SKELETON_SHAPES.length] + '</div>';
      tile.style.opacity = "0";
      this.grid.appendChild(tile);
      this._skeletonIds.push("_skeleton_" + i);
      (function(t) {
        requestAnimationFrame(function() {
          t.style.transition = "opacity 0.3s ease";
          t.style.opacity = "1";
        });
      })(tile);
    }
    if (this.empty) this.empty.style.display = "none";
  };

  DashRenderer.prototype.clearSkeletons = function() {
    if (!this.grid) return;
    for (var i = 0; i < this._skeletonIds.length; i++) {
      var el = this.grid.querySelector('[data-component-id="' + this._skeletonIds[i] + '"]');
      if (el) {
        el.style.transition = "opacity 0.2s ease";
        el.style.opacity = "0";
        (function(e) {
          setTimeout(function() { if (e.parentNode) e.parentNode.removeChild(e); }, 200);
        })(el);
      }
    }
    this._skeletonIds = [];
  };

  // ── Tile creation ──

  DashRenderer.prototype.createTile = function(comp) {
    var span = spanOf(comp.type);
    var tile = document.createElement("div");
    tile.className = "dash-tile dash-" + span;
    tile.dataset.componentId = comp.id;
    tile.dataset.id = comp.id;
    tile.dataset.type = comp.type;
    tile.dataset.order = (comp.layout && comp.layout.order != null) ? comp.layout.order : 999;
    tile.setAttribute("role", "article");
    tile.setAttribute("tabindex", "0");
    tile.setAttribute("aria-label",
      (comp.data && comp.data.title ? comp.data.title : comp.type) + " component");

    // Smart-widget size class
    if (comp.type === "smart-widget") {
      var size = null;
      if (comp.config && comp.config.size) size = comp.config.size;
      else if (comp.data && comp.data.config && comp.data.config.size) size = comp.data.config.size;
      if (size && size !== "default") tile.classList.add("widget-" + size);
    }

    // Start invisible for FLIP entrance
    tile.style.opacity = "0";
    tile.style.transform = "scale(0.92) translateY(8px)";
    tile.style.willChange = "transform, opacity";
    tile.style.backfaceVisibility = "hidden";

    this.fillTile(tile, comp);
    return tile;
  };

  DashRenderer.prototype.fillTile = function(tile, comp) {
    var data = comp.data || {};
    var self = this;

    // Try live component first
    if (typeof LiveComponents !== "undefined" && LiveComponents.has(comp.type)) {
      var existing = this._liveInstances[comp.id];
      if (existing) {
        existing.update(data);
        return;
      }
      var lc = LiveComponents.create(comp.type, data);
      if (lc) {
        this._liveInstances[comp.id] = lc;
        tile.innerHTML = "";
        tile.appendChild(lc.el);
        return;
      }
    }

    // Fallback: HTML string renderers with crossfade
    var d = { component: comp.type };
    if (comp.data) { for (var k in comp.data) d[k] = comp.data[k]; }
    var html = (typeof renderCanvasComponent === "function")
      ? renderCanvasComponent(d)
      : (typeof renderComponent === "function" ? renderComponent(JSON.stringify(d)) : "");

    if (tile.children.length > 0 && tile.style.opacity !== "0") {
      var wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      wrapper.style.opacity = "0";
      wrapper.style.transition = "opacity 150ms ease";
      var oldChildren = Array.from(tile.children);
      for (var ci = 0; ci < oldChildren.length; ci++) {
        oldChildren[ci].style.transition = "opacity 100ms ease";
        oldChildren[ci].style.opacity = "0";
      }
      setTimeout(function() {
        tile.innerHTML = "";
        tile.appendChild(wrapper);
        requestAnimationFrame(function() { wrapper.style.opacity = "1"; });
      }, 100);
    } else {
      tile.innerHTML = html;
    }
  };

  // ── Grid helpers ──

  DashRenderer.prototype.reorder = function() {
    if (!this.grid) return;
    var tiles = Array.from(this.grid.children).filter(function(e) {
      return e.classList.contains("dash-tile");
    });
    tiles.sort(function(a, b) {
      return (parseInt(a.dataset.order) || 0) - (parseInt(b.dataset.order) || 0);
    });
    for (var i = 0; i < tiles.length; i++) {
      tiles[i].style.setProperty("--tile-index", i);
      this.grid.appendChild(tiles[i]);
    }
  };

  DashRenderer.prototype.updateEmpty = function() {
    if (!this.grid || !this.empty) return;
    var hasTiles = this.grid.querySelector(".dash-tile");
    this.empty.style.display = hasTiles ? "none" : "flex";
  };

  // ── Batch / FLIP animation system ──

  DashRenderer.prototype.beginBatch = function() {
    this._batching = true;
    if (this._flipRAF) {
      cancelAnimationFrame(this._flipRAF);
      this._flipRAF = null;
    }
  };

  DashRenderer.prototype.endBatch = function() {
    this._batching = false;
    if (this._pendingOps.length > 0 && !this._flipRAF) {
      var self = this;
      this._flipRAF = requestAnimationFrame(function() { self.flushOps(); });
    }
  };

  DashRenderer.prototype.queueOp = function(type, data) {
    this._pendingOps.push({ type: type, data: data });
    if (!this._batching && !this._flipRAF) {
      var self = this;
      this._flipRAF = requestAnimationFrame(function() { self.flushOps(); });
    }
  };

  DashRenderer.prototype.flushOps = function() {
    this._flipRAF = null;
    if (!this.grid || this._pendingOps.length === 0) return;
    if (this._skeletonIds.length > 0) this.clearSkeletons();

    var rawOps = this._pendingOps;
    this._pendingOps = [];

    // Deduplicate
    var ops = [];
    var seen = {};
    for (var i = 0; i < rawOps.length; i++) {
      var rop = rawOps[i];
      var rid = rop.data && rop.data.id;
      if (rid && (rop.type === "patch" || rop.type === "upsert" || rop.type === "move")) {
        if (rid in seen) {
          var prevIdx = seen[rid];
          var prev = ops[prevIdx];
          if (prev && prev.type === "upsert" && rop.type === "patch") {
            if (rop.data.data) {
              prev.data.data = prev.data.data || {};
              var pkeys = Object.keys(rop.data.data);
              for (var pk = 0; pk < pkeys.length; pk++) {
                prev.data.data[pkeys[pk]] = rop.data.data[pkeys[pk]];
              }
            }
          } else {
            ops[prevIdx] = null;
            seen[rid] = ops.length;
            ops.push(rop);
          }
          continue;
        }
        seen[rid] = ops.length;
      }
      ops.push(rop);
    }
    ops = ops.filter(function(o) { return o !== null; });

    // FIRST: batch-read current positions
    var oldPos = {};
    var existingTiles = this.grid.querySelectorAll(".dash-tile");
    for (var i = 0; i < existingTiles.length; i++) {
      var id = existingTiles[i].dataset.componentId;
      if (id) oldPos[id] = existingTiles[i].getBoundingClientRect();
    }

    // Batch-write: DOM mutations
    var entering = [];
    var leaving = [];
    var self = this;

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      switch (op.type) {
        case "upsert":
        case "patch":
        case "move": {
          var ex = this._els[op.data.id];
          if (ex) {
            this.fillTile(ex, op.data);
            var ns = spanOf(op.data.type);
            var nc = "dash-tile dash-" + ns;
            if (ex.className !== nc) ex.className = nc;
            if (ex.dataset.type !== op.data.type) ex.dataset.type = op.data.type;
            if (op.data.layout && op.data.layout.order != null) {
              ex.dataset.order = op.data.layout.order;
            }
          } else {
            var el = this.createTile(op.data);
            this._els[op.data.id] = el;
            this.grid.appendChild(el);
            entering.push(el);
          }
          break;
        }
        case "remove": {
          if (op.data && op.data.id && this._els[op.data.id]) {
            leaving.push(this._els[op.data.id]);
            delete this._els[op.data.id];
            delete this._liveInstances[op.data.id];
          }
          break;
        }
        case "clear": {
          var ids = Object.keys(this._els);
          for (var ci = 0; ci < ids.length; ci++) {
            leaving.push(this._els[ids[ci]]);
          }
          this._els = {};
          this._liveInstances = {};
          break;
        }
        case "layout":
          this.grid.dataset.layout = op.data.mode || "auto";
          break;
      }
    }

    // View Transitions for clear+rebuild
    var skipLeaveAnim = leaving.length > 0 && entering.length > 0;
    if (skipLeaveAnim) {
      var doSwap = function() {
        for (var i = 0; i < leaving.length; i++) {
          if (leaving[i].parentNode) leaving[i].parentNode.removeChild(leaving[i]);
        }
        for (var i = 0; i < entering.length; i++) {
          entering[i].style.opacity = "1";
          entering[i].style.transform = "";
          entering[i].style.willChange = "";
        }
      };
      if (document.startViewTransition) {
        document.startViewTransition(doSwap);
      } else {
        doSwap();
      }
      this.reorder();
      this.updateEmpty();
      return;
    }

    // Animate leaving
    for (var i = 0; i < leaving.length; i++) {
      leaving[i].style.transition = "opacity 150ms ease, transform 150ms ease";
      leaving[i].style.opacity = "0";
      leaving[i].style.transform = "scale(0.95)";
      leaving[i].style.pointerEvents = "none";
      (function(el) {
        setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 160);
      })(leaving[i]);
    }

    var enterDelay = leaving.length > 0 ? 170 : 0;
    var flipDuration = this._flipDuration;

    setTimeout(function() {
      self.reorder();

      // FLIP: animate moved tiles
      var invertData = [];
      var allTiles = self.grid.querySelectorAll(".dash-tile");
      for (var i = 0; i < allTiles.length; i++) {
        var tile = allTiles[i];
        var tid = tile.dataset.componentId;
        if (!tid || !oldPos[tid]) continue;
        var isNew = false;
        for (var j = 0; j < entering.length; j++) { if (entering[j] === tile) { isNew = true; break; } }
        if (isNew) continue;
        var nr = tile.getBoundingClientRect();
        var dx = oldPos[tid].left - nr.left;
        var dy = oldPos[tid].top - nr.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          invertData.push({ el: tile, dx: dx, dy: dy });
        }
      }

      for (var i = 0; i < invertData.length; i++) {
        invertData[i].el.style.transition = "none";
        invertData[i].el.style.transform = "translate(" + invertData[i].dx + "px, " + invertData[i].dy + "px)";
      }

      // Double-rAF
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          for (var i = 0; i < invertData.length; i++) {
            invertData[i].el.style.transition = "transform " + flipDuration + "ms cubic-bezier(0.22, 1, 0.36, 1)";
            invertData[i].el.style.transform = "";
          }

          // Staggered entrance
          var staggerMs = Math.max(30, Math.min(80, 400 / (entering.length || 1)));
          for (var i = 0; i < entering.length; i++) {
            (function(el, delay) {
              el.style.opacity = "0";
              el.style.transform = "translateY(16px)";
              el.style.transition = "none";
              el.offsetHeight; // force reflow
              el.style.transition = "opacity 350ms cubic-bezier(0.0, 0.0, 0.2, 1) " + delay + "ms, transform 400ms cubic-bezier(0.0, 0.0, 0.2, 1) " + delay + "ms";
              el.style.opacity = "1";
              el.style.transform = "translateY(0)";
            })(entering[i], i * staggerMs);
          }

          var totalTime = flipDuration + entering.length * staggerMs + 200;
          setTimeout(function() {
            for (var i = 0; i < invertData.length; i++) {
              invertData[i].el.style.transition = "";
              invertData[i].el.style.transform = "";
            }
            for (var i = 0; i < entering.length; i++) {
              entering[i].style.transition = "";
              entering[i].style.opacity = "";
              entering[i].style.transform = "";
              entering[i].style.willChange = "";
            }
            self.updateEmpty();
          }, totalTime);
        });
      });
    }, enterDelay);

    this.updateEmpty();
  };

  // ── Immediate reset (page load / restore) ──

  DashRenderer.prototype.resetFromState = function(components) {
    if (!this.grid) return;
    var ids = Object.keys(this._els);
    for (var i = 0; i < ids.length; i++) {
      if (this._els[ids[i]].parentNode) this._els[ids[i]].remove();
    }
    this._els = {};
    this._liveInstances = {};

    if (Array.isArray(components)) {
      for (var i = 0; i < components.length; i++) {
        var c = components[i];
        var el = this.createTile(c);
        el.style.opacity = "1";
        el.style.transform = "";
        el.dataset.order = (c.layout && c.layout.order != null) ? c.layout.order : i;
        this._els[c.id] = el;
        this.grid.appendChild(el);
      }
      this.reorder();
    }
    this.updateEmpty();
  };

  // ── Expose ──
  window.DashRenderer = DashRenderer;

})();
