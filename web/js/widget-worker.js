/**
 * Widget Web Worker Runtime - Phase 2
 * True isolation for widget execution with secure messaging
 */

// Worker global state
let widget = null;
let widgetContext = null;
let updateInterval = null;

// Secure message handler
self.addEventListener('message', function(event) {
  const { type, data, id } = event.data;
  
  try {
    switch (type) {
      case 'deploy':
        deployWidget(data, id);
        break;
      case 'call':
        callWidgetMethod(data.method, data.args, id);
        break;
      case 'setState':
        updateWidgetState(data.state, id);
        break;
      case 'destroy':
        destroyWidget(id);
        break;
      default:
        postMessage({
          type: 'error',
          id,
          error: `Unknown message type: ${type}`
        });
    }
  } catch (error) {
    postMessage({
      type: 'error',
      id,
      error: error.message,
      stack: error.stack
    });
  }
});

function deployWidget(widgetData, messageId) {
  try {
    const { code, config, state } = widgetData;
    
    // Create secure widget context
    widgetContext = createWidgetContext(config, state);
    
    // Execute widget code in controlled environment
    const widgetFactory = executeWidgetCode(code, widgetContext);
    
    // Initialize widget instance
    widget = typeof widgetFactory === 'function' ? new widgetFactory() : widgetFactory;
    
    // Set up lifecycle
    setupWidgetLifecycle(config);
    
    postMessage({
      type: 'deployed',
      id: messageId,
      success: true
    });
    
    // Call init if it exists
    if (widget && typeof widget.init === 'function') {
      widget.init();
      
      postMessage({
        type: 'lifecycle',
        event: 'init',
        success: true
      });
    }
    
  } catch (error) {
    postMessage({
      type: 'deployed',
      id: messageId,
      success: false,
      error: error.message
    });
  }
}

function createWidgetContext(config, initialState) {
  const context = {
    // Widget state management
    state: initialState || {},
    setState: function(newState) {
      Object.assign(context.state, newState);
      postMessage({
        type: 'stateUpdate',
        state: context.state
      });
    },
    
    // Secure API interface - all calls go through main thread
    api: createAPIProxy(config.apis || []),
    
    // Utility functions
    utils: {
      formatDate: function(date) {
        return new Date(date).toLocaleDateString();
      },
      formatNumber: function(num) {
        return Number(num).toLocaleString();
      },
      // Add more utilities as needed
      uuid: function() {
        return 'widget-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      }
    },
    
    // Secure console (logs go to main thread)
    console: {
      log: function(...args) {
        postMessage({
          type: 'console',
          level: 'log',
          args: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg))
        });
      },
      error: function(...args) {
        postMessage({
          type: 'console',
          level: 'error',
          args: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg))
        });
      },
      warn: function(...args) {
        postMessage({
          type: 'console',
          level: 'warn',
          args: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg))
        });
      }
    },
    
    // No direct DOM access in worker - UI updates go through messages
    createUI: function(uiData) {
      postMessage({
        type: 'uiUpdate',
        ui: uiData
      });
    }
  };
  
  return context;
}

function createAPIProxy(allowedAPIs) {
  return {
    async fetch(endpoint, options = {}) {
      if (!allowedAPIs.includes('fetch')) {
        throw new Error('fetch API not allowed for this widget');
      }
      
      // Send API request to main thread for proxy handling
      const response = await sendMessageAndWait('apiCall', {
        type: 'fetch',
        endpoint,
        options
      });
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      return response.data;
    },
    
    async weather(city = 'Cannes') {
      if (!allowedAPIs.includes('weather')) {
        throw new Error('weather API not allowed for this widget');
      }
      
      const response = await sendMessageAndWait('apiCall', {
        type: 'weather',
        city
      });
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      return response.data;
    },
    
    // Standard Notes API integration
    standardNotes: {
      async authenticate(email, password, server = null) {
        if (!allowedAPIs.includes('standard-notes')) {
          throw new Error('Standard Notes API not allowed for this widget');
        }
        
        const response = await sendMessageAndWait('apiCall', {
          type: 'standard-notes',
          action: 'auth',
          data: { email, password, server }
        });
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        return response.data;
      },
      
      async listNotes(sessionId, options = {}) {
        if (!allowedAPIs.includes('standard-notes')) {
          throw new Error('Standard Notes API not allowed for this widget');
        }
        
        const response = await sendMessageAndWait('apiCall', {
          type: 'standard-notes',
          action: 'notes',
          sessionId,
          data: options
        });
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        return response.data;
      },
      
      async getNote(sessionId, noteId) {
        if (!allowedAPIs.includes('standard-notes')) {
          throw new Error('Standard Notes API not allowed for this widget');
        }
        
        const response = await sendMessageAndWait('apiCall', {
          type: 'standard-notes',
          action: 'note',
          sessionId,
          data: { id: noteId }
        });
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        return response.data;
      },
      
      async createNote(sessionId, title, content, tags = []) {
        if (!allowedAPIs.includes('standard-notes')) {
          throw new Error('Standard Notes API not allowed for this widget');
        }
        
        const response = await sendMessageAndWait('apiCall', {
          type: 'standard-notes',
          action: 'notes',
          sessionId,
          data: { title, content, tags }
        });
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        return response.data;
      },
      
      async updateNote(sessionId, noteId, updates) {
        if (!allowedAPIs.includes('standard-notes')) {
          throw new Error('Standard Notes API not allowed for this widget');
        }
        
        const response = await sendMessageAndWait('apiCall', {
          type: 'standard-notes',
          action: 'note',
          sessionId,
          data: { id: noteId, updates }
        });
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        return response.data;
      },
      
      async deleteNote(sessionId, noteId) {
        if (!allowedAPIs.includes('standard-notes')) {
          throw new Error('Standard Notes API not allowed for this widget');
        }
        
        const response = await sendMessageAndWait('apiCall', {
          type: 'standard-notes',
          action: 'note',
          sessionId,
          data: { id: noteId, delete: true }
        });
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        return response.data;
      },
      
      async searchNotes(sessionId, query) {
        if (!allowedAPIs.includes('standard-notes')) {
          throw new Error('Standard Notes API not allowed for this widget');
        }
        
        const response = await sendMessageAndWait('apiCall', {
          type: 'standard-notes',
          action: 'search',
          sessionId,
          data: { query }
        });
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        return response.data;
      },
      
      async logout(sessionId) {
        if (!allowedAPIs.includes('standard-notes')) {
          throw new Error('Standard Notes API not allowed for this widget');
        }
        
        const response = await sendMessageAndWait('apiCall', {
          type: 'standard-notes',
          action: 'logout',
          sessionId
        });
        
        if (response.error) {
          throw new Error(response.error);
        }
        
        return response.data;
      }
    }
    
    // More API endpoints can be added here
  };
}

function executeWidgetCode(code, context) {
  // Create function with controlled scope - only allowed globals
  const allowedGlobals = Object.keys(context);
  const values = allowedGlobals.map(key => context[key]);
  
  // Add minimal safe globals
  const safeGlobals = {
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    setTimeout: (fn, delay) => {
      // Limited setTimeout - max 30 seconds
      delay = Math.min(delay || 0, 30000);
      return setTimeout(fn, delay);
    },
    clearTimeout,
    setInterval: (fn, delay) => {
      // Limited setInterval - max frequency 100ms
      delay = Math.max(delay || 100, 100);
      return setInterval(fn, delay);
    },
    clearInterval
  };
  
  const allGlobals = [...allowedGlobals, ...Object.keys(safeGlobals)];
  const allValues = [...values, ...Object.values(safeGlobals)];
  
  try {
    // Execute in strict mode with controlled globals
    const fn = new Function(...allGlobals, `
      "use strict";
      ${code}
    `);
    
    return fn.apply(null, allValues);
    
  } catch (error) {
    throw new Error(`Widget execution error: ${error.message}`);
  }
}

function setupWidgetLifecycle(config) {
  // Set up auto-updates if configured
  if (config.updateInterval && widget && typeof widget.update === 'function') {
    // Minimum 1 second intervals
    const interval = Math.max(config.updateInterval, 1000);
    
    updateInterval = setInterval(() => {
      try {
        widget.update();
      } catch (error) {
        postMessage({
          type: 'console',
          level: 'error',
          args: ['Widget update error:', error.message]
        });
      }
    }, interval);
  }
}

function callWidgetMethod(method, args, messageId) {
  try {
    if (!widget || typeof widget[method] !== 'function') {
      throw new Error(`Widget method '${method}' not found`);
    }
    
    const result = widget[method].apply(widget, args || []);
    
    postMessage({
      type: 'methodResult',
      id: messageId,
      result
    });
    
  } catch (error) {
    postMessage({
      type: 'methodResult',
      id: messageId,
      error: error.message
    });
  }
}

function updateWidgetState(newState, messageId) {
  if (widgetContext) {
    Object.assign(widgetContext.state, newState);
    
    // Trigger render if available
    if (widget && typeof widget.render === 'function') {
      try {
        widget.render();
      } catch (error) {
        postMessage({
          type: 'console',
          level: 'error',
          args: ['Widget render error:', error.message]
        });
      }
    }
  }
  
  postMessage({
    type: 'stateUpdated',
    id: messageId,
    success: true
  });
}

function destroyWidget(messageId) {
  try {
    // Clear any intervals
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
    
    // Call widget destroy if available
    if (widget && typeof widget.destroy === 'function') {
      widget.destroy();
    }
    
    // Clean up
    widget = null;
    widgetContext = null;
    
    postMessage({
      type: 'destroyed',
      id: messageId,
      success: true
    });
    
  } catch (error) {
    postMessage({
      type: 'destroyed',
      id: messageId,
      success: false,
      error: error.message
    });
  }
}

// Helper function to send message and wait for response
function sendMessageAndWait(type, data) {
  return new Promise((resolve) => {
    const messageId = 'req-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    
    const handler = function(event) {
      if (event.data.type === 'apiResponse' && event.data.id === messageId) {
        self.removeEventListener('message', handler);
        resolve(event.data);
      }
    };
    
    self.addEventListener('message', handler);
    
    postMessage({
      type,
      id: messageId,
      data
    });
    
    // Timeout after 10 seconds
    setTimeout(() => {
      self.removeEventListener('message', handler);
      resolve({ error: 'API call timeout' });
    }, 10000);
  });
}

// Worker ready signal
postMessage({
  type: 'ready',
  timestamp: Date.now()
});