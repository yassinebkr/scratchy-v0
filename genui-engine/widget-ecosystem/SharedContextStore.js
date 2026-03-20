/**
 * SharedContextStore - Cross-Widget Data Management
 * Centralized store for shared data, contexts, and relationships
 */

const { widgetEventBus } = require('./WidgetEventBus');

class SharedContextStore {
  constructor() {
    this.contexts = new Map(); // Main data store
    this.relationships = new Map(); // Data relationships
    this.subscriptions = new Map(); // Widget subscriptions
    this.changeHistory = [];
    this.maxHistorySize = 2000;
    this.debugMode = false;
  }

  /**
   * Set data in a specific context
   */
  set(contextPath, data, source = null) {
    const changeId = `change-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const previousValue = this.get(contextPath);
    
    // Parse context path (e.g., "user.123.notes" or "projects.alpha.tasks")
    const pathParts = contextPath.split('.');
    const contextKey = pathParts[0];
    
    if (!this.contexts.has(contextKey)) {
      this.contexts.set(contextKey, {});
    }
    
    // Set nested data using path
    const contextData = this.contexts.get(contextKey);
    this.setNestedValue(contextData, pathParts.slice(1), data);

    // Record change
    const change = {
      id: changeId,
      contextPath,
      previousValue,
      newValue: data,
      source,
      timestamp: Date.now(),
      operation: previousValue === undefined ? 'create' : 'update'
    };

    this.changeHistory.push(change);
    if (this.changeHistory.length > this.maxHistorySize) {
      this.changeHistory.shift();
    }

    if (this.debugMode) {
      console.log(`📊 Context updated: ${contextPath} by ${source || 'system'}`);
    }

    // Notify subscribed widgets
    this.notifySubscribers(contextPath, change);

    // Emit global event
    widgetEventBus.emit('context-changed', {
      contextPath,
      data,
      source,
      operation: change.operation
    }, source);

    return changeId;
  }

  /**
   * Get data from context
   */
  get(contextPath) {
    const pathParts = contextPath.split('.');
    const contextKey = pathParts[0];
    
    if (!this.contexts.has(contextKey)) {
      return undefined;
    }
    
    const contextData = this.contexts.get(contextKey);
    return this.getNestedValue(contextData, pathParts.slice(1));
  }

  /**
   * Delete data from context
   */
  delete(contextPath, source = null) {
    const previousValue = this.get(contextPath);
    if (previousValue === undefined) {
      return false;
    }

    const pathParts = contextPath.split('.');
    const contextKey = pathParts[0];
    const contextData = this.contexts.get(contextKey);
    
    if (pathParts.length === 1) {
      // Delete entire context
      this.contexts.delete(contextKey);
    } else {
      // Delete nested value
      this.deleteNestedValue(contextData, pathParts.slice(1));
    }

    // Record change
    const change = {
      id: `change-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      contextPath,
      previousValue,
      newValue: undefined,
      source,
      timestamp: Date.now(),
      operation: 'delete'
    };

    this.changeHistory.push(change);

    if (this.debugMode) {
      console.log(`📊 Context deleted: ${contextPath} by ${source || 'system'}`);
    }

    // Notify subscribers
    this.notifySubscribers(contextPath, change);

    // Emit event
    widgetEventBus.emit('context-deleted', {
      contextPath,
      source
    }, source);

    return true;
  }

  /**
   * Subscribe widget to context changes
   */
  subscribe(widgetId, contextPath, callback) {
    if (!this.subscriptions.has(contextPath)) {
      this.subscriptions.set(contextPath, new Map());
    }
    
    this.subscriptions.get(contextPath).set(widgetId, {
      callback,
      subscribedAt: Date.now()
    });

    if (this.debugMode) {
      console.log(`📊 Widget ${widgetId} subscribed to ${contextPath}`);
    }

    // Return unsubscribe function
    return () => this.unsubscribe(widgetId, contextPath);
  }

  /**
   * Unsubscribe widget from context changes
   */
  unsubscribe(widgetId, contextPath) {
    if (this.subscriptions.has(contextPath)) {
      const removed = this.subscriptions.get(contextPath).delete(widgetId);
      
      // Clean up empty subscriptions
      if (this.subscriptions.get(contextPath).size === 0) {
        this.subscriptions.delete(contextPath);
      }

      if (this.debugMode && removed) {
        console.log(`📊 Widget ${widgetId} unsubscribed from ${contextPath}`);
      }
      
      return removed;
    }
    return false;
  }

  /**
   * Create relationships between data contexts
   */
  relate(sourceContext, targetContext, relationship = 'references') {
    const relationId = `rel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    if (!this.relationships.has(sourceContext)) {
      this.relationships.set(sourceContext, []);
    }
    
    this.relationships.get(sourceContext).push({
      id: relationId,
      target: targetContext,
      relationship,
      createdAt: Date.now()
    });

    if (this.debugMode) {
      console.log(`📊 Relationship created: ${sourceContext} ${relationship} ${targetContext}`);
    }

    return relationId;
  }

  /**
   * Get related contexts
   */
  getRelated(contextPath, relationship = null) {
    if (!this.relationships.has(contextPath)) {
      return [];
    }
    
    const relations = this.relationships.get(contextPath);
    return relationship 
      ? relations.filter(r => r.relationship === relationship)
      : relations;
  }

  /**
   * Query contexts by pattern
   */
  query(pattern) {
    const results = [];
    const regex = new RegExp(pattern.replace('*', '.*'));
    
    for (const [contextKey, contextData] of this.contexts) {
      if (regex.test(contextKey)) {
        results.push({
          contextPath: contextKey,
          data: contextData
        });
      }
      
      // Also search nested paths
      this.searchNested(contextData, contextKey, regex, results);
    }
    
    return results;
  }

  /**
   * Get aggregated data across contexts
   */
  aggregate(contextPattern, aggregateFunction) {
    const matchingContexts = this.query(contextPattern);
    
    switch (aggregateFunction) {
      case 'count':
        return matchingContexts.length;
      case 'sum':
        return matchingContexts.reduce((sum, ctx) => sum + (ctx.data.value || 0), 0);
      case 'avg':
        const total = matchingContexts.reduce((sum, ctx) => sum + (ctx.data.value || 0), 0);
        return matchingContexts.length > 0 ? total / matchingContexts.length : 0;
      case 'collect':
        return matchingContexts.map(ctx => ctx.data);
      default:
        throw new Error(`Unknown aggregate function: ${aggregateFunction}`);
    }
  }

  /**
   * Get context change history
   */
  getChangeHistory(contextPath = null, limit = 100) {
    let history = this.changeHistory;
    
    if (contextPath) {
      history = history.filter(change => 
        change.contextPath === contextPath || 
        change.contextPath.startsWith(contextPath + '.')
      );
    }
    
    return history.slice(-limit);
  }

  /**
   * Get all contexts overview
   */
  getContexts() {
    const overview = {};
    for (const [key, data] of this.contexts) {
      overview[key] = {
        dataSize: JSON.stringify(data).length,
        lastModified: this.getLastModified(key),
        subscribers: this.subscriptions.has(key) ? this.subscriptions.get(key).size : 0
      };
    }
    return overview;
  }

  /**
   * Clear all data (use with caution)
   */
  clear() {
    this.contexts.clear();
    this.relationships.clear();
    this.subscriptions.clear();
    this.changeHistory = [];
    
    if (this.debugMode) {
      console.log('📊 All contexts cleared');
    }
    
    widgetEventBus.emit('all-contexts-cleared', {}, 'system');
  }

  /**
   * Enable/disable debug mode
   */
  setDebugMode(enabled) {
    this.debugMode = enabled;
    console.log(`📊 SharedContextStore debug mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Helper methods
   */
  setNestedValue(obj, path, value) {
    if (path.length === 0) return value;
    
    const [key, ...rest] = path;
    if (rest.length === 0) {
      obj[key] = value;
    } else {
      if (!obj[key] || typeof obj[key] !== 'object') {
        obj[key] = {};
      }
      this.setNestedValue(obj[key], rest, value);
    }
  }

  getNestedValue(obj, path) {
    if (path.length === 0) return obj;
    
    const [key, ...rest] = path;
    if (obj[key] === undefined) return undefined;
    
    return rest.length === 0 ? obj[key] : this.getNestedValue(obj[key], rest);
  }

  deleteNestedValue(obj, path) {
    if (path.length === 1) {
      delete obj[path[0]];
      return;
    }
    
    const [key, ...rest] = path;
    if (obj[key] && typeof obj[key] === 'object') {
      this.deleteNestedValue(obj[key], rest);
    }
  }

  searchNested(obj, basePath, regex, results) {
    if (typeof obj !== 'object' || obj === null) return;
    
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = `${basePath}.${key}`;
      if (regex.test(fullPath)) {
        results.push({
          contextPath: fullPath,
          data: value
        });
      }
      
      if (typeof value === 'object' && value !== null) {
        this.searchNested(value, fullPath, regex, results);
      }
    }
  }

  notifySubscribers(contextPath, change) {
    // Exact path subscribers
    if (this.subscriptions.has(contextPath)) {
      for (const [widgetId, subscription] of this.subscriptions.get(contextPath)) {
        try {
          subscription.callback(change);
        } catch (error) {
          console.error(`Error notifying subscriber ${widgetId}:`, error);
        }
      }
    }
    
    // Pattern-based subscribers (parent paths)
    const pathParts = contextPath.split('.');
    for (let i = pathParts.length - 1; i > 0; i--) {
      const parentPath = pathParts.slice(0, i).join('.');
      if (this.subscriptions.has(parentPath + '.*')) {
        for (const [widgetId, subscription] of this.subscriptions.get(parentPath + '.*')) {
          try {
            subscription.callback(change);
          } catch (error) {
            console.error(`Error notifying pattern subscriber ${widgetId}:`, error);
          }
        }
      }
    }
  }

  getLastModified(contextPath) {
    const changes = this.changeHistory.filter(change => 
      change.contextPath === contextPath || 
      change.contextPath.startsWith(contextPath + '.')
    );
    
    return changes.length > 0 ? changes[changes.length - 1].timestamp : null;
  }

  /**
   * Get statistics
   */
  getStats() {
    const contextSizes = {};
    let totalDataSize = 0;
    
    for (const [key, data] of this.contexts) {
      const size = JSON.stringify(data).length;
      contextSizes[key] = size;
      totalDataSize += size;
    }
    
    return {
      totalContexts: this.contexts.size,
      totalDataSize,
      totalRelationships: Array.from(this.relationships.values()).reduce((sum, rels) => sum + rels.length, 0),
      totalSubscriptions: Array.from(this.subscriptions.values()).reduce((sum, subs) => sum + subs.size, 0),
      totalChanges: this.changeHistory.length,
      contextSizes,
      largestContext: Object.entries(contextSizes).reduce((max, [key, size]) => 
        size > (max.size || 0) ? { key, size } : max, {}
      )
    };
  }
}

// Singleton instance
const sharedContextStore = new SharedContextStore();

module.exports = { SharedContextStore, sharedContextStore };