/**
 * Web Worker Runtime Manager - Phase 2
 * Manages isolated widget execution in Web Workers
 */

class WebWorkerRuntime {
  constructor(widgetData, containerEl) {
    this.data = widgetData;
    this.container = containerEl;
    this.worker = null;
    this.destroyed = false;
    this.messageId = 0;
    this.pendingMessages = new Map();
    
    // Create UI proxy for worker
    this.uiProxy = this.createUIProxy();
  }
  
  async deploy() {
    try {
      // Check if Web Workers are supported
      if (!window.Worker) {
        throw new Error('Web Workers not supported - falling back to basic sandbox');
      }
      
      // Create dedicated worker for this widget
      this.worker = new Worker('/js/widget-worker.js');
      
      // Set up message handling
      this.setupMessageHandling();
      
      // Wait for worker to be ready
      await this.waitForWorkerReady();
      
      // Deploy widget to worker
      const deployResult = await this.sendMessage('deploy', {
        code: this.data.code || '',
        config: this.data.config || {},
        state: this.data.state || {}
      });
      
      if (!deployResult.success) {
        throw new Error(deployResult.error || 'Widget deployment failed');
      }
      
      console.log('[WebWorker] Widget deployed successfully:', this.data.config?.size || 'default');
      return this;
      
    } catch (error) {
      console.error('[WebWorker] Deployment failed:', error);
      this.destroy();
      throw error;
    }
  }
  
  setupMessageHandling() {
    this.worker.addEventListener('message', (event) => {
      const { type, id, data } = event.data;
      
      switch (type) {
        case 'ready':
          this.handleWorkerReady();
          break;
          
        case 'deployed':
        case 'methodResult':
        case 'stateUpdated':
        case 'destroyed':
          this.handleMessageResponse(id, event.data);
          break;
          
        case 'console':
          this.handleConsoleMessage(event.data);
          break;
          
        case 'uiUpdate':
          this.handleUIUpdate(event.data.ui);
          break;
          
        case 'stateUpdate':
          this.handleStateUpdate(event.data.state);
          break;
          
        case 'apiCall':
          this.handleAPICall(id, event.data.data);
          break;
          
        case 'lifecycle':
          this.handleLifecycleEvent(event.data);
          break;
          
        case 'error':
          this.handleWorkerError(event.data);
          break;
          
        default:
          console.warn('[WebWorker] Unknown message type:', type);
      }
    });
    
    this.worker.addEventListener('error', (error) => {
      console.error('[WebWorker] Worker error:', error);
      this.handleWorkerError({ error: error.message });
    });
  }
  
  handleWorkerReady() {
    this.workerReady = true;
    if (this.workerReadyResolve) {
      this.workerReadyResolve();
    }
  }
  
  waitForWorkerReady() {
    if (this.workerReady) {
      return Promise.resolve();
    }
    
    return new Promise((resolve) => {
      this.workerReadyResolve = resolve;
      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.workerReadyResolve) {
          this.workerReadyResolve();
        }
      }, 5000);
    });
  }
  
  handleConsoleMessage({ level, args }) {
    const prefix = '[Widget]';
    switch (level) {
      case 'log':
        console.log(prefix, ...args);
        break;
      case 'error':
        console.error(prefix, ...args);
        break;
      case 'warn':
        console.warn(prefix, ...args);
        break;
      default:
        console.log(prefix, ...args);
    }
  }
  
  handleUIUpdate(uiData) {
    // Create UI elements based on worker's UI data
    if (uiData.type === 'html') {
      this.container.innerHTML = uiData.content;
    } else if (uiData.type === 'dom') {
      // Handle structured DOM updates
      this.updateContainerDOM(uiData);
    }
  }
  
  handleStateUpdate(newState) {
    // Update our local state copy and trigger persistence
    Object.assign(this.data.state, newState);
    
    // Trigger any external state change handlers
    if (this.onStateChange) {
      this.onStateChange(this.data.state);
    }
  }
  
  async handleAPICall(messageId, apiData) {
    try {
      let result;
      
      switch (apiData.type) {
        case 'fetch':
          result = await this.handleFetchAPI(apiData);
          break;
        case 'weather':
          result = await this.handleWeatherAPI(apiData);
          break;
        case 'standard-notes':
          result = await this.handleStandardNotesAPI(apiData);
          break;
        default:
          throw new Error(`Unknown API type: ${apiData.type}`);
      }
      
      this.worker.postMessage({
        type: 'apiResponse',
        id: messageId,
        data: result
      });
      
    } catch (error) {
      this.worker.postMessage({
        type: 'apiResponse',
        id: messageId,
        error: error.message
      });
    }
  }
  
  async handleFetchAPI({ endpoint, options }) {
    try {
      const response = await fetch(endpoint, {
        ...options,
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
      throw new Error(`Fetch error: ${error.message}`);
    }
  }
  
  async handleWeatherAPI({ city }) {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Return mock weather data (same as Phase 1)
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
  
  async handleStandardNotesAPI({ action, sessionId, data }) {
    try {
      const headers = {
        'Content-Type': 'application/json'
      };
      
      if (sessionId) {
        headers['X-Session-ID'] = sessionId;
      }
      
      let url = `/api/standard-notes/${action}`;
      let options = {
        method: 'GET',
        headers
      };
      
      // Handle different API actions
      switch (action) {
        case 'auth':
          options.method = 'POST';
          options.body = JSON.stringify(data);
          break;
          
        case 'notes':
          if (data && data.title) {
            // Creating a new note
            options.method = 'POST';
            options.body = JSON.stringify(data);
          } else {
            // Listing notes with optional filters
            const params = new URLSearchParams();
            if (data?.search) params.append('search', data.search);
            if (data?.tag) params.append('tag', data.tag);
            if (data?.limit) params.append('limit', data.limit);
            
            if (params.toString()) {
              url += '?' + params.toString();
            }
          }
          break;
          
        case 'note':
          const params = new URLSearchParams();
          if (data?.id) params.append('id', data.id);
          url += '?' + params.toString();
          
          if (data?.updates) {
            options.method = 'PUT';
            options.body = JSON.stringify(data.updates);
          } else if (data?.delete) {
            options.method = 'DELETE';
          }
          break;
          
        case 'search':
          if (data?.query) {
            url += '?q=' + encodeURIComponent(data.query);
          }
          break;
          
        case 'logout':
          options.method = 'POST';
          break;
      }
      
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }
      
      return await response.json();
      
    } catch (error) {
      throw new Error(`Standard Notes API error: ${error.message}`);
    }
  }
  
  handleLifecycleEvent({ event, success, error }) {
    console.log(`[WebWorker] Lifecycle event '${event}':`, success ? 'success' : 'failed', error || '');
  }
  
  handleWorkerError({ error, stack }) {
    console.error('[WebWorker] Widget error:', error);
    if (stack) {
      console.error('[WebWorker] Stack trace:', stack);
    }
    
    // Show error in container
    this.container.innerHTML = `
      <div style="padding: 16px; background: rgba(239,68,68,0.1); border: 1px solid #ef4444; border-radius: 6px; color: #ef4444;">
        <div style="font-weight: bold; margin-bottom: 4px;">Widget Error (Web Worker)</div>
        <div style="font-size: 0.9rem;">${error}</div>
      </div>
    `;
  }
  
  handleMessageResponse(messageId, response) {
    const resolver = this.pendingMessages.get(messageId);
    if (resolver) {
      this.pendingMessages.delete(messageId);
      resolver(response);
    }
  }
  
  sendMessage(type, data) {
    return new Promise((resolve) => {
      const id = `msg-${++this.messageId}`;
      this.pendingMessages.set(id, resolve);
      
      this.worker.postMessage({
        type,
        id,
        data
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id);
          resolve({ success: false, error: 'Message timeout' });
        }
      }, 10000);
    });
  }
  
  createUIProxy() {
    const self = this;
    
    return {
      // For widgets that need DOM-like interface
      createElement: function(tag) {
        // Return a proxy object that builds UI data
        return {
          tagName: tag.toUpperCase(),
          style: {},
          textContent: '',
          innerHTML: '',
          children: [],
          
          appendChild: function(child) {
            this.children.push(child);
          },
          
          addEventListener: function(event, handler) {
            // Store event handlers to be recreated in main thread
            if (!this.events) this.events = {};
            this.events[event] = handler.toString();
          },
          
          // Trigger UI update when widget modifies elements
          _updateUI: function() {
            self.handleUIUpdate({
              type: 'dom',
              elements: [this]
            });
          }
        };
      }
    };
  }
  
  updateContainerDOM(uiData) {
    // Convert worker UI data back to real DOM elements
    if (uiData.elements) {
      // Simple implementation for now
      this.container.innerHTML = this.renderUIElements(uiData.elements);
    }
  }
  
  renderUIElements(elements) {
    return elements.map(el => {
      const styles = Object.entries(el.style || {})
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ');
      
      const attrs = styles ? ` style="${styles}"` : '';
      const content = el.innerHTML || el.textContent || '';
      
      return `<${el.tagName.toLowerCase()}${attrs}>${content}</${el.tagName.toLowerCase()}>`;
    }).join('');
  }
  
  async callMethod(method, args = []) {
    if (this.destroyed || !this.worker) {
      throw new Error('Widget has been destroyed');
    }
    
    const result = await this.sendMessage('call', { method, args });
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    return result.result;
  }
  
  async setState(newState) {
    if (this.destroyed || !this.worker) {
      return;
    }
    
    await this.sendMessage('setState', { state: newState });
  }
  
  destroy() {
    this.destroyed = true;
    
    if (this.worker) {
      // Send destroy message
      this.sendMessage('destroy', {}).finally(() => {
        this.worker.terminate();
        this.worker = null;
      });
    }
    
    // Clear pending messages
    this.pendingMessages.clear();
  }
}

// Make available globally
window.WebWorkerRuntime = WebWorkerRuntime;