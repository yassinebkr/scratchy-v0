/**
 * Shared Widget Authentication & Validation Middleware
 * Addresses both Sonnet + Gemini recommendations for security
 */

class WidgetAuthValidator {
  constructor() {
    this.authCache = new Map();
    this.rateLimits = new Map();
    this.validationSchemas = new Map();
    this.securityLevel = 'STRICT';
    
    console.log('🛡️ Widget Auth Validator initialized');
  }

  /**
   * SONNET RECOMMENDATION: Authorization bypass prevention
   * GEMINI RECOMMENDATION: Shared auth/validation middleware
   */
  async validateAction(action, context = {}) {
    const startTime = Date.now();
    
    try {
      // 1. SONNET: Authorization Check (HIGH PRIORITY)
      await this.validateAuthorization(action, context);
      
      // 2. GEMINI: Schema Validation at entry point
      this.validateSchema(action);
      
      // 3. Rate limiting per widget
      this.enforceRateLimit(action, context);
      
      // 4. GEMINI: Origin validation 
      this.validateOrigin(action, context);
      
      return {
        valid: true,
        validatedAt: Date.now(),
        validationTime: Date.now() - startTime
      };
      
    } catch (error) {
      return {
        valid: false,
        error: error.message,
        validationTime: Date.now() - startTime,
        blocked: true
      };
    }
  }

  /**
   * SONNET: Authorization bypass prevention (HIGH PRIORITY)
   */
  async validateAuthorization(action, context) {
    const { surfaceId, componentId, action: actionType } = action;
    const userId = context.userId || 'anonymous';
    
    // Check if user has permission for this action
    const authKey = `${userId}:${actionType}:${componentId}`;
    
    if (this.authCache.has(authKey)) {
      const cachedAuth = this.authCache.get(authKey);
      if (Date.now() - cachedAuth.timestamp < 300000) { // 5 min cache
        if (!cachedAuth.authorized) {
          throw new Error(`Unauthorized: ${actionType} on ${componentId}`);
        }
        return;
      }
    }
    
    // Perform authorization check
    const authorized = await this.checkPermissions(userId, actionType, componentId);
    
    // Cache result
    this.authCache.set(authKey, {
      authorized,
      timestamp: Date.now()
    });
    
    if (!authorized) {
      throw new Error(`Unauthorized: ${actionType} on ${componentId}`);
    }
  }

  /**
   * GEMINI: Schema validation at router entry point
   */
  validateSchema(action) {
    // Required fields
    if (!action.surfaceId || !action.componentId || !action.action) {
      throw new Error('Invalid action: missing required fields (surfaceId, componentId, action)');
    }
    
    // Action type validation
    if (typeof action.action !== 'string' || action.action.length === 0) {
      throw new Error('Invalid action: action must be non-empty string');
    }
    
    // Component ID format validation
    if (!/^[a-zA-Z0-9_-]+$/.test(action.componentId)) {
      throw new Error('Invalid action: componentId contains illegal characters');
    }
    
    // Context validation
    if (action.context && typeof action.context !== 'object') {
      throw new Error('Invalid action: context must be object');
    }
    
    // Size limits
    const actionSize = JSON.stringify(action).length;
    if (actionSize > 50000) { // 50KB limit
      throw new Error('Invalid action: payload too large');
    }
  }

  /**
   * GEMINI: Rate limiting with backpressure
   */
  enforceRateLimit(action, context) {
    const { componentId } = action;
    const key = `${context.userId || 'anonymous'}:${componentId}`;
    
    const now = Date.now();
    const window = 60000; // 1 minute
    const limit = 100; // 100 actions per minute per widget
    
    if (!this.rateLimits.has(key)) {
      this.rateLimits.set(key, []);
    }
    
    const timestamps = this.rateLimits.get(key);
    
    // Remove old timestamps
    while (timestamps.length > 0 && now - timestamps[0] > window) {
      timestamps.shift();
    }
    
    // Check limit
    if (timestamps.length >= limit) {
      throw new Error(`Rate limit exceeded: ${limit} actions per minute for ${componentId}`);
    }
    
    // Add current timestamp
    timestamps.push(now);
  }

  /**
   * GEMINI: Origin validation to prevent spoofed actions
   */
  validateOrigin(action, context) {
    // Validate request came from authenticated session
    if (!context.sessionId) {
      throw new Error('Invalid origin: missing session identifier');
    }
    
    // Validate session is active
    if (context.sessionExpired) {
      throw new Error('Invalid origin: session expired');
    }
    
    // Validate surface ID matches session context
    if (context.expectedSurfaceId && action.surfaceId !== context.expectedSurfaceId) {
      throw new Error('Invalid origin: surface ID mismatch');
    }
  }

  /**
   * Permission check (placeholder - integrate with actual auth system)
   */
  async checkPermissions(userId, actionType, componentId) {
    // HIGH SECURITY ACTIONS - require explicit permissions
    const highSecurityActions = [
      'enable-memory-protection',
      'sn-authenticate', 
      'delete-data',
      'system-config'
    ];
    
    if (highSecurityActions.some(action => actionType.includes(action))) {
      // For now, allow if user has been authenticated recently
      // In production, check against proper permission system
      return context.authenticated === true;
    }
    
    // Regular actions allowed for authenticated users
    return userId !== 'anonymous';
  }

  /**
   * GEMINI: Register validation schema for specific widgets
   */
  registerWidgetSchema(widgetId, schema) {
    this.validationSchemas.set(widgetId, schema);
    console.log(`📋 Validation schema registered for widget: ${widgetId}`);
  }

  /**
   * Clean up expired cache entries
   */
  cleanup() {
    const now = Date.now();
    
    // Clean auth cache
    for (const [key, value] of this.authCache.entries()) {
      if (now - value.timestamp > 300000) { // 5 minutes
        this.authCache.delete(key);
      }
    }
    
    // Clean rate limit cache
    for (const [key, timestamps] of this.rateLimits.entries()) {
      while (timestamps.length > 0 && now - timestamps[0] > 60000) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.rateLimits.delete(key);
      }
    }
  }

  /**
   * Get validation statistics
   */
  getStats() {
    return {
      authCacheSize: this.authCache.size,
      rateLimitEntries: this.rateLimits.size,
      securityLevel: this.securityLevel,
      registeredSchemas: this.validationSchemas.size
    };
  }
}

// Create singleton
const widgetAuthValidator = new WidgetAuthValidator();

// Cleanup every 5 minutes
setInterval(() => {
  widgetAuthValidator.cleanup();
}, 300000);

module.exports = {
  WidgetAuthValidator,
  widgetAuthValidator
};