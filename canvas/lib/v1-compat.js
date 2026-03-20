/**
 * V1Compat — Translates v1 canvas ops into v2 A2UI envelope messages.
 */

class V1Compat {
  /**
   * Convert a hyphenated type name to PascalCase.
   * "chart-bar" → "ChartBar", "weather" → "Weather"
   */
  _toPascal(type) {
    return type.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }

  /**
   * Convert a data object's entries into A2UI dataModel contents array.
   * Each entry becomes {key, valueString|valueNumber|valueBool}.
   */
  _toContents(data) {
    if (!data) return [];
    return Object.entries(data).map(([key, val]) => {
      const entry = { key };
      if (typeof val === 'boolean') entry.valueBool = val;
      else if (typeof val === 'number') entry.valueNumber = val;
      else if (typeof val === 'string') entry.valueString = val;
      else entry.valueString = JSON.stringify(val);
      return entry;
    });
  }

  /**
   * Build data bindings object from data keys and component id.
   */
  _toBindings(id, data) {
    if (!data) return {};
    const bindings = {};
    for (const key of Object.keys(data)) {
      bindings[key] = { dataBinding: `/${id}/${key}` };
    }
    return bindings;
  }

  _beginRendering(surfaceId) {
    return { type: 'a2ui', payload: { beginRendering: { surfaceId, root: 'canvas-root' } } };
  }

  /**
   * Translate an array of v1 ops into an array of v2 A2UI envelopes.
   * beginRendering is batched: only one emitted at the end if needed.
   */
  translate(ops, surfaceId = 'main') {
    const envelopes = [];
    let needsRender = false;

    for (const op of ops) {
      switch (op.op) {
        case 'upsert': {
          const typeName = this._toPascal(op.type);
          const bindings = this._toBindings(op.id, op.data);
          envelopes.push({
            type: 'a2ui',
            payload: {
              surfaceUpdate: {
                surfaceId,
                components: [{ id: op.id, component: { [typeName]: bindings } }]
              }
            }
          });
          envelopes.push({
            type: 'a2ui',
            payload: {
              dataModelUpdate: {
                surfaceId,
                path: op.id,
                contents: this._toContents(op.data)
              }
            }
          });
          needsRender = true;
          break;
        }

        case 'patch': {
          envelopes.push({
            type: 'a2ui',
            payload: {
              dataModelUpdate: {
                surfaceId,
                path: op.id,
                contents: this._toContents(op.data)
              }
            }
          });
          needsRender = true;
          break;
        }

        case 'remove': {
          envelopes.push({
            type: 'a2ui',
            payload: { surfaceUpdate: { surfaceId, removeComponents: [op.id] } }
          });
          needsRender = true;
          break;
        }

        case 'clear': {
          envelopes.push({
            type: 'a2ui',
            payload: { deleteSurface: { surfaceId } }
          });
          // clear does not need beginRendering (client recreates surface)
          break;
        }

        case 'layout': {
          envelopes.push({
            type: 'a2ui',
            payload: { surfaceUpdate: { surfaceId, layout: { mode: op.mode } } }
          });
          needsRender = true;
          break;
        }

        case 'move': {
          envelopes.push({
            type: 'a2ui',
            payload: { surfaceUpdate: { surfaceId, moveComponent: { id: op.id, layout: op.layout } } }
          });
          needsRender = true;
          break;
        }
      }
    }

    if (needsRender) {
      envelopes.push(this._beginRendering(surfaceId));
    }

    return envelopes;
  }
}

module.exports = { V1Compat };
