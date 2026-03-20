/**
 * device-sync.js — Cross-device real-time sync for Scratchy
 *
 * Handles incoming sync events from the server so that user messages
 * sent from other devices/browsers appear in real time, and agent
 * activity indicators are mirrored across all connected clients.
 *
 * Load order: connection.js → device-sync.js → app.js
 *
 * Global: window.ScratchyDeviceSync
 */
(function () {
  'use strict';

  // ── Tool-name → friendly label mapping ──────────────────────────────
  var TOOL_LABELS = {
    'image':          '📷 Analyzing photo',
    'web_search':     '🔍 Searching the web',
    'web_fetch':      '🌐 Fetching page',
    'exec':           '⚙️ Running command',
    'read':           '📄 Reading file',
    'write':          '📝 Writing file',
    'edit':           '✏️ Editing file',
    'browser':        '🖥️ Using browser',
    'memory_search':  '🧠 Searching memory',
    'sessions_spawn': '🚀 Spawning sub-agent',
    'tts':            '🔊 Generating speech',
    'cron':           '⏰ Setting reminder',
    'message':        '💬 Sending message',
    'nodes':          '📱 Accessing device',
  };

  // ── Device ID ───────────────────────────────────────────────────────
  // Persists across page refreshes (localStorage) but is unique per
  // browser / device.  Includes a platform hint for easier debugging.

  function _getDeviceId() {
    var STORAGE_KEY = 'scratchy_deviceId';
    try {
      var id = localStorage.getItem(STORAGE_KEY);
      if (id) return id;

      var hint = /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'mob' : 'desk';
      id = 'dev-' + hint + '-' + Date.now().toString(36) + '-' +
           Math.random().toString(36).slice(2, 8);
      localStorage.setItem(STORAGE_KEY, id);
      return id;
    } catch (err) {
      // Private browsing or storage quota exceeded — fall back to a
      // session-only ID so we still function (just won't persist).
      console.warn('[DeviceSync] localStorage unavailable, using ephemeral ID', err);
      return 'dev-tmp-' + Date.now().toString(36) + '-' +
             Math.random().toString(36).slice(2, 8);
    }
  }

  // ── Internal state ──────────────────────────────────────────────────

  var _connection = null;  // ScratchyConnection reference
  var _app        = null;  // ScratchyApp reference
  var _deviceId   = _getDeviceId();
  var _inited     = false;

  // ── Helpers ─────────────────────────────────────────────────────────

  function _log(/* ...args */) {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[DeviceSync]');
    console.log.apply(console, args);
  }

  function _warn(/* ...args */) {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[DeviceSync]');
    console.warn.apply(console, args);
  }

  /**
   * Safely scroll the message container to the bottom.
   * Mirrors whatever scroll logic the app itself uses.
   */
  function _scrollToBottom() {
    try {
      if (_app && typeof _app.scrollToBottom === 'function') {
        _app.scrollToBottom();
        return;
      }
      // Fallback: find the messages container and scroll it directly
      var container = document.getElementById('messages') ||
                      document.querySelector('.messages-container');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    } catch (err) {
      // Never crash the app for a cosmetic scroll
    }
  }

  // ── Sync frame handlers ─────────────────────────────────────────────

  /**
   * Handle a "user-message" sync event — a message sent by the same
   * user from a *different* device / browser tab.
   */
  function _handleUserMessage(payload) {
    if (!payload) return;

    // Ignore our own messages (already rendered locally when sent)
    if (payload.deviceId === _deviceId) return;

    _log('Remote user message from device', payload.deviceId);

    try {
      // 1. Render in the chat via app
      if (_app) {
        // Try the most common app APIs in order of likelihood
        if (typeof _app.addUserMessage === 'function') {
          _app.addUserMessage(payload.text, payload.attachments || []);
        } else if (typeof _app.renderUserMessage === 'function') {
          _app.renderUserMessage(payload.text, payload.attachments || []);
        } else if (typeof _app._renderMessage === 'function') {
          _app._renderMessage({
            role: 'user',
            text: payload.text,
            attachments: payload.attachments || [],
            ts: payload.ts || Date.now(),
          });
        } else {
          _warn('No suitable method found on app to render user message');
        }
      }

      // 2. Persist to localStorage message store
      try {
        if (window.ScratchyMessageStore && typeof window.ScratchyMessageStore.add === 'function') {
          window.ScratchyMessageStore.add({
            role: 'user',
            text: payload.text,
            attachments: payload.attachments || [],
            ts: payload.ts || Date.now(),
          });
        }
      } catch (storeErr) {
        _warn('Failed to persist synced message to store', storeErr);
      }

      // 3. Scroll to bottom so the user sees the new message
      _scrollToBottom();

    } catch (err) {
      _warn('Error handling synced user-message', err);
    }
  }

  /**
   * Handle an "activity" sync event — agent activity happening on the
   * server, triggered by another device's request.
   */
  function _handleActivity(payload) {
    if (!payload) return;

    try {
      var label = null;
      if (payload.type === 'tool' && payload.name) {
        label = ScratchyDeviceSync.getToolLabel(payload.name);
      } else if (payload.detail) {
        label = payload.detail;
      }

      if (_app && label) {
        // Try the app's activity indicator API
        if (typeof _app.showActivity === 'function') {
          _app.showActivity(label);
        } else if (typeof _app.setActivity === 'function') {
          _app.setActivity(label);
        } else if (typeof _app._showToolActivity === 'function') {
          _app._showToolActivity(label);
        }
      }
    } catch (err) {
      _warn('Error handling synced activity', err);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  window.ScratchyDeviceSync = {

    /** Unique device ID — persists in localStorage. */
    deviceId: _deviceId,

    /**
     * Initialise the sync module.
     * Call once after ScratchyConnection and ScratchyApp are created.
     *
     * @param {Object} connection  ScratchyConnection instance
     * @param {Object} app         ScratchyApp instance
     */
    init: function init(connection, app) {
      if (_inited) {
        _warn('Already initialised — ignoring duplicate init()');
        return;
      }
      _connection = connection || null;
      _app        = app        || null;
      _inited     = true;

      _log('Initialised — deviceId=' + _deviceId);
    },

    /**
     * Process an incoming WebSocket frame and handle it if it is a sync
     * event.  Intended to be called from the connection's message
     * handler before other processing.
     *
     * @param  {Object} data  Parsed frame (the `frame` property from
     *                        the `{ seq, frame }` envelope, or the raw
     *                        object if already unwrapped).
     * @return {boolean}      `true` if the frame was a sync event and
     *                        was handled; `false` otherwise.
     */
    handleFrame: function handleFrame(data) {
      try {
        if (!data || data.type !== 'sync') return false;

        var event   = data.event;
        var payload = data.payload || {};

        switch (event) {
          case 'user-message':
            _handleUserMessage(payload);
            return true;

          case 'activity':
            _handleActivity(payload);
            return true;

          default:
            _log('Unknown sync event: ' + event);
            return false;
        }
      } catch (err) {
        _warn('handleFrame error', err);
        return false;
      }
    },

    /**
     * Return the device ID for inclusion in WS connection params.
     * @return {string}
     */
    getDeviceId: function getDeviceId() {
      return _deviceId;
    },

    /**
     * Map a tool name to a user-friendly activity label.
     *
     * @param  {string} toolName  e.g. "image", "web_search"
     * @return {string}           e.g. "📷 Analyzing photo"
     */
    getToolLabel: function getToolLabel(toolName) {
      if (!toolName) return '🔧 Working…';
      return TOOL_LABELS[toolName] || ('🔧 Using ' + toolName);
    },
  };

  _log('Loaded — deviceId=' + _deviceId);
})();
