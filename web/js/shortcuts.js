// shortcuts.js — Global keyboard shortcut handler
(function() {
  'use strict';
  
  var _shortcuts = {};
  var _enabled = true;
  
  function register(combo, handler, description) {
    _shortcuts[combo.toLowerCase()] = { handler: handler, description: description || combo };
  }
  
  function _getCombo(e) {
    var parts = [];
    if (e.metaKey || e.ctrlKey) parts.push('mod');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    if (!e.key) return '';
    var key = e.key.toLowerCase();
    if (key === 'escape') key = 'esc';
    parts.push(key);
    return parts.join('+');
  }
  
  document.addEventListener('keydown', function(e) {
    if (!_enabled) return;
    
    // Don't fire shortcuts when typing in inputs
    var tag = (e.target.tagName || '').toLowerCase();
    var isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    
    var combo = _getCombo(e);
    var shortcut = _shortcuts[combo];
    
    // Allow Escape even in inputs (for closing overlays)
    if (!shortcut && !isInput) return;
    if (!shortcut) {
      if (combo === 'esc' && isInput) {
        e.target.blur();
        e.preventDefault();
      }
      return;
    }
    
    // For mod+ shortcuts, always fire (even in inputs)
    if (combo.startsWith('mod+') || !isInput) {
      e.preventDefault();
      shortcut.handler(e);
    }
  });
  
  // Built-in shortcuts
  register('mod+k', function() {
    if (typeof CommandPalette !== 'undefined') CommandPalette.open();
  }, 'Command palette');
  
  register('mod+/', function() {
    var search = document.getElementById('sidebar-search');
    if (search) { search.focus(); search.select(); }
  }, 'Search messages');
  
  register('esc', function() {
    // Close focus overlay if open
    var overlay = document.querySelector('.focus-overlay:not(.closing)');
    if (overlay) {
      overlay.classList.add('closing');
      setTimeout(function() { overlay.remove(); }, 200);
      return;
    }
    // Close sidebar on mobile
    var sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
      var backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.style.display = 'none';
    }
  }, 'Close overlay / sidebar');
  
  register('mod+n', function() {
    // Focus message input
    var input = document.getElementById('message-input');
    if (input) { input.focus(); }
  }, 'New message');
  
  register('alt+n', function() {
    // Open notes widget
    if (window.showToast) window.showToast('Opening notes...', 'info');
    if (window.connection && window.connection.ws) {
      window.connection.ws.send(JSON.stringify({
        type: "widget-action",
        sessionKey: window.connection.sessionKey,
        data: { surfaceId: 'main', componentId: 'auto', action: 'sn-list', context: {} },
        timestamp: Date.now()
      }));
    }
  }, 'Open Notes');
  
  register('alt+c', function() {
    if (window.connection && window.connection.ws) {
      window.connection.ws.send(JSON.stringify({
        type: "widget-action",
        sessionKey: window.connection.sessionKey,
        data: { surfaceId: 'main', componentId: 'auto', action: 'cal-month', context: {} },
        timestamp: Date.now()
      }));
    }
  }, 'Open Calendar');
  
  register('alt+e', function() {
    if (window.connection && window.connection.ws) {
      window.connection.ws.send(JSON.stringify({
        type: "widget-action",
        sessionKey: window.connection.sessionKey,
        data: { surfaceId: 'main', componentId: 'auto', action: 'mail-inbox', context: {} },
        timestamp: Date.now()
      }));
    }
  }, 'Open Email');
  
  // Expose
  window.Shortcuts = {
    register: register,
    list: function() { return Object.keys(_shortcuts).map(function(k) { return { combo: k, description: _shortcuts[k].description }; }); },
    enable: function() { _enabled = true; },
    disable: function() { _enabled = false; }
  };
})();
