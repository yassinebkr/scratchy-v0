/**
 * Simple Widget Router - DIRECT Integration
 * No over-engineering, just works with industry-grade widgets
 */

class SimpleWidgetRouter {
  constructor() {
    this.widgets = new Map();
    this.debugMode = true;
    
    console.log('🎯 Simple Widget Router initialized - Direct widget integration');
  }

  /**
   * Register a widget - just store it, no complexity
   */
  registerWidget(widgetId, widgetInstance) {
    this.widgets.set(widgetId, widgetInstance);
    console.log(`📝 Registered widget: ${widgetId}`);
  }

  /**
   * Route UserAction DIRECTLY to widget - no layers, no complexity
   */
  async routeUserActionDirectly(userActionMessage) {
    if (this.debugMode) {
      console.log('🎯 Simple routing - parsing UserAction');
    }

    try {
      // Parse UserAction from message
      const match = userActionMessage.match(/\[UserAction\]\s*(\{.*\})/);
      if (!match) {
        throw new Error('Invalid UserAction format');
      }

      const userAction = JSON.parse(match[1]);
      const { componentId = 'unknown', action, context } = userAction;

      if (this.debugMode) {
        console.log(`🎯 Parsed action: ${action} for component: ${componentId}`);
      }

      // Determine target widget (simple routing)
      let targetWidget = null;
      let targetWidgetId = null;

      // Standard Notes widget
      if (action.startsWith('sn-') || (componentId && componentId.includes('sn-'))) {
        targetWidget = this.widgets.get('notes');
        targetWidgetId = 'notes';
      }
      // Memory protection widget  
      else if (action.includes('memory-protection') || (componentId && (componentId.includes('memory') || componentId.includes('protection')))) {
        targetWidget = this.widgets.get('memory-protection');
        targetWidgetId = 'memory-protection';
      }

      if (!targetWidget) {
        throw new Error(`No widget found for action: ${action}`);
      }

      if (this.debugMode) {
        console.log(`🎯 Routing to widget: ${targetWidgetId}`);
      }

      // Call widget DIRECTLY - no enterprise layers blocking it
      const result = await targetWidget.handleUserAction(action, context);

      if (this.debugMode) {
        console.log(`✅ Widget returned result with ${result.ops?.length || 0} operations`);
      }

      return {
        ...result,
        routedBy: 'simple-widget-router',
        targetWidget: targetWidgetId,
        direct: true
      };

    } catch (error) {
      console.error('❌ Simple routing failed:', error);
      
      return {
        ops: [
          { op: "clear" },
          {
            op: "upsert",
            id: "simple-routing-error",
            type: "alert",
            data: {
              title: "⚠️ Widget Error",
              message: error.message,
              severity: "error"
            },
            layout: { zone: "auto" }
          }
        ],
        error: true
      };
    }
  }

  /**
   * Get simple status
   */
  getStatus() {
    return {
      registeredWidgets: Array.from(this.widgets.keys()),
      totalWidgets: this.widgets.size,
      debugMode: this.debugMode
    };
  }
}

// Create singleton
const simpleWidgetRouter = new SimpleWidgetRouter();

// Auto-register the Standard Notes widget if available
try {
  const StandardNotesWidget = require('../genui-engine/templates/notes');
  const notesWidget = new StandardNotesWidget();
  simpleWidgetRouter.registerWidget('notes', notesWidget);
  console.log('📝 Standard Notes widget auto-registered');
} catch (error) {
  console.log('⚠️ Standard Notes widget not available:', error.message);
}

// Auto-register memory protection widget
const memoryProtectionWidget = {
  async handleUserAction(action, context) {
    switch (action) {
      case 'enable-memory-protection-confirmed':
        // Validate consent
        if (!context.explicit_consent || !context.data_understanding) {
          return {
            ops: [
              { op: "clear" },
              {
                op: "upsert",
                id: "consent-error",
                type: "alert",
                data: {
                  title: "⚠️ Consent Required",
                  message: "Both consent checkboxes must be checked to activate memory protection",
                  severity: "warning"
                },
                layout: { zone: "auto" }
              }
            ]
          };
        }

        // Simulate memory protection activation
        return {
          ops: [
            { op: "clear" },
            {
              op: "upsert",
              id: "protection-activated",
              type: "alert",
              data: {
                title: "🛡️ Memory Protection Activated (Simulated)",
                message: `Auto-save would be active every ${context.auto_save_interval} seconds. This is a direct widget call demonstration.`,
                severity: "success"
              },
              layout: { zone: "auto" }
            },
            {
              op: "upsert",
              id: "direct-routing-success",
              type: "card",
              data: {
                title: "🎯 Direct Routing Success",
                text: "✅ UserAction routed DIRECTLY to widget\n✅ No enterprise layers blocking execution\n✅ Widget processed action and returned ops\n✅ Simple, clean, working integration"
              },
              layout: { zone: "auto" }
            }
          ]
        };

      default:
        throw new Error(`Unknown memory protection action: ${action}`);
    }
  }
};

simpleWidgetRouter.registerWidget('memory-protection', memoryProtectionWidget);

// Export for global access
if (typeof window !== 'undefined') {
  window.simpleWidgetRouter = simpleWidgetRouter;
}

module.exports = {
  SimpleWidgetRouter,
  simpleWidgetRouter
};