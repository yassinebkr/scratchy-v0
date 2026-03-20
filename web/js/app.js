// ============================================
// Scratchy — Main App
// ============================================

// (diagnostic click tracer removed)

(function() {
  // Resolve gateway URL — "auto" derives from page origin (wss://host/ws or ws://host/ws)
  function resolveGatewayUrl() {
    var url = SCRATCHY_CONFIG.gatewayUrl;
    if (url !== "auto") return url;
    if (window.location.protocol === "https:") {
      return "wss://" + window.location.host + "/ws";
    }
    if (window.location.protocol === "http:") {
      return "ws://" + window.location.host + "/ws";
    }
    return "ws://localhost:28945";
  }
  const OPENCLAW_WS_URL = resolveGatewayUrl();

  // Resolve the server URL — "auto" means same origin as the page
  function resolveServerUrl() {
    var url = SCRATCHY_CONFIG.serverUrl;
    if (url === "auto") {
      if (window.location.protocol.startsWith("http")) {
        return window.location.origin;
      }
      return "";
    }
    return url || "";
  }

  // Initialize components
  const messagesContainer = document.getElementById("messages");
  const messageInput = document.getElementById("message-input");
  const sendBtn = document.getElementById("send-btn");
  const statusEl = document.getElementById("connection-status");
  const reloadBtn = document.getElementById("reload-btn");
  const genuiToggle = document.getElementById("genui-toggle");
  const attachBtn = document.getElementById("attach-btn");
  const fileInput = document.getElementById("file-input");
  const attachmentPreview = document.getElementById("attachment-preview");

  const connection = new ScratchyConnection(OPENCLAW_WS_URL);
  // Set per-user session key from config (localStorage) — critical for multi-user isolation
  connection.sessionKey = SCRATCHY_CONFIG.sessionKey;
  window._scratchyConnection = connection;

  // Phase 29: Initialize cross-device sync
  if (window.ScratchyDeviceSync) {
    window.ScratchyDeviceSync.init(connection, null); // app ref set later
  }

  // Global widget action sender — used by table action buttons etc.
  // Auto-switches to chat tab when a widget action is fired from workspace
  window._scratchyWidgetAction = function(action, context) {
    if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify({
        type: "widget-action",
        sessionKey: connection.sessionKey,
        data: { surfaceId: "main", componentId: "table-action", action: action, context: context || {} },
        timestamp: Date.now()
      }));
    }
    // Switch to chat tab so user sees the widget response
    if (window._scratchySwitchToChat) window._scratchySwitchToChat();
  };
  const renderer = new MessageRenderer(messagesContainer);
  const store = new MessageStore();
  const domSync = new DOMSync(store, messagesContainer, renderer);

  let welcomeCleared = false;

  // ── Loading overlay status updater ──
  function _updateLoadingStatus(status, detail) {
    var overlay = messagesContainer.querySelector(".loading-overlay");
    if (!overlay) return;
    var statusEl = overlay.querySelector(".loading-status");
    var detailEl = overlay.querySelector(".loading-detail");
    if (statusEl) statusEl.innerHTML = status + '<span class="loading-dots"></span>';
    if (detailEl) detailEl.textContent = detail || "";
  }

  // ── Instant load: render cached messages BEFORE WS connects ──
  // Disabled on mobile (touch devices) — was causing blank screen with stale cache
  try {
    store._sessionKey = SCRATCHY_CONFIG.sessionKey;
    var isMobile = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (!isMobile) {
      var cached = store.loadFromCache();
      if (cached && cached.length > 0) {
        store.loadHistory(cached);
        welcomeCleared = true;
        if (renderer && typeof renderer.clearWelcome === "function") renderer.clearWelcome();
        console.log("[Scratchy] ⚡ Instant load: " + cached.length + " messages from cache");
      }
    }
  } catch(e) {
    console.error("[Scratchy] Instant load failed:", e);
  }
  let streamingEnabled = true;
  let activitySafetyTimer = null;
  let historyLoaded = false;
  var _historyRendered = false;  // true once history messages are in the DOM
  var _pendingCanvasUpdates = []; // canvas-update events queued before history ready
  function _flushPendingCanvasUpdates() {
    if (_pendingCanvasUpdates.length > 0) {
      console.log("[Scratchy] Flushing " + _pendingCanvasUpdates.length + " queued canvas-update(s)");
      for (var pci = 0; pci < _pendingCanvasUpdates.length; pci++) {
        connection.onCanvasUpdate(_pendingCanvasUpdates[pci]);
      }
      _pendingCanvasUpdates = [];
    }
    // localStorage canvas state is a CACHE only — server re-triggers handle widget
    // restoration on reconnect. Do NOT render from localStorage here.
    // This eliminates the race condition where stale localStorage overwrites fresh server state.
  }

  // ------------------------------------------
  // Sidebar management
  // ------------------------------------------
  var sidebar = document.getElementById("sidebar");
  var sidebarToggle = document.getElementById("sidebar-toggle");
  var sidebarBackdrop = document.getElementById("sidebar-backdrop");
  var sidebarSearch = document.getElementById("sidebar-search");
  var sidebarSessions = document.getElementById("sidebar-sessions");
  var sidebarSessionsData = [];
  var sidebarSearchTimer = null;

  function toggleSidebar() {
    var isOpen = sidebar.classList.toggle("open");
    document.body.classList.toggle("sidebar-open", isOpen);
    if (isOpen) {
      sidebarBackdrop.classList.add("visible");
      if (currentView === "canvas") {
        loadCanvasHistory();
      } else {
        loadSessions();
      }
    } else {
      sidebarBackdrop.classList.remove("visible");
    }
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    document.body.classList.remove("sidebar-open");
    sidebarBackdrop.classList.remove("visible");
  }

  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", toggleSidebar);
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", closeSidebar);
  }

  function loadCanvasHistory() {
    var serverUrl = resolveServerUrl();
    if (!serverUrl) return;
    fetch(serverUrl + "/api/canvas-history", { credentials: "same-origin" })
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(data) {
        if (!data || !data.history) return;
        renderCanvasHistory(data.history);
      })
      .catch(function() {});
  }

  function renderCanvasHistory(history) {
    sidebarSessions.innerHTML = "";
    if (history.length === 0) {
      sidebarSessions.innerHTML = '<div class="search-no-results">No canvas history yet</div>';
      return;
    }
    var header = document.createElement("div");
    header.className = "session-group-header";
    header.innerHTML = '<span class="session-group-title">Canvas History</span>';
    sidebarSessions.appendChild(header);

    var container = document.createElement("div");
    container.className = "session-group-items";

    for (var i = 0; i < history.length; i++) {
      (function(idx, item) {
        var div = document.createElement("div");
        div.className = "session-item";
        var d = new Date(item.ts);
        var timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        var dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
        div.innerHTML =
          '<div class="session-item-row">' +
            '<span class="session-item-icon">🖼</span>' +
            '<div class="session-item-info">' +
              '<div class="session-item-top">' +
                '<span class="session-item-name">' + escapeHtml(item.title) + '</span>' +
                '<span class="session-item-time">' + dateStr + ' ' + timeStr + '</span>' +
              '</div>' +
              '<div class="session-item-bottom">' +
                '<span class="session-item-preview">' + item.count + ' component' + (item.count !== 1 ? 's' : '') + '</span>' +
              '</div>' +
            '</div>' +
          '</div>';
        div.addEventListener("click", function() {
          fetch(resolveServerUrl() + "/api/canvas-history/restore", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ index: idx })
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.ok) closeSidebar();
          }).catch(function() {});
        });
        container.appendChild(div);
      })(i, history[i]);
    }
    sidebarSessions.appendChild(container);
  }

  function loadSessions() {
    var serverUrl = resolveServerUrl();
    if (!serverUrl) return;
    fetch(serverUrl + "/api/sessions", { credentials: "same-origin" })
      .then(function(res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function(data) {
        sidebarSessionsData = data.sessions || [];
        renderSessionList(sidebarSessionsData);
      })
      .catch(function(err) {
        console.warn("[Scratchy] Failed to load sessions:", err);
      });
  }

  // Sidebar collapse state (persisted in localStorage)
  var sidebarCollapseState = {};
  try {
    sidebarCollapseState = JSON.parse(localStorage.getItem("scratchy_sidebar_collapse") || "{}");
  } catch(e) {}

  function saveSidebarCollapse() {
    try { localStorage.setItem("scratchy_sidebar_collapse", JSON.stringify(sidebarCollapseState)); } catch(e) {}
  }

  function formatSessionTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    var diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      return d.toLocaleDateString([], { weekday: "short" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function renderSessionList(sessions) {
    sidebarSessions.innerHTML = "";
    if (sessions.length === 0) {
      sidebarSessions.innerHTML = '<div class="search-no-results">No sessions found</div>';
      return;
    }

    var groups = { conversation: [], background: [], archived: [] };
    for (var i = 0; i < sessions.length; i++) {
      var cat = sessions[i].category || "conversation";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(sessions[i]);
    }

    groups.conversation.sort(function(a, b) {
      if (a.sessionKey === "agent:main:main") return -1;
      if (b.sessionKey === "agent:main:main") return 1;
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });

    var groupDefs = [
      { key: "conversation", title: "Conversations", collapsible: false },
      { key: "background",   title: "Background",    collapsible: true },
      { key: "archived",     title: "Archived",      collapsible: true },
    ];

    for (var g = 0; g < groupDefs.length; g++) {
      var def = groupDefs[g];
      var items = groups[def.key];
      if (!items || items.length === 0) continue;

      var isCollapsed = def.collapsible && (sidebarCollapseState[def.key] !== false);
      if (def.collapsible && sidebarCollapseState[def.key] === undefined) {
        isCollapsed = true;
      }

      var header = document.createElement("div");
      header.className = "session-group-header" + (def.collapsible ? " collapsible" : "");
      if (isCollapsed) header.classList.add("collapsed");
      header.innerHTML =
        (def.collapsible ? '<span class="session-group-chevron">' + (isCollapsed ? "▸" : "▾") + '</span>' : '') +
        '<span class="session-group-title">' + escapeHtml(def.title) + '</span>' +
        (def.collapsible ? '<span class="session-group-count">' + items.length + '</span>' : '');

      if (def.collapsible) {
        header.setAttribute("data-group", def.key);
        header.addEventListener("click", (function(groupKey, headerEl) {
          return function() {
            var container = headerEl.nextElementSibling;
            var wasCollapsed = headerEl.classList.contains("collapsed");
            headerEl.classList.toggle("collapsed");
            if (container) container.style.display = wasCollapsed ? "block" : "none";
            var chevron = headerEl.querySelector(".session-group-chevron");
            if (chevron) chevron.textContent = wasCollapsed ? "▾" : "▸";
            sidebarCollapseState[groupKey] = !wasCollapsed;
            saveSidebarCollapse();
          };
        })(def.key, header));
      }

      sidebarSessions.appendChild(header);

      var container = document.createElement("div");
      container.className = "session-group-items";
      if (isCollapsed) container.style.display = "none";

      for (var j = 0; j < items.length; j++) {
        var s = items[j];
        var div = document.createElement("div");
        div.className = "session-item";
        if (def.key === "background") div.classList.add("background");
        if (def.key === "archived") div.classList.add("archived");
        if (s.sessionKey === connection.sessionKey) div.classList.add("active");

        var timeStr = formatSessionTime(s.lastActivity);
        var icon = s.icon || "💬";
        var tokenBadge = s.formattedTokens ? '<span class="session-token-badge">' + escapeHtml(s.formattedTokens) + '</span>' : '';
        var preview = s.lastMessage ? '<div class="session-item-preview">' + escapeHtml(s.lastMessage) + '</div>' : '';

        div.innerHTML =
          '<div class="session-item-row">' +
            '<span class="session-item-icon">' + icon + '</span>' +
            '<div class="session-item-info">' +
              '<div class="session-item-top">' +
                '<span class="session-item-name">' + escapeHtml(s.label) + '</span>' +
                '<span class="session-item-time">' + timeStr + '</span>' +
              '</div>' +
              '<div class="session-item-bottom">' +
                preview +
                tokenBadge +
              '</div>' +
            '</div>' +
          '</div>';

        div.setAttribute("data-session-key", s.sessionKey);
        div.addEventListener("click", (function(key) {
          return function() { switchToSession(key); };
        })(s.sessionKey));

        container.appendChild(div);
      }

      sidebarSessions.appendChild(container);
    }
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function switchToSession(sessionKey) {
    if (sessionKey === connection.sessionKey) {
      closeSidebar();
      return;
    }

    // Clear store for new session
    store.switchSession(sessionKey);

    messagesContainer.innerHTML = '<div class="welcome-message loading-overlay"><div class="loading-icon">🐱</div><div class="loading-spinner"></div><div class="loading-status">Switching session<span class="loading-dots"></span></div><div class="loading-detail"></div></div>';
    _activeWidgetRegion = null;
    welcomeCleared = false;
    historyLoaded = false;
    _historyRendered = false;
    _pendingCanvasUpdates = [];

    SCRATCHY_CONFIG.sessionKey = sessionKey;

    connection.switchSession(sessionKey);

    if (window.innerWidth <= 600) {
      closeSidebar();
    }

    var items = sidebarSessions.querySelectorAll(".session-item");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("active", items[i].getAttribute("data-session-key") === sessionKey);
    }

    var activeItem = sidebarSessions.querySelector('.session-item[data-session-key="' + sessionKey + '"]');
    if (activeItem) {
      var parentContainer = activeItem.closest(".session-group-items");
      if (parentContainer && parentContainer.style.display === "none") {
        parentContainer.style.display = "block";
        var header = parentContainer.previousElementSibling;
        if (header && header.classList.contains("collapsed")) {
          header.classList.remove("collapsed");
          var chevron = header.querySelector(".session-group-chevron");
          if (chevron) chevron.textContent = "▾";
          var groupKey = header.getAttribute("data-group");
          if (groupKey) {
            sidebarCollapseState[groupKey] = false;
            saveSidebarCollapse();
          }
        }
      }
    }
  }

  // Search functionality
  if (sidebarSearch) {
    sidebarSearch.addEventListener("input", function() {
      var query = sidebarSearch.value.trim();
      if (sidebarSearchTimer) clearTimeout(sidebarSearchTimer);
      if (query.length < 2) {
        renderSessionList(sidebarSessionsData);
        return;
      }
      sidebarSearchTimer = setTimeout(function() {
        performSearch(query);
      }, 400);
    });
  }

  function performSearch(query) {
    var serverUrl = resolveServerUrl();
    if (!serverUrl) return;
    fetch(serverUrl + "/api/search?q=" + encodeURIComponent(query) + "&session=all", { credentials: "same-origin" })
      .then(function(res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function(data) {
        renderSearchResults(data.results || [], query);
      })
      .catch(function(err) {
        console.warn("[Scratchy] Search failed:", err);
      });
  }

  function renderSearchResults(results, query) {
    sidebarSessions.innerHTML = "";
    if (results.length === 0) {
      sidebarSessions.innerHTML = '<div class="search-no-results">No results found</div>';
      return;
    }

    var escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var highlightRe = new RegExp("(" + escaped + ")", "gi");

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var div = document.createElement("div");
      div.className = "search-result-item";

      var parts = r.sessionKey.split(":");
      var label = parts[parts.length - 1] || r.sessionKey;

      var highlighted = escapeHtml(r.text).replace(highlightRe, "<mark>$1</mark>");

      div.innerHTML =
        '<div class="search-result-session">' + escapeHtml(label) + ' · ' + escapeHtml(r.role) + '</div>' +
        '<div class="search-result-text">' + highlighted + '</div>';

      div.setAttribute("data-session-key", r.sessionKey);
      div.addEventListener("click", (function(key) {
        return function() {
          switchToSession(key);
          sidebarSearch.value = "";
          renderSessionList(sidebarSessionsData);
        };
      })(r.sessionKey));

      sidebarSessions.appendChild(div);
    }
  }

  // ------------------------------------------
  // Image attachments state
  // ------------------------------------------
  var pendingAttachments = [];
  var MAX_ATTACHMENTS = 5;
  var MAX_FILE_SIZE = 10 * 1024 * 1024;

  function generateAttachId() {
    return "att-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  }

  function compressImage(file, callback) {
    var img = new Image();
    var reader = new FileReader();
    reader.onload = function(e) {
      img.onload = function() {
        var MAX_DIM = 1600;
        var w = img.width;
        var h = img.height;
        if (w > MAX_DIM || h > MAX_DIM) {
          if (w > h) {
            h = Math.round(h * MAX_DIM / w);
            w = MAX_DIM;
          } else {
            w = Math.round(w * MAX_DIM / h);
            h = MAX_DIM;
          }
        }
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL("image/jpeg", 0.80);
        var originalKB = (file.size / 1024).toFixed(0);
        var compressedKB = (dataUrl.length * 3 / 4 / 1024).toFixed(0);
        console.log("[Scratchy] Image compressed: " + originalKB + "KB -> ~" + compressedKB + "KB (" + w + "x" + h + ")");
        callback(dataUrl, "image/jpeg");
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  var FILE_TYPE_ICONS = {
    "application/pdf": "📄",
    "text/plain": "📝",
    "text/markdown": "📝",
    "text/csv": "📊",
    "text/x-python": "🐍",
    "text/javascript": "⚡",
    "application/json": "🔧",
    "text/x-rust": "🦀",
    "text/yaml": "📋",
    "text/xml": "📋",
    "application/zip": "📦",
  };

  function getFileIcon(mimeType) {
    return FILE_TYPE_ICONS[mimeType] || "📎";
  }

  function addAttachment(file) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      console.warn("[Scratchy] Max attachments reached (" + MAX_ATTACHMENTS + ")");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      console.warn("[Scratchy] File too large: " + file.name + " (" + (file.size / 1024 / 1024).toFixed(1) + " MB)");
      return;
    }

    var isImage = file.type.startsWith("image/");
    var att = { id: generateAttachId(), mimeType: file.type, file: file, dataUrl: null, isImage: isImage, fileName: file.name };
    pendingAttachments.push(att);

    if (isImage) {
      compressImage(file, function(dataUrl, mimeType) {
        att.dataUrl = dataUrl;
        att.mimeType = mimeType;
        renderAttachmentPreview();
      });
    } else {
      var reader = new FileReader();
      reader.onload = function(e) {
        att.dataUrl = e.target.result;
        renderAttachmentPreview();
      };
      reader.readAsDataURL(file);
    }
  }

  function removeAttachment(id) {
    pendingAttachments = pendingAttachments.filter(function(a) { return a.id !== id; });
    renderAttachmentPreview();
  }

  function clearAttachments() {
    pendingAttachments = [];
    renderAttachmentPreview();
    fileInput.value = "";
  }

  function renderAttachmentPreview() {
    if (pendingAttachments.length === 0) {
      attachmentPreview.style.display = "none";
      attachmentPreview.innerHTML = "";
      return;
    }

    attachmentPreview.style.display = "flex";
    attachmentPreview.innerHTML = "";

    for (var i = 0; i < pendingAttachments.length; i++) {
      var att = pendingAttachments[i];
      var thumb = document.createElement("div");
      thumb.className = "attachment-thumb";

      if (att.isImage && att.dataUrl) {
        var img = document.createElement("img");
        img.src = att.dataUrl;
        img.alt = "attachment";
        thumb.appendChild(img);
      } else {
        thumb.classList.add("file-thumb");
        var iconSpan = document.createElement("span");
        iconSpan.className = "file-icon";
        iconSpan.textContent = getFileIcon(att.mimeType);
        thumb.appendChild(iconSpan);
        var nameSpan = document.createElement("span");
        nameSpan.className = "file-name";
        nameSpan.textContent = att.fileName || "file";
        thumb.appendChild(nameSpan);
      }

      var removeBtn = document.createElement("button");
      removeBtn.className = "attachment-remove";
      removeBtn.innerHTML = "✕";
      removeBtn.title = "Remove";
      removeBtn.setAttribute("data-att-id", att.id);
      removeBtn.addEventListener("click", (function(attId) {
        return function(e) {
          e.stopPropagation();
          removeAttachment(attId);
        };
      })(att.id));
      thumb.appendChild(removeBtn);

      attachmentPreview.appendChild(thumb);
    }
  }

  function buildAttachmentsPayload() {
    var result = [];
    for (var i = 0; i < pendingAttachments.length; i++) {
      var att = pendingAttachments[i];
      if (!att.dataUrl) continue;
      var b64 = att.dataUrl.replace(/^data:[^;]+;base64,/, "");
      if (att.isImage) {
        result.push({ type: "image", mimeType: att.mimeType, content: b64 });
      } else {
        result.push({ type: "file", mimeType: att.mimeType, content: b64, fileName: att.fileName || "file" });
      }
    }
    return result;
  }

  if (attachBtn) {
    attachBtn.addEventListener("click", function() { fileInput.click(); });
  }

  if (fileInput) {
    fileInput.addEventListener("change", function() {
      var files = fileInput.files;
      for (var i = 0; i < files.length; i++) {
        addAttachment(files[i]);
      }
      fileInput.value = "";
    });
  }

  var inputArea = document.getElementById("input-area");
  if (inputArea) {
    inputArea.addEventListener("dragover", function(e) {
      e.preventDefault();
      inputArea.style.borderColor = "var(--accent)";
    });
    inputArea.addEventListener("dragleave", function() {
      inputArea.style.borderColor = "";
    });
    inputArea.addEventListener("drop", function(e) {
      e.preventDefault();
      inputArea.style.borderColor = "";
      var files = e.dataTransfer.files;
      for (var i = 0; i < files.length; i++) {
        addAttachment(files[i]);
      }
    });
  }

  messageInput.addEventListener("paste", function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        var file = items[i].getAsFile();
        if (file) addAttachment(file);
      }
    }
  });

  // ------------------------------------------
  // Voice recording
  // ------------------------------------------
  var micBtn = document.getElementById("mic-btn");
  var mediaRecorder = null;
  var audioChunks = [];
  var recordingStartTime = null;
  var recordingTimer = null;
  var recordingIndicator = null;
  var MAX_RECORDING_SECONDS = 120;

  function startRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") return;

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      var mimeType = "audio/webm;codecs=opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "audio/webm";
      if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "audio/mp4";
      if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "";

      var options = mimeType ? { mimeType: mimeType } : {};
      mediaRecorder = new MediaRecorder(stream, options);
      audioChunks = [];
      recordingStartTime = Date.now();

      mediaRecorder.ondataavailable = function(e) {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = function() {
        stream.getTracks().forEach(function(t) { t.stop(); });
        hideRecordingIndicator();

        var duration = (Date.now() - recordingStartTime) / 1000;
        if (duration < 0.5) {
          console.log("[Scratchy] Recording too short, ignoring");
          micBtn.classList.remove("recording");
          return;
        }

        var blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        console.log("[Scratchy] Recorded " + duration.toFixed(1) + "s, " + (blob.size / 1024).toFixed(0) + "KB");
        micBtn.classList.remove("recording");
        transcribeAndSend(blob);
      };

      mediaRecorder.start(250);
      micBtn.classList.add("recording");
      showRecordingIndicator();

      recordingTimer = setTimeout(function() {
        if (mediaRecorder && mediaRecorder.state === "recording") {
          stopRecording();
        }
      }, MAX_RECORDING_SECONDS * 1000);

    }).catch(function(err) {
      console.error("[Scratchy] Mic access denied:", err.message);
    });
  }

  function stopRecording() {
    if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }

  function cancelRecording() {
    if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      audioChunks = [];
      recordingStartTime = Date.now();
      mediaRecorder.stop();
    }
    micBtn.classList.remove("recording");
    hideRecordingIndicator();
  }

  function showRecordingIndicator() {
    hideRecordingIndicator();
    recordingIndicator = document.createElement("div");
    recordingIndicator.className = "recording-indicator";
    recordingIndicator.innerHTML =
      '<span class="recording-dot"></span>' +
      '<span class="recording-timer">0:00</span>' +
      '<span class="recording-label">Recording...</span>' +
      '<button class="recording-cancel">Cancel</button>';

    var cancelBtn = recordingIndicator.querySelector(".recording-cancel");
    cancelBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      cancelRecording();
    });

    var inputRow = document.querySelector(".input-row");
    inputRow.parentNode.insertBefore(recordingIndicator, inputRow);

    var timerEl = recordingIndicator.querySelector(".recording-timer");
    var timerInterval = setInterval(function() {
      if (!recordingIndicator || !recordingIndicator.parentNode) {
        clearInterval(timerInterval);
        return;
      }
      var elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      var min = Math.floor(elapsed / 60);
      var sec = elapsed % 60;
      timerEl.textContent = min + ":" + (sec < 10 ? "0" : "") + sec;
    }, 1000);
  }

  function hideRecordingIndicator() {
    if (recordingIndicator && recordingIndicator.parentNode) {
      recordingIndicator.remove();
    }
    recordingIndicator = null;
  }

  function transcribeAndSend(blob) {
    micBtn.classList.add("transcribing");
    micBtn.textContent = "⏳";

    // Pass user's language preference as a hint for Whisper accuracy
    var sttLang = localStorage.getItem("scratchy_lang") || "";
    var transcribeUrl = "/api/transcribe" + (sttLang ? "?lang=" + encodeURIComponent(sttLang) : "");

    fetch(transcribeUrl, {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      credentials: "same-origin",
      body: blob,
    })
      .then(function(res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function(data) {
        micBtn.classList.remove("transcribing");
        micBtn.textContent = "🎤";

        if (!data.text || data.empty) {
          console.log("[Scratchy] Empty transcription, ignoring");
          return;
        }

        if (!welcomeCleared) {
          renderer.clearWelcome();
          welcomeCleared = true;
        }

        var text = "🎤 " + data.text;
        store.ingest({
          role: "user",
          text: text,
          source: "local",
          timestamp: new Date().toISOString()
        });
        var voiceSendText = SCRATCHY_GENUI_ENABLED ? data.text + "\n[genui:on]" : data.text;
        connection.send(voiceSendText);
        startActivityTimer();
      })
      .catch(function(err) {
        console.error("[Scratchy] Transcription failed:", err);
        micBtn.classList.remove("transcribing");
        micBtn.textContent = "🎤";
        renderer.renderSystemMessage("⚠️ Voice transcription failed: " + err.message);
      });
  }

  if (micBtn) {
    micBtn.addEventListener("click", function() {
      if (micBtn.classList.contains("transcribing")) return;
      if (mediaRecorder && mediaRecorder.state === "recording") {
        stopRecording();
      } else {
        startRecording();
      }
    });
  }

  // ------------------------------------------
  // Reload button
  // ------------------------------------------
  if (reloadBtn) {
    reloadBtn.addEventListener("click", function() {
      location.reload();
    });
  }

  // ------------------------------------------
  // Auto-speech toggle
  // ------------------------------------------
  var autoSpeechBtn = document.getElementById("auto-speech-toggle");
  if (autoSpeechBtn) {
    autoSpeechBtn.textContent = SCRATCHY_AUTO_SPEECH ? "🔊 Auto" : "🔇";
    autoSpeechBtn.classList.toggle("active", SCRATCHY_AUTO_SPEECH);

    autoSpeechBtn.addEventListener("click", function() {
      SCRATCHY_AUTO_SPEECH = !SCRATCHY_AUTO_SPEECH;
      try { localStorage.setItem("scratchy_auto_speech", SCRATCHY_AUTO_SPEECH); } catch(e) {}
      autoSpeechBtn.textContent = SCRATCHY_AUTO_SPEECH ? "🔊 Auto" : "🔇";
      autoSpeechBtn.classList.toggle("active", SCRATCHY_AUTO_SPEECH);
      console.log("[Scratchy] Auto-speech:", SCRATCHY_AUTO_SPEECH ? "on" : "off");
    });
  }

  // ------------------------------------------
  // GenUI toggle
  // ------------------------------------------
  if (genuiToggle) {
    genuiToggle.addEventListener("click", function() {
      SCRATCHY_GENUI_ENABLED = !SCRATCHY_GENUI_ENABLED;
      genuiToggle.textContent = SCRATCHY_GENUI_ENABLED ? "✨ GenUI" : "📝 Text";
      genuiToggle.classList.toggle("off", !SCRATCHY_GENUI_ENABLED);
      console.log("[Scratchy] Generative UI:", SCRATCHY_GENUI_ENABLED ? "on" : "off");
    });
  }

  // ------------------------------------------
  // Sidebar settings wiring
  // ------------------------------------------
  var sidebarGenuiBtn = document.getElementById("sidebar-genui-toggle");
  var genuiState = document.getElementById("genui-state");
  var sidebarSpeechBtn = document.getElementById("sidebar-speech-toggle");
  var speechState = document.getElementById("speech-state");

  if (genuiState) genuiState.textContent = SCRATCHY_GENUI_ENABLED ? "ON" : "OFF";
  if (speechState) speechState.textContent = SCRATCHY_AUTO_SPEECH ? "ON" : "OFF";

  if (sidebarGenuiBtn) {
    sidebarGenuiBtn.addEventListener("click", function() {
      if (genuiToggle) genuiToggle.click(); // trigger existing handler
      if (genuiState) genuiState.textContent = SCRATCHY_GENUI_ENABLED ? "ON" : "OFF";
    });
  }
  if (sidebarSpeechBtn) {
    sidebarSpeechBtn.addEventListener("click", function() {
      if (autoSpeechBtn) autoSpeechBtn.click(); // trigger existing handler
      if (speechState) speechState.textContent = SCRATCHY_AUTO_SPEECH ? "ON" : "OFF";
    });
  }
  // Theme toggle (dark/light)
  var sidebarThemeBtn = document.getElementById("sidebar-theme-toggle");
  var themeState = document.getElementById("theme-state");
  var isDarkMode = localStorage.getItem("scratchy_theme") !== "light";
  if (!isDarkMode) document.body.classList.add("light-mode");
  if (themeState) themeState.textContent = isDarkMode ? "Dark" : "Light";
  if (sidebarThemeBtn) {
    sidebarThemeBtn.addEventListener("click", function() {
      document.body.classList.toggle("light-mode");
      var isLight = document.body.classList.contains("light-mode");
      localStorage.setItem("scratchy_theme", isLight ? "light" : "dark");
      if (themeState) themeState.textContent = isLight ? "Light" : "Dark";
    });
  }

  // ------------------------------------------
  // Admin dashboard button (visible for admin role only)
  // ------------------------------------------
  var sidebarAdminBtn = document.getElementById("sidebar-admin-btn");
  // Show admin button when server sends user-info with role=admin
  // Server-driven view switching (e.g. after onboarding dismiss)
  window._scratchySwitchView = function(view) {
    if (view === 'chat' || view === 'canvas') {
      // If workspace tab is active, switch to chat tab first
      var activeTab = typeof window._scratchyActiveTab === 'function' ? window._scratchyActiveTab() : undefined;
      if (activeTab === 'workspace' && typeof window._scratchySwitchToChat === 'function') {
        window._scratchySwitchToChat();
      }
      switchView(view);
    }
  };

  var sidebarAccountBtn = document.getElementById("sidebar-account-btn");
  var sidebarLogoutBtn = document.getElementById("sidebar-logout-btn");

  window._scratchyShowAdminIfNeeded = function(userInfo) {
    if (sidebarAdminBtn && userInfo && userInfo.role === 'admin') {
      sidebarAdminBtn.style.display = '';
    }
    // Show account button for non-admin users (operators, viewers)
    if (sidebarAccountBtn && userInfo && userInfo.role !== 'admin') {
      sidebarAccountBtn.style.display = '';
    }
    // Always show logout button for authenticated users
    if (sidebarLogoutBtn && userInfo) {
      sidebarLogoutBtn.style.display = '';
    }
    // Store role for command palette filtering
    window._scratchyUserRole = userInfo ? userInfo.role : null;
  };
  if (sidebarAdminBtn) {
    // Click → send admin-dashboard widget-action
    sidebarAdminBtn.addEventListener("click", function() {
      if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
        // Clear any dismiss suppression for admin prefix
        if (_dismissedPrefixes['admin']) {
          delete _dismissedPrefixes['admin'];
          try { localStorage.setItem('scratchy-dismissed-widgets', JSON.stringify(_dismissedPrefixes)); } catch(e) {}
        }
        connection.ws.send(JSON.stringify({
          type: "widget-action",
          sessionKey: connection.sessionKey,
          data: { surfaceId: 'main', componentId: 'sidebar', action: 'admin-dashboard', context: {} },
          timestamp: Date.now()
        }));
      }
      // Switch to chat tab so widget response is visible
      if (window._scratchySwitchToChat) window._scratchySwitchToChat();
      // Close sidebar (use existing function which also removes body.sidebar-open)
      closeSidebar();
    });
  }

  // Account button (non-admin users)
  if (sidebarAccountBtn) {
    sidebarAccountBtn.addEventListener("click", function() {
      if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
        if (_dismissedPrefixes['account']) {
          delete _dismissedPrefixes['account'];
          try { localStorage.setItem('scratchy-dismissed-widgets', JSON.stringify(_dismissedPrefixes)); } catch(e) {}
        }
        connection.ws.send(JSON.stringify({
          type: "widget-action",
          sessionKey: connection.sessionKey,
          data: { surfaceId: 'main', componentId: 'sidebar', action: 'account-profile', context: {} },
          timestamp: Date.now()
        }));
      }
      if (window._scratchySwitchToChat) window._scratchySwitchToChat();
      closeSidebar();
    });
  }

  // Logout button
  if (sidebarLogoutBtn) {
    sidebarLogoutBtn.addEventListener("click", function() {
      if (confirm('Log out of Scratchy?')) {
        // Clear localStorage
        localStorage.removeItem('scratchy_session');
        localStorage.removeItem('scratchy_token');
        // Server clears HttpOnly cookies
        fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
          .finally(function() { window.location.href = '/login-v2.html'; });
      }
    });
  }

  // ------------------------------------------
  // Utility functions
  // ------------------------------------------

  // Strip metadata tags that OpenClaw adds to messages
  function cleanMetadata(text) {
    return (text || "")
      .replace(/\[SecurityPlugin Canary\][^\n]*/g, "")
      .replace(/\n?\[message_id:[^\]]*\]/g, "")
      .replace(/\n?\[genui:\w+\]/g, "")
      .replace(/^\[SecurityPlugin[ :L][^\n]*/gm, "")
      .replace(/\[securityplugin:source=[^\]]*\]/g, "")
      .trim();
  }

  // Get raw text from a message element for dedup
  function getMsgRawText(el) {
    var raw = el.getAttribute("data-raw-text");
    if (raw) return raw;
    var body = el.querySelector(".message-body");
    return body ? body.textContent : "";
  }

  function simpleHash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xFFFFFFFF;
    }
    return hash.toString(36);
  }

  function normalizePreview(text) {
    var normalized = cleanMetadata(text).replace(/\s+/g, " ").trim();
    return simpleHash(normalized);
  }

  // Filter system/internal messages that shouldn't render in chat
  function isSystemMessage(text) {
    if (!text) return true;
    var t = text.trim().replace(/^\[SecurityPlugin Canary\][^\n]*\n?/, "").trim();
    if (!t) return true;
    return t.startsWith("[SecurityPlugin L") ||
           t.startsWith("[SecurityPlugin:") ||
           /^System:\s*\[/m.test(t) ||
           t.startsWith("GatewayRestart:") ||
           t.indexOf("[securityplugin:source=") !== -1 ||
           t === "HEARTBEAT_OK" ||
           t === "NO_REPLY" ||
           t.startsWith("Read HEARTBEAT.md") ||
           t.startsWith("A background task ") ||
           t.indexOf("Summarize this naturally") !== -1 ||
           t.indexOf("sessionKey agent:main:subagent:") !== -1 ||
           t.startsWith("Pre-compaction memory flush") ||
           t.startsWith("The conversation history before this point was compacted");
  }

  // ------------------------------------------
  // Strip gateway-injected prefixes from user message text
  // Mirrors server-side cleanSystemMetadata
  // ------------------------------------------
  function cleanGatewayText(text) {
    return (text || "")
      .replace(/\[SecurityPlugin Memory\] Auto-recalled[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |$)/g, "")
      .replace(/\[SecurityPlugin Canary\][^\n]*/g, "")
      .replace(/^Note: The previous agent run was aborted[^\n]*\n?/gm, "")
      .replace(/\n?\[message_id:[^\]]*\]/g, "")
      .replace(/\n?\[genui:\w+\]/g, "")
      .replace(/^\s*\n/gm, "")
      .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[^\]]*\]\s*/g, "")
      .trim();
  }

  // ------------------------------------------
  // Activity timer + safety timer
  // ------------------------------------------
  let activityTimer = null;

  function startActivityTimer() {
    clearActivityTimer();
    activityTimer = setTimeout(function() {
      renderer.showActivity({ type: "thinking", phase: "start" });
    }, 1500);
  }

  function clearActivityTimer() {
    if (activityTimer) {
      clearTimeout(activityTimer);
      activityTimer = null;
    }
  }

  function resetSafetyTimer() {
    if (activitySafetyTimer) clearTimeout(activitySafetyTimer);
    activitySafetyTimer = setTimeout(function() {
      console.log("[Scratchy] Safety timeout — finalizing stuck streaming");
      renderer.hideActivity();
      // Finalize (not delete) any orphaned streaming message
      var last = store.messages[store.messages.length - 1];
      if (last && last.streaming) {
        store.finalizeStreaming(last.text);
      }
    }, 60000);
  }

  function clearSafetyTimer() {
    if (activitySafetyTimer) {
      clearTimeout(activitySafetyTimer);
      activitySafetyTimer = null;
    }
  }

  // ------------------------------------------
  // Connection callbacks
  // ------------------------------------------

  connection.onStatusChange = function(status) {
    statusEl.textContent = status;
    statusEl.className = "status " + status;
    var isConnected = status === "connected";
    messageInput.disabled = false;
    sendBtn.disabled = false;
    attachBtn.disabled = !isConnected;
    micBtn.disabled = !isConnected;

    if (isConnected) {
      renderer.hideActivity();
      clearSafetyTimer();
      clearActivityTimer();
      var orphan = document.getElementById("streaming-message");
      if (orphan) orphan.remove();

      // Ensure store knows the current session
      if (!store._sessionKey) {
        store._sessionKey = SCRATCHY_CONFIG.sessionKey;
      }

      if (!historyLoaded) {
        historyLoaded = true;
        _updateLoadingStatus("Loading messages", "Fetching conversation history");
        loadChatHistory();
        // Safety: if no messages appear within 5s, retry history load
        setTimeout(function() {
          // Check BOTH store AND DOM — store may have messages that DOMSync hasn't rendered yet
          var hasContent = store.messages.length > 0 ||
                           messagesContainer.querySelectorAll(".message").length > 0;
          if (!hasContent) {
            console.log("[Scratchy] ⚠️ No messages after 5s — retrying history load");
            _updateLoadingStatus("Retrying", "First attempt took too long");
            historyLoaded = false;
            loadChatHistory();
          }
        }, 5000);
        // Post-OAuth auto-trigger: if we just came from Google auth, fire the widget
        // Must check BEFORE onboarding — post-auth overrides the onboarding start
        var postAuthWidget = null;
        try { postAuthWidget = localStorage.getItem("scratchy-post-auth-widget"); } catch(e) {}
        if (postAuthWidget) {
          localStorage.removeItem("scratchy-post-auth-widget");
          setTimeout(function() {
            console.log("[Scratchy] Post-auth auto-trigger:", postAuthWidget);
            if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
              connection.ws.send(JSON.stringify({
                type: "widget-action",
                sessionKey: connection.sessionKey,
                data: { surfaceId: 'main', componentId: 'auto', action: postAuthWidget, context: {} },
                timestamp: Date.now()
              }));
            }
          }, 1000);
        } else {
          // Only check onboarding if no post-auth widget is pending
          checkOnboarding();
        }
      }
    }
  };

  connection.onReconnected = function() {
    console.log("[Scratchy] Reconnected — catching up missed messages");
    // Clear stale dismiss state — reconnect means fresh server state
    _dismissedPrefixes = {};
    // Clear any stale activity state from the previous connection
    clearActivityTimer();
    clearSafetyTimer();
    renderer.hideActivity();
    _supplementWithGatewayHistory();
  };

  // Re-ingest queued messages into store if store was cleared (DOM purge during offline)
  connection.onQueueReplay = function(msg) {
    var existing = store._idIndex.get(msg.id);
    if (!existing) {
      // Store was cleared — re-ingest so the user sees their queued message
      var displayText = (msg.text || "").replace(/\n\[genui:on\]$/, "");
      if (displayText) {
        console.log("[Scratchy] Re-ingesting queued message into store: " + msg.id);
        store.ingest({
          role: "user",
          text: displayText,
          source: "local",
          status: "sending",
          id: msg.id,
          timestamp: msg.ts ? new Date(msg.ts).toISOString() : new Date().toISOString()
        });
      }
    }
  };

  // Track message status updates (sending → sent → failed)
  connection.onMessageStatus = function(messageId, status) {
    store.updateStatus(messageId, status);
  };

  connection.onQueueDrained = function() {
    // Update all queued messages in the store to "sent"
    var hadQueued = false;
    for (var i = 0; i < store.messages.length; i++) {
      if (store.messages[i].status === "queued" || store.messages[i].status === "sending") {
        store.updateStatus(store.messages[i].id, "sent");
        hadQueued = true;
      }
    }
    // Only show activity if messages were actually drained (agent will respond)
    // Empty queue drain (reconnect with nothing pending) should NOT trigger thinking indicator
    if (hadQueued) startActivityTimer();
  };

  connection.onSendError = function(error, messageId) {
    // Mark the original message as failed in the store
    if (messageId) store.updateStatus(messageId, "failed");

    // Add error as a system message — store handles ordering
    var errorText = (error && error.message) || "Message failed to send";
    store.ingest({
      role: "system",
      text: "⚠️ Send failed: " + errorText,
      source: "local"
    });

    clearActivityTimer();
  };

  connection.onRemoteUserMessage = function(message) {
    console.log("[Scratchy] Remote user message:", message.text.slice(0, 50));
    if ((connection._isSystemNoise && connection._isSystemNoise(message.text)) || isSystemMessage(message.text)) {
      console.log("[Scratchy] Filtered system noise from remote user message");
      return;
    }

    if (!welcomeCleared) {
      renderer.clearWelcome();
      welcomeCleared = true;
    }

    // Clean gateway-injected prefixes and store (dedup via contentHash)
    var cleanText = cleanGatewayText(message.text);
    if (!cleanText) return;
    store.ingest({
      role: message.role || "user",
      text: cleanText,
      source: message.source || "remote",
      timestamp: message.timestamp
    });
  };

  connection.onAgentActivity = function(activity) {
    clearActivityTimer();
    _clearPostDeltaTimer();
    if (activity.type === "done") {
      renderer.hideActivity();
      clearSafetyTimer();
    } else {
      renderer.showActivity(activity);
      resetSafetyTimer();
    }

    // Real-time TTS phase tracking
    if (SCRATCHY_AUTO_SPEECH) {
      if (activity.type === "thinking" && activity.phase === "start") {
        // New agent turn starting — reset TTS state
        if (typeof resetRealtimeTTS === "function") resetRealtimeTTS();
      } else if (activity.type === "tool") {
        // Tool event seen — mark tools phase so TTS knows final answer comes after
        if (typeof signalRealtimeTTSToolsSeen === "function") signalRealtimeTTSToolsSeen();
      }
    }
  };

  connection.onMessage = function(message) {
    clearActivityTimer();
    _clearPostDeltaTimer();
    clearSafetyTimer();
    renderer.hideActivity();

    if (isSystemMessage(message.text)) return;

    if (!welcomeCleared) {
      renderer.clearWelcome();
      welcomeCleared = true;
    }

    if (streamingEnabled) {
      // Try to finalize a streaming message first
      var finalized = store.finalizeStreaming(message.text);
      if (!finalized) {
        // No streaming message existed — ingest as a new complete message
        store.ingest({
          role: "assistant",
          text: message.text,
          source: message.source || "stream",
          timestamp: message.timestamp,
          streaming: false
        });
      }
    } else {
      store.ingest({
        role: "assistant",
        text: message.text,
        source: message.source || "stream",
        timestamp: message.timestamp,
        streaming: false
      });
    }
  };

  var _postDeltaTimer = null;
  function _clearPostDeltaTimer() {
    if (_postDeltaTimer) { clearTimeout(_postDeltaTimer); _postDeltaTimer = null; }
  }

  connection.onStreamDelta = function(message) {
    clearActivityTimer();
    _clearPostDeltaTimer();
    resetSafetyTimer(); // Reset safety timer on deltas to prevent killing long streams
    if (!streamingEnabled) return;
    renderer.hideActivity();

    // Re-show activity if no new delta/tool/final arrives within 2s
    // Covers the "text:" → tool call gap where user sees nothing
    _postDeltaTimer = setTimeout(function() {
      _postDeltaTimer = null;
      if (connection._runActive) {
        renderer.showActivity({ type: "thinking", phase: "start" });
      }
    }, 2000);

    if (!welcomeCleared) {
      renderer.clearWelcome();
      welcomeCleared = true;
    }

    // Try to update existing streaming message, or create a new one
    var existing = store.updateStreaming(message.text);
    if (!existing) {
      store.ingest({
        role: "assistant",
        text: message.text,
        source: "stream",
        streaming: true
      });
    }

    // Real-time TTS: feed sentence-buffered TTS (only during answer phase)
    if (SCRATCHY_AUTO_SPEECH && typeof feedRealtimeTTS === "function") {
      if (typeof signalRealtimeTTSTextDelta === "function") {
        signalRealtimeTTSTextDelta(message.text.length);
      }
      feedRealtimeTTS(message.text);
    }
  };

  // When a run ends (lifecycle.end synthesized), finalize any streaming msg
  connection.onRunEnd = function() {
    var last = store.messages[store.messages.length - 1];
    if (last && last.streaming) {
      store.finalizeStreaming(last.text);
    }
  };

  // ------------------------------------------
  // Send button
  // ------------------------------------------

  sendBtn.addEventListener("click", function() {
    var text = messageInput.value.trim();
    var hasAttachments = pendingAttachments.length > 0;
    if (text === "" && !hasAttachments) return;

    if (!welcomeCleared) {
      renderer.clearWelcome();
      welcomeCleared = true;
    }

    var attachments = hasAttachments ? buildAttachmentsPayload() : null;

    // Build image/file data for the store
    var imageDataUrls = null;
    var fileAttachmentsList = null;
    if (hasAttachments) {
      imageDataUrls = pendingAttachments
        .filter(function(a) { return a.dataUrl && a.isImage; })
        .map(function(a) { return a.dataUrl; });
      if (imageDataUrls.length === 0) imageDataUrls = null;
      fileAttachmentsList = pendingAttachments
        .filter(function(a) { return a.dataUrl && !a.isImage; })
        .map(function(a) { return { name: a.fileName, icon: getFileIcon(a.mimeType) }; });
      if (fileAttachmentsList.length === 0) fileAttachmentsList = null;
    }

    var wasQueued = !connection.connected || !connection.handshakeComplete;

    // Ingest into store — DOMSync handles rendering
    var ingestedMsg = store.ingest({
      role: "user",
      text: text,
      source: "local",
      status: wasQueued ? "queued" : "sending",
      images: imageDataUrls,
      fileAttachments: fileAttachmentsList,
      timestamp: new Date().toISOString()
    });

    // messageId tracked by store — onSendError uses store.updateStatus()

    // Clean up any existing streaming bubble before new send
    var streamingMsg = store.messages.find(function(m) { return m.streaming; });
    if (streamingMsg) {
      if (streamingMsg.text) {
        store.finalizeStreaming(streamingMsg.text);
      } else if (streamingMsg.el) {
        streamingMsg.el.remove();
        // Remove from store
        var sIdx = store.messages.indexOf(streamingMsg);
        if (sIdx !== -1) store.messages.splice(sIdx, 1);
        store._hashIndex.delete(streamingMsg.contentHash);
        store._idIndex.delete(streamingMsg.id);
      }
    }

    // Append genui tag so the agent knows to use interactive components
    var sendText = text;
    if (SCRATCHY_GENUI_ENABLED) {
      sendText = text + "\n[genui:on]";
    }

    var messageId = connection.send(sendText, attachments);

    // Link connection messageId to store message for status tracking (Bug 5 fix)
    if (ingestedMsg && messageId && messageId !== ingestedMsg.id) {
      store._idIndex.set(messageId, ingestedMsg);
    }

    // Phase 29: Show contextual activity indicator for image uploads
    if (hasAttachments && imageDataUrls && imageDataUrls.length > 0) {
      renderer.showActivity({ type: "tool", name: "image", phase: "start", detail: { message: "Analyzing your photo" } });
    }

    // Show skeleton tiles on canvas for instant feedback
    if (currentView === "canvas") _showSkeletons();

    if (wasQueued && ingestedMsg) {
      store.updateStatus(ingestedMsg.id, "queued");
    } else {
      startActivityTimer();
    }

    clearAttachments();
    messageInput.value = "";
    messageInput.style.height = "auto";
    messageInput.focus();
  });

  // ------------------------------------------
  // Keyboard & input handlers
  // ------------------------------------------

  messageInput.addEventListener("keydown", function(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendBtn.click();
    }
  });

  messageInput.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 150) + "px";
  });

  // Recapture focus to input when typing anywhere outside an input/textarea
  // Recapture focus to input when typing anywhere outside an input/textarea.
  // Disabled on touch devices — programmatic focus() triggers the virtual keyboard,
  // and touch users tap the input directly when they want to type.
  var _isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (!_isTouchDevice) {
    document.addEventListener("keydown", function(e) {
      var tag = (e.target.tagName || "").toLowerCase();
      var isInputEl = tag === "input" || tag === "textarea" || e.target.isContentEditable;
      if (!isInputEl && e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        messageInput.focus();
        var start = messageInput.selectionStart;
        var end = messageInput.selectionEnd;
        var val = messageInput.value;
        messageInput.value = val.substring(0, start) + e.key + val.substring(end);
        messageInput.selectionStart = messageInput.selectionEnd = start + 1;
        messageInput.dispatchEvent(new Event("input"));
      }
    }, true);
  }

  // Auto-detect pasted code and wrap in a code block
  messageInput.addEventListener("paste", function(e) {
    setTimeout(function() {
      var text = messageInput.value;
      if (text.indexOf("```") !== -1) return;
      var lines = text.split("\n");
      if (lines.length < 3) return;
      var codeSignals = 0;
      var patterns = [
        /[{};]$/m,
        /^\s{2,}/m,
        /^(fn |let |const |var |import |from |def |class |pub |use |mod |async |return )/m,
        /[=!<>]=|=>|->|\|\||&&/,
        /\(.*\)/,
        /^\s*\/\//m,
        /^\s*#\[/m,
      ];
      for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].test(text)) codeSignals++;
      }
      if (codeSignals >= 3) {
        var lang = "";
        if (/\b(fn |let mut |impl |pub fn |use |mod |::)/.test(text)) lang = "rust";
        else if (/\b(const |let |var |=>|function |require\()/.test(text)) lang = "javascript";
        else if (/\b(def |import |from |class |self\.)/.test(text)) lang = "python";
        else if (/\b(async function|await |Promise)/.test(text)) lang = "javascript";

        messageInput.value = "```" + lang + "\n" + text + "\n```";
        messageInput.style.height = "auto";
        messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + "px";
      }
    }, 0);
  });

  // ------------------------------------------
  // Onboarding check for new users
  // ------------------------------------------

  function checkOnboarding() {
    fetch('/api/v2/auth/me', { credentials: 'same-origin' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok === false) return; // not authenticated or error
        // If user needs onboarding and has no messages yet, trigger wizard
        if (data.needsOnboarding && store.messages.length === 0) {
          // Small delay to let canvas initialize
          setTimeout(function() {
            if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
              connection.ws.send(JSON.stringify({
                type: "widget-action",
                sessionKey: connection.sessionKey,
                data: { surfaceId: 'main', componentId: 'auto', action: 'onboard-start', context: {} },
                timestamp: Date.now()
              }));
            }
          }, 1000);
        }
      })
      .catch(function() { /* silent */ });
  }

  // ------------------------------------------
  // History loading
  // ------------------------------------------

  function loadChatHistory() {
    var serverUrl = resolveServerUrl();
    if (serverUrl) {
      loadFullHistory(serverUrl, function() {
        _supplementWithGatewayHistory();
      });
    } else {
      loadGatewayHistory();
    }
  }

  function _supplementWithGatewayHistory() {
    _updateLoadingStatus("Syncing", "Checking for recent messages");
    var requestSessionKey = SCRATCHY_CONFIG.sessionKey; // Capture at call time
    connection.loadHistory(function(frame) {
      if (!frame.ok || !frame.payload || !frame.payload.messages) return;

      // Guard: if session changed during fetch, discard stale results
      if (SCRATCHY_CONFIG.sessionKey !== requestSessionKey) {
        console.log("[Scratchy] Discarding stale gateway history for " + requestSessionKey);
        return;
      }

      var messages = frame.payload.messages;
      if (messages.length === 0) return;

      var added = 0;
      for (var j = 0; j < messages.length; j++) {
        var msg = messages[j];
        // Only render user and assistant messages — skip toolResult, toolCall, system
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        if (!msg.content || !Array.isArray(msg.content)) continue;

        var text = msg.content
          .filter(function(b) { return b.type === "text" && b.text; })
          .map(function(b) { return b.text; })
          .join("\n");
        if (!text) continue;
        if (isSystemMessage(text)) continue;
        if (connection._isSystemNoise && connection._isSystemNoise(text)) continue;

        // Clean gateway-injected prefixes from user messages
        if (msg.role === "user") text = cleanGatewayText(text);
        if (!text) continue;

        if (!welcomeCleared) { renderer.clearWelcome(); welcomeCleared = true; }

        // Store handles dedup via contentHash automatically
        var countBefore = store.messages.length;
        store.ingest({
          role: msg.role,
          text: text,
          source: "gateway",
          timestamp: msg.timestamp
        });
        if (store.messages.length > countBefore) {
          added++;
        }
      }

      if (added > 0) {
        console.log("[Scratchy] Supplemented " + added + " unflushed message(s) from gateway");
      }
    });
  }

  function loadFullHistory(serverUrl, onDone) {
    var requestSessionKey = SCRATCHY_CONFIG.sessionKey; // Capture at call time
    var url = serverUrl + "/api/history?session=" + encodeURIComponent(requestSessionKey);

    fetch(url, { credentials: "same-origin" })
      .then(function(res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function(data) {
        // Guard: if session changed during fetch, discard stale results
        if (SCRATCHY_CONFIG.sessionKey !== requestSessionKey) {
          console.log("[Scratchy] Discarding stale history for " + requestSessionKey);
          return;
        }
        if (!data.messages || data.messages.length === 0) {
          console.log("[Scratchy] No full history, falling back to gateway");
          loadGatewayHistory();
          return;
        }

        if (!welcomeCleared) {
          renderer.clearWelcome();
          welcomeCleared = true;
        }

        console.log("[Scratchy] Loaded " + data.messages.length + " messages from full history");
        _updateLoadingStatus("Rendering", data.messages.length + " messages");

        // Filter and transform messages for the store
        var storeMessages = [];
        for (var i = 0; i < data.messages.length; i++) {
          var msg = data.messages[i];

          if (msg.role === "compaction") {
            storeMessages.push({
              role: "compaction",
              text: "",
              timestamp: msg.timestamp || "",
              source: "history"
            });
            continue;
          }

          if (!msg.text) continue;
          if (isSystemMessage(msg.text)) continue;

          storeMessages.push({
            role: msg.role,
            text: msg.text,
            timestamp: msg.timestamp,
            source: "history"
          });
        }

        // Limit to last 200 messages to prevent browser freeze on large histories
        var MAX_RENDER = 200;
        if (storeMessages.length > MAX_RENDER) {
          // Keep compaction markers + last N messages
          var trimmed = [];
          var compactions = storeMessages.filter(function(m) { return m.role === "compaction"; });
          var regular = storeMessages.filter(function(m) { return m.role !== "compaction"; });
          trimmed = compactions.concat(regular.slice(-MAX_RENDER));
          console.log("[Scratchy] Trimmed history from " + storeMessages.length + " to " + trimmed.length + " messages");
          storeMessages = trimmed;
        }

        // Bulk load into store — replaces everything and notifies DOMSync
        store.loadHistory(storeMessages);

        // History is now in the DOM — flush any queued canvas-update events
        _historyRendered = true;
        _flushPendingCanvasUpdates();

        if (onDone) onDone();
      })
      .catch(function(err) {
        console.warn("[Scratchy] Full history failed, falling back to gateway:", err);
        loadGatewayHistory();
      });
  }

  function loadGatewayHistory(callback) {
    _updateLoadingStatus("Loading messages", "Fetching from gateway");
    connection.loadHistory(function(frame) {
      if (!frame.ok) {
        console.error("[Scratchy] Failed to load history:", frame.error);
        _historyRendered = true;
        _flushPendingCanvasUpdates();
        if (callback) callback(false);
        return;
      }

      var messages = frame.payload.messages;
      if (!messages || messages.length === 0) {
        _historyRendered = true;
        _flushPendingCanvasUpdates();
        if (callback) callback(false);
        return;
      }

      if (!welcomeCleared) {
        renderer.clearWelcome();
        welcomeCleared = true;
      }

      // Build store messages from gateway format
      var storeMessages = [];

      var sessionId = frame.payload.sessionId || "";
      var deletedMatch = sessionId.match(/\.deleted\.(\d{4}-\d{2}-\d{2})T/);
      if (deletedMatch) {
        storeMessages.push({
          role: "compaction",
          text: "",
          timestamp: deletedMatch[1],
          source: "gateway"
        });
      }

      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        // Only render user and assistant messages — skip toolResult, toolCall, system
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        if (!msg.content || !Array.isArray(msg.content)) continue;

        var text = msg.content
          .filter(function(block) { return block.type === "text" && block.text; })
          .map(function(block) { return block.text; })
          .join("\n");

        if (!text) continue;
        if (isSystemMessage(text)) continue;

        // Clean gateway-injected prefixes from user messages
        if (msg.role === "user") text = cleanGatewayText(text);
        if (!text) continue;

        storeMessages.push({
          role: msg.role,
          text: text,
          timestamp: msg.timestamp,
          source: "gateway"
        });
      }

      store.loadHistory(storeMessages);

      // History is now in the DOM — flush any queued canvas-update events
      _historyRendered = true;
      _flushPendingCanvasUpdates();

      // Collapse any widget regions created during history render —
      // they're stale snapshots, shouldn't dominate the view on reload
      var historyRegions = messagesContainer.querySelectorAll('.widget-region');
      for (var hr = 0; hr < historyRegions.length; hr++) {
        var regionBody = historyRegions[hr].querySelector('.widget-region-body');
        if (regionBody && !historyRegions[hr].classList.contains('pinned')) {
          regionBody.style.display = 'none';
          historyRegions[hr].classList.add('widget-collapsed');
          // Add a click-to-expand on the header
          (function(reg, body) {
            var header = reg.querySelector('.widget-region-header');
            if (header) {
              header.style.cursor = 'pointer';
              var chevron = document.createElement('span');
              chevron.textContent = '▸';
              chevron.className = 'widget-collapse-chevron';
              chevron.style.cssText = 'margin-right:4px;font-size:11px;color:var(--text-tertiary,#5a5f73);transition:transform 200ms ease;';
              header.insertBefore(chevron, header.firstChild);
              header.addEventListener('click', function(e) {
                if (e.target.closest('.widget-action-btn')) return; // don't interfere with action buttons
                var isCollapsed = body.style.display === 'none';
                body.style.display = isCollapsed ? '' : 'none';
                chevron.style.transform = isCollapsed ? 'rotate(90deg)' : 'rotate(0deg)';
                reg.classList.toggle('widget-collapsed', !isCollapsed);
              });
            }
          })(historyRegions[hr], regionBody);
        }
      }

      // Scroll to bottom past any collapsed history regions
      renderer._scrollToBottom();

      if (callback) callback(true);
    });
  }

  // ------------------------------------------
  // Visibility / resume handlers
  // ------------------------------------------

  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "visible") {
      console.log("[Scratchy] App resumed — checking connection health");

      renderer.hideActivity();
      clearActivityTimer();
      clearSafetyTimer();

      // Finalize any orphaned streaming bubble
      var orphanedStream = document.getElementById("streaming-message");
      if (orphanedStream) {
        var streamText = orphanedStream.getAttribute("data-stream-text") || "";
        if (streamText) {
          console.log("[Scratchy] Finalizing orphaned streaming bubble on resume (" + streamText.length + " chars)");
          renderer.finalizeStreaming(streamText);
        } else {
          console.log("[Scratchy] Removing empty streaming bubble on resume");
          orphanedStream.remove();
        }
      }

      // Check if page content was purged (mobile memory pressure)
      var hasMessages = messagesContainer.querySelectorAll(".message").length > 0;
      if (!hasMessages && historyLoaded) {
        // Don't clear if a history load is in flight (check for loading overlay)
        var isLoading = messagesContainer.querySelector('.loading-overlay');
        if (isLoading) {
          console.log("[Scratchy] DOM empty but loading overlay present — skip clear");
        } else {
          console.log("[Scratchy] Page content was purged — clearing state for clean reload");
          store.clear();
          messagesContainer.innerHTML = '';
          _activeWidgetRegion = null;
          historyLoaded = false;
          welcomeCleared = false;
        }
      }

      // If WS is clearly dead, reconnect immediately
      if (!connection.ws || connection.ws.readyState === WebSocket.CLOSED || connection.ws.readyState === WebSocket.CLOSING) {
        console.log("[Scratchy] WS is dead — reconnecting");
        connection.forceReconnect();
        return;
      }

      // WS looks alive but might be a zombie — health check
      connection.checkHealth(function(alive) {
        if (alive) {
          console.log("[Scratchy] WS confirmed alive — catching up");
          if (!historyLoaded) {
            loadChatHistory();
            historyLoaded = true;
          } else {
            _supplementWithGatewayHistory();
          }
        } else {
          console.log("[Scratchy] Zombie socket — force reconnecting");
          connection.forceReconnect();
        }
      });

      // Ultimate safety: if DOM is still empty after 3s, force a recovery
      setTimeout(function() {
        if (document.visibilityState === "visible") {
          var hasContent = messagesContainer.querySelectorAll(".message").length > 0 ||
                           messagesContainer.querySelector('.loading-overlay') ||
                           messagesContainer.querySelector('.welcome-message');
          if (!hasContent) {
            console.log("[Scratchy] ⚠️ Empty chat after resume recovery — injecting loading overlay");
            messagesContainer.innerHTML = '<div class="welcome-message loading-overlay"><div class="loading-icon">🐱</div><div class="loading-spinner"></div><div class="loading-status">Reconnecting<span class="loading-dots"></span></div></div>';
            _activeWidgetRegion = null;
            historyLoaded = false;
            welcomeCleared = false;
            if (connection.connected && connection.handshakeComplete) {
              loadChatHistory();
              historyLoaded = true;
            }
          }
        }
      }, 3000);

      if (messageInput && !messageInput.disabled) {
        setTimeout(function() { messageInput.focus(); }, 100);
      }
    }
  });

  // iOS Safari standalone: pageshow fires when restoring from bfcache
  window.addEventListener("pageshow", function(event) {
    if (event.persisted) {
      console.log("[Scratchy] Page restored from cache");
      var hasMessages = messagesContainer.querySelectorAll(".message").length > 0;
      if (!hasMessages) {
        console.log("[Scratchy] bfcache restore with empty DOM — clearing for clean reload");
        store.clear();
        messagesContainer.innerHTML = '';
        historyLoaded = false;
        welcomeCleared = false;
      }
      // Use forceReconnect to clean up old socket (not bare connect())
      connection.forceReconnect();
    }
  });

  // Dismiss message menus on click outside
  document.addEventListener("click", function(e) {
    if (!e.target.closest(".msg-menu") && !e.target.closest(".msg-actions")) {
      renderer._dismissMenus();
    }
  });

  // ------------------------------------------
  // Canvas view integration
  // ------------------------------------------
  var chatView = document.getElementById("chat-view");
  var canvasView = document.getElementById("canvas-view");
  var viewChatBtn = document.getElementById("view-chat-btn");
  var viewCanvasBtn = document.getElementById("view-canvas-btn");
  var canvasGrid = document.getElementById("canvas-grid");
  var canvasEmpty = document.getElementById("canvas-empty");
  var canvasChatPanel = document.getElementById("canvas-chat-panel");
  var canvasChatToggle = document.getElementById("canvas-chat-toggle");
  var canvasChatBody = document.getElementById("canvas-chat-body");
  var canvasChatExpand = document.getElementById("canvas-chat-expand");
  var canvasChatMessages = document.getElementById("canvas-chat-messages");
  var canvasChatInput = document.getElementById("canvas-chat-input");
  var canvasSendBtn = document.getElementById("canvas-send-btn");
  var canvasChatStatus = document.getElementById("canvas-chat-status");

  // Canvas state & renderer (classes loaded from canvas-state.js / canvas-renderer.js)
  var canvasState = new CanvasState();
  window.canvasState = canvasState;
  var canvasRenderer = null; // initialized lazily when canvas-grid exists

  // v2 Surface Manager — handles A2UI envelopes, data binding, beginRendering
  if (typeof SurfaceManager !== 'undefined') {
    SurfaceManager.init(canvasState, function(surfaceId) {
      console.log('[v2] Surface flushed:', surfaceId);
    });
  }

  // v2 Catalog — advertise supported component types
  var _canvasCatalog = null;
  (function loadCatalog() {
    fetch('/catalog/v2.json').then(function(r) { return r.json(); }).then(function(data) {
      _canvasCatalog = data;
      var types = Object.keys(data.components || data);
      console.log('[v2] Catalog loaded: ' + types.length + ' component types');
      // Store on window for external access (agent tools, dev console)
      window.__scratchyCatalog = { version: 2, types: types, full: data };
    }).catch(function() {
      console.log('[v2] Catalog not available — using built-in LiveComponents');
    });
  })();

  // v2 AG-UI Handler — bottom-right status bar REMOVED (redundant with in-chat indicator)

  // v2 Surface DOM — multi-surface containers (sidebar, overlays, toasts)
  if (typeof SurfaceDom !== 'undefined') {
    SurfaceDom.init(document.body);
  }

  // v2 UserAction — delegated click handler for [data-sui-send] buttons
  // Sends structured A2UI userAction envelope to agent
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-sui-send]');

    // Safety net: if button in a widget region has no data-sui-send, try to resolve from cached canvas state
    if (!btn) {
      var fallbackBtn = e.target.closest('button');
      if (fallbackBtn && fallbackBtn.closest('.dash-tile')) {
        var tile = fallbackBtn.closest('.dash-tile');
        var cid = tile ? tile.dataset.componentId : null;
        if (cid && canvasState && canvasState.components && canvasState.components[cid]) {
          var comp = canvasState.components[cid];
          if (comp.type === 'buttons' && comp.data && comp.data.buttons) {
            var btnText = fallbackBtn.textContent.trim();
            for (var bi = 0; bi < comp.data.buttons.length; bi++) {
              var bDef = comp.data.buttons[bi];
              if ((bDef.label || bDef.action || '') === btnText) {
                var resolvedAction = bDef.action || bDef.label;
                console.log('[SUI-FALLBACK] Resolved action from canvasState:', resolvedAction, 'for button:', btnText);
                fallbackBtn.setAttribute('data-sui-send', resolvedAction);
                btn = fallbackBtn;
                break;
              }
            }
          }
        }
      }
      if (!btn) return;
    }
    e.preventDefault();
    var action = btn.getAttribute('data-sui-send');
    // console.log('[DEBUG-CLICK] sui-send action:', action);
    var formId = btn.getAttribute('data-sui-form');
    var context = {};

    // Collect form field values if this is a form button
    if (formId) {
      var form = btn.closest('form');
      if (form) {
        var inputs = form.querySelectorAll('input, textarea, select');
        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i];
          var name = inp.name || inp.getAttribute('data-field') || ('field-' + i);
          if (inp.type === 'checkbox') context[name] = inp.checked;
          else context[name] = inp.value || '';
        }
      }
    }

    // Client-side form validation — only for primary/submit actions, skip navigation (back, logout, etc.)
    var skipValidation = /back|logout|help|sync|search|cancel|close|cal-today|cal-week|cal-month|cal-tasks|sn-list|sn-back|mail-inbox|mail-compose|mail-search-form|mail-read-/i.test(action);
    if (formId && !skipValidation) {
      var form = btn.closest('form');
      if (form) {
        var hasErrors = false;
        // Clear previous errors
        var oldErrors = form.querySelectorAll('.sui-field-error');
        for (var ei = 0; ei < oldErrors.length; ei++) oldErrors[ei].remove();
        var oldShake = form.querySelectorAll('.sui-error-shake');
        for (var si = 0; si < oldShake.length; si++) oldShake[si].classList.remove('sui-error-shake');

        var inputs = form.querySelectorAll('input[required], textarea[required], select[required]');
        for (var vi = 0; vi < inputs.length; vi++) {
          var field = inputs[vi];
          var val = (field.value || '').trim();
          var label = field.getAttribute('data-label') || field.name || 'This field';
          var errMsg = '';

          if (!val) {
            errMsg = label + ' is required';
          } else if (field.type === 'email' && val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
            errMsg = 'Please enter a valid email address';
          }

          if (errMsg) {
            hasErrors = true;
            field.classList.add('sui-error-shake');
            field.style.borderColor = '#ef4444';
            var errEl = document.createElement('div');
            errEl.className = 'sui-field-error';
            errEl.style.cssText = 'color:#ef4444;font-size:12px;margin-top:2px;margin-bottom:4px;';
            errEl.textContent = errMsg;
            field.parentNode.insertBefore(errEl, field.nextSibling);
            // Reset border after 3s
            (function(f) { setTimeout(function() { f.style.borderColor = ''; f.classList.remove('sui-error-shake'); }, 3000); })(field);
          }
        }

        if (hasErrors) {
          // Show toast-style error at top of tile
          var tile = btn.closest('.dash-tile');
          if (tile) {
            var toast = tile.querySelector('.sui-toast');
            if (!toast) {
              toast = document.createElement('div');
              toast.className = 'sui-toast';
              toast.style.cssText = 'background:#ef4444;color:white;padding:8px 12px;border-radius:6px;margin-bottom:8px;font-size:13px;text-align:center;animation:sui-fade-in 0.2s ease;';
              tile.insertBefore(toast, tile.firstChild);
            }
            toast.textContent = 'Please fill in all required fields';
            setTimeout(function() { if (toast.parentNode) toast.remove(); }, 4000);
          }
          return; // Block the action
        }
      }
    }

    // Find parent component ID and surface
    var tile = btn.closest('.dash-tile');
    var componentId = tile ? tile.dataset.componentId : 'unknown';
    var surfaceId = 'main'; // default surface

    // Merge button-level context (from data-sui-context attribute)
    var btnContext = btn.getAttribute('data-sui-context');
    if (btnContext) {
      try {
        var parsed = JSON.parse(btnContext);
        for (var k in parsed) { if (parsed.hasOwnProperty(k)) context[k] = parsed[k]; }
      } catch(e) {}
    }

    // Build A2UI-compliant userAction envelope
    var userAction = {
      surfaceId: surfaceId,
      componentId: componentId,
      action: action
    };
    if (Object.keys(context).length > 0) userAction.context = context;

    console.log('[UserAction]', action);

    // Track origin region so the response routes back to the SAME widget region
    var originRegion = btn.closest('.widget-region');
    if (originRegion) _pendingActionRegion = originRegion;

    // Clear any dismissed prefix for this action (user explicitly re-triggered)
    var actionPrefix = action.split('-')[0];
    if (actionPrefix && _dismissedPrefixes[actionPrefix]) {
      delete _dismissedPrefixes[actionPrefix];
      try { localStorage.setItem('scratchy-dismissed-widgets', JSON.stringify(_dismissedPrefixes)); } catch(e) {}
    }
    
    // Disable button + show loading state
    btn.disabled = true;
    var origLabel = btn.textContent;
    btn.textContent = '⏳ ' + origLabel.replace(/^[^\w]*/, '');
    btn.style.opacity = '0.7';

    // Cancel any in-progress streaming canvas ops (prevents race with widget response)
    StreamCanvasParser.finalize();

    // Send widget action via dedicated channel (not as chat message)
    if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify({
        type: "widget-action",
        sessionKey: connection.sessionKey,
        data: userAction,
        timestamp: Date.now()
      }));
    }

    // Clear sensitive form fields after submission (passwords, auth codes, etc.)
    if (formId) {
      var formEl = btn.closest('form');
      if (formEl) {
        var sensitiveInputs = formEl.querySelectorAll('input[type="password"], input[name="auth_code"], input[name="api_key"], input[name="secret"], input[name="token"]');
        for (var ci = 0; ci < sensitiveInputs.length; ci++) {
          sensitiveInputs[ci].value = '';
        }
      }
    }

    // Re-enable button after timeout (in case widget doesn't respond)
    setTimeout(function() {
      btn.disabled = false;
      btn.textContent = origLabel;
      btn.style.opacity = '1';
    }, 5000);
  });

  // Current view: always "chat" in unified mode (Phase 31)
  var currentView = "chat";

  // ── Phase 31: Widget Region System ──
  // Widgets render inline in the chat stream instead of a separate canvas view
  var _activeWidgetRegion = null; // The current widget region being streamed into
  var _widgetRegionCounter = 0;
  var _dismissedPrefixes = {};   // Prefix → timestamp. Suppress new regions for recently dismissed widgets.
  var _lastRenderWasUserInitiated = false; // Flag: true when ops came from user action, false for auto-push
  // Restore dismissed prefixes from localStorage (survives page refresh)
  try {
    var _storedDismissed = localStorage.getItem('scratchy-dismissed-widgets');
    if (_storedDismissed) {
      var _parsed = JSON.parse(_storedDismissed);
      for (var _dk in _parsed) {
        // Only restore if dismissed < 5 min ago (after that, allow re-trigger)
        if (_parsed[_dk] && (Date.now() - _parsed[_dk]) < 300000) {
          _dismissedPrefixes[_dk] = _parsed[_dk];
        }
      }
      if (Object.keys(_dismissedPrefixes).length > 0) {
        console.log('[Widget] Restored dismissed prefixes from localStorage:', Object.keys(_dismissedPrefixes).join(', '));
      }
    }
  } catch(e) {}
  var _pendingActionRegion = null; // Region where the last widget button was clicked — response routes here

  function createWidgetRegion(opts) {
    opts = opts || {};
    var id = opts.id || ('widget-' + (++_widgetRegionCounter) + '-' + Date.now());
    var icon = opts.icon || '📦';
    var title = opts.title || 'Widget';

    var region = document.createElement('div');
    region.className = 'widget-region';
    region.dataset.widgetId = id;
    if (opts.turnId) region.dataset.turnId = opts.turnId;

    region.innerHTML =
      '<div class="widget-region-header">' +
        '<span class="widget-region-icon">' + icon + '</span>' +
        '<span class="widget-region-title">' + title + '</span>' +
        '<div class="widget-region-actions">' +
          '<button class="widget-action-btn widget-pin-btn" data-action="pin" title="Pin to Workspace" data-tooltip="Pin to Workspace"><span class="pin-icon-default">📌</span><span class="pin-icon-pinned" style="display:none;">✖</span></button>' +
          '<button class="widget-action-btn" data-action="expand" title="Expand">⤢</button>' +
          '<button class="widget-action-btn" data-action="dismiss" title="Dismiss">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="widget-region-body">' +
        '<div class="canvas-grid" data-layout="auto"></div>' +
      '</div>';

    // Wire up action buttons
    var actionBtns = region.querySelectorAll('.widget-action-btn');
    for (var i = 0; i < actionBtns.length; i++) {
      (function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var action = btn.dataset.action;
          if (action === 'pin') {
            _handlePinAction(region, btn);
          } else if (action === 'dismiss') {
            console.log('[Dismiss] Clicked. pinned=' + region.classList.contains('pinned'));
            // Don't dismiss pinned regions
            if (region.classList.contains('pinned')) return;

            // Track dismissed prefix to suppress re-creation from stale canvas updates
            var dismissTiles = region.querySelectorAll('.dash-tile[data-component-id]');
            var dismissPrefix = '';
            if (dismissTiles.length > 0) {
              dismissPrefix = (dismissTiles[0].dataset.componentId || '').split('-')[0];
              if (dismissPrefix) {
                _dismissedPrefixes[dismissPrefix] = Date.now();
                // Persist to localStorage (survives page refresh even if server restart loses the WS message)
                try { localStorage.setItem('scratchy-dismissed-widgets', JSON.stringify(_dismissedPrefixes)); } catch(e) {}
                // Also clear this prefix from localStorage canvas state
                try {
                  var _csRaw = localStorage.getItem('scratchy-canvas-state-v2');
                  if (_csRaw) {
                    var _csData = JSON.parse(_csRaw);
                    if (_csData && _csData.components) {
                      var _changed = false;
                      for (var _ck in _csData.components) {
                        if (_ck.startsWith(dismissPrefix + '-') || _ck === dismissPrefix) {
                          delete _csData.components[_ck];
                          _changed = true;
                        }
                      }
                      if (_changed) localStorage.setItem('scratchy-canvas-state-v2', JSON.stringify(_csData));
                    }
                  }
                } catch(e) {}
              }
              // Notify server to clear from active widget tracking (won't re-appear on reconnect)
              if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
                connection.ws.send(JSON.stringify({ type: 'widget-dismiss', prefix: dismissPrefix }));
              }
            }
            // Clear active region reference if it points to this region
            var wasActive = (_activeWidgetRegion === region);
            if (wasActive) _activeWidgetRegion = null;

            // Remember position for undo (insert before next sibling)
            var parentEl = region.parentNode;
            var nextSibling = region.nextSibling;

            // Animate out and detach (don't destroy yet — keep for undo)
            region.style.animation = 'focusExit 200ms ease-in forwards';
            var dismissed = true;
            setTimeout(function() {
              if (dismissed && region.parentNode) region.parentNode.removeChild(region);
            }, 200);

            // Show inline undo bar (5s) — placed where the region was
            _showDismissUndoToast(function onUndo() {
              dismissed = false;
              // Restore region
              region.style.animation = 'focusEnter 250ms cubic-bezier(0.16,1,0.3,1) both';
              if (nextSibling && nextSibling.parentNode === parentEl) {
                parentEl.insertBefore(region, nextSibling);
              } else if (parentEl) {
                parentEl.appendChild(region);
              }
              // Clear dismissed prefix so updates come through again
              if (dismissPrefix && _dismissedPrefixes[dismissPrefix]) {
                delete _dismissedPrefixes[dismissPrefix];
              }
              if (wasActive) _activeWidgetRegion = region;
            }, parentEl, nextSibling);
          } else if (action === 'expand') {
            _expandWidgetToOverlay(region);
          } else if (action === 'collapse') {
            if (region._collapseOverlay) region._collapseOverlay();
          }
        });
      })(actionBtns[i]);
    }

    // If skeleton requested, show shimmer
    if (opts.skeleton) {
      var grid = region.querySelector('.canvas-grid');
      grid.innerHTML =
        '<div class="skeleton-tile">' +
          '<div class="skeleton-line" style="width:50%;height:16px;"></div>' +
          '<div class="skeleton-line" style="width:80%;height:12px;margin-top:8px;"></div>' +
          '<div class="skeleton-line" style="width:65%;height:12px;margin-top:4px;"></div>' +
        '</div>';
    }

    return region;
  }

  function _expandWidgetToOverlay(regionEl) {
    // CSS-only expand: the region stays in the same DOM position (so all event listeners
    // and live push updates keep working). We just toggle a class that displays it as
    // a fixed full-screen overlay, and add a backdrop element.
    if (regionEl.classList.contains('widget-expanded')) return; // already expanded

    regionEl.classList.add('widget-expanded');

    // Create backdrop
    var backdrop = document.createElement('div');
    backdrop.className = 'widget-expanded-backdrop';
    document.body.appendChild(backdrop);

    // Swap the expand button to a collapse button
    var expandBtn = regionEl.querySelector('.widget-action-btn[data-action="expand"]');
    if (expandBtn) {
      expandBtn.textContent = '⤡';
      expandBtn.title = 'Collapse';
      expandBtn.dataset.action = 'collapse';
    }

    function collapse() {
      regionEl.classList.add('widget-collapsing');
      backdrop.classList.add('widget-backdrop-closing');
      setTimeout(function() {
        regionEl.classList.remove('widget-expanded', 'widget-collapsing');
        backdrop.remove();
        // Restore expand button
        if (expandBtn) {
          expandBtn.textContent = '⤢';
          expandBtn.title = 'Expand';
          expandBtn.dataset.action = 'expand';
        }
      }, 200);
      document.removeEventListener('keydown', onEsc);
    }

    backdrop.addEventListener('click', collapse);

    function onEsc(e) { if (e.key === 'Escape') collapse(); }
    document.addEventListener('keydown', onEsc);

    // Store collapse fn on the region so the action-btn handler can call it
    regionEl._collapseOverlay = collapse;
  }

  // Get or create the active widget region for the current message
  // For server-pushed canvas-update (widget action results), reuse the last region
  function _getOrCreateWidgetRegion(messagesContainer, opts) {
    opts = opts || {};
    // If we have an active streaming region, use it
    if (_activeWidgetRegion && _activeWidgetRegion.parentNode) {
      return _activeWidgetRegion;
    }
    // For widget action results (not streaming), reuse the LAST widget region in the chat
    if (opts.reuseExisting) {
      var existing = messagesContainer.querySelectorAll('.widget-region');
      if (existing.length > 0) {
        var last = existing[existing.length - 1];
        _activeWidgetRegion = last;
        return last;
      }
    }
    var region = createWidgetRegion({ skeleton: !opts.noSkeleton, icon: opts.icon, title: opts.title });
    messagesContainer.appendChild(region);
    _activeWidgetRegion = region;
    // Auto-scroll to new region
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return region;
  }

  // Finalize the active widget region (called when streaming ends)
  function _finalizeWidgetRegion() {
    if (_activeWidgetRegion) {
      // Remove any remaining skeletons
      var skeletons = _activeWidgetRegion.querySelectorAll('.skeleton-tile');
      for (var i = 0; i < skeletons.length; i++) skeletons[i].remove();
      // Don't null out _activeWidgetRegion — widget action responses
      // should reuse the same region. It gets replaced when a NEW region is created.
    }
  }

  // Find an existing widget region that contains components with the given prefix
  function _findWidgetRegionByPrefix(messagesEl, opId) {
    if (!opId) return null;
    var regions = messagesEl.querySelectorAll('.widget-region');
    for (var i = regions.length - 1; i >= 0; i--) {
      var tiles = regions[i].querySelectorAll('.dash-tile[data-component-id]');
      for (var j = 0; j < tiles.length; j++) {
        var cid = tiles[j].dataset.componentId;
        // Same prefix means same widget (e.g., both start with "sn-" or "cal-")
        var prefix = cid.split('-').slice(0, 1).join('-');
        var opPrefix = opId.split('-').slice(0, 1).join('-');
        if (prefix === opPrefix && prefix.length > 0) return regions[i];
      }
    }
    return null;
  }

  // Widget metadata for auto-labeling regions
  var _widgetMeta = {
    'sn':    { icon: '📝', title: 'Notes' },
    'cal':   { icon: '📅', title: 'Calendar' },
    'mail':  { icon: '📧', title: 'Email' },
    'admin': { icon: '⚙️', title: 'Admin' },
    'sa':    { icon: '🤖', title: 'Sub-Agents' },
    'account': { icon: '👤', title: 'Account' },
    'yt':    { icon: '▶️', title: 'YouTube' },
    'sp':    { icon: '🎵', title: 'Spotify' },
    'spotify': { icon: '🎵', title: 'Spotify' },
    'youtube': { icon: '▶️', title: 'YouTube' },
    'onboard': { icon: '👋', title: 'Welcome' },
    'analytics': { icon: '📊', title: 'Analytics' }
  };

  // Cache LiveComponent instances for efficient patch updates (update() instead of full re-create)
  var _liveComponentCache = {};

  // Phase 31: Render a batch of ops into widget regions
  function _renderOpsInWidgetRegion(ops) {
    var messagesEl = document.getElementById("messages");
    if (!messagesEl || !ops || ops.length === 0) return;
    var _t0 = performance.now();
    var _scrollBefore = messagesEl.scrollTop;

    // Detect if this batch is a tab switch (contains a clear op) AND has existing content to replace
    var isTabSwitch = false;
    for (var tc = 0; tc < ops.length; tc++) { if (ops[tc].op === 'clear') { isTabSwitch = true; break; } }

    // Auto-detect widget metadata from first op with an id
    var firstId = null;
    for (var fi = 0; fi < ops.length; fi++) { if (ops[fi].id) { firstId = ops[fi].id; break; } }
    var prefix = firstId ? firstId.split('-')[0] : '';
    var meta = _widgetMeta[prefix] || {};
    // Fallback: derive title from first hero/card/alert title in ops, or from agent name
    if (!meta.title) {
      for (var mi = 0; mi < ops.length; mi++) {
        var _mop = ops[mi];
        if (_mop.data && _mop.data.title && (_mop.type === 'hero' || _mop.type === 'card' || _mop.type === 'alert')) {
          meta = { icon: '🤖', title: _mop.data.title };
          break;
        }
      }
      if (!meta.title) meta = { icon: '🤖', title: 'Agent' };
    }

    // Find region for this batch:
    // 1. If user clicked a button inside a widget region, route response BACK to that region
    //    (only consume _pendingActionRegion for user-initiated renders — live pushes
    //    must NOT steal it, or a pending action response may create a new region)
    // 2. Otherwise, match by prefix from existing regions
    var batchRegion = null;
    if (_pendingActionRegion && _pendingActionRegion.parentNode && _lastRenderWasUserInitiated) {
      batchRegion = _pendingActionRegion;
      _pendingActionRegion = null;
    } else if (firstId) {
      batchRegion = _findWidgetRegionByPrefix(messagesEl, firstId);
    }
    var isNewRegion = !batchRegion;
    var hasExistingContent = batchRegion && batchRegion.querySelector('.dash-tile');

    // Update widget region header if the widget type changed (e.g. admin → sub-agents)
    if (batchRegion && !isNewRegion && meta.title) {
      var headerTitle = batchRegion.querySelector('.widget-region-title');
      var headerIcon = batchRegion.querySelector('.widget-region-icon');
      if (headerTitle && headerTitle.textContent !== meta.title) {
        headerTitle.textContent = meta.title;
        if (headerIcon && meta.icon) headerIcon.textContent = meta.icon;
      }
    }

    // Relocate: if existing region is NOT the last child, move it to the bottom.
    // User/agent triggered a widget — they expect it at the bottom of chat, not buried in history.
    // Only relocate for user-initiated actions (clicks, ⌘K), NOT auto-restores or live pushes.
    var didRelocate = false;
    if (batchRegion && !isNewRegion && _lastRenderWasUserInitiated) {
      var isLastChild = batchRegion === messagesEl.lastElementChild;
      if (!isLastChild) {
        batchRegion.remove();
        messagesEl.appendChild(batchRegion);
        batchRegion.classList.add('widget-region-relocate');
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            batchRegion.classList.remove('widget-region-relocate');
          });
        });
        didRelocate = true;
      }
    }

    // If no existing region for this prefix, either replace an unpinned region or create new
    if (!batchRegion) {
      if (prefix && _dismissedPrefixes[prefix] && !_lastRenderWasUserInitiated) {
        // Only suppress for auto-pushes (reconnect re-triggers, server broadcasts).
        // User-initiated actions (Cmd+K, button clicks, trigger ops) always render.
        if (Date.now() - _dismissedPrefixes[prefix] > 60000) {
          delete _dismissedPrefixes[prefix];
          console.log('[Widget] Dismiss expired for prefix: ' + prefix);
        } else {
          console.log('[Widget] Suppressed auto-push for dismissed prefix: ' + prefix);
          return;
        }
      }
      // Clear dismiss when user explicitly requested this widget
      if (prefix && _dismissedPrefixes[prefix] && _lastRenderWasUserInitiated) {
        delete _dismissedPrefixes[prefix];
        try { localStorage.setItem('scratchy-dismissed-widgets', JSON.stringify(_dismissedPrefixes)); } catch(e) {}
      }

      // Look for an existing unpinned widget region to replace
      var existingRegions = messagesEl.querySelectorAll('.widget-region');
      var unpinnedRegion = null;
      for (var er = existingRegions.length - 1; er >= 0; er--) {
        if (!existingRegions[er].classList.contains('pinned')) {
          unpinnedRegion = existingRegions[er];
          break;
        }
      }

      if (unpinnedRegion && !unpinnedRegion.querySelector('.dash-tile:not(.skeleton-tile)')) {
        // Replace the unpinned region (no live tiles): clear its content and update header
        var oldGrid = unpinnedRegion.querySelector('.canvas-grid');
        if (oldGrid) oldGrid.innerHTML = '';
        // Update header to new widget type
        var hTitle = unpinnedRegion.querySelector('.widget-region-title');
        var hIcon = unpinnedRegion.querySelector('.widget-region-icon');
        if (hTitle && meta.title) hTitle.textContent = meta.title;
        if (hIcon && meta.icon) hIcon.textContent = meta.icon;
        // Update dataset for prefix matching
        unpinnedRegion.dataset.widgetId = prefix + '-' + Date.now();
        // Invalidate old LiveComponent cache entries for this region
        var oldTiles = unpinnedRegion.querySelectorAll('.dash-tile[data-component-id]');
        for (var ot = 0; ot < oldTiles.length; ot++) {
          var ocid = oldTiles[ot].dataset.componentId;
          if (ocid && _liveComponentCache[ocid]) delete _liveComponentCache[ocid];
        }
        batchRegion = unpinnedRegion;
        _activeWidgetRegion = batchRegion;
        // Relocate to bottom if above viewport
        var _rr = batchRegion.getBoundingClientRect();
        var _cr = messagesEl.getBoundingClientRect();
        if (_rr.bottom < _cr.top + 40) {
          batchRegion.remove();
          messagesEl.appendChild(batchRegion);
        }
      } else {
        // All existing regions are pinned (or none exist) — create new below
        batchRegion = createWidgetRegion({ icon: meta.icon, title: meta.title });
        messagesEl.appendChild(batchRegion);
        _activeWidgetRegion = batchRegion;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ── Pre-scan: detect layout mode + zone usage ──
    var _layoutMode = null;
    var _hasZones = false;
    for (var ps = 0; ps < ops.length; ps++) {
      if (ops[ps].op === 'layout' && ops[ps].mode) _layoutMode = ops[ps].mode;
      if (ops[ps].layout && ops[ps].layout.zone) _hasZones = true;
    }

    // ── Tab switch: hide grid BEFORE DOM changes to prevent flash ──
    if (isTabSwitch && batchRegion) {
      var _preGrid = batchRegion.querySelector('.canvas-grid');
      if (_preGrid) _preGrid.classList.add('grid-swap-hide');
    }

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      var region = batchRegion;
      var grid = region.querySelector('.canvas-grid');
      if (!grid) continue;

      // Remove skeletons on first real op
      var sks = region.querySelectorAll('.skeleton-tile');
      for (var si = 0; si < sks.length; si++) sks[si].remove();

      // ── Layout mode op ──
      if (op.op === 'layout' && op.mode) {
        grid.dataset.layoutMode = op.mode;
        // For columns mode, set up two zone containers
        if (op.mode === 'columns' || _hasZones) {
          if (!grid.querySelector('.zone-left')) {
            grid.classList.add('grid-columns');
            var zl = document.createElement('div');
            zl.className = 'zone-left';
            var zr = document.createElement('div');
            zr.className = 'zone-right';
            // Move existing tiles into left zone by default
            var existingChildren = Array.from(grid.querySelectorAll('.dash-tile'));
            for (var ec = 0; ec < existingChildren.length; ec++) {
              zl.appendChild(existingChildren[ec]);
            }
            grid.appendChild(zl);
            grid.appendChild(zr);
          }
        }
        continue;
      }

      if (op.op === 'clear') {
        // Mark existing tiles for reconciliation.
        // Surviving tiles (updated by subsequent upserts) get unmarked.
        var allTiles = grid.querySelectorAll('.dash-tile');
        for (var ci = 0; ci < allTiles.length; ci++) {
          allTiles[ci].classList.add('pending-removal');
        }
        // Reset column zones on clear
        grid.classList.remove('grid-columns');
        var oldZl = grid.querySelector('.zone-left');
        var oldZr = grid.querySelector('.zone-right');
        if (oldZl) oldZl.remove();
        if (oldZr) oldZr.remove();
        // Re-setup zones if layout mode is columns
        if (_layoutMode === 'columns' || _hasZones) {
          grid.classList.add('grid-columns');
          var newZl = document.createElement('div');
          newZl.className = 'zone-left';
          var newZr = document.createElement('div');
          newZr.className = 'zone-right';
          grid.appendChild(newZl);
          grid.appendChild(newZr);
        }
      } else if (op.op === 'upsert' && op.type && op.data) {
        var existing = grid.querySelector('[data-component-id="' + op.id + '"]');

        if (existing) {
          existing.classList.remove('pending-removal');
          // If same type and we have a cached LiveComponent, use .update() (no DOM rebuild)
          var existingLC = _liveComponentCache[op.id];
          if (existingLC && existingLC.update && existing.dataset.type === op.type) {
            existingLC.update(op.data);
          } else {
            existing.dataset.type = op.type;
            existing.innerHTML = '';
            var liveResult = null;
            var html = '';
            if (typeof LiveComponents !== 'undefined' && LiveComponents.has(op.type)) {
              try { liveResult = LiveComponents.create(op.type, op.data, op.id); } catch(lcErr) { console.warn('[LC error]', op.id, lcErr.message); }
            }
            if (!liveResult && typeof renderCanvasComponent === 'function') {
              html = renderCanvasComponent(Object.assign({ component: op.type }, op.data));
            }
            if (!liveResult && !html) {
              html = '<div class="sui-card"><div class="sui-card-title">' + (op.data.title || op.type) + '</div></div>';
            }
            if (liveResult) { _liveComponentCache[op.id] = liveResult; existing.appendChild(liveResult.el); }
            else { existing.innerHTML = html; }
          }
        } else {
          var liveResult = null;
          var html = '';
          if (typeof LiveComponents !== 'undefined' && LiveComponents.has(op.type)) {
            try { liveResult = LiveComponents.create(op.type, op.data, op.id); } catch(lcErr) { console.warn('[LC error]', op.id, lcErr.message); }
          }
          if (!liveResult && typeof renderCanvasComponent === 'function') {
            html = renderCanvasComponent(Object.assign({ component: op.type }, op.data));
          }
          if (!liveResult && !html) {
            html = '<div class="sui-card"><div class="sui-card-title">' + (op.data.title || op.type) + '</div></div>';
          }
          if (liveResult) _liveComponentCache[op.id] = liveResult;
          var tile = document.createElement('div');
          // Only animate entrance on first-time loads, not tab switches
          tile.className = (isTabSwitch ? 'dash-tile' : 'dash-tile tile-enter');
          tile.dataset.componentId = op.id;
          tile.dataset.type = op.type;
          if (liveResult && liveResult.el) { tile.appendChild(liveResult.el); }
          else { tile.innerHTML = html; }
          // Route to zone if columns mode is active
          var _zone = op.layout && op.layout.zone;
          var _zoneTarget = null;
          if (grid.classList.contains('grid-columns')) {
            if (_zone === 'right') _zoneTarget = grid.querySelector('.zone-right');
            else _zoneTarget = grid.querySelector('.zone-left'); // default to left
          }
          if (_zoneTarget) _zoneTarget.appendChild(tile);
          else grid.appendChild(tile);
        }
      } else if (op.op === 'patch' && op.id && op.data) {
        var cachedLC = _liveComponentCache[op.id];
        if (cachedLC && cachedLC.update) {
          cachedLC.update(op.data);
        } else {
          var target = grid.querySelector('[data-component-id="' + op.id + '"]');
          if (target && canvasState.components[op.id]) {
            var comp = canvasState.components[op.id];
            var pLive = null;
            var pHtml = '';
            if (typeof LiveComponents !== 'undefined' && LiveComponents.has(comp.type)) {
              pLive = LiveComponents.create(comp.type, comp.data, op.id);
              if (pLive) _liveComponentCache[op.id] = pLive;
            }
            if (!pLive && typeof renderCanvasComponent === 'function') {
              pHtml = renderCanvasComponent(Object.assign({ component: comp.type }, comp.data));
            }
            if (pLive && pLive.el) { target.innerHTML = ''; target.appendChild(pLive.el); }
            else if (pHtml) { target.innerHTML = pHtml; }
          }
        }
      } else if (op.op === 'remove' && op.id) {
        var rm = grid.querySelector('[data-component-id="' + op.id + '"]');
        if (rm) {
          rm.classList.add('removing');
          var rmId = rm.dataset.componentId;
          if (rmId) delete _liveComponentCache[rmId];
          setTimeout(function(el) { if (el.parentNode) el.remove(); }, 200, rm);
        }
      }
    }

    // Reconciliation: remove stale tiles
    if (batchRegion) {
      var stale = batchRegion.querySelectorAll('.dash-tile.pending-removal');
      for (var ri = 0; ri < stale.length; ri++) {
        var cid = stale[ri].dataset.componentId;
        if (cid) delete _liveComponentCache[cid];
        if (isTabSwitch) {
          // Tab switch: remove IMMEDIATELY — no animation, no overlap, no layout shift
          stale[ri].remove();
        } else {
          // Individual remove: animate out
          stale[ri].classList.remove('pending-removal');
          stale[ri].classList.add('removing');
          (function(el) { setTimeout(function() { if (el.parentNode) el.remove(); }, 200); })(stale[ri]);
        }
      }
    }

    // Smart density: auto single-column when too many tiles
    if (batchRegion) {
      var _grid = batchRegion.querySelector('.canvas-grid');
      if (_grid) {
        var tileCount = _grid.querySelectorAll('.dash-tile').length;
        if (tileCount > 8) {
          _grid.classList.add('grid-dense');
        } else {
          _grid.classList.remove('grid-dense');
        }
      }
    }

    // Detect truncation on newly rendered tiles
    requestAnimationFrame(function() {
      _detectAllTruncations(batchRegion);
    });

    // Scroll on first-time region creation OR when region was relocated to bottom
    // Only scroll for user-initiated actions — auto-restores and live pushes don't steal scroll
    if ((isNewRegion || didRelocate) && batchRegion && _lastRenderWasUserInitiated) {
      batchRegion.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    // Crossfade: for tab switches on existing content, fade in the new tiles
    // The grid was hidden at the start of the batch (opacity 0) to prevent flash
    if (isTabSwitch && batchRegion) {
      var grid = batchRegion.querySelector('.canvas-grid');
      if (grid) {
        grid.classList.add('grid-swap-in');
        grid.classList.remove('grid-swap-hide');
        setTimeout(function() { grid.classList.remove('grid-swap-in'); }, 150);
      }
    }
  }

  // ── Tile truncation detection + expand ──
  function _detectTruncation(tile) {
    if (!tile || tile.classList.contains('tile-expanded')) return;
    // Check if content overflows the max-height
    if (tile.scrollHeight > tile.clientHeight + 4) {
      tile.classList.add('tile-truncated');
    } else {
      tile.classList.remove('tile-truncated');
    }
  }

  // Run truncation detection after tiles are rendered
  function _detectAllTruncations(container) {
    if (!container) return;
    var tiles = container.querySelectorAll('.dash-tile:not(.tile-expanded)');
    for (var i = 0; i < tiles.length; i++) {
      _detectTruncation(tiles[i]);
    }
  }
  // Expose for workspace-renderer.js
  window._detectAllTruncations = _detectAllTruncations;

  // Tile expand/collapse click handler (delegated)
  document.addEventListener('click', function(e) {
    var tile = e.target.closest('.dash-tile.tile-truncated, .dash-tile.tile-expanded');
    if (!tile) return;
    // Don't expand if clicking a button, link, or interactive element
    if (e.target.closest('button, a, input, select, textarea, [data-sui-action], [data-sui-send]')) return;

    if (tile.classList.contains('tile-expanded')) {
      tile.classList.remove('tile-expanded');
      // Re-detect truncation after collapse
      requestAnimationFrame(function() { _detectTruncation(tile); });
    } else {
      tile.classList.add('tile-expanded');
      tile.classList.remove('tile-truncated');
    }
  });

  // Toast notification helper
  // Dismiss-undo toast with clickable Undo button (5s timeout)
  function _showDismissUndoToast(onUndo, parentEl, nextSibling) {
    console.log('[Dismiss] Showing undo bar');
    var resolved = false;

    function resolve(doUndo) {
      if (resolved) return;
      resolved = true;
      if (doUndo) onUndo();
      if (bar && bar.parentNode) {
        bar.style.opacity = '0';
        bar.style.transform = 'translateY(-4px)';
        setTimeout(function() { bar.remove(); }, 250);
      }
    }

    // Inline undo bar with inline styles (no external CSS dependency)
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 20px;margin:4px 0;background:var(--surface-2,#161924);border:1px dashed var(--border,rgba(255,255,255,0.1));border-radius:12px;position:relative;overflow:hidden;opacity:0;transform:translateY(8px);transition:opacity 250ms ease,transform 250ms ease;';

    var text = document.createElement('span');
    text.textContent = 'Canvas dismissed';
    text.style.cssText = 'font-size:13px;color:var(--text-secondary,#8b8fa3);';

    var btn = document.createElement('button');
    btn.textContent = 'Undo';
    btn.style.cssText = 'background:none;border:1px solid var(--accent,#6366f1);color:var(--accent,#6366f1);border-radius:6px;padding:5px 16px;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;z-index:1;transition:all 150ms ease;';
    btn.onmouseenter = function() { btn.style.background = 'var(--accent,#6366f1)'; btn.style.color = '#fff'; };
    btn.onmouseleave = function() { btn.style.background = 'none'; btn.style.color = 'var(--accent,#6366f1)'; };

    var progress = document.createElement('div');
    progress.style.cssText = 'position:absolute;bottom:0;left:0;height:3px;width:100%;background:var(--accent,#6366f1);opacity:0.4;transition:width 5s linear;';

    bar.appendChild(text);
    bar.appendChild(btn);
    bar.appendChild(progress);

    // Insert where the region was
    if (nextSibling && nextSibling.parentNode === parentEl) {
      parentEl.insertBefore(bar, nextSibling);
    } else if (parentEl) {
      parentEl.appendChild(bar);
    }

    // Animate in (next frame)
    requestAnimationFrame(function() {
      bar.style.opacity = '1';
      bar.style.transform = 'translateY(0)';
      // Start progress countdown
      requestAnimationFrame(function() { progress.style.width = '0%'; });
    });

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      resolve(true);
    });

    // Auto-dismiss after 5s
    setTimeout(function() { resolve(false); }, 5000);
  }

  function showToast(message, type, duration) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    type = type || 'info';
    duration = duration || 4000;

    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(function() {
      toast.classList.add('exiting');
      setTimeout(function() { toast.remove(); }, 200);
    }, duration);
  }
  window.showToast = showToast;

  function switchView(view) {
    // Phase 31: unified mode — switchView is a no-op, chat is always visible
    // Kept for backward compat with code that still calls it
    currentView = "chat";
    // Only restore chat-view display if we're on the chat tab
    // (workspace tab manages its own visibility — don't override it)
    var activeTab = typeof window._scratchyActiveTab === 'function' ? window._scratchyActiveTab() : undefined;
    if (activeTab === 'chat' || typeof activeTab === 'undefined') {
      chatView.style.display = "";
    }
  }

  if (viewChatBtn) {
    viewChatBtn.addEventListener("click", function() { switchView("chat"); });
  }
  if (viewCanvasBtn) {
    viewCanvasBtn.addEventListener("click", function() { switchView("canvas"); });
  }

  // Apply saved view on load
  if (currentView === "canvas") {
    switchView("canvas");
  }

  // Restore canvas state from server on load
  // ── Canvas State Persistence (localStorage + server fallback) ──
  var CANVAS_STORAGE_KEY = 'scratchy-canvas-state-v2';

  // Save canvas state to localStorage — debounced to avoid GC pressure from rapid patches
  var _canvasSaveTimer = null;
  canvasState.onChange(function(type) {
    if (_canvasSaveTimer) return; // already scheduled
    _canvasSaveTimer = setTimeout(function() {
      _canvasSaveTimer = null;
      try {
        var snapshot = {
          components: canvasState.components,
          layout: canvasState.layout,
          version: canvasState.version,
          savedAt: Date.now()
        };
        localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(snapshot));
      } catch(e) {} // localStorage full or unavailable
    }, 2000); // save at most once every 2s
  });

  // Restore on page load: localStorage first, server fallback
  (function restoreCanvasState() {
    // 1. Try localStorage (instant, no network)
    try {
      var stored = localStorage.getItem(CANVAS_STORAGE_KEY);
      if (stored) {
        var state = JSON.parse(stored);
        if (state && state.components && Object.keys(state.components).length > 0) {
          // Only restore if saved recently (< 24h)
          if (state.savedAt && (Date.now() - state.savedAt) < 86400000) {
            console.log("[Canvas] Restoring " + Object.keys(state.components).length + " components from localStorage");
            canvasState.components = state.components;
            canvasState.layout = state.layout || 'auto';
            canvasState.version = state.version || 0;
            var arr = Object.values(state.components).sort(function(a, b) {
              return ((a.layout && a.layout.order) || 999) - ((b.layout && b.layout.order) || 999);
            });
            canvasState._notify("reset", arr);
            return; // localStorage worked, skip server
          }
        }
      }
    } catch(e) {}

    // 2. No localStorage data — canvas starts empty (agent will rebuild on next message)
    console.log("[Canvas] No saved state — starting fresh");
  })();

  // Canvas chat panel toggle
  var canvasChatExpanded = false;
  if (canvasChatToggle) {
    canvasChatToggle.addEventListener("click", function() {
      canvasChatExpanded = !canvasChatExpanded;
      canvasChatBody.style.display = canvasChatExpanded ? "flex" : "none";
      canvasChatExpand.textContent = canvasChatExpanded ? "▼" : "▲";
      canvasChatPanel.classList.toggle("expanded", canvasChatExpanded);
    });
  }

  // Canvas chat send
  function canvasSendMessage() {
    var text = canvasChatInput.value.trim();
    if (!text) return;

    addCanvasChatMsg("user", text);

    if (!welcomeCleared) {
      renderer.clearWelcome();
      welcomeCleared = true;
    }

    store.ingest({
      role: "user",
      text: text,
      source: "local",
      timestamp: new Date().toISOString()
    });

    var sendText = SCRATCHY_GENUI_ENABLED ? text + "\n[genui:on]" : text;
    connection.send(sendText);
    startActivityTimer();

    canvasChatInput.value = "";
    canvasChatInput.style.height = "auto";
    canvasChatInput.focus();
  }

  if (canvasSendBtn) {
    canvasSendBtn.addEventListener("click", canvasSendMessage);
  }
  if (canvasChatInput) {
    canvasChatInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        canvasSendMessage();
      }
    });
    canvasChatInput.addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 80) + "px";
    });
  }

  function addCanvasChatMsg(role, text) {
    if (!canvasChatMessages) return;
    text = (text || "")
      .replace(/\[SecurityPlugin Canary\][^\n]*/g, "")
      .replace(/\[message_id:[^\]]*\]/g, "")
      .replace(/\[genui:\w+\]/g, "")
      .replace(/```scratchy-canvas[\s\S]*?```/g, "[canvas update]")
      .replace(/```scratchy-toon[\s\S]*?```/g, "[canvas update]")
      .replace(/```scratchy-tpl[\s\S]*?```/g, "[canvas update]")
      .trim();
    if (!text) return;
    if (text.length > 200) text = text.slice(0, 200) + "...";
    var div = document.createElement("div");
    div.className = "canvas-chat-msg canvas-chat-msg-" + role;
    div.textContent = (role === "user" ? "You: " : "Agent: ") + text;
    canvasChatMessages.appendChild(div);
    canvasChatMessages.scrollTop = canvasChatMessages.scrollHeight;
    if (role === "assistant" || role === "agent") {
      canvasChatStatus.textContent = "💬 " + text.slice(0, 60) + (text.length > 60 ? "..." : "");
    }
  }

  // Wire canvas state → grid rendering
  var _canvasGridEls = {};

  var _CANVAS_SPAN = {
    small:  ["sparkline","gauge","progress","status","rating","toggle","slider"],
    medium: ["card","stats","alert","checklist","kv","buttons","link-card","chips",
             "input","form-strip","streak","stacked-bar","chart-pie","tags","weather"],
    wide:   ["chart-bar","chart-line","table","code","tabs","accordion"],
    full:   ["hero","form","timeline"]
  };

  function _canvasSpanOf(type) {
    for (var s in _CANVAS_SPAN) { if (_CANVAS_SPAN[s].indexOf(type) !== -1) return s; }
    return "medium";
  }

  // Store live component instances: id -> {el, update}
  var _liveInstances = {};

  function _renderCanvasTile(comp) {
    var span = _canvasSpanOf(comp.type);
    var tile = document.createElement("div");
    tile.className = "dash-tile dash-" + span;
    tile.dataset.componentId = comp.id;
    tile.dataset.id = comp.id;
    tile.dataset.type = comp.type;
    tile.dataset.order = (comp.layout && comp.layout.order != null) ? comp.layout.order : 999;
    tile.setAttribute('role', 'article');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', (comp.data && comp.data.title ? comp.data.title : comp.type) + ' component');
    
    // Apply widget size class for smart-widgets
    if (comp.type === "smart-widget") {
      var size = null;
      // Check multiple possible locations for size config
      if (comp.config && comp.config.size) {
        size = comp.config.size;
      } else if (comp.data && comp.data.config && comp.data.config.size) {
        size = comp.data.config.size;
      }
      
      if (size && size !== 'default') {
        tile.classList.add("widget-" + size);
        console.log("Applied size class:", "widget-" + size, "to component:", comp.id);
      }
    }
    
    // Start invisible — FLIP system will animate entrance
    tile.style.opacity = "0";
    tile.style.transform = "scale(0.92) translateY(8px)";
    tile.style.willChange = "transform, opacity";
    tile.style.backfaceVisibility = "hidden";
    _fillCanvasTile(tile, comp);
    return tile;
  }

  function _fillCanvasTile(tile, comp) {
    var data = comp.data || {};
    // Try live component first (data-bound, no innerHTML)
    if (typeof LiveComponents !== "undefined" && LiveComponents.has(comp.type)) {
      var existing = _liveInstances[comp.id];
      if (existing) {
        // UPDATE: just patch the data — no DOM destruction
        console.log("[LC] PATCH " + comp.id + " (" + comp.type + ") — live update, no innerHTML");
        existing.update(data);
        return;
      }
      // CREATE: build live DOM once
      var lc = LiveComponents.create(comp.type, data);
      if (lc) {
        console.log("[LC] CREATE " + comp.id + " (" + comp.type + ") — live component");
        _liveInstances[comp.id] = lc;
        tile.innerHTML = "";
        tile.appendChild(lc.el);
        return;
      }
    } else {
      console.warn("[LC] LiveComponents NOT available or type not supported: " + comp.type);
    }
    // Fallback: HTML string renderers (crossfade to avoid flash)
    var d = { component: comp.type };
    if (comp.data) { for (var k in comp.data) d[k] = comp.data[k]; }
    var html = (typeof renderCanvasComponent === "function")
      ? renderCanvasComponent(d)
      : (typeof renderComponent === "function" ? renderComponent(JSON.stringify(d)) : "");
    // If tile already has content, crossfade
    if (tile.children.length > 0 && tile.style.opacity !== "0") {
      var wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      wrapper.style.opacity = "0";
      wrapper.style.transition = "opacity 150ms ease";
      tile.style.position = "relative";
      // Fade out old content
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
  }

  function _canvasReorder() {
    if (!canvasGrid) return;
    var tiles = Array.from(canvasGrid.children).filter(function(e) { return e.classList.contains("dash-tile"); });
    tiles.sort(function(a, b) { return (parseInt(a.dataset.order)||0) - (parseInt(b.dataset.order)||0); });
    for (var i = 0; i < tiles.length; i++) {
      tiles[i].style.setProperty('--tile-index', i);
      canvasGrid.appendChild(tiles[i]);
    }
  }

  function _canvasUpdateEmpty() {
    if (!canvasGrid || !canvasEmpty) return;
    var hasTiles = canvasGrid.querySelector(".dash-tile");
    canvasEmpty.style.display = hasTiles ? "none" : "flex";
  }

  // ═══════════════════════════════════════════════
  // ═══════════════════════════════════════════════
  // Skeleton Loading — instant feedback on send
  // ═══════════════════════════════════════════════
  var _skeletonIds = [];
  function _showSkeletons() {
    if (!canvasGrid) return;
    _clearSkeletons();
    var shapes = [
      '<div style="padding:16px;"><div class="skeleton-bar wide"></div><div class="skeleton-bar medium"></div><div class="skeleton-bar narrow"></div></div>',
      '<div style="padding:16px;display:flex;gap:12px;align-items:center;"><div class="skeleton-bar circle"></div><div style="flex:1;"><div class="skeleton-bar wide"></div><div class="skeleton-bar medium"></div></div></div>',
      '<div style="padding:16px;"><div class="skeleton-bar narrow"></div><div style="display:flex;gap:8px;margin-top:8px;"><div class="skeleton-bar" style="height:60px;width:33%;"></div><div class="skeleton-bar" style="height:60px;width:33%;"></div><div class="skeleton-bar" style="height:60px;width:33%;"></div></div></div>'
    ];
    for (var i = 0; i < 3; i++) {
      var tile = document.createElement("div");
      tile.className = "dash-tile dash-sm skeleton";
      tile.dataset.componentId = "_skeleton_" + i;
      tile.innerHTML = '<div class="tile-inner">' + shapes[i] + '</div>';
      tile.style.opacity = "0";
      canvasGrid.appendChild(tile);
      _skeletonIds.push("_skeleton_" + i);
      (function(t) { requestAnimationFrame(function() { t.style.transition = "opacity 0.3s ease"; t.style.opacity = "1"; }); })(tile);
    }
    if (canvasEmpty) canvasEmpty.style.display = "none";
  }
  function _clearSkeletons() {
    for (var i = 0; i < _skeletonIds.length; i++) {
      var el = canvasGrid && canvasGrid.querySelector('[data-component-id="' + _skeletonIds[i] + '"]');
      if (el) {
        el.style.transition = "opacity 0.2s ease";
        el.style.opacity = "0";
        (function(e) { setTimeout(function() { if (e.parentNode) e.parentNode.removeChild(e); }, 200); })(el);
      }
    }
    _skeletonIds = [];
  }

  // FLIP Animation System (double-rAF, batch read/write)
  // ═══════════════════════════════════════════════
  var _canvasPendingOps = [];
  var _canvasFlipRAF = null;
  var _canvasFlipDuration = 250;
  var _canvasBatching = false; // v2 beginRendering: suppress rAF scheduling during batch

  // v2 batch signals — suppress rAF scheduling until endBatch
  function _canvasBeginBatch() {
    _canvasBatching = true;
    if (_canvasFlipRAF) {
      cancelAnimationFrame(_canvasFlipRAF);
      _canvasFlipRAF = null;
    }
  }
  function _canvasEndBatch() {
    _canvasBatching = false;
    if (_canvasPendingOps.length > 0 && !_canvasFlipRAF) {
      _canvasFlipRAF = requestAnimationFrame(_canvasFlushOps);
    }
  }

  function _canvasQueueOp(type, data) {
    _canvasPendingOps.push({ type: type, data: data });
    if (!_canvasBatching && !_canvasFlipRAF) {
      _canvasFlipRAF = requestAnimationFrame(_canvasFlushOps);
    }
  }

  function _canvasFlushOps() {
    _canvasFlipRAF = null;
    if (!canvasGrid || _canvasPendingOps.length === 0) return;
    // Phase 31: #canvas-view is display:none — skip all rendering + View Transitions
    // (widgets render via _renderOpsInWidgetRegion into inline widget regions instead)
    var canvasViewEl = canvasGrid.closest('#canvas-view');
    if (canvasViewEl && canvasViewEl.style.display === 'none') {
      _canvasPendingOps = [];
      return;
    }
    if (_skeletonIds.length > 0) _clearSkeletons();
    var rawOps = _canvasPendingOps;
    _canvasPendingOps = [];

    // Deduplicate: for same-id ops, merge intelligently
    // upsert + patch for same id → keep upsert with merged data
    // multiple patches → keep last patch
    var ops = [];
    var seen = {};     // id -> index in ops array
    for (var i = 0; i < rawOps.length; i++) {
      var rop = rawOps[i];
      var rid = rop.data && rop.data.id;
      if (rid && (rop.type === "patch" || rop.type === "upsert" || rop.type === "move")) {
        if (rid in seen) {
          var prevIdx = seen[rid];
          var prev = ops[prevIdx];
          if (prev.type === "upsert" && rop.type === "patch") {
            // Merge patch data into upsert
            if (rop.data.data) {
              prev.data.data = prev.data.data || {};
              var pkeys = Object.keys(rop.data.data);
              for (var pk = 0; pk < pkeys.length; pk++) {
                prev.data.data[pkeys[pk]] = rop.data.data[pkeys[pk]];
              }
            }
          } else {
            // Replace previous with this one
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
    // Remove nulled entries
    ops = ops.filter(function(o) { return o !== null; });

    // ── FIRST: batch-read all current positions ──
    var oldPos = {};
    var existing = canvasGrid.querySelectorAll(".dash-tile");
    for (var i = 0; i < existing.length; i++) {
      var id = existing[i].dataset.componentId;
      if (id) oldPos[id] = existing[i].getBoundingClientRect();
    }

    // ── Fast path: if ALL ops are patches for existing tiles, skip FLIP entirely ──
    var allPatches = true;
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].type !== "patch" || !ops[i].data || !_canvasGridEls[ops[i].data.id]) {
        allPatches = false;
        console.log("[Canvas] SLOW PATH — op " + i + ": type=" + ops[i].type + " id=" + (ops[i].data && ops[i].data.id) + " inGrid=" + !!(ops[i].data && _canvasGridEls[ops[i].data.id]));
        break;
      }
    }
    if (allPatches && ops.length > 0) {
      console.log("[Canvas] FAST PATH — " + ops.length + " patch-only updates");
      for (var i = 0; i < ops.length; i++) {
        _fillCanvasTile(_canvasGridEls[ops[i].data.id], ops[i].data);
      }
      return; // No layout changes — skip FLIP, reorder, animations
    }

    // ── Batch-write: apply all DOM mutations ──
    var entering = [];
    var leaving = [];

    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      switch (op.type) {
        case "upsert":
        case "patch":
        case "move": {
          var ex = _canvasGridEls[op.data.id];
          if (ex) {
            _fillCanvasTile(ex, op.data);
            var ns = _canvasSpanOf(op.data.type);
            var nc = "dash-tile dash-" + ns;
            if (ex.className !== nc) ex.className = nc;
            if (ex.dataset.type !== op.data.type) ex.dataset.type = op.data.type;
            if (op.data.layout && op.data.layout.order != null) {
              ex.dataset.order = op.data.layout.order;
            }
          } else {
            var el = _renderCanvasTile(op.data);
            _canvasGridEls[op.data.id] = el;
            canvasGrid.appendChild(el);
            entering.push(el);
          }
          break;
        }
        case "remove": {
          if (op.data && op.data.id && _canvasGridEls[op.data.id]) {
            var rmEl = _canvasGridEls[op.data.id];
            delete _canvasGridEls[op.data.id];
            delete _liveInstances[op.data.id];
            leaving.push(rmEl);
          }
          break;
        }
        case "clear": {
          Object.keys(_canvasGridEls).forEach(function(cid) {
            leaving.push(_canvasGridEls[cid]);
          });
          _canvasGridEls = {};
          _liveInstances = {};
          break;
        }
        case "layout":
          canvasGrid.dataset.layout = op.data.mode || "auto";
          break;
      }
    }

    // ── Remove leaving tiles ──
    // If there are also entering tiles (clear+rebuild), use View Transitions API if available
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
      // Use View Transitions API for smooth crossfade on widget navigation
      if (document.startViewTransition) {
        document.startViewTransition(doSwap);
      } else {
        doSwap();
      }
      _canvasReorder();
      _canvasUpdateEmpty();
      return; // Done — no FLIP, no rAF chain, no flash
    }

    // ── Non-clear path: animate leaving tiles ──
    for (var i = 0; i < leaving.length; i++) {
      leaving[i].style.transition = "opacity 150ms ease, transform 150ms ease";
      leaving[i].style.opacity = "0";
      leaving[i].style.transform = "scale(0.95)";
      leaving[i].style.pointerEvents = "none";
      (function(el) {
        setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 160);
      })(leaving[i]);
    }

    // ── Delay entrance only if leave animation is playing ──
    var enterDelay = leaving.length > 0 ? 170 : 0;

    setTimeout(function() {
      _canvasReorder();

      // ── FLIP: animate existing tiles that moved ──
      var invertData = [];
      var allTiles = canvasGrid.querySelectorAll(".dash-tile");
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

      // Double-rAF: commit styles, then animate
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          for (var i = 0; i < invertData.length; i++) {
            invertData[i].el.style.transition = "transform " + _canvasFlipDuration + "ms cubic-bezier(0.22, 1, 0.36, 1)";
            invertData[i].el.style.transform = "";
          }

          // Staggered entrance for new tiles (no clear involved)
          var staggerMs = Math.max(30, Math.min(80, 400 / (entering.length || 1)));
          for (var i = 0; i < entering.length; i++) {
            (function(el, delay) {
              el.style.opacity = "0";
              el.style.transform = "translateY(16px)";
              el.style.transition = "none";
              el.offsetHeight;
              el.style.transition = "opacity 350ms cubic-bezier(0.0, 0.0, 0.2, 1) " + delay + "ms, transform 400ms cubic-bezier(0.0, 0.0, 0.2, 1) " + delay + "ms";
              el.style.opacity = "1";
              el.style.transform = "translateY(0)";
            })(entering[i], i * staggerMs);
          }

          var totalTime = _canvasFlipDuration + entering.length * staggerMs + 200;
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
            _canvasUpdateEmpty();
          }, totalTime);
        });
      });
    }, enterDelay);

    _canvasUpdateEmpty();
  }

  canvasState.onChange(function(type, data) {
    if (!canvasGrid) return;
    // Phase 31: skip canvas-view rendering entirely when hidden
    var _cvEl = canvasGrid.closest('#canvas-view');
    if (_cvEl && _cvEl.style.display === 'none') return;
    if (type === "reset") {
      // Immediate rebuild on page load
      Object.keys(_canvasGridEls).forEach(function(id) { _canvasGridEls[id].remove(); });
      _canvasGridEls = {};
      if (Array.isArray(data)) {
        for (var i = 0; i < data.length; i++) {
          var c = data[i];
          var el = _renderCanvasTile(c);
          el.style.opacity = "1";
          el.style.transform = "";
          el.dataset.order = (c.layout && c.layout.order != null) ? c.layout.order : i;
          _canvasGridEls[c.id] = el;
          canvasGrid.appendChild(el);
        }
        _canvasReorder();
      }
      _canvasUpdateEmpty();
      return;
    }
    _canvasQueueOp(type, data);
  });

  // ── StreamCanvasParser: incremental parser for streaming canvas ops ──
  var StreamCanvasParser = (function() {
    var _inBlock = false;     // inside a scratchy-canvas or scratchy-a2ui block
    var _blockType = null;    // "canvas" or "a2ui"
    var _appliedHashes = {};  // dedup: hash → true
    var _lastScanPos = 0;     // resume position in accumulated text

    function _hashOp(op) {
      return (op.op || "") + "|" + (op.id || "") + "|" + JSON.stringify(op.data || {});
    }

    function _emitCanvasOp(op) {
      var h = _hashOp(op);
      if (_appliedHashes[h]) return;
      _appliedHashes[h] = true;

      // Surface ops (toast/overlay/dismiss)
      if (typeof SurfaceDom !== "undefined") {
        if (op.op === "toast") { SurfaceDom.toast(op.message || (op.data && op.data.message) || "", op.data || {}); return; }
        if (op.op === "overlay") { SurfaceDom.overlay(op.id || "overlay-" + Date.now(), op.data || {}); return; }
        if (op.op === "dismiss") { SurfaceDom.remove(op.id || ""); return; }
      }

      // Phase 31: Also render into active widget region (inline in chat)
      _renderOpsInWidgetRegion([op]);

      _canvasBeginBatch();
      canvasState.apply(op);
      _canvasEndBatch();
    }

    function _emitA2ui(envelope) {
      if (typeof SurfaceManager !== "undefined") {
        SurfaceManager.processBatch([{ type: "a2ui", payload: envelope }]);
      }
    }

    function feed(text) {
      // Scan from where we left off
      var pos = _lastScanPos;
      while (pos < text.length) {
        var nlIdx = text.indexOf("\n", pos);
        if (nlIdx === -1) break; // no complete line yet
        var line = text.substring(pos, nlIdx).trim();
        pos = nlIdx + 1;

        if (!_inBlock) {
          if (line === "```scratchy-canvas") { _inBlock = true; _blockType = "canvas"; }
          else if (line === "```scratchy-a2ui") { _inBlock = true; _blockType = "a2ui"; }
        } else {
          if (line === "```") { _inBlock = false; _blockType = null; }
          else if (line) {
            try {
              var parsed = JSON.parse(line);
              if (_blockType === "canvas" && parsed && parsed.op) {
                _emitCanvasOp(parsed);
              } else if (_blockType === "a2ui" && parsed && (parsed.surfaceUpdate || parsed.dataModelUpdate || parsed.beginRendering || parsed.deleteSurface)) {
                _emitA2ui(parsed);
              }
            } catch(e) { /* partial or invalid JSON — skip */ }
          }
        }
      }
      _lastScanPos = pos;
    }

    function finalize() {
      _inBlock = false;
      _blockType = null;
      _appliedHashes = {};
      _lastScanPos = 0;
      // Phase 31: finalize the active widget region
      _finalizeWidgetRegion();
    }

    return { feed: feed, finalize: finalize };
  })();

  // Parse scratchy-canvas AND scratchy-toon blocks and apply to canvasState (for canvas mode)
  function parseCanvasOps(text) {
    var re = /```scratchy-canvas\s*\n([\s\S]*?)```/g;
    var toonRe = /```scratchy-toon\s*\n([\s\S]*?)```/g;
    var match;
    var chatText = text;

    // Phase 31: No auto-switch — widgets render inline via widget regions
    // The StreamCanvasParser handles inline rendering during streaming
    // This function processes the final text for any missed ops
    re.lastIndex = 0;
    toonRe.lastIndex = 0;

    while ((match = re.exec(text)) !== null) {
      var lines = match[1].split("\n");
      var ops = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        try {
          var op = JSON.parse(line);
          if (op && op.op) ops.push(op);
        } catch(e) {}
      }
      // Canvas state persistence handled by localStorage (onChange handler above)
      // Handle surface-specific ops (toast, overlay, sidebar) before canvas state
      var canvasOps = [];
      for (var k = 0; k < ops.length; k++) {
        var sop = ops[k];
        if (typeof SurfaceDom !== 'undefined') {
          if (sop.op === 'toast') {
            SurfaceDom.toast(sop.message || sop.data && sop.data.message || '', sop.data || {});
            continue;
          }
          if (sop.op === 'overlay') {
            SurfaceDom.overlay(sop.id || 'overlay-' + Date.now(), sop.data || {});
            continue;
          }
          if (sop.op === 'dismiss') {
            SurfaceDom.remove(sop.id || '');
            continue;
          }
        }
        // "trigger" op: auto-fire a widget action (no user click needed)
        if (sop.op === 'trigger' && sop.action) {
          (function(triggerAction, triggerContext) {
            setTimeout(function() {
              console.log('[Canvas] Auto-trigger:', triggerAction, triggerContext ? 'with context' : '');
              // Clear any dismiss suppression for this action's prefix
              var triggerPrefix = triggerAction.split('-')[0];
              if (triggerPrefix && _dismissedPrefixes[triggerPrefix]) delete _dismissedPrefixes[triggerPrefix];
              // Switch to chat tab so user sees the widget response
              if (window._scratchySwitchToChat) window._scratchySwitchToChat();
              if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
                connection.ws.send(JSON.stringify({
                  type: "widget-action",
                  sessionKey: connection.sessionKey,
                  data: { surfaceId: 'main', componentId: 'auto', action: triggerAction, context: triggerContext || {} },
                  timestamp: Date.now()
                }));
              }
            }, 100);
          })(sop.action, sop.context);
          continue;
        }
        canvasOps.push(sop);
      }
      // Apply canvas ops with batch signals
      if (canvasOps.length > 0) {
        // Phase 31: Also render into widget regions (for non-streaming final messages)
        _renderOpsInWidgetRegion(canvasOps);

        _canvasBeginBatch();
        for (var k = 0; k < canvasOps.length; k++) {
          canvasState.apply(canvasOps[k]);
        }
        _canvasEndBatch();
      }
    }
    // Parse scratchy-toon blocks (TOON format — token-efficient alternative)
    if (typeof ToonIntegration !== 'undefined') {
      var toonResult = ToonIntegration.parseBlocks(text);
      if (toonResult.ops.length > 0) {
        var toonCanvasOps = [];
        for (var ti = 0; ti < toonResult.ops.length; ti++) {
          var top = toonResult.ops[ti];
          if (typeof SurfaceDom !== 'undefined') {
            if (top.op === 'toast') { SurfaceDom.toast(top.message || (top.data && top.data.message) || '', top.data || {}); continue; }
            if (top.op === 'overlay') { SurfaceDom.overlay(top.id || 'overlay-' + Date.now(), top.data || {}); continue; }
            if (top.op === 'dismiss') { SurfaceDom.remove(top.id || ''); continue; }
          }
          if (top.op === 'trigger' && top.action) {
            (function(triggerAction, triggerContext) {
              setTimeout(function() {
                if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
                  connection.ws.send(JSON.stringify({ type: "widget-action", sessionKey: connection.sessionKey, data: { surfaceId: 'main', componentId: 'auto', action: triggerAction, context: triggerContext || {} }, timestamp: Date.now() }));
                }
              }, 100);
            })(top.action, top.context);
            continue;
          }
          toonCanvasOps.push(top);
        }
        if (toonCanvasOps.length > 0) {
          // Phase 31: render into widget regions
          _renderOpsInWidgetRegion(toonCanvasOps);
          _canvasBeginBatch();
          for (var tk = 0; tk < toonCanvasOps.length; tk++) {
            canvasState.apply(toonCanvasOps[tk]);
          }
          _canvasEndBatch();
        }
      }
    }

    // Parse scratchy-a2ui blocks (native v2 format)
    var a2uiRe = /```scratchy-a2ui\s*\n([\s\S]*?)```/g;
    var a2uiMatch;
    while ((a2uiMatch = a2uiRe.exec(text)) !== null) {
      var a2uiLines = a2uiMatch[1].split("\n");
      var envelopes = [];
      for (var ai = 0; ai < a2uiLines.length; ai++) {
        var aline = a2uiLines[ai].trim();
        if (!aline) continue;
        try {
          var parsed = JSON.parse(aline);
          if (parsed.surfaceUpdate || parsed.dataModelUpdate || parsed.beginRendering || parsed.deleteSurface) {
            envelopes.push({ type: 'a2ui', payload: parsed });
          }
        } catch(e) {}
      }
      if (envelopes.length > 0 && typeof SurfaceManager !== 'undefined') {
        SurfaceManager.processBatch(envelopes);
      }
    }

    // Return text without canvas/toon/a2ui/tpl blocks for chat
    return chatText
      .replace(/```scratchy-canvas[\s\S]*?```/g, "")
      .replace(/```scratchy-toon[\s\S]*?```/g, "")
      .replace(/```scratchy-a2ui[\s\S]*?```/g, "")
      .replace(/```scratchy-tpl[\s\S]*?```/g, "")
      .replace(/\[SecurityPlugin Canary\][^\n]*/g, "")
      .replace(/\[message_id:[^\]]*\]/g, "")
      .replace(/\[genui:\w+\]/g, "")
      .trim();
  }

  // ── TOON Stream Parser setup ──
  var _toonStreamParser = null;
  if (typeof ToonIntegration !== 'undefined') {
    _toonStreamParser = ToonIntegration.createStreamParser({
      onOp: function(op) {
        if (op && op.op) {
          // Surface ops
          if (typeof SurfaceDom !== 'undefined') {
            if (op.op === 'toast') { SurfaceDom.toast(op.message || (op.data && op.data.message) || '', op.data || {}); return; }
            if (op.op === 'overlay') { SurfaceDom.overlay(op.id || 'overlay-' + Date.now(), op.data || {}); return; }
            if (op.op === 'dismiss') { SurfaceDom.remove(op.id || ''); return; }
          }
          // Render inline in chat widget region (same as JSON stream parser)
          _renderOpsInWidgetRegion([op]);
          _canvasBeginBatch();
          canvasState.apply(op);
          _canvasEndBatch();
        }
      }
    });
  }

  // Hook into existing message handlers to also feed canvas
  var _origOnMessage = connection.onMessage;
  connection.onMessage = function(message) {
    // Finalize stream parsers + full parse as safety net (dedup prevents doubles)
    StreamCanvasParser.finalize();
    if (_toonStreamParser) _toonStreamParser.finalize();
    if (message.text) {
      var chatText = parseCanvasOps(message.text);
      // Phase 31: Strip canvas blocks from the message text so they don't show as code in chat
      // The widget regions are already rendered inline by parseCanvasOps
      if (chatText !== message.text) {
        message.text = chatText;
      }
    }
    // Skip empty messages (pure canvas ops with no text) — widget regions handle the rendering
    if (!message.text || !message.text.trim()) {
      // Still finalize any streaming bubble so it doesn't stay in DOM with raw canvas text
      if (typeof store !== 'undefined' && store.finalizeStreaming) {
        var orphan = store.finalizeStreaming("");
        if (orphan && orphan.el && orphan.el.parentNode) orphan.el.remove();
      }
      return;
    }
    // Call the original handler (feeds chat mode store)
    if (_origOnMessage) _origOnMessage(message);
  };

  var _origOnStreamDelta = connection.onStreamDelta;
  connection.onStreamDelta = function(message) {
    // Incremental streaming: fire canvas ops as lines complete (no waiting for closing ```)
    if (message.text) {
      StreamCanvasParser.feed(message.text);
      if (_toonStreamParser) _toonStreamParser.feed(message.text);
    }
    if (_origOnStreamDelta) _origOnStreamDelta(message);
  };

  var _origOnAgentActivity = connection.onAgentActivity;
  connection.onAgentActivity = function(activity) {
    // Phase 31: canvas chat status removed (unified view)
    // Feed AG-UI handler — map gateway activity to AG-UI events
    if (typeof AgUiHandler !== 'undefined') {
      if (activity.type === "thinking") {
        AgUiHandler.handleEvent({ type: "RUN_STARTED", runId: "run-" + Date.now(), threadId: "main", timestamp: Date.now() });
        AgUiHandler.handleEvent({ type: "TEXT_MESSAGE_START", runId: "run-" + Date.now(), timestamp: Date.now() });
      } else if (activity.type === "tool") {
        AgUiHandler.handleEvent({ type: "STEP_STARTED", runId: "active", stepId: "step-" + Date.now(), stepName: activity.name || "working", timestamp: Date.now() });
      } else if (activity.type === "done") {
        AgUiHandler.handleEvent({ type: "RUN_FINISHED", runId: "active", timestamp: Date.now() });
      }
    }
    if (_origOnAgentActivity) _origOnAgentActivity(activity);
  };

  // Handle canvas state sync from server (cross-device + widget action results)
  connection.onCanvasUpdate = function(payload) {
    if (payload && payload.ops && Array.isArray(payload.ops)) {
      // Set intent flag: user-initiated ops bypass dismiss, auto-restores don't
      _lastRenderWasUserInitiated = !payload.restore && !payload.autoRestore && !!payload.userInitiated;

      // On page load restore: apply to canvasState ONLY (no render).
      // Server re-triggers will send fresh widget state separately.
      // This prevents stale disk state from competing with fresh renders.
      if (payload.restore) {
        console.log("[Scratchy] Canvas restore — " + payload.ops.length + " components loaded into state (no render)");
        _canvasBeginBatch();
        for (var r = 0; r < payload.ops.length; r++) {
          canvasState.apply(payload.ops[r]);
        }
        _canvasEndBatch();
        // Invalidate localStorage cache — server state is authoritative
        try { localStorage.removeItem('scratchy-canvas-state-v2'); } catch(e) {}
        return;
      }

      // If history hasn't rendered yet, queue this update
      if (!_historyRendered) {
        console.log("[Scratchy] Canvas-update arrived before history — queuing " + payload.ops.length + " ops");
        _pendingCanvasUpdates.push(payload);
        _canvasBeginBatch();
        for (var q = 0; q < payload.ops.length; q++) {
          canvasState.apply(payload.ops[q]);
        }
        _canvasEndBatch();
        return;
      }

      // Apply to canvasState first, then render widget region
      _canvasBeginBatch();
      for (var j = 0; j < payload.ops.length; j++) {
        canvasState.apply(payload.ops[j]);
      }
      _canvasEndBatch();

      _renderOpsInWidgetRegion(payload.ops);
      _lastRenderWasUserInitiated = false; // reset after render
    }
  };

  // ── Keyboard navigation for canvas tiles ──
  if (canvasGrid) {
    canvasGrid.addEventListener('keydown', function(e) {
      var tiles = Array.from(canvasGrid.querySelectorAll('.dash-tile'));
      var current = tiles.indexOf(document.activeElement);
      if (current === -1) return;

      var columns = 1;
      var cs = getComputedStyle(canvasGrid);
      if (cs.gridTemplateColumns) columns = cs.gridTemplateColumns.split(' ').length;

      var next = -1;
      switch (e.key) {
        case 'ArrowRight': next = Math.min(current + 1, tiles.length - 1); break;
        case 'ArrowLeft': next = Math.max(current - 1, 0); break;
        case 'ArrowDown': next = Math.min(current + columns, tiles.length - 1); break;
        case 'ArrowUp': next = Math.max(current - columns, 0); break;
        default: return;
      }

      if (next !== -1 && next !== current) {
        e.preventDefault();
        tiles[current].tabIndex = -1;
        tiles[next].tabIndex = 0;
        tiles[next].focus();
      }
    });
  }

  // ── Streaming progress bar ──
  var _progressBar = document.createElement('div');
  _progressBar.className = 'streaming-progress';
  _progressBar.style.display = 'none';
  document.body.appendChild(_progressBar);

  // Hook into existing activity handler to show/hide progress bar
  var _origActivity2 = connection.onAgentActivity;
  connection.onAgentActivity = function(activity) {
    if (activity.type === 'thinking' || activity.type === 'tool') {
      _progressBar.style.display = 'block';
    } else if (activity.type === 'done') {
      _progressBar.style.display = 'none';
    }
    if (_origActivity2) _origActivity2.call(this, activity);
  };

  // ── Context Meter ──
  var _contextMaxTokens = 150000;
  var _contextBaseTokens = 0; // Let message counting handle it — base offset was way too high
  var _contextEstTokens = 0;

  function updateContextMeter(pct) {
    window._contextPct = pct;
    var meter = document.getElementById('context-meter');
    var fill = meter ? meter.querySelector('.context-meter__fill') : null;
    var tooltip = document.getElementById('context-meter-tooltip');
    if (!meter || !fill) return;
    pct = Math.max(0, Math.min(100, pct));
    fill.style.setProperty('--context-pct', pct);
    meter.setAttribute('aria-valuenow', pct);
    var level = pct >= 90 ? 'critical' : pct >= 75 ? 'high' : pct >= 50 ? 'medium' : 'low';
    meter.dataset.level = level;
    // Update tooltip
    if (tooltip) {
      var estK = Math.round(_contextEstTokens / 1000);
      var maxK = Math.round(_contextMaxTokens / 1000);
      tooltip.textContent = 'Context: ~' + pct + '% (' + estK + 'k/' + maxK + 'k tokens)';
    }
  }
  window.updateContextMeter = updateContextMeter;

  // ── Compaction Indicator (event-driven + sessionStorage persistence) ──
  var _compactionEl = null;
  var _compactionStartTime = null;
  var _compactionMaxTimer = null;
  var _compactionTokensBefore = null;  // Real token count from gateway
  var _compactionContextWindow = null; // Context window from gateway
  var _compactionRealPct = null; // Real streaming progress from gateway
  var _compactionActive = false; // True between compaction:start and compaction:end
  var COMPACT_STORAGE_KEY = 'scratchy_compaction';

  function _setMeterCompacting(active) {
    var meter = document.getElementById('context-meter');
    var label = document.getElementById('context-meter-label');
    if (meter) meter.dataset.compacting = active ? 'true' : 'false';
    if (label) label.dataset.visible = active ? 'true' : 'false';
  }

  function _compactionElapsed() {
    if (!_compactionStartTime) return '';
    var s = Math.floor((Date.now() - _compactionStartTime) / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    return (m > 0 ? m + 'm ' : '') + s + 's';
  }

  // Progress: logarithmic curve with dynamic τ based on context size.
  // Smooth compaction progress using logarithmic easing.
  // Old exponential decay (1-e^(-t/τ)) was too front-loaded: 0→85% fast, then crawled.
  // New approach: logarithmic curve gives steady perceived progress.
  //   Phase 1 (0-70%): steady linear-ish climb based on elapsed time
  //   Phase 2 (70-95%): gentle slowdown (still moving visibly)
  // Real gateway pct overrides estimation when available.
  var _compactionDisplayPct = 0; // Smoothed display value
  var _compactionTargetPct = 0;  // Target value (from estimation or gateway)
  
  function _compactionProgress() {
    // Calculate target
    var target;
    if (_compactionRealPct != null) {
      // Real streaming progress from gateway — let it go up to 99%
      target = Math.min(99, _compactionRealPct);
    } else if (!_compactionStartTime) {
      target = 0;
    } else {
      var elapsed = (Date.now() - _compactionStartTime) / 1000;
      var tokens = _compactionTokensBefore || window._contextEstTokens || 100000;
      // Estimate total duration: ~1s per 10k tokens (rough)
      var estDuration = Math.max(5, Math.min(60, tokens / 10000));
      // Logarithmic progress: fast start, steady middle, gentle slowdown
      var t = elapsed / estDuration;
      if (t < 0.8) {
        // Phase 1: steady climb to 70% over ~80% of estimated time
        target = (t / 0.8) * 70;
      } else {
        // Phase 2: 70% → 95% over remaining time, with diminishing returns
        var t2 = (t - 0.8) / 0.8; // normalize to 0-1 (allows overshoot)
        target = 70 + 25 * (1 - Math.exp(-2 * t2));
      }
      target = Math.min(95, Math.round(target));
    }
    _compactionTargetPct = target;
    
    // Smooth towards target — never jump more than 3% per update (1s interval)
    if (_compactionDisplayPct < target) {
      var step = Math.max(1, Math.min(3, (target - _compactionDisplayPct) * 0.4));
      _compactionDisplayPct = Math.min(target, _compactionDisplayPct + step);
    }
    return Math.round(_compactionDisplayPct);
  }

  function _updateCompactionUI() {
    if (!_compactionEl) return;
    var elapsed = _compactionEl.querySelector('.compact-indicator__elapsed');
    if (elapsed) elapsed.textContent = _compactionElapsed();
    var bar = _compactionEl.querySelector('.compact-indicator__bar-fill');
    if (bar) bar.style.width = _compactionProgress() + '%';
    var pctLabel = _compactionEl.querySelector('.compact-indicator__pct');
    if (pctLabel) pctLabel.textContent = _compactionProgress() + '%';
  }

  function _persistCompaction() {
    try {
      sessionStorage.setItem(COMPACT_STORAGE_KEY, JSON.stringify({
        startTime: _compactionStartTime,
        pct: Math.round(window._contextPct || 0),
        tokens: window._contextEstTokens ? Math.round(window._contextEstTokens / 1000) + 'k' : '?'
      }));
    } catch(e) {}
  }

  function _clearCompactionStorage() {
    try { sessionStorage.removeItem(COMPACT_STORAGE_KEY); } catch(e) {}
  }

  var _compactionLastHideTime = 0; // Debounce: don't restart within 10s of hiding

  function showCompactionIndicator(pct, tokens) {
    if (_compactionEl) return; // already showing
    // Suppress rapid re-trigger (pre-compaction flush → actual compaction fires twice)
    if (Date.now() - _compactionLastHideTime < 10000) return;
    _setMeterCompacting(true);
    if (!_compactionStartTime) _compactionStartTime = Date.now();
    _compactionRealPct = null;
    _compactionDisplayPct = 0;
    _compactionTargetPct = 0;
    pct = pct || Math.round(window._contextPct || 0);
    tokens = tokens || (window._contextEstTokens ? Math.round(window._contextEstTokens / 1000) + 'k' : '?');
    _compactionEl = document.createElement('div');
    _compactionEl.className = 'compact-indicator';
    _compactionEl.innerHTML =
      '<div class="compact-indicator__icon"><span class="compact-indicator__diamond"></span></div>' +
      '<div class="compact-indicator__content">' +
        '<span class="compact-indicator__title">Compacting context\u2026</span>' +
        '<div class="compact-indicator__bar"><div class="compact-indicator__bar-fill" style="width:' + _compactionProgress() + '%"></div></div>' +
        '<span class="compact-indicator__subtitle">' +
          '<span class="compact-indicator__pct">' + _compactionProgress() + '%</span> \u2022 ' +
          pct + '% context (' + tokens + ' tokens) \u2022 ' +
          '<span class="compact-indicator__elapsed">' + _compactionElapsed() + '</span>' +
        '</span>' +
      '</div>';
    _compactionEl._interval = setInterval(_updateCompactionUI, 1000);
    // Remove any existing activity indicator
    var indicator = document.getElementById('activity-indicator');
    if (indicator) indicator.remove();
    var streaming = document.getElementById('streaming-message');
    if (streaming) streaming.remove();
    messagesContainer.appendChild(_compactionEl);
    renderer._scrollToBottom();
    _persistCompaction();
    // Safety: auto-hide after 10 minutes
    if (_compactionMaxTimer) clearTimeout(_compactionMaxTimer);
    _compactionMaxTimer = setTimeout(function() { hideCompactionIndicator(); }, 600000);
  }

  function hideCompactionIndicator() {
    _clearCompactionStorage();
    if (!_compactionEl) return;
    _compactionLastHideTime = Date.now();
    _setMeterCompacting(false);
    if (_compactionEl._interval) clearInterval(_compactionEl._interval);
    
    // Animate smoothly to 100% before showing "done"
    var bar = _compactionEl.querySelector('.compact-indicator__bar-fill');
    var pctLabel = _compactionEl.querySelector('.compact-indicator__pct');
    var title = _compactionEl.querySelector('.compact-indicator__title');
    var el = _compactionEl;
    var currentPct = _compactionDisplayPct || 0;
    
    // Quick smooth animation from current → 100% (500ms)
    var animStart = Date.now();
    var animDur = 500;
    function animateTo100() {
      var t = Math.min(1, (Date.now() - animStart) / animDur);
      // ease-out cubic
      var eased = 1 - Math.pow(1 - t, 3);
      var pct = Math.round(currentPct + (100 - currentPct) * eased);
      if (bar) bar.style.width = pct + '%';
      if (pctLabel) pctLabel.textContent = pct + '%';
      if (t < 1) {
        requestAnimationFrame(animateTo100);
      } else {
        // Show "done" state for 1.5s then remove
        if (title) title.textContent = 'Context compacted \u2714';
        el.dataset.state = 'done';
        setTimeout(function() { if (el.parentNode) el.remove(); }, 1500);
      }
    }
    requestAnimationFrame(animateTo100);
    
    _compactionEl = null;
    _compactionStartTime = null;
    _compactionRealPct = null;
    _compactionDisplayPct = 0;
    _compactionTargetPct = 0;
    if (_compactionMaxTimer) { clearTimeout(_compactionMaxTimer); _compactionMaxTimer = null; }
  }

  // Restore compaction state after page reload
  (function _restoreCompaction() {
    try {
      var saved = sessionStorage.getItem(COMPACT_STORAGE_KEY);
      if (saved) {
        var state = JSON.parse(saved);
        // Only restore if started recently (< 10 min)
        if (state.startTime && (Date.now() - state.startTime) < 600000) {
          _compactionStartTime = state.startTime;
          console.log('[Scratchy] Restoring compaction indicator (started ' + _compactionElapsed() + ' ago)');
          showCompactionIndicator(state.pct, state.tokens);
        } else {
          _clearCompactionStorage();
        }
      }
    } catch(e) {}
  })();

  // Primary: listen for gateway compaction events
  var _origActivity3 = connection.onAgentActivity;
  connection.onAgentActivity = function(activity) {
    if (activity.type === 'compaction') {
      if (activity.phase === 'start') {
        // Store server-reported token data for accurate progress
        var detail = activity.detail || {};
        _compactionTokensBefore = detail.tokensBefore || null;
        _compactionContextWindow = detail.contextWindow || null;
        _compactionActive = true;
        console.log('[Scratchy] Compaction started (gateway event) tokensBefore=' +
          (_compactionTokensBefore || '?') + ' contextWindow=' + (_compactionContextWindow || '?'));
        showCompactionIndicator();
      } else if (activity.phase === 'progress') {
        var progressDetail = activity.detail || {};
        if (progressDetail.pct != null) {
          // Real streaming progress from gateway — override the estimation
          _compactionRealPct = progressDetail.pct;
          console.log('[Scratchy] Real compaction progress: ' + progressDetail.pct + '%');
        }
        _updateCompactionUI();
      } else if (activity.phase === 'end') {
        var endDetail = activity.detail || {};
        var tb = endDetail.tokensBefore || _compactionTokensBefore;
        var ta = endDetail.tokensAfter;
        console.log('[Scratchy] Compaction ended (gateway event) ' +
          (tb ? tb + '→' + (ta || '?') : '') + ' tokens');
        // Update context meter with real post-compaction data if available
        if (ta && _compactionContextWindow) {
          var realPct = Math.round((ta / _compactionContextWindow) * 100);
          updateContextMeter(realPct);
        }
        _compactionActive = false;
        _compactionTokensBefore = null;
        _compactionContextWindow = null;
        hideCompactionIndicator();
      }
    }
    // Also hide on agent done (safety net) — but NOT during active compaction
    if (activity.type === 'done' && !_compactionActive) {
      hideCompactionIndicator();
    }
    if (_origActivity3) _origActivity3.call(this, activity);
  };

  // Also hide on streaming delta (agent is responding post-compaction)
  // BUT: don't hide during active compaction — deltas during compaction are the summary text
  var _compactOrigDelta = connection.onStreamDelta;
  connection.onStreamDelta = function(delta) {
    if (_compactionEl && !_compactionActive) hideCompactionIndicator();
    if (_compactOrigDelta) _compactOrigDelta.call(this, delta);
  };

  // Also detect compaction from history or final messages
  var _compactOrigMsg = connection.onMessage;
  connection.onMessage = function(msg) {
    // Any incoming final message = agent is done, hide indicator
    _compactionActive = false;
    if (_compactionEl) hideCompactionIndicator();
    _cancelCompactionHeuristic();
    if (msg && msg.role === 'compaction') {
      updateContextMeter(15); // estimate: compaction resets to ~15% with 800k window
      // Request canvas state refresh from server — compaction clears conversation context
      // but server still has the canvas state tracked in _serverCanvasState
      if (connection && connection.ws && connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(JSON.stringify({ type: "canvas-refresh", timestamp: Date.now() }));
      }
    }
    if (_compactOrigMsg) _compactOrigMsg.call(this, msg);
  };

  // ── Compaction heuristic fallback ──
  // Only triggers at very high context usage AND long silence.
  // Primary detection is via gateway compaction:start/end events — this is just a safety net.
  var _compactionHeuristicTimer = null;
  window._contextPct = 0;

  function _startCompactionHeuristic() {
    // Disabled — gateway compaction:start/end events are the reliable source.
    // Heuristic was causing false positives (showing indicator when no compaction was happening).
    // Keeping the function as a no-op so call sites don't break.
    return;
  }

  function _cancelCompactionHeuristic() {
    if (_compactionHeuristicTimer) {
      clearTimeout(_compactionHeuristicTimer);
      _compactionHeuristicTimer = null;
    }
  }

  // Hook into send to start heuristic
  var _compactOrigSend = connection.send;
  connection.send = function() {
    var result = _compactOrigSend.apply(this, arguments);
    _startCompactionHeuristic();
    return result;
  };

  // Cancel heuristic on first delta (agent responded, no compaction)
  var _compactOrigDelta2 = connection.onStreamDelta;
  connection.onStreamDelta = function(delta) {
    _cancelCompactionHeuristic();
    if (_compactionEl && !_compactionActive) hideCompactionIndicator();
    if (_compactOrigDelta2) _compactOrigDelta2.call(this, delta);
  };

  // ── Context usage from gateway (real data) ──
  var _contextPollTimer = null;
  function fetchContextUsage() {
    fetch('/api/context', { credentials: 'include' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        _contextMaxTokens = data.contextWindow || 800000;
        _contextEstTokens = data.totalTokens || 0;
        window._contextEstTokens = _contextEstTokens;
        window._contextPct = data.pct || 0;
        updateContextMeter(data.pct || 0);
      })
      .catch(function() {}); // silent fail
  }
  // Poll every 15s + on message change
  function startContextPolling() {
    fetchContextUsage();
    if (_contextPollTimer) clearInterval(_contextPollTimer);
    _contextPollTimer = setInterval(fetchContextUsage, 15000);
  }
  store.onChange(function() {
    // Debounce: fetch 2s after last message change
    clearTimeout(window._contextDebounce);
    window._contextDebounce = setTimeout(fetchContextUsage, 2000);
  });
  setTimeout(startContextPolling, 1000);

  // ── Phase 32: Workspace (Pin to Workspace) ──
  var _workspaceStore = null;
  var _workspaceRenderer = null;
  var _workspaceHistory = null;
  var _activeTab = 'chat'; // 'chat' | 'workspace'

  if (typeof WorkspaceStore === 'function') {
    _workspaceStore = new WorkspaceStore();
    _workspaceStore.load();
    window._workspaceStore = _workspaceStore; // expose for debugging

    var wsGrid = document.getElementById('workspace-grid');
    var wsEmpty = document.getElementById('workspace-empty');
    var wsView = document.getElementById('workspace-view');
    var wsTabBar = document.getElementById('workspace-tab-bar');
    var wsBadge = document.getElementById('workspace-badge');
    var wsHistoryPanel = document.getElementById('workspace-history-panel');

    // Init renderer
    if (typeof WorkspaceRenderer === 'function' && wsGrid) {
      _workspaceRenderer = new WorkspaceRenderer({
        container: wsGrid,
        workspaceStore: _workspaceStore,
        canvasState: canvasState,
        emptyEl: wsEmpty
      });
    }

    // Init history
    if (typeof WorkspaceHistory === 'function' && wsHistoryPanel) {
      _workspaceHistory = new WorkspaceHistory({
        panel: wsHistoryPanel,
        workspaceStore: _workspaceStore,
        onRestore: function(snapshot) {
          // Re-pin the snapshot's components
          if (snapshot && snapshot.widgetId && snapshot.components) {
            var compIds = Object.keys(snapshot.components);
            // Apply components to canvasState
            for (var ci = 0; ci < compIds.length; ci++) {
              var comp = snapshot.components[compIds[ci]];
              if (comp) canvasState.apply({ op: 'upsert', id: compIds[ci], type: comp.type, data: comp.data });
            }
            // Pin if not already
            if (!_workspaceStore.isPinned(snapshot.widgetId)) {
              _workspaceStore.pin(snapshot.widgetId, compIds, { icon: snapshot.icon, title: snapshot.title });
            }
          }
        }
      });
    }

    // Tab switching
    function _switchTab(tab) {
      if (tab === _activeTab) return;
      _activeTab = tab;

      var chatView = document.getElementById('chat-view');
      var inputArea = document.getElementById('input-area');
      var tabChat = document.getElementById('tab-chat');
      var tabWorkspace = document.getElementById('tab-workspace');

      if (tab === 'workspace') {
        chatView.style.display = 'none';
        if (inputArea) inputArea.style.display = 'none';
        if (wsView) wsView.classList.add('active');
        if (tabChat) tabChat.setAttribute('aria-selected', 'false');
        if (tabWorkspace) tabWorkspace.setAttribute('aria-selected', 'true');
        // Reset badge + tracking
        if (wsBadge) { wsBadge.style.display = 'none'; wsBadge.textContent = '0'; }
        _badgeUpdatedWidgets = {};
        // Announce to screen reader
        var sr = document.getElementById('sr-announcer');
        if (sr) sr.textContent = 'Switched to Workspace view';
      } else {
        if (wsView) wsView.classList.remove('active');
        chatView.style.display = '';
        if (inputArea) inputArea.style.display = '';
        if (tabChat) tabChat.setAttribute('aria-selected', 'true');
        if (tabWorkspace) tabWorkspace.setAttribute('aria-selected', 'false');
        var sr2 = document.getElementById('sr-announcer');
        if (sr2) sr2.textContent = 'Switched to Chat view';
      }

      try { localStorage.setItem('scratchy-active-tab', tab); } catch(e) {}
    }

    // Wire tab clicks
    if (wsTabBar) {
      wsTabBar.addEventListener('click', function(e) {
        var tabBtn = e.target.closest('.tab-item');
        if (!tabBtn) return;
        _switchTab(tabBtn.dataset.tab);
      });
    }

    // Wire workspace header actions (history button + empty state browse)
    if (wsView) {
      wsView.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-action="history"]');
        if (btn && _workspaceHistory) {
          _workspaceHistory.toggle();
        }
      });
    }

    // Show/hide tab bar based on pin count
    function _updateTabBarVisibility() {
      if (!wsTabBar) return;
      var pinCount = Object.keys(_workspaceStore.pins).length;
      if (pinCount > 0) {
        if (!wsTabBar.classList.contains('visible')) {
          wsTabBar.classList.add('visible');
          wsTabBar.classList.add('entering');
          setTimeout(function() { wsTabBar.classList.remove('entering'); }, 400);
        }
      } else {
        // Keep visible if on workspace tab or has history
        if (_activeTab !== 'workspace' && _workspaceStore.history.length === 0) {
          wsTabBar.classList.remove('visible');
          if (_activeTab === 'workspace') _switchTab('chat');
        }
      }
    }

    _workspaceStore.onChange(function(type) {
      _updateTabBarVisibility();
      // Persist on changes
      _workspaceStore.save();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === '1') { e.preventDefault(); _switchTab('chat'); }
      if (mod && e.key === '2') { e.preventDefault(); _switchTab('workspace'); }
      if (mod && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        _switchTab(_activeTab === 'chat' ? 'workspace' : 'chat');
      }
    });

    // Badge updates: when canvas changes while on chat tab, show count of distinct updated widgets
    var _badgeUpdatedWidgets = {};
    canvasState.onChange(function(type, data) {
      if (_activeTab !== 'chat' || !wsBadge) return;
      if (!data || !data.id) return;
      if (_workspaceStore.isPinnedComponent(data.id)) {
        // Find which widget owns this component
        var pins = _workspaceStore.getPins();
        for (var pi = 0; pi < pins.length; pi++) {
          var pin = pins[pi];
          if (pin.componentIds && pin.componentIds.indexOf(data.id) !== -1) {
            _badgeUpdatedWidgets[pin.widgetId] = true;
            break;
          }
        }
        var distinctCount = Object.keys(_badgeUpdatedWidgets).length;
        wsBadge.textContent = distinctCount;
        wsBadge.style.display = '';
        wsBadge.classList.add('updating');
        setTimeout(function() { wsBadge.classList.remove('updating'); }, 700);
      }
    });

    // Listen for workspace expand events (workspace cards use different button classes)
    document.addEventListener('workspace-expand', function(e) {
      var detail = e.detail || {};
      var cardEl = detail.cardEl;
      if (!cardEl || cardEl.classList.contains('widget-expanded')) return;

      cardEl.classList.add('widget-expanded');

      var backdrop = document.createElement('div');
      backdrop.className = 'widget-expanded-backdrop';
      document.body.appendChild(backdrop);

      var expandBtn = cardEl.querySelector('.wc-action[data-action="expand"]');
      if (expandBtn) {
        expandBtn.textContent = '\u2715'; // ✕
        expandBtn.title = 'Collapse';
        expandBtn.dataset.action = 'collapse-expanded';
      }

      function collapse() {
        cardEl.classList.add('widget-collapsing');
        backdrop.classList.add('widget-backdrop-closing');
        setTimeout(function() {
          cardEl.classList.remove('widget-expanded', 'widget-collapsing');
          backdrop.remove();
          if (expandBtn) {
            expandBtn.textContent = '\u2922'; // ⤢
            expandBtn.title = 'Expand';
            expandBtn.dataset.action = 'expand';
          }
        }, 200);
        document.removeEventListener('keydown', onEsc);
      }

      backdrop.addEventListener('click', collapse);
      function onEsc(ev) { if (ev.key === 'Escape') collapse(); }
      document.addEventListener('keydown', onEsc);

      // Let the workspace-renderer's click handler know about collapse
      expandBtn && expandBtn.addEventListener('click', function collapseOnce(ev) {
        ev.stopPropagation();
        collapse();
        expandBtn.removeEventListener('click', collapseOnce);
      });
    });

    // Expose tab-switch for global callers (widget actions, sidebar triggers, etc.)
    window._scratchySwitchToChat = function() {
      if (_activeTab !== 'chat') _switchTab('chat');
    };
    // Expose active tab for cross-scope guards (switchView, _scratchySwitchView)
    window._scratchyActiveTab = function() { return _activeTab; };

    // Initial visibility check
    _updateTabBarVisibility();

    // Restore last active tab (only if workspace has pins)
    try {
      var savedTab = localStorage.getItem('scratchy-active-tab');
      if (savedTab === 'workspace' && Object.keys(_workspaceStore.pins).length > 0) {
        _switchTab('workspace');
      }
    } catch(e) {}
  }

  // Pin action handler
  function _handlePinAction(region, btn) {
    if (!_workspaceStore) return;

    var widgetId = region.dataset.widgetId || 'widget-' + Date.now();
    var isPinned = _workspaceStore.isPinned(widgetId);

    if (isPinned) {
      // Unpin
      _workspaceStore.unpin(widgetId);
      region.classList.remove('pinned');
      btn.removeAttribute('data-pinned');
      btn.title = 'Pin to Workspace';
      btn.setAttribute('data-tooltip', 'Pin to Workspace');
      var defIcon = btn.querySelector('.pin-icon-default');
      var pinIcon = btn.querySelector('.pin-icon-pinned');
      if (defIcon) defIcon.style.display = '';
      if (pinIcon) pinIcon.style.display = 'none';
      // Toast
      if (typeof SurfaceDom !== 'undefined' && SurfaceDom.toast) {
        SurfaceDom.toast('Removed from Workspace', { severity: 'info' });
      }
    } else {
      // Collect component IDs and snapshot data from this region
      var grid = region.querySelector('.canvas-grid');
      var tiles = grid ? grid.querySelectorAll('.dash-tile') : [];
      var compIds = [];
      var compData = {};
      for (var t = 0; t < tiles.length; t++) {
        var cid = tiles[t].dataset.componentId;
        if (cid) {
          compIds.push(cid);
          // Snapshot the component data from canvasState for offline restore
          var comp = canvasState.get(cid);
          if (comp) compData[cid] = { type: comp.type, data: comp.data };
        }
      }
      if (compIds.length === 0) return;

      // Get widget metadata
      var prefix = (compIds[0] || '').split('-')[0];
      var meta = _widgetMeta[prefix] || {};
      var icon = region.querySelector('.widget-region-icon');
      var title = region.querySelector('.widget-region-title');

      var result = _workspaceStore.pin(widgetId, compIds, {
        icon: icon ? icon.textContent : meta.icon || '📦',
        title: title ? title.textContent : meta.title || 'Widget',
        componentData: compData
      });

      if (result === false) {
        if (typeof SurfaceDom !== 'undefined' && SurfaceDom.toast) {
          SurfaceDom.toast('Maximum pins reached (20)', { severity: 'warning' });
        }
        return;
      }

      region.classList.add('pinned');
      btn.setAttribute('data-pinned', 'true');
      btn.title = 'Unpin from Workspace';
      btn.setAttribute('data-tooltip', 'Unpin');
      var defIcon2 = btn.querySelector('.pin-icon-default');
      var pinIcon2 = btn.querySelector('.pin-icon-pinned');
      if (defIcon2) defIcon2.style.display = 'none';
      if (pinIcon2) pinIcon2.style.display = '';

      // Pin animation
      btn.classList.add('pinning');
      setTimeout(function() { btn.classList.remove('pinning'); }, 400);

      // Toast
      if (typeof SurfaceDom !== 'undefined' && SurfaceDom.toast) {
        SurfaceDom.toast('📌 Pinned to Workspace', { severity: 'success' });
      }
    }
  }

  // Connect on page load
  connection.connect();

  // Safety: if history hasn't rendered after 8s, flush pending canvas updates anyway
  setTimeout(function() {
    if (!_historyRendered) {
      console.log("[Scratchy] Safety flush — history not rendered after 8s");
      _historyRendered = true;
      _flushPendingCanvasUpdates();
    }
  }, 8000);
})();
