/**
 * Command Palette for Scratchy (⌘K / Ctrl+K)
 * Self-contained IIFE — no dependencies.
 */
(function () {
  'use strict';

  let isOpen = false;
  let selectedIndex = 0;
  let results = [];
  let backdrop, modal, input, listEl, styleInjected = false;

  // ── Static commands (Phase 31: unified view — no chat/canvas split) ──
  const STATIC_ITEMS = [
    { id: 'wid-notes',     label: 'Open Notes',        icon: '📝', category: 'Widgets',    action: () => _sendWidgetAction('sn-list') },
    { id: 'wid-calendar',  label: 'Open Calendar',     icon: '📅', category: 'Widgets',    action: () => _sendWidgetAction('cal-month') },
    { id: 'wid-email',     label: 'Open Email',        icon: '✉️', category: 'Widgets',    action: () => _sendWidgetAction('mail-inbox') },
    { id: 'wid-admin',     label: 'Admin Dashboard',   icon: '🛡️', category: 'Widgets',   action: () => _sendWidgetAction('admin-dashboard'), adminOnly: true },
    { id: 'wid-account',   label: 'My Account',        icon: '👤', category: 'Widgets',    action: () => _sendWidgetAction('account-profile'), nonAdminOnly: true },
    { id: 'act-clear',     label: 'Clear Widgets',     icon: '🗑', category: 'Actions',    action: () => {
      // Remove all widget regions from chat
      document.querySelectorAll('.widget-region').forEach(r => r.remove());
      if (window.canvasState) window.canvasState.apply({ op: 'clear' });
    }},
    { id: 'act-scroll',    label: 'Scroll to Bottom',  icon: '⬇️', category: 'Actions',   action: () => {
      const msgs = document.getElementById('messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }},
  ];

  // ── Widget action helper (Phase 31: direct WS dispatch, no view switching) ──
  function _sendWidgetAction(action) {
    const conn = window._scratchyConnection;
    if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({
        type: 'widget-action',
        sessionKey: conn.sessionKey,
        data: { action: action, componentId: 'cmd-palette', context: {} },
        timestamp: Date.now()
      }));
    } else {
      console.warn('[CmdPalette] WS not connected — cannot send widget action:', action);
    }
  }

  // ── Fuzzy match ──────────────────────────────────────────────────
  function fuzzy(query, text) {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) qi++;
    }
    return qi === q.length;
  }

  // ── Search ───────────────────────────────────────────────────────
  function _roleFilter(items) {
    var role = window._scratchyUserRole || 'admin'; // default to admin for legacy single-user
    return items.filter(function(i) {
      if (i.adminOnly && role !== 'admin') return false;
      if (i.nonAdminOnly && role === 'admin') return false;
      return true;
    });
  }

  function search(query) {
    var filtered = _roleFilter(STATIC_ITEMS);
    if (!query) return filtered.slice(0, 8);
    return filtered.filter(i => fuzzy(query, i.label) || fuzzy(query, i.category)).slice(0, 8);
  }

  // ── Render ───────────────────────────────────────────────────────
  function render() {
    // Update classes on existing rows if possible, only rebuild if count changed
    const existingRows = listEl.querySelectorAll('.cp-row');
    if (existingRows.length === results.length) {
      // Just update selection class
      existingRows.forEach((row, i) => {
        row.classList.toggle('cp-selected', i === selectedIndex);
      });
      return;
    }
    // Full rebuild needed
    listEl.innerHTML = '';
    results.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'cp-row' + (i === selectedIndex ? ' cp-selected' : '');
      row.innerHTML = `<span class="cp-icon">${item.icon}</span><span class="cp-label">${item.label}</span><span class="cp-badge">${item.category}</span>`;
      row.addEventListener('click', (e) => { e.stopPropagation(); execute(i); });
      row.addEventListener('mouseenter', () => { selectedIndex = i; render(); });
      listEl.appendChild(row);
    });
  }

  function execute(i) {
    const item = results[i];
    close();
    if (item && item.action) {
      try {
        item.action();
      } catch(e) {
        console.error('[CmdPalette] Action error:', e);
      }
    }
  }

  // ── CSS injection ────────────────────────────────────────────────
  function injectStyles() {
    if (styleInjected) return;
    styleInjected = true;
    const s = document.createElement('style');
    s.textContent = `
.cp-backdrop{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);display:flex;align-items:flex-start;justify-content:center;padding-top:min(20vh,160px);opacity:0;transition:opacity 150ms ease}
.cp-backdrop.cp-visible{opacity:1}
.cp-modal{width:90%;max-width:500px;background:var(--bg-secondary,#141414);border:1px solid var(--border,rgba(255,255,255,.08));border-radius:12px;overflow:hidden;transform:scale(.98);transition:transform 150ms ease;font-family:inherit;color:var(--text-primary,#ededed)}
.cp-backdrop.cp-visible .cp-modal{transform:scale(1)}
.cp-input{display:block;width:100%;box-sizing:border-box;padding:16px 20px;font-size:16px;background:transparent;border:none;border-bottom:1px solid var(--border,rgba(255,255,255,.08));color:var(--text-primary,#ededed);outline:none;font-family:inherit}
.cp-input::placeholder{color:var(--text-secondary,#888)}
.cp-list{max-height:352px;overflow-y:auto}
.cp-row{display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;transition:background 80ms ease}
.cp-row.cp-selected{background:var(--accent,#6366f1)}
.cp-icon{font-size:16px;width:24px;text-align:center;flex-shrink:0}
.cp-label{flex:1;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp-badge{font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,.06);color:var(--text-secondary,#888);flex-shrink:0}
.cp-selected .cp-badge{background:rgba(255,255,255,.15);color:#fff}
@keyframes cp-flash{0%{box-shadow:0 0 0 3px var(--accent,#6366f1)}100%{box-shadow:0 0 0 0 transparent}}
.cp-highlight{animation:cp-flash .6s ease-out 2}
`;
    document.head.appendChild(s);
  }

  // ── DOM creation ─────────────────────────────────────────────────
  function ensureDOM() {
    if (backdrop) return;
    injectStyles();
    backdrop = document.createElement('div');
    backdrop.className = 'cp-backdrop';
    modal = document.createElement('div');
    modal.className = 'cp-modal';
    input = document.createElement('input');
    input.className = 'cp-input';
    input.placeholder = 'Type a command…';
    listEl = document.createElement('div');
    listEl.className = 'cp-list';
    modal.appendChild(input);
    modal.appendChild(listEl);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    input.addEventListener('input', () => { selectedIndex = 0; results = search(input.value); render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = (selectedIndex + 1) % results.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = (selectedIndex - 1 + results.length) % results.length; render(); }
      else if (e.key === 'Enter') { e.preventDefault(); execute(selectedIndex); }
      else if (e.key === 'Escape') { close(); }
    });
  }

  // ── Touch detection ───────────────────────────────────────────────
  // On touch devices (Android/iOS tablets), focusing an input auto-opens
  // the virtual keyboard — which is annoying for a command palette that's
  // primarily navigated by tapping, not typing.
  function _isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  // ── Open / Close ─────────────────────────────────────────────────
  function open() {
    if (isOpen) return;
    isOpen = true;
    ensureDOM();
    input.value = '';
    selectedIndex = 0;
    results = search('');
    render();
    backdrop.style.display = 'flex';
    // Force reflow before adding visible class for animation
    backdrop.offsetHeight;
    backdrop.classList.add('cp-visible');
    // On touch devices, don't auto-focus the search input (avoids virtual keyboard popup).
    // Users can still tap the input to search if they want.
    if (!_isTouchDevice()) {
      requestAnimationFrame(() => input.focus());
    }
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (backdrop) {
      backdrop.classList.remove('cp-visible');
      // Hide after transition to stop blocking clicks
      setTimeout(() => {
        if (!isOpen && backdrop) backdrop.style.display = 'none';
      }, 160);
    }
  }

  // ── Global shortcut ──────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      isOpen ? close() : open();
    }
    if (e.key === 'Escape' && isOpen) close();
  });

  // ── Public API ───────────────────────────────────────────────────
  window.CommandPalette = { open, close };
})();

