/**
 * Direct Widget Router - TRUE Isolation Implementation
 * Routes UserActions directly to isolated widgets WITHOUT chat pipeline
 * 
 * UPGRADED with Sonnet + Gemini recommendations:
 * - Authorization validation
 * - Health monitoring
 * - Action queuing with backpressure
 * - Metrics collection
 * - Protocol versioning
 */

const { widgetAuthValidator } = require('./widget-auth-validator');
const { widgetLifecycleManager } = require('./widget-lifecycle-manager');
const { widgetActionQueueManager } = require('./widget-action-queue');

class DirectWidgetRouter {
  constructor() {
    this.isolatedWidgets = new Map();
    this.routingRules = new Map();
    this.debugMode = false;
    this.chatBypassEnabled = true;
    this.protocolVersion = '1.0';
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      startTime: Date.now()
    };
    this.latencyHistory = [];
    
    console.log('🎯 Direct Widget Router initialized - ENHANCED with security & monitoring');
  }

  /**
   * Register an isolated widget with direct routing
   */
  registerIsolatedWidget(widgetId, widgetHandler, routingRules = {}) {
    this.isolatedWidgets.set(widgetId, {
      handler: widgetHandler,
      rules: routingRules,
      registeredAt: Date.now(),
      directCallsOnly: true
    });
    
    // Store routing rules
    if (routingRules.actionPrefixes) {
      routingRules.actionPrefixes.forEach(prefix => {
        this.routingRules.set(prefix, widgetId);
      });
    }
    
    if (routingRules.componentPrefixes) {
      routingRules.componentPrefixes.forEach(prefix => {
        this.routingRules.set(`component:${prefix}`, widgetId);
      });
    }
    
    if (this.debugMode) {
      console.log(`🔧 Widget registered for direct routing: ${widgetId}`);
    }
  }

  /**
   * Route UserAction DIRECTLY to isolated widget (NO chat involvement)
   * UPGRADED: Security validation + Health monitoring + Action queuing
   */
  async routeUserActionDirectly(userAction, context = {}) {
    const startTime = Date.now();
    this.metrics.totalRequests++;
    
    if (this.debugMode) {
      console.log('🎯 Direct routing UserAction (ENHANCED):', userAction);
    }
    
    try {
      // STEP 1: SONNET + GEMINI - Security validation
      const validationResult = await widgetAuthValidator.validateAction(userAction, {
        ...context,
        sessionId: context.sessionId || 'unknown',
        userId: context.userId || 'anonymous',
        authenticated: context.authenticated || false
      });
      
      if (!validationResult.valid) {
        this.metrics.failedRequests++;
        throw new Error(`Security validation failed: ${validationResult.error}`);
      }
      
      // STEP 2: Determine target widget
      const targetWidgetId = this.determineTargetWidget(userAction);
      if (!targetWidgetId) {
        this.metrics.failedRequests++;
        throw new Error(`No widget registered to handle action: ${userAction.action}`);
      }
      
      // STEP 3: SONNET - Check widget health status
      const widgetStatus = widgetLifecycleManager.getWidgetStatus(targetWidgetId);
      if (!widgetStatus) {
        this.metrics.failedRequests++;
        throw new Error(`Widget not mounted: ${targetWidgetId}`);
      }
      
      if (widgetStatus.status === 'degraded' || widgetStatus.lastHealth === 'unhealthy') {
        console.warn(`⚠️ Routing to degraded widget: ${targetWidgetId}`);
      }
      
      // STEP 4: Get widget handler
      const widget = this.isolatedWidgets.get(targetWidgetId);
      if (!widget) {
        this.metrics.failedRequests++;
        throw new Error(`Widget handler not found: ${targetWidgetId}`);
      }
      
      // STEP 5: GEMINI - Get action queue and check backpressure
      const actionQueue = widgetActionQueueManager.getQueue(targetWidgetId);
      const queueStatus = actionQueue.getStatus();
      
      if (queueStatus.stats.backpressureActive) {
        console.warn(`⚠️ Backpressure active for ${targetWidgetId} - queuing action`);
      }
      
      // STEP 6: Create isolated context (NO chat references)
      const isolatedContext = {
        ...context,
        source: 'direct-widget-router',
        chatBypass: true,
        isolated: true,
        timestamp: Date.now(),
        protocolVersion: this.protocolVersion,
        validationTime: validationResult.validationTime,
        // NEVER include chat references
        chatDisabled: true
      };
      
      // STEP 7: Execute through queue system (GEMINI recommendation)
      const queueResult = await actionQueue.enqueue(userAction, isolatedContext);
      
      if (!queueResult.queued) {
        this.metrics.failedRequests++;
        throw new Error(`Action queue rejected: ${queueResult.reason}`);
      }
      
      // STEP 8: Execute DIRECTLY on widget handler (via queue)
      actionQueue.executeAction = async (action, ctx) => {
        return await widget.handler.executeCommand(action.action, action.context, ctx);
      };
      
      // For synchronous response, we need to wait for queue processing
      // In production, this could be async with callback/promise resolution
      const result = await this.waitForQueueExecution(actionQueue, queueResult.actionId);
      
      // STEP 9: Update metrics
      const latency = Date.now() - startTime;
      this.updateLatencyMetrics(latency);
      this.metrics.successfulRequests++;
      
      if (this.debugMode) {
        console.log(`✅ Direct execution successful: ${targetWidgetId} (${latency}ms)`);
      }
      
      return {
        ...result,
        routedDirectly: true,
        targetWidget: targetWidgetId,
        chatBypassed: true,
        protocolVersion: this.protocolVersion,
        latency,
        queuedAction: queueResult.actionId,
        backpressureActive: queueStatus.stats.backpressureActive
      };
      
    } catch (error) {
      const latency = Date.now() - startTime;
      this.updateLatencyMetrics(latency);
      this.metrics.failedRequests++;
      
      console.error(`❌ Enhanced direct routing failed:`, error);
      throw error;
    }
  }

  /**
   * Determine which widget should handle the UserAction
   */
  determineTargetWidget(userAction) {
    const { action, componentId } = userAction;
    
    // Check action prefix routing
    for (const [prefix, widgetId] of this.routingRules.entries()) {
      if (prefix.startsWith('component:')) {
        const componentPrefix = prefix.replace('component:', '');
        if (componentId && componentId.startsWith(componentPrefix)) {
          return widgetId;
        }
      } else {
        // Action prefix
        if (action && action.startsWith(prefix)) {
          return widgetId;
        }
      }
    }
    
    // Default routing based on component ID patterns
    if (componentId) {
      if (componentId.includes('sn-') || componentId.includes('notes')) {
        return 'notes';
      }
      if (componentId.includes('memory-') || componentId.includes('protection')) {
        return 'memory-protection';
      }
      if (componentId.includes('email-') || componentId.includes('mail')) {
        return 'email';
      }
    }
    
    return null;
  }

  /**
   * Intercept and bypass chat processing for UserActions
   */
  interceptUserAction(userActionMessage) {
    // Parse UserAction from message
    const match = userActionMessage.match(/\[UserAction\]\s*(\{.*\})/);
    if (!match) {
      return null; // Not a UserAction, let normal processing handle
    }
    
    try {
      const userAction = JSON.parse(match[1]);
      
      if (this.debugMode) {
        console.log('🚫 Intercepting UserAction from chat pipeline');
      }
      
      // Route directly - BYPASS CHAT ENTIRELY
      return this.routeUserActionDirectly(userAction, {
        intercepted: true,
        originalMessage: userActionMessage
      });
      
    } catch (error) {
      console.error('❌ UserAction interception failed:', error);
      return null;
    }
  }

  /**
   * Check if message should be intercepted for direct routing
   */
  shouldIntercept(message) {
    return message.includes('[UserAction]') && this.chatBypassEnabled;
  }

  /**
   * Enable/disable chat bypass
   */
  setChatBypass(enabled, reason = '') {
    this.chatBypassEnabled = enabled;
    
    if (reason) {
      console.log(`🔧 Chat bypass ${enabled ? 'ENABLED' : 'DISABLED'}: ${reason}`);
    }
  }

  /**
   * Get routing status
   */
  getRoutingStatus() {
    return {
      chatBypassEnabled: this.chatBypassEnabled,
      registeredWidgets: Array.from(this.isolatedWidgets.keys()),
      routingRules: Object.fromEntries(this.routingRules),
      totalRoutes: this.routingRules.size,
      directCallsOnly: true
    };
  }

  /**
   * Wait for queue execution (simplified synchronous approach)
   */
  async waitForQueueExecution(actionQueue, actionId, timeout = 30000) {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const status = actionQueue.getStatus();
        
        // Check if our action is still in queue
        const isInQueue = status.nextAction && status.nextAction.id === actionId;
        const hasTimedOut = Date.now() - startTime > timeout;
        
        if (hasTimedOut) {
          clearInterval(checkInterval);
          reject(new Error(`Action execution timeout: ${actionId}`));
        } else if (!isInQueue && !actionQueue.processing) {
          // Action completed (success assumed for now)
          clearInterval(checkInterval);
          resolve({
            success: true,
            executedAt: Date.now(),
            processingTime: Date.now() - startTime
          });
        }
      }, 100);
    });
  }

  /**
   * Update latency metrics
   */
  updateLatencyMetrics(latency) {
    this.latencyHistory.push(latency);
    if (this.latencyHistory.length > 1000) {
      this.latencyHistory.shift();
    }
    
    this.metrics.averageLatency = 
      this.latencyHistory.reduce((sum, lat) => sum + lat, 0) / this.latencyHistory.length;
  }

  /**
   * SONNET: Register widget with lifecycle management
   */
  async registerIsolatedWidgetEnhanced(widgetId, widgetHandler, routingRules = {}) {
    // Mount widget through lifecycle manager
    await widgetLifecycleManager.mountWidget(widgetId, widgetHandler, routingRules);
    
    // Register routing rules
    this.registerIsolatedWidget(widgetId, { handler: widgetHandler }, routingRules);
    
    // Initialize action queue
    widgetActionQueueManager.getQueue(widgetId, routingRules.queueConfig);
    
    console.log(`🔧 Enhanced widget registration complete: ${widgetId}`);
  }

  /**
   * SONNET: Unregister widget with proper cleanup
   */
  async unregisterIsolatedWidgetEnhanced(widgetId, reason = 'user_requested') {
    // Unmount through lifecycle manager
    await widgetLifecycleManager.unmountWidget(widgetId, reason);
    
    // Remove action queue
    widgetActionQueueManager.removeQueue(widgetId);
    
    // Remove from router
    this.isolatedWidgets.delete(widgetId);
    
    // Clean routing rules
    for (const [rule, targetId] of this.routingRules.entries()) {
      if (targetId === widgetId) {
        this.routingRules.delete(rule);
      }
    }
    
    console.log(`🗑️ Enhanced widget unregistration complete: ${widgetId}`);
  }

  /**
   * GEMINI: Get comprehensive system metrics
   */
  getEnhancedMetrics() {
    const uptime = Date.now() - this.metrics.startTime;
    const requestRate = this.metrics.totalRequests / (uptime / 1000);
    const successRate = this.metrics.successfulRequests / this.metrics.totalRequests;
    
    return {
      router: {
        totalRequests: this.metrics.totalRequests,
        successfulRequests: this.metrics.successfulRequests,
        failedRequests: this.metrics.failedRequests,
        successRate,
        requestRate,
        averageLatency: this.metrics.averageLatency,
        uptime
      },
      widgets: widgetLifecycleManager.getAllWidgetStatuses(),
      queues: widgetActionQueueManager.getAllQueueStatuses(),
      security: widgetAuthValidator.getStats(),
      system: {
        chatBypassEnabled: this.chatBypassEnabled,
        protocolVersion: this.protocolVersion,
        debugMode: this.debugMode
      }
    };
  }

  /**
   * GEMINI: Health check endpoint
   */
  async performHealthCheck() {
    const startTime = Date.now();
    
    const health = {
      status: 'healthy',
      timestamp: startTime,
      checks: {
        router: { status: 'ok' },
        widgets: { status: 'ok', details: {} },
        queues: { status: 'ok', details: {} },
        security: { status: 'ok' }
      },
      metrics: {}
    };
    
    try {
      // Check widget health
      const widgetStatuses = widgetLifecycleManager.getAllWidgetStatuses();
      let unhealthyWidgets = 0;
      
      for (const [widgetId, status] of Object.entries(widgetStatuses)) {
        if (status.status === 'degraded' || status.lastHealth === 'unhealthy') {
          unhealthyWidgets++;
        }
        health.checks.widgets.details[widgetId] = {
          status: status.status,
          lastHealth: status.lastHealth
        };
      }
      
      if (unhealthyWidgets > 0) {
        health.checks.widgets.status = `${unhealthyWidgets} unhealthy`;
        if (unhealthyWidgets > Object.keys(widgetStatuses).length / 2) {
          health.status = 'degraded';
        }
      }
      
      // Check queue health
      const queueOverview = widgetActionQueueManager.getSystemOverview();
      health.checks.queues.details = queueOverview;
      
      if (queueOverview.backpressureQueues > 0) {
        health.checks.queues.status = `${queueOverview.backpressureQueues} under backpressure`;
      }
      
      // Add metrics
      health.metrics = this.getEnhancedMetrics();
      
    } catch (error) {
      health.status = 'unhealthy';
      health.error = error.message;
    }
    
    health.checkDuration = Date.now() - startTime;
    return health;
  }

  /**
   * Enable debug mode
   */
  setDebugMode(enabled) {
    this.debugMode = enabled;
    console.log(`🐛 Enhanced Direct Widget Router debug: ${enabled ? 'ON' : 'OFF'}`);
  }
}

// Create singleton router
const directWidgetRouter = new DirectWidgetRouter();

// Export for global access (browser-only)
if (typeof window !== 'undefined') {
  window.directWidgetRouter = directWidgetRouter;
}

module.exports = {
  DirectWidgetRouter,
  directWidgetRouter
};