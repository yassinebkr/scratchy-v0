// ============================================
// Scratchy — MessageRenderer (Refactored)
// ============================================
// DOM rendering for chat messages.
// IIFE pattern — exposes window.ScratchyMessageRenderer
//
// New features:
//   - Message status indicators (sending spinner, sent checkmark)
//   - Message grouping (consecutive same-author within 2 min)
//   - Smart timestamps (show on >5 min gap, always on hover)
//   - Smooth entrance animation for new messages

(function() {
  "use strict";

  // Auto-speech setting
  var AUTO_SPEECH = localStorage.getItem("scratchy_auto_speech") === "true";

  // Grouping threshold: 2 minutes
  var GROUP_THRESHOLD_MS = 2 * 60 * 1000;
  // Timestamp gap threshold: 5 minutes
  var TIMESTAMP_GAP_MS = 5 * 60 * 1000;

  function MessageRenderer(containerElement) {
    this.container = containerElement;
    this._autoScroll = true;
    this._scrollBtn = null;
    this._lastRenderedMsg = null; // For grouping logic
    this._initScrollWatcher();
  }

  MessageRenderer.prototype = {

    // ── Scroll management ──

    _initScrollWatcher: function() {
      var self = this;

      this.container.addEventListener("scroll", function() {
        if (self._isNearBottom()) {
          self._autoScroll = true;
          self._hideScrollBtn();
        } else {
          self._autoScroll = false;
          self._showScrollBtn();
        }
      });

      document.addEventListener("keydown", function(e) {
        if (document.activeElement === document.getElementById("message-input")) return;
        if (e.key === "ArrowUp") {
          self._autoScroll = false;
          self._showScrollBtn();
        }
        if (e.key === "ArrowDown") {
          requestAnimationFrame(function() {
            if (self._isNearBottom()) {
              self._autoScroll = true;
              self._hideScrollBtn();
            }
          });
        }
      });

      this._scrollBtn = document.createElement("button");
      this._scrollBtn.id = "scroll-bottom-btn";
      this._scrollBtn.innerHTML = "↓";
      this._scrollBtn.title = "Scroll to bottom";
      this._scrollBtn.style.display = "none";
      this._scrollBtn.addEventListener("click", function() {
        self._autoScroll = true;
        self._scrollToBottom();
        self._hideScrollBtn();
      });
      var app = document.getElementById("app");
      if (app) app.appendChild(this._scrollBtn);
    },

    _isNearBottom: function() {
      return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 60;
    },
    _showScrollBtn: function() { if (this._scrollBtn) this._scrollBtn.style.display = "flex"; },
    _hideScrollBtn: function() { if (this._scrollBtn) this._scrollBtn.style.display = "none"; },

    // ── Status indicator HTML ──

    _statusHtml: function(status) {
      if (!status) return "";
      switch (status) {
        case "sending":
          return '<span class="msg-status sending" title="Sending">⏳</span>';
        case "sent":
          return '<span class="msg-status sent" title="Sent">✓</span>';
        case "delivered":
          return '<span class="msg-status delivered" title="Delivered">✓✓</span>';
        case "failed":
          return '<span class="msg-status failed" title="Failed">⚠️</span>';
        default:
          return "";
      }
    },

    // ── Grouping logic ──

    _shouldGroup: function(msg) {
      if (!this._lastRenderedMsg) return false;
      if (this._lastRenderedMsg.role !== msg.role) return false;
      if (msg.role === "system" || msg.role === "compaction") return false;

      var prevTime = this._lastRenderedMsg._ingestTime || this._parseTime(this._lastRenderedMsg.timestamp);
      var thisTime = msg._ingestTime || this._parseTime(msg.timestamp) || Date.now();
      if (!prevTime) return false;
      return (thisTime - prevTime) < GROUP_THRESHOLD_MS;
    },

    _parseTime: function(ts) {
      if (!ts) return null;
      var d = new Date(ts);
      return isNaN(d.getTime()) ? null : d.getTime();
    },

    // ── Smart timestamps ──

    _shouldShowTimestamp: function(msg) {
      if (!this._lastRenderedMsg) return true;
      var prevTime = this._lastRenderedMsg._ingestTime || this._parseTime(this._lastRenderedMsg.timestamp);
      var thisTime = msg._ingestTime || this._parseTime(msg.timestamp) || Date.now();
      if (!prevTime) return true;
      return (thisTime - prevTime) >= TIMESTAMP_GAP_MS;
    },

    // ── Entrance animation ──

    _animateEntrance: function(el) {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      el.style.transition = "opacity 0.25s ease, transform 0.25s ease";
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          el.style.opacity = "1";
          el.style.transform = "translateY(0)";
        });
      });
    },

    // ── TTS handler ──

    _attachTtsHandler: function(el) {
      var btn = el.querySelector(".tts-btn");
      if (!btn) return;
      btn._state = "idle";
      btn._blobUrl = null;
      btn._audio = null;

      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        if (window._activeTtsBtn && window._activeTtsBtn !== btn) {
          var other = window._activeTtsBtn;
          if (other._audio) { other._audio.pause(); other._audio.currentTime = 0; }
          other._state = "idle";
          other.textContent = "🔊";
          other.classList.remove("playing", "loading");
        }
        if (btn._state === "loading") return;
        if (btn._state === "playing") {
          if (btn._audio) btn._audio.pause();
          btn._state = "paused";
          btn.textContent = "▶️";
          btn.classList.remove("playing");
          return;
        }
        if (btn._state === "paused" && btn._audio) {
          btn._audio.play();
          btn._state = "playing";
          btn.textContent = "⏸";
          btn.classList.add("playing");
          window._activeTtsBtn = btn;
          return;
        }
        if (btn._blobUrl) {
          var audio = new Audio(btn._blobUrl);
          btn._audio = audio;
          btn._state = "playing";
          btn.textContent = "⏸";
          btn.classList.add("playing");
          window._activeTtsBtn = btn;
          audio.addEventListener("ended", function() {
            btn._state = "idle"; btn.textContent = "🔊"; btn.classList.remove("playing");
          });
          audio.play();
          return;
        }
        var text = el.getAttribute("data-raw-text");
        if (!text) return;
        btn._state = "loading";
        btn.textContent = "⏳";
        btn.classList.add("loading");
        fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ text: text }),
        })
          .then(function(res) { if (!res.ok) throw new Error("TTS failed"); return res.blob(); })
          .then(function(blob) {
            var url = URL.createObjectURL(blob);
            btn._blobUrl = url;
            var audio = new Audio(url);
            btn._audio = audio;
            btn._state = "playing";
            btn.textContent = "⏸";
            btn.classList.remove("loading");
            btn.classList.add("playing");
            window._activeTtsBtn = btn;
            audio.addEventListener("ended", function() {
              btn._state = "idle"; btn.textContent = "🔊"; btn.classList.remove("playing");
            });
            audio.play();
          })
          .catch(function(err) {
            console.error("[TTS]", err);
            btn._state = "idle"; btn.textContent = "🔊"; btn.classList.remove("loading");
          });
      });
    },

    // ── Delete handler (tap message → menu) ──

    _attachDeleteHandler: function(el) {
      var self = this;
      el.addEventListener("click", function(e) {
        var tag = (e.target.tagName || "").toLowerCase();
        if (tag === "a" || tag === "button" || e.target.closest("button") || e.target.closest("a") ||
            e.target.closest(".msg-menu") || e.target.closest(".msg-actions")) return;
        self._dismissMenus();
        if (el.querySelector(".msg-menu")) return;
        e.stopPropagation();
        el.style.position = "relative";
        var timestamp = el.querySelector(".timestamp");
        var dots = document.createElement("button");
        dots.className = "msg-menu";
        dots.innerHTML = "⋯";
        dots.title = "Message options";
        if (timestamp) timestamp.appendChild(dots); else el.appendChild(dots);
        dots.addEventListener("click", function(e2) {
          e2.stopPropagation();
          var existing = el.querySelector(".msg-actions");
          if (existing) { existing.remove(); return; }
          var actions = document.createElement("div");
          actions.className = "msg-actions";
          actions.innerHTML = '<button class="msg-action-delete">Delete</button>';
          el.appendChild(actions);
          actions.querySelector(".msg-action-delete").addEventListener("click", function(e3) {
            e3.stopPropagation();
            var ttsBtn = el.querySelector(".tts-btn");
            if (ttsBtn) {
              if (ttsBtn._audio) { ttsBtn._audio.pause(); ttsBtn._audio = null; }
              if (ttsBtn._blobUrl) { URL.revokeObjectURL(ttsBtn._blobUrl); ttsBtn._blobUrl = null; }
            }
            el.style.transition = "opacity 0.2s, transform 0.2s";
            el.style.opacity = "0";
            el.style.transform = "scale(0.95)";
            setTimeout(function() { el.remove(); }, 200);
          });
        });
      });
    },

    _dismissMenus: function() {
      var menus = document.querySelectorAll(".msg-menu, .msg-actions");
      for (var i = 0; i < menus.length; i++) menus[i].remove();
    },

    // ── Create element from store message ──

    createElement: function(msg, opts) {
      var text = msg.text || "";
      var clean = this._cleanText(text);
      var isGrouped = this._shouldGroup(msg);
      var showTimestamp = this._shouldShowTimestamp(msg);
      var animate = opts && opts.animate;

      // Compaction marker
      if (msg.role === "compaction") {
        var div = document.createElement("div");
        div.classList.add("compaction-marker");
        var dateStr = msg.timestamp || "";
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
          var dp = dateStr.split("-");
          dateStr = dp[2] + "/" + dp[1] + "/" + dp[0];
        }
        var label = dateStr ? "older messages compacted · " + dateStr : "older messages compacted";
        div.innerHTML = '<span class="compaction-line"></span><span class="compaction-label">' + label + '</span><span class="compaction-line"></span>';
        this._lastRenderedMsg = msg;
        return div;
      }

      // Streaming message
      if (msg.streaming) {
        var div = document.createElement("div");
        div.id = "streaming-message";
        div.classList.add("message", "agent", "streaming");
        if (isGrouped) div.classList.add("grouped");
        div.setAttribute("data-stream-text", text);
        div.setAttribute("data-raw-text", clean);
        if (msg.id) div.setAttribute("data-msg-id", msg.id);
        if (msg.uuid) div.setAttribute("data-uuid", msg.uuid);
        div.innerHTML =
          '<div class="message-body">' + renderMedia(renderMarkdown(text, { streaming: true })) + '</div>' +
          '<div class="timestamp streaming-indicator">● typing...</div>';
        this._addCopyButtons(div);
        this._lastRenderedMsg = msg;
        if (animate) this._animateEntrance(div);
        return div;
      }

      var div = document.createElement("div");
      if (msg.id) div.setAttribute("data-msg-id", msg.id);
      if (msg.uuid) div.setAttribute("data-uuid", msg.uuid);
      div.setAttribute("data-raw-text", clean);

      var timestampStr = msg.timestamp ? this._formatTimeFromISO(msg.timestamp) : this._formatTime();
      var statusIndicator = this._statusHtml(msg.status);

      // Hover timestamp (always available via title)
      var timestampFull = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : new Date().toLocaleString();

      if (msg.role === "user") {
        div.classList.add("message", "user");
        if (isGrouped) div.classList.add("grouped");

        var imagesHtml = "";
        if (msg.images && msg.images.length > 0) {
          imagesHtml = '<div class="msg-attachments">';
          for (var i = 0; i < msg.images.length; i++) {
            imagesHtml += '<img src="' + msg.images[i] + '" alt="attached image" loading="lazy">';
          }
          imagesHtml += '</div>';
        }

        var filesHtml = "";
        if (msg.fileAttachments && msg.fileAttachments.length > 0) {
          filesHtml = '<div class="msg-file-attachments">';
          for (var f = 0; f < msg.fileAttachments.length; f++) {
            var fa = msg.fileAttachments[f];
            filesHtml += '<span class="file-badge">' + (fa.icon || '📎') + ' ' + this._escapeHtml(fa.name) + '</span>';
          }
          filesHtml += '</div>';
        }

        var bodyHtml = clean ? renderMarkdown(clean) : "";
        var tsHtml = showTimestamp
          ? '<div class="timestamp" title="' + this._escapeHtml(timestampFull) + '">' + timestampStr + statusIndicator + '</div>'
          : '<div class="timestamp hover-only" title="' + this._escapeHtml(timestampFull) + '">' + timestampStr + statusIndicator + '</div>';

        div.innerHTML = imagesHtml + filesHtml +
          '<div class="message-body">' + bodyHtml + '</div>' + tsHtml;

        // Image lightbox
        var imgs = div.querySelectorAll(".msg-attachments img");
        for (var j = 0; j < imgs.length; j++) {
          imgs[j].addEventListener("click", function(e) {
            var lb = document.createElement("div");
            lb.className = "image-lightbox";
            var bigImg = document.createElement("img");
            bigImg.src = e.target.src;
            lb.appendChild(bigImg);
            lb.addEventListener("click", function() { lb.remove(); });
            document.body.appendChild(lb);
          });
        }

        this._addCopyButtons(div);
        this._addCollapsible(div);
        this._highlightCode(div);
        this._attachDeleteHandler(div);

      } else if (msg.role === "assistant") {
        div.classList.add("message", "agent");
        if (isGrouped) div.classList.add("grouped");

        var tsHtml = showTimestamp
          ? '<div class="timestamp" title="' + this._escapeHtml(timestampFull) + '">' + timestampStr + '</div>'
          : '<div class="timestamp hover-only" title="' + this._escapeHtml(timestampFull) + '">' + timestampStr + '</div>';

        div.innerHTML =
          '<div class="message-body">' + renderMedia(renderMarkdown(text)) + '</div>' +
          '<div class="message-actions"><button class="tts-btn" title="Listen">🔊</button></div>' +
          tsHtml;

        this._addCopyButtons(div);
        this._addCollapsible(div);
        this._highlightCode(div);
        this._initVideos(div);
        this._attachDeleteHandler(div);
        this._attachTtsHandler(div);

      } else {
        div.classList.add("message", "system");
        div.innerHTML = '<span class="system-text">' + this._escapeHtml(clean) + '</span>';
      }

      this._lastRenderedMsg = msg;
      if (animate) this._animateEntrance(div);
      return div;
    },

    // ── Kept methods from original (backward compat) ──

    renderUserMessage: function(text) {
      var clean = this._cleanText(text);
      var div = document.createElement("div");
      div.classList.add("message", "user");
      div.setAttribute("data-raw-text", clean);
      div.innerHTML =
        '<div class="message-body">' + renderMarkdown(clean) + '</div>' +
        '<div class="timestamp">' + this._formatTime() + '</div>';
      var activityEl = document.getElementById("activity-indicator");
      if (activityEl) this.container.insertBefore(div, activityEl);
      else this.container.appendChild(div);
      this._addCopyButtons(div);
      this._addCollapsible(div);
      this._highlightCode(div);
      this._attachDeleteHandler(div);
      this._animateEntrance(div);
      this._scrollToBottom();
    },

    renderUserMessageWithImages: function(text, imageDataUrls, fileAttachments) {
      var clean = this._cleanText(text);
      var div = document.createElement("div");
      div.classList.add("message", "user");
      div.setAttribute("data-raw-text", clean);
      var imagesHtml = "";
      if (imageDataUrls && imageDataUrls.length > 0) {
        imagesHtml = '<div class="msg-attachments">';
        for (var i = 0; i < imageDataUrls.length; i++) {
          imagesHtml += '<img src="' + imageDataUrls[i] + '" alt="attached image" loading="lazy">';
        }
        imagesHtml += '</div>';
      }
      var filesHtml = "";
      if (fileAttachments && fileAttachments.length > 0) {
        filesHtml = '<div class="msg-file-attachments">';
        for (var f = 0; f < fileAttachments.length; f++) {
          var fa = fileAttachments[f];
          filesHtml += '<span class="file-badge">' + (fa.icon || '📎') + ' ' + this._escapeHtml(fa.name) + '</span>';
        }
        filesHtml += '</div>';
      }
      var bodyHtml = clean ? renderMarkdown(clean) : "";
      div.innerHTML = imagesHtml + filesHtml +
        '<div class="message-body">' + bodyHtml + '</div>' +
        '<div class="timestamp">' + this._formatTime() + '</div>';
      var imgs = div.querySelectorAll(".msg-attachments img");
      for (var j = 0; j < imgs.length; j++) {
        imgs[j].addEventListener("click", function(e) {
          var lb = document.createElement("div");
          lb.className = "image-lightbox";
          var bigImg = document.createElement("img");
          bigImg.src = e.target.src;
          lb.appendChild(bigImg);
          lb.addEventListener("click", function() { lb.remove(); });
          document.body.appendChild(lb);
        });
      }
      this.container.appendChild(div);
      this._addCopyButtons(div);
      this._addCollapsible(div);
      this._highlightCode(div);
      this._attachDeleteHandler(div);
      this._animateEntrance(div);
      this._scrollToBottom();
    },

    renderAgentMessage: function(text) {
      var indicator = document.getElementById("activity-indicator");
      if (indicator) indicator.remove();
      var streaming = document.getElementById("streaming-message");
      if (streaming) streaming.remove();
      var div = document.createElement("div");
      div.classList.add("message", "agent");
      div.setAttribute("data-raw-text", text);
      div.innerHTML =
        '<div class="message-body">' + renderMedia(renderMarkdown(text)) + '</div>' +
        '<div class="message-actions"><button class="tts-btn" title="Listen">🔊</button></div>' +
        '<div class="timestamp">' + this._formatTime() + '</div>';
      this._collapsePreviousLast();
      this.container.appendChild(div);
      this._addCopyButtons(div);
      this._addCollapsible(div, { forceExpand: true });
      this._highlightCode(div);
      this._initVideos(div);
      this._attachDeleteHandler(div);
      this._attachTtsHandler(div);
      this._animateEntrance(div);
      this._scrollToBottom();
    },

    _collapsePreviousLast: function() {
      var agents = this.container.querySelectorAll(".message.agent");
      if (agents.length === 0) return;
      var prev = agents[agents.length - 1];
      this._addCollapsible(prev);
    },

    // ── Activity indicator ──

    showActivity: function(activity) {
      var indicator = document.getElementById("activity-indicator");
      if (activity.phase === "end" || activity.type === "done") {
        if (activity.phase === "end" && activity.type === "tool" && indicator) {
          this._addActivityLog(indicator, activity, true);
        }
        if (activity.type === "done") {
          if (indicator) {
            if (indicator._elapsedTimer) clearInterval(indicator._elapsedTimer);
            indicator.remove();
          }
        }
        return;
      }
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.id = "activity-indicator";
        indicator.classList.add("message", "agent", "activity");
        indicator.innerHTML =
          '<div class="activity-content">' +
            '<span class="activity-dots"><span>.</span><span>.</span><span>.</span></span>' +
            '<span class="activity-label"></span>' +
            '<span class="activity-elapsed"></span>' +
          '</div>' +
          '<div class="activity-detail-line"></div>' +
          '<details class="activity-details"><summary class="activity-expand">Details</summary>' +
          '<div class="activity-log"></div></details>';
        indicator._startTime = Date.now();
        indicator._toolCount = 0;
        // Elapsed timer — updates every second
        var elapsedEl = indicator.querySelector(".activity-elapsed");
        indicator._elapsedTimer = setInterval(function() {
          if (!indicator._startTime || !elapsedEl) return;
          var s = Math.floor((Date.now() - indicator._startTime) / 1000);
          if (s < 5) return; // don't show for first 5s
          var m = Math.floor(s / 60); s = s % 60;
          elapsedEl.textContent = (m > 0 ? m + "m " : "") + s + "s";
        }, 1000);
        this.container.appendChild(indicator);
      }
      var toolLabels = {
        Read: "📄 Reading", read: "📄 Reading",
        Write: "✍️ Writing", write: "✍️ Writing",
        Edit: "✏️ Editing", edit: "✏️ Editing",
        exec: "⚡", process: "⚡ Process",
        web_search: "🔍 Searching", web_fetch: "🌐 Fetching",
        browser: "🌐 Browser", memory_search: "🧠 Searching memory",
        memory_get: "🧠 Reading memory", cron: "⏰ Schedules",
        gateway: "⚙️ Gateway", sessions_spawn: "🤖 Spawning sub-agent",
        sessions_history: "📜 Reading history", sessions_send: "💬 Sending message",
        session_status: "📊 Status", message: "💬 Messaging",
        image: "🖼️ Analyzing image", tts: "🔊 Generating audio",
        canvas: "🎨 Canvas", nodes: "📱 Devices",
      };
      // Build the main label — show full detail inline
      var label = "";
      var detailText = "";
      if (activity.type === "tool" && activity.name) {
        var prefix = toolLabels[activity.name] || ("🔧 " + activity.name);
        detailText = this._extractToolDetail(activity.name, activity.detail);
        if (detailText) {
          // Truncate very long details but keep them readable
          var display = detailText.length > 100 ? detailText.substring(0, 97) + "..." : detailText;
          label = prefix + " " + display;
        } else {
          label = prefix;
        }
      } else if (activity.type === "thinking") {
        label = "💭 Thinking...";
      } else {
        label = "⏳ Working...";
      }
      var labelEl = indicator.querySelector(".activity-label");
      if (labelEl) labelEl.textContent = label;
      // Detail line — full path/command/query for context (always show if present)
      var detailLine = indicator.querySelector(".activity-detail-line");
      if (detailLine) {
        if (detailText) {
          detailLine.textContent = detailText;
          detailLine.style.display = "block";
        } else {
          detailLine.style.display = "none";
        }
      }
      if (activity.type === "tool") {
        indicator._toolCount = (indicator._toolCount || 0) + 1;
        this._addActivityLog(indicator, activity, false);
      }
      this.container.appendChild(indicator);
      this._scrollToBottom();
    },

    _extractToolDetail: function(name, detail) {
      if (!detail) return "";
      var d = detail.args || detail.input || detail;
      if (!d || typeof d !== "object") return "";
      switch(name) {
        case "read": case "Read":
          var rp = d.path || d.file_path || "";
          if (d.offset) rp += " (line " + d.offset + ")";
          return rp;
        case "write": case "Write":
          return d.path || d.file_path || "";
        case "edit": case "Edit":
          var ep = d.path || d.file_path || "";
          return ep;
        case "exec":
          return d.command || "";
        case "web_search":
          return d.query ? '"' + d.query + '"' : "";
        case "web_fetch":
          // Show domain + path for URLs
          try {
            var u = new URL(d.url || "");
            return u.hostname + u.pathname;
          } catch(e) { return d.url || ""; }
        case "browser":
          var ba = d.action || "";
          if (d.targetUrl) ba += " → " + d.targetUrl;
          return ba;
        case "memory_search":
          return d.query ? '"' + d.query + '"' : "";
        case "memory_get":
          return d.path || "";
        case "sessions_spawn":
          return d.task || "";
        case "image":
          return d.prompt || "";
        case "gateway":
          return d.action || "";
        case "cron":
          var ca = d.action || "";
          if (d.job && d.job.name) ca += " " + d.job.name;
          return ca;
        case "message":
          var ma = d.action || "";
          if (d.target) ma += " → " + d.target;
          return ma;
        case "tts":
          return d.text ? '"' + (d.text.length > 60 ? d.text.substring(0, 57) + "..." : d.text) + '"' : "";
        default: return "";
      }
    },

    _addActivityLog: function(indicator, activity, isEnd) {
      var log = indicator.querySelector(".activity-log");
      if (!log) return;
      var detail = this._extractToolDetail(activity.name, activity.detail);
      var entry = document.createElement("div");
      entry.className = "activity-log-entry" + (isEnd ? " done" : "");
      var icon = isEnd ? "✅" : "▸";
      var text = (activity.name || "tool");
      if (detail) {
        // Truncate long details in log
        var logDetail = detail.length > 80 ? detail.substring(0, 77) + "..." : detail;
        text += ": " + logDetail;
      }
      entry.textContent = icon + " " + text;
      log.appendChild(entry);
      while (log.children.length > 20) log.removeChild(log.firstChild);
      var summary = indicator.querySelector(".activity-expand");
      var count = indicator._toolCount || log.children.length;
      if (summary) summary.textContent = "Details (" + count + " tool calls)";
    },

    hideActivity: function() {
      var indicator = document.getElementById("activity-indicator");
      if (indicator) indicator.remove();
    },

    // ── Streaming ──

    renderStreamingDelta: function(text) {
      var indicator = document.getElementById("activity-indicator");
      if (indicator) indicator.remove();
      var bubble = document.getElementById("streaming-message");
      if (!bubble) {
        bubble = document.createElement("div");
        bubble.id = "streaming-message";
        bubble.classList.add("message", "agent", "streaming");
        this.container.appendChild(bubble);
      }
      bubble.setAttribute("data-stream-text", text);
      bubble.innerHTML =
        '<div class="message-body">' + renderMedia(renderMarkdown(text, { streaming: true })) + '</div>' +
        '<div class="timestamp streaming-indicator">● typing...</div>';
      this._addCopyButtons(bubble);
      this._scrollToBottom();
    },

    finalizeStreaming: function(text) {
      var indicator = document.getElementById("activity-indicator");
      if (indicator) indicator.remove();
      var bubble = document.getElementById("streaming-message");
      if (!bubble) { this.renderAgentMessage(text); return; }

      var thinkingHtml = "";
      var streamText = bubble.getAttribute("data-stream-text") || "";
      var thinking = this._extractThinking(streamText, text);
      if (thinking) {
        thinkingHtml = '<details class="sui-thinking"><summary>💭 Show reasoning</summary>' +
          '<div class="sui-thinking-body">' + renderMarkdown(thinking) + '</div></details>';
      }

      bubble.setAttribute("data-raw-text", text);
      bubble.innerHTML = thinkingHtml +
        '<div class="message-body">' + renderMedia(renderMarkdown(text)) + '</div>' +
        '<div class="message-actions"><button class="tts-btn" title="Listen">🔊</button></div>' +
        '<div class="timestamp">' + this._formatTime() + '</div>';
      bubble.classList.remove("streaming");
      bubble.removeAttribute("id");
      bubble.removeAttribute("data-stream-text");
      this._addCopyButtons(bubble);
      this._addCollapsible(bubble, { forceExpand: true });
      this._highlightCode(bubble);
      this._initVideos(bubble);
      this._attachDeleteHandler(bubble);
      this._attachTtsHandler(bubble);

      if (AUTO_SPEECH && text.length < 500) {
        var ttsBtn = bubble.querySelector(".tts-btn");
        if (ttsBtn) setTimeout(function() { ttsBtn.click(); }, 300);
      }

      if (bubble.nextElementSibling && bubble.nextElementSibling.classList.contains("message")) {
        this.container.appendChild(bubble);
      }
      this._scrollToBottom();
    },

    _extractThinking: function(streamText, finalText) {
      if (!streamText || !finalText) return null;
      var st = streamText.trim();
      var ft = finalText.trim();
      if (st.length > ft.length + 20 && st.endsWith(ft)) return st.slice(0, st.length - ft.length).trim();
      var idx = st.lastIndexOf(ft);
      if (idx > 20) return st.slice(0, idx).trim();
      return null;
    },

    renderSystemMessage: function(text) {
      var div = document.createElement("div");
      div.classList.add("message", "system");
      div.innerHTML = '<span class="system-text">' + this._escapeHtml(text) + '</span>';
      this.container.appendChild(div);
      this._scrollToBottom();
    },

    renderCompactionMarker: function(dateStr) {
      var div = document.createElement("div");
      div.classList.add("compaction-marker");
      var label = dateStr ? "older messages compacted · " + dateStr : "older messages compacted";
      div.innerHTML = '<span class="compaction-line"></span><span class="compaction-label">' + label + '</span><span class="compaction-line"></span>';
      if (this.container.firstChild) this.container.insertBefore(div, this.container.firstChild);
      else this.container.appendChild(div);
    },

    clearWelcome: function() {
      var el = this.container.querySelector(".welcome-message");
      if (el) el.remove();
    },

    // ── Collapsible "See more/less" ──

    _addCollapsible: function(el, opts) {
      var body = el.querySelector(".message-body");
      if (!body) return;
      var existingBtn = el.querySelector(".see-more-btn");
      if (existingBtn) existingBtn.remove();
      body.classList.remove("collapsed");
      body.style.maxHeight = "";
      var forceExpand = opts && opts.forceExpand;
      requestAnimationFrame(function() {
        var MAX_HEIGHT = 300;
        if (body.scrollHeight <= MAX_HEIGHT) return;
        var expanded = !!forceExpand;
        if (!forceExpand) {
          body.classList.add("collapsed");
          body.style.maxHeight = MAX_HEIGHT + "px";
        }
        var btn = document.createElement("button");
        btn.className = "see-more-btn";
        btn.textContent = expanded ? "See less ▲" : "See more ▼";
        btn.addEventListener("click", function() {
          expanded = !expanded;
          if (expanded) {
            body.classList.remove("collapsed");
            body.style.maxHeight = "none";
            btn.textContent = "See less ▲";
          } else {
            body.classList.add("collapsed");
            body.style.maxHeight = MAX_HEIGHT + "px";
            btn.textContent = "See more ▼";
          }
        });
        var timestamp = el.querySelector(".timestamp");
        if (timestamp) el.insertBefore(btn, timestamp);
        else el.appendChild(btn);
      });
    },

    // ── Copy buttons ──

    _addCopyButtons: function(el) {
      var pres = el.querySelectorAll("pre");
      for (var i = 0; i < pres.length; i++) {
        var pre = pres[i];
        if (pre.querySelector(".code-copy-btn")) continue;
        var wrapper = document.createElement("div");
        wrapper.className = "code-block-wrapper";
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
        var btn = document.createElement("button");
        btn.className = "code-copy-btn";
        btn.textContent = "Copy";
        btn.addEventListener("click", (function(targetPre, targetBtn) {
          return function() {
            var code = targetPre.querySelector("code");
            var text = code ? code.textContent : targetPre.textContent;
            navigator.clipboard.writeText(text).then(function() {
              targetBtn.textContent = "Copied!";
              targetBtn.classList.add("copied");
              setTimeout(function() { targetBtn.textContent = "Copy"; targetBtn.classList.remove("copied"); }, 2000);
            });
          };
        })(pre, btn));
        wrapper.appendChild(btn);
      }
    },

    // ── Videos ──

    _initVideos: function(el) {
      var videos = el.querySelectorAll("video.sui-video-player");
      var dlIcon = '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      for (var i = 0; i < videos.length; i++) {
        (function(v) {
          var parent = v.parentNode;
          var errEl = parent.querySelector(".sui-video-error") || parent.parentNode.querySelector(".sui-video-error");
          var src = v.querySelector("source");
          if (src) {
            src.addEventListener("error", function() {
              v.style.display = "none";
              if (errEl) errEl.style.display = "flex";
            });
          }
          v.addEventListener("play", function() { setTimeout(function() { v.blur(); }, 50); });
          v.addEventListener("pause", function() { setTimeout(function() { v.blur(); }, 50); });
          var existingDl = parent.querySelector(".sui-video-dl");
          if (existingDl && typeof navigator.share === "function" && !existingDl._shareWired) {
            existingDl._shareWired = true;
            var dlSrc = existingDl.getAttribute("href");
            if (dlSrc && dlSrc !== "#") {
              existingDl.removeAttribute("download");
              existingDl.addEventListener("click", (function(url) {
                return function(e) {
                  e.preventDefault(); e.stopPropagation();
                  fetch(url).then(function(r) { return r.blob(); }).then(function(blob) {
                    var filename = url.split("/").pop() || "video.mp4";
                    var file = new File([blob], filename, { type: blob.type || "video/mp4" });
                    if (navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share({ files: [file], title: filename });
                    else return navigator.share({ url: url, title: filename });
                  }).catch(function() { navigator.share({ url: url }).catch(function() {}); });
                };
              })(dlSrc));
            }
          }
          if (!parent.querySelector(".sui-video-dl")) {
            var videoSrc = (src && src.getAttribute("src")) || v.getAttribute("src") || "";
            if (videoSrc) {
              if (!parent.classList.contains("sui-video-wrap")) {
                var wrap = document.createElement("div");
                wrap.className = "sui-video-wrap";
                parent.insertBefore(wrap, v);
                wrap.appendChild(v);
                parent = wrap;
              }
              var btn = document.createElement("a");
              btn.className = "sui-video-dl";
              btn.title = "Save / Share";
              btn.innerHTML = dlIcon;
              if (typeof navigator.share === "function") {
                btn.href = "#";
                btn.addEventListener("click", (function(url) {
                  return function(e) {
                    e.preventDefault(); e.stopPropagation();
                    fetch(url).then(function(r) { return r.blob(); }).then(function(blob) {
                      var filename = url.split("/").pop() || "video.mp4";
                      var file = new File([blob], filename, { type: blob.type || "video/mp4" });
                      if (navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share({ files: [file], title: filename });
                      else return navigator.share({ url: url, title: filename });
                    }).catch(function() { navigator.share({ url: url }).catch(function() {}); });
                  };
                })(videoSrc));
              } else {
                btn.href = videoSrc;
                btn.download = "";
              }
              parent.appendChild(btn);
            }
          }
        })(videos[i]);
      }
    },

    // ── Syntax highlighting ──

    _highlightCode: function(el) {
      if (typeof Prism === "undefined") return;
      var blocks = el.querySelectorAll("pre code[class*='language-']");
      for (var i = 0; i < blocks.length; i++) Prism.highlightElement(blocks[i]);
    },

    // ── Utilities ──

    _cleanText: function(text) {
      return (text || "")
        .replace(/\[ProteClaw Memory\] Auto-recalled[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |$)/g, "")
        .replace(/\[ProteClaw Canary\][^\n]*/g, "")
        .replace(/\n?\[message_id:[^\]]*\]/g, "")
        .replace(/\n?\[genui:\w+\]/g, "")
        .replace(/^\s*\n/gm, "")
        .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[^\]]*\]\s*/g, "")
        .trim();
    },

    _escapeHtml: function(text) {
      var div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    },

    _formatTime: function() {
      return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    },

    _formatTimeFromISO: function(isoStr) {
      if (!isoStr) return this._formatTime();
      try {
        var d = new Date(isoStr);
        if (isNaN(d.getTime())) return this._formatTime();
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch(e) { return this._formatTime(); }
    },

    _scrollToBottom: function() {
      if (typeof hydrateLiveComponents === "function") hydrateLiveComponents(this.container);
      if (!this._autoScroll) return;
      var last = this.container.lastElementChild;
      if (last) last.scrollIntoView({ block: "end", behavior: "auto" });
      else this.container.scrollTop = this.container.scrollHeight;
    },

    // Reset grouping state (call when clearing messages)
    resetGrouping: function() {
      this._lastRenderedMsg = null;
    }
  };

  // Expose globally
  window.ScratchyMessageRenderer = MessageRenderer;

  // Backward compat
  if (!window.MessageRenderer) {
    window.MessageRenderer = MessageRenderer;
  }

})();
