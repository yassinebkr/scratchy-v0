/**
 * SmartWidget Base Class
 * Foundation for all smart widgets - designed for evolution through phases
 */

class SmartWidget {
  constructor(config = {}) {
    this.config = config;
    this.state = config.initialState || {};
    this.id = null; // Set by runtime
    this.type = 'smart-widget';
    this.element = null;
    this.runtime = null; // Injected by runtime
    this.api = null; // Injected by runtime
    
    // Phase 2 preparation
    this.subscriptions = new Set();
    this.intervals = new Set();
    this.eventListeners = new Map();
    
    // Lifecycle flags
    this.isInitialized = false;
    this.isMounted = false;
    this.isDestroyed = false;
  }

  /**
   * Lifecycle Methods
   * These remain stable across all phases
   */
  
  async init() {
    if (this.isInitialized) return;
    
    try {
      // Call user-defined initialization
      if (this.onInit) {
        await this.onInit();
      }
      
      this.isInitialized = true;
      console.log(`Widget ${this.id} initialized`);
      
    } catch (error) {
      console.error(`Widget ${this.id} initialization failed:`, error);
      throw error;
    }
  }

  async mount(container) {
    if (!this.isInitialized || this.isMounted) return;
    
    try {
      // Create widget container
      this.element = document.createElement('div');
      this.element.id = this.id;
      this.element.className = `smart-widget ${this.type}-widget`;
      
      // Initial render
      await this.render();
      
      // Mount to container
      container.appendChild(this.element);
      
      // Call user-defined mount handler
      if (this.onMount) {
        await this.onMount();
      }
      
      this.isMounted = true;
      console.log(`Widget ${this.id} mounted`);
      
    } catch (error) {
      console.error(`Widget ${this.id} mount failed:`, error);
      throw error;
    }
  }

  async render() {
    if (!this.element || this.isDestroyed) return;
    
    try {
      let html = '';
      
      if (this.template) {
        // Template-based rendering
        html = this.template(this.state, this.config);
      } else if (this.onRender) {
        // Custom render function
        html = await this.onRender(this.state, this.config);
      } else {
        // Default minimal rendering
        html = this.defaultTemplate();
      }
      
      // Update DOM
      this.element.innerHTML = html;
      
      // Bind event handlers after render
      this.bindEventHandlers();
      
      // Call post-render hook
      if (this.onPostRender) {
        await this.onPostRender();
      }
      
    } catch (error) {
      console.error(`Widget ${this.id} render failed:`, error);
      this.element.innerHTML = this.errorTemplate(error);
    }
  }

  /**
   * State Management
   * Consistent API that will work with enhanced state systems in Phase 2
   */
  
  setState(update, options = {}) {
    if (this.isDestroyed) return;
    
    const prevState = { ...this.state };
    
    if (typeof update === 'function') {
      this.state = { ...this.state, ...update(this.state) };
    } else {
      this.state = { ...this.state, ...update };
    }
    
    // Persist state via runtime
    if (this.runtime && this.runtime.setState) {
      this.runtime.setState(this.state);
    }
    
    // Re-render if needed
    if (!options.skipRender && this.shouldUpdate(prevState, this.state)) {
      this.render().catch(console.error);
    }
    
    // Call state change handler
    if (this.onStateChange) {
      this.onStateChange(this.state, prevState);
    }
  }

  getState() {
    return { ...this.state };
  }

  shouldUpdate(prevState, nextState) {
    // Default: always update
    // Override in subclasses for performance optimization
    return true;
  }

  /**
   * Communication Methods
   * Event system that will integrate with advanced message passing in Phase 2
   */
  
  emit(event, data = null) {
    if (this.runtime && this.runtime.emit) {
      this.runtime.emit(event, data);
    }
    
    // Also emit locally for direct widget-to-widget communication
    const customEvent = new CustomEvent(`widget:${event}`, {
      detail: { widgetId: this.id, data }
    });
    document.dispatchEvent(customEvent);
  }

  listen(event, callback) {
    if (this.runtime && this.runtime.listen) {
      this.runtime.listen(event, callback);
      this.subscriptions.add(event);
    }
  }

  /**
   * API Access Methods
   * Abstracted to work with different API systems across phases
   */
  
  async connectAPI(serviceName, credentials = null) {
    if (!this.api) {
      throw new Error('API proxy not available');
    }
    
    try {
      const connection = await this.api[serviceName];
      
      // Store connection reference for cleanup
      if (!this.apiConnections) {
        this.apiConnections = new Map();
      }
      this.apiConnections.set(serviceName, connection);
      
      return connection;
    } catch (error) {
      console.error(`Failed to connect to API ${serviceName}:`, error);
      throw error;
    }
  }

  async fetchData(source, params = {}) {
    // Generic data fetching method
    // Will be enhanced in Phase 2 with caching, retries, etc.
    
    if (typeof source === 'string') {
      // API call
      const api = await this.connectAPI(source);
      return await api.fetch(params);
    } else if (typeof source === 'function') {
      // Custom data fetcher
      return await source(params);
    } else {
      throw new Error('Invalid data source');
    }
  }

  /**
   * Utility Methods
   */
  
  startPolling(interval, callback) {
    const intervalId = setInterval(async () => {
      try {
        await callback();
      } catch (error) {
        console.error(`Polling error in widget ${this.id}:`, error);
      }
    }, interval);
    
    this.intervals.add(intervalId);
    return intervalId;
  }

  stopPolling(intervalId) {
    if (intervalId && this.intervals.has(intervalId)) {
      clearInterval(intervalId);
      this.intervals.delete(intervalId);
    }
  }

  bindEventHandlers() {
    // Automatically bind click handlers and other events
    // This allows widgets to define methods that are automatically connected
    
    const clickElements = this.element.querySelectorAll('[data-click]');
    clickElements.forEach(el => {
      const methodName = el.getAttribute('data-click');
      if (typeof this[methodName] === 'function') {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          this[methodName](e);
        });
      }
    });
    
    const inputElements = this.element.querySelectorAll('[data-input]');
    inputElements.forEach(el => {
      const methodName = el.getAttribute('data-input');
      if (typeof this[methodName] === 'function') {
        el.addEventListener('input', (e) => {
          this[methodName](e.target.value, e);
        });
      }
    });
  }

  /**
   * Configuration Update
   * Allows runtime configuration changes
   */
  
  async updateConfig(newConfig) {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };
    
    if (this.onConfigUpdate) {
      await this.onConfigUpdate(this.config, oldConfig);
    }
    
    // Re-render with new config
    await this.render();
  }

  /**
   * Error Handling
   */
  
  handleError(error, context = '') {
    console.error(`Widget ${this.id} error ${context}:`, error);
    
    if (this.onError) {
      this.onError(error, context);
    } else {
      // Default error display
      this.setState({ 
        error: { message: error.message, context, timestamp: Date.now() } 
      });
    }
  }

  /**
   * Template Methods
   * Override in subclasses
   */
  
  defaultTemplate() {
    return `
      <div class="widget-content">
        <div class="widget-header">
          <h3>${this.config.title || 'Smart Widget'}</h3>
        </div>
        <div class="widget-body">
          ${this.state.error ? this.errorTemplate(this.state.error) : ''}
          <p>Widget ${this.id} loaded</p>
          <pre>${JSON.stringify(this.state, null, 2)}</pre>
        </div>
      </div>
    `;
  }

  errorTemplate(error) {
    return `
      <div class="widget-error">
        <strong>Error:</strong> ${error.message || error}
        ${error.context ? `<br><small>Context: ${error.context}</small>` : ''}
      </div>
    `;
  }

  /**
   * Cleanup and Destruction
   */
  
  async destroy() {
    if (this.isDestroyed) return;
    
    try {
      // Call user-defined cleanup
      if (this.onDestroy) {
        await this.onDestroy();
      }
      
      // Clear all intervals
      this.intervals.forEach(intervalId => clearInterval(intervalId));
      this.intervals.clear();
      
      // Unsubscribe from events
      this.subscriptions.forEach(event => {
        if (this.runtime && this.runtime.unlisten) {
          this.runtime.unlisten(event);
        }
      });
      this.subscriptions.clear();
      
      // Close API connections
      if (this.apiConnections) {
        this.apiConnections.forEach(async (connection, name) => {
          if (connection.close) {
            await connection.close();
          }
        });
        this.apiConnections.clear();
      }
      
      // Remove from DOM
      if (this.element && this.element.parentNode) {
        this.element.parentNode.removeChild(this.element);
      }
      
      this.isDestroyed = true;
      console.log(`Widget ${this.id} destroyed`);
      
    } catch (error) {
      console.error(`Widget ${this.id} destruction failed:`, error);
    }
  }

  /**
   * Lifecycle Hooks (Override in subclasses)
   * These provide extension points that will remain stable across phases
   */
  
  // async onInit() { /* Override */ }
  // async onMount() { /* Override */ }
  // async onRender(state, config) { /* Override */ }
  // async onPostRender() { /* Override */ }
  // async onUpdate() { /* Override */ }
  // onStateChange(newState, oldState) { /* Override */ }
  // async onConfigUpdate(newConfig, oldConfig) { /* Override */ }
  // onError(error, context) { /* Override */ }
  // async onDestroy() { /* Override */ }
}

// Export for global use
window.SmartWidget = SmartWidget;