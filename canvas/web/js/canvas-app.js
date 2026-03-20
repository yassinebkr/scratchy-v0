// ============================================
// Scratchy Canvas — Main App (Phase 5.1)
// ============================================
// Persistent spatial workspace with FLIP animations,
// drag-to-reorder, and tile resizing.
// Canvas is separate from chat — only receives canvas ops.

(function() {
  "use strict";

  // ── DOM refs ──
  var gridEl     = document.getElementById("canvas-grid");
  var emptyEl    = document.getElementById("canvas-empty");
  var inputEl    = document.getElementById("chat-input");
  var sendBtn    = document.getElementById("send-btn");
  var chatPanel  = document.getElementById("chat-panel");
  var chatToggle = document.getElementById("chat-panel-toggle");
  var chatMsgs   = document.getElementById("chat-messages");
  var chatStatus = document.getElementById("chat-status");

  // ── Chat Panel Toggle ──
  var chatExpanded = false;
  chatToggle.addEventListener("click", function() {
    chatExpanded = !chatExpanded;
    chatPanel.classList.toggle("expanded", chatExpanded);
  });

  function addChatMsg(role, text) {
    text = (text || "")
      .replace(/\[ClawOS Canary\][^\n]*/g, "")
      .replace(/\[message_id:[^\]]*\]/g, "")
      .replace(/\[genui:\w+\]/g, "")
      .replace(/```scratchy-canvas[\s\S]*?```/g, "")
      .replace(/```scratchy-toon[\s\S]*?```/g, "")
      .replace(/```scratchy-tpl[\s\S]*?```/g, "")
      .replace(/```scratchy-ui[\s\S]*?```/g, "")
      .trim();
    if (!text) return;
    if (text.length > 300) text = text.slice(0, 300) + "…";
    var div = document.createElement("div");
    div.className = "chat-msg chat-msg-" + role;
    div.innerHTML = '<span class="chat-msg-role">' + (role === "user" ? "You" : "Gil") + ':</span> ' +
      '<span>' + _esc(text) + '</span>';
    chatMsgs.appendChild(div);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  function _esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ── Connection Toast ──
  var toastEl = document.getElementById("conn-toast");
  var _toastTimer = null;
  function showToast(msg, cls, autoHide) {
    toastEl.textContent = msg;
    toastEl.className = "conn-toast visible" + (cls ? " " + cls : "");
    clearTimeout(_toastTimer);
    if (autoHide) _toastTimer = setTimeout(function() { toastEl.className = "conn-toast"; }, autoHide);
  }

  // ── Core State ──
  var state = new CanvasState();

  // ── Grid Element Tracking ──
  var _gridEls = {};  // id → DOM element

  var _SPAN = {
    small:  ["sparkline","gauge","progress","status","rating","toggle","slider"],
    medium: ["card","stats","alert","checklist","kv","buttons","link-card","chips",
             "input","form-strip","streak","stacked-bar","chart-pie","tags","weather"],
    wide:   ["chart-bar","chart-line","table","code","tabs","accordion"],
    full:   ["hero","form","timeline"]
  };

  function _spanOf(type) {
    for (var s in _SPAN) { if (_SPAN[s].indexOf(type) !== -1) return s; }
    return "medium";
  }

  function _renderHTML(comp) {
    var d = { component: comp.type };
    if (comp.data) { for (var k in comp.data) d[k] = comp.data[k]; }
    return (typeof renderCanvasComponent === "function")
      ? renderCanvasComponent(d) : "";
  }

  function _sanitize(html) {
    if (typeof DOMPurify !== "undefined") {
      return DOMPurify.sanitize(html, { ADD_ATTR: ["data-sui-send","data-sui-form","onclick","style"] });
    }
    return html;
  }

  // ═══════════════════════════════════════════
  // FLIP Animation System
  // ═══════════════════════════════════════════
  // Captures tile positions before DOM changes,
  // then animates tiles from old → new position.

  var _flipDuration = 220; // ms

  function _capturePositions() {
    var positions = {};
    var tiles = gridEl.querySelectorAll(".dash-tile");
    for (var i = 0; i < tiles.length; i++) {
      var id = tiles[i].dataset.componentId;
      if (id) {
        var rect = tiles[i].getBoundingClientRect();
        positions[id] = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }
    }
    return positions;
  }

  // _animateFlip is now inlined in _flushOps for zero-paint-gap FLIP

  // ═══════════════════════════════════════════
  // Tile CRUD with FLIP
  // ═══════════════════════════════════════════

  function _createTile(comp, hidden) {
    var span = comp._userSpan || _spanOf(comp.type);
    var el = document.createElement("div");
    el.className = "dash-tile dash-" + span;
    el.dataset.componentId = comp.id;
    el.dataset.type = comp.type;
    el.dataset.span = span;
    el.dataset.order = (comp.layout && comp.layout.order != null) ? comp.layout.order : 999;
    el.setAttribute("draggable", "true");

    // Start invisible — FLIP will reveal with animation
    if (hidden !== false) {
      el.style.opacity = "0";
    }

    // Inner content wrapper
    var inner = document.createElement("div");
    inner.className = "tile-inner";
    inner.innerHTML = _sanitize(_renderHTML(comp));
    el.appendChild(inner);

    // Resize handle
    var handle = document.createElement("div");
    handle.className = "tile-resize-handle";
    handle.title = "Drag to resize";
    el.appendChild(handle);

    return el;
  }

  function _updateTile(el, comp) {
    var newHTML = _renderHTML(comp);
    var inner = el.querySelector(".tile-inner");
    if (!inner) {
      inner = document.createElement("div");
      inner.className = "tile-inner";
      el.innerHTML = "";
      el.appendChild(inner);
    }
    if (typeof morphdom === "function") {
      var tmp = document.createElement("div");
      tmp.className = "tile-inner";
      tmp.innerHTML = _sanitize(newHTML);
      morphdom(inner, tmp, {
        onBeforeElUpdated: function(fromEl, toEl) {
          if (fromEl === document.activeElement) return false;
          return true;
        }
      });
    } else {
      inner.innerHTML = _sanitize(newHTML);
    }
    var ns = comp._userSpan || _spanOf(comp.type);
    el.className = el.className.replace(/dash-(small|medium|wide|full)/g, "dash-" + ns);
    el.dataset.type = comp.type;
    el.dataset.span = ns;
  }

  function _reorder() {
    var tiles = Array.from(gridEl.children).filter(function(e) { return e.classList.contains("dash-tile"); });
    tiles.sort(function(a, b) { return (parseInt(a.dataset.order)||0) - (parseInt(b.dataset.order)||0); });
    for (var i = 0; i < tiles.length; i++) gridEl.appendChild(tiles[i]);
  }

  function _updateEmpty() {
    var hasTiles = gridEl.querySelector(".dash-tile");
    emptyEl.style.display = hasTiles ? "none" : "flex";
  }

  // Batched update queue — collects ops within a frame, applies with single FLIP
  var _pendingOps = [];
  var _batchRAF = null;

  function _queueOp(type, data) {
    _pendingOps.push({ type: type, data: data });
    if (!_batchRAF) {
      _batchRAF = requestAnimationFrame(_flushOps);
    }
  }

  function _flushOps() {
    _batchRAF = null;
    if (_pendingOps.length === 0) return;

    var ops = _pendingOps;
    _pendingOps = [];

    // ════════════════════════════════════════════════
    // FLIP with double-rAF (state of the art pattern)
    // ════════════════════════════════════════════════

    // ── FIRST: batch-read all current positions ──
    var oldPos = {};
    var existingTiles = gridEl.querySelectorAll(".dash-tile");
    for (var i = 0; i < existingTiles.length; i++) {
      var id = existingTiles[i].dataset.componentId;
      if (id) oldPos[id] = existingTiles[i].getBoundingClientRect();
    }

    // ── Batch-write: apply all DOM mutations (no reads!) ──
    var entering = [];
    var leaving = [];

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      switch (op.type) {
        case "upsert":
        case "patch":
        case "move": {
          var ex = _gridEls[op.data.id];
          if (ex) {
            _updateTile(ex, op.data);
            if (op.data.layout && op.data.layout.order != null) {
              ex.dataset.order = op.data.layout.order;
            }
          } else {
            var el = _createTile(op.data);
            _gridEls[op.data.id] = el;
            gridEl.appendChild(el);
            entering.push(el);
          }
          break;
        }
        case "remove": {
          var el = _gridEls[op.data.id];
          if (el) {
            delete _gridEls[op.data.id];
            leaving.push(el);
          }
          break;
        }
        case "clear": {
          var ids = Object.keys(_gridEls);
          for (var j = 0; j < ids.length; j++) {
            var cel = _gridEls[ids[j]];
            if (cel) leaving.push(cel);
          }
          _gridEls = {};
          break;
        }
        case "layout":
          gridEl.dataset.layout = op.data.mode || "auto";
          break;
      }
    }

    _reorder();
    _updateEmpty();

    // ── Set entering tiles invisible (no transition) ──
    for (var i = 0; i < entering.length; i++) {
      entering[i].style.opacity = "0";
      entering[i].style.transform = "scale(0.92) translateY(8px)";
    }

    // ── LAST + INVERT: batch-read new positions, batch-write transforms ──
    var allTiles = gridEl.querySelectorAll(".dash-tile");
    var invertData = []; // { el, dx, dy } — read first, write after

    for (var i = 0; i < allTiles.length; i++) {
      var tile = allTiles[i];
      var tid = tile.dataset.componentId;
      if (!tid || !oldPos[tid]) continue;
      var newRect = tile.getBoundingClientRect();
      var dx = oldPos[tid].left - newRect.left;
      var dy = oldPos[tid].top - newRect.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        invertData.push({ el: tile, dx: dx, dy: dy });
      }
    }

    // Batch-write: apply inverse transforms (no reads between writes!)
    for (var i = 0; i < invertData.length; i++) {
      var d = invertData[i];
      d.el.style.transition = "none";
      d.el.style.transform = "translate(" + d.dx + "px, " + d.dy + "px)";
    }

    // ── PLAY: double-rAF guarantees browser has committed styles ──
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        // Animate existing tiles to natural positions
        for (var i = 0; i < invertData.length; i++) {
          invertData[i].el.style.transition = "transform " + _flipDuration + "ms cubic-bezier(0.2, 0, 0, 1)";
          invertData[i].el.style.transform = "";
        }

        // Staggered entrance for new tiles
        for (var i = 0; i < entering.length; i++) {
          (function(el, delay) {
            el.style.transition = "opacity " + _flipDuration + "ms ease " + delay + "ms, transform " + _flipDuration + "ms cubic-bezier(0.16, 1, 0.3, 1) " + delay + "ms";
            el.style.opacity = "1";
            el.style.transform = "scale(1) translateY(0)";
          })(entering[i], i * 60);
        }

        // Animate out leaving tiles
        for (var i = 0; i < leaving.length; i++) {
          leaving[i].style.transition = "opacity 180ms ease, transform 180ms ease";
          leaving[i].style.opacity = "0";
          leaving[i].style.transform = "scale(0.9)";
          leaving[i].style.pointerEvents = "none";
          (function(el) {
            setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
          })(leaving[i]);
        }

        // Cleanup after animations complete
        var maxDelay = entering.length * 60;
        setTimeout(function() {
          for (var i = 0; i < invertData.length; i++) {
            invertData[i].el.style.transition = "";
            invertData[i].el.style.transform = "";
          }
          for (var i = 0; i < entering.length; i++) {
            entering[i].style.transition = "";
            entering[i].style.opacity = "";
            entering[i].style.transform = "";
          }
          _updateEmpty();
        }, _flipDuration + maxDelay + 50);
      });
    });
  }

  // _applyDOMOp removed — all logic is now in _flushOps with proper FLIP

  // ── Wire state → batched FLIP queue ──
  state.onChange(function(type, data) {
    if (type === "reset") {
      // Reset bypasses FLIP — immediate rebuild (page load)
      Object.keys(_gridEls).forEach(function(id) {
        if (_gridEls[id].parentNode) _gridEls[id].parentNode.removeChild(_gridEls[id]);
      });
      _gridEls = {};
      if (Array.isArray(data)) {
        for (var k = 0; k < data.length; k++) {
          var c = data[k];
          var el = _createTile(c, false);
          el.dataset.order = (c.layout && c.layout.order != null) ? c.layout.order : k;
          _gridEls[c.id] = el;
          gridEl.appendChild(el);
        }
        _reorder();
      }
      _updateEmpty();
      return;
    }
    _queueOp(type, data);
  });

  // ═══════════════════════════════════════════
  // Drag to Reorder
  // ═══════════════════════════════════════════

  var _dragId = null;
  var _dragGhost = null;

  gridEl.addEventListener("dragstart", function(e) {
    var tile = e.target.closest(".dash-tile");
    if (!tile || e.target.classList.contains("tile-resize-handle")) { e.preventDefault(); return; }
    _dragId = tile.dataset.componentId;
    tile.classList.add("dash-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", _dragId);
    // Transparent ghost
    _dragGhost = document.createElement("div");
    _dragGhost.style.width = "1px";
    _dragGhost.style.height = "1px";
    _dragGhost.style.position = "absolute";
    _dragGhost.style.top = "-999px";
    document.body.appendChild(_dragGhost);
    e.dataTransfer.setDragImage(_dragGhost, 0, 0);
  });

  gridEl.addEventListener("dragover", function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    var tile = e.target.closest(".dash-tile");
    if (tile && tile.dataset.componentId !== _dragId) {
      tile.classList.add("dash-drop-target");
    }
  });

  gridEl.addEventListener("dragleave", function(e) {
    var tile = e.target.closest(".dash-tile");
    if (tile) tile.classList.remove("dash-drop-target");
  });

  gridEl.addEventListener("drop", function(e) {
    e.preventDefault();
    var targetTile = e.target.closest(".dash-tile");
    if (!targetTile || !_dragId) return;
    var targetId = targetTile.dataset.componentId;
    if (targetId === _dragId) return;

    targetTile.classList.remove("dash-drop-target");

    // Swap orders
    var dragTile = _gridEls[_dragId];
    if (!dragTile) return;

    var oldPos = _capturePositions();

    var dragOrder = parseInt(dragTile.dataset.order) || 0;
    var targetOrder = parseInt(targetTile.dataset.order) || 0;
    dragTile.dataset.order = targetOrder;
    targetTile.dataset.order = dragOrder;

    var dragComp = state.get(_dragId);
    var targetComp = state.get(targetId);
    if (dragComp) { if (!dragComp.layout) dragComp.layout = {}; dragComp.layout.order = targetOrder; }
    if (targetComp) { if (!targetComp.layout) targetComp.layout = {}; targetComp.layout.order = dragOrder; }

    _reorder();
    // Inline FLIP for drag reorder
    var allTiles = gridEl.querySelectorAll(".dash-tile");
    for (var di = 0; di < allTiles.length; di++) {
      var dt = allTiles[di];
      var did = dt.dataset.componentId;
      if (!did || !oldPos[did]) continue;
      var dnr = dt.getBoundingClientRect();
      var ddx = oldPos[did].left - dnr.left;
      var ddy = oldPos[did].top - dnr.top;
      if (Math.abs(ddx) > 1 || Math.abs(ddy) > 1) {
        dt.style.transform = "translate(" + ddx + "px, " + ddy + "px)";
        dt.style.transition = "none";
        dt.offsetHeight;
        dt.style.transition = "transform " + _flipDuration + "ms cubic-bezier(0.25, 0.1, 0.25, 1)";
        dt.style.transform = "";
        (function(t) { setTimeout(function() { t.style.transition = ""; t.style.transform = ""; }, _flipDuration + 20); })(dt);
      }
    }

    // Notify agent about reorder
    connection.send("[canvas:reorder] " + _dragId + " moved to position " + targetOrder + "\n[genui:on]");
  });

  gridEl.addEventListener("dragend", function(e) {
    if (_dragId && _gridEls[_dragId]) {
      _gridEls[_dragId].classList.remove("dash-dragging");
    }
    document.querySelectorAll(".dash-drop-target").forEach(function(el) { el.classList.remove("dash-drop-target"); });
    _dragId = null;
    if (_dragGhost && _dragGhost.parentNode) _dragGhost.parentNode.removeChild(_dragGhost);
    _dragGhost = null;
  });

  // ═══════════════════════════════════════════
  // Tile Resizing
  // ═══════════════════════════════════════════

  var _resizing = null;
  var _resizeStartX = 0;
  var _spanCycle = ["small", "medium", "wide", "full"];

  gridEl.addEventListener("pointerdown", function(e) {
    if (!e.target.classList.contains("tile-resize-handle")) return;
    var tile = e.target.closest(".dash-tile");
    if (!tile) return;
    e.preventDefault();
    _resizing = tile;
    _resizeStartX = e.clientX;
    tile.classList.add("dash-resizing");
    document.addEventListener("pointermove", _onResizeMove);
    document.addEventListener("pointerup", _onResizeEnd);
  });

  function _onResizeMove(e) {
    if (!_resizing) return;
    var dx = e.clientX - _resizeStartX;
    // Visual feedback — show projected size
    var currentSpan = _resizing.dataset.span || "medium";
    var idx = _spanCycle.indexOf(currentSpan);
    var newIdx = idx;
    if (dx > 80) newIdx = Math.min(idx + 1, 3);
    if (dx > 200) newIdx = Math.min(idx + 2, 3);
    if (dx < -80) newIdx = Math.max(idx - 1, 0);
    if (dx < -200) newIdx = Math.max(idx - 2, 0);
    var newSpan = _spanCycle[newIdx];
    if (newSpan !== _resizing.dataset.span) {
      var resOldPos = _capturePositions();
      _resizing.className = _resizing.className.replace(/dash-(small|medium|wide|full)/g, "dash-" + newSpan);
      _resizing.dataset.span = newSpan;
      // Inline FLIP for resize
      var resTiles = gridEl.querySelectorAll(".dash-tile");
      for (var rsi = 0; rsi < resTiles.length; rsi++) {
        var rst = resTiles[rsi];
        var rsid = rst.dataset.componentId;
        if (!rsid || !resOldPos[rsid]) continue;
        var rsnr = rst.getBoundingClientRect();
        var rsdx = resOldPos[rsid].left - rsnr.left;
        var rsdy = resOldPos[rsid].top - rsnr.top;
        if (Math.abs(rsdx) > 1 || Math.abs(rsdy) > 1) {
          rst.style.transform = "translate(" + rsdx + "px, " + rsdy + "px)";
          rst.style.transition = "none";
          rst.offsetHeight;
          rst.style.transition = "transform " + _flipDuration + "ms cubic-bezier(0.25, 0.1, 0.25, 1)";
          rst.style.transform = "";
          (function(t) { setTimeout(function() { t.style.transition = ""; t.style.transform = ""; }, _flipDuration + 20); })(rst);
        }
      }
    }
  }

  function _onResizeEnd(e) {
    if (!_resizing) return;
    _resizing.classList.remove("dash-resizing");
    var id = _resizing.dataset.componentId;
    var newSpan = _resizing.dataset.span;
    // Store user's size preference on the component
    var comp = state.get(id);
    if (comp) comp._userSpan = newSpan;
    _resizing = null;
    document.removeEventListener("pointermove", _onResizeMove);
    document.removeEventListener("pointerup", _onResizeEnd);
  }

  // ═══════════════════════════════════════════
  // Connection
  // ═══════════════════════════════════════════

  var config = window.SCRATCHY_CANVAS_CONFIG || {};
  var serverUrl = config.serverUrl || window.location.origin;
  var sessionKey = config.sessionKey || "agent:main:main";
  state.sessionKey = sessionKey;

  var wsUrl = String(serverUrl).replace(/^http/, "ws") + "/ws";
  var connection = new ScratchyConnection(wsUrl);
  connection.sessionKey = sessionKey;

  connection.onStatusChange = function(status) {
    var el = document.getElementById("session-indicator");
    var labels = { connected: "● Connected", disconnected: "○ Disconnected", connecting: "◌ Connecting…" };
    if (el) { el.textContent = labels[status] || status; el.className = "session-info status-" + status; }
    if (status === "connected") {
      showToast("Connected ✓", "connected", 2000);
      fetch(serverUrl + "/api/canvas?session=" + encodeURIComponent(sessionKey))
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(s) {
          if (s && s.components && Object.keys(s.components).length > 0) {
            state.loadSnapshot(s);
          }
        })
        .catch(function() {});
    }
    else if (status === "connecting" || status === "reconnecting") showToast("Reconnecting…", "reconnecting", 0);
    else if (status === "disconnected") showToast("Disconnected", "", 0);
  };

  connection.onSendError = function() { showToast("Message failed", "", 3000); };

  // ── Streaming — only status, no text ──
  connection.onStreamDelta = function() {
    chatStatus.textContent = "💬 Typing…";
  };

  // ── Final message — only show non-canvas text in chat panel ──
  var _seenHashes = new Set();
  function _hash(t) { var h=5381; t=(t||"").slice(0,300); for(var i=0;i<t.length;i++) h=((h<<5)+h+t.charCodeAt(i))&0xffffffff; return h; }
  function _isDup(t) { var h=_hash(t); if(_seenHashes.has(h)) return true; _seenHashes.add(h); if(_seenHashes.size>100){var a=Array.from(_seenHashes);_seenHashes=new Set(a.slice(-50));} return false; }

  connection.onMessage = function(message) {
    var text = message.text || "";
    if (!text || _isDup(text)) return;
    if (connection._isSystemNoise && connection._isSystemNoise(text)) return;
    var chatText = text
      .replace(/```scratchy-canvas[\s\S]*?```/g, "")
      .replace(/```scratchy-toon[\s\S]*?```/g, "")
      .replace(/```scratchy-tpl[\s\S]*?```/g, "")
      .replace(/```scratchy-ui[\s\S]*?```/g, "")
      .replace(/\[ClawOS Canary\][^\n]*/g, "")
      .replace(/\[message_id:[^\]]*\]/g, "")
      .replace(/\[genui:\w+\]/g, "")
      .trim();
    if (chatText) {
      addChatMsg("agent", chatText);
      chatStatus.textContent = "💬 " + chatText.slice(0, 50);
    } else {
      chatStatus.textContent = "💬 Canvas updated";
    }
  };

  connection.onRemoteUserMessage = function() {};

  // ── Canvas ops from server broadcast ──
  connection.onCanvasUpdate = function(payload) {
    if (payload.ops && payload.ops.length > 0) {
      state.applyBatch(payload.ops);
    }
  };

  connection.onAgentActivity = function(activity) {
    if (activity.type === "thinking") chatStatus.textContent = "💭 Thinking…";
    else if (activity.type === "tool") chatStatus.textContent = "🔧 " + (activity.name || "working") + "…";
    else if (activity.type === "done") chatStatus.textContent = "💬 Ready";
  };

  // ── Handle canvas-update and history events ──
  var _origHandle = connection._handleEvent ? connection._handleEvent.bind(connection) : null;
  if (_origHandle) {
    connection._handleEvent = function(frame) {
      if (frame.type === "event" && frame.event === "canvas-update" && frame.payload) {
        if (connection.onCanvasUpdate) connection.onCanvasUpdate(frame.payload);
        return;
      }
      if (frame.type === "event" && frame.event === "history" && frame.payload) {
        var msgs = frame.payload.messages || [];
        for (var i = 0; i < msgs.length; i++) {
          if (msgs[i].role === "assistant" && msgs[i].text) _isDup(msgs[i].text);
        }
        return;
      }
      _origHandle(frame);
    };
  }

  // ── Send Message ──
  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text) return;
    addChatMsg("user", text);
    connection.send(text + "\n[genui:on]");
    inputEl.value = "";
    inputEl.style.height = "auto";
    inputEl.focus();
  }

  sendBtn.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputEl.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
  });

  // ── Component button/form interactions ──
  document.addEventListener("click", function(e) {
    var btn = e.target.closest("[data-sui-send]");
    if (!btn) return;
    var value = btn.getAttribute("data-sui-send");
    var formId = btn.getAttribute("data-sui-form");
    if (formId) {
      var fields = {};
      document.querySelectorAll("[id^='form-" + formId + "-']").forEach(function(el) {
        var name = el.name || el.id.replace("form-" + formId + "-", "");
        fields[name] = el.type === "checkbox" ? el.checked : el.value;
      });
      var msg = "[form:submit] id=" + formId + " action=" + value + " fields=" + JSON.stringify(fields);
      addChatMsg("user", value);
      connection.send(msg + "\n[genui:on]");
      return;
    }
    addChatMsg("user", value);
    connection.send(value + "\n[genui:on]");
  });

  // ── Init ──
  inputEl.setAttribute("aria-label", "Message input");
  sendBtn.setAttribute("aria-label", "Send");
  setTimeout(function() { inputEl.focus(); }, 300);
  connection.connect();

})();
