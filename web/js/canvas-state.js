class CanvasState {
  constructor() {
    this.components = {}; // id -> component object
    this.layout = "auto"; // "auto" | "dashboard" | "focus" | "columns" | "rows"
    this.version = 0;
    this.sessionKey = null;
    this._listeners = [];
  }

  /**
   * Apply a single operation to the state.
   * @param {Object} op - The operation object { op, id, ...args }
   * @returns {boolean} - True if state changed
   */
  apply(op) {
    if (!op || !op.op) return false;

    let changed = false;
    const now = Date.now();

    switch (op.op) {
      case "upsert": {
        const { id, type, data, layout } = op;
        if (!id || !type) return false;

        const existing = this.components[id];
        const defaultLayout = { zone: "auto", order: 0 };

        if (existing) {
          // Update existing
          this.components[id] = {
            ...existing,
            type,
            data: data || existing.data,
            layout: layout || existing.layout,
            updatedAt: now
          };
        } else {
          // Create new
          this.components[id] = {
            id,
            type,
            data: data || {},
            layout: layout || defaultLayout,
            createdAt: now,
            updatedAt: now
          };
        }
        this._notify("upsert", this.components[id]);
        changed = true;
        break;
      }

      case "patch": {
        const { id, data } = op;
        const comp = this.components[id];
        if (comp && data) {
          // Deep merge data
          comp.data = this._deepMerge(comp.data || {}, data);
          comp.updatedAt = now;
          this._notify("patch", comp);
          changed = true;
        }
        break;
      }

      case "remove": {
        const { id } = op;
        if (this.components[id]) {
          delete this.components[id];
          this._notify("remove", { id });
          changed = true;
        }
        break;
      }

      case "clear": {
        this.components = {};
        this._notify("clear", {});
        changed = true;
        break;
      }

      case "layout": {
        const { mode } = op;
        if (mode && this.layout !== mode) {
          this.layout = mode;
          this._notify("layout", { mode });
          changed = true;
        }
        break;
      }

      case "move": {
        const { id, layout } = op;
        const comp = this.components[id];
        if (comp && layout) {
          comp.layout = { ...comp.layout, ...layout };
          comp.updatedAt = now;
          this._notify("move", comp);
          changed = true;
        }
        break;
      }
    }

    if (changed) {
      this.version++;
    }

    return changed;
  }

  /**
   * Load a full state snapshot, usually on connection or refresh.
   * @param {Object} state - The raw state object
   */
  loadSnapshot(state) {
    if (!state) return;
    
    this.components = state.components || {};
    this.layout = state.layout || "auto";
    this.version = state.version || 0;
    
    // If session matches, we might just be refreshing, but usually we just reset
    if (state.sessionKey) {
      this.sessionKey = state.sessionKey;
    }

    this._notify("reset", this.getAll());
  }

  /**
   * Clear all components from state.
   */
  clear() {
    this.apply({ op: "clear" });
  }

  /**
   * Switch to a new session key, clearing previous state.
   * @param {string} sessionKey 
   */
  switchSession(sessionKey) {
    this.sessionKey = sessionKey;
    this.clear();
    this.version = 0;
  }

  /**
   * Get a component by ID.
   * @param {string} id 
   * @returns {Object|undefined}
   */
  get(id) {
    return this.components[id];
  }

  /**
   * Get all components, sorted by layout order.
   * @returns {Array<Object>}
   */
  getAll() {
    return Object.values(this.components).sort((a, b) => {
      // Sort by zone first (optional), then by order
      // Assuming simple order integer for now
      const orderA = a.layout?.order || 0;
      const orderB = b.layout?.order || 0;
      return orderA - orderB;
    });
  }

  /**
   * Subscribe to state changes.
   * @param {Function} fn - Callback (type, data) => void
   */
  onChange(fn) {
    this._listeners.push(fn);
  }

  /**
   * Internal notification helper.
   * @param {string} type 
   * @param {Object} data 
   */
  _notify(type, data) {
    for (const listener of this._listeners) {
      try {
        listener(type, data);
      } catch (e) {
        console.error("CanvasState listener error:", e);
      }
    }
  }

  /**
   * Helper for deep merging objects.
   * Very basic implementation sufficient for data patches.
   */
  _deepMerge(target, source) {
    if (typeof target !== 'object' || target === null) return source;
    if (typeof source !== 'object' || source === null) return source;

    const output = { ...target };
    
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          output[key] = this._deepMerge(target[key], source[key]);
        } else {
          output[key] = source[key];
        }
      }
    }
    return output;
  }
}
