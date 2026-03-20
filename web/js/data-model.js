// ============================================
// Scratchy Canvas v2 — Data Model
// ============================================
// Path-based data store with change tracking.
// Supports JSON Pointer paths (RFC 6901).
// Components register watched paths; only affected
// components re-render on data updates.

var DataModel = (function() {
  'use strict';

  function DataModel() {
    this._data = {};           // flat path → value store (e.g. "weather/city" → "Paris")
    this._watchers = {};       // path → [{componentId, callback}]
    this._batchDepth = 0;      // nested batch support
    this._batchChanges = null; // Set of changed paths during batch
  }

  // ── Path operations ──

  // Normalize path: strip leading /, split on /
  DataModel.prototype._parsePath = function(path) {
    if (!path) return [];
    return path.replace(/^\//, '').split('/');
  };

  // Get value at path (e.g. "/weather/city" or "weather/city")
  DataModel.prototype.get = function(path) {
    var parts = this._parsePath(path);
    var obj = this._data;
    for (var i = 0; i < parts.length; i++) {
      if (obj == null || typeof obj !== 'object') return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  };

  // Set value at path, creating intermediate objects as needed
  DataModel.prototype.set = function(path, value) {
    var parts = this._parsePath(path);
    if (parts.length === 0) return;

    var obj = this._data;
    for (var i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] == null || typeof obj[parts[i]] !== 'object') {
        obj[parts[i]] = {};
      }
      obj = obj[parts[i]];
    }

    var lastKey = parts[parts.length - 1];
    var oldVal = obj[lastKey];
    obj[lastKey] = value;

    // Notify if changed
    if (oldVal !== value) {
      this._notifyPath(path);
      // Also notify parent path watchers (e.g. changing "/weather/city" notifies "/weather")
      for (var j = parts.length - 1; j > 0; j--) {
        this._notifyPath(parts.slice(0, j).join('/'));
      }
    }
  };

  // Set multiple values under a base path from A2UI contents array
  // contents: [{key, valueString|valueNumber|valueBool}]
  DataModel.prototype.setContents = function(basePath, contents) {
    if (!Array.isArray(contents)) return;
    this.beginBatch();
    for (var i = 0; i < contents.length; i++) {
      var entry = contents[i];
      var val;
      if ('valueString' in entry) {
        // Try parsing JSON for arrays/objects
        try { val = JSON.parse(entry.valueString); } catch(e) { val = entry.valueString; }
      } else if ('valueNumber' in entry) {
        val = entry.valueNumber;
      } else if ('valueBool' in entry) {
        val = entry.valueBool;
      } else {
        val = entry.value;
      }
      var fullPath = basePath ? basePath + '/' + entry.key : entry.key;
      this.set(fullPath, val);
    }
    this.endBatch();
  };

  // Delete value at path
  DataModel.prototype.delete = function(path) {
    var parts = this._parsePath(path);
    if (parts.length === 0) return;

    var obj = this._data;
    for (var i = 0; i < parts.length - 1; i++) {
      if (obj == null || typeof obj !== 'object') return;
      obj = obj[parts[i]];
    }
    if (obj && typeof obj === 'object') {
      delete obj[parts[parts.length - 1]];
      this._notifyPath(path);
    }
  };

  // Get full snapshot of data under a path (or all data)
  DataModel.prototype.snapshot = function(path) {
    if (!path) return JSON.parse(JSON.stringify(this._data));
    var val = this.get(path);
    return val != null ? JSON.parse(JSON.stringify(val)) : null;
  };

  // Clear all data
  DataModel.prototype.clear = function() {
    this._data = {};
    this._notifyAll();
  };

  // ── Batch operations ──
  // Batch prevents notifications until endBatch, then fires all at once

  DataModel.prototype.beginBatch = function() {
    if (this._batchDepth === 0) {
      this._batchChanges = {};
    }
    this._batchDepth++;
  };

  DataModel.prototype.endBatch = function() {
    this._batchDepth--;
    if (this._batchDepth <= 0) {
      this._batchDepth = 0;
      var changes = this._batchChanges;
      this._batchChanges = null;
      if (changes) {
        var paths = Object.keys(changes);
        for (var i = 0; i < paths.length; i++) {
          this._fireWatchers(paths[i]);
        }
      }
    }
  };

  // ── Watchers ──

  // Watch a path for changes. Returns unwatch function.
  DataModel.prototype.watch = function(path, componentId, callback) {
    var normalized = path.replace(/^\//, '');
    if (!this._watchers[normalized]) this._watchers[normalized] = [];
    var entry = { componentId: componentId, callback: callback };
    this._watchers[normalized].push(entry);

    // Return unwatch function
    var self = this;
    return function() {
      var list = self._watchers[normalized];
      if (!list) return;
      var idx = list.indexOf(entry);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) delete self._watchers[normalized];
    };
  };

  // Remove all watchers for a component
  DataModel.prototype.unwatchComponent = function(componentId) {
    var paths = Object.keys(this._watchers);
    for (var i = 0; i < paths.length; i++) {
      var list = this._watchers[paths[i]];
      for (var j = list.length - 1; j >= 0; j--) {
        if (list[j].componentId === componentId) list.splice(j, 1);
      }
      if (list.length === 0) delete this._watchers[paths[i]];
    }
  };

  // ── Internal notification ──

  DataModel.prototype._notifyPath = function(path) {
    var normalized = path.replace(/^\//, '');
    if (this._batchDepth > 0) {
      this._batchChanges[normalized] = true;
      return;
    }
    this._fireWatchers(normalized);
  };

  DataModel.prototype._fireWatchers = function(normalizedPath) {
    // Fire exact path watchers
    var list = this._watchers[normalizedPath];
    if (list) {
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].callback(normalizedPath, this.get(normalizedPath));
        } catch(e) {
          console.error('[DataModel] Watcher error:', e);
        }
      }
    }
    // Fire parent path watchers (e.g. "weather" fires for "weather/city" change)
    // Already handled by _notifyPath calling parents
  };

  DataModel.prototype._notifyAll = function() {
    var paths = Object.keys(this._watchers);
    for (var i = 0; i < paths.length; i++) {
      this._fireWatchers(paths[i]);
    }
  };

  // ── Resolve a BoundValue against this data model ──
  DataModel.prototype.resolve = function(boundValue) {
    if (boundValue == null) return boundValue;
    if (typeof boundValue !== 'object') return boundValue;
    if ('literalString' in boundValue) return boundValue.literalString;
    if ('literalNumber' in boundValue) return boundValue.literalNumber;
    if ('literalBool' in boundValue) return boundValue.literalBool;
    if ('dataBinding' in boundValue) return this.get(boundValue.dataBinding);
    // Plain value passthrough (v1 compat)
    return boundValue;
  };

  // Resolve all bindings in an object to plain values
  DataModel.prototype.resolveAll = function(bindings) {
    if (!bindings || typeof bindings !== 'object') return {};
    var result = {};
    var keys = Object.keys(bindings);
    for (var i = 0; i < keys.length; i++) {
      result[keys[i]] = this.resolve(bindings[keys[i]]);
    }
    return result;
  };

  return DataModel;
})();
