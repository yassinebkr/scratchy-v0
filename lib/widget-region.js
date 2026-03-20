'use strict';
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'genui-engine', 'widget-manifest.json');

class WidgetRegionManager {
  constructor() {
    this.manifest = null;
    this.widgets = [];
    this._loadManifest();
  }

  _loadManifest() {
    try {
      const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
      this.manifest = JSON.parse(raw);
      this.widgets = this.manifest.widgets || [];
    } catch (e) {
      console.error('[WidgetRegion] Failed to load manifest:', e.message);
      this.widgets = [];
    }
  }

  // Reload manifest (for hot-reload)
  reload() { this._loadManifest(); }

  // Get widget by ID
  getWidget(widgetId) {
    return this.widgets.find(w => w.id === widgetId) || null;
  }

  // Get widget by action prefix
  getWidgetByPrefix(action) {
    if (!action) return null;
    return this.widgets.find(w => action.startsWith(w.prefix)) || null;
  }

  // Match user intent to a widget
  matchIntent(userText) {
    if (!userText) return { widget: null, confidence: 0, alternatives: [] };
    const text = userText.toLowerCase();
    
    const scores = this.widgets.map(w => {
      let score = 0;
      // Check trigger phrases
      for (const phrase of w.triggerPhrases) {
        if (text.includes(phrase.toLowerCase())) {
          score += phrase.split(' ').length; // Multi-word matches score higher
        }
      }
      // Check anti-phrases (negative signal)
      for (const anti of w.antiPhrases) {
        if (text.includes(anti.toLowerCase())) {
          score -= 2;
        }
      }
      // Priority boost (only if we had at least one trigger match)
      if (score > 0 && w.priority === 'high') score += 0.5;
      
      return { widget: w, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

    if (scores.length === 0) return { widget: null, confidence: 0, alternatives: [] };
    
    const best = scores[0];
    const secondBest = scores[1];
    
    // Confidence: how much better is the best match vs second?
    let confidence = 1;
    if (secondBest && secondBest.score > 0) {
      confidence = best.score / (best.score + secondBest.score);
    }

    return {
      widget: best.widget,
      confidence,
      score: best.score,
      alternatives: scores.slice(1, 3).map(s => s.widget),
      needsDisambiguation: confidence < 0.65
    };
  }

  // Validate that canvas ops match user intent
  validateOps(canvasOps, recentUserMessages) {
    // Detect which widget the ops are trying to render
    const opWidget = this._detectWidgetFromOps(canvasOps);
    if (!opWidget) return { valid: true, reason: 'ad-hoc' }; // Not a known widget, ad-hoc GenUI

    // Check user intent from recent messages
    const combinedText = recentUserMessages.slice(-3).join(' ');
    const intentResult = this.matchIntent(combinedText);

    if (!intentResult.widget) return { valid: true, reason: 'no-clear-intent' };
    
    if (intentResult.widget.id !== opWidget.id) {
      return {
        valid: false,
        reason: 'mismatch',
        intended: intentResult.widget,
        attempted: opWidget,
        suggestedAction: intentResult.widget.entryAction
      };
    }

    return { valid: true, reason: 'match' };
  }

  _detectWidgetFromOps(ops) {
    for (const op of ops) {
      if (op.id) {
        const match = this.widgets.find(w => op.id.startsWith(w.prefix));
        if (match) return match;
      }
    }
    return null;
  }

  // Get skeleton config for a widget
  getSkeletonConfig(widgetId) {
    const w = this.getWidget(widgetId);
    if (!w) return { type: 'default', icon: '📦', title: 'Loading...' };
    return { type: w.skeletonType || 'default', icon: w.icon, title: w.name };
  }

  // Get all widgets (for admin UI)
  listWidgets() {
    return this.widgets.map(w => ({
      id: w.id, name: w.name, icon: w.icon, prefix: w.prefix,
      capabilities: w.capabilities, requiresAuth: w.requiresAuth
    }));
  }
}

module.exports = { WidgetRegionManager };
