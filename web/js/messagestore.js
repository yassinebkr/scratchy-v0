// ============================================
// Scratchy — MessageStore + DOMSync
// ============================================
// Single source of truth for all chat messages.
// Replaces 9 scattered render paths with one ordered store.
// Fixes: message overlap, ordering bugs, duplicates, multi-device sync.

class MessageStore {
  constructor() {
    this.messages = [];           // Sorted by seq
    this._hashIndex = new Map();  // contentHash → message (dedup)
    this._idIndex = new Map();    // id → message (lookup)
    this._seqCounter = 0;         // Monotonic counter
    this._listeners = [];          // onChange callbacks
    this._sessionKey = null;       // Current session (guards stale data)
  }

  // ── Core: Add or update a message ──
  ingest(msg) {
    // 1. Reject if wrong session
    if (msg.sessionKey && this._sessionKey && msg.sessionKey !== this._sessionKey) return null;

    // 2. Generate contentHash if missing
    if (!msg.contentHash) {
      msg.contentHash = this._hash(this._normalize(msg.text || ""));
    }

    // 3a. Time-based dedup: reject assistant messages too similar to last one within 3s
    if (msg.role === "assistant" && !msg.streaming && this.messages.length > 0) {
      var last = this.messages[this.messages.length - 1];
      if (last.role === "assistant" && !last.streaming) {
        var lastNorm = this._normalize(last.text || "");
        var thisNorm = this._normalize(msg.text || "");
        // If normalized text starts the same (first 150 chars) and arrived within 3s
        if (lastNorm.slice(0, 150) === thisNorm.slice(0, 150) && lastNorm.length > 10) {
          var timeDiff = Date.now() - (last._ingestTime || 0);
          if (timeDiff < 3000) {
            console.log("[MessageStore] Time-based dedup: suppressed near-duplicate assistant message (" + timeDiff + "ms)");
            return last;
          }
        }
      }
    }

    // 3. Dedup: if contentHash exists AND same role, update instead of insert
    var existing = this._hashIndex.get(msg.contentHash);
    if (existing && existing.role === msg.role) {
      var changed = false;
      // Update status (e.g. "sending" → "sent")
      if (msg.status && msg.status !== existing.status) {
        existing.status = msg.status;
        changed = true;
      }
      // Finalize streaming
      if (msg.streaming === false && existing.streaming === true) {
        existing.streaming = false;
        existing.text = msg.text;
        var newHash = this._hash(this._normalize(msg.text || ""));
        if (newHash !== existing.contentHash) {
          this._hashIndex.delete(existing.contentHash);
          existing.contentHash = newHash;
          this._hashIndex.set(newHash, existing);
        }
        changed = true;
      }
      // Update source if upgrading (e.g. "local" → "gateway")
      if (msg.source && msg.source !== existing.source && !existing.streaming) {
        existing.source = msg.source;
        changed = true;
      }
      if (changed) this._notify("update", existing);
      return existing;
    }

    // 4. Assign seq if missing
    if (msg.seq == null) {
      msg.seq = this._nextSeq();
    } else {
      // External seq (from history) — update counter to stay ahead
      if (msg.seq >= this._seqCounter) {
        this._seqCounter = msg.seq + 1;
      }
    }

    // 5. Assign ID if missing
    if (!msg.id) {
      msg.id = "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    }

    // 6. Default fields
    if (!msg.role) msg.role = "user";
    if (!msg.source) msg.source = "unknown";
    if (!msg.status) msg.status = null;
    if (msg.streaming === undefined) msg.streaming = false;
    if (!msg.images) msg.images = null;
    if (!msg.fileAttachments) msg.fileAttachments = null;
    msg.el = null;
    msg._ingestTime = Date.now();

    // 7. Insert at correct position (binary search by seq)
    var idx = this._findInsertIndex(msg.seq);
    this.messages.splice(idx, 0, msg);
    this._hashIndex.set(msg.contentHash, msg);
    this._idIndex.set(msg.id, msg);

    // 8. Notify renderer
    this._notify("insert", msg, idx);

    // 9. Debounced cache persist (don't thrash localStorage during streaming)
    if (!msg.streaming) {
      if (this._cachePersistTimer) clearTimeout(this._cachePersistTimer);
      var self = this;
      this._cachePersistTimer = setTimeout(function() { self.persistToCache(); }, 2000);
    }

    return msg;
  }

  // ── Bulk load (history) — replaces all messages ──
  loadHistory(historyMessages) {
    this.clear();
    for (var i = 0; i < historyMessages.length; i++) {
      var m = historyMessages[i];
      m.seq = i;
      m.source = m.source || "history";
      this.ingest(m);
    }
    this._seqCounter = historyMessages.length;
    this._notify("reset");
    this.persistToCache();
  }

  // ── Session switch ──
  switchSession(sessionKey) {
    this._sessionKey = sessionKey;
    this.clear();
  }

  // ── Clear all ──
  clear() {
    this.messages = [];
    this._hashIndex.clear();
    this._idIndex.clear();
    // Don't reset _seqCounter — live messages may arrive during clear
    this._notify("reset");
  }

  // ── Update message status (sending → sent → failed) ──
  updateStatus(id, status) {
    var msg = this._idIndex.get(id);
    if (msg) {
      msg.status = status;
      this._notify("update", msg);
    }
  }

  // ── Finalize streaming message ──
  finalizeStreaming(text) {
    // Find the current streaming message
    for (var i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].streaming) {
        var streaming = this.messages[i];
        streaming.streaming = false;
        streaming.text = text;
        var newHash = this._hash(this._normalize(text || ""));
        this._hashIndex.delete(streaming.contentHash);
        streaming.contentHash = newHash;
        this._hashIndex.set(newHash, streaming);
        this._notify("finalize", streaming);
        return streaming;
      }
    }
    return null;
  }

  // ── Update streaming text (delta) ──
  updateStreaming(text) {
    for (var i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].streaming) {
        this.messages[i].text = text;
        this._notify("streaming-delta", this.messages[i]);
        return this.messages[i];
      }
    }
    return null;
  }

  // ── Get by id ──
  getById(id) {
    return this._idIndex.get(id) || null;
  }

  // ── Internals ──

  _nextSeq() {
    return this._seqCounter++;
  }

  _findInsertIndex(seq) {
    // Binary search: find first message with seq > target
    var lo = 0, hi = this.messages.length;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (this.messages[mid].seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _normalize(text) {
    if (!text) return "";
    return text
      .replace(/\[SecurityPlugin Canary\][^\n]*/g, "")
      .replace(/\[SecurityPlugin Memory\] Auto-recalled[\s\S]*?(?=\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s|\[message_id:|$)/g, "") // strip system metadata
      .replace(/\n?\[message_id:[^\]]*\]/g, "")
      .replace(/\n?\[genui:\w+\]/g, "")
      .replace(/```[\s\S]*?```/g, "") // strip code blocks for stable hashing
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500)
      .toLowerCase();
  }

  _hash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(36);
  }

  _notify(type, msg, idx) {
    for (var i = 0; i < this._listeners.length; i++) {
      this._listeners[i](type, msg, idx);
    }
  }

  onChange(fn) {
    this._listeners.push(fn);
  }

  // ── localStorage message cache for instant load ──
  _cacheKey() {
    return "scratchy_msgcache_" + (this._sessionKey || "default");
  }

  // Persist last N messages to localStorage (lightweight snapshot)
  persistToCache() {
    try {
      var toCache = [];
      // Keep last 50 non-streaming messages
      for (var i = Math.max(0, this.messages.length - 50); i < this.messages.length; i++) {
        var m = this.messages[i];
        if (m.streaming) continue;
        toCache.push({
          role: m.role,
          text: m.text,
          timestamp: m.timestamp,
          source: m.source,
          seq: m.seq,
          contentHash: m.contentHash
        });
      }
      localStorage.setItem(this._cacheKey(), JSON.stringify(toCache));
    } catch(e) {} // localStorage full
  }

  // Load cached messages — returns array or null
  loadFromCache() {
    try {
      var raw = localStorage.getItem(this._cacheKey());
      if (!raw) return null;
      var msgs = JSON.parse(raw);
      if (!Array.isArray(msgs) || msgs.length === 0) return null;
      return msgs;
    } catch(e) { return null; }
  }
}


// ============================================
// DOMSync — Keeps the DOM in sync with MessageStore
// ============================================

class DOMSync {
  constructor(store, container, messageRenderer) {
    this.store = store;
    this.container = container;
    this.renderer = messageRenderer;

    var self = this;

    store.onChange(function(type, msg, idx) {
      switch (type) {
        case "insert":          self._onInsert(msg, idx); break;
        case "update":          self._onUpdate(msg); break;
        case "finalize":        self._onFinalize(msg); break;
        case "streaming-delta": self._onStreamingDelta(msg); break;
        case "reset":           self._onReset(); break;
      }
    });
  }

  _onInsert(msg, idx) {
    // Create DOM element
    var el = this.renderer.createElement(msg);
    msg.el = el;

    // Insert at correct DOM position (before activity indicator)
    var children = this.container.querySelectorAll(".message:not(.activity):not(.system), .compaction-marker");
    var activityEl = document.getElementById("activity-indicator");

    if (idx >= children.length) {
      // Append (most common case — new messages)
      if (activityEl && activityEl.parentNode === this.container) {
        this.container.insertBefore(el, activityEl);
      } else {
        this.container.appendChild(el);
      }
    } else {
      // Insert before the element at idx (rare — out-of-order correction)
      this.container.insertBefore(el, children[idx]);
    }

    if (this.renderer._autoScroll) this.renderer._scrollToBottom();
  }

  _onUpdate(msg) {
    if (!msg.el) return;

    // Update status badge
    this._updateStatusBadge(msg);

    // Re-render body if text changed (non-streaming)
    if (!msg.streaming) {
      var body = msg.el.querySelector(".message-body");
      if (body && msg.text) {
        var clean = this._cleanText(msg.text);
        if (msg.role === "assistant") {
          body.innerHTML = renderMedia(renderMarkdown(clean));
        } else {
          body.innerHTML = renderMarkdown(clean);
        }
        this.renderer._addCopyButtons(msg.el);
        this.renderer._addCollapsible(msg.el);
        this.renderer._highlightCode(msg.el);
      }
    }
  }

  _onFinalize(msg) {
    if (!msg.el) return;
    // Clear any pending streaming render timer
    if (this._streamRenderTimer) { clearTimeout(this._streamRenderTimer); this._streamRenderTimer = null; }
    this._lastStreamRender = 0;

    var text = msg.text || "";
    var clean = this._cleanText(text);

    // Extract thinking from streamed text
    var thinkingHtml = "";
    var streamText = msg.el.getAttribute("data-stream-text") || "";
    var thinking = this.renderer._extractThinking(streamText, text);
    if (thinking) {
      thinkingHtml = '<details class="sui-thinking"><summary>💭 Show reasoning</summary>' +
        '<div class="sui-thinking-body">' + renderMarkdown(thinking) + '</div></details>';
    }

    // Update element
    msg.el.setAttribute("data-raw-text", clean);
    msg.el.innerHTML =
      thinkingHtml +
      '<div class="message-body">' + renderMedia(renderMarkdown(text)) + '</div>' +
      '<div class="message-actions"><button class="tts-btn" title="Listen">🔊</button></div>' +
      '<div class="timestamp">' + this.renderer._formatTime() + '</div>';

    msg.el.classList.remove("streaming");
    msg.el.removeAttribute("id");
    msg.el.removeAttribute("data-stream-text");

    // Post-processing
    this.renderer._addCopyButtons(msg.el);
    this.renderer._addCollapsible(msg.el);
    this.renderer._highlightCode(msg.el);
    this.renderer._initVideos(msg.el);
    this.renderer._attachDeleteHandler(msg.el);
    this.renderer._attachTtsHandler(msg.el);

    // Auto-speech for short replies
    if (SCRATCHY_AUTO_SPEECH && text.length < 500) {
      var ttsBtn = msg.el.querySelector(".tts-btn");
      if (ttsBtn) {
        setTimeout(function() { ttsBtn.click(); }, 300);
      }
    }

    if (this.renderer._autoScroll) this.renderer._scrollToBottom();
  }

  _onStreamingDelta(msg) {
    if (!msg.el) return;

    var text = msg.text || "";
    msg.el.setAttribute("data-stream-text", text);

    // Throttle: only re-render at most every 80ms to avoid stack overflow
    // from renderMarkdown regex on every single delta token
    var now = Date.now();
    if (!this._lastStreamRender) this._lastStreamRender = 0;

    if (now - this._lastStreamRender < 80) {
      // Schedule a trailing render so we don't miss the last delta
      if (!this._streamRenderTimer) {
        var self = this;
        this._streamRenderTimer = setTimeout(function() {
          self._streamRenderTimer = null;
          self._renderStreamFrame(msg);
        }, 80);
      }
      return;
    }
    this._renderStreamFrame(msg);
  }

  _renderStreamFrame(msg) {
    if (!msg.el) return;
    var text = msg.text || "";
    this._lastStreamRender = Date.now();

    // Light renderer during streaming: escape HTML + minimal formatting only
    // Full renderMarkdown runs on finalize (chat final) — avoids regex backtracking
    var html = this._streamingHtml(text);

    msg.el.innerHTML =
      '<div class="message-body">' + html + '</div>' +
      '<div class="timestamp streaming-indicator">● typing...</div>';
    if (this.renderer._autoScroll) this.renderer._scrollToBottom();
  }

  _streamingHtml(text) {
    // Lightweight streaming renderer — no complex regex, no tables, no lists
    // Just: escape HTML, bold, inline code, code block placeholder, links
    var h = escapeHtmlForMd(text);

    // Hide incomplete code blocks (trailing ```)
    h = h.replace(/```([\w-]*)[\s\S]*$/g, function(m, lang) {
      if (lang === 'scratchy-canvas' || lang === 'scratchy-a2ui' || lang === 'scratchy-toon' || lang === 'scratchy-tpl') {
        // Canvas ops render incrementally in widget regions — no loading indicator needed
        return '';
      }
      return '<div class="sui-loading">✨ rendering...</div>';
    });

    // Complete code blocks — hide all scratchy-* blocks entirely
    // Closing ``` must follow a newline (on its own line) to avoid matching ``` inside code content
    h = h.replace(/```(\w[\w-]*)\s*\n([\s\S]*?)\n```/g, function(m, lang, code) {
      if (lang === 'scratchy-canvas' || lang === 'scratchy-toon' || lang === 'scratchy-tpl' || lang === 'scratchy-a2ui') return '';
      return '<div class="sui-code"><div class="sui-code-header"><span class="sui-code-lang">' + lang + '</span></div><pre><code>' + code.trim() + '</code></pre></div>';
    });
    h = h.replace(/```\s*\n([\s\S]*?)\n```/g, '<div class="sui-code"><pre><code>$1</code></pre></div>');

    // Inline code
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Links — allow optional whitespace between ] and (
    h = h.replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    return h;
  }

  _onReset() {
    // Clear all message elements from DOM (but preserve welcome, etc.)
    var messages = this.container.querySelectorAll(".message:not(.activity), .compaction-marker");
    for (var i = 0; i < messages.length; i++) {
      messages[i].remove();
    }
    // Re-render all messages from store
    for (var j = 0; j < this.store.messages.length; j++) {
      this._onInsert(this.store.messages[j], j);
    }
  }

  _updateStatusBadge(msg) {
    if (!msg.el || !msg.status) return;
    var ts = msg.el.querySelector(".timestamp");
    if (!ts) return;

    // Remove existing badge
    var badge = ts.querySelector(".queued-badge, .status-badge");
    if (badge) badge.remove();

    if (msg.status === "queued") {
      var b = document.createElement("span");
      b.className = "queued-badge";
      b.textContent = "📤 queued";
      ts.appendChild(b);
    } else if (msg.status === "sent") {
      var existing = ts.querySelector(".queued-badge");
      if (existing) {
        existing.textContent = "✓ sent";
        existing.classList.add("sent");
        setTimeout(function() {
          existing.style.transition = "opacity 0.5s";
          existing.style.opacity = "0";
          setTimeout(function() { existing.remove(); }, 500);
        }, 2000);
      }
    } else if (msg.status === "failed") {
      var fb = document.createElement("span");
      fb.className = "status-badge failed";
      fb.textContent = "⚠️ failed";
      ts.appendChild(fb);
    }
  }

  _cleanText(text) {
    return (text || "")
      .replace(/\[SecurityPlugin Memory\] Auto-recalled[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |$)/g, "")
      .replace(/\[SecurityPlugin Canary\][^\n]*/g, "")
      .replace(/\n?\[message_id:[^\]]*\]/g, "")
      .replace(/\n?\[genui:\w+\]/g, "")
      .replace(/^\s*\n/gm, "")
      .trim();
  }
}
