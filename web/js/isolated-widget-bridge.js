/**
 * Isolated Widget Bridge - Connects Direct Router to Isolated Framework
 * NO CHAT DEPENDENCIES - Pure widget isolation
 */

const { directWidgetRouter } = require('./direct-widget-router');

class IsolatedWidgetBridge {
  constructor() {
    this.isolatedWidgets = new Map();
    this.activeConnections = new Map();
    this.initialized = false;
  }

  /**
   * Initialize the bridge with chat bypass
   */
  async initialize() {
    if (this.initialized) return;
    
    console.log('🌉 Initializing Isolated Widget Bridge...');
    
    // Enable complete chat bypass
    directWidgetRouter.setChatBypass(true, 'Widget isolation bridge activated');
    
    // Register default widgets
    await this.registerDefaultWidgets();
    
    // Set up UserAction interception
    this.setupUserActionInterception();
    
    this.initialized = true;
    console.log('✅ Isolated Widget Bridge initialized - Chat completely bypassed');
  }

  /**
   * Register default isolated widgets
   */
  async registerDefaultWidgets() {
    // Memory Protection Widget
    const memoryProtectionWidget = this.createMemoryProtectionWidget();
    await this.registerWidget('memory-protection', memoryProtectionWidget, {
      actionPrefixes: ['enable-memory-protection', 'memory-protection'],
      componentPrefixes: ['enable-protection', 'memory-']
    });

    // Standard Notes Widget (if available)
    try {
      const StandardNotesWidget = require('../genui-engine/templates/notes');
      const notesWidget = new StandardNotesWidget();
      await this.registerWidget('notes', this.wrapStandardNotesWidget(notesWidget), {
        actionPrefixes: ['sn-', 'notes-'],
        componentPrefixes: ['sn-', 'notes-']
      });
      console.log('📝 Standard Notes widget registered for direct routing');
    } catch (error) {
      console.log('⚠️ Standard Notes widget not available for direct routing');
    }
  }

  /**
   * Register a widget for direct routing (NO chat)
   */
  async registerWidget(widgetId, widget, routingRules = {}) {
    // Validate widget for isolation
    this.validateWidgetIsolation(widget);
    
    // Wrap with isolation layer
    const isolatedWidget = this.wrapWithIsolation(widget, widgetId);
    
    // Store locally
    this.isolatedWidgets.set(widgetId, isolatedWidget);
    
    // Register with direct router
    directWidgetRouter.registerIsolatedWidget(widgetId, isolatedWidget, routingRules);
    
    console.log(`🔒 Widget registered in isolation bridge: ${widgetId}`);
    return isolatedWidget;
  }

  /**
   * Create Memory Protection Widget for direct routing
   */
  createMemoryProtectionWidget() {
    return {
      async executeCommand(command, params, context) {
        switch (command) {
          case 'enable-memory-protection-confirmed':
            return await this.handleMemoryProtectionActivation(params, context);
          case 'cancel-memory-protection':
            return this.handleMemoryProtectionCancel();
          default:
            throw new Error(`Unknown memory protection command: ${command}`);
        }
      },

      async handleMemoryProtectionActivation(params, context) {
        // Validate consent
        if (!params.explicit_consent || !params.data_understanding) {
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
            ],
            directRouted: true,
            chatBypassed: true
          };
        }

        // Initialize memory protection
        try {
          const { memoryProtection } = require('../genui-engine/memory-protection-hooks');
          const activated = await memoryProtection.initializeProtection(true);
          
          if (activated) {
            return {
              ops: [
                { op: "clear" },
                {
                  op: "upsert",
                  id: "protection-activated",
                  type: "alert",
                  data: {
                    title: "🛡️ Memory Protection Activated",
                    message: `Auto-save active every ${params.auto_save_interval} seconds. All session data will be continuously protected.`,
                    severity: "success"
                  },
                  layout: { zone: "auto" }
                },
                {
                  op: "upsert",
                  id: "protection-status",
                  type: "kv",
                  data: {
                    title: "🔧 Protection Settings",
                    items: [
                      { key: "Status", value: "✅ ACTIVE" },
                      { key: "Auto-save Interval", value: `${params.auto_save_interval} seconds` },
                      { key: "Project Memory", value: params.project_memory ? "✅ Enabled" : "❌ Disabled" },
                      { key: "Chat Bypass", value: "✅ Complete isolation" },
                      { key: "Abort Protection", value: "✅ Active" }
                    ]
                  },
                  layout: { zone: "auto" }
                }
              ],
              directRouted: true,
              chatBypassed: true,
              memoryProtectionActive: true
            };
          }
        } catch (error) {
          return {
            ops: [
              { op: "clear" },
              {
                op: "upsert",
                id: "activation-error",
                type: "alert",
                data: {
                  title: "❌ Activation Failed",
                  message: `Memory protection activation failed: ${error.message}`,
                  severity: "error"
                },
                layout: { zone: "auto" }
              }
            ],
            directRouted: true,
            chatBypassed: true,
            error: error.message
          };
        }
      },

      handleMemoryProtectionCancel() {
        return {
          ops: [
            { op: "clear" },
            {
              op: "upsert",
              id: "protection-cancelled",
              type: "alert",
              data: {
                title: "❌ Memory Protection Cancelled",
                message: "Memory protection was not activated. Manual saves only.",
                severity: "info"
              },
              layout: { zone: "auto" }
            }
          ],
          directRouted: true,
          chatBypassed: true,
          cancelled: true
        };
      },

      getMetadata() {
        return {
          widgetId: 'memory-protection',
          isolated: true,
          chatBypass: true,
          capabilities: ['memory-protection-activation', 'consent-validation']
        };
      }
    };
  }

  /**
   * Wrap Standard Notes widget for isolation
   */
  wrapStandardNotesWidget(notesWidget) {
    return {
      async executeCommand(command, params, context) {
        // Route to Standard Notes widget's AI command handler
        return await notesWidget.handleAICommand(command, params, {
          ...context,
          isolated: true,
          chatBypassed: true
        });
      },

      getMetadata() {
        return {
          widgetId: 'notes',
          isolated: true,
          chatBypass: true,
          capabilities: notesWidget.getAICapabilities ? notesWidget.getAICapabilities() : []
        };
      }
    };
  }

  /**
   * Validate widget for complete isolation
   */
  validateWidgetIsolation(widget) {
    if (!widget.executeCommand) {
      throw new Error('Widget must implement executeCommand method for isolation');
    }
    
    if (widget.requiresChatHooks === true) {
      throw new Error('Widget declares chat hook dependency - isolation impossible');
    }
    
    return true;
  }

  /**
   * Wrap widget with isolation enforcement
   */
  wrapWithIsolation(widget, widgetId) {
    return {
      async executeCommand(command, params, context = {}) {
        // Enforce isolation context
        const isolatedContext = {
          ...context,
          widgetId,
          isolated: true,
          chatBypassed: true,
          directRouting: true,
          timestamp: Date.now()
        };
        
        // Execute with isolation
        try {
          const result = await widget.executeCommand(command, params, isolatedContext);
          
          return {
            ...result,
            widgetId,
            isolated: true,
            chatBypassed: true
          };
        } catch (error) {
          console.error(`❌ Isolated widget error (${widgetId}):`, error);
          throw error;
        }
      },

      getMetadata() {
        return {
          ...widget.getMetadata(),
          isolated: true,
          chatBypassed: true,
          bridged: true
        };
      }
    };
  }

  /**
   * Set up UserAction interception at the browser level
   */
  setupUserActionInterception() {
    // Override form submission handling
    if (typeof window !== 'undefined') {
      // Intercept form submissions that would create UserActions
      document.addEventListener('submit', (event) => {
        const form = event.target;
        if (form.dataset && form.dataset.widgetForm === 'true') {
          event.preventDefault();
          this.handleFormSubmissionDirectly(form);
        }
      });

      // Intercept button clicks for widget actions
      document.addEventListener('click', (event) => {
        const button = event.target;
        if (button.dataset && button.dataset.widgetAction) {
          event.preventDefault();
          this.handleWidgetActionDirectly(button);
        }
      });
    }
  }

  /**
   * Handle form submission directly (NO chat)
   */
  async handleFormSubmissionDirectly(form) {
    const formData = new FormData(form);
    const action = form.dataset.action || 'submit';
    const componentId = form.id || 'unknown';
    
    // Convert form data to params
    const params = {};
    for (const [key, value] of formData.entries()) {
      params[key] = value;
    }
    
    const userAction = {
      surfaceId: 'main',
      componentId,
      action,
      context: params
    };
    
    try {
      const result = await directWidgetRouter.routeUserActionDirectly(userAction);
      this.renderWidgetResponse(result);
    } catch (error) {
      console.error('❌ Direct form handling failed:', error);
    }
  }

  /**
   * Handle widget action directly (NO chat)
   */
  async handleWidgetActionDirectly(button) {
    const action = button.dataset.widgetAction;
    const componentId = button.dataset.componentId || 'unknown';
    
    const userAction = {
      surfaceId: 'main',
      componentId,
      action,
      context: {}
    };
    
    try {
      const result = await directWidgetRouter.routeUserActionDirectly(userAction);
      this.renderWidgetResponse(result);
    } catch (error) {
      console.error('❌ Direct action handling failed:', error);
    }
  }

  /**
   * Render widget response directly to UI
   */
  renderWidgetResponse(result) {
    if (result && result.ops && typeof window !== 'undefined' && window.CanvasRenderer) {
      // Use existing canvas renderer
      const renderer = new window.CanvasRenderer();
      renderer.renderOperations(result.ops);
    }
  }

  /**
   * Get bridge status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      isolatedWidgets: Array.from(this.isolatedWidgets.keys()),
      routingStatus: directWidgetRouter.getRoutingStatus(),
      chatBypassed: true,
      activeConnections: this.activeConnections.size
    };
  }
}

// Create and export singleton
const isolatedWidgetBridge = new IsolatedWidgetBridge();

// Auto-initialize if in browser (not in Node.js server context)
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      isolatedWidgetBridge.initialize().catch(console.error);
    });
  } else {
    isolatedWidgetBridge.initialize().catch(console.error);
  }
}

module.exports = {
  IsolatedWidgetBridge,
  isolatedWidgetBridge
};