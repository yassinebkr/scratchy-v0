/**
 * Isolated Widget Framework - Chat-Independent Architecture
 * Widgets operate standalone with no chat hooks or dependencies
 */

const { memoryProtection } = require('./memory-protection-hooks');

class IsolatedWidgetFramework {
  constructor() {
    this.widgets = new Map();
    this.widgetConfigs = new Map();
    this.isolationLevel = 'STRICT'; // STRICT | MODERATE | MINIMAL
    this.chatHooksBlocked = true;
  }

  /**
   * Register a widget with strict isolation
   */
  registerIsolatedWidget(widgetId, widgetClass, config = {}) {
    // Validate widget isolation compliance
    this.validateWidgetIsolation(widgetClass);
    
    // Create widget instance with isolation wrapper
    const widget = new widgetClass(config);
    const isolatedWidget = this.wrapWithIsolation(widget, widgetId);
    
    // Store with isolation metadata
    this.widgets.set(widgetId, isolatedWidget);
    this.widgetConfigs.set(widgetId, {
      ...config,
      isolationLevel: this.isolationLevel,
      chatHooksAllowed: false,
      registeredAt: Date.now()
    });
    
    // Log to memory protection if active
    memoryProtection.markChanged('widget_registered', 
      `Isolated widget registered: ${widgetId} (${widgetClass.name})`);
    
    console.log(`🔒 Isolated widget registered: ${widgetId}`);
    return isolatedWidget;
  }

  /**
   * Validate widget follows isolation principles
   */
  validateWidgetIsolation(widgetClass) {
    const violations = [];
    const instance = new widgetClass({});
    
    // Check for chat dependencies
    if (instance.requiresChatHooks) {
      violations.push('Widget declares chat hook dependency');
    }
    
    // Check for global state access
    if (instance.accessesGlobalState) {
      violations.push('Widget accesses global state');
    }
    
    // Check for external communication without isolation
    if (instance.directExternalCalls && !instance.isolatedExternalCalls) {
      violations.push('Widget makes uncontrolled external calls');
    }
    
    // Check required isolation methods
    const requiredMethods = ['getState', 'setState', 'handleCommand', 'cleanup'];
    for (const method of requiredMethods) {
      if (typeof instance[method] !== 'function') {
        violations.push(`Missing required isolation method: ${method}`);
      }
    }
    
    if (violations.length > 0) {
      throw new Error(`Widget isolation violations:\n- ${violations.join('\n- ')}`);
    }
    
    return true;
  }

  /**
   * Wrap widget with isolation layer
   */
  wrapWithIsolation(widget, widgetId) {
    return {
      // Original widget (sandboxed)
      _widget: widget,
      _widgetId: widgetId,
      _isolated: true,
      
      // Controlled interface
      async executeCommand(command, params, context = {}) {
        // Block chat-originated commands if configured
        if (this.chatHooksBlocked && context.source === 'chat') {
          throw new Error('Chat-originated commands blocked for isolated widgets');
        }
        
        // Log command execution
        memoryProtection.markChanged('widget_command', 
          `Widget ${widgetId}: ${command} executed`);
        
        try {
          return await widget.handleCommand(command, params, context);
        } catch (error) {
          memoryProtection.markChanged('widget_error', 
            `Widget ${widgetId} error: ${error.message}`);
          throw error;
        }
      },
      
      // Safe state access
      getState() {
        return widget.getState ? widget.getState() : {};
      },
      
      // Controlled state updates
      setState(newState, source = 'internal') {
        if (source === 'chat' && this.chatHooksBlocked) {
          throw new Error('Chat-originated state updates blocked');
        }
        
        memoryProtection.markChanged('widget_state_change', 
          `Widget ${widgetId} state updated by ${source}`);
        
        return widget.setState(newState);
      },
      
      // Widget metadata
      getMetadata() {
        return {
          widgetId,
          isolated: true,
          chatHooksBlocked: this.chatHooksBlocked,
          isolationLevel: this.isolationLevel,
          className: widget.constructor.name
        };
      },
      
      // Clean shutdown
      async cleanup(reason = 'normal') {
        memoryProtection.markChanged('widget_cleanup', 
          `Widget ${widgetId} cleanup: ${reason}`);
        
        if (widget.cleanup) {
          await widget.cleanup();
        }
      }
    };
  }

  /**
   * Execute widget command with full isolation
   */
  async executeWidgetCommand(widgetId, command, params, context = {}) {
    const widget = this.widgets.get(widgetId);
    if (!widget) {
      throw new Error(`Widget not found: ${widgetId}`);
    }
    
    // Enforce isolation
    const isolatedContext = {
      ...context,
      isolated: true,
      chatHooksAllowed: false,
      executedAt: Date.now()
    };
    
    return await widget.executeCommand(command, params, isolatedContext);
  }

  /**
   * Get widget without breaking isolation
   */
  getWidgetInterface(widgetId) {
    const widget = this.widgets.get(widgetId);
    if (!widget) {
      return null;
    }
    
    // Return safe interface only
    return {
      widgetId,
      executeCommand: (cmd, params, ctx) => widget.executeCommand(cmd, params, ctx),
      getState: () => widget.getState(),
      getMetadata: () => widget.getMetadata(),
      isolated: true
    };
  }

  /**
   * List all isolated widgets
   */
  listWidgets() {
    const widgets = [];
    
    for (const [widgetId, widget] of this.widgets.entries()) {
      const config = this.widgetConfigs.get(widgetId);
      widgets.push({
        widgetId,
        className: widget._widget.constructor.name,
        isolated: true,
        config: {
          isolationLevel: config.isolationLevel,
          chatHooksAllowed: config.chatHooksAllowed,
          registeredAt: new Date(config.registeredAt).toISOString()
        },
        state: widget.getState()
      });
    }
    
    return widgets;
  }

  /**
   * Create chat-independent widget runner
   */
  createStandaloneRunner(widgetId) {
    const widget = this.widgets.get(widgetId);
    if (!widget) {
      throw new Error(`Widget not found: ${widgetId}`);
    }
    
    return {
      // Direct command execution (no chat involvement)
      async run(command, params = {}) {
        return await widget.executeCommand(command, params, {
          source: 'standalone',
          isolated: true,
          timestamp: Date.now()
        });
      },
      
      // Direct state access
      getState: () => widget.getState(),
      
      // Widget info
      info: () => widget.getMetadata()
    };
  }

  /**
   * Block all chat hooks (security measure)
   */
  blockChatHooks() {
    this.chatHooksBlocked = true;
    
    for (const widget of this.widgets.values()) {
      widget._chatHooksBlocked = true;
    }
    
    memoryProtection.markChanged('security_change', 'Chat hooks blocked for all widgets');
    console.log('🛡️ Chat hooks blocked for all widgets');
  }

  /**
   * Allow chat hooks (only when explicitly needed)
   */
  allowChatHooks(widgetId, reason) {
    if (!reason || reason.length < 10) {
      throw new Error('Chat hook allowance requires detailed reason');
    }
    
    const widget = this.widgets.get(widgetId);
    if (widget) {
      widget._chatHooksBlocked = false;
      memoryProtection.markChanged('security_exception', 
        `Chat hooks allowed for ${widgetId}: ${reason}`);
    }
    
    console.log(`⚠️ Chat hooks allowed for ${widgetId}: ${reason}`);
  }

  /**
   * Get system status
   */
  getSystemStatus() {
    return {
      isolationLevel: this.isolationLevel,
      chatHooksBlocked: this.chatHooksBlocked,
      totalWidgets: this.widgets.size,
      memoryProtection: memoryProtection.getStatus(),
      widgets: this.listWidgets().map(w => ({
        id: w.widgetId,
        className: w.className,
        isolated: w.isolated
      }))
    };
  }

  /**
   * Emergency isolation - lock down everything
   */
  emergencyIsolation(reason) {
    console.log(`🚨 Emergency isolation activated: ${reason}`);
    
    this.isolationLevel = 'MAXIMUM';
    this.chatHooksBlocked = true;
    
    // Lock down all widgets
    for (const [widgetId, widget] of this.widgets.entries()) {
      widget._emergencyLocked = true;
      widget._chatHooksBlocked = true;
    }
    
    memoryProtection.markChanged('emergency_isolation', 
      `Emergency isolation: ${reason}`);
    
    return {
      status: 'EMERGENCY_ISOLATED',
      reason,
      timestamp: Date.now(),
      widgetsLocked: this.widgets.size
    };
  }

  /**
   * Create widget with memory protection
   */
  createProtectedWidget(widgetId, widgetClass, config = {}) {
    // Enable memory protection if not already active
    if (config.enableMemoryProtection) {
      memoryProtection.initializeProtection(true);
    }
    
    return this.registerIsolatedWidget(widgetId, widgetClass, {
      ...config,
      memoryProtected: true
    });
  }
}

// Export singleton framework
const isolatedWidgetFramework = new IsolatedWidgetFramework();

module.exports = {
  IsolatedWidgetFramework,
  isolatedWidgetFramework
};