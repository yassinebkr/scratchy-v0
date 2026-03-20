/**
 * Widget Lifecycle Manager
 * SONNET RECOMMENDATION: Handle mount/unmount/health separate from routing
 * GEMINI RECOMMENDATION: Health monitoring + bridge recycling
 */

const { widgetAuthValidator } = require('./widget-auth-validator');

class WidgetLifecycleManager {
  constructor() {
    this.widgets = new Map();
    this.healthChecks = new Map();
    this.metrics = new Map();
    this.recycleThresholds = {
      memoryMB: 100,
      errorRate: 0.1,
      responseTimeMs: 5000
    };
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    console.log('🔄 Widget Lifecycle Manager initialized');
  }

  /**
   * SONNET: Widget registration with lifecycle tracking
   */
  async mountWidget(widgetId, widgetHandler, config = {}) {
    if (this.widgets.has(widgetId)) {
      throw new Error(`Widget ${widgetId} is already mounted`);
    }
    
    const startTime = Date.now();
    
    try {
      // Initialize widget state
      const widgetState = {
        id: widgetId,
        handler: widgetHandler,
        config,
        status: 'mounting',
        mountedAt: null,
        lastHealth: null,
        errorCount: 0,
        successCount: 0,
        totalActions: 0,
        averageResponseTime: 0,
        memoryUsage: 0,
        recycleCount: 0
      };
      
      // Store widget
      this.widgets.set(widgetId, widgetState);
      
      // Initialize health monitoring
      this.initializeHealthMonitoring(widgetId);
      
      // Initialize metrics
      this.initializeMetrics(widgetId);
      
      // Call widget initialization if available
      if (widgetHandler.initialize) {
        await widgetHandler.initialize(config);
      }
      
      // Mark as mounted
      widgetState.status = 'mounted';
      widgetState.mountedAt = Date.now();
      
      const mountTime = Date.now() - startTime;
      console.log(`🔄 Widget mounted: ${widgetId} (${mountTime}ms)`);
      
      return {
        widgetId,
        mounted: true,
        mountTime,
        status: 'healthy'
      };
      
    } catch (error) {
      // Clean up on failure
      this.widgets.delete(widgetId);
      this.healthChecks.delete(widgetId);
      this.metrics.delete(widgetId);
      
      console.error(`❌ Widget mount failed: ${widgetId}`, error);
      throw error;
    }
  }

  /**
   * SONNET: Clean widget unmounting
   */
  async unmountWidget(widgetId, reason = 'user_requested') {
    const widget = this.widgets.get(widgetId);
    if (!widget) {
      return false;
    }
    
    console.log(`🔄 Unmounting widget: ${widgetId} (${reason})`);
    
    try {
      // Update status
      widget.status = 'unmounting';
      
      // Call widget cleanup if available
      if (widget.handler.cleanup) {
        await widget.handler.cleanup();
      }
      
      // Clean up health monitoring
      this.cleanupHealthMonitoring(widgetId);
      
      // Remove from all maps
      this.widgets.delete(widgetId);
      this.healthChecks.delete(widgetId);
      this.metrics.delete(widgetId);
      
      console.log(`✅ Widget unmounted: ${widgetId}`);
      return true;
      
    } catch (error) {
      console.error(`❌ Widget unmount error: ${widgetId}`, error);
      // Force cleanup even on error
      this.widgets.delete(widgetId);
      this.healthChecks.delete(widgetId);
      this.metrics.delete(widgetId);
      return false;
    }
  }

  /**
   * GEMINI: Health monitoring with automatic recycling
   */
  startHealthMonitoring() {
    // Health check every 30 seconds
    setInterval(() => {
      this.performHealthChecks();
    }, 30000);
    
    // Metrics collection every 10 seconds
    setInterval(() => {
      this.collectMetrics();
    }, 10000);
    
    // Recycling check every 5 minutes
    setInterval(() => {
      this.checkRecyclingNeeds();
    }, 300000);
  }

  /**
   * Initialize health monitoring for a widget
   */
  initializeHealthMonitoring(widgetId) {
    this.healthChecks.set(widgetId, {
      lastCheck: Date.now(),
      consecutiveFailures: 0,
      totalChecks: 0,
      successRate: 1.0
    });
  }

  /**
   * Initialize metrics collection for a widget
   */
  initializeMetrics(widgetId) {
    this.metrics.set(widgetId, {
      responseTimes: [],
      errorCounts: [],
      memorySnapshots: [],
      actionCounts: []
    });
  }

  /**
   * Perform health checks on all widgets
   */
  async performHealthChecks() {
    for (const [widgetId, widget] of this.widgets.entries()) {
      if (widget.status !== 'mounted') continue;
      
      const healthData = this.healthChecks.get(widgetId);
      const startTime = Date.now();
      
      try {
        // Perform health check
        let isHealthy = true;
        
        // Check if widget has health check method
        if (widget.handler.healthCheck) {
          isHealthy = await Promise.race([
            widget.handler.healthCheck(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 5000))
          ]);
        }
        
        // Update health data
        healthData.lastCheck = Date.now();
        healthData.totalChecks++;
        
        if (isHealthy) {
          healthData.consecutiveFailures = 0;
          widget.lastHealth = 'healthy';
        } else {
          healthData.consecutiveFailures++;
          widget.lastHealth = 'unhealthy';
        }
        
        // Calculate success rate
        const recentChecks = Math.min(healthData.totalChecks, 10);
        const failures = Math.min(healthData.consecutiveFailures, recentChecks);
        healthData.successRate = (recentChecks - failures) / recentChecks;
        
        // Check for recycling need
        if (healthData.consecutiveFailures >= 3) {
          console.warn(`⚠️ Widget ${widgetId} failing health checks - consider recycling`);
          widget.status = 'degraded';
        }
        
      } catch (error) {
        healthData.consecutiveFailures++;
        healthData.totalChecks++;
        widget.lastHealth = 'error';
        
        console.error(`❌ Health check failed for ${widgetId}:`, error);
      }
    }
  }

  /**
   * Collect performance metrics
   */
  collectMetrics() {
    for (const [widgetId, widget] of this.widgets.entries()) {
      const metrics = this.metrics.get(widgetId);
      
      // Collect response time
      metrics.responseTimes.push(widget.averageResponseTime);
      if (metrics.responseTimes.length > 60) { // Keep last 60 samples (10 minutes)
        metrics.responseTimes.shift();
      }
      
      // Collect error counts
      metrics.errorCounts.push(widget.errorCount);
      if (metrics.errorCounts.length > 60) {
        metrics.errorCounts.shift();
      }
      
      // Collect memory usage (if available)
      if (typeof process !== 'undefined' && process.memoryUsage) {
        const memUsage = process.memoryUsage();
        widget.memoryUsage = memUsage.heapUsed / 1024 / 1024; // MB
        metrics.memorySnapshots.push(widget.memoryUsage);
        if (metrics.memorySnapshots.length > 60) {
          metrics.memorySnapshots.shift();
        }
      }
    }
  }

  /**
   * GEMINI: Check if widgets need recycling
   */
  checkRecyclingNeeds() {
    for (const [widgetId, widget] of this.widgets.entries()) {
      const shouldRecycle = this.shouldRecycleWidget(widgetId);
      
      if (shouldRecycle.needed) {
        console.log(`♻️ Recycling widget ${widgetId}: ${shouldRecycle.reason}`);
        this.recycleWidget(widgetId).catch(error => {
          console.error(`❌ Widget recycling failed for ${widgetId}:`, error);
        });
      }
    }
  }

  /**
   * Determine if a widget should be recycled
   */
  shouldRecycleWidget(widgetId) {
    const widget = this.widgets.get(widgetId);
    const healthData = this.healthChecks.get(widgetId);
    const metrics = this.metrics.get(widgetId);
    
    if (!widget || !healthData || !metrics) {
      return { needed: false };
    }
    
    // Check memory usage
    if (widget.memoryUsage > this.recycleThresholds.memoryMB) {
      return { 
        needed: true, 
        reason: `High memory usage: ${widget.memoryUsage.toFixed(1)}MB` 
      };
    }
    
    // Check error rate
    if (healthData.successRate < (1 - this.recycleThresholds.errorRate)) {
      return { 
        needed: true, 
        reason: `High error rate: ${((1 - healthData.successRate) * 100).toFixed(1)}%` 
      };
    }
    
    // Check response time
    if (widget.averageResponseTime > this.recycleThresholds.responseTimeMs) {
      return { 
        needed: true, 
        reason: `Slow response time: ${widget.averageResponseTime}ms` 
      };
    }
    
    // Check consecutive failures
    if (healthData.consecutiveFailures >= 5) {
      return { 
        needed: true, 
        reason: `Consecutive health check failures: ${healthData.consecutiveFailures}` 
      };
    }
    
    return { needed: false };
  }

  /**
   * Recycle a widget (unmount + remount)
   */
  async recycleWidget(widgetId) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;
    
    const originalConfig = widget.config;
    const originalHandler = widget.handler;
    
    try {
      // Unmount old widget
      await this.unmountWidget(widgetId, 'recycling');
      
      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Remount with same config
      await this.mountWidget(widgetId, originalHandler, originalConfig);
      
      // Increment recycle count
      const newWidget = this.widgets.get(widgetId);
      if (newWidget) {
        newWidget.recycleCount = (widget.recycleCount || 0) + 1;
      }
      
      console.log(`♻️ Widget recycled successfully: ${widgetId}`);
      return true;
      
    } catch (error) {
      console.error(`❌ Widget recycling failed: ${widgetId}`, error);
      return false;
    }
  }

  /**
   * Clean up health monitoring for a widget
   */
  cleanupHealthMonitoring(widgetId) {
    this.healthChecks.delete(widgetId);
    this.metrics.delete(widgetId);
  }

  /**
   * Get widget status
   */
  getWidgetStatus(widgetId) {
    const widget = this.widgets.get(widgetId);
    const healthData = this.healthChecks.get(widgetId);
    const metrics = this.metrics.get(widgetId);
    
    if (!widget) {
      return null;
    }
    
    return {
      id: widgetId,
      status: widget.status,
      mountedAt: widget.mountedAt,
      lastHealth: widget.lastHealth,
      uptime: widget.mountedAt ? Date.now() - widget.mountedAt : 0,
      errorCount: widget.errorCount,
      successCount: widget.successCount,
      totalActions: widget.totalActions,
      averageResponseTime: widget.averageResponseTime,
      memoryUsage: widget.memoryUsage,
      recycleCount: widget.recycleCount,
      healthCheck: healthData ? {
        successRate: healthData.successRate,
        consecutiveFailures: healthData.consecutiveFailures,
        lastCheck: healthData.lastCheck
      } : null,
      shouldRecycle: this.shouldRecycleWidget(widgetId)
    };
  }

  /**
   * Get all widget statuses
   */
  getAllWidgetStatuses() {
    const statuses = {};
    
    for (const widgetId of this.widgets.keys()) {
      statuses[widgetId] = this.getWidgetStatus(widgetId);
    }
    
    return statuses;
  }

  /**
   * Get system overview
   */
  getSystemOverview() {
    const totalWidgets = this.widgets.size;
    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;
    
    for (const widget of this.widgets.values()) {
      switch (widget.status) {
        case 'mounted':
          if (widget.lastHealth === 'healthy') healthyCount++;
          else if (widget.lastHealth === 'unhealthy') degradedCount++;
          else unhealthyCount++;
          break;
        case 'degraded':
          degradedCount++;
          break;
        default:
          unhealthyCount++;
      }
    }
    
    return {
      totalWidgets,
      healthyCount,
      degradedCount,
      unhealthyCount,
      healthPercentage: totalWidgets > 0 ? (healthyCount / totalWidgets) * 100 : 100
    };
  }
}

// Create singleton
const widgetLifecycleManager = new WidgetLifecycleManager();

module.exports = {
  WidgetLifecycleManager,
  widgetLifecycleManager
};