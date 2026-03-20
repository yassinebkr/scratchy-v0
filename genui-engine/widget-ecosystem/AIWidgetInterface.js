/**
 * AIWidgetInterface - AI-to-Widget Command System
 * Enables AI to directly command and orchestrate widgets
 */

const { widgetEventBus } = require('./WidgetEventBus');

class AIWidgetInterface {
  constructor() {
    this.activeWidgets = new Map();
    this.commandHistory = [];
    this.orchestrationQueue = [];
    this.debugMode = false;
  }

  /**
   * Register a widget for AI commands
   */
  registerWidget(widgetId, widget) {
    this.activeWidgets.set(widgetId, {
      widget,
      capabilities: widget.getAICapabilities ? widget.getAICapabilities() : [],
      metadata: {
        type: widget.constructor.name,
        registeredAt: Date.now(),
        commandCount: 0
      }
    });

    if (this.debugMode) {
      console.log(`🧠 AI Widget registered: ${widgetId} (${widget.constructor.name})`);
    }
  }

  /**
   * Execute a direct command on a widget
   */
  async command(widgetType, action, params = {}, context = {}) {
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    if (this.debugMode) {
      console.log(`🧠 AI Command: ${widgetType}.${action}(${JSON.stringify(params)})`);
    }

    // Find widget by type or ID
    let targetWidget = null;
    let widgetId = null;

    for (const [id, registration] of this.activeWidgets) {
      if (id === widgetType || registration.metadata.type.toLowerCase().includes(widgetType.toLowerCase())) {
        targetWidget = registration;
        widgetId = id;
        break;
      }
    }

    if (!targetWidget) {
      throw new Error(`No active widget found for type: ${widgetType}`);
    }

    // Check if widget supports AI commands
    if (!targetWidget.widget.handleAICommand) {
      throw new Error(`Widget ${widgetId} does not support AI commands`);
    }

    try {
      // Execute command
      const result = await targetWidget.widget.handleAICommand(action, params, context);
      const executionTime = Date.now() - startTime;

      // Log command
      const commandLog = {
        id: commandId,
        widgetId,
        widgetType: targetWidget.metadata.type,
        action,
        params,
        context,
        result,
        executionTime,
        timestamp: Date.now(),
        status: 'success'
      };

      this.commandHistory.push(commandLog);
      targetWidget.metadata.commandCount++;

      // Emit event for other widgets to react
      widgetEventBus.emit('ai-command-executed', {
        commandId,
        widgetId,
        action,
        result
      }, 'ai-system');

      if (this.debugMode) {
        console.log(`✅ AI Command completed: ${widgetType}.${action} (${executionTime}ms)`);
      }

      return {
        commandId,
        result,
        executionTime,
        widgetId
      };

    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      // Log failed command
      const commandLog = {
        id: commandId,
        widgetId,
        widgetType: targetWidget.metadata.type,
        action,
        params,
        context,
        error: error.message,
        executionTime,
        timestamp: Date.now(),
        status: 'error'
      };

      this.commandHistory.push(commandLog);

      if (this.debugMode) {
        console.log(`❌ AI Command failed: ${widgetType}.${action} - ${error.message}`);
      }

      throw error;
    }
  }

  /**
   * Orchestrate a complex multi-widget workflow
   */
  async orchestrate(workflowName, steps, context = {}) {
    const orchestrationId = `orch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    if (this.debugMode) {
      console.log(`🎼 Orchestrating workflow: ${workflowName} (${steps.length} steps)`);
    }

    const orchestration = {
      id: orchestrationId,
      name: workflowName,
      steps,
      context,
      startTime,
      status: 'running',
      results: [],
      errors: []
    };

    this.orchestrationQueue.push(orchestration);

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        
        if (this.debugMode) {
          console.log(`🎼 Step ${i + 1}/${steps.length}: ${step.widgetType}.${step.action}`);
        }

        // Check if step has dependencies on previous results
        let stepParams = { ...step.params };
        if (step.dependencies) {
          for (const dep of step.dependencies) {
            const previousResult = orchestration.results.find(r => r.stepId === dep.stepId);
            if (previousResult) {
              stepParams[dep.paramName] = previousResult.result[dep.resultPath];
            }
          }
        }

        try {
          const stepResult = await this.command(
            step.widgetType,
            step.action,
            stepParams,
            { ...context, orchestrationId, stepIndex: i }
          );

          orchestration.results.push({
            stepId: step.id || `step-${i}`,
            stepIndex: i,
            stepName: step.name || `${step.widgetType}.${step.action}`,
            ...stepResult
          });

          // Optional delay between steps
          if (step.delay) {
            await new Promise(resolve => setTimeout(resolve, step.delay));
          }

        } catch (error) {
          orchestration.errors.push({
            stepIndex: i,
            stepName: step.name || `${step.widgetType}.${step.action}`,
            error: error.message
          });

          // Handle error based on step configuration
          if (step.required !== false) {
            // Stop orchestration on required step failure
            orchestration.status = 'failed';
            throw new Error(`Orchestration failed at step ${i + 1}: ${error.message}`);
          }
        }
      }

      orchestration.status = 'completed';
      orchestration.executionTime = Date.now() - startTime;

      // Emit orchestration completed event
      widgetEventBus.emit('orchestration-completed', {
        orchestrationId,
        workflowName,
        results: orchestration.results,
        executionTime: orchestration.executionTime
      }, 'ai-system');

      if (this.debugMode) {
        console.log(`✅ Orchestration completed: ${workflowName} (${orchestration.executionTime}ms)`);
      }

      return {
        orchestrationId,
        status: 'completed',
        results: orchestration.results,
        errors: orchestration.errors,
        executionTime: orchestration.executionTime
      };

    } catch (error) {
      orchestration.status = 'failed';
      orchestration.executionTime = Date.now() - startTime;

      if (this.debugMode) {
        console.log(`❌ Orchestration failed: ${workflowName} - ${error.message}`);
      }

      throw error;
    }
  }

  /**
   * Query widget capabilities
   */
  getWidgetCapabilities(widgetType = null) {
    if (widgetType) {
      for (const [id, registration] of this.activeWidgets) {
        if (id === widgetType || registration.metadata.type.toLowerCase().includes(widgetType.toLowerCase())) {
          return {
            widgetId: id,
            type: registration.metadata.type,
            capabilities: registration.capabilities,
            commandCount: registration.metadata.commandCount
          };
        }
      }
      return null;
    }

    // Return all widget capabilities
    const allCapabilities = {};
    for (const [id, registration] of this.activeWidgets) {
      allCapabilities[id] = {
        type: registration.metadata.type,
        capabilities: registration.capabilities,
        commandCount: registration.metadata.commandCount
      };
    }
    return allCapabilities;
  }

  /**
   * Get command history
   */
  getCommandHistory(limit = 50) {
    return this.commandHistory.slice(-limit);
  }

  /**
   * Get orchestration history
   */
  getOrchestrationHistory() {
    return this.orchestrationQueue.slice(-20); // Last 20 orchestrations
  }

  /**
   * Enable/disable debug mode
   */
  setDebugMode(enabled) {
    this.debugMode = enabled;
    console.log(`🧠 AIWidgetInterface debug mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Get system statistics
   */
  getStats() {
    const commandsByWidget = {};
    const commandsByAction = {};
    
    this.commandHistory.forEach(cmd => {
      commandsByWidget[cmd.widgetType] = (commandsByWidget[cmd.widgetType] || 0) + 1;
      commandsByAction[cmd.action] = (commandsByAction[cmd.action] || 0) + 1;
    });

    return {
      activeWidgets: this.activeWidgets.size,
      totalCommands: this.commandHistory.length,
      totalOrchestrations: this.orchestrationQueue.length,
      commandsByWidget,
      commandsByAction,
      averageCommandTime: this.commandHistory.length > 0 
        ? this.commandHistory.reduce((sum, cmd) => sum + cmd.executionTime, 0) / this.commandHistory.length
        : 0
    };
  }
}

// Singleton instance
const aiWidgetInterface = new AIWidgetInterface();

module.exports = { AIWidgetInterface, aiWidgetInterface };