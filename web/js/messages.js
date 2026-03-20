// ============================================
// Scratchy — Message Rendering
// ============================================

// Auto-speech: automatically play TTS for short agent replies
var SCRATCHY_AUTO_SPEECH = localStorage.getItem("scratchy_auto_speech") === "true";

// Extract plain speakable text from a message (strip markdown, code, canvas ops, etc.)
function _extractSpeakableText(text) {
  if (!text) return "";
  // Don't speak canvas operations or system messages
  if (/```scratchy-(canvas|ui|tpl|toon)/.test(text)) return "";
  if (/^\[ProteClaw/.test(text)) return "";
  if (/^(HEARTBEAT_OK|NO_REPLY)$/.test(text.trim())) return "";

  var clean = text
    // Remove code blocks entirely
    .replace(/```[\s\S]*?```/g, "")
    // Remove inline code
    .replace(/`[^`]+`/g, "")
    // Remove markdown headings markers
    .replace(/#{1,6}\s*/g, "")
    // Remove bold/italic/strikethrough markers
    .replace(/[*_~]{1,3}/g, "")
    // Remove links — keep link text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    // Remove HTML tags
    .replace(/<[^>]+>/g, "")
    // Remove blockquote markers
    .replace(/^>\s*/gm, "")
    // Remove list markers
    .replace(/^[\s]*[-*+]\s/gm, "")
    .replace(/^[\s]*\d+\.\s/gm, "")
    // Collapse newlines
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    // Collapse spaces
    .replace(/\s{2,}/g, " ")
    .trim();

  return clean;
}

class MessageRenderer {
  constructor(containerElement) {
    this.container = containerElement;
    this._autoScroll = true;
    this._scrollBtn = null;
    this._initScrollWatcher();
  }

  // Track user scroll position — disable auto-scroll when not at bottom
  _initScrollWatcher() {
    // Scroll event (mouse wheel, trackpad, drag scrollbar)
    this.container.addEventListener("scroll", () => {
      var atBottom = this._isNearBottom();
      if (atBottom) {
        this._autoScroll = true;
        this._hideScrollBtn();
      } else {
        this._autoScroll = false;
        this._showScrollBtn();
      }
    });

    // Arrow keys: Up disables auto-scroll, Down re-enables when near bottom
    document.addEventListener("keydown", (e) => {
      if (document.activeElement === document.getElementById("message-input")) return;
      if (e.key === "ArrowUp") {
        this._autoScroll = false;
        this._showScrollBtn();
      }
      if (e.key === "ArrowDown") {
        // If we scrolled back to bottom, re-enable auto-scroll
        requestAnimationFrame(() => {
          if (this._isNearBottom()) {
            this._autoScroll = true;
            this._hideScrollBtn();
          }
        });
      }
    });

    // Create the scroll-to-bottom button
    this._scrollBtn = document.createElement("button");
    this._scrollBtn.id = "scroll-bottom-btn";
    this._scrollBtn.innerHTML = "↓";
    this._scrollBtn.title = "Scroll to bottom";
    this._scrollBtn.style.display = "none";
    this._scrollBtn.addEventListener("click", () => {
      this._autoScroll = true;
      this._scrollToBottom();
      this._hideScrollBtn();
    });

    // Insert into #app (positioned via CSS)
    var app = document.getElementById("app");
    if (app) app.appendChild(this._scrollBtn);
  }

  _isNearBottom() {
    var threshold = 60;
    return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
  }

  _showScrollBtn() {
    if (this._scrollBtn) this._scrollBtn.style.display = "flex";
  }

  _hideScrollBtn() {
    if (this._scrollBtn) this._scrollBtn.style.display = "none";
  }

  // Attach message menu: tap message → show ⋯ button → tap ⋯ → show actions
  // ------------------------------------------
  // TTS: play agent message as audio
  // ------------------------------------------
  _attachTtsHandler(el) {
    var btn = el.querySelector(".tts-btn");
    if (!btn) return;

    // State: idle | loading | playing | paused
    btn._state = "idle";
    btn._blobUrl = null; // Cached audio blob URL
    btn._audio = null;

    btn.addEventListener("click", function(e) {
      e.stopPropagation();

      // Stop any other playing TTS globally
      if (window._activeTtsBtn && window._activeTtsBtn !== btn) {
        var other = window._activeTtsBtn;
        if (other._audio) { other._audio.pause(); other._audio.currentTime = 0; }
        other._state = other._blobUrl ? "idle" : "idle";
        other.textContent = "🔊";
        other.classList.remove("playing", "loading");
      }

      if (btn._state === "loading") return; // Don't double-trigger

      if (btn._state === "playing") {
        // Pause
        if (btn._audio) btn._audio.pause();
        btn._state = "paused";
        btn.textContent = "▶️";
        btn.classList.remove("playing");
        return;
      }

      if (btn._state === "paused" && btn._audio) {
        // Resume
        btn._audio.play();
        btn._state = "playing";
        btn.textContent = "⏸";
        btn.classList.add("playing");
        window._activeTtsBtn = btn;
        return;
      }

      // If we have cached audio, just play it
      if (btn._blobUrl) {
        var audio = new Audio(btn._blobUrl);
        btn._audio = audio;
        btn._state = "playing";
        btn.textContent = "⏸";
        btn.classList.add("playing");
        window._activeTtsBtn = btn;

        audio.addEventListener("ended", function() {
          btn._state = "idle";
          btn.textContent = "🔊";
          btn.classList.remove("playing");
        });
        audio.play();
        return;
      }

      // First time: fetch and cache
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
        .then(function(res) {
          if (!res.ok) throw new Error("TTS failed: " + res.status);
          return res.blob();
        })
        .then(function(blob) {
          var url = URL.createObjectURL(blob);
          btn._blobUrl = url; // Cache it

          var audio = new Audio(url);
          btn._audio = audio;
          btn._state = "playing";
          btn.textContent = "⏸";
          btn.classList.remove("loading");
          btn.classList.add("playing");
          window._activeTtsBtn = btn;

          audio.addEventListener("ended", function() {
            btn._state = "idle";
            btn.textContent = "🔊";
            btn.classList.remove("playing");
          });

          audio.play();
        })
        .catch(function(err) {
          console.error("[TTS]", err);
          btn._state = "idle";
          btn.textContent = "🔊";
          btn.classList.remove("loading");
        });
    });
  }

  _attachDeleteHandler(el) {
    var self = this;

    el.addEventListener("click", function(e) {
      // Don't trigger on links, buttons, copy buttons, or interactive elements
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "a" || tag === "button" || e.target.closest("button") || e.target.closest("a") ||
          e.target.closest(".msg-menu") || e.target.closest(".msg-actions")) return;

      // Remove any existing menus on other messages
      self._dismissMenus();

      // Don't re-add if already has one
      if (el.querySelector(".msg-menu")) return;

      // Stop propagation so the global dismiss listener doesn't kill it immediately
      e.stopPropagation();

      el.style.position = "relative";
      // Insert dots inline next to the timestamp
      var timestamp = el.querySelector(".timestamp");
      var dots = document.createElement("button");
      dots.className = "msg-menu";
      dots.innerHTML = "⋯";
      dots.title = "Message options";
      if (timestamp) {
        timestamp.appendChild(dots);
      } else {
        el.appendChild(dots);
      }

      dots.addEventListener("click", function(e2) {
        e2.stopPropagation();
        // Toggle actions panel
        var existing = el.querySelector(".msg-actions");
        if (existing) { existing.remove(); return; }

        var actions = document.createElement("div");
        actions.className = "msg-actions";
        actions.innerHTML = '<button class="msg-action-delete">Delete</button>';
        el.appendChild(actions);

        actions.querySelector(".msg-action-delete").addEventListener("click", function(e3) {
          e3.stopPropagation();
          // H4: Revoke TTS blob URL to prevent memory leak
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
  }

  _dismissMenus() {
    var menus = document.querySelectorAll(".msg-menu, .msg-actions");
    for (var i = 0; i < menus.length; i++) menus[i].remove();
  }

  // Create a DOM element from a store message object WITHOUT appending it.
  // Used by DOMSync to build elements for the message store.
  createElement(msg) {
    var text = msg.text || "";
    var clean = text
      .replace(/\[ProteClaw Memory\] Auto-recalled[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |$)/g, "")
      .replace(/\[ProteClaw Canary\][^\n]*/g, "")
      .replace(/\n?\[message_id:[^\]]*\]/g, "")
      .replace(/\n?\[genui:\w+\]/g, "")
      .replace(/^\s*\n/gm, "")
      .trim();

    // Compaction: render as a date divider
    if (msg.role === "compaction") {
      var div = document.createElement("div");
      div.classList.add("compaction-marker");
      var dateStr = msg.timestamp || "";
      if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        var dparts = dateStr.split("-");
        dateStr = dparts[2] + "/" + dparts[1] + "/" + dparts[0];
      }
      var label = dateStr
        ? "older messages compacted · " + dateStr
        : "older messages compacted";
      div.innerHTML = '<span class="compaction-line"></span><span class="compaction-label">' + label + '</span><span class="compaction-line"></span>';
      return div;
    }

    // Streaming message (in-progress agent response)
    if (msg.streaming) {
      var div = document.createElement("div");
      div.id = "streaming-message";
      div.classList.add("message", "agent", "streaming");
      div.setAttribute("data-stream-text", text);
      div.setAttribute("data-raw-text", clean);
      if (msg.id) div.setAttribute("data-msg-id", msg.id);
      div.innerHTML =
        '<div class="message-body">' + renderMedia(renderMarkdown(text, { streaming: true })) + '</div>' +
        '<div class="timestamp streaming-indicator">● typing...</div>';
      this._addCopyButtons(div);
      return div;
    }

    var div = document.createElement("div");
    if (msg.id) div.setAttribute("data-msg-id", msg.id);
    div.setAttribute("data-raw-text", clean);

    if (msg.role === "user") {
      div.classList.add("message", "user");

      // Build image thumbnails
      var imagesHtml = '';
      if (msg.images && msg.images.length > 0) {
        imagesHtml = '<div class="msg-attachments">';
        for (var i = 0; i < msg.images.length; i++) {
          imagesHtml += '<img src="' + msg.images[i] + '" alt="attached image" loading="lazy">';
        }
        imagesHtml += '</div>';
      }

      // Build file attachment badges
      var filesHtml = '';
      if (msg.fileAttachments && msg.fileAttachments.length > 0) {
        filesHtml = '<div class="msg-file-attachments">';
        for (var f = 0; f < msg.fileAttachments.length; f++) {
          var fa = msg.fileAttachments[f];
          filesHtml += '<span class="file-badge">' + (fa.icon || '📎') + ' ' + this._escapeHtml(fa.name) + '</span>';
        }
        filesHtml += '</div>';
      }

      var bodyHtml = clean ? renderMarkdown(clean) : "";
      var timestampStr = msg.timestamp ? this._formatTimeFromISO(msg.timestamp) : this._formatTime();

      div.innerHTML =
        imagesHtml +
        filesHtml +
        '<div class="message-body">' + bodyHtml + '</div>' +
        '<div class="timestamp">' + timestampStr + '</div>';

      // Click image → fullscreen lightbox
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

      // Post-processing
      this._addCopyButtons(div);
      this._addCollapsible(div);
      this._highlightCode(div);
      this._attachDeleteHandler(div);

    } else if (msg.role === "assistant") {
      div.classList.add("message", "agent");
      var timestampStr = msg.timestamp ? this._formatTimeFromISO(msg.timestamp) : this._formatTime();

      div.innerHTML =
        '<div class="message-body">' + renderMedia(renderMarkdown(text)) + '</div>' +
        '<div class="message-actions"><button class="tts-btn" title="Listen">🔊</button></div>' +
        '<div class="timestamp">' + timestampStr + '</div>';

      // Post-processing
      this._addCopyButtons(div);
      this._addCollapsible(div);
      this._highlightCode(div);
      this._initVideos(div);
      this._attachDeleteHandler(div);
      this._attachTtsHandler(div);

    } else {
      // system or unknown role
      div.classList.add("message", "system");
      div.innerHTML = '<span class="system-text">' + this._escapeHtml(clean) + '</span>';
    }

    return div;
  }

  // Format time from ISO timestamp string
  _formatTimeFromISO(isoStr) {
    if (!isoStr) return this._formatTime();
    try {
      var d = new Date(isoStr);
      if (isNaN(d.getTime())) return this._formatTime();
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch(e) {
      return this._formatTime();
    }
  }

  renderUserMessage(text) {
    // Strip metadata tags that shouldn't be visible
    var clean = text
      .replace(/\[ProteClaw Memory\] Auto-recalled[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |$)/g, "")
      .replace(/\[ProteClaw Canary\][^\n]*/g, "")
      .replace(/\n?\[message_id:[^\]]*\]/g, "")
      .replace(/\n?\[genui:\w+\]/g, "")
      .replace(/^\s*\n/gm, "")
      .trim();
    const div = document.createElement("div");
    div.classList.add("message", "user");
    div.setAttribute("data-raw-text", clean);
    div.innerHTML = `
      <div class="message-body">${renderMarkdown(clean)}</div>
      <div class="timestamp">${this._formatTime()}</div>
    `;
    // Insert before activity indicator so it stays at the bottom
    var activityEl = document.getElementById("activity-indicator");
    if (activityEl) {
      this.container.insertBefore(div, activityEl);
    } else {
      this.container.appendChild(div);
    }
    this._addCopyButtons(div);
    this._addCollapsible(div);
    this._highlightCode(div);
    this._attachDeleteHandler(div);
    this._scrollToBottom();
  }

  // Render user message with image attachments
  renderUserMessageWithImages(text, imageDataUrls, fileAttachments) {
    var clean = text
      .replace(/\[ProteClaw Memory\] Auto-recalled[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |$)/g, "")
      .replace(/\[ProteClaw Canary\][^\n]*/g, "")
      .replace(/\n?\[message_id:[^\]]*\]/g, "")
      .replace(/\n?\[genui:\w+\]/g, "")
      .replace(/^\s*\n/gm, "")
      .trim();

    const div = document.createElement("div");
    div.classList.add("message", "user");
    div.setAttribute("data-raw-text", clean);

    // Build image thumbnails
    var imagesHtml = '';
    if (imageDataUrls && imageDataUrls.length > 0) {
      imagesHtml = '<div class="msg-attachments">';
      for (var i = 0; i < imageDataUrls.length; i++) {
        imagesHtml += '<img src="' + imageDataUrls[i] + '" alt="attached image" loading="lazy">';
      }
      imagesHtml += '</div>';
    }

    // Build file attachment badges
    var filesHtml = '';
    if (fileAttachments && fileAttachments.length > 0) {
      filesHtml = '<div class="msg-file-attachments">';
      for (var f = 0; f < fileAttachments.length; f++) {
        var fa = fileAttachments[f];
        filesHtml += '<span class="file-badge">' + (fa.icon || '📎') + ' ' + this._escapeHtml(fa.name) + '</span>';
      }
      filesHtml += '</div>';
    }

    var bodyHtml = clean ? renderMarkdown(clean) : "";

    div.innerHTML = `
      ${imagesHtml}
      ${filesHtml}
      <div class="message-body">${bodyHtml}</div>
      <div class="timestamp">${this._formatTime()}</div>
    `;

    // Click image → fullscreen lightbox
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
    this._scrollToBottom();
  }

  renderAgentMessage(text) {
    // Clear any lingering indicators
    var indicator = document.getElementById("activity-indicator");
    if (indicator) indicator.remove();
    var streaming = document.getElementById("streaming-message");
    if (streaming) streaming.remove();

    // Phase 31: Strip canvas blocks (rendered as widget regions inline)
    var displayText = text
      .replace(/```scratchy-canvas\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-toon\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-a2ui\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-tpl\s*\n[\s\S]*?```/g, '')
      .trim();

    const div = document.createElement("div");
    div.classList.add("message", "agent");
    div.setAttribute("data-raw-text", text);
    div.innerHTML = `
      <div class="message-body">${renderMedia(renderMarkdown(displayText || text))}</div>
      <div class="message-actions">
        <button class="tts-btn" title="Listen">🔊</button>
      </div>
      <div class="timestamp">${this._formatTime()}</div>
    `;
    // Collapse the previous last agent message before adding the new one
    this._collapsePreviousLast();
    this.container.appendChild(div);
    this._addCopyButtons(div);
    this._addCollapsible(div, { forceExpand: true });
    this._highlightCode(div);
    this._initVideos(div);
    this._attachDeleteHandler(div);
    this._attachTtsHandler(div);

    // Auto-speech: finalize real-time TTS or fall back to full-message TTS
    if (SCRATCHY_AUTO_SPEECH && typeof isRealtimeTTSActive === "function" && isRealtimeTTSActive()) {
      // Finalize real-time TTS with remaining text
      if (typeof finalizeRealtimeTTS === "function") {
        var plainText = _extractSpeakableText(text);
        finalizeRealtimeTTS(plainText);
      }
    } else if (SCRATCHY_AUTO_SPEECH && typeof playStreamingTTS === "function") {
      // Fallback: play full message TTS (non-streaming path)
      var plainText = _extractSpeakableText(text);
      if (plainText && plainText.length > 0 && plainText.length < 500) {
        setTimeout(function() { playStreamingTTS(plainText); }, 200);
      }
    }

    this._scrollToBottom();
  }

  // Collapse the previous last agent message (if it was expanded as "last")
  _collapsePreviousLast() {
    var agents = this.container.querySelectorAll(".message.agent");
    if (agents.length === 0) return;
    var prev = agents[agents.length - 1];
    // Re-apply collapsible without forceExpand
    this._addCollapsible(prev);
  }

  // Activity indicator — shows what the agent is doing (tool calls, thinking)
  showActivity(activity) {
    let indicator = document.getElementById("activity-indicator");

    if (activity.phase === "end" || activity.type === "done") {
      // On tool end: update log but don't remove indicator (next tool or streaming will clear it)
      if (activity.phase === "end" && activity.type === "tool" && indicator) {
        this._addActivityLog(indicator, activity, true);
      }
      if (activity.type === "done") {
        if (indicator) indicator.remove();
      }
      return;
    }

    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "activity-indicator";
      indicator.classList.add("message", "agent", "activity");
      indicator.innerHTML = `
        <div class="activity-content">
          <span class="activity-dots"><span>.</span><span>.</span><span>.</span></span>
          <span class="activity-label"></span>
        </div>
        <details class="activity-details"><summary class="activity-expand">Show details</summary><div class="activity-log"></div></details>
      `;
      this.container.appendChild(indicator);
    }

    // Map tool names to friendly labels with specific detail extraction
    var toolLabels = {
      Read: "📄 Reading file", read: "📄 Reading file",
      Write: "✍️ Writing file", write: "✍️ Writing file",
      Edit: "✏️ Editing file", edit: "✏️ Editing file",
      exec: "⚡ Running command", process: "⚡ Managing process",
      web_search: "🔍 Searching the web", web_fetch: "🌐 Fetching page",
      browser: "🌐 Using browser", memory_search: "🧠 Searching memory",
      memory_get: "🧠 Reading memory", cron: "⏰ Managing schedules",
      gateway: "⚙️ Configuring gateway", sessions_spawn: "🤖 Spawning sub-agent",
      sessions_history: "📜 Reading history", sessions_send: "💬 Sending message",
      session_status: "📊 Checking status", message: "💬 Sending message",
      image: "🖼️ Analyzing image", tts: "🔊 Generating audio",
      canvas: "🎨 Rendering canvas", nodes: "📱 Checking devices",
    };

    var label = "";
    var detailText = "";
    if (activity.type === "tool" && activity.name) {
      label = toolLabels[activity.name] || ("🔧 " + activity.name);
      detailText = this._extractToolDetail(activity.name, activity.detail);
    } else if (activity.type === "thinking") {
      label = "💭 Thinking...";
    } else {
      label = "⏳ Working...";
    }

    var labelEl = indicator.querySelector(".activity-label");
    if (labelEl) labelEl.textContent = label;

    // Detail line — full path/command/query
    var detailLine = indicator.querySelector(".activity-detail-line");
    if (detailLine) {
      if (detailText) {
        detailLine.textContent = detailText;
        detailLine.style.display = "block";
      } else {
        detailLine.style.display = "none";
      }
    }

    // Add to activity log
    if (activity.type === "tool") {
      this._addActivityLog(indicator, activity, false);
    }

    // Ensure it's always at the very bottom
    this.container.appendChild(indicator);
    this._scrollToBottom();
  }

  _extractToolDetail(name, detail) {
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
        return d.path || d.file_path || "";
      case "exec":
        return d.command || "";
      case "web_search":
        return d.query ? '"' + d.query + '"' : "";
      case "web_fetch":
        try { var u = new URL(d.url || ""); return u.hostname + u.pathname; }
        catch(e) { return d.url || ""; }
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
      case "cron":
        return d.action || "";
      default:
        return "";
    }
  }

  _addActivityLog(indicator, activity, isEnd) {
    var log = indicator.querySelector(".activity-log");
    if (!log) return;
    var detail = this._extractToolDetail(activity.name, activity.detail);
    var entry = document.createElement("div");
    entry.className = "activity-log-entry" + (isEnd ? " done" : "");
    var icon = isEnd ? "✓" : "▸";
    var text = (activity.name || "tool");
    if (detail) text += ": " + detail;
    entry.textContent = icon + " " + text;
    log.appendChild(entry);
    // Keep max 10 entries
    while (log.children.length > 10) log.removeChild(log.firstChild);
    // Update summary count
    var summary = indicator.querySelector(".activity-expand");
    if (summary) summary.textContent = "Details (" + log.children.length + " actions)";
  }

  hideActivity() {
    var indicator = document.getElementById("activity-indicator");
    if (indicator) indicator.remove();
  }

  // Streaming: create or update a live typing bubble
  renderStreamingDelta(text) {
    // Always remove activity indicator when streaming starts
    var indicator = document.getElementById("activity-indicator");
    if (indicator) indicator.remove();

    let bubble = document.getElementById("streaming-message");

    if (!bubble) {
      bubble = document.createElement("div");
      bubble.id = "streaming-message";
      bubble.classList.add("message", "agent", "streaming");
      this.container.appendChild(bubble);
    }

    // Store full streaming text for thinking extraction on finalize
    bubble.setAttribute("data-stream-text", text);

    // Phase 31: Strip canvas blocks from visible text (they render as widget regions inline)
    var displayText = text
      .replace(/```scratchy-canvas\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-toon\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-a2ui\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-tpl\s*\n[\s\S]*?```/g, '')
      .trim();
    // Also strip incomplete blocks at the end (still streaming)
    displayText = displayText.replace(/```scratchy-(canvas|toon|a2ui|tpl)\s*\n[^`]*$/, '').trim();

    // Hide bubble if only canvas ops (no visible text)
    if (!displayText) {
      bubble.style.display = 'none';
    } else {
      bubble.style.display = '';
      bubble.innerHTML = `
        <div class="message-body">${renderMedia(renderMarkdown(displayText, { streaming: true }))}</div>
        <div class="timestamp streaming-indicator">● typing...</div>
      `;
      this._addCopyButtons(bubble);
    }
    this._scrollToBottom();
  }

  // Called when final message arrives — render with full markdown + media
  finalizeStreaming(text) {
    // Clear any lingering activity indicator
    var indicator = document.getElementById("activity-indicator");
    if (indicator) indicator.remove();

    let bubble = document.getElementById("streaming-message");

    if (!bubble) {
      // No streaming bubble exists — render as a normal agent message instead
      this.renderAgentMessage(text);
      return;
    }

    // Extract thinking: whatever was in streaming but not in the final response
    var thinkingHtml = "";
    var streamText = bubble.getAttribute("data-stream-text") || "";
    var thinking = this._extractThinking(streamText, text);
    if (thinking) {
      thinkingHtml = '<details class="sui-thinking"><summary>💭 Show reasoning</summary>' +
        '<div class="sui-thinking-body">' + renderMarkdown(thinking) + '</div></details>';
    }

    // Phase 31: Strip canvas blocks from visible text
    var finalDisplayText = text
      .replace(/```scratchy-canvas\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-toon\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-a2ui\s*\n[\s\S]*?```/g, '')
      .replace(/```scratchy-tpl\s*\n[\s\S]*?```/g, '')
      .trim();

    bubble.setAttribute("data-raw-text", text);
    bubble.innerHTML = `
      ${thinkingHtml}
      <div class="message-body">${renderMedia(renderMarkdown(finalDisplayText || text))}</div>
      <div class="message-actions">
        <button class="tts-btn" title="Listen">🔊</button>
      </div>
      <div class="timestamp">${this._formatTime()}</div>
    `;
    bubble.classList.remove("streaming");
    bubble.removeAttribute("id");
    bubble.removeAttribute("data-stream-text");
    this._addCopyButtons(bubble);
    this._addCollapsible(bubble, { forceExpand: true });
    this._highlightCode(bubble);
    this._initVideos(bubble);
    this._attachDeleteHandler(bubble);
    this._attachTtsHandler(bubble);

    // Auto-speech: finalize real-time TTS or fall back to full-message TTS
    if (SCRATCHY_AUTO_SPEECH && typeof isRealtimeTTSActive === "function" && isRealtimeTTSActive()) {
      // Finalize real-time TTS with remaining text
      if (typeof finalizeRealtimeTTS === "function") {
        var plainText = _extractSpeakableText(text);
        finalizeRealtimeTTS(plainText);
      }
    } else if (SCRATCHY_AUTO_SPEECH && typeof playStreamingTTS === "function") {
      // Fallback: play full message TTS (non-streaming path)
      var plainText = _extractSpeakableText(text);
      if (plainText && plainText.length > 0 && plainText.length < 500) {
        setTimeout(function() { playStreamingTTS(plainText); }, 200);
      }
    }

    // Ensure finalized bubble is the last message (fixes ordering bug)
    if (bubble.nextElementSibling && bubble.nextElementSibling.classList.contains("message")) {
      this.container.appendChild(bubble);
    }
    this._scrollToBottom();
  }

  // Extract thinking content by comparing streaming text with final text
  _extractThinking(streamText, finalText) {
    if (!streamText || !finalText) return null;
    // Trim both for comparison
    var st = streamText.trim();
    var ft = finalText.trim();
    // If streaming had more content and ends with the final text, the prefix is thinking
    if (st.length > ft.length + 20 && st.endsWith(ft)) {
      return st.slice(0, st.length - ft.length).trim();
    }
    // If final text appears somewhere in the stream, everything before it is thinking
    var idx = st.lastIndexOf(ft);
    if (idx > 20) {
      return st.slice(0, idx).trim();
    }
    return null;
  }

  renderSystemMessage(text) {
    const div = document.createElement("div");
    div.classList.add("message", "system");
    div.innerHTML = `
      <span class="system-text">${this._escapeHtml(text)}</span>
    `;
    this.container.appendChild(div);
    this._scrollToBottom();
  }

  // Show a discrete compaction marker at the top of history
  renderCompactionMarker(dateStr) {
    const div = document.createElement("div");
    div.classList.add("compaction-marker");
    const label = dateStr
      ? "older messages compacted · " + dateStr
      : "older messages compacted";
    div.innerHTML = `<span class="compaction-line"></span><span class="compaction-label">${label}</span><span class="compaction-line"></span>`;
    // Insert at the top of the container
    if (this.container.firstChild) {
      this.container.insertBefore(div, this.container.firstChild);
    } else {
      this.container.appendChild(div);
    }
  }

  clearWelcome() {
    const welcomeEl = this.container.querySelector(".welcome-message");
    if (welcomeEl) {
      welcomeEl.remove();
    }
  }

  // Collapse long messages with a "See more" button
  // Options: { forceExpand: true } to keep the message unfolded (used for last message)
  _addCollapsible(el, opts) {
    var body = el.querySelector(".message-body");
    if (!body) return;

    // Prevent duplicate buttons
    var existingBtn = el.querySelector(".see-more-btn");
    if (existingBtn) existingBtn.remove();
    body.classList.remove("collapsed");
    body.style.maxHeight = "";

    var forceExpand = opts && opts.forceExpand;

    // Wait for render to measure height
    requestAnimationFrame(function() {
      var MAX_HEIGHT = 300; // px threshold
      if (body.scrollHeight <= MAX_HEIGHT) return;

      // If forceExpand, don't collapse — just add the button in expanded state
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

      // Insert button after message-body, before timestamp
      var timestamp = el.querySelector(".timestamp");
      if (timestamp) {
        el.insertBefore(btn, timestamp);
      } else {
        el.appendChild(btn);
      }
    });
  }

  // Add copy buttons to all <pre> code blocks in an element
  _addCopyButtons(el) {
    var pres = el.querySelectorAll("pre");
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      // Skip if already has a copy button
      if (pre.querySelector(".code-copy-btn")) continue;
      // Wrap in a container for positioning
      var wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      // Add copy button
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
            setTimeout(function() {
              targetBtn.textContent = "Copy";
              targetBtn.classList.remove("copied");
            }, 2000);
          });
        };
      })(pre, btn));
      wrapper.appendChild(btn);
    }
  }

  // Wire up video error handling + blur on play + download button (retro-compatible)
  _initVideos(el) {
    var videos = el.querySelectorAll("video.sui-video-player");
    var dlIcon = '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    for (var i = 0; i < videos.length; i++) {
      (function(v) {
        var parent = v.parentNode;
        var errEl = parent.querySelector(".sui-video-error") ||
                    parent.parentNode.querySelector(".sui-video-error");
        // Show error fallback if source fails
        var src = v.querySelector("source");
        if (src) {
          src.addEventListener("error", function() {
            v.style.display = "none";
            if (errEl) errEl.style.display = "flex";
          });
        }
        // Blur video after play starts so it doesn't steal keyboard
        v.addEventListener("play", function() {
          setTimeout(function() { v.blur(); }, 50);
        });
        v.addEventListener("pause", function() {
          setTimeout(function() { v.blur(); }, 50);
        });

        // Upgrade existing download buttons to share on mobile
        var existingDl = parent.querySelector(".sui-video-dl");
        if (existingDl && typeof navigator.share === "function" && !existingDl._shareWired) {
          existingDl._shareWired = true;
          var dlSrc = existingDl.getAttribute("href");
          if (dlSrc && dlSrc !== "#") {
            existingDl.removeAttribute("download");
            existingDl.addEventListener("click", (function(url) {
              return function(e) {
                e.preventDefault();
                e.stopPropagation();
                fetch(url)
                  .then(function(r) { return r.blob(); })
                  .then(function(blob) {
                    var filename = url.split("/").pop() || "video.mp4";
                    var file = new File([blob], filename, { type: blob.type || "video/mp4" });
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                      return navigator.share({ files: [file], title: filename });
                    } else {
                      return navigator.share({ url: url, title: filename });
                    }
                  })
                  .catch(function() {
                    navigator.share({ url: url }).catch(function() {});
                  });
              };
            })(dlSrc));
          }
        }

        // Retro-compatible: add download/share button if missing
        if (!parent.querySelector(".sui-video-dl")) {
          var videoSrc = (src && src.getAttribute("src")) || v.getAttribute("src") || "";
          if (videoSrc) {
            // Ensure parent is a .sui-video-wrap (retro: old videos may not have the wrapper)
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

            // On mobile with Web Share API: use native share sheet (stays in-app)
            // On desktop: use <a download> (triggers save dialog)
            var canShare = typeof navigator.share === "function";
            if (canShare) {
              btn.href = "#";
              btn.addEventListener("click", (function(url) {
                return function(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  // Try sharing as file first, fall back to URL share
                  fetch(url)
                    .then(function(r) { return r.blob(); })
                    .then(function(blob) {
                      var filename = url.split("/").pop() || "video.mp4";
                      var file = new File([blob], filename, { type: blob.type || "video/mp4" });
                      if (navigator.canShare && navigator.canShare({ files: [file] })) {
                        return navigator.share({ files: [file], title: filename });
                      } else {
                        return navigator.share({ url: url, title: filename });
                      }
                    })
                    .catch(function() {
                      // Fallback: share URL only
                      navigator.share({ url: url }).catch(function() {});
                    });
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
  }

  // Syntax highlighting via Prism.js
  _highlightCode(el) {
    if (typeof Prism === "undefined") return;
    var blocks = el.querySelectorAll("pre code[class*='language-']");
    for (var i = 0; i < blocks.length; i++) {
      Prism.highlightElement(blocks[i]);
    }
  }

  _escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  _formatTime() {
    return new Date().toLocaleTimeString([], { 
      hour: "2-digit", 
      minute: "2-digit" 
    });
  }

  _scrollToBottom() {
    // Hydrate any live component placeholders in new messages
    if (typeof hydrateLiveComponents === "function") {
      hydrateLiveComponents(this.container);
    }
    if (!this._autoScroll) return;
    // Use lastElementChild to avoid flex overshoot with scrollHeight
    var last = this.container.lastElementChild;
    if (last) {
      last.scrollIntoView({ block: "end", behavior: "auto" });
    } else {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }
}
