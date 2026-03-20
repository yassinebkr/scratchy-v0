// Scratchy — WebSocket Connection
//
// Manages the WebSocket connection to the OpenClaw gateway.
// Handles protocol handshake, message framing, streaming,
// auto-reconnect, and chat history loading.

class ScratchyConnection {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.handshakeComplete = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.reconnectDelay = 1000; // ms (base for exponential backoff)
    this.messageIdCounter = 0;
    this.sessionKey = window.__SCRATCHY_SESSION_KEY || "agent:main:main";
    this.pendingRequests = {}; // Maps request id → callback function

    // Message status tracking
    this._msgIdCounter = 0;
    this._OFFLINE_QUEUE_MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours in ms
    this._MAX_RETRIES = 3;

    // Session continuity — persistent clientId + event sequence tracking
    this._clientId = this._loadOrCreateClientId();
    this._lastSeq = parseInt(sessionStorage.getItem("scratchy_lastSeq") || "0", 10);
    this._isReplaying = false;  // True during event replay after reconnect
    this._resumed = false;      // True if this connection resumed an existing session

    // Offline message queue — persistent via localStorage
    this._offlineQueue = this._loadOfflineQueue();
    this._lastSeenMessageTs = null; // Track last message timestamp for catch-up
    this._healthCheckTimer = null; // For zombie socket detection
    this._healthCheckCallback = null; // Resolves when health check response arrives
    this._lastSentAt = 0; // Timestamp of last message we sent (for sync detection)
    this._currentRunId = null; // Track active run for lifecycle synthesis
    this._runEndTimer = null;  // Fallback timeout to detect run end

    // Callbacks — the app will set these
    this.onMessage = null;      // Called when agent sends a final message
    this.onStreamDelta = null;  // Called with partial text as agent types (real-time)
    this.onStatusChange = null; // Called when connection status changes
    this.onAgentActivity = null; // Called with activity updates (tool use, thinking, etc.)
    this.onQueueDrained = null; // Called when offline queue finishes sending
    this.onQueueReplay = null;  // Called with message data before re-sending queued messages (for store re-ingestion)
    this.onResumeCatchUp = null; // Called after resume catch-up with missed messages
    this.onRemoteUserMessage = null; // Called when another instance sends a message
    this.onSendError = null;    // Called when a message permanently fails
    this.onMessageStatus = null; // Called with (messageId, status) for send tracking
  }

  // ------------------------------------------
  // Session continuity — clientId
  // ------------------------------------------
  _loadOrCreateClientId() {
    var id = sessionStorage.getItem("scratchy_clientId");
    if (!id) {
      id = "sc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("scratchy_clientId", id);
    }
    return id;
  }

  _persistLastSeq() {
    try { sessionStorage.setItem("scratchy_lastSeq", String(this._lastSeq)); } catch(e) {}
  }

  // ------------------------------------------
  // Offline Queue Persistence
  // ------------------------------------------
  _storageKey() {
    return "scratchy_offline_queue:" + this.sessionKey;
  }

  _loadOfflineQueue() {
    try {
      var raw = localStorage.getItem(this._storageKey());
      if (!raw) return [];
      var queue = JSON.parse(raw);
      if (!Array.isArray(queue)) return [];
      // Expire messages older than 4 hours
      var now = Date.now();
      var maxAge = this._OFFLINE_QUEUE_MAX_AGE;
      var filtered = queue.filter(function(msg) {
        return msg.ts && (now - msg.ts) < maxAge;
      });
      if (filtered.length !== queue.length) {
        console.log("[Scratchy] Expired " + (queue.length - filtered.length) + " old queued message(s)");
      }
      if (filtered.length > 0) {
        console.log("[Scratchy] Loaded " + filtered.length + " persisted queued message(s)");
      }
      return filtered;
    } catch (e) {
      console.error("[Scratchy] Failed to load offline queue:", e);
      return [];
    }
  }

  _persistOfflineQueue() {
    try {
      localStorage.setItem(this._storageKey(), JSON.stringify(this._offlineQueue));
    } catch (e) {
      console.error("[Scratchy] Failed to persist offline queue:", e);
    }
  }

  _generateMessageId() {
    this._msgIdCounter++;
    return "msg-" + Date.now() + "-" + this._msgIdCounter;
  }

  _emitStatus(messageId, status) {
    if (this.onMessageStatus) {
      this.onMessageStatus(messageId, status);
    }
  }

  // ------------------------------------------
  // ------------------------------------------
  // OpenClaw's WebSocket isn't raw text — it uses structured JSON frames:
  //
  // Request frame:  { type: "req", id: "unique-id", method: "chat.send", params: {...} }
  // Response frame: { type: "res", id: "matching-id", ok: true/false, result: {...} }
  // Event frame:    { type: "event", event: "chat.event", data: {...} }
  //
  // Before sending any messages, you must complete a "connect" handshake
  // that tells the gateway who you are (client id, version, protocol version).
  //

  // ------------------------------------------
  // Connect to the OpenClaw gateway
  // ------------------------------------------
  connect() {
    // Clean up any existing dead socket before reconnecting
    if (this.ws) {
      try { this.ws.close(); } catch(e) {}
      this.ws = null;
    }
    this.connected = false;
    this.handshakeComplete = false;
    this._resumed = false;
    this._updateStatus("connecting");

    // Append clientId + lastSeq for session continuity
    var wsUrl = this.url;
    var sep = wsUrl.indexOf("?") >= 0 ? "&" : "?";
    wsUrl += sep + "clientId=" + encodeURIComponent(this._clientId) + "&lastSeq=" + this._lastSeq;
    // Include device ID for cross-device sync
    if (window.ScratchyDeviceSync) {
      wsUrl += "&deviceId=" + encodeURIComponent(window.ScratchyDeviceSync.getDeviceId());
    }
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      // WebSocket is open, but we need to complete the handshake first
      this._sendHandshake();
    };

    this.ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch (e) {
        console.error("[Scratchy] JSON parse error:", e.message, "len:", event.data?.length);
        return;
      }
      try {
        this._handleFrame(frame);
      } catch (e) {
        console.error("[Scratchy] Frame handling error:", e.message, "type:", frame?.type, "event:", frame?.event || frame?.frame?.event, "seq:", frame?.seq);
      }
    };

    this.ws.onerror = (error) => {
      console.error("[Scratchy] WebSocket error:", error);
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.handshakeComplete = false;
      this._stopClientKeepalive();
      // M2: Clear pending requests — they'll never get responses
      this.pendingRequests = {};
      this._updateStatus("disconnected");
      this._tryReconnect();
    };

    // Visibility change — reconnect immediately when tab comes back
    if (!this._visibilityBound) {
      this._visibilityBound = true;
      var self = this;
      document.addEventListener("visibilitychange", function() {
        if (document.visibilityState === "visible" && (!self.ws || self.ws.readyState !== WebSocket.OPEN)) {
          console.log("[Scratchy] Tab visible + WS dead → instant reconnect");
          self.reconnectAttempts = 0; // Reset backoff
          self._tryReconnect();
        }
      });
    }

    // Network online — reconnect immediately when device regains connectivity
    // Critical for mobile (train dead zones, tunnels, airplane mode toggle)
    if (!this._onlineBound) {
      this._onlineBound = true;
      var self2 = this;
      window.addEventListener("online", function() {
        console.log("[Scratchy] 📶 Network online — instant reconnect");
        self2.reconnectAttempts = 0; // Reset backoff
        if (!self2.ws || self2.ws.readyState !== WebSocket.OPEN) {
          self2._tryReconnect();
        }
      });
    }
  }

  // ------------------------------------------
  // ------------------------------------------
  // First message MUST be a connect request. The gateway will
  // reject anything else and close the connection.
  //
  _sendHandshake() {
    const connectFrame = {
      type: "req",
      id: this._nextId(),
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "webchat",
          displayName: "Scratchy",
          version: "0.1.0",
          platform: "web",
          mode: "webchat"
        },
        caps: ["tool-events"],
        role: "operator",
        ...(SCRATCHY_CONFIG.authToken ? { auth: { token: SCRATCHY_CONFIG.authToken } } : {})
      }
    };
    this.ws.send(JSON.stringify(connectFrame));
    console.log("[Scratchy] Handshake sent");
  }

  // ------------------------------------------
  // ------------------------------------------
  // Routes incoming frames based on their type
  //
  _handleFrame(frame) {
    // Cross-device sync frames — handle before anything else
    if (frame.type === "sync" && window.ScratchyDeviceSync) {
      window.ScratchyDeviceSync.handleFrame(frame);
      return;
    }

    // JSON pong from server — mark socket as alive
    if (frame.type === "pong") {
      this._pongReceived = true;
      return;
    }

    // User info from server (role, email, displayName)
    if (frame.type === "user-info" && frame.user) {
      this._userInfo = frame.user;
      if (typeof window._scratchyShowAdminIfNeeded === "function") {
        window._scratchyShowAdminIfNeeded(frame.user);
      }
      return;
    }

    // View switch signal from server (e.g. after onboarding dismiss)
    if (frame.type === "switch-view" && frame.view) {
      if (typeof window._scratchySwitchView === "function") {
        window._scratchySwitchView(frame.view);
      }
      return;
    }

    // ── Dedicated compaction event from server (bypasses seq buffering) ──
    if (frame.type === "compaction") {
      console.log("[Scratchy] Compaction event (dedicated):", frame.phase);
      // Keep staleness watchdog happy during compaction
      this._lastEventAt = Date.now();
      // Cancel run-start/end timers — compaction runs long with no deltas
      if (this._runStartTimer) { clearTimeout(this._runStartTimer); this._runStartTimer = null; }
      if (this._runEndTimer) { clearTimeout(this._runEndTimer); this._runEndTimer = null; }
      if (this.onAgentActivity) {
        this.onAgentActivity({ type: "compaction", phase: frame.phase || "start", detail: frame });
      }
      return;
    }

    // ── Session continuity: replay protocol ──
    if (frame.type === "replay_start") {
      this._isReplaying = true;
      console.log("[Scratchy] Replay started — " + frame.count + " events (seq " + frame.fromSeq + "→" + frame.toSeq + ")");
      return;
    }
    if (frame.type === "replay_end") {
      this._isReplaying = false;
      this._persistLastSeq(); // Ensure seq is saved after full replay
      console.log("[Scratchy] Replay complete — lastSeq now " + this._lastSeq);
      return;
    }

    // ── Session continuity: unwrap seq envelope ──
    // Smart proxy wraps events as { seq: N, frame: <original> }
    if (typeof frame.seq === "number" && frame.frame) {
      this._lastSeq = frame.seq;
      this._persistLastSeq();
      frame = frame.frame; // Unwrap to original frame
    }

    // Response to our requests (connect, chat.send, etc.)
    if (frame.type === "res") {
      // Check if this is the connect response
      if (!this.handshakeComplete) {
        if (frame.ok) {
          var wasReconnect = this.reconnectAttempts > 0;
          this._resumed = !!frame.payload?.resumed;
          this.handshakeComplete = true;
          this.connected = true;
          this.reconnectAttempts = 0;
          this._updateStatus("connected");
          console.log("[Scratchy] Handshake complete — connected!" +
            (wasReconnect ? " (reconnect)" : "") +
            (this._resumed ? " (resumed session, " + (frame.payload?.bufferedEvents || 0) + " buffered)" : ""));
          // Start client-side keepalive (app-level JSON ping through Cloudflare tunnel)
          this._startClientKeepalive();
          // Drain offline queue, THEN catch up history (fixes race condition
          // where history fetch returns before drained messages are processed)
          var _self = this;
          var _wasReconnect = wasReconnect;
          var _wasResumed = this._resumed;
          this._drainCallback = function() {
            _self._drainCallback = null;
            // Now safe to catch up history — drained messages have been sent
            if (_wasReconnect && !_wasResumed && _self.onReconnected) {
              // Small delay to let gateway process the drained messages
              setTimeout(function() { _self.onReconnected(); }, 500);
            }
          };
          this._drainOfflineQueue();
        } else {
          console.error("[Scratchy] Handshake failed:", frame.error);
          this.ws.close();
        }
        if (frame.type === "res" && this.pendingRequests[frame.id]) {
          this.pendingRequests[frame.id](frame);
          delete this.pendingRequests[frame.id];
        }
        return;
      }

      // Route responses to pending request callbacks
      if (this.pendingRequests[frame.id]) {
        this.pendingRequests[frame.id](frame);
        delete this.pendingRequests[frame.id];
      }
      
    }

    // Events from the gateway (agent messages, status updates, etc.)
    if (frame.type === "event") {
      this._lastEventAt = Date.now();
      try {
        this._handleEvent(frame);
      } catch (e) {
        console.error("[Scratchy] _handleEvent CRASH:", e.message, "event:", frame.event, "state:", frame.payload?.state, "stack:", e.stack?.split("\n").slice(0, 10).join(" | "));
      }
      return;
    }
    // Debug: log unhandled frame types
    if (frame.type !== "res") {
      console.log("[Scratchy] Unhandled frame type:", frame.type);
    }
  }

  // ------------------------------------------
  // ------------------------------------------
  // The gateway sends events like:
  //   { type: "event", event: "chat.event", data: { kind: "text", text: "..." } }
  //   { type: "event", event: "chat.event", data: { kind: "agent.done" } }
  //
  // For now, just handle "chat.event" where data.kind === "text"
  // and pass data.text to this.onMessage
  //
  //
  _handleEvent(frame) {
    // Event handling

    // Canvas state push from server
    if (frame.event === "canvas-update" && frame.payload) {
      if (this.onCanvasUpdate) this.onCanvasUpdate(frame.payload);
      return;
    }

    // Filter events by session — only show events for the active session
    if (frame.payload && frame.payload.sessionKey && frame.payload.sessionKey !== this.sessionKey) {
      // Silently drop events for other sessions
      return;
    }

    // Agent activity events
    // Gateway webchat WS only sends: event=agent stream=assistant (text deltas)
    // and event=chat state=delta/final. No lifecycle or tool events.
    // We synthesize lifecycle from runId changes and chat final state.
    if (frame.event === "agent" && frame.payload) {
      var stream = frame.payload.stream;
      var data = frame.payload.data || {};
      var runId = frame.payload.runId;

      // Synthesize lifecycle.start: new runId = new agent turn
      if (runId && runId !== this._currentRunId) {
        this._currentRunId = runId;
        console.log("[Scratchy] New run detected:", runId);
        // Detect if another instance triggered this turn
        var timeSinceSend = Date.now() - this._lastSentAt;
        if (timeSinceSend > 3000 && this.onRemoteUserMessage) {
          console.log("[Scratchy] Remote turn detected (last send " + timeSinceSend + "ms ago)");
          this._fetchLastUserMessage();
        }
        if (this.onAgentActivity) {
          this.onAgentActivity({ type: "thinking", phase: "start" });
        }
        this._runActive = true;
        this._showedToolIdle = false;
        this._startToolIdleDetection();
        this._startStalenessWatchdog();
        // Fallback: if no deltas or chat.final within 15s, the run likely ended
        // silently (heartbeat, NO_REPLY, system noise). Clear the indicator.
        if (this._runStartTimer) clearTimeout(this._runStartTimer);
        var self3 = this;
        this._runStartTimer = setTimeout(function() {
          if (self3._runActive && self3._currentRunId === runId) {
            console.log("[Scratchy] Run start timeout (15s no deltas/final) — clearing stale indicator");
            self3._endRun();
          }
        }, 15000);
      }

      if (stream === "tool" && data.phase === "start" && data.name) {
        // Tool event confirms run is real — cancel start timeout
        if (this._runStartTimer) { clearTimeout(this._runStartTimer); this._runStartTimer = null; }
        console.log("[Scratchy] Tool event:", data.name, "args:", JSON.stringify(data.args), "keys:", Object.keys(data));
        if (this.onAgentActivity) {
          this.onAgentActivity({ type: "tool", name: data.name, phase: "start", detail: data });
        }
      } else if (stream === "tool" && (data.phase === "end" || data.phase === "error")) {
        if (this.onAgentActivity) {
          this.onAgentActivity({ type: "tool", name: data.name || "", phase: "end", detail: data });
        }
      } else if (stream === "compaction") {
        // Gateway compaction events — start/end
        // Cancel run-start timeout — compaction runs long with no deltas/tools
        if (this._runStartTimer) { clearTimeout(this._runStartTimer); this._runStartTimer = null; }
        if (this._runEndTimer) { clearTimeout(this._runEndTimer); this._runEndTimer = null; }
        console.log("[Scratchy] Compaction event:", data.phase);
        if (this.onAgentActivity) {
          this.onAgentActivity({ type: "compaction", phase: data.phase || "start", detail: data });
        }
      } else if (stream === "assistant" && data.delta) {
        // Text is streaming — clear start timeout and tool-idle timer
        if (this._runStartTimer) { clearTimeout(this._runStartTimer); this._runStartTimer = null; }
        if (this._toolIdleTimer) clearTimeout(this._toolIdleTimer);
        this._lastDeltaAt = Date.now();
        if (this._showedToolIdle && this.onAgentActivity) {
          this.onAgentActivity({ type: "done", phase: "end" });
          this._showedToolIdle = false;
        }
        // Reset run-end fallback timer (5s after last delta = run probably ended)
        if (this._runEndTimer) clearTimeout(this._runEndTimer);
        var self = this;
        this._runEndTimer = setTimeout(function() {
          if (self._runActive) {
            console.log("[Scratchy] Run end fallback (5s no delta)");
            self._endRun();
          }
        }, 5000);
      }
      return;
    }

    // Chat events: agent replies
    // Format: { type: "event", event: "chat", payload: { state: "final", message: "..." } }
    if (frame.event === "chat" && frame.payload) {
      if (frame.payload.state === "final" && frame.payload.message) {
        // message is { role, content: [{ type: "text", text: "..." }, ...], ... }
        const msg = frame.payload.message;
        let text = "";
        if (typeof msg === "string") {
          text = msg;
        } else if (msg.content && Array.isArray(msg.content)) {
          // Extract text from content blocks
          text = msg.content
            .filter(block => block.type === "text" && block.text)
            .map(block => block.text)
            .join("\n");
        }
        // Filter out sub-agent completion notifications and system noise
        if (text && this._isSystemNoise(text)) {
          console.log("[Scratchy] Filtered system noise from live stream");
          text = "";
        }
        if (text && this.onMessage) {
          this.onMessage({ text: text, role: "assistant", timestamp: new Date().toISOString(), source: "stream" });
        }
        // Synthesize lifecycle.end: final chat = turn complete
        this._endRun();
      }
      // ------------------------------------------

      // ------------------------------------------
      // The gateway sends partial text as the agent types:
      //   { state: "delta", message: { content: [{ type: "text", text: "text so far..." }] } }
      //
      // To show real-time typing:
      // 1. When you get a "delta", update the LAST agent message bubble
      //    instead of creating a new one
      // 2. When you get a "final", that's the complete message — replace the
      //    streaming bubble with the final text
      //
      // Hint: You'll need a new callback like this.onStreamDelta
      // Hint: The delta text is the FULL text so far (not just the new chunk)
      //
      if (frame.payload.state === "delta" && frame.payload.message) {
        const msg = frame.payload.message;
        let text = "";
        if (msg.content && Array.isArray(msg.content)) {
          text = msg.content
            .filter(block => block.type === "text" && block.text)
            .map(block => block.text)
            .join("\n");
        }
        if (text && !this._isSystemNoise(text) && this.onStreamDelta) {
          // Stream delta received
          this.onStreamDelta({ text: text, role: "assistant", source: "stream" });
        }
      }

      if (frame.payload.state === "error" && frame.payload.errorMessage) {
        if (this.onMessage) {
          this.onMessage({ text: "⚠️ " + frame.payload.errorMessage, role: "assistant", timestamp: new Date().toISOString(), source: "stream" });
        }
        this._endRun();
      }
    }
  }

  // ------------------------------------------
  // Send a chat message to the agent
  // ------------------------------------------
  // attachments: optional array of { type: "image", mimeType: "image/png", content: "<base64>" }
  // Returns: messageId (string) for tracking status via onMessageStatus
  send(text, attachments) {
    var messageId = this._generateMessageId();

    if (!this.connected || !this.handshakeComplete) {
      // Queue message for sending when connection is restored
      var queuedMsg = {
        text: text,
        attachments: attachments || null,
        ts: Date.now(),
        id: messageId,
        retries: 0
      };
      this._offlineQueue.push(queuedMsg);
      this._persistOfflineQueue();
      this._emitStatus(messageId, "queued");
      console.log("[Scratchy] Queued message (offline). Queue size:", this._offlineQueue.length);
      if (this.onStatusChange) {
        this.onStatusChange("disconnected"); // Ensure UI reflects offline state
      }
      return messageId;
    }

    this._emitStatus(messageId, "sending");

    var params = {
      sessionKey: this.sessionKey,
      message: text,
      idempotencyKey: this._nextId()
    };

    // Send file attachments via HTTP (server processes PDFs, text files, etc.)
    // The gateway's WS chat.send doesn't handle file attachments natively.
    if (attachments && attachments.length > 0) {
      console.log("[Scratchy] Sending " + attachments.length + " attachment(s) via HTTP upload");
      this._sendViaHttp(text, attachments, messageId, 0);
      return messageId;
    }

    var self = this;
    const reqId = this._nextId();
    const requestFrame = {
      type: "req",
      id: reqId,
      method: "chat.send",
      params: params
    };

    // Register callback to catch errors
    this.pendingRequests[reqId] = function(response) {
      if (!response.ok) {
        console.error("[Scratchy] chat.send FAILED:", response.error);
        self._emitStatus(messageId, "failed");
        if (self.onSendError) {
          self.onSendError(response.error, messageId);
        }
      } else {
        console.log("[Scratchy] chat.send OK — runId:", response.payload?.runId);
        self._emitStatus(messageId, "sent");
      }
    };

    this._lastSentAt = Date.now();
    this.ws.send(JSON.stringify(requestFrame));
    return messageId;
  }

  // Upload files via HTTP POST to /api/send (server relays to gateway on localhost)
  // messageId: tracking id for status callbacks
  // retryCount: current retry attempt (0 = first try)
  _sendViaHttp(text, attachments, messageId, retryCount) {
    this._lastSentAt = Date.now();
    var formData = new FormData();
    formData.append("message", text || "");
    formData.append("sessionKey", this.sessionKey);

    for (var i = 0; i < attachments.length; i++) {
      var att = attachments[i];
      // Convert base64 to blob
      var byteStr = atob(att.content);
      var bytes = new Uint8Array(byteStr.length);
      for (var j = 0; j < byteStr.length; j++) {
        bytes[j] = byteStr.charCodeAt(j);
      }
      var blob = new Blob([bytes], { type: att.mimeType || "application/octet-stream" });
      if (att.type === "image") {
        formData.append("image", blob, "image-" + i + ".jpg");
      } else {
        formData.append("file", blob, att.fileName || ("file-" + i));
      }
    }

    var self = this;
    var currentRetry = retryCount || 0;
    console.log("[Scratchy] Uploading " + attachments.length + " file(s) via HTTP..." +
      (currentRetry > 0 ? " (retry " + currentRetry + "/" + self._MAX_RETRIES + ")" : ""));

    fetch("/api/send", { method: "POST", body: formData, credentials: "same-origin" })
      .then(function(response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status + " " + response.statusText);
        }
        return response.json();
      })
      .then(function(data) {
        if (data.ok) {
          console.log("[Scratchy] HTTP send OK — runId:", data.runId);
          if (messageId) self._emitStatus(messageId, "sent");
        } else {
          console.error("[Scratchy] HTTP send failed:", data.error);
          throw new Error(data.error || "Server returned error");
        }
      })
      .catch(function(err) {
        console.error("[Scratchy] HTTP upload error:", err);
        self._requeueFailedHttp(text, attachments, messageId, currentRetry, err);
      });
  }

  // Re-queue a failed HTTP upload into the offline queue with retry tracking
  _requeueFailedHttp(text, attachments, messageId, retryCount, err) {
    var nextRetry = (retryCount || 0) + 1;
    if (nextRetry > this._MAX_RETRIES) {
      console.error("[Scratchy] HTTP upload permanently failed after " + this._MAX_RETRIES + " retries");
      if (messageId) this._emitStatus(messageId, "failed");
      if (this.onSendError) {
        this.onSendError({ message: "Upload failed after " + this._MAX_RETRIES + " retries: " + err.message }, messageId);
      }
      return;
    }

    console.log("[Scratchy] Re-queuing failed HTTP upload (retry " + nextRetry + "/" + this._MAX_RETRIES + ")");
    var queuedMsg = {
      text: text,
      attachments: attachments || null,
      ts: Date.now(),
      id: messageId || this._generateMessageId(),
      retries: nextRetry
    };
    this._offlineQueue.push(queuedMsg);
    this._persistOfflineQueue();
    if (messageId) this._emitStatus(messageId, "queued");
  }

  // ------------------------------------------
  // ------------------------------------------
  // After connecting, we want to load previous messages so the
  // chat doesn't start empty on every refresh.
  //
  // Steps:
  // 1. Send a request frame with method "chat.history"
  //    params: { sessionKey: this.sessionKey, limit: 50 }
  // 2. The response will come back through _handleFrame as a "res" frame
  //    with result: { messages: [...] }
  //
  // Problem: _handleFrame currently doesn't handle responses after
  // the handshake. You need to:
  //   a) Store a callback for pending requests (keyed by request id)
  //   b) In _handleFrame, check if a response matches a pending request
  //   c) Call the callback with the result
  //
  // This is called the "request/response pattern" — you send a request
  // with an id, and when the response comes back with that same id,
  // you match them up.
  //
  //           The id links a request to its response.
  //
  // Hint: Add a `this.pendingRequests = {}` in the constructor
  // Hint: In _handleFrame, after handshake check:
  //       if (frame.type === "res" && this.pendingRequests[frame.id]) {
  //         this.pendingRequests[frame.id](frame);
  //         delete this.pendingRequests[frame.id];
  //       }
  //
  loadHistory(callback) {
    // M3: Guard against null/disconnected WS
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.handshakeComplete) {
      console.warn("[Scratchy] Cannot load history — not connected");
      if (callback) callback({ ok: false, error: { message: "not connected" } });
      return;
    }

    const id = this._nextId();
    this.pendingRequests[id] = callback;
    this.ws.send(JSON.stringify({
      type: "req",
      id: id,
      method: "chat.history",
      params: { sessionKey: this.sessionKey, limit: 50 }
    }));
  }

  // ------------------------------------------
  // Synthesize lifecycle.end — called on chat final or timeout
  _endRun() {
    if (!this._runActive) return;
    this._runActive = false;
    this._currentRunId = null;
    if (this._runStartTimer) { clearTimeout(this._runStartTimer); this._runStartTimer = null; }
    if (this._toolIdleTimer) clearTimeout(this._toolIdleTimer);
    if (this._runEndTimer) clearTimeout(this._runEndTimer);
    if (this._stalenessTimer) clearInterval(this._stalenessTimer);
    this._stalenessTimer = null;
    this._showedToolIdle = false;
    if (this.onAgentActivity) {
      this.onAgentActivity({ type: "done", phase: "end" });
    }
    // Finalize any orphaned streaming message
    if (this.onRunEnd) this.onRunEnd();
  }

  // ------------------------------------------
  // Detect when the agent stops streaming text (= tool call in progress)
  _startToolIdleDetection() {
    var self = this;
    this._lastDeltaAt = Date.now();
    if (this._toolIdleTimer) clearTimeout(this._toolIdleTimer);

    function check() {
      // No-op: real tool events now arrive via gateway broadcast.
      // Keeping the timer structure for future heuristic use.
    }
    this._toolIdleTimer = setTimeout(check, 2000);
  }

  // Drain queued messages after reconnect
  // ------------------------------------------
  _isSystemNoise(text) {
    if (!text) return true;
    var t = text.trim();
    // Strip ProteClaw canary prefix if present
    t = t.replace(/^\[ProteClaw Canary\][^\n]*\n?/, "").trim();
    if (!t) return true;

    // Sub-agent completions
    if (/^A background task .+ just completed/m.test(t)) return true;
    if (/^Stats: runtime .+ sessionKey agent:/m.test(t)) return true;
    if (/Summarize this naturally for the user/m.test(t)) return true;
    if (/Do not mention technical details like tokens/m.test(t)) return true;

    // System/exec notifications from OpenClaw
    if (/^System:\s*\[/m.test(t)) return true;           // "System: [2026-02-17 11:09:17 GMT+1] Exec completed..."
    if (/^GatewayRestart:/m.test(t)) return true;
    if (/^\[ProteClaw[ :L]/m.test(t) && !/\[ProteClaw Memory\]/m.test(t)) return true;  // [ProteClaw L0], [ProteClaw:source=...] — but NOT [ProteClaw Memory] (contains user messages)
    if (/\[proteclaw:source=/m.test(t)) return true;        // trust metadata tags

    // Heartbeats, cron, internal — use loose matching (prefix/suffix) like gateway
    if (/(?:^|\s)NO_REPLY(?:\s|$)/.test(t)) return true;
    if (/(?:^|\s)HEARTBEAT_OK(?:\s|$)/.test(t)) return true;
    if (/^Read HEARTBEAT\.md/m.test(t)) return true;     // heartbeat poll prompt
    if (/^sessionKey agent:main:subagent:/m.test(t)) return true;

    return false;
  }

  _drainOfflineQueue() {
    if (this._offlineQueue.length === 0) {
      // No queued messages — still fire callbacks so reconnect flow continues
      if (this.onQueueDrained) this.onQueueDrained();
      if (this._drainCallback) this._drainCallback();
      return;
    }

    var queue = this._offlineQueue.slice(); // Copy
    this._offlineQueue = [];
    this._persistOfflineQueue();
    console.log("[Scratchy] Draining " + queue.length + " queued message(s)");

    var self = this;
    var i = 0;

    function sendNext() {
      if (i >= queue.length) {
        console.log("[Scratchy] Offline queue drained");
        if (self.onQueueDrained) self.onQueueDrained();
        if (self._drainCallback) self._drainCallback();
        return;
      }

      if (!self.connected || !self.handshakeComplete) {
        // Lost connection again mid-drain — re-queue remaining
        for (var j = i; j < queue.length; j++) {
          self._offlineQueue.push(queue[j]);
        }
        self._persistOfflineQueue();
        console.log("[Scratchy] Connection lost during drain — re-queued " + (queue.length - i) + " message(s)");
        return;
      }

      var msg = queue[i];
      i++;

      // Emit replay event so the app can re-ingest into store if it was cleared (DOM purge)
      if (self.onQueueReplay) {
        self.onQueueReplay({ text: msg.text, id: msg.id, ts: msg.ts });
      }

      // Check if this message has exceeded max retries
      if (msg.retries && msg.retries > self._MAX_RETRIES) {
        console.log("[Scratchy] Dropping message " + msg.id + " — exceeded max retries");
        self._emitStatus(msg.id, "failed");
        if (self.onSendError) {
          self.onSendError({ message: "Message failed after " + self._MAX_RETRIES + " retries" }, msg.id);
        }
        setTimeout(sendNext, 50);
        return;
      }

      self._emitStatus(msg.id, "sending");

      // Messages with attachments go via HTTP
      if (msg.attachments && msg.attachments.length > 0) {
        self._sendViaHttp(msg.text, msg.attachments, msg.id, msg.retries || 0);
        setTimeout(sendNext, 300);
        return;
      }

      // Plain text messages go via WebSocket
      var params = {
        sessionKey: self.sessionKey,
        message: msg.text,
        idempotencyKey: self._nextId()
      };
      var reqId = self._nextId();
      var requestFrame = {
        type: "req",
        id: reqId,
        method: "chat.send",
        params: params
      };

      self.pendingRequests[reqId] = (function(msgId) {
        return function(response) {
          if (!response.ok) {
            console.error("[Scratchy] chat.send FAILED (queued):", response.error);
            self._emitStatus(msgId, "failed");
            if (self.onSendError) {
              self.onSendError(response.error, msgId);
            }
          } else {
            console.log("[Scratchy] chat.send OK (queued) — runId:", response.payload?.runId);
            self._emitStatus(msgId, "sent");
          }
        };
      })(msg.id);

      self._lastSentAt = Date.now();
      self.ws.send(JSON.stringify(requestFrame));

      // Small delay between queued messages to avoid flooding
      setTimeout(sendNext, 300);
    }

    sendNext();
  }

  // ------------------------------------------
  // Fetch the last user message (for multi-instance sync)
  // ------------------------------------------
  _fetchLastUserMessage() {
    if (!this.connected || !this.handshakeComplete) return;

    var id = this._nextId();
    var self = this;

    this.pendingRequests[id] = function(frame) {
      if (!frame.ok || !frame.payload || !frame.payload.messages) return;

      var messages = frame.payload.messages;
      // Find ALL recent user messages (not just the last one)
      var userMsgs = [];
      for (var i = messages.length - 1; i >= 0; i--) {
        var msg = messages[i];
        if (msg.role === "user") {
          var text = "";
          if (msg.content && Array.isArray(msg.content)) {
            text = msg.content
              .filter(function(b) { return b.type === "text" && b.text; })
              .map(function(b) { return b.text; })
              .join("\n");
          } else if (typeof msg.content === "string") {
            text = msg.content;
          }
          if (text && !self._isSystemNoise(text)) {
            userMsgs.unshift({ text: text });
          }
        } else if (msg.role !== "assistant") {
          break; // Stop at system/compaction boundaries
        }
      }
      // Notify for each found user message
      for (var j = 0; j < userMsgs.length; j++) {
        userMsgs[j].role = "user";
        userMsgs[j].source = "remote";
        userMsgs[j].timestamp = new Date().toISOString();
        if (self.onRemoteUserMessage) {
          self.onRemoteUserMessage(userMsgs[j]);
        }
      }
    };

    this.ws.send(JSON.stringify({
      type: "req",
      id: id,
      method: "chat.history",
      params: { sessionKey: this.sessionKey, limit: 10 }
    }));
  }

  // ------------------------------------------
  // Fetch missed messages after reconnect
  // ------------------------------------------
  catchUpMissedMessages(callback) {
    if (!this.connected || !this.handshakeComplete) return;

    var id = this._nextId();
    var self = this;

    this.pendingRequests[id] = function(frame) {
      if (!frame.ok || !frame.payload || !frame.payload.messages) {
        console.log("[Scratchy] Catch-up: no messages or failed");
        return;
      }

      var messages = frame.payload.messages;
      if (messages.length === 0) return;

      // Find trailing messages (both user and assistant) that may have been missed
      // Walk backward from the end; collect all recent messages
      var missed = [];
      for (var i = messages.length - 1; i >= 0; i--) {
        var msg = messages[i];
        if (msg.role === "assistant" || msg.role === "user") {
          missed.unshift(msg);
        } else if (msg.role === "system") {
          continue; // Skip system messages but keep walking
        } else {
          break;
        }
      }

      if (missed.length > 0 && callback) {
        console.log("[Scratchy] Catch-up: found " + missed.length + " potentially missed message(s)");
        callback(missed);
      }
    };

    this.ws.send(JSON.stringify({
      type: "req",
      id: id,
      method: "chat.history",
      params: { sessionKey: this.sessionKey, limit: 20 }
    }));
  }

  // ------------------------------------------
  // Staleness watchdog — detect dead socket during active agent runs
  // ------------------------------------------
  // Client-side keepalive: send a JSON ping every 25s to keep the
  // Cloudflare tunnel connection alive AND detect zombie sockets.
  // If we send a ping and don't get a pong within 10s, socket is dead.
  _startClientKeepalive() {
    this._stopClientKeepalive();
    var self = this;
    this._pongReceived = true; // Assume alive
    this._keepaliveTimer = setInterval(function() {
      if (!self.ws || self.ws.readyState !== WebSocket.OPEN) return;
      if (!self._pongReceived) {
        // Previous ping never got a pong — zombie socket
        console.log("[Scratchy] 💀 Zombie socket detected (no pong to JSON ping) — forcing reconnect");
        self.forceReconnect();
        return;
      }
      self._pongReceived = false;
      try { self.ws.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch(e) {}
    }, 25000); // ping every 25s
  }

  _stopClientKeepalive() {
    if (this._keepaliveTimer) { clearInterval(this._keepaliveTimer); this._keepaliveTimer = null; }
  }

  // If we're in an active run (lifecycle.start received) but no events arrive
  // for 10s, the socket is probably dead. Run a health check; if it fails,
  // force reconnect so buffered events replay immediately.
  _startStalenessWatchdog() {
    if (this._stalenessTimer) clearInterval(this._stalenessTimer);
    this._lastEventAt = Date.now();
    var self = this;
    this._stalenessTimer = setInterval(function() {
      if (!self._runActive) {
        clearInterval(self._stalenessTimer);
        self._stalenessTimer = null;
        return;
      }
      var gap = Date.now() - (self._lastEventAt || 0);
      if (gap > 10000) {
        console.log("[Scratchy] ⚠️ Staleness detected — no events for " + Math.round(gap/1000) + "s during active run. Health checking...");
        self.checkHealth(function(alive) {
          if (!alive && self._runActive) {
            console.log("[Scratchy] 💀 Socket dead during active run — forcing reconnect");
            self.forceReconnect();
          } else if (alive) {
            // Socket is fine — agent is probably doing long tool calls, reset timer
            self._lastEventAt = Date.now();
          }
        }, 5000);
      }
    }, 5000); // Check every 5s
  }

  // ------------------------------------------
  // Health check — detect zombie WebSocket
  // ------------------------------------------
  // Sends a lightweight request and waits for a response.
  // If no response within timeoutMs, the socket is dead.
  // Returns: callback(alive: boolean)
  checkHealth(callback, timeoutMs) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      callback(false);
      return;
    }

    var id = this._nextId();
    var self = this;
    var timedOut = false;
    timeoutMs = timeoutMs || 3000;

    // Set a timeout — if no response, socket is zombie
    this._healthCheckTimer = setTimeout(function() {
      timedOut = true;
      delete self.pendingRequests[id];
      console.log("[Scratchy] Health check timed out — zombie socket detected");
      callback(false);
    }, timeoutMs);

    // Use chat.history with limit:1 as a lightweight ping
    this.pendingRequests[id] = function(frame) {
      if (timedOut) return; // Already called back
      clearTimeout(self._healthCheckTimer);
      self._healthCheckTimer = null;
      console.log("[Scratchy] Health check OK — socket is alive");
      callback(true);
    };

    try {
      this.ws.send(JSON.stringify({
        type: "req",
        id: id,
        method: "chat.history",
        params: { sessionKey: this.sessionKey, limit: 1 }
      }));
    } catch(e) {
      clearTimeout(this._healthCheckTimer);
      this._healthCheckTimer = null;
      delete this.pendingRequests[id];
      console.log("[Scratchy] Health check send failed:", e.message);
      callback(false);
    }
  }

  // ------------------------------------------
  // Force reconnect — tear down and rebuild
  // ------------------------------------------
  forceReconnect() {
    console.log("[Scratchy] Force reconnecting...");
    this.connected = false;
    this.handshakeComplete = false;
    // Set to 1 (not 0) so wasReconnect detection works in _handleFrame
    this.reconnectAttempts = 1;
    // Clear all pending requests — they'll never get responses
    this.pendingRequests = {};
    // Clear stale run state so activity indicator doesn't carry over
    this._runActive = false;
    this._currentRunId = null;
    if (this._toolIdleTimer) { clearTimeout(this._toolIdleTimer); this._toolIdleTimer = null; }
    if (this._runEndTimer) { clearTimeout(this._runEndTimer); this._runEndTimer = null; }
    if (this._stalenessTimer) { clearInterval(this._stalenessTimer); this._stalenessTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch(e) {}
      this.ws = null;
    }
    this.connect();
  }

  // ------------------------------------------
  // Switch to a different session
  // ------------------------------------------
  switchSession(newSessionKey) {
    if (!/^[a-zA-Z0-9:._-]+$/.test(newSessionKey)) {
      console.error("[Scratchy] Invalid session key:", newSessionKey);
      return;
    }
    console.log("[Scratchy] Switching session:", this.sessionKey, "->", newSessionKey);
    // Save current session's queue before switching
    this._persistOfflineQueue();
    this.sessionKey = newSessionKey;
    // Load the new session's queue (don't wipe it)
    this._offlineQueue = this._loadOfflineQueue();
    this.disconnect();
    this.reconnectAttempts = 0;
    this.connect();
  }

  // ------------------------------------------
  // ------------------------------------------
  disconnect() {
    this.reconnectAttempts = this.maxReconnectAttempts;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.handshakeComplete = false;
    this._updateStatus("disconnected");
  }

  // ------------------------------------------
  // ------------------------------------------
  _tryReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log("[Scratchy] Max reconnect attempts reached");
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s... capped at 15s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 15000);
    console.log(`[Scratchy] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (!this.connected) {
        this.connect();
      }
    }, delay);
  }

  // ------------------------------------------
  // ------------------------------------------
  _updateStatus(status) {
    console.log(`[Scratchy] Connection: ${status}`);
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  _nextId() {
    this.messageIdCounter++;
    return `scratchy-${Date.now()}-${this.messageIdCounter}`;
  }
}
