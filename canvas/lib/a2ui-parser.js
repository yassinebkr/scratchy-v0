const A2UI_KEYS = ['surfaceUpdate', 'dataModelUpdate', 'beginRendering', 'deleteSurface'];
const BLOCK_RE = /```scratchy-a2ui\s*\n([\s\S]*?)```/g;

class A2UIParser {
  parse(text) {
    const envelopes = [];
    const cleanText = text.replace(BLOCK_RE, (_, body) => {
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (A2UI_KEYS.some(k => k in parsed)) {
            envelopes.push({ type: 'a2ui', payload: parsed });
          }
        } catch (_e) { /* skip unparseable lines */ }
      }
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();

    return { envelopes, cleanText };
  }

  validateUserAction(action) {
    const errors = [];
    if (!action || typeof action !== 'object') {
      return { valid: false, action: null, errors: ['action must be an object'] };
    }
    for (const field of ['surfaceId', 'componentId', 'action']) {
      if (typeof action[field] !== 'string' || !action[field]) {
        errors.push(`${field} is required and must be a non-empty string`);
      }
    }
    if (action.context !== undefined && (typeof action.context !== 'object' || action.context === null || Array.isArray(action.context))) {
      errors.push('context must be a plain object if provided');
    }
    return { valid: errors.length === 0, action: errors.length === 0 ? action : null, errors };
  }

  formatUserActionMessage(action) {
    let msg = `[UserAction] component=${action.componentId} action=${action.action} surface=${action.surfaceId}`;
    if (action.context && Object.keys(action.context).length > 0) {
      msg += `\nContext: ${JSON.stringify(action.context)}`;
    }
    return msg;
  }
}

module.exports = { A2UIParser };
