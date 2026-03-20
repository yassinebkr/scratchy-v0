/**
 * Scratchy Complete Integration - Widget Ecosystem + Standard Notes
 * 
 * This module integrates the complete widget ecosystem into Scratchy:
 * - Widget Event Bus for inter-widget communication
 * - AI Widget Interface for direct AI commands
 * - Shared Context Store for cross-widget data
 * - Workflow Orchestrator for multi-widget coordination
 * - Standard Notes widget as the first autonomous widget
 * - UserAction handling for widget autonomy
 */

const { widgetEcosystem } = require('./widget-ecosystem');
const StandardNotesWidget = require('./templates/notes');

class ScratchyCompleteIntegration {
  constructor() {
    this.ecosystem = widgetEcosystem;
    this.registeredWidgets = new Map();
    this.debugMode = false;
    
    // Initialize the ecosystem
    this.initializeEcosystem();
  }

  /**
   * Initialize the widget ecosystem with Standard Notes
   */
  initializeEcosystem() {
    console.log('🌐 [Scratchy] Initializing complete widget ecosystem...');
    
    // Enable debug mode for initial setup
    if (process.env.NODE_ENV === 'development') {
      this.ecosystem.setDebugMode(true);
      this.debugMode = true;
    }

    // Register Standard Notes widget
    this.registerStandardNotesWidget();
    
    // Register built-in workflow templates
    this.registerWorkflowTemplates();
    
    // Set up global context
    this.initializeGlobalContext();
    
    console.log('✅ [Scratchy] Widget ecosystem initialized');
    console.log(`🔧 [Scratchy] Registered widgets: ${Array.from(this.registeredWidgets.keys()).join(', ')}`);
  }

  /**
   * Register the Standard Notes widget
   */
  registerStandardNotesWidget() {
    try {
      const notesWidget = new StandardNotesWidget();
      
      // Add ecosystem-required methods if missing
      if (!notesWidget.handleEvent) {
        notesWidget.handleEvent = (event, eventBus) => {
          if (this.debugMode) {
            console.log(`📝 [Notes] Received event: ${event.type}`);
          }
          
          // Handle events relevant to notes
          switch (event.type) {
            case 'task-created':
              if (event.data.needsNote) {
                setTimeout(() => {
                  eventBus.emit('note-suggestion', {
                    taskId: event.data.taskId,
                    suggestedTitle: `Notes for: ${event.data.title}`,
                    reason: 'task-created'
                  }, 'notes');
                }, 100);
              }
              break;
            
            case 'project-created':
              setTimeout(() => {
                eventBus.emit('project-docs-suggested', {
                  projectId: event.data.projectId,
                  templates: ['README', 'MEETING_NOTES', 'TECHNICAL_SPECS']
                }, 'notes');
              }, 100);
              break;
          }
        };
      }

      // Add AI capabilities method if missing
      if (!notesWidget.getAICapabilities) {
        notesWidget.getAICapabilities = () => [
          'createNote',
          'editNote', 
          'searchNotes',
          'listNotes',
          'deleteNote',
          'authenticateWithStandardNotes'
        ];
      }

      // Set interested events
      if (!notesWidget.interestedEvents) {
        notesWidget.interestedEvents = [
          'task-created',
          'project-created',
          'meeting-scheduled',
          'user-action',
          '*'
        ];
      }

      // Register with ecosystem
      this.ecosystem.registerWidget('notes', notesWidget);
      this.registeredWidgets.set('notes', notesWidget);
      
      console.log('📝 [Scratchy] Standard Notes widget registered');
      
    } catch (error) {
      console.error('❌ [Scratchy] Failed to register Standard Notes widget:', error);
    }
  }

  /**
   * Register workflow templates for common user scenarios
   */
  registerWorkflowTemplates() {
    // Daily Planning Workflow
    this.ecosystem.registerWorkflowTemplate('daily-planning', {
      name: 'Daily Planning Session',
      description: 'Prepare for the day by reviewing notes, tasks, and schedule',
      steps: [
        {
          id: 'review-notes',
          type: 'widget-command',
          widgetType: 'notes',
          action: 'searchNotes',
          params: {
            query: 'today OR tomorrow OR urgent',
            limit: 10
          },
          storeResult: 'daily.todayNotes'
        },
        {
          id: 'create-daily-summary',
          type: 'widget-command',
          widgetType: 'notes',
          action: 'createNote',
          params: {
            title: 'Daily Plan - ${context.date}',
            content: 'Generated daily planning summary...',
            tags: ['daily', 'planning']
          }
        }
      ]
    });

    // Quick Capture Workflow
    this.ecosystem.registerWorkflowTemplate('quick-capture', {
      name: 'Quick Idea Capture',
      description: 'Rapidly capture ideas across multiple widgets',
      steps: [
        {
          id: 'save-idea',
          type: 'widget-command',
          widgetType: 'notes',
          action: 'createNote',
          params: {
            title: '${params.title}',
            content: '${params.content}',
            tags: ['idea', 'quick-capture']
          }
        }
      ]
    });

    console.log('📋 [Scratchy] Workflow templates registered');
  }

  /**
   * Initialize global context with system information
   */
  initializeGlobalContext() {
    this.ecosystem.contextStore.set('system.scratchy', {
      version: '2.0.0',
      ecosystem: 'complete',
      startTime: new Date().toISOString(),
      features: [
        'autonomous-widgets',
        'inter-widget-communication', 
        'ai-orchestration',
        'shared-context',
        'workflow-orchestration'
      ]
    }, 'system');

    this.ecosystem.contextStore.set('user.session', {
      startTime: new Date().toISOString(),
      widgetsAvailable: Array.from(this.registeredWidgets.keys())
    }, 'system');
  }

  /**
   * Main message processing with DIRECT WIDGET ROUTING
   */
  async processMessage(message, context = {}, statusCallback = null) {
    const startTime = Date.now();
    
    if (this.debugMode) {
      console.log(`🧠 [Scratchy] Processing message: "${message.slice(0, 50)}..."`);
    }

    try {
      // FIRST: Check for direct widget routing (BYPASS CHAT)
      if (this.isUserAction(message)) {
        console.log('🎯 UserAction detected - routing DIRECTLY to isolated widget (bypassing chat)');
        return await this.routeDirectlyToWidget(message, context, statusCallback);
      }

      // Regular message processing through intent classification
      // Note: We need to access the ScratchyGenUIEngine from the ecosystem
      // For now, use a simple fallback until we integrate properly
      const result = await this.processMessageThroughEcosystem(message, context, statusCallback);

      const processingTime = Date.now() - startTime;
      
      if (this.debugMode) {
        console.log(`✅ [Scratchy] Processed in ${processingTime}ms - Tier ${result.tier}, ${result.ops?.length || 0} components`);
      }

      // Store interaction in shared context
      this.ecosystem.contextStore.set('interactions.latest', {
        message: message.slice(0, 100),
        result: {
          tier: result.tier,
          layoutType: result.layoutType,
          componentCount: result.ops?.length || 0,
          processingTime
        },
        timestamp: new Date().toISOString()
      }, 'system');

      return result;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`❌ [Scratchy] Processing error (${processingTime}ms):`, error);
      
      // Return error UI
      return {
        ops: [
          { op: "clear" },
          {
            op: "upsert",
            id: "error",
            type: "alert",
            data: {
              title: "⚠️ Processing Error",
              message: `Sorry, something went wrong: ${error.message}`,
              severity: "error"
            },
            layout: { zone: "auto" }
          }
        ],
        source: 'error-handler',
        tier: 3,
        layoutType: 'error',
        processingTime
      };
    }
  }

  /**
   * Process message through the ecosystem using our intent classification
   */
  async processMessageThroughEcosystem(message, context = {}, statusCallback = null) {
    // Import the ScratchyGenUIEngine here to avoid circular imports
    const { ScratchyGenUIEngine } = require('./scratchy-integration');
    
    if (!this.genUIEngine) {
      this.genUIEngine = new ScratchyGenUIEngine();
    }

    // Process through the 3-tier system
    return await this.genUIEngine.processMessage(message, context, statusCallback);
  }

  /**
   * Route UserAction DIRECTLY to widget - SIMPLE & WORKING
   */
  async routeDirectlyToWidget(message, context = {}, statusCallback = null) {
    if (this.debugMode) {
      console.log('🎯 [Scratchy] SIMPLE DIRECT ROUTING - No over-engineering');
    }

    try {
      // Use simple widget router (no complex layers)
      const { simpleWidgetRouter } = require('../web/js/simple-widget-router');
      
      // Route directly to widget - clean and simple
      const result = await simpleWidgetRouter.routeUserActionDirectly(message);
      
      console.log('✅ Simple direct routing successful - Widget executed directly');
      
      return {
        ...result,
        source: 'simple-direct-routing',
        tier: 1, // Direct routing is instant
        chatBypassed: true,
        simple: true
      };
      
    } catch (error) {
      console.error('❌ Simple direct routing failed:', error);
      
      // Simple error response
      return {
        ops: [
          { op: "clear" },
          {
            op: "upsert",
            id: "simple-routing-error",
            type: "alert",
            data: {
              title: "⚠️ Widget Error",
              message: `Error: ${error.message}`,
              severity: "error"
            },
            layout: { zone: "auto" }
          }
        ],
        source: 'simple-routing-error',
        tier: 1,
        chatBypassed: true,
        error: error.message
      };
    }
  }

  /**
   * OLD METHOD - Handle UserAction through chat (DEPRECATED)
   * This method should NOT be used anymore - kept for compatibility only
   */
  async handleUserAction(message, context = {}, statusCallback = null) {
    console.warn('⚠️ DEPRECATED: handleUserAction called - should use routeDirectlyToWidget');
    
    if (this.debugMode) {
      console.log('🎯 [Scratchy] Handling UserAction:', message.slice(0, 100));
    }

    // Parse UserAction from message
    // Format: [UserAction] {"surfaceId":"main","componentId":"sn-auth","action":"sn-authenticate","context":{...}}
    const match = message.match(/\[UserAction\]\s*(\{.*\})/);
    if (!match) {
      throw new Error('Invalid UserAction format');
    }

    const userAction = JSON.parse(match[1]);
    const { surfaceId, componentId, action, context: actionContext } = userAction;

    // Determine which widget should handle this action
    const widgetType = this.determineWidgetFromAction(action, componentId);
    if (!widgetType) {
      throw new Error(`No widget found to handle action: ${action}`);
    }

    if (this.debugMode) {
      console.log(`🎯 [Scratchy] Routing action '${action}' to widget '${widgetType}'`);
    }

    // Route to appropriate widget via ecosystem
    const result = await this.ecosystem.aiInterface.command(
      widgetType,
      'handleUserAction', 
      { action, context: actionContext },
      { userAction: true, surfaceId, componentId }
    );

    // Convert widget response to GenUI format
    return {
      ops: result.result?.ops || [],
      source: 'user-action-legacy',
      tier: 1, // UserActions are always instant
      layoutType: widgetType,
      processingTime: result.executionTime || 0,
      userAction: true,
      deprecated: true
    };
  }

  /**
   * Check if message is a UserAction
   */
  isUserAction(message) {
    return message.includes('[UserAction]') && message.includes('"action"');
  }

  /**
   * Determine which widget should handle an action
   */
  determineWidgetFromAction(action, componentId) {
    // Standard Notes actions
    if (action.startsWith('sn-') || componentId.startsWith('sn-')) {
      return 'notes';
    }

    // Task actions
    if (action.startsWith('task-') || componentId.startsWith('task-')) {
      return 'tasks';
    }

    // Calendar actions
    if (action.startsWith('cal-') || componentId.startsWith('cal-')) {
      return 'calendar';
    }

    // Email actions
    if (action.startsWith('email-') || componentId.startsWith('email-')) {
      return 'email';
    }

    // Generic form actions - route based on component ID
    if (componentId.includes('notes') || componentId.includes('sn')) {
      return 'notes';
    }

    // Default to first available widget
    return Array.from(this.registeredWidgets.keys())[0];
  }

  /**
   * Start a workflow by template ID
   */
  async startWorkflow(templateId, params = {}, context = {}) {
    return await this.ecosystem.startWorkflow(templateId, params, context);
  }

  /**
   * Get ecosystem status and statistics
   */
  getStatus() {
    return {
      ecosystem: this.ecosystem.getOverview(),
      health: this.ecosystem.healthCheck(),
      registeredWidgets: Array.from(this.registeredWidgets.keys()),
      debugMode: this.debugMode
    };
  }

  /**
   * Enable/disable debug mode
   */
  setDebugMode(enabled) {
    this.debugMode = enabled;
    this.ecosystem.setDebugMode(enabled);
    console.log(`🐛 [Scratchy] Complete integration debug mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Add a new widget to the ecosystem
   */
  async addWidget(widgetId, widgetClass, config = {}) {
    try {
      const widget = new widgetClass(config);
      this.ecosystem.registerWidget(widgetId, widget);
      this.registeredWidgets.set(widgetId, widget);
      
      console.log(`➕ [Scratchy] Added widget: ${widgetId}`);
      return true;
    } catch (error) {
      console.error(`❌ [Scratchy] Failed to add widget ${widgetId}:`, error);
      return false;
    }
  }

  /**
   * Remove a widget from the ecosystem
   */
  removeWidget(widgetId) {
    const removed = this.ecosystem.unregisterWidget(widgetId);
    if (removed) {
      this.registeredWidgets.delete(widgetId);
      console.log(`➖ [Scratchy] Removed widget: ${widgetId}`);
    }
    return removed;
  }

  /**
   * Export complete system state for debugging
   */
  exportSystemState() {
    return {
      ...this.ecosystem.exportState(),
      registeredWidgets: Array.from(this.registeredWidgets.keys()),
      systemContext: {
        scratchy: this.ecosystem.contextStore.get('system.scratchy'),
        userSession: this.ecosystem.contextStore.get('user.session'),
        latestInteraction: this.ecosystem.contextStore.get('interactions.latest')
      }
    };
  }
}

// Create singleton instance
const scratchyCompleteIntegration = new ScratchyCompleteIntegration();

module.exports = {
  ScratchyCompleteIntegration,
  scratchyCompleteIntegration
};