/**
 * SurfaceState - Manages multi-surface state for the v2 protocol layer.
 * Max 20 surfaces enforced.
 */

const MAX_SURFACES = 20;

class SurfaceState {
  constructor() {
    /** @type {Map<string, {components: Map<string, object>, data: object, created: number}>} */
    this._surfaces = new Map();
  }

  /**
   * Get or create a surface by ID.
   * @param {string} surfaceId
   * @returns {{components: Map, data: object, created: number}}
   * @throws if max surfaces exceeded
   */
  get(surfaceId) {
    let surface = this._surfaces.get(surfaceId);
    if (!surface) {
      if (this._surfaces.size >= MAX_SURFACES) {
        throw new Error(`Max ${MAX_SURFACES} surfaces reached`);
      }
      surface = { components: new Map(), data: {}, created: Date.now() };
      this._surfaces.set(surfaceId, surface);
    }
    return surface;
  }

  /**
   * Update (upsert) components on a surface.
   * @param {string} surfaceId
   * @param {Array<{id: string, type: string, data?: object, layout?: object}>} components
   */
  updateComponents(surfaceId, components) {
    const surface = this.get(surfaceId);
    for (const comp of components) {
      const existing = surface.components.get(comp.id);
      if (existing) {
        // Merge: preserve existing data, overlay new
        surface.components.set(comp.id, {
          ...existing,
          ...comp,
          data: comp.data ? this._deepMerge({ ...(existing.data || {}) }, comp.data) : existing.data
        });
      } else {
        surface.components.set(comp.id, { ...comp });
      }
    }
  }

  /**
   * Update the data model at a given path.
   * @param {string} surfaceId
   * @param {string} path - Dot-style path, e.g. "weather"
   * @param {Array<{key: string, valueString?: string, valueNumber?: number, valueBool?: boolean}>} contents
   */
  updateData(surfaceId, path, contents) {
    const surface = this.get(surfaceId);
    if (!surface.data[path]) surface.data[path] = {};
    const target = surface.data[path];
    for (const entry of contents) {
      if (entry.valueString !== undefined) target[entry.key] = entry.valueString;
      else if (entry.valueNumber !== undefined) target[entry.key] = entry.valueNumber;
      else if (entry.valueBool !== undefined) target[entry.key] = entry.valueBool;
    }
  }

  /**
   * Remove specific components by ID from a surface.
   * @param {string} surfaceId
   * @param {string[]} componentIds
   */
  removeComponents(surfaceId, componentIds) {
    const surface = this._surfaces.get(surfaceId);
    if (!surface) return;
    for (const id of componentIds) {
      surface.components.delete(id);
    }
  }

  /**
   * Delete an entire surface.
   * @param {string} surfaceId
   */
  delete(surfaceId) {
    this._surfaces.delete(surfaceId);
  }

  /**
   * Get a full snapshot of a surface (for STATE_SNAPSHOT on connect).
   * @param {string} surfaceId
   * @returns {{components: object[], data: object} | null}
   */
  snapshot(surfaceId) {
    const surface = this._surfaces.get(surfaceId);
    if (!surface) return null;
    return {
      components: Array.from(surface.components.values()),
      data: { ...surface.data }
    };
  }

  /**
   * Get all surface IDs.
   * @returns {string[]}
   */
  list() {
    return Array.from(this._surfaces.keys());
  }

  /**
   * Deep merge source into target (mutates target). For patch-like updates.
   * @param {object} target
   * @param {object} source
   * @returns {object} merged target
   */
  _deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      const sv = source[key];
      const tv = target[key];
      if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
        this._deepMerge(tv, sv);
      } else {
        target[key] = sv;
      }
    }
    return target;
  }
}

module.exports = { SurfaceState };
