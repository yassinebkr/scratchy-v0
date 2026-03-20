// WorkspaceStore — manages pin state, layout, and history
(function() {
  "use strict";

  var HISTORY_MAX = 50;
  var STORAGE_KEY = 'scratchy-workspace-v1';
  var MAX_PINS = 20;
  var SAVE_DEBOUNCE = 2000;
  var DEFAULT_COLUMNS = 4;

  // ── Constructor ──────────────────────────────────────────────────────

  function WorkspaceStore() {
    this.pins = {};           // widgetId -> PinRecord
    this.layout = { columns: DEFAULT_COLUMNS, mode: "auto" };
    this.history = [];        // SnapshotRecord[]
    this.version = 0;
    this._listeners = [];
    this._saveTimer = null;
  }

  var proto = WorkspaceStore.prototype;

  // ── Core API ─────────────────────────────────────────────────────────

  /**
   * Pin a widget group.
   * @param {string} widgetId
   * @param {string[]} componentIds
   * @param {object} meta  - { icon, title, autoPin }
   * @returns {object|false} The PinRecord, or false if MAX_PINS reached.
   */
  proto.pin = function(widgetId, componentIds, meta) {
    if (this.pins[widgetId]) return this.pins[widgetId]; // already pinned
    if (Object.keys(this.pins).length >= MAX_PINS) return false;

    meta = meta || {};
    var position = this._nextPosition();
    var record = {
      widgetId: widgetId,
      componentIds: componentIds || [],
      componentData: meta.componentData || {},  // Saved component snapshots for offline restore
      pinnedAt: Date.now(),
      position: position,
      size: { w: 1, h: 1 },
      collapsed: false,
      autoPin: !!meta.autoPin,
      icon: meta.icon || null,
      title: meta.title || widgetId
    };

    this.pins[widgetId] = record;
    this.version++;
    this._notify('pin', record);
    this.save();
    return record;
  };

  /**
   * Remove a pin by widget group id.
   * @param {string} widgetId
   */
  proto.unpin = function(widgetId) {
    if (!this.pins[widgetId]) return;
    var record = this.pins[widgetId];
    delete this.pins[widgetId];
    this.version++;
    this._notify('unpin', record);
    this.save();
  };

  /**
   * Check if a widget group is pinned.
   * @param {string} widgetId
   * @returns {boolean}
   */
  proto.isPinned = function(widgetId) {
    return !!this.pins[widgetId];
  };

  /**
   * Check if a specific component is in any pin.
   * @param {string} componentId
   * @returns {boolean}
   */
  proto.isPinnedComponent = function(componentId) {
    var ids = Object.keys(this.pins);
    for (var i = 0; i < ids.length; i++) {
      var pin = this.pins[ids[i]];
      if (pin.componentIds && pin.componentIds.indexOf(componentId) !== -1) {
        return true;
      }
    }
    return false;
  };

  /**
   * Return all pins sorted by position (row first, then col).
   * @returns {object[]}
   */
  proto.getPins = function() {
    var list = [];
    var ids = Object.keys(this.pins);
    for (var i = 0; i < ids.length; i++) {
      list.push(this.pins[ids[i]]);
    }
    list.sort(function(a, b) {
      var ar = a.position ? a.position.row : 0;
      var br = b.position ? b.position.row : 0;
      if (ar !== br) return ar - br;
      var ac = a.position ? a.position.col : 0;
      var bc = b.position ? b.position.col : 0;
      return ac - bc;
    });
    return list;
  };

  /**
   * Update grid position after drag.
   * @param {string} widgetId
   * @param {{col:number, row:number}} position
   */
  proto.updatePosition = function(widgetId, position) {
    var pin = this.pins[widgetId];
    if (!pin) return;
    pin.position = { col: position.col, row: position.row };
    this.version++;
    this._notify('update', pin);
    this.save();
  };

  /**
   * Reorder pins based on DOM order after drag-to-reorder.
   * @param {string[]} orderedIds — widget IDs in new visual order
   */
  proto.reorder = function(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;
    for (var i = 0; i < orderedIds.length; i++) {
      var pin = this.pins[orderedIds[i]];
      if (pin) {
        pin.position = { row: i, col: 0 };
      }
    }
    this.version++;
    this._notify('update', { reordered: true });
    this.save();
  };

  /**
   * Toggle collapsed state for a pinned widget.
   * @param {string} widgetId
   */
  proto.toggleCollapse = function(widgetId) {
    var pin = this.pins[widgetId];
    if (!pin) return;
    pin.collapsed = !pin.collapsed;
    this.version++;
    this._notify('collapse', pin);
    this.save();
  };

  /**
   * Update saved component data for a pinned widget (for offline restore).
   * @param {string} widgetId
   * @param {string} componentId
   * @param {object} componentSnapshot - { type, data }
   */
  proto.updateComponentData = function(widgetId, componentId, componentSnapshot) {
    var pin = this.pins[widgetId];
    if (!pin) return;
    if (!pin.componentData) pin.componentData = {};
    pin.componentData[componentId] = componentSnapshot;
    // Debounced save (don't notify — this is a background update)
    this.save();
  };

  /**
   * Update size {w, h} for a pinned widget.
   * @param {string} widgetId
   * @param {{w:number, h:number}} size
   */
  proto.resize = function(widgetId, size) {
    var pin = this.pins[widgetId];
    if (!pin) return;
    pin.size = { w: size.w, h: size.h };
    this.version++;
    this._notify('resize', pin);
    this.save();
  };

  // ── Auto-position ────────────────────────────────────────────────────

  /**
   * Find the next available grid position.
   * Scans left-to-right, top-to-bottom for first gap.
   * @returns {{col:number, row:number}}
   */
  proto._nextPosition = function() {
    var cols = this.layout.columns || DEFAULT_COLUMNS;
    // Build a set of occupied cells "col,row"
    var occupied = {};
    var ids = Object.keys(this.pins);
    for (var i = 0; i < ids.length; i++) {
      var p = this.pins[ids[i]].position;
      if (p) occupied[p.col + ',' + p.row] = true;
    }
    // Scan rows then cols
    for (var row = 0; row < 1000; row++) {
      for (var col = 0; col < cols; col++) {
        if (!occupied[col + ',' + row]) {
          return { col: col, row: row };
        }
      }
    }
    // Fallback (shouldn't happen with MAX_PINS=20)
    return { col: 0, row: 0 };
  };

  // ── Saved Workspaces ────────────────────────────────────────────────

  /**
   * Save current workspace layout as a named preset.
   * @param {string} name
   * @returns {object} The saved workspace record.
   */
  proto.saveWorkspace = function(name) {
    if (!this._savedWorkspaces) this._savedWorkspaces = [];
    // Snapshot all current pins with their component data
    var snapshot = {
      id: 'ws-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      name: name || ('Workspace ' + (this._savedWorkspaces.length + 1)),
      savedAt: Date.now(),
      pins: JSON.parse(JSON.stringify(this.pins)),
      layout: JSON.parse(JSON.stringify(this.layout))
    };
    this._savedWorkspaces.push(snapshot);
    // Limit to 20 saved workspaces
    while (this._savedWorkspaces.length > 20) this._savedWorkspaces.shift();
    this.version++;
    this._notify('workspace-saved', snapshot);
    this.save();
    return snapshot;
  };

  /**
   * Load a saved workspace, replacing current pins.
   * @param {string} workspaceId
   * @returns {boolean}
   */
  proto.loadWorkspace = function(workspaceId) {
    if (!this._savedWorkspaces) return false;
    for (var i = 0; i < this._savedWorkspaces.length; i++) {
      if (this._savedWorkspaces[i].id === workspaceId) {
        var ws = this._savedWorkspaces[i];
        this.pins = JSON.parse(JSON.stringify(ws.pins));
        if (ws.layout) this.layout = JSON.parse(JSON.stringify(ws.layout));
        this.version++;
        this._notify('reset', null);
        this.save();
        return true;
      }
    }
    return false;
  };

  /**
   * Delete a saved workspace.
   * @param {string} workspaceId
   */
  proto.deleteWorkspace = function(workspaceId) {
    if (!this._savedWorkspaces) return;
    this._savedWorkspaces = this._savedWorkspaces.filter(function(w) { return w.id !== workspaceId; });
    this.version++;
    this._notify('workspace-deleted', { id: workspaceId });
    this.save();
  };

  /**
   * Get all saved workspaces (newest first).
   * @returns {object[]}
   */
  proto.getSavedWorkspaces = function() {
    if (!this._savedWorkspaces) return [];
    return this._savedWorkspaces.slice().reverse();
  };

  // ── History ──────────────────────────────────────────────────────────

  /**
   * Add a history snapshot. Auto-generates id and timestamp.
   * FIFO eviction at HISTORY_MAX.
   * @param {object} snapshot - { widgetId, title, icon, components }
   */
  proto.addSnapshot = function(snapshot) {
    var record = {
      id: 'snap-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      timestamp: Date.now(),
      widgetId: snapshot.widgetId || null,
      title: snapshot.title || '',
      icon: snapshot.icon || null,
      components: snapshot.components || {}
    };
    this.history.push(record);
    // FIFO eviction
    while (this.history.length > HISTORY_MAX) {
      this.history.shift();
    }
    this.version++;
    this._notify('history', record);
    this.save();
    return record;
  };

  /**
   * Return all snapshots newest first.
   * @returns {object[]}
   */
  proto.getHistory = function() {
    var copy = this.history.slice();
    copy.reverse();
    return copy;
  };

  /**
   * Returns the snapshot's components object (caller handles re-pinning).
   * @param {string} snapshotId
   * @returns {object|null}
   */
  proto.restoreSnapshot = function(snapshotId) {
    for (var i = 0; i < this.history.length; i++) {
      if (this.history[i].id === snapshotId) {
        return this.history[i].components;
      }
    }
    return null;
  };

  /**
   * Remove all snapshots.
   */
  proto.clearHistory = function() {
    this.history = [];
    this.version++;
    this._notify('history', null);
    this.save();
  };

  // ── Persistence ──────────────────────────────────────────────────────

  /**
   * Debounced save to localStorage.
   */
  proto.save = function() {
    var self = this;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._saveTimer = setTimeout(function() {
      self._saveTimer = null;
      self.saveImmediate();
    }, SAVE_DEBOUNCE);
  };

  /**
   * Immediate save (for beforeunload).
   */
  proto.saveImmediate = function() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      var json = JSON.stringify(this.toJSON());
      localStorage.setItem(STORAGE_KEY, json);
    } catch (e) {
      // Safari private mode or quota exceeded — silently ignore
    }
  };

  /**
   * Load from localStorage. Returns true if data was found.
   * @returns {boolean}
   */
  proto.load = function() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (data) {
        this.fromJSON(data);
        return true;
      }
    } catch (e) {
      // Corrupt data or access denied — start fresh
    }
    return false;
  };

  /**
   * Serialize to plain object.
   * @returns {object}
   */
  proto.toJSON = function() {
    return {
      pins: this.pins,
      layout: this.layout,
      history: this.history,
      savedWorkspaces: this._savedWorkspaces || [],
      version: this.version
    };
  };

  /**
   * Deserialize from plain object and notify listeners.
   * @param {object} data
   */
  proto.fromJSON = function(data) {
    if (!data) return;
    this.pins = data.pins || {};
    this.layout = data.layout || { columns: DEFAULT_COLUMNS, mode: "auto" };
    this.history = data.history || [];
    this._savedWorkspaces = data.savedWorkspaces || [];
    this.version = data.version || 0;
    this._notify('reset', null);
  };

  // ── Events ───────────────────────────────────────────────────────────

  /**
   * Subscribe to changes.
   * @param {function} fn - fn(type, data) where type = 'pin'|'unpin'|'update'|'collapse'|'resize'|'reset'|'history'
   * @returns {function} unsubscribe function
   */
  proto.onChange = function(fn) {
    if (typeof fn !== 'function') return function() {};
    this._listeners.push(fn);
    var listeners = this._listeners;
    return function() {
      var idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  };

  /**
   * Emit to all listeners.
   * @param {string} type
   * @param {*} data
   */
  proto._notify = function(type, data) {
    for (var i = 0; i < this._listeners.length; i++) {
      try {
        this._listeners[i](type, data);
      } catch (e) {
        // Don't let a bad listener break the store
      }
    }
  };

  // ── Expose ───────────────────────────────────────────────────────────

  window.WorkspaceStore = WorkspaceStore;
})();
