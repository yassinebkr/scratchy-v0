/**
 * MessageValidator - Validates v2 envelope messages and v1 op arrays.
 */

const VALID_TYPES = ['a2ui', 'ag-ui', 'chat', 'v1'];

const VALID_OPS = ['upsert', 'patch', 'remove', 'clear', 'layout', 'move'];

const VALID_COMPONENT_TYPES = [
  'hero', 'gauge', 'progress', 'weather', 'alert', 'stats', 'checklist',
  'card', 'kv', 'buttons', 'timeline', 'tags', 'table', 'sparkline',
  'code', 'accordion', 'stacked-bar', 'form-strip', 'link-card', 'status',
  'form', 'streak', 'rating', 'chips', 'toggle', 'input', 'slider', 'tabs',
  'video', 'image', 'chart-bar', 'chart-line', 'chart-pie'
];

const ID_REGEX = /^[a-zA-Z0-9_-]{1,100}$/;
const MAX_STRING_VALUE = 10 * 1024; // 10KB
const MAX_OPS = 50;
const MAX_COMPONENTS_PER_SURFACE_UPDATE = 50;
const MAX_DATA_ENTRIES = 200;
const MAX_SURFACES = 20;

class MessageValidator {
  /**
   * Validate an envelope message.
   * @param {object} envelope
   * @returns {{valid: boolean, errors: string[]}}
   */
  validate(envelope) {
    const errors = [];

    if (!envelope || typeof envelope !== 'object') {
      return { valid: false, errors: ['Envelope must be an object'] };
    }

    if (!VALID_TYPES.includes(envelope.type)) {
      errors.push(`Invalid type "${envelope.type}". Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    if (!envelope.payload || typeof envelope.payload !== 'object') {
      errors.push('Envelope must have a payload object');
    }

    if (errors.length) return { valid: false, errors };

    // Type-specific validation
    if (envelope.type === 'v1') {
      const v1Result = this.validateV1Ops(envelope.payload.ops || envelope.payload);
      if (!v1Result.valid) errors.push(...v1Result.errors);
    }

    if (envelope.type === 'a2ui') {
      this._validateA2UIPayload(envelope.payload, errors);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a v1 op array.
   * @param {Array} ops
   * @returns {{valid: boolean, errors: string[]}}
   */
  validateV1Ops(ops) {
    const errors = [];

    if (!Array.isArray(ops)) {
      return { valid: false, errors: ['V1 ops must be an array'] };
    }

    if (ops.length > MAX_OPS) {
      errors.push(`Max ${MAX_OPS} ops per batch, got ${ops.length}`);
    }

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const prefix = `Op[${i}]`;

      if (!op || typeof op !== 'object') {
        errors.push(`${prefix}: must be an object`);
        continue;
      }

      if (!VALID_OPS.includes(op.op)) {
        errors.push(`${prefix}: invalid op "${op.op}". Must be one of: ${VALID_OPS.join(', ')}`);
        continue;
      }

      // ID-required ops
      if (op.op === 'upsert') {
        if (!this._isValidId(op.id)) errors.push(`${prefix}: upsert requires a valid id`);
        if (!this._isValidComponentType(op.type)) errors.push(`${prefix}: upsert requires a valid type`);
      }
      if (op.op === 'patch') {
        if (!this._isValidId(op.id)) errors.push(`${prefix}: patch requires a valid id`);
      }
      if (op.op === 'remove') {
        if (!this._isValidId(op.id)) errors.push(`${prefix}: remove requires a valid id`);
      }

      // Check data values for functions
      if (op.data) {
        this._checkNoFunctions(op.data, `${prefix}.data`, errors);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /** @private */
  _validateA2UIPayload(payload, errors) {
    if (payload.surfaceUpdate) {
      const su = payload.surfaceUpdate;
      if (Array.isArray(su.components) && su.components.length > MAX_COMPONENTS_PER_SURFACE_UPDATE) {
        errors.push(`surfaceUpdate: max ${MAX_COMPONENTS_PER_SURFACE_UPDATE} components, got ${su.components.length}`);
      }
      if (Array.isArray(su.components)) {
        for (let i = 0; i < su.components.length; i++) {
          const c = su.components[i];
          if (!this._isValidId(c.id)) errors.push(`surfaceUpdate.components[${i}]: invalid id`);
          if (!this._isValidComponentType(c.type)) errors.push(`surfaceUpdate.components[${i}]: invalid type "${c.type}"`);
        }
      }
    }

    if (payload.dataModelUpdate) {
      const dm = payload.dataModelUpdate;
      if (Array.isArray(dm.entries) && dm.entries.length > MAX_DATA_ENTRIES) {
        errors.push(`dataModelUpdate: max ${MAX_DATA_ENTRIES} entries, got ${dm.entries.length}`);
      }
    }

    if (Array.isArray(payload.surfaces) && payload.surfaces.length > MAX_SURFACES) {
      errors.push(`Max ${MAX_SURFACES} surfaces, got ${payload.surfaces.length}`);
    }

    // Check string values for size
    this._checkStringSize(payload, 'payload', errors);
  }

  /** @private */
  _isValidId(id) {
    return typeof id === 'string' && ID_REGEX.test(id);
  }

  /** @private */
  _isValidComponentType(type) {
    return typeof type === 'string' && VALID_COMPONENT_TYPES.includes(type);
  }

  /** @private - Recursively check no function values */
  _checkNoFunctions(obj, path, errors) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'function') {
        errors.push(`${path}.${key}: function values not allowed`);
      } else if (val && typeof val === 'object') {
        this._checkNoFunctions(val, `${path}.${key}`, errors);
      }
    }
  }

  /** @private - Check string values don't exceed 10KB */
  _checkStringSize(obj, path, errors) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > MAX_STRING_VALUE) {
        errors.push(`${path}.${key}: string exceeds ${MAX_STRING_VALUE} bytes`);
      } else if (val && typeof val === 'object') {
        this._checkStringSize(val, `${path}.${key}`, errors);
      }
    }
  }
}

module.exports = { MessageValidator };
