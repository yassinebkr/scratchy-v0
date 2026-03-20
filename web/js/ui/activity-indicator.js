// ============================================
// Scratchy — ActivityIndicator
// ============================================
// Extracted from app.js: compaction indicator, context meter,
// streaming progress bar, tool-idle detection.
// IIFE pattern — exposes window.ActivityIndicator.

(function() {
  "use strict";

  var _compactionEl = null;
  var _compactionTimer = null;
  var _compactionMaxTimer = null;
  var _contextMaxTokens = 300000;
  var _contextEstTokens = 0;
  var _progressBar = null;
  var _toolIdleTimer = null;
  var _lastToolTime = 0;

  var ActivityIndicator = {};

  // ── Streaming progress bar ──

  ActivityIndicator.initProgressBar = function() {
    if (_progressBar) return _progressBar;
    _progressBar = document.createElement("div");
    _progressBar.className = "streaming-progress";
    _progressBar.style.display = "none";
    document.body.appendChild(_progressBar);
    return _progressBar;
  };

  ActivityIndicator.showProgress = function() {
    if (_progressBar) _progressBar.style.display = "block";
  };

  ActivityIndicator.hideProgress = function() {
    if (_progressBar) _progressBar.style.display = "none";
  };

  // ── Context Meter ──

  ActivityIndicator.updateContextMeter = function(pct) {
    var meter = document.getElementById("context-meter");
    var fill = meter ? meter.querySelector(".context-meter__fill") : null;
    var tooltip = document.getElementById("context-meter-tooltip");
    if (!meter || !fill) return;
    pct = Math.max(0, Math.min(100, pct));
    fill.style.setProperty("--context-pct", pct);
    meter.setAttribute("aria-valuenow", pct);
    var level = pct >= 90 ? "critical" : pct >= 75 ? "high" : pct >= 50 ? "medium" : "low";
    meter.dataset.level = level;
    if (tooltip) {
      var estK = Math.round(_contextEstTokens / 1000);
      var maxK = Math.round(_contextMaxTokens / 1000);
      tooltip.textContent = "Context: ~" + pct + "% (" + estK + "k/" + maxK + "k tokens)";
    }
  };

  // Backward compat
  window.updateContextMeter = ActivityIndicator.updateContextMeter;

  ActivityIndicator.estimateContextUsage = function(store) {
    if (!store || !store.messages) return;
    var totalChars = 0;
    var msgs = store.messages;
    for (var i = 0; i < msgs.length; i++) {
      var content = msgs[i].content || msgs[i].text || "";
      if (typeof content === "string") {
        totalChars += content.length;
      } else if (Array.isArray(content)) {
        for (var j = 0; j < content.length; j++) {
          if (content[j] && content[j].text) totalChars += content[j].text.length;
        }
      }
    }
    _contextEstTokens = Math.round(totalChars / 4) + 2000;
    var pct = Math.round((_contextEstTokens / _contextMaxTokens) * 100);
    ActivityIndicator.updateContextMeter(pct);
  };

  // ── Compaction Indicator ──

  function _setMeterCompacting(active) {
    var meter = document.getElementById("context-meter");
    var label = document.getElementById("context-meter-label");
    if (meter) meter.dataset.compacting = active ? "true" : "false";
    if (label) label.dataset.visible = active ? "true" : "false";
  }

  ActivityIndicator.showCompactionIndicator = function(messagesContainer, renderer) {
    if (_compactionEl) return;
    _setMeterCompacting(true);
    _compactionEl = document.createElement("div");
    _compactionEl.className = "compact-indicator";
    _compactionEl.innerHTML =
      '<div><span class="compact-indicator__diamond"></span></div>' +
      '<div>' +
        '<span class="compact-indicator__title">Reorganizing memory\u2026</span>' +
        '<span class="compact-indicator__subtitle">Your messages are queued and will be processed when ready.</span>' +
      '</div>';

    // Remove existing activity indicator (compaction supersedes it)
    var indicator = document.getElementById("activity-indicator");
    if (indicator) indicator.remove();
    var streaming = document.getElementById("streaming-message");
    if (streaming) streaming.remove();

    if (messagesContainer) {
      messagesContainer.appendChild(_compactionEl);
    }
    if (renderer && renderer._scrollToBottom) {
      renderer._scrollToBottom();
    }

    // Emit on bus
    if (window.ScratchyBus) {
      window.ScratchyBus.emit("compaction:start", { ts: Date.now() });
    }
  };

  ActivityIndicator.hideCompactionIndicator = function() {
    if (!_compactionEl) return;
    _setMeterCompacting(false);
    _compactionEl.dataset.state = "done";
    var el = _compactionEl;
    setTimeout(function() { if (el.parentNode) el.remove(); }, 300);
    _compactionEl = null;
    if (_compactionTimer) { clearTimeout(_compactionTimer); _compactionTimer = null; }
    if (_compactionMaxTimer) { clearTimeout(_compactionMaxTimer); _compactionMaxTimer = null; }

    if (window.ScratchyBus) {
      window.ScratchyBus.emit("compaction:end", { ts: Date.now() });
    }
  };

  ActivityIndicator.isCompacting = function() {
    return !!_compactionEl;
  };

  // ── Compaction detection timer ──

  ActivityIndicator.startCompactionDetection = function(connection, messagesContainer, renderer) {
    if (_compactionTimer) clearTimeout(_compactionTimer);
    _compactionTimer = setTimeout(function() {
      if (connection && connection.connected && connection.handshakeComplete) {
        ActivityIndicator.showCompactionIndicator(messagesContainer, renderer);
        if (_compactionMaxTimer) clearTimeout(_compactionMaxTimer);
        _compactionMaxTimer = setTimeout(function() {
          ActivityIndicator.hideCompactionIndicator();
        }, 120000);
      }
    }, 8000);
  };

  ActivityIndicator.cancelCompactionDetection = function() {
    if (_compactionTimer) { clearTimeout(_compactionTimer); _compactionTimer = null; }
  };

  // ── Tool-idle detection (2s gap → "Using tools...") ──

  ActivityIndicator.onToolActivity = function() {
    _lastToolTime = Date.now();
    if (_toolIdleTimer) clearTimeout(_toolIdleTimer);
    _toolIdleTimer = setTimeout(function() {
      // 2s since last tool activity — show "Using tools..." indicator
      var indicator = document.getElementById("activity-indicator");
      if (indicator) {
        var text = indicator.querySelector(".activity-text");
        if (text) text.textContent = "Using tools\u2026";
      }
    }, 2000);
  };

  ActivityIndicator.clearToolIdle = function() {
    if (_toolIdleTimer) { clearTimeout(_toolIdleTimer); _toolIdleTimer = null; }
  };

  // ── Bus integration (optional — wire up if bus exists) ──

  if (window.ScratchyBus) {
    window.ScratchyBus.on("agent:activity", function(activity) {
      if (activity && activity.type === "tool") {
        ActivityIndicator.onToolActivity();
      }
      if (activity && (activity.type === "thinking" && activity.phase === "start")) {
        ActivityIndicator.cancelCompactionDetection();
        ActivityIndicator.hideCompactionIndicator();
        ActivityIndicator.showProgress();
      }
      if (activity && activity.type === "done") {
        ActivityIndicator.hideCompactionIndicator();
        ActivityIndicator.hideProgress();
        ActivityIndicator.clearToolIdle();
      }
    });

    window.ScratchyBus.on("stream:delta", function() {
      if (_compactionEl) ActivityIndicator.hideCompactionIndicator();
      ActivityIndicator.cancelCompactionDetection();
    });

    window.ScratchyBus.on("message:received", function(msg) {
      if (_compactionEl) ActivityIndicator.hideCompactionIndicator();
      ActivityIndicator.cancelCompactionDetection();
      if (msg && msg.role === "compaction") {
        ActivityIndicator.updateContextMeter(35);
      }
    });

    window.ScratchyBus.on("store:message:add", function() {
      // Defer context estimation — needs store reference
      // App.js should call estimateContextUsage(store) on message add
    });
  }

  // ── Expose ──
  window.ActivityIndicator = ActivityIndicator;

})();
