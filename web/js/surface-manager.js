// ============================================
// Scratchy Canvas v2 — Surface Manager
// ============================================
// Receives v2 envelope messages, dispatches to correct surface DOM.
// Uses DataModel for data binding resolution.
// Handles beginRendering buffering to eliminate entrance flash.

var SurfaceManager = (function() {
  'use strict';

  // ── State ──
  var surfaces = {};        // surfaceId -> {id, components, dataModel, layout}
  var _canvasState = null;  // Reference to v1 CanvasState for backward compat
  var _flushCallback = null;

  // ── Init ──
  function init(canvasState, onFlush) {
    _canvasState = canvasState;
    _flushCallback = onFlush;
  }

  // ── Surface lifecycle ──
  function _getOrCreateSurface(surfaceId) {
    if (surfaces[surfaceId]) return surfaces[surfaceId];
    surfaces[surfaceId] = {
      id: surfaceId,
      components: {},   // id -> {id, type, bindings}
      dataModel: (typeof DataModel !== 'undefined') ? new DataModel() : null,
      layout: 'auto'
    };
    return surfaces[surfaceId];
  }

  function _deleteSurface(surfaceId) {
    var surface = surfaces[surfaceId];
    if (surface && surface.dataModel) {
      surface.dataModel.clear();
    }
    delete surfaces[surfaceId];
  }

  // ── Type conversion ──
  function _typeToKebab(pascalType) {
    return pascalType
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }

  // ── Resolve component bindings to plain data via DataModel ──
  function _resolveComponentData(surface, bindings) {
    if (!bindings || typeof bindings !== 'object') return {};
    if (!surface.dataModel) return bindings; // no DataModel, pass through
    return surface.dataModel.resolveAll(bindings);
  }

  // ── Handlers ──

  function _handleSurfaceUpdate(payload) {
    var surfaceId = payload.surfaceId || 'main';
    var surface = _getOrCreateSurface(surfaceId);

    if (payload.layout) {
      surface.layout = payload.layout.mode || surface.layout;
    }

    // Remove components
    if (payload.removeComponents) {
      for (var i = 0; i < payload.removeComponents.length; i++) {
        var rid = payload.removeComponents[i];
        delete surface.components[rid];
        if (surface.dataModel) surface.dataModel.unwatchComponent(rid);
        if (_canvasState) _canvasState.apply({ op: 'remove', id: rid });
      }
    }

    // Move component
    if (payload.moveComponent) {
      var mc = payload.moveComponent;
      if (surface.components[mc.id]) {
        surface.components[mc.id].layout = mc.layout;
        if (_canvasState) _canvasState.apply({ op: 'move', id: mc.id, layout: mc.layout });
      }
    }

    // Upsert components (structure only — data comes via dataModelUpdate)
    if (payload.components) {
      for (var i = 0; i < payload.components.length; i++) {
        var comp = payload.components[i];
        if (!comp.id || !comp.component) continue;
        var typeName = Object.keys(comp.component)[0];
        var bindings = comp.component[typeName] || {};
        var kebabType = _typeToKebab(typeName);
        surface.components[comp.id] = {
          id: comp.id,
          type: kebabType,
          bindings: bindings,
          layout: comp.layout || { zone: 'auto', order: 0 }
        };
      }
    }
  }

  function _handleDataModelUpdate(payload) {
    var surfaceId = payload.surfaceId || 'main';
    var surface = _getOrCreateSurface(surfaceId);

    if (!surface.dataModel) return;

    // Update data model
    surface.dataModel.setContents(payload.path || '', payload.contents || []);
  }

  // ── Flush surface: resolve all bindings and push to v1 CanvasState ──
  function _flushSurface(surfaceId) {
    var surface = surfaces[surfaceId];
    if (!surface || !_canvasState) return;

    // Layout
    if (surface.layout) {
      _canvasState.apply({ op: 'layout', mode: surface.layout });
    }

    // For each component, resolve bindings → data, then upsert into v1 CanvasState
    var compIds = Object.keys(surface.components);
    for (var i = 0; i < compIds.length; i++) {
      var comp = surface.components[compIds[i]];
      var resolvedData = _resolveComponentData(surface, comp.bindings);
      _canvasState.apply({
        op: 'upsert',
        id: comp.id,
        type: comp.type,
        data: resolvedData,
        layout: comp.layout
      });

      // Register watcher for data-only updates (Phase 2 optimization)
      _registerComponentWatcher(surface, comp);
    }
  }

  // ── Register data watchers for a component ──
  // When data changes, re-resolve bindings and patch the component
  function _registerComponentWatcher(surface, comp) {
    if (!surface.dataModel || !comp.bindings) return;

    // Unwatch previous (in case of re-register)
    surface.dataModel.unwatchComponent(comp.id);

    // Find all data paths this component binds to
    var bindingKeys = Object.keys(comp.bindings);
    for (var i = 0; i < bindingKeys.length; i++) {
      var bv = comp.bindings[bindingKeys[i]];
      if (bv && typeof bv === 'object' && bv.dataBinding) {
        // Watch the component's data path (e.g. "gauge-cpu")
        var basePath = bv.dataBinding.replace(/^\//, '').split('/')[0];
        surface.dataModel.watch(basePath, comp.id, function() {
          // Data changed — re-resolve all bindings and patch
          if (!_canvasState) return;
          var newData = _resolveComponentData(surface, comp.bindings);
          _canvasState.apply({ op: 'patch', id: comp.id, data: newData });
        });
        break; // One watcher per component is enough (watches base path)
      }
    }
  }

  // ── Main entry point ──
  function processEnvelope(envelope) {
    if (!envelope || !envelope.type) return;

    // v1 passthrough
    if (envelope.type === 'v1') {
      if (envelope.payload && envelope.payload.ops) {
        var ops = envelope.payload.ops;
        for (var i = 0; i < ops.length; i++) {
          if (_canvasState) _canvasState.apply(ops[i]);
        }
      }
      return;
    }

    if (envelope.type !== 'a2ui') return;
    var payload = envelope.payload;
    if (!payload) return;

    if (payload.surfaceUpdate) {
      _handleSurfaceUpdate(payload.surfaceUpdate);
    } else if (payload.dataModelUpdate) {
      _handleDataModelUpdate(payload.dataModelUpdate);
    } else if (payload.beginRendering) {
      // Flush — this is the signal to render
      _flushSurface(payload.beginRendering.surfaceId || 'main');
      if (_flushCallback) _flushCallback(payload.beginRendering.surfaceId || 'main');
    } else if (payload.deleteSurface) {
      if (_canvasState) _canvasState.apply({ op: 'clear' });
      _deleteSurface(payload.deleteSurface.surfaceId || 'main');
    }
  }

  function processBatch(envelopes) {
    if (!Array.isArray(envelopes)) return;
    for (var i = 0; i < envelopes.length; i++) {
      processEnvelope(envelopes[i]);
    }
  }

  function getSurface(surfaceId) {
    return surfaces[surfaceId] || null;
  }

  function listSurfaces() {
    return Object.keys(surfaces);
  }

  return {
    init: init,
    processEnvelope: processEnvelope,
    processBatch: processBatch,
    getSurface: getSurface,
    listSurfaces: listSurfaces
  };
})();
