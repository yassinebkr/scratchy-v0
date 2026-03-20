// ============================================
// Scratchy Canvas — Chat Panel
// ============================================
// Collapsible chat bar at the bottom of the canvas.
// Handles: message display, input, send, expand/collapse.

class ChatPanel {
  constructor(options) {
    this.panelEl = options.panel;         // #chat-panel
    this.messagesEl = options.messages;   // #chat-messages
    this.inputEl = options.input;         // #chat-input
    this.sendBtn = options.sendBtn;       // #send-btn
    this.toggleBtn = options.toggleBtn;   // #chat-toggle
    this.connection = options.connection; // ScratchyConnection instance
    this.onSend = options.onSend || null; // callback(text)

    this._expanded = false;
    this._messages = []; // { role, text, timestamp }

    this._bindEvents();
  }

  _bindEvents() {
    var self = this;

    // Toggle expand/collapse
    this.toggleBtn.addEventListener("click", function() {
      self.toggle();
    });

    // Send on button click
    this.sendBtn.addEventListener("click", function() {
      self._send();
    });

    // Send on Enter key
    this.inputEl.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        self._send();
      }
    });
  }

  _send() {
    var text = this.inputEl.value.trim();
    if (!text) return;

    // Append genui tag
    var sendText = text + "\n[genui:on]";

    // Add to local display
    this.addMessage("user", text);

    // Clear input
    this.inputEl.value = "";
    this.inputEl.focus();

    // Call send callback or connection directly
    if (this.onSend) {
      this.onSend(sendText);
    } else if (this.connection) {
      this.connection.send(sendText);
    }
  }

  // Add a message to the chat panel
  addMessage(role, text) {
    var msg = {
      role: role,
      text: text,
      timestamp: new Date().toISOString()
    };
    this._messages.push(msg);

    // Keep only last 50 messages in memory
    if (this._messages.length > 50) {
      this._messages.shift();
    }

    // Render
    this._renderMessage(msg);
    this._scrollToBottom();
  }

  _renderMessage(msg) {
    var div = document.createElement("div");
    div.className = "chat-msg chat-msg-" + msg.role;

    // Clean text for display
    var clean = (msg.text || "")
      .replace(/\[SecurityPlugin Canary\][^\n]*/g, "")
      .replace(/\n?\[message_id:[^\]]*\]/g, "")
      .replace(/\n?\[genui:\w+\]/g, "")
      .trim();

    if (!clean) return; // Don't render empty messages

    // Use markdown renderer if available, otherwise plain text
    if (typeof renderMarkdown === "function") {
      safeHTML(div, renderMarkdown(clean));
    } else {
      div.textContent = clean;
    }

    this.messagesEl.appendChild(div);
  }

  _scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  toggle() {
    this._expanded = !this._expanded;
    if (this._expanded) {
      this.panelEl.classList.add("expanded");
      this.toggleBtn.textContent = "▼";
    } else {
      this.panelEl.classList.remove("expanded");
      this.toggleBtn.textContent = "▲";
    }
    this._scrollToBottom();
  }

  expand() {
    if (!this._expanded) this.toggle();
  }

  collapse() {
    if (this._expanded) this.toggle();
  }

  // Clear all messages
  clear() {
    this._messages = [];
    this.messagesEl.innerHTML = "";
  }

  // Show connection status
  setStatus(status) {
    var indicator = document.getElementById("session-indicator");
    if (indicator) {
      var labels = {
        "connected": "● Connected",
        "disconnected": "○ Disconnected",
        "connecting": "◌ Connecting...",
        "handshake": "◌ Handshake..."
      };
      indicator.textContent = labels[status] || status;
      indicator.className = "session-info status-" + status;
    }
  }
}
