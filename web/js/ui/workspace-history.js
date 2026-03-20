/**
 * WorkspaceHistory — Saved Workspaces + History panel
 * Phase 32: Pin to Workspace
 *
 * Shows saved workspace presets (save/load/delete) and canvas history.
 */
(function() {
  "use strict";

  function WorkspaceHistory(options) {
    this.panel = options.panel;
    this.store = options.workspaceStore;
    this.onRestore = options.onRestore || function() {};
    this._isOpen = false;
    this._init();
  }

  WorkspaceHistory.prototype._init = function() {
    var self = this;
    this.panel.classList.add('hidden');

    this.panel.innerHTML =
      '<div class="workspace-history-panel-header">' +
        '<span class="workspace-history-panel-header-title">Saved Workspaces</span>' +
        '<button class="workspace-history-panel-close" title="Close" aria-label="Close">' +
          '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 3L3 11M3 3l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="workspace-history-save-bar">' +
        '<input type="text" class="workspace-save-input" placeholder="Workspace name..." maxlength="40">' +
        '<button class="workspace-save-btn">Save</button>' +
      '</div>' +
      '<div class="workspace-history-list"></div>' +
      '<div class="workspace-history-panel-footer">' +
        '<button class="workspace-history-clear-btn">Clear All</button>' +
      '</div>';

    this._listEl = this.panel.querySelector('.workspace-history-list');
    this._saveInput = this.panel.querySelector('.workspace-save-input');
    this._saveBtn = this.panel.querySelector('.workspace-save-btn');

    // Close
    this.panel.querySelector('.workspace-history-panel-close').addEventListener('click', function() {
      self.close();
    });

    // Save current workspace
    this._saveBtn.addEventListener('click', function() {
      var name = self._saveInput.value.trim();
      if (!name) name = 'Workspace ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      self.store.saveWorkspace(name);
      self._saveInput.value = '';
      self._render();
    });

    this._saveInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') self._saveBtn.click();
    });

    // Clear all
    this.panel.querySelector('.workspace-history-clear-btn').addEventListener('click', function() {
      if (confirm('Delete all saved workspaces?')) {
        self.store._savedWorkspaces = [];
        self.store.clearHistory();
        self.store.save();
        self._render();
      }
    });

    // Click outside to close
    document.addEventListener('click', function(e) {
      if (self._isOpen && !self.panel.contains(e.target) && !e.target.closest('[data-action="history"]')) {
        self.close();
      }
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && self._isOpen) self.close();
    });

    this.store.onChange(function(type) {
      if (type === 'workspace-saved' || type === 'workspace-deleted' || type === 'reset' || type === 'history') {
        if (self._isOpen) self._render();
      }
    });
  };

  WorkspaceHistory.prototype.toggle = function() {
    if (this._isOpen) this.close(); else this.open();
  };

  WorkspaceHistory.prototype.open = function() {
    this._render();
    this.panel.classList.add('open');
    this.panel.classList.remove('hidden');
    this._isOpen = true;
    this._saveInput.focus();
  };

  WorkspaceHistory.prototype.close = function() {
    this.panel.classList.remove('open');
    this.panel.classList.add('hidden');
    this._isOpen = false;
  };

  WorkspaceHistory.prototype._render = function() {
    var listEl = this._listEl;
    listEl.innerHTML = '';

    // Saved workspaces
    var saved = this.store.getSavedWorkspaces();

    if (saved.length === 0) {
      listEl.innerHTML =
        '<div style="padding:24px 16px;text-align:center;color:var(--text-ghost)">' +
          '<div style="font-size:24px;margin-bottom:6px">📁</div>' +
          '<div style="font-size:var(--text-xs)">No saved workspaces</div>' +
          '<div style="font-size:var(--text-2xs);margin-top:4px;opacity:0.7">Name and save your current layout to switch between workspace configurations.</div>' +
        '</div>';
      return;
    }

    for (var i = 0; i < saved.length; i++) {
      listEl.appendChild(this._createWorkspaceEntry(saved[i]));
    }
  };

  WorkspaceHistory.prototype._createWorkspaceEntry = function(ws) {
    var self = this;
    var div = document.createElement('div');
    div.className = 'workspace-history-entry';

    var time = new Date(ws.savedAt);
    var timeStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
      ' ' + time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var pinCount = Object.keys(ws.pins || {}).length;

    // Icon
    var iconEl = document.createElement('span');
    iconEl.className = 'workspace-history-entry-icon';
    iconEl.textContent = '📁';

    // Content
    var contentEl = document.createElement('div');
    contentEl.className = 'workspace-history-entry-content';

    var titleEl = document.createElement('div');
    titleEl.className = 'workspace-history-entry-title';
    titleEl.textContent = ws.name;
    contentEl.appendChild(titleEl);

    var metaEl = document.createElement('div');
    metaEl.className = 'workspace-history-entry-time';
    metaEl.textContent = pinCount + ' widget' + (pinCount !== 1 ? 's' : '') + ' · ' + timeStr;
    contentEl.appendChild(metaEl);

    // Actions
    var actionsEl = document.createElement('div');
    actionsEl.className = 'workspace-history-entry-actions';
    actionsEl.style.display = 'flex';
    actionsEl.style.gap = '4px';

    var loadBtn = document.createElement('button');
    loadBtn.className = 'workspace-history-restore';
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      self.store.loadWorkspace(ws.id);
      self.close();
    });

    var delBtn = document.createElement('button');
    delBtn.className = 'workspace-history-restore';
    delBtn.style.borderColor = 'var(--border-subtle)';
    delBtn.style.background = 'transparent';
    delBtn.style.color = 'var(--text-tertiary)';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      self.store.deleteWorkspace(ws.id);
    });

    actionsEl.appendChild(loadBtn);
    actionsEl.appendChild(delBtn);

    div.appendChild(iconEl);
    div.appendChild(contentEl);
    div.appendChild(actionsEl);

    return div;
  };

  WorkspaceHistory.prototype.destroy = function() {
    this._listEl = null;
    this.panel.innerHTML = '';
    this._isOpen = false;
  };

  window.WorkspaceHistory = WorkspaceHistory;
})();
