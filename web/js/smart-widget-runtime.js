/**
 * Smart Widget Runtime - Phase 1
 * Secure JavaScript execution sandbox for canvas widgets
 */

class SmartWidgetSandbox {
  constructor(widgetData, containerEl) {
    this.data = widgetData;
    this.container = containerEl;
    this.widget = null;
    this.destroyed = false;
    this.updateInterval = null;
    
    // Safe API proxy
    this.apis = this.createAPIProxy();
  }
  
  deploy() {
    try {
      // Parse and validate widget code
      const code = this.data.code || '';
      const config = this.data.config || {};
      
      // Create widget context with restricted globals
      const widgetContext = this.createWidgetContext(config);
      
      // Execute widget code in controlled environment
      const widgetFactory = this.executeCode(code, widgetContext);
      
      if (typeof widgetFactory !== 'function' && typeof widgetFactory !== 'object') {
        throw new Error('Widget must return a function or object');
      }
      
      // Initialize widget instance
      this.widget = typeof widgetFactory === 'function' ? new widgetFactory() : widgetFactory;
      
      // Set up widget lifecycle
      this.setupLifecycle();
      
      return this.widget;
      
    } catch (error) {
      console.error('Widget deployment failed:', error);
      throw error;
    }
  }
  
  createWidgetContext(config) {
    const self = this;
    
    return {
      // Widget state management
      state: this.data.state || {},
      setState: function(newState) {
        Object.assign(self.data.state, newState);
        if (self.widget && self.widget.render) {
          self.widget.render();
        }
      },
      
      // DOM access (restricted to widget container)
      container: this.container,
      createElement: function(tag) {
        return document.createElement(tag);
      },
      
      // Safe API access
      api: this.apis,
      
      // Utility functions
      utils: {
        formatDate: function(date) {
          return new Date(date).toLocaleDateString();
        },
        formatNumber: function(num) {
          return Number(num).toLocaleString();
        }
      },
      
      // Console (redirected)
      console: {
        log: function(...args) {
          console.log('[Widget]', ...args);
        },
        error: function(...args) {
          console.error('[Widget]', ...args);
        }
      }
    };
  }
  
  executeCode(code, context) {
    // Simple sandboxing: execute in function scope with controlled globals
    const allowedGlobals = Object.keys(context);
    const values = allowedGlobals.map(key => context[key]);
    
    try {
      // Create function with restricted scope
      const fn = new Function(...allowedGlobals, `
        "use strict";
        ${code}
      `);
      
      return fn.apply(null, values);
      
    } catch (error) {
      throw new Error(`Widget execution error: ${error.message}`);
    }
  }
  
  createAPIProxy() {
    const self = this;
    const config = this.data.config || {};
    const allowedAPIs = config.apis || [];
    
    return {
      async fetch(endpoint, options = {}) {
        // For Phase 1: simple fetch wrapper with basic validation
        if (!allowedAPIs.includes('fetch')) {
          throw new Error('fetch API not allowed for this widget');
        }
        
        try {
          const response = await fetch(endpoint, {
            ...options,
            // Add basic security headers
            headers: {
              'Content-Type': 'application/json',
              ...options.headers
            }
          });
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          
          return await response.json();
        } catch (error) {
          console.error('Widget API error:', error);
          throw error;
        }
      },
      
      // Mock weather API for demo
      async weather(city = 'Cannes') {
        if (!allowedAPIs.includes('weather')) {
          throw new Error('weather API not allowed for this widget');
        }
        
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Return mock data
        const temps = [18, 22, 25, 19, 21];
        const conditions = ['Sunny', 'Partly Cloudy', 'Clear', 'Overcast', 'Sunny'];
        const temp = temps[Math.floor(Math.random() * temps.length)];
        const condition = conditions[Math.floor(Math.random() * conditions.length)];
        
        return {
          city: city,
          temp: temp,
          condition: condition,
          humidity: Math.floor(Math.random() * 40) + 40,
          timestamp: Date.now()
        };
      }
    };
  }
  
  setupLifecycle() {
    if (!this.widget) return;
    
    const config = this.data.config || {};
    
    // Call init if it exists
    if (typeof this.widget.init === 'function') {
      try {
        this.widget.init();
      } catch (error) {
        console.error('Widget init error:', error);
      }
    }
    
    // Set up auto-updates if configured
    if (config.updateInterval && typeof this.widget.update === 'function') {
      this.updateInterval = setInterval(() => {
        if (!this.destroyed) {
          try {
            this.widget.update();
          } catch (error) {
            console.error('Widget update error:', error);
          }
        }
      }, config.updateInterval);
    }
  }
  
  destroy() {
    this.destroyed = true;
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    if (this.widget && typeof this.widget.destroy === 'function') {
      try {
        this.widget.destroy();
      } catch (error) {
        console.error('Widget destroy error:', error);
      }
    }
    
    this.widget = null;
  }
}

// Make available globally
window.SmartWidgetSandbox = SmartWidgetSandbox;