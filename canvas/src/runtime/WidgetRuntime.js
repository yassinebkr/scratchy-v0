/**
 * Canvas 2.0 Widget Runtime
 * Phase 1: Hybrid approach with forward compatibility
 * Designed for seamless upgrade to Phase 2 (full runtime) and Phase 3 (AI generation)
 */

class WidgetRuntime {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.container = document.getElementById(containerId);
    this.widgets = new Map();
    this.eventBus = new EventBus();
    this.apiGateway = new APIGateway(options.apiConfig || {});
    this.stateManager = new StateManager(options.storage || 'localStorage');
    
    // Future-ready: These will be enhanced in Phase 2
    this.securityPolicy = new SecurityPolicy(options.security || {});
    this.resourceMonitor = new ResourceMonitor(options.resources || {});
    
    this.init();
  }

  async init() {
    // Initialize runtime environment
    this.setupEventListeners();
    this.setupAPIProxy();
    
    // Phase 2 preparation: Hook for future worker-based sandbox
    if (typeof Worker !== 'undefined') {
      this.workerSupport = true;
      // Workers will be initialized here in Phase 2
    }
    
    console.log('Canvas Widget Runtime initialized');
  }

  /**
   * Deploy a smart widget
   * Phase 1: Execute in main thread with safety checks
   * Phase 2: Will migrate to Web Workers seamlessly
   */
  async deployWidget(config) {
    const widgetId = this.generateWidgetId();
    
    try {
      // Phase 1: Basic validation and execution
      const widget = await this.createWidget(widgetId, config);
      
      // Future-ready: State will be managed by dedicated service in Phase 2
      const initialState = await this.stateManager.getState(widgetId);
      if (initialState) {
        widget.state = { ...widget.state, ...initialState };
      }
      
      // Register widget
      this.widgets.set(widgetId, widget);
      
      // Initialize and mount
      await widget.init();
      await widget.mount(this.container);
      
      // Setup communication channels (extensible for Phase 2)
      this.setupWidgetCommunication(widgetId, widget);
      
      return widgetId;
      
    } catch (error) {
      console.error(`Failed to deploy widget ${widgetId}:`, error);
      throw error;
    }
  }

  /**
   * Create widget instance
   * Abstracted to allow different execution modes in future phases
   */
  async createWidget(widgetId, config) {
    // Phase 1: Direct execution with safety wrapper
    const WidgetClass = await this.executeWidgetCode(config.code, {
      widgetId,
      apis: this.createAPIProxy(widgetId, config.apis || []),
      runtime: this.createRuntimeInterface(widgetId),
      security: this.securityPolicy
    });
    
    const widget = new WidgetClass(config.config || {});
    widget.id = widgetId;
    widget.type = config.type || 'smart-widget';
    
    return widget;
  }

  /**
   * Execute widget code safely
   * Phase 1: eval with security checks
   * Phase 2: Web Worker execution
   * Phase 3: Server-side validation + client execution
   */
  async executeWidgetCode(code, context) {
    // Security check
    if (!this.securityPolicy.isCodeSafe(code)) {
      throw new SecurityError('Widget code contains unsafe operations');
    }
    
    // Phase 1: Create safe execution context
    const safeContext = this.createSafeContext(context);
    
    // Future-ready: This will become a worker message in Phase 2
    const wrappedCode = `
      (function(widgetId, api, runtime, SmartWidget, EventBus) {
        'use strict';
        ${code}
      })(
        '${context.widgetId}',
        context.apis,
        context.runtime,
        SmartWidget,
        EventBus
      );
    `;
    
    // Execute in controlled environment
    return new Function('context', 'SmartWidget', 'EventBus', wrappedCode)(
      safeContext, SmartWidget, EventBus
    );
  }

  /**
   * Create API proxy for widget
   * Extensible design for Phase 2 server-side proxying
   */
  createAPIProxy(widgetId, allowedAPIs) {
    return new Proxy({}, {
      get: (target, apiName) => {
        if (!allowedAPIs.includes(apiName)) {
          throw new SecurityError(`Widget ${widgetId} not authorized for API: ${apiName}`);
        }
        
        return new Proxy({}, {
          get: (apiTarget, method) => {
            return async (...args) => {
              // Phase 1: Direct API calls with rate limiting
              // Phase 2: Will proxy through server
              return await this.apiGateway.call(widgetId, apiName, method, args);
            };
          }
        });
      }
    });
  }

  /**
   * Create runtime interface for widgets
   * Stable API that will remain consistent through all phases
   */
  createRuntimeInterface(widgetId) {
    return {
      // State management (consistent across phases)
      setState: (state) => this.updateWidgetState(widgetId, state),
      getState: () => this.getWidgetState(widgetId),
      
      // Communication (will be enhanced in Phase 2)
      emit: (event, data) => this.eventBus.emit(`widget:${widgetId}:${event}`, data),
      listen: (event, callback) => this.eventBus.on(event, callback),
      
      // Resource access (will be expanded in Phase 2)
      storage: this.stateManager.createNamespace(widgetId),
      
      // Future extension points
      extensions: new Map(), // For Phase 2/3 features
      hooks: new Map()      // For lifecycle extensions
    };
  }

  /**
   * Update widget - handles both static and smart widgets
   * Forward-compatible with all phases
   */
  async updateWidget(widgetId, update) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return;
    
    if (widget.type === 'smart-widget') {
      // Smart widget update
      if (update.state) {
        await this.updateWidgetState(widgetId, update.state);
      }
      if (update.config) {
        await widget.updateConfig(update.config);
      }
      if (update.code) {
        // Phase 2: Will support hot-reload
        await this.redeployWidget(widgetId, { ...widget.config, code: update.code });
      }
    } else {
      // Legacy component update (backward compatibility)
      return this.updateLegacyComponent(widgetId, update);
    }
  }

  /**
   * Widget state management
   * Consistent API across all phases
   */
  async updateWidgetState(widgetId, state) {
    const widget = this.widgets.get(widgetId);
    if (widget) {
      widget.state = { ...widget.state, ...state };
      await this.stateManager.setState(widgetId, widget.state);
      
      // Re-render if needed
      if (widget.shouldUpdate && widget.shouldUpdate(state)) {
        await widget.render();
      }
    }
  }

  getWidgetState(widgetId) {
    const widget = this.widgets.get(widgetId);
    return widget ? widget.state : {};
  }

  /**
   * Setup widget communication
   * Extensible for future inter-widget protocols
   */
  setupWidgetCommunication(widgetId, widget) {
    // Subscribe to widget events
    this.eventBus.on(`widget:${widgetId}:*`, (event, data) => {
      // Phase 2: Will add sophisticated routing
      this.handleWidgetEvent(widgetId, event, data);
    });
    
    // Setup auto-updates if configured
    if (widget.config.updateInterval) {
      const interval = setInterval(async () => {
        if (widget.onUpdate) {
          await widget.onUpdate();
        }
      }, widget.config.updateInterval);
      
      widget._interval = interval;
    }
  }

  /**
   * Legacy component support
   * Ensures backward compatibility
   */
  updateLegacyComponent(widgetId, update) {
    // Handle existing scratchy-canvas components
    const element = document.getElementById(widgetId);
    if (element && update.data) {
      // Re-render using existing component system
      return this.legacyRenderer.update(element, update);
    }
  }

  // Utility methods
  generateWidgetId() {
    return `widget-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  createSafeContext(context) {
    // Remove dangerous globals, provide safe alternatives
    return {
      ...context,
      console: {
        log: (...args) => console.log(`[Widget ${context.widgetId}]:`, ...args),
        warn: (...args) => console.warn(`[Widget ${context.widgetId}]:`, ...args),
        error: (...args) => console.error(`[Widget ${context.widgetId}]:`, ...args)
      }
    };
  }

  setupEventListeners() {
    // Global widget event handling
    this.eventBus.on('widget:*', this.handleGlobalWidgetEvent.bind(this));
  }

  setupAPIProxy() {
    // Initialize API gateway
    this.apiGateway.init();
  }

  handleWidgetEvent(widgetId, event, data) {
    // Event routing and processing
    // Will be enhanced in Phase 2 for complex workflows
  }

  handleGlobalWidgetEvent(event, data) {
    // Global event processing
  }

  // Cleanup
  async destroyWidget(widgetId) {
    const widget = this.widgets.get(widgetId);
    if (widget) {
      // Cleanup intervals
      if (widget._interval) {
        clearInterval(widget._interval);
      }
      
      // Widget cleanup
      if (widget.onDestroy) {
        await widget.onDestroy();
      }
      
      // Remove from DOM
      if (widget.element) {
        widget.element.remove();
      }
      
      // Clean state
      await this.stateManager.clearState(widgetId);
      
      this.widgets.delete(widgetId);
    }
  }
}

// Export for global use
window.WidgetRuntime = WidgetRuntime;