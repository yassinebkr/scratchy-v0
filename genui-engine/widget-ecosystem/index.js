/**
 * Widget Ecosystem - Complete Inter-Widget Communication System
 * 
 * This module provides a complete ecosystem for autonomous widgets to:
 * - Communicate with each other via events
 * - Receive direct commands from AI
 * - Share data through a central context store
 * - Participate in complex multi-widget workflows
 * 
 * Architecture Overview:
 * - WidgetEventBus: Inter-widget communication via events
 * - AIWidgetInterface: AI-to-widget command system
 * - SharedContextStore: Cross-widget data management
 * - WorkflowOrchestrator: Multi-widget workflow coordination
 */

const { WidgetEventBus, widgetEventBus } = require('./WidgetEventBus');
const { AIWidgetInterface, aiWidgetInterface } = require('./AIWidgetInterface');
const { SharedContextStore, sharedContextStore } = require('./SharedContextStore');
const { WorkflowOrchestrator, workflowOrchestrator } = require('./WorkflowOrchestrator');

class WidgetEcosystem {
  constructor() {
    this.eventBus = widgetEventBus;
    this.aiInterface = aiWidgetInterface;
    this.contextStore = sharedContextStore;
    this.orchestrator = workflowOrchestrator;
    
    this.registeredWidgets = new Map();
    this.debugMode = false;
  }

  /**
   * Register a widget in the complete ecosystem
   */
  registerWidget(widgetId, widget) {
    if (this.registeredWidgets.has(widgetId)) {
      throw new Error(`Widget ${widgetId} is already registered`);
    }

    // Validate widget interface
    this.validateWidgetInterface(widget);

    // Register with all subsystems
    this.eventBus.registerWidget(widgetId, widget);
    this.aiInterface.registerWidget(widgetId, widget);
    
    // Store reference
    this.registeredWidgets.set(widgetId, {
      widget,
      registeredAt: Date.now(),
      metadata: {
        type: widget.constructor.name,
        capabilities: widget.getAICapabilities ? widget.getAICapabilities() : [],
        interestedEvents: widget.interestedEvents || []
      }
    });

    if (this.debugMode) {
      console.log(`🌐 Widget registered in ecosystem: ${widgetId} (${widget.constructor.name})`);
    }

    // Emit ecosystem event
    this.eventBus.emit('widget-registered', {
      widgetId,
      type: widget.constructor.name,
      capabilities: widget.getAICapabilities ? widget.getAICapabilities() : []
    }, 'ecosystem');

    return {
      widgetId,
      registered: true,
      subsystems: ['eventBus', 'aiInterface']
    };
  }

  /**
   * Unregister a widget from the ecosystem
   */
  unregisterWidget(widgetId) {
    if (!this.registeredWidgets.has(widgetId)) {
      return false;
    }

    // Unregister from subsystems
    this.eventBus.unregisterWidget(widgetId);
    // Note: AIWidgetInterface doesn't have unregister method yet

    // Remove reference
    this.registeredWidgets.delete(widgetId);

    if (this.debugMode) {
      console.log(`🌐 Widget unregistered from ecosystem: ${widgetId}`);
    }

    // Emit ecosystem event
    this.eventBus.emit('widget-unregistered', { widgetId }, 'ecosystem');

    return true;
  }

  /**
   * Validate widget interface compliance
   */
  validateWidgetInterface(widget) {
    const errors = [];

    // Check required methods
    if (typeof widget.handleEvent !== 'function') {
      errors.push('Widget must implement handleEvent(event, eventBus) method');
    }

    if (typeof widget.handleAICommand !== 'function') {
      errors.push('Widget must implement handleAICommand(action, params, context) method');
    }

    // Check optional but recommended properties
    if (!widget.interestedEvents || !Array.isArray(widget.interestedEvents)) {
      console.warn(`⚠️ Widget ${widget.constructor.name} should define interestedEvents array`);
    }

    if (typeof widget.getAICapabilities !== 'function') {
      console.warn(`⚠️ Widget ${widget.constructor.name} should implement getAICapabilities() method`);
    }

    if (errors.length > 0) {
      throw new Error(`Widget interface validation failed:\n- ${errors.join('\n- ')}`);
    }
  }

  /**
   * Send event between widgets
   */
  sendEvent(eventType, data, sourceWidgetId) {
    return this.eventBus.emit(eventType, data, sourceWidgetId);
  }

  /**
   * Send AI command to widget
   */
  async sendAICommand(widgetType, action, params, context) {
    return await this.aiInterface.command(widgetType, action, params, context);
  }

  /**
   * Set shared context data
   */
  setContext(contextPath, data, source) {
    return this.contextStore.set(contextPath, data, source);
  }

  /**
   * Get shared context data
   */
  getContext(contextPath) {
    return this.contextStore.get(contextPath);
  }

  /**
   * Subscribe to context changes
   */
  subscribeToContext(widgetId, contextPath, callback) {
    return this.contextStore.subscribe(widgetId, contextPath, callback);
  }

  /**
   * Start a workflow
   */
  async startWorkflow(templateId, params, context) {
    return await this.orchestrator.startWorkflow(templateId, params, context);
  }

  /**
   * Register a workflow template
   */
  registerWorkflowTemplate(templateId, template) {
    return this.orchestrator.registerTemplate(templateId, template);
  }

  /**
   * Get ecosystem overview
   */
  getOverview() {
    return {
      registeredWidgets: Array.from(this.registeredWidgets.keys()),
      widgetDetails: Array.from(this.registeredWidgets.entries()).map(([id, registration]) => ({
        id,
        type: registration.metadata.type,
        capabilities: registration.metadata.capabilities,
        interestedEvents: registration.metadata.interestedEvents,
        registeredAt: new Date(registration.registeredAt).toISOString()
      })),
      eventBus: this.eventBus.getStats(),
      aiInterface: this.aiInterface.getStats(),
      contextStore: this.contextStore.getStats(),
      orchestrator: this.orchestrator.getStats()
    };
  }

  /**
   * Enable/disable debug mode for entire ecosystem
   */
  setDebugMode(enabled) {
    this.debugMode = enabled;
    this.eventBus.setDebugMode(enabled);
    this.aiInterface.setDebugMode(enabled);
    this.contextStore.setDebugMode(enabled);
    this.orchestrator.setDebugMode(enabled);
    
    console.log(`🌐 Widget Ecosystem debug mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Health check for ecosystem
   */
  healthCheck() {
    const health = {
      status: 'healthy',
      issues: [],
      subsystems: {
        eventBus: { status: 'operational', registeredWidgets: this.eventBus.getStats().registeredWidgets },
        aiInterface: { status: 'operational', activeWidgets: this.aiInterface.getStats().activeWidgets },
        contextStore: { status: 'operational', totalContexts: this.contextStore.getStats().totalContexts },
        orchestrator: { status: 'operational', activeWorkflows: this.orchestrator.getStats().activeWorkflows }
      },
      timestamp: Date.now()
    };

    // Check for potential issues
    if (this.registeredWidgets.size === 0) {
      health.issues.push('No widgets registered in ecosystem');
      health.status = 'warning';
    }

    if (this.eventBus.getStats().registeredWidgets === 0) {
      health.issues.push('No widgets registered with event bus');
      health.status = 'warning';
    }

    if (health.issues.length > 2) {
      health.status = 'degraded';
    }

    return health;
  }

  /**
   * Initialize ecosystem with sample data (for testing)
   */
  async initializeSampleEcosystem() {
    console.log('🌐 Initializing sample widget ecosystem...');

    // Sample workflow templates
    this.registerWorkflowTemplate('demo-project-setup', {
      name: 'Demo Project Setup',
      description: 'Demonstrates multi-widget coordination',
      steps: [
        {
          id: 'create-context',
          type: 'context-operation',
          operation: 'set',
          params: {
            path: 'demo.project',
            data: {
              name: 'Demo Project',
              status: 'initializing',
              createdAt: new Date().toISOString()
            }
          }
        }
      ]
    });

    // Sample context data
    this.setContext('system.initialized', {
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      features: ['inter-widget-communication', 'ai-commands', 'shared-context', 'workflow-orchestration']
    }, 'ecosystem');

    console.log('✅ Sample ecosystem initialized');
    return this.getOverview();
  }

  /**
   * Export ecosystem state (for persistence/debugging)
   */
  exportState() {
    return {
      registeredWidgets: Array.from(this.registeredWidgets.entries()),
      eventHistory: this.eventBus.getEventHistory(100),
      commandHistory: this.aiInterface.getCommandHistory(50),
      contextData: this.contextStore.getContexts(),
      workflowTemplates: this.orchestrator.getTemplates(),
      activeWorkflows: this.orchestrator.getActiveWorkflows(),
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Performance benchmark
   */
  async benchmark() {
    console.log('🏃 Running ecosystem performance benchmark...');
    
    const results = {
      eventEmission: null,
      aiCommand: null,
      contextOperation: null,
      workflow: null
    };

    // Benchmark event emission
    const eventStart = Date.now();
    this.sendEvent('benchmark-test', { data: 'test' }, 'benchmark');
    results.eventEmission = Date.now() - eventStart;

    // Benchmark context operation
    const contextStart = Date.now();
    this.setContext('benchmark.test', { value: Math.random() }, 'benchmark');
    this.getContext('benchmark.test');
    results.contextOperation = Date.now() - contextStart;

    console.log('📊 Benchmark Results:');
    console.log(`  Event Emission: ${results.eventEmission}ms`);
    console.log(`  Context Operation: ${results.contextOperation}ms`);

    return results;
  }
}

// Create singleton instance
const widgetEcosystem = new WidgetEcosystem();

// Export both class and singleton
module.exports = {
  WidgetEcosystem,
  widgetEcosystem,
  
  // Export individual components for direct access
  WidgetEventBus,
  widgetEventBus,
  AIWidgetInterface,
  aiWidgetInterface,
  SharedContextStore,
  sharedContextStore,
  WorkflowOrchestrator,
  workflowOrchestrator
};