/**
 * Supporting Infrastructure for Canvas 2.0
 * Designed for evolution through all phases
 */

/**
 * EventBus - Inter-widget communication system
 * Phase 1: Simple event system
 * Phase 2: Will add sophisticated routing and filtering
 * Phase 3: AI-driven event orchestration
 */
class EventBus {
  constructor() {
    this.listeners = new Map();
    this.middlewares = [];
    this.eventHistory = []; // For debugging and Phase 3 AI analysis
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    
    this.listeners.get(event).add(callback);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(event);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  off(event, callback) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  emit(event, data = null) {
    const eventObj = {
      event,
      data,
      timestamp: Date.now(),
      id: this.generateEventId()
    };

    // Store for history (useful for debugging and future AI analysis)
    this.eventHistory.push(eventObj);
    if (this.eventHistory.length > 1000) {
      this.eventHistory.shift(); // Keep last 1000 events
    }

    // Apply middlewares (extensibility point for Phase 2)
    let processedEvent = eventObj;
    for (const middleware of this.middlewares) {
      processedEvent = middleware(processedEvent);
      if (!processedEvent) return; // Middleware can cancel event
    }

    // Direct event listeners
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(processedEvent.data, processedEvent);
        } catch (error) {
          console.error(`Event listener error for ${event}:`, error);
        }
      });
    }

    // Wildcard listeners (e.g., 'widget:*')
    this.listeners.forEach((callbacks, pattern) => {
      if (pattern.includes('*') && this.matchPattern(event, pattern)) {
        callbacks.forEach(callback => {
          try {
            callback(processedEvent.data, processedEvent);
          } catch (error) {
            console.error(`Wildcard listener error for ${pattern}:`, error);
          }
        });
      }
    });
  }

  // Middleware system for Phase 2 extensions
  use(middleware) {
    this.middlewares.push(middleware);
  }

  // Pattern matching for wildcard events
  matchPattern(event, pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(event);
  }

  generateEventId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  // Debug and monitoring methods
  getEventHistory(filter = null) {
    if (!filter) return [...this.eventHistory];
    return this.eventHistory.filter(filter);
  }

  getActiveListeners() {
    const result = {};
    this.listeners.forEach((callbacks, event) => {
      result[event] = callbacks.size;
    });
    return result;
  }
}

/**
 * APIGateway - Secure API access and management
 * Phase 1: Basic rate limiting and proxying
 * Phase 2: Enhanced security and caching
 * Phase 3: AI-driven API optimization
 */
class APIGateway {
  constructor(config = {}) {
    this.config = {
      rateLimit: config.rateLimit || 100, // requests per minute per widget
      timeout: config.timeout || 30000,
      retries: config.retries || 2,
      allowedDomains: config.allowedDomains || [],
      ...config
    };
    
    this.rateLimits = new Map(); // widgetId -> request counts
    this.apiConnections = new Map();
    this.cache = new Map(); // Simple cache, will be enhanced in Phase 2
  }

  init() {
    // Initialize API gateway
    this.setupRateLimitReset();
    console.log('API Gateway initialized');
  }

  async call(widgetId, apiName, method, args) {
    // Rate limiting
    if (!this.checkRateLimit(widgetId)) {
      throw new Error(`Rate limit exceeded for widget ${widgetId}`);
    }

    // Security check
    if (!this.isAPIAllowed(apiName)) {
      throw new Error(`API ${apiName} not in allowlist`);
    }

    const cacheKey = `${widgetId}:${apiName}:${method}:${JSON.stringify(args)}`;
    
    // Check cache (Phase 1: simple, Phase 2: sophisticated)
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < (cached.ttl || 300000)) { // 5min default
        return cached.data;
      }
    }

    try {
      // Make API call with retries
      const result = await this.makeAPICall(apiName, method, args);
      
      // Cache result
      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now(),
        ttl: this.getAPITTL(apiName, method)
      });

      // Update rate limit
      this.updateRateLimit(widgetId);

      return result;

    } catch (error) {
      console.error(`API call failed: ${apiName}.${method}`, error);
      throw error;
    }
  }

  async makeAPICall(apiName, method, args) {
    // Phase 1: Simple HTTP calls
    // Phase 2: Will add sophisticated API adapters
    
    const apiConfig = this.getAPIConfig(apiName);
    if (!apiConfig) {
      throw new Error(`Unknown API: ${apiName}`);
    }

    const url = `${apiConfig.baseUrl}/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...apiConfig.headers
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(this.config.timeout)
    });

    if (!response.ok) {
      throw new Error(`API call failed: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  checkRateLimit(widgetId) {
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute window
    
    let requests = this.rateLimits.get(widgetId) || [];
    requests = requests.filter(timestamp => timestamp > windowStart);
    
    return requests.length < this.config.rateLimit;
  }

  updateRateLimit(widgetId) {
    const now = Date.now();
    let requests = this.rateLimits.get(widgetId) || [];
    requests.push(now);
    
    // Clean old requests
    const windowStart = now - 60000;
    requests = requests.filter(timestamp => timestamp > windowStart);
    
    this.rateLimits.set(widgetId, requests);
  }

  setupRateLimitReset() {
    // Clean up rate limit data every minute
    setInterval(() => {
      const now = Date.now();
      const windowStart = now - 60000;
      
      this.rateLimits.forEach((requests, widgetId) => {
        const filtered = requests.filter(timestamp => timestamp > windowStart);
        if (filtered.length === 0) {
          this.rateLimits.delete(widgetId);
        } else {
          this.rateLimits.set(widgetId, filtered);
        }
      });
    }, 60000);
  }

  isAPIAllowed(apiName) {
    // Phase 1: Simple allowlist
    // Phase 2: Will add per-widget permissions
    return this.config.allowedAPIs ? this.config.allowedAPIs.includes(apiName) : true;
  }

  getAPIConfig(apiName) {
    // Phase 1: Hardcoded configs
    // Phase 2: Dynamic configuration system
    const configs = {
      openweather: {
        baseUrl: 'https://api.openweathermap.org/data/2.5',
        headers: { 'X-API-Key': process.env.OPENWEATHER_API_KEY }
      },
      github: {
        baseUrl: 'https://api.github.com',
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
      }
      // More APIs will be added
    };

    return configs[apiName];
  }

  getAPITTL(apiName, method) {
    // Different cache times for different APIs/methods
    const ttls = {
      'openweather:current': 300000, // 5 minutes
      'github:repos': 3600000, // 1 hour
      'default': 300000
    };

    return ttls[`${apiName}:${method}`] || ttls.default;
  }
}

/**
 * StateManager - Persistent widget state
 * Phase 1: localStorage-based
 * Phase 2: Enhanced with cloud sync
 * Phase 3: AI-driven state optimization
 */
class StateManager {
  constructor(storage = 'localStorage') {
    this.storage = storage;
    this.cache = new Map();
    this.storagePrefix = 'canvas-widget-';
  }

  async getState(widgetId) {
    if (this.cache.has(widgetId)) {
      return this.cache.get(widgetId);
    }

    try {
      const key = this.storagePrefix + widgetId;
      const stored = localStorage.getItem(key);
      const state = stored ? JSON.parse(stored) : {};
      
      this.cache.set(widgetId, state);
      return state;
    } catch (error) {
      console.error(`Failed to get state for widget ${widgetId}:`, error);
      return {};
    }
  }

  async setState(widgetId, state) {
    try {
      const key = this.storagePrefix + widgetId;
      localStorage.setItem(key, JSON.stringify(state));
      this.cache.set(widgetId, state);
    } catch (error) {
      console.error(`Failed to set state for widget ${widgetId}:`, error);
    }
  }

  async clearState(widgetId) {
    try {
      const key = this.storagePrefix + widgetId;
      localStorage.removeItem(key);
      this.cache.delete(widgetId);
    } catch (error) {
      console.error(`Failed to clear state for widget ${widgetId}:`, error);
    }
  }

  createNamespace(widgetId) {
    // Create a namespaced storage interface for widgets
    return {
      get: (key) => this.getNamespaced(widgetId, key),
      set: (key, value) => this.setNamespaced(widgetId, key, value),
      remove: (key) => this.removeNamespaced(widgetId, key)
    };
  }

  async getNamespaced(widgetId, key) {
    const state = await this.getState(widgetId);
    return state[key];
  }

  async setNamespaced(widgetId, key, value) {
    const state = await this.getState(widgetId);
    state[key] = value;
    await this.setState(widgetId, state);
  }

  async removeNamespaced(widgetId, key) {
    const state = await this.getState(widgetId);
    delete state[key];
    await this.setState(widgetId, state);
  }
}

/**
 * SecurityPolicy - Code validation and security
 * Phase 1: Basic static analysis
 * Phase 2: Advanced sandboxing
 * Phase 3: AI-powered threat detection
 */
class SecurityPolicy {
  constructor(config = {}) {
    this.config = {
      allowedGlobals: config.allowedGlobals || ['console', 'Math', 'Date', 'JSON'],
      blockedPatterns: config.blockedPatterns || [
        /eval\s*\(/,
        /Function\s*\(/,
        /document\.write/,
        /innerHTML\s*=/,
        /outerHTML\s*=/,
        /\.src\s*=/,
        /location\./,
        /window\./
      ],
      maxCodeSize: config.maxCodeSize || 100000, // 100KB max
      ...config
    };
  }

  isCodeSafe(code) {
    // Size check
    if (code.length > this.config.maxCodeSize) {
      console.warn('Code size exceeds limit');
      return false;
    }

    // Pattern-based checks
    for (const pattern of this.config.blockedPatterns) {
      if (pattern.test(code)) {
        console.warn(`Code contains blocked pattern: ${pattern}`);
        return false;
      }
    }

    // More sophisticated checks in Phase 2
    return true;
  }

  sanitizeCode(code) {
    // Phase 1: Basic sanitization
    // Phase 2: AST-based transformation
    return code;
  }
}

/**
 * ResourceMonitor - Performance and resource tracking
 * Phase 1: Basic monitoring
 * Phase 2: Advanced profiling
 * Phase 3: AI-driven optimization
 */
class ResourceMonitor {
  constructor(config = {}) {
    this.config = {
      maxMemoryMB: config.maxMemoryMB || 50,
      maxCPUPercent: config.maxCPUPercent || 10,
      ...config
    };
    
    this.metrics = new Map();
  }

  startMonitoring(widgetId) {
    // Phase 1: Placeholder
    // Phase 2: Real resource tracking
    this.metrics.set(widgetId, {
      startTime: Date.now(),
      memoryUsage: 0,
      cpuUsage: 0
    });
  }

  stopMonitoring(widgetId) {
    this.metrics.delete(widgetId);
  }

  getMetrics(widgetId) {
    return this.metrics.get(widgetId) || {};
  }
}

// Security error class
class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityError';
  }
}

// Export all classes
window.EventBus = EventBus;
window.APIGateway = APIGateway;
window.StateManager = StateManager;
window.SecurityPolicy = SecurityPolicy;
window.ResourceMonitor = ResourceMonitor;
window.SecurityError = SecurityError;