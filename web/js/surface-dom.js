var SurfaceDom = (function() {
  'use strict';

  var _surfaces = {};
  var _root = null;
  var _toastContainer = null;
  var _toastCounter = 0;

  function init(rootEl) {
    _root = rootEl || document.body;
  }

  function _ensureToastContainer() {
    if (_toastContainer) return _toastContainer;
    _toastContainer = document.createElement('div');
    _toastContainer.id = 'surface-toast-container';
    Object.assign(_toastContainer.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: '10001',
      display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none'
    });
    document.body.appendChild(_toastContainer);
    return _toastContainer;
  }

  function _createMain(surfaceId) {
    var existing = document.getElementById('canvas-grid');
    if (existing) {
      _surfaces[surfaceId] = { el: existing, type: 'main', visible: true };
      return existing;
    }
    var el = document.createElement('div');
    el.id = surfaceId;
    el.className = 'surface-main';
    _root.appendChild(el);
    _surfaces[surfaceId] = { el: el, type: 'main', visible: true };
    return el;
  }

  function _createSidebar(surfaceId) {
    var el = document.createElement('div');
    el.id = surfaceId;
    el.className = 'surface-sidebar';
    Object.assign(el.style, {
      position: 'fixed', right: '0', top: '0', height: '100vh', width: '320px',
      background: 'rgba(15,23,42,0.95)', backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)', borderLeft: '1px solid rgba(255,255,255,0.06)',
      transform: 'translateX(100%)', transition: 'transform 300ms ease',
      zIndex: '9999', overflowY: 'auto', padding: '16px', boxSizing: 'border-box'
    });
    var close = document.createElement('button');
    close.textContent = '\u00d7';
    Object.assign(close.style, {
      position: 'absolute', top: '12px', right: '12px', background: 'none',
      border: 'none', color: '#a1a1aa', fontSize: '1.4rem', cursor: 'pointer',
      lineHeight: '1', padding: '4px 8px'
    });
    close.onmouseenter = function() { close.style.color = '#e2e8f0'; };
    close.onmouseleave = function() { close.style.color = '#a1a1aa'; };
    close.onclick = function() { remove(surfaceId); };
    el.appendChild(close);
    var content = document.createElement('div');
    content.className = 'surface-sidebar-content';
    content.style.marginTop = '36px';
    el.appendChild(content);
    document.body.appendChild(el);
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { el.style.transform = 'translateX(0)'; });
    });
    _surfaces[surfaceId] = { el: el, type: 'sidebar', visible: true, content: content };
    return el;
  }

  function _createOverlayEl(surfaceId, options) {
    options = options || {};
    var width = options.width || '480px';
    var closable = options.closable !== false;

    var backdrop = document.createElement('div');
    backdrop.id = surfaceId;
    backdrop.className = 'surface-overlay';
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', zIndex: '10000',
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      WebkitBackdropFilter: 'blur(4px)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      opacity: '0', transition: 'opacity 200ms ease'
    });

    var panel = document.createElement('div');
    panel.className = 'surface-overlay-panel';
    Object.assign(panel.style, {
      maxWidth: width, width: '100%', maxHeight: '80vh',
      background: 'rgba(15,23,42,0.98)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '16px', padding: '20px', boxSizing: 'border-box',
      transform: 'scale(0.95)', transition: 'transform 200ms ease',
      display: 'flex', flexDirection: 'column', position: 'relative'
    });

    if (closable) {
      var close = document.createElement('button');
      close.textContent = '\u00d7';
      Object.assign(close.style, {
        position: 'absolute', top: '12px', right: '16px', background: 'none',
        border: 'none', color: '#a1a1aa', fontSize: '1.4rem', cursor: 'pointer',
        lineHeight: '1', padding: '4px 8px', zIndex: '1'
      });
      close.onmouseenter = function() { close.style.color = '#e2e8f0'; };
      close.onmouseleave = function() { close.style.color = '#a1a1aa'; };
      close.onclick = function() {
        if (options.onClose) options.onClose();
        remove(surfaceId);
      };
      panel.appendChild(close);
      backdrop.addEventListener('click', function(e) {
        if (e.target === backdrop) {
          if (options.onClose) options.onClose();
          remove(surfaceId);
        }
      });
    }

    if (options.title) {
      var header = document.createElement('div');
      header.className = 'surface-overlay-header';
      header.textContent = options.title;
      Object.assign(header.style, {
        fontSize: '1.1rem', fontWeight: '600', color: '#e2e8f0',
        marginBottom: '16px', paddingRight: '24px'
      });
      panel.appendChild(header);
    }

    var content = document.createElement('div');
    content.className = 'surface-overlay-content';
    content.style.overflowY = 'auto';
    content.style.flex = '1';
    panel.appendChild(content);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        backdrop.style.opacity = '1';
        panel.style.transform = 'scale(1)';
      });
    });

    _surfaces[surfaceId] = { el: backdrop, type: 'overlay', visible: true, content: content, panel: panel };
    return backdrop;
  }

  var MAX_TOASTS = 3;

  function _createToast(surfaceId, message, options) {
    options = options || {};
    var type = options.type || 'info';
    var duration = options.duration != null ? options.duration : 4000;
    var colors = { info: '#3b82f6', success: '#10b981', warning: '#f59e0b', error: '#ef4444' };

    _ensureToastContainer();

    // Enforce max toasts — remove oldest if at limit
    var existingToasts = _toastContainer.querySelectorAll('.surface-toast');
    while (existingToasts.length >= MAX_TOASTS) {
      var oldest = existingToasts[0];
      var oldId = oldest.id;
      if (oldId && _surfaces[oldId]) {
        delete _surfaces[oldId];
      }
      oldest.remove();
      existingToasts = _toastContainer.querySelectorAll('.surface-toast');
    }

    var el = document.createElement('div');
    el.id = surfaceId;
    el.className = 'surface-toast';
    Object.assign(el.style, {
      maxWidth: '340px', background: 'rgba(15,23,42,0.95)', borderRadius: '10px',
      borderLeft: '3px solid ' + (colors[type] || colors.info),
      padding: '12px 16px', fontSize: '0.8rem',
      transform: 'translateX(120%)', transition: 'transform 300ms ease, opacity 300ms ease',
      pointerEvents: 'auto', opacity: '1'
    });

    if (options.title) {
      var title = document.createElement('div');
      title.textContent = options.title;
      Object.assign(title.style, { fontWeight: '600', color: '#e2e8f0', marginBottom: '4px' });
      el.appendChild(title);
    }

    var msg = document.createElement('div');
    msg.textContent = message;
    msg.style.color = '#a1a1aa';
    el.appendChild(msg);

    _toastContainer.appendChild(el);

    requestAnimationFrame(function() {
      requestAnimationFrame(function() { el.style.transform = 'translateX(0)'; });
    });

    _surfaces[surfaceId] = { el: el, type: 'toast', visible: true };

    if (duration > 0) {
      setTimeout(function() { remove(surfaceId); }, duration);
    }

    return el;
  }

  function getOrCreate(surfaceId, type) {
    if (_surfaces[surfaceId]) return _surfaces[surfaceId].el;
    switch (type) {
      case 'main': return _createMain(surfaceId);
      case 'sidebar': return _createSidebar(surfaceId);
      case 'overlay': return _createOverlayEl(surfaceId);
      case 'toast': return _createToast(surfaceId, '', {});
      default: return _createMain(surfaceId);
    }
  }

  function remove(surfaceId) {
    var s = _surfaces[surfaceId];
    if (!s) return;
    var el = s.el;

    if (s.type === 'sidebar') {
      el.style.transform = 'translateX(100%)';
      setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    } else if (s.type === 'overlay') {
      el.style.opacity = '0';
      if (s.panel) s.panel.style.transform = 'scale(0.95)';
      setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    } else if (s.type === 'toast') {
      el.style.opacity = '0';
      el.style.transform = 'translateX(120%)';
      setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    } else {
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    delete _surfaces[surfaceId];
  }

  function show(surfaceId) {
    var s = _surfaces[surfaceId];
    if (!s) return;
    s.el.style.display = '';
    s.visible = true;
    if (s.type === 'sidebar') s.el.style.transform = 'translateX(0)';
    if (s.type === 'overlay') { s.el.style.opacity = '1'; if (s.panel) s.panel.style.transform = 'scale(1)'; }
  }

  function hide(surfaceId) {
    var s = _surfaces[surfaceId];
    if (!s) return;
    s.visible = false;
    if (s.type === 'sidebar') {
      s.el.style.transform = 'translateX(100%)';
    } else if (s.type === 'overlay') {
      s.el.style.opacity = '0';
      if (s.panel) s.panel.style.transform = 'scale(0.95)';
    } else {
      s.el.style.display = 'none';
    }
  }

  function get(surfaceId) {
    var s = _surfaces[surfaceId];
    return s ? s.el : null;
  }

  function list() {
    return Object.keys(_surfaces);
  }

  function toast(message, options) {
    options = options || {};
    var id = 'toast-' + (++_toastCounter) + '-' + Date.now();
    _createToast(id, message, options);
    return id;
  }

  function overlay(surfaceId, options) {
    if (_surfaces[surfaceId]) remove(surfaceId);
    _createOverlayEl(surfaceId, options);
    return _surfaces[surfaceId].content;
  }

  return { init: init, getOrCreate: getOrCreate, remove: remove, show: show, hide: hide, get: get, list: list, toast: toast, overlay: overlay };
})();
