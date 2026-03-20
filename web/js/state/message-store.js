// ============================================
// Scratchy — MessageStore (Refactored)
// ============================================
// Single source of truth for all chat messages.
// IIFE pattern — exposes window.ScratchyMessageStore
//
// New features over original:
//   - Client-side UUIDs for every message
//   - Message status tracking: sending → sent → delivered
//   - Optimistic UI: addOptimistic(msg) / confirmSent(uuid)
//   - Specific onAdd / onUpdate listeners
//   - ScratchyBus event emission

(function() {
  "use strict";

  // ── UUID generator (v4-like, no crypto dependency) ──
  function generateUUID() {
    var d = Date.now();
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      d += performance.now();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
      var r = (d + Math.random() * 16) % 16 | 0;
      d = Math.floor(d / 16);
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ── Bus helper ──
  function emitBus(eventName, detail) {
    if (window.ScratchyBus && typeof window.ScratchyBus.emit === "function") {
      window.ScratchyBus.emit(eventName, detail);
    }
  }

  function MessageStore() {
    this.messages = [];
    this._hashIndex = new Map();
    this._idIndex = new Map();
    this._uuidIndex = new Map();
    this._seqCounter = 0;
    this._listeners = [];
    this._addListeners = [];
    this._updateListeners = [];
    this._sessionKey = null;
    this._cachePersistTimer = null;
  }

  MessageStore.prototype = {

    // ── Core: Add or update a message ──
    ingest: function(msg) {
      if (msg.sessionKey && this._sessionKey && msg.sessionKey !== this._sessionKey) return null;

      if (!msg.contentHash) {
        msg.contentHash = this._hash(this._normalize(msg.text || ""));
      }

      // Time-based dedup for assistant messages
      if (msg.role === "assistant" && !msg.streaming && this.messages.length > 0) {
        var last = this.messages[this.messages.length - 1];
        if (last.role === "assistant" && !last.streaming) {
          var lastNorm = this._normalize(last.text || "");
          var thisNorm = this._normalize(msg.text || "");
          if (lastNorm.slice(0, 150) === thisNorm.slice(0, 150) && lastNorm.length > 10) {
            var timeDiff = Date.now() - (last._ingestTime || 0);
            if (timeDiff < 3000) {
              console.log("[MessageStore] Time-based dedup: suppressed near-duplicate (" + timeDiff + "ms)");
              return last;
            }
          }
        }
      }

      // Dedup by hash+role → update existing
      var existing = this._hashIndex.get(msg.contentHash);
      if (existing && existing.role === msg.role) {
        var changed = false;
        if (msg.status && msg.status !== existing.status) {
          existing.status = msg.status;
          changed = true;
        }
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
        if (msg.source && msg.source !== existing.source && !existing.streaming) {
          existing.source = msg.source;
          changed = true;
        }
        if (changed) {
          this._notify("update", existing);
          this._notifyUpdate(existing);
          emitBus("store:message:update", existing);
        }
        return existing;
      }

      // Assign seq
      if (msg.seq == null) {
        msg.seq = this._nextSeq();
      } else {
        if (msg.seq >= this._seqCounter) this._seqCounter = msg.seq + 1;
      }

      // Assign ID if missing
      if (!msg.id) {
        msg.id = "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      }

      // Assign UUID (client-side, always unique)
      if (!msg.uuid) {
        msg.uuid = generateUUID();
      }

      // Defaults
      if (!msg.role) msg.role = "user";
      if (!msg.source) msg.source = "unknown";
      if (!msg.status) msg.status = null;
      if (msg.streaming === undefined) msg.streaming = false;
      if (!msg.images) msg.images = null;
      if (!msg.fileAttachments) msg.fileAttachments = null;
      msg.el = null;
      msg._ingestTime = Date.now();

      // Insert at correct position
      var idx = this._findInsertIndex(msg.seq);
      this.messages.splice(idx, 0, msg);
      this._hashIndex.set(msg.contentHash, msg);
      this._idIndex.set(msg.id, msg);
      this._uuidIndex.set(msg.uuid, msg);

      this._notify("insert", msg, idx);
      this._notifyAdd(msg);
      emitBus("store:message:add", msg);

      // Debounced persist
      if (!msg.streaming) {
        if (this._cachePersistTimer) clearTimeout(this._cachePersistTimer);
        var self = this;
        this._cachePersistTimer = setTimeout(function() { self.persistToCache(); }, 2000);
      }

      return msg;
    },

    // ── Optimistic UI: add a message with "sending" status, returns UUID ──
    addOptimistic: function(msg) {
      msg.uuid = generateUUID();
      msg.status = "sending";
      msg.source = msg.source || "local";
      this.ingest(msg);
      return msg.uuid;
    },

    // ── Confirm a message was sent (by UUID) ──
    confirmSent: function(uuid) {
      var msg = this._uuidIndex.get(uuid);
      if (msg) {
        msg.status = "sent";
        this._notify("update", msg);
        this._notifyUpdate(msg);
        emitBus("store:message:update", msg);
      }
      return msg || null;
    },

    // ── Mark delivered ──
    markDelivered: function(uuid) {
      var msg = this._uuidIndex.get(uuid);
      if (msg) {
        msg.status = "delivered";
        this._notify("update", msg);
        this._notifyUpdate(msg);
        emitBus("store:message:update", msg);
      }
      return msg || null;
    },

    // ── Bulk load (history) ──
    loadHistory: function(historyMessages) {
      this.clear();
      for (var i = 0; i < historyMessages.length; i++) {
        var m = historyMessages[i];
        m.seq = i;
        m.source = m.source || "history";
        this.ingest(m);
      }
      this._seqCounter = historyMessages.length;
      this._notify("reset");
      emitBus("store:messages:loaded", { count: historyMessages.length });
      this.persistToCache();
    },

    // ── Session switch ──
    switchSession: function(sessionKey) {
      this._sessionKey = sessionKey;
      this.clear();
    },

    // ── Clear all ──
    clear: function() {
      this.messages = [];
      this._hashIndex.clear();
      this._idIndex.clear();
      this._uuidIndex.clear();
      this._notify("reset");
    },

    // ── Update status by id ──
    updateStatus: function(id, status) {
      var msg = this._idIndex.get(id);
      if (msg) {
        msg.status = status;
        this._notify("update", msg);
        this._notifyUpdate(msg);
        emitBus("store:message:update", msg);
      }
    },

    // ── Finalize streaming ──
    finalizeStreaming: function(text) {
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
          this._notifyUpdate(streaming);
          emitBus("store:message:update", streaming);
          return streaming;
        }
      }
      return null;
    },

    // ── Update streaming delta ──
    updateStreaming: function(text) {
      for (var i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].streaming) {
          this.messages[i].text = text;
          this._notify("streaming-delta", this.messages[i]);
          return this.messages[i];
        }
      }
      return null;
    },

    // ── Getters ──
    getById: function(id) { return this._idIndex.get(id) || null; },
    getByUUID: function(uuid) { return this._uuidIndex.get(uuid) || null; },
    getAll: function() { return this.messages.slice(); },

    // ── Listeners ──
    onChange: function(fn) { this._listeners.push(fn); },
    onAdd: function(fn) { this._addListeners.push(fn); },
    onUpdate: function(fn) { this._updateListeners.push(fn); },

    // ── Persist / Load cache ──
    persistToCache: function() {
      try {
        var toCache = [];
        for (var i = Math.max(0, this.messages.length - 50); i < this.messages.length; i++) {
          var m = this.messages[i];
          if (m.streaming) continue;
          toCache.push({
            role: m.role, text: m.text, timestamp: m.timestamp,
            source: m.source, seq: m.seq, contentHash: m.contentHash,
            uuid: m.uuid, status: m.status
          });
        }
        localStorage.setItem(this._cacheKey(), JSON.stringify(toCache));
      } catch(e) {}
    },

    loadFromCache: function() {
      try {
        var raw = localStorage.getItem(this._cacheKey());
        if (!raw) return null;
        var msgs = JSON.parse(raw);
        if (!Array.isArray(msgs) || msgs.length === 0) return null;
        return msgs;
      } catch(e) { return null; }
    },

    // Aliases for backward compat
    persist: function() { this.persistToCache(); },
    load: function() { return this.loadFromCache(); },

    // ── Internals ──
    _cacheKey: function() {
      return "scratchy_msgcache_" + (this._sessionKey || "default");
    },
    _nextSeq: function() { return this._seqCounter++; },
    _findInsertIndex: function(seq) {
      var lo = 0, hi = this.messages.length;
      while (lo < hi) {
        var mid = (lo + hi) >>> 1;
        if (this.messages[mid].seq <= seq) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    _normalize: function(text) {
      if (!text) return "";
      return text
        .replace(/\[ProteClaw Canary\][^\n]*/g, "")
        .replace(/\n?\[message_id:[^\]]*\]/g, "")
        .replace(/\n?\[genui:\w+\]/g, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/\s+/g, " ")
        .trim().slice(0, 500).toLowerCase();
    },
    _hash: function(str) {
      var hash = 5381;
      for (var i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
      }
      return hash.toString(36);
    },
    _notify: function(type, msg, idx) {
      for (var i = 0; i < this._listeners.length; i++) {
        this._listeners[i](type, msg, idx);
      }
    },
    _notifyAdd: function(msg) {
      for (var i = 0; i < this._addListeners.length; i++) {
        this._addListeners[i](msg);
      }
    },
    _notifyUpdate: function(msg) {
      for (var i = 0; i < this._updateListeners.length; i++) {
        this._updateListeners[i](msg);
      }
    }
  };

  // Expose globally
  window.ScratchyMessageStore = MessageStore;

  // Backward compat: also expose as MessageStore if not already taken
  if (!window.MessageStore) {
    window.MessageStore = MessageStore;
  }

})();
