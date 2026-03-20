/**
 * WorkflowOrchestrator - Multi-Widget Coordination System
 * Manages complex workflows involving multiple widgets and AI
 */

const { aiWidgetInterface } = require('./AIWidgetInterface');
const { sharedContextStore } = require('./SharedContextStore');
const { widgetEventBus } = require('./WidgetEventBus');

class WorkflowOrchestrator {
  constructor() {
    this.workflows = new Map(); // Active workflows
    this.templates = new Map(); // Workflow templates
    this.history = []; // Completed workflows
    this.debugMode = false;
    
    // Initialize built-in workflow templates
    this.initializeBuiltinTemplates();
  }

  /**
   * Register a workflow template
   */
  registerTemplate(templateId, template) {
    this.templates.set(templateId, {
      ...template,
      registeredAt: Date.now()
    });
    
    if (this.debugMode) {
      console.log(`🎼 Workflow template registered: ${templateId}`);
    }
  }

  /**
   * Start a workflow from template
   */
  async startWorkflow(templateId, params = {}, context = {}) {
    if (!this.templates.has(templateId)) {
      throw new Error(`Unknown workflow template: ${templateId}`);
    }
    
    const template = this.templates.get(templateId);
    const workflowId = `workflow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const workflow = {
      id: workflowId,
      templateId,
      name: template.name,
      description: template.description,
      params,
      context,
      startTime: Date.now(),
      status: 'running',
      steps: template.steps.map((step, index) => ({
        ...step,
        id: step.id || `step-${index}`,
        status: 'pending',
        result: null,
        error: null
      })),
      results: {},
      metadata: {
        totalSteps: template.steps.length,
        currentStep: 0,
        progress: 0
      }
    };
    
    this.workflows.set(workflowId, workflow);
    
    if (this.debugMode) {
      console.log(`🎼 Workflow started: ${template.name} (${workflowId})`);
    }
    
    // Emit workflow started event
    widgetEventBus.emit('workflow-started', {
      workflowId,
      templateId,
      name: template.name
    }, 'orchestrator');
    
    // Start execution
    try {
      const result = await this.executeWorkflow(workflowId);
      return result;
    } catch (error) {
      workflow.status = 'failed';
      workflow.error = error.message;
      workflow.endTime = Date.now();
      
      widgetEventBus.emit('workflow-failed', {
        workflowId,
        error: error.message
      }, 'orchestrator');
      
      throw error;
    }
  }

  /**
   * Execute workflow steps
   */
  async executeWorkflow(workflowId) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    
    try {
      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        workflow.metadata.currentStep = i;
        workflow.metadata.progress = Math.round((i / workflow.steps.length) * 100);
        
        if (this.debugMode) {
          console.log(`🎼 Executing step ${i + 1}/${workflow.steps.length}: ${step.name || step.type}`);
        }
        
        step.status = 'running';
        
        // Emit step started event
        widgetEventBus.emit('workflow-step-started', {
          workflowId,
          stepId: step.id,
          stepIndex: i,
          stepName: step.name
        }, 'orchestrator');
        
        try {
          let stepResult;
          
          switch (step.type) {
            case 'widget-command':
              stepResult = await this.executeWidgetCommand(step, workflow);
              break;
            case 'context-operation':
              stepResult = await this.executeContextOperation(step, workflow);
              break;
            case 'conditional':
              stepResult = await this.executeConditional(step, workflow);
              break;
            case 'parallel':
              stepResult = await this.executeParallel(step, workflow);
              break;
            case 'wait':
              stepResult = await this.executeWait(step, workflow);
              break;
            case 'custom':
              stepResult = await this.executeCustomStep(step, workflow);
              break;
            default:
              throw new Error(`Unknown step type: ${step.type}`);
          }
          
          step.status = 'completed';
          step.result = stepResult;
          workflow.results[step.id] = stepResult;
          
          // Store result in shared context if specified
          if (step.storeResult) {
            sharedContextStore.set(step.storeResult, stepResult, `workflow-${workflowId}`);
          }
          
          widgetEventBus.emit('workflow-step-completed', {
            workflowId,
            stepId: step.id,
            stepIndex: i,
            result: stepResult
          }, 'orchestrator');
          
        } catch (error) {
          step.status = 'failed';
          step.error = error.message;
          
          widgetEventBus.emit('workflow-step-failed', {
            workflowId,
            stepId: step.id,
            stepIndex: i,
            error: error.message
          }, 'orchestrator');
          
          // Check if step is required
          if (step.required !== false) {
            throw new Error(`Required step failed: ${step.name || step.id} - ${error.message}`);
          }
        }
        
        // Optional delay between steps
        if (step.delay) {
          await new Promise(resolve => setTimeout(resolve, step.delay));
        }
      }
      
      // Workflow completed successfully
      workflow.status = 'completed';
      workflow.endTime = Date.now();
      workflow.metadata.progress = 100;
      
      // Move to history
      this.history.push(workflow);
      this.workflows.delete(workflowId);
      
      widgetEventBus.emit('workflow-completed', {
        workflowId,
        results: workflow.results,
        executionTime: workflow.endTime - workflow.startTime
      }, 'orchestrator');
      
      if (this.debugMode) {
        console.log(`✅ Workflow completed: ${workflow.name} (${workflow.endTime - workflow.startTime}ms)`);
      }
      
      return {
        workflowId,
        status: 'completed',
        results: workflow.results,
        executionTime: workflow.endTime - workflow.startTime
      };
      
    } catch (error) {
      workflow.status = 'failed';
      workflow.error = error.message;
      workflow.endTime = Date.now();
      
      // Move to history even if failed
      this.history.push(workflow);
      this.workflows.delete(workflowId);
      
      throw error;
    }
  }

  /**
   * Execute widget command step
   */
  async executeWidgetCommand(step, workflow) {
    const resolvedParams = this.resolveParameters(step.params, workflow);
    
    return await aiWidgetInterface.command(
      step.widgetType,
      step.action,
      resolvedParams,
      { workflowId: workflow.id, stepId: step.id, ...workflow.context }
    );
  }

  /**
   * Execute context operation step
   */
  async executeContextOperation(step, workflow) {
    const resolvedParams = this.resolveParameters(step.params, workflow);
    
    switch (step.operation) {
      case 'set':
        return sharedContextStore.set(resolvedParams.path, resolvedParams.data, `workflow-${workflow.id}`);
      case 'get':
        return sharedContextStore.get(resolvedParams.path);
      case 'delete':
        return sharedContextStore.delete(resolvedParams.path, `workflow-${workflow.id}`);
      case 'query':
        return sharedContextStore.query(resolvedParams.pattern);
      default:
        throw new Error(`Unknown context operation: ${step.operation}`);
    }
  }

  /**
   * Execute conditional step
   */
  async executeConditional(step, workflow) {
    const condition = this.resolveParameters(step.condition, workflow);
    const conditionResult = this.evaluateCondition(condition, workflow);
    
    if (conditionResult) {
      if (step.then) {
        return await this.executeStepGroup(step.then, workflow);
      }
    } else {
      if (step.else) {
        return await this.executeStepGroup(step.else, workflow);
      }
    }
    
    return { conditionResult, executed: conditionResult ? 'then' : 'else' };
  }

  /**
   * Execute parallel steps
   */
  async executeParallel(step, workflow) {
    const promises = step.steps.map(async (parallelStep, index) => {
      try {
        return await this.executeStep(parallelStep, workflow);
      } catch (error) {
        return { error: error.message, stepIndex: index };
      }
    });
    
    const results = await Promise.all(promises);
    return { parallelResults: results };
  }

  /**
   * Execute wait step
   */
  async executeWait(step, workflow) {
    const duration = this.resolveParameters(step.duration, workflow);
    await new Promise(resolve => setTimeout(resolve, duration));
    return { waited: duration };
  }

  /**
   * Execute custom step
   */
  async executeCustomStep(step, workflow) {
    if (!step.handler) {
      throw new Error('Custom step requires handler function');
    }
    
    return await step.handler(step, workflow, this);
  }

  /**
   * Execute a group of steps
   */
  async executeStepGroup(steps, workflow) {
    const results = [];
    for (const step of steps) {
      const result = await this.executeStep(step, workflow);
      results.push(result);
    }
    return results;
  }

  /**
   * Execute a single step (used by conditionals and parallel execution)
   */
  async executeStep(step, workflow) {
    switch (step.type) {
      case 'widget-command':
        return await this.executeWidgetCommand(step, workflow);
      case 'context-operation':
        return await this.executeContextOperation(step, workflow);
      case 'wait':
        return await this.executeWait(step, workflow);
      default:
        throw new Error(`Unsupported step type in group: ${step.type}`);
    }
  }

  /**
   * Resolve parameters with workflow context and results
   */
  resolveParameters(params, workflow) {
    if (typeof params !== 'object' || params === null) {
      return params;
    }
    
    const resolved = {};
    
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        // Resolve template variable
        const varPath = value.slice(2, -1);
        resolved[key] = this.resolveVariable(varPath, workflow);
      } else if (typeof value === 'object') {
        resolved[key] = this.resolveParameters(value, workflow);
      } else {
        resolved[key] = value;
      }
    }
    
    return resolved;
  }

  /**
   * Resolve a template variable
   */
  resolveVariable(varPath, workflow) {
    const parts = varPath.split('.');
    
    switch (parts[0]) {
      case 'workflow':
        return this.getNestedValue(workflow, parts.slice(1));
      case 'context':
        return this.getNestedValue(workflow.context, parts.slice(1));
      case 'params':
        return this.getNestedValue(workflow.params, parts.slice(1));
      case 'results':
        return this.getNestedValue(workflow.results, parts.slice(1));
      case 'shared':
        return sharedContextStore.get(parts.slice(1).join('.'));
      default:
        throw new Error(`Unknown variable scope: ${parts[0]}`);
    }
  }

  /**
   * Evaluate condition
   */
  evaluateCondition(condition, workflow) {
    if (typeof condition === 'boolean') {
      return condition;
    }
    
    if (typeof condition === 'object') {
      const { operator, left, right } = condition;
      const leftValue = this.resolveVariable(left, workflow);
      const rightValue = this.resolveVariable(right, workflow);
      
      switch (operator) {
        case '==':
          return leftValue == rightValue;
        case '===':
          return leftValue === rightValue;
        case '!=':
          return leftValue != rightValue;
        case '!==':
          return leftValue !== rightValue;
        case '>':
          return leftValue > rightValue;
        case '<':
          return leftValue < rightValue;
        case '>=':
          return leftValue >= rightValue;
        case '<=':
          return leftValue <= rightValue;
        case 'contains':
          return String(leftValue).includes(String(rightValue));
        case 'exists':
          return leftValue !== undefined && leftValue !== null;
        default:
          throw new Error(`Unknown condition operator: ${operator}`);
      }
    }
    
    throw new Error('Invalid condition format');
  }

  /**
   * Get workflow status
   */
  getWorkflowStatus(workflowId) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      // Check history
      const historicalWorkflow = this.history.find(w => w.id === workflowId);
      return historicalWorkflow ? {
        ...historicalWorkflow,
        source: 'history'
      } : null;
    }
    
    return {
      ...workflow,
      source: 'active'
    };
  }

  /**
   * Get all active workflows
   */
  getActiveWorkflows() {
    return Array.from(this.workflows.values());
  }

  /**
   * Get workflow templates
   */
  getTemplates() {
    return Array.from(this.templates.entries()).map(([id, template]) => ({
      id,
      ...template
    }));
  }

  /**
   * Cancel a running workflow
   */
  cancelWorkflow(workflowId) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return false;
    }
    
    workflow.status = 'cancelled';
    workflow.endTime = Date.now();
    
    // Move to history
    this.history.push(workflow);
    this.workflows.delete(workflowId);
    
    widgetEventBus.emit('workflow-cancelled', { workflowId }, 'orchestrator');
    
    if (this.debugMode) {
      console.log(`🎼 Workflow cancelled: ${workflow.name} (${workflowId})`);
    }
    
    return true;
  }

  /**
   * Initialize built-in workflow templates
   */
  initializeBuiltinTemplates() {
    // Project Setup Workflow
    this.registerTemplate('project-setup', {
      name: 'Project Setup',
      description: 'Create a new project with tasks, notes, and calendar events',
      steps: [
        {
          id: 'create-project-context',
          type: 'context-operation',
          operation: 'set',
          params: {
            path: 'projects.${params.projectName}',
            data: {
              name: '${params.projectName}',
              description: '${params.description}',
              createdAt: new Date().toISOString(),
              status: 'active'
            }
          }
        },
        {
          id: 'create-tasks',
          type: 'widget-command',
          widgetType: 'tasks',
          action: 'createProject',
          params: {
            projectName: '${params.projectName}',
            tasks: '${params.tasks}'
          },
          storeResult: 'projects.${params.projectName}.taskList'
        },
        {
          id: 'create-notes',
          type: 'widget-command',
          widgetType: 'notes',
          action: 'createProjectNotes',
          params: {
            projectName: '${params.projectName}',
            notes: '${params.notes}'
          },
          storeResult: 'projects.${params.projectName}.notesList'
        },
        {
          id: 'create-calendar-events',
          type: 'widget-command',
          widgetType: 'calendar',
          action: 'createProjectEvents',
          params: {
            projectName: '${params.projectName}',
            events: '${params.events}'
          },
          storeResult: 'projects.${params.projectName}.events',
          required: false
        }
      ]
    });
    
    // Daily Standup Workflow
    this.registerTemplate('daily-standup', {
      name: 'Daily Standup Preparation',
      description: 'Gather information for daily standup meeting',
      steps: [
        {
          id: 'get-completed-tasks',
          type: 'widget-command',
          widgetType: 'tasks',
          action: 'getCompletedTasks',
          params: {
            since: '${params.since}',
            userId: '${params.userId}'
          }
        },
        {
          id: 'get-current-tasks',
          type: 'widget-command',
          widgetType: 'tasks',
          action: 'getCurrentTasks',
          params: {
            userId: '${params.userId}'
          }
        },
        {
          id: 'create-standup-note',
          type: 'widget-command',
          widgetType: 'notes',
          action: 'createStandupNote',
          params: {
            date: new Date().toISOString().split('T')[0],
            completedTasks: '${results.get-completed-tasks}',
            currentTasks: '${results.get-current-tasks}',
            blockers: '${params.blockers}'
          }
        }
      ]
    });
  }

  /**
   * Helper method to get nested values
   */
  getNestedValue(obj, path) {
    return path.reduce((current, key) => current && current[key], obj);
  }

  /**
   * Enable/disable debug mode
   */
  setDebugMode(enabled) {
    this.debugMode = enabled;
    console.log(`🎼 WorkflowOrchestrator debug mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Get statistics
   */
  getStats() {
    const completedWorkflows = this.history.filter(w => w.status === 'completed').length;
    const failedWorkflows = this.history.filter(w => w.status === 'failed').length;
    
    return {
      activeWorkflows: this.workflows.size,
      totalTemplates: this.templates.size,
      totalCompleted: completedWorkflows,
      totalFailed: failedWorkflows,
      totalHistory: this.history.length,
      successRate: this.history.length > 0 
        ? Math.round((completedWorkflows / this.history.length) * 100)
        : 0
    };
  }
}

// Singleton instance
const workflowOrchestrator = new WorkflowOrchestrator();

module.exports = { WorkflowOrchestrator, workflowOrchestrator };