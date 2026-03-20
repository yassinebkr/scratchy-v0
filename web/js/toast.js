// toast.js — Lightweight toast notification system
(function() {
  'use strict';
  
  var container = null;
  var _queue = [];
  var _maxVisible = 3;
  
  function _getContainer() {
    if (!container) container = document.getElementById('toast-container');
    return container;
  }
  
  /**
   * Show a toast notification
   * @param {string} message - The message text
   * @param {object} opts - Options: type ('info'|'success'|'error'|'warning'), duration (ms), action ({label, fn})
   */
  function show(message, opts) {
    opts = opts || {};
    var type = opts.type || 'info';
    var duration = opts.duration || 4000;
    var c = _getContainer();
    if (!c) return;
    
    // Limit visible toasts
    var existing = c.querySelectorAll('.toast:not(.exiting)');
    if (existing.length >= _maxVisible) {
      _dismiss(existing[0]);
    }
    
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    
    var textSpan = document.createElement('span');
    textSpan.className = 'toast-text';
    textSpan.textContent = message;
    toast.appendChild(textSpan);
    
    // Optional action button
    if (opts.action && opts.action.label) {
      var actionBtn = document.createElement('button');
      actionBtn.className = 'toast-action';
      actionBtn.textContent = opts.action.label;
      actionBtn.style.cssText = 'background:none;border:none;color:var(--accent,#6366f1);cursor:pointer;font-weight:600;font-size:12px;margin-left:12px;padding:4px 8px;border-radius:4px;';
      actionBtn.addEventListener('click', function() {
        if (opts.action.fn) opts.action.fn();
        _dismiss(toast);
      });
      toast.appendChild(actionBtn);
    }
    
    // Click to dismiss
    toast.addEventListener('click', function(e) {
      if (e.target.className !== 'toast-action') _dismiss(toast);
    });
    
    c.appendChild(toast);
    
    // Auto-dismiss
    if (duration > 0) {
      toast._timer = setTimeout(function() { _dismiss(toast); }, duration);
    }
    
    return toast;
  }
  
  function _dismiss(toast) {
    if (!toast || toast._dismissed) return;
    toast._dismissed = true;
    if (toast._timer) clearTimeout(toast._timer);
    toast.classList.add('exiting');
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  }
  
  // Convenience methods
  function success(msg, opts) { return show(msg, Object.assign({ type: 'success' }, opts || {})); }
  function error(msg, opts) { return show(msg, Object.assign({ type: 'error', duration: 6000 }, opts || {})); }
  function warning(msg, opts) { return show(msg, Object.assign({ type: 'warning' }, opts || {})); }
  function info(msg, opts) { return show(msg, Object.assign({ type: 'info' }, opts || {})); }
  
  // Clear all toasts
  function clear() {
    var c = _getContainer();
    if (!c) return;
    var toasts = c.querySelectorAll('.toast');
    for (var i = 0; i < toasts.length; i++) _dismiss(toasts[i]);
  }
  
  // Expose globally
  window.Toast = { show: show, success: success, error: error, warning: warning, info: info, clear: clear };
})();
