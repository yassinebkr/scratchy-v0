/**
 * Widget Action Queue System with Backpressure
 * GEMINI RECOMMENDATION: Per-widget action queues with configurable depth + backpressure
 * SONNET RECOMMENDATION: Sequential processing to prevent race conditions
 */

class WidgetActionQueue {
  constructor(widgetId, config = {}) {
    this.widgetId = widgetId;
    this.config = {
      maxDepth: config.maxDepth || 50,
      processingTimeout: config.processingTimeout || 30000,
      backpressureThreshold: config.backpressureThreshold || 0.8,
      overflowPolicy: config.overflowPolicy || 'drop-oldest', // 'drop-oldest' | 'reject-newest' | 'expand'
      batchSize: config.batchSize || 1,
      ...config
    };
    
    this.queue = [];
    this.processing = false;
    this.stats = {
      totalEnqueued: 0,
      totalProcessed: 0,
      totalDropped: 0,
      totalRejected: 0,
      totalErrors: 0,
      averageProcessingTime: 0,
      currentDepth: 0,
      backpressureActive: false
    };
    
    this.processingTimes = [];
    this.lastProcessedAt = null;
  }

  /**
   * GEMINI: Enqueue action with overflow policy
   */
  async enqueue(action, context = {}) {
    const startTime = Date.now();
    
    // Check if queue is full
    if (this.queue.length >= this.config.maxDepth) {
      return this.handleOverflow(action, context);
    }
    
    // Create queue item
    const queueItem = {
      id: this.generateActionId(),
      action,
      context,
      enqueuedAt: startTime,
      attempts: 0,
      maxAttempts: context.maxAttempts || 3
    };
    
    // Add to queue
    this.queue.push(queueItem);
    this.stats.totalEnqueued++;
    this.stats.currentDepth = this.queue.length;
    
    // Check backpressure
    this.updateBackpressureStatus();
    
    // Start processing if not already running
    if (!this.processing) {
      setImmediate(() => this.processQueue());
    }
    
    return {
      queued: true,
      actionId: queueItem.id,
      queuePosition: this.queue.length,
      estimatedWaitTime: this.estimateWaitTime(),
      backpressureActive: this.stats.backpressureActive
    };
  }

  /**
   * Handle queue overflow based on policy
   */
  handleOverflow(action, context) {
    switch (this.config.overflowPolicy) {
      case 'drop-oldest':
        if (this.queue.length > 0) {
          const dropped = this.queue.shift();
          this.stats.totalDropped++;
          console.warn(`🗑️ Dropped oldest action for ${this.widgetId}:`, dropped.action.action);
          
          // Add new action
          const queueItem = {
            id: this.generateActionId(),
            action,
            context,
            enqueuedAt: Date.now(),
            attempts: 0,
            maxAttempts: context.maxAttempts || 3
          };
          this.queue.push(queueItem);
          this.stats.totalEnqueued++;
          
          return {
            queued: true,
            actionId: queueItem.id,
            droppedOldest: true,
            queuePosition: this.queue.length
          };
        }
        break;
        
      case 'reject-newest':
        this.stats.totalRejected++;
        return {
          queued: false,
          rejected: true,
          reason: 'Queue full - newest action rejected',
          queueDepth: this.queue.length,
          maxDepth: this.config.maxDepth
        };
        
      case 'expand':
        // Allow queue to grow beyond limit (risky)
        console.warn(`⚠️ Queue expanding beyond limit for ${this.widgetId}: ${this.queue.length + 1} actions`);
        const queueItem = {
          id: this.generateActionId(),
          action,
          context,
          enqueuedAt: Date.now(),
          attempts: 0,
          maxAttempts: context.maxAttempts || 3
        };
        this.queue.push(queueItem);
        this.stats.totalEnqueued++;
        
        return {
          queued: true,
          actionId: queueItem.id,
          expanded: true,
          queuePosition: this.queue.length
        };
    }
    
    return {
      queued: false,
      rejected: true,
      reason: 'Queue full and no valid overflow policy'
    };
  }

  /**
   * SONNET: Sequential processing to prevent race conditions
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    
    this.processing = true;
    
    try {
      while (this.queue.length > 0) {
        const batchSize = Math.min(this.config.batchSize, this.queue.length);
        const batch = this.queue.splice(0, batchSize);
        
        // Process batch (sequential for now, could be parallel if safe)
        for (const queueItem of batch) {
          await this.processQueueItem(queueItem);
        }
        
        // Update stats
        this.stats.currentDepth = this.queue.length;
        this.updateBackpressureStatus();
      }
    } catch (error) {
      console.error(`❌ Queue processing error for ${this.widgetId}:`, error);
    } finally {
      this.processing = false;
      this.lastProcessedAt = Date.now();
    }
  }

  /**
   * Process individual queue item
   */
  async processQueueItem(queueItem) {
    const startTime = Date.now();
    
    try {
      // Add timeout wrapper
      const result = await Promise.race([
        this.executeAction(queueItem.action, queueItem.context),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Action timeout')), this.config.processingTimeout)
        )
      ]);
      
      // Update stats
      const processingTime = Date.now() - startTime;
      this.updateProcessingTimeStats(processingTime);
      this.stats.totalProcessed++;
      
      return result;
      
    } catch (error) {
      queueItem.attempts++;
      
      if (queueItem.attempts < queueItem.maxAttempts) {
        // Retry: add back to queue with exponential backoff
        setTimeout(() => {
          this.queue.unshift(queueItem);
        }, Math.pow(2, queueItem.attempts) * 1000);
        
        console.warn(`🔄 Retrying action ${queueItem.id} (attempt ${queueItem.attempts + 1})`);
      } else {
        // Max attempts exceeded
        this.stats.totalErrors++;
        console.error(`❌ Action failed after ${queueItem.maxAttempts} attempts:`, error);
      }
    }
  }

  /**
   * Execute action (to be overridden by widget implementation)
   */
  async executeAction(action, context) {
    throw new Error('executeAction must be implemented by widget');
  }

  /**
   * Update backpressure status
   */
  updateBackpressureStatus() {
    const utilizationRatio = this.queue.length / this.config.maxDepth;
    const wasActive = this.stats.backpressureActive;
    
    this.stats.backpressureActive = utilizationRatio >= this.config.backpressureThreshold;
    
    if (this.stats.backpressureActive && !wasActive) {
      console.warn(`⚠️ Backpressure activated for ${this.widgetId} (${this.queue.length}/${this.config.maxDepth})`);
    } else if (!this.stats.backpressureActive && wasActive) {
      console.log(`✅ Backpressure cleared for ${this.widgetId}`);
    }
  }

  /**
   * Update processing time statistics
   */
  updateProcessingTimeStats(processingTime) {
    this.processingTimes.push(processingTime);
    if (this.processingTimes.length > 100) {
      this.processingTimes.shift();
    }
    
    this.stats.averageProcessingTime = 
      this.processingTimes.reduce((sum, time) => sum + time, 0) / this.processingTimes.length;
  }

  /**
   * Estimate wait time for new actions
   */
  estimateWaitTime() {
    if (this.queue.length === 0) return 0;
    
    const avgProcessingTime = this.stats.averageProcessingTime || 1000;
    return this.queue.length * avgProcessingTime / this.config.batchSize;
  }

  /**
   * Generate unique action ID
   */
  generateActionId() {
    return `action-${this.widgetId}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      widgetId: this.widgetId,
      queueDepth: this.queue.length,
      processing: this.processing,
      config: this.config,
      stats: { ...this.stats },
      nextAction: this.queue.length > 0 ? {
        id: this.queue[0].id,
        action: this.queue[0].action.action,
        waitTime: Date.now() - this.queue[0].enqueuedAt
      } : null,
      estimatedWaitTime: this.estimateWaitTime(),
      lastProcessedAt: this.lastProcessedAt
    };
  }

  /**
   * Clear queue (emergency)
   */
  clear(reason = 'manual_clear') {
    const clearedCount = this.queue.length;
    this.queue = [];
    this.stats.currentDepth = 0;
    this.stats.backpressureActive = false;
    
    console.log(`🗑️ Queue cleared for ${this.widgetId}: ${clearedCount} actions (${reason})`);
    
    return clearedCount;
  }

  /**
   * Pause queue processing
   */
  pause() {
    this.paused = true;
    console.log(`⏸️ Queue paused for ${this.widgetId}`);
  }

  /**
   * Resume queue processing
   */
  resume() {
    this.paused = false;
    console.log(`▶️ Queue resumed for ${this.widgetId}`);
    
    if (!this.processing && this.queue.length > 0) {
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    const now = Date.now();
    
    return {
      throughput: {
        actionsPerSecond: this.stats.totalProcessed / ((now - this.createdAt) / 1000),
        averageProcessingTime: this.stats.averageProcessingTime,
        currentQueueDepth: this.queue.length
      },
      reliability: {
        successRate: this.stats.totalProcessed / (this.stats.totalProcessed + this.stats.totalErrors),
        errorRate: this.stats.totalErrors / this.stats.totalEnqueued,
        retryRate: (this.stats.totalEnqueued - this.stats.totalProcessed - this.stats.totalErrors) / this.stats.totalEnqueued
      },
      capacity: {
        maxDepth: this.config.maxDepth,
        currentUtilization: this.queue.length / this.config.maxDepth,
        backpressureActive: this.stats.backpressureActive,
        droppedActions: this.stats.totalDropped,
        rejectedActions: this.stats.totalRejected
      }
    };
  }
}

/**
 * Widget Action Queue Manager - manages queues for all widgets
 */
class WidgetActionQueueManager {
  constructor() {
    this.queues = new Map();
    this.globalConfig = {
      maxDepth: 50,
      processingTimeout: 30000,
      backpressureThreshold: 0.8,
      overflowPolicy: 'drop-oldest'
    };
  }

  /**
   * Get or create queue for widget
   */
  getQueue(widgetId, config = {}) {
    if (!this.queues.has(widgetId)) {
      const queueConfig = { ...this.globalConfig, ...config };
      const queue = new WidgetActionQueue(widgetId, queueConfig);
      this.queues.set(widgetId, queue);
      
      console.log(`📥 Created action queue for widget: ${widgetId}`);
    }
    
    return this.queues.get(widgetId);
  }

  /**
   * Remove queue for widget
   */
  removeQueue(widgetId) {
    if (this.queues.has(widgetId)) {
      const queue = this.queues.get(widgetId);
      queue.clear('widget_unmounted');
      this.queues.delete(widgetId);
      
      console.log(`🗑️ Removed action queue for widget: ${widgetId}`);
      return true;
    }
    return false;
  }

  /**
   * Get all queue statuses
   */
  getAllQueueStatuses() {
    const statuses = {};
    
    for (const [widgetId, queue] of this.queues.entries()) {
      statuses[widgetId] = queue.getStatus();
    }
    
    return statuses;
  }

  /**
   * Get system overview
   */
  getSystemOverview() {
    let totalQueues = this.queues.size;
    let totalActions = 0;
    let backpressureQueues = 0;
    let processingQueues = 0;
    
    for (const queue of this.queues.values()) {
      const status = queue.getStatus();
      totalActions += status.queueDepth;
      if (status.stats.backpressureActive) backpressureQueues++;
      if (status.processing) processingQueues++;
    }
    
    return {
      totalQueues,
      totalActions,
      backpressureQueues,
      processingQueues,
      averageQueueDepth: totalQueues > 0 ? totalActions / totalQueues : 0
    };
  }
}

// Create singleton manager
const widgetActionQueueManager = new WidgetActionQueueManager();

module.exports = {
  WidgetActionQueue,
  WidgetActionQueueManager,
  widgetActionQueueManager
};