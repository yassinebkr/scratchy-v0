/**
 * Canvas 2.0 Integration Layer
 * Extends existing Canvas system with smart widget support
 * Maintains backward compatibility with all existing components
 */

(function() {
  'use strict';

  // Global widget runtime instance
  let widgetRuntime = null;
  let widgetScriptsLoaded = false;

  /**
   * Load widget runtime scripts dynamically
   */
  async function loadWidgetRuntime() {
    if (widgetScriptsLoaded) return;
    
    const scripts = [
      '/js/runtime/supporting.js',
      '/js/runtime/SmartWidget.js', 
      '/js/runtime/WidgetRuntime.js'
    ];
    
    for (const script of scripts) {
      await loadScript(script);
    }
    
    widgetScriptsLoaded = true;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  /**
   * Initialize Canvas 2.0 Widget Runtime
   */
  async function initWidgetRuntime() {
    if (!widgetRuntime) {
      await loadWidgetRuntime();
      
      widgetRuntime = new WidgetRuntime('canvas-stream', {
        apiConfig: {
          rateLimit: 100, // per minute per widget
          timeout: 30000,
          allowedAPIs: ['openweather', 'github'], // Expand as needed
        },
        security: {
          maxCodeSize: 100000,
          blockedPatterns: [
            /eval\s*\(/,
            /Function\s*\(/,
            /document\.write/,
            /innerHTML\s*=/,
            /location\./,
            /window\./
          ]
        },
        storage: 'localStorage',
        resources: {
          maxMemoryMB: 50,
          maxCPUPercent: 10
        }
      });
      
      console.log('Canvas 2.0 Widget Runtime initialized');
    }
    
    return widgetRuntime;
  }

  /**
   * Extended Canvas Renderer with Smart Widget Support
   * Wraps existing renderer to add smart widget capabilities
   */
  function extendCanvasRenderer() {
    if (!window.CanvasRenderer) {
      console.error('CanvasRenderer not found - integration failed');
      return;
    }

    const originalRenderComponentHtml = CanvasRenderer.prototype._renderComponentHtml;
    
    // Override the component rendering method
    CanvasRenderer.prototype._renderComponentHtml = async function(data) {
      // Handle smart widgets
      if (data.component === 'smart-widget') {
        return await renderSmartWidget(data, this);
      }
      
      // Handle legacy components with original renderer
      return originalRenderComponentHtml.call(this, data);
    };

    // Override component creation to handle async smart widgets
    const originalCreateComponentEl = CanvasRenderer.prototype._createComponentEl;
    
    CanvasRenderer.prototype._createComponentEl = function(comp) {
      if (comp.type === 'smart-widget') {
        return createSmartWidgetElement(comp, this);
      }
      
      return originalCreateComponentEl.call(this, comp);
    };

    console.log('Canvas renderer extended with smart widget support');
  }

  /**
   * Render smart widget component
   */
  async function renderSmartWidget(data, renderer) {
    const widgetId = data.id || `widget-${Date.now()}`;
    
    try {
      // Ensure runtime is initialized
      const runtime = await initWidgetRuntime();
      
      // Create widget container
      const containerId = `smart-widget-${widgetId}`;
      
      // Deploy widget to runtime
      await runtime.deployWidget({
        id: widgetId,
        type: 'smart-widget',
        code: data.code || data.widget_code || '',
        config: data.config || {},
        apis: data.apis || []
      });
      
      return `
        <div id="${containerId}" class="smart-widget-container" data-widget-id="${widgetId}">
          <div class="smart-widget-loading">
            <div class="loading-spinner"></div>
            <span>Loading smart widget...</span>
          </div>
        </div>
      `;
      
    } catch (error) {
      console.error('Smart widget render error:', error);
      return `
        <div class="smart-widget-error">
          <h4>Smart Widget Error</h4>
          <p>${error.message}</p>
          <details>
            <summary>Debug Info</summary>
            <pre>${JSON.stringify(data, null, 2)}</pre>
          </details>
        </div>
      `;
    }
  }

  /**
   * Create smart widget DOM element with async loading
   */
  function createSmartWidgetElement(comp, renderer) {
    const size = renderer._getSize(comp.type);
    const el = document.createElement('div');
    
    el.className = 'block-component smart-widget-block';
    if (size === 'wide' || size === 'full') {
      el.className += ' break-row';
    }
    
    el.dataset.componentId = comp.id;
    el.dataset.type = comp.type;
    el.dataset.size = size;
    
    // Async render the smart widget
    renderSmartWidget(comp.data, renderer).then(html => {
      safeHTML(el, html);
      
      // Post-render setup
      setTimeout(() => {
        setupSmartWidgetIntegration(comp.id, el);
      }, 100);
    }).catch(error => {
      console.error('Smart widget creation failed:', error);
      el.innerHTML = `
        <div class="smart-widget-error">
          <p>Failed to load smart widget: ${error.message}</p>
        </div>
      `;
    });
    
    // Show loading state initially
    el.innerHTML = `
      <div class="smart-widget-loading">
        <div class="loading-spinner"></div>
        <span>Initializing smart widget...</span>
      </div>
    `;
    
    // Track for upsert
    if (comp.id) {
      renderer._componentElements[comp.id] = el;
    }
    
    return el;
  }

  /**
   * Setup integration between smart widget and canvas system
   */
  function setupSmartWidgetIntegration(widgetId, element) {
    if (!widgetRuntime) return;
    
    const widget = widgetRuntime.widgets.get(widgetId);
    if (!widget) return;
    
    // Listen for widget events and relay to canvas system
    widget.runtime.listen('widget:*', (data, event) => {
      // Handle widget-to-canvas communication
      handleWidgetCanvasEvent(widgetId, event, data);
    });
    
    // Setup widget resize observer for responsive layouts
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (widget.onResize) {
            widget.onResize(entry.contentRect);
          }
        }
      });
      
      resizeObserver.observe(element);
    }
  }

  /**
   * Handle communication between widgets and canvas system
   */
  function handleWidgetCanvasEvent(widgetId, event, data) {
    // Examples of widget-to-canvas integration
    switch (event.event) {
      case 'widget:resize':
        // Handle widget requesting size change
        updateWidgetSize(widgetId, data.size);
        break;
        
      case 'widget:navigate':
        // Handle widget requesting navigation
        if (data.url) {
          window.location.href = data.url;
        }
        break;
        
      case 'widget:notify':
        // Handle widget requesting notification
        showNotification(data.message, data.type);
        break;
        
      case 'widget:data':
        // Handle widget sharing data with other widgets
        broadcastWidgetData(widgetId, data);
        break;
        
      default:
        console.log('Unhandled widget event:', event, data);
    }
  }

  /**
   * Utility functions for widget-canvas integration
   */
  function updateWidgetSize(widgetId, size) {
    const element = document.querySelector(`[data-widget-id="${widgetId}"]`);
    if (element) {
      element.dataset.size = size;
      // Trigger layout recalculation if needed
    }
  }

  function showNotification(message, type = 'info') {
    // Integrate with existing notification system or create simple one
    console.log(`Widget notification [${type}]:`, message);
    
    // TODO: Integrate with existing canvas notification system
    // For now, just console log
  }

  function broadcastWidgetData(fromWidgetId, data) {
    if (!widgetRuntime) return;
    
    // Broadcast to all other widgets
    widgetRuntime.widgets.forEach((widget, widgetId) => {
      if (widgetId !== fromWidgetId && widget.runtime.emit) {
        widget.runtime.emit('external:data', { from: fromWidgetId, data });
      }
    });
  }

  /**
   * Enhanced canvas state handling for smart widgets
   */
  function extendCanvasState() {
    if (!window.CanvasState) {
      console.error('CanvasState not found - integration failed');
      return;
    }

    const originalApply = CanvasState.prototype.apply;
    
    CanvasState.prototype.apply = function(op) {
      // Handle smart widget operations
      if (op.type === 'smart-widget') {
        return handleSmartWidgetOperation.call(this, op);
      }
      
      // Handle regular operations
      return originalApply.call(this, op);
    };
  }

  /**
   * Handle smart widget specific operations
   */
  function handleSmartWidgetOperation(op) {
    const { id, data } = op;
    
    switch (op.op) {
      case 'upsert':
        // Store widget configuration in state
        const existing = this.components[id];
        const now = Date.now();
        
        this.components[id] = {
          id,
          type: 'smart-widget',
          data: { ...data },
          layout: op.layout || { zone: 'auto', order: 0 },
          createdAt: existing?.createdAt || now,
          updatedAt: now
        };
        
        this._notify('upsert', this.components[id]);
        return true;
        
      case 'patch':
        if (this.components[id]) {
          this.components[id].data = { 
            ...this.components[id].data, 
            ...data 
          };
          this.components[id].updatedAt = Date.now();
          
          // Update the running widget
          if (widgetRuntime) {
            widgetRuntime.updateWidget(id, { state: data });
          }
          
          this._notify('patch', this.components[id]);
          return true;
        }
        break;
        
      case 'remove':
        if (this.components[id]) {
          // Destroy the widget
          if (widgetRuntime) {
            widgetRuntime.destroyWidget(id);
          }
          
          delete this.components[id];
          this._notify('remove', { id });
          return true;
        }
        break;
    }
    
    return false;
  }

  /**
   * Initialize Canvas 2.0 integration when DOM is ready
   */
  function initIntegration() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initIntegration);
      return;
    }
    
    try {
      // Extend existing systems
      extendCanvasRenderer();
      extendCanvasState();
      
      console.log('Canvas 2.0 integration initialized');
      
      // Pre-load widget runtime for faster first widget deployment
      setTimeout(initWidgetRuntime, 1000);
      
    } catch (error) {
      console.error('Canvas 2.0 integration failed:', error);
    }
  }

  // Initialize when script loads
  initIntegration();

  // Export for debugging
  window.Canvas2Integration = {
    getWidgetRuntime: () => widgetRuntime,
    initWidgetRuntime,
    renderSmartWidget
  };

})();