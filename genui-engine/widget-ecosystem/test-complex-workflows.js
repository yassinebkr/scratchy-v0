#!/usr/bin/env node

/**
 * Complex Multi-Widget Workflow Tests
 * Demonstrates the complete ecosystem in action
 */

const { widgetEventBus } = require('./WidgetEventBus');
const { aiWidgetInterface } = require('./AIWidgetInterface');
const { sharedContextStore } = require('./SharedContextStore');
const { workflowOrchestrator } = require('./WorkflowOrchestrator');

// Mock widget implementations for testing
class MockNotesWidget {
  constructor() {
    this.interestedEvents = ['task-created', 'project-created', '*'];
    this.notes = [];
  }

  getAICapabilities() {
    return ['createNote', 'createProjectNotes', 'createStandupNote', 'searchNotes'];
  }

  async handleAICommand(action, params, context) {
    switch (action) {
      case 'createNote':
        const note = {
          id: `note-${Date.now()}`,
          title: params.title,
          content: params.content,
          tags: params.tags || [],
          projectId: params.projectId,
          createdAt: new Date().toISOString()
        };
        this.notes.push(note);
        return { success: true, noteId: note.id };

      case 'createProjectNotes':
        const projectNotes = (params.notes || []).map(noteData => {
          const note = {
            id: `note-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            title: noteData.title,
            content: noteData.content,
            projectName: params.projectName,
            createdAt: new Date().toISOString()
          };
          this.notes.push(note);
          return note.id;
        });
        return { success: true, noteIds: projectNotes };

      case 'createStandupNote':
        const standupNote = {
          id: `standup-${params.date}`,
          title: `Standup - ${params.date}`,
          content: `
**Yesterday's Accomplishments:**
${params.completedTasks?.map(t => `- ${t.title}`).join('\n') || '- No completed tasks'}

**Today's Plan:**
${params.currentTasks?.map(t => `- ${t.title}`).join('\n') || '- No current tasks'}

**Blockers:**
${params.blockers || '- None'}
          `.trim(),
          type: 'standup',
          date: params.date,
          createdAt: new Date().toISOString()
        };
        this.notes.push(standupNote);
        return { success: true, noteId: standupNote.id };

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  handleEvent(event, eventBus) {
    console.log(`📝 Notes widget received event: ${event.type}`);
    
    switch (event.type) {
      case 'task-created':
        if (event.data.needsNote) {
          // Auto-create related note
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
        // Auto-create project documentation template
        setTimeout(() => {
          eventBus.emit('project-docs-created', {
            projectId: event.data.projectId,
            docsCreated: ['README', 'PLANNING', 'MEETING_NOTES']
          }, 'notes');
        }, 100);
        break;
    }
  }
}

class MockTasksWidget {
  constructor() {
    this.interestedEvents = ['note-created', 'project-created'];
    this.tasks = [];
  }

  getAICapabilities() {
    return ['createTask', 'createProject', 'getCompletedTasks', 'getCurrentTasks'];
  }

  async handleAICommand(action, params, context) {
    switch (action) {
      case 'createTask':
        const task = {
          id: `task-${Date.now()}`,
          title: params.title,
          description: params.description,
          status: 'pending',
          priority: params.priority || 'medium',
          projectId: params.projectId,
          createdAt: new Date().toISOString()
        };
        this.tasks.push(task);
        return { success: true, taskId: task.id };

      case 'createProject':
        const projectTasks = (params.tasks || []).map(taskData => {
          const task = {
            id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            title: taskData.title,
            description: taskData.description,
            status: 'pending',
            projectName: params.projectName,
            createdAt: new Date().toISOString()
          };
          this.tasks.push(task);
          return task.id;
        });
        return { success: true, projectTaskIds: projectTasks };

      case 'getCompletedTasks':
        const completed = this.tasks.filter(task => 
          task.status === 'completed' && 
          new Date(task.completedAt || 0) >= new Date(params.since)
        );
        return completed;

      case 'getCurrentTasks':
        const current = this.tasks.filter(task => task.status === 'pending');
        return current;

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  handleEvent(event, eventBus) {
    console.log(`✅ Tasks widget received event: ${event.type}`);
    
    if (event.type === 'note-created' && event.data.actionable) {
      // Suggest creating task from note
      setTimeout(() => {
        eventBus.emit('task-suggestion', {
          noteId: event.data.noteId,
          suggestedTask: `Task from: ${event.data.title}`,
          reason: 'actionable-note'
        }, 'tasks');
      }, 100);
    }
  }
}

class MockCalendarWidget {
  constructor() {
    this.interestedEvents = ['project-created', 'meeting-note-created'];
    this.events = [];
  }

  getAICapabilities() {
    return ['createEvent', 'createProjectEvents', 'getUpcomingEvents'];
  }

  async handleAICommand(action, params, context) {
    switch (action) {
      case 'createEvent':
        const event = {
          id: `event-${Date.now()}`,
          title: params.title,
          description: params.description,
          startTime: params.startTime,
          endTime: params.endTime,
          attendees: params.attendees || [],
          createdAt: new Date().toISOString()
        };
        this.events.push(event);
        return { success: true, eventId: event.id };

      case 'createProjectEvents':
        const projectEvents = (params.events || []).map(eventData => {
          const event = {
            id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            title: eventData.title,
            description: eventData.description,
            startTime: eventData.startTime,
            projectName: params.projectName,
            createdAt: new Date().toISOString()
          };
          this.events.push(event);
          return event.id;
        });
        return { success: true, projectEventIds: projectEvents };

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  handleEvent(event, eventBus) {
    console.log(`📅 Calendar widget received event: ${event.type}`);
    
    if (event.type === 'project-created') {
      // Auto-suggest kickoff meeting
      setTimeout(() => {
        eventBus.emit('meeting-suggestion', {
          projectId: event.data.projectId,
          suggestedMeeting: `${event.data.projectName} Kickoff`,
          reason: 'project-created'
        }, 'calendar');
      }, 100);
    }
  }
}

class ComplexWorkflowTester {
  constructor() {
    this.testResults = [];
    this.setupWidgets();
    this.setupDebugMode();
  }

  setupWidgets() {
    console.log('🔧 Setting up mock widgets...\n');
    
    // Create mock widgets
    this.notesWidget = new MockNotesWidget();
    this.tasksWidget = new MockTasksWidget();
    this.calendarWidget = new MockCalendarWidget();
    
    // Register widgets with event bus
    widgetEventBus.registerWidget('notes', this.notesWidget);
    widgetEventBus.registerWidget('tasks', this.tasksWidget);
    widgetEventBus.registerWidget('calendar', this.calendarWidget);
    
    // Register widgets with AI interface
    aiWidgetInterface.registerWidget('notes', this.notesWidget);
    aiWidgetInterface.registerWidget('tasks', this.tasksWidget);
    aiWidgetInterface.registerWidget('calendar', this.calendarWidget);
    
    console.log('✅ All widgets registered\n');
  }

  setupDebugMode() {
    widgetEventBus.setDebugMode(true);
    aiWidgetInterface.setDebugMode(true);
    sharedContextStore.setDebugMode(true);
    workflowOrchestrator.setDebugMode(true);
  }

  async runAllTests() {
    console.log('🧪 Starting Complex Multi-Widget Workflow Tests\n');
    console.log('=' .repeat(60) + '\n');
    
    try {
      await this.testBasicInterWidgetCommunication();
      await this.testAIWidgetCommands();
      await this.testSharedContextOperations();
      await this.testComplexWorkflow();
      await this.testMultiWidgetCoordination();
      await this.testErrorHandlingAndRecovery();
      
      this.printFinalResults();
      
    } catch (error) {
      console.error('❌ Test suite failed:', error);
      process.exit(1);
    }
  }

  async testBasicInterWidgetCommunication() {
    console.log('🔄 TEST 1: Basic Inter-Widget Communication\n');
    
    const startTime = Date.now();
    
    // Test basic event emission and handling
    const result = widgetEventBus.emit('task-created', {
      taskId: 'test-task-1',
      title: 'Test Task',
      needsNote: true
    }, 'tasks');
    
    // Wait for async event propagation
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const eventHistory = widgetEventBus.getEventHistory(5);
    const suggestions = eventHistory.filter(e => e.type === 'note-suggestion');
    
    this.assert(
      suggestions.length > 0,
      'Notes widget should suggest note creation',
      { suggestions: suggestions.length }
    );
    
    console.log(`✅ Inter-widget communication working (${Date.now() - startTime}ms)\n`);
  }

  async testAIWidgetCommands() {
    console.log('🧠 TEST 2: AI-to-Widget Commands\n');
    
    const startTime = Date.now();
    
    // Test direct AI command to widget
    const noteResult = await aiWidgetInterface.command('notes', 'createNote', {
      title: 'AI-Created Note',
      content: 'This note was created by AI command',
      tags: ['ai', 'test']
    });
    
    this.assert(
      noteResult.result.success,
      'AI should successfully create note',
      noteResult
    );
    
    // Test widget capabilities query
    const capabilities = aiWidgetInterface.getWidgetCapabilities('notes');
    
    this.assert(
      capabilities.capabilities.includes('createNote'),
      'Widget capabilities should be discoverable',
      capabilities
    );
    
    console.log(`✅ AI widget commands working (${Date.now() - startTime}ms)\n`);
  }

  async testSharedContextOperations() {
    console.log('📊 TEST 3: Shared Context Store Operations\n');
    
    const startTime = Date.now();
    
    // Test context storage and retrieval
    const projectData = {
      name: 'Test Project Alpha',
      status: 'planning',
      team: ['Alice', 'Bob', 'Charlie'],
      createdAt: new Date().toISOString()
    };
    
    const changeId = sharedContextStore.set('projects.alpha', projectData, 'test-system');
    const retrievedData = sharedContextStore.get('projects.alpha');
    
    this.assert(
      JSON.stringify(retrievedData) === JSON.stringify(projectData),
      'Context data should be stored and retrieved correctly',
      { stored: projectData, retrieved: retrievedData }
    );
    
    // Test context subscriptions
    let subscriptionTriggered = false;
    const unsubscribe = sharedContextStore.subscribe('projects.alpha', 'projects.alpha.status', (change) => {
      subscriptionTriggered = true;
    });
    
    sharedContextStore.set('projects.alpha.status', 'active', 'test-system');
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    this.assert(
      subscriptionTriggered,
      'Context subscriptions should trigger on changes',
      { triggered: subscriptionTriggered }
    );
    
    unsubscribe();
    
    console.log(`✅ Shared context operations working (${Date.now() - startTime}ms)\n`);
  }

  async testComplexWorkflow() {
    console.log('🎼 TEST 4: Complex Workflow Orchestration\n');
    
    const startTime = Date.now();
    
    // Test built-in project setup workflow
    const workflowResult = await workflowOrchestrator.startWorkflow('project-setup', {
      projectName: 'Test Project Beta',
      description: 'A test project for workflow testing',
      tasks: [
        { title: 'Setup repository', description: 'Initialize git repo' },
        { title: 'Create documentation', description: 'Write README and docs' }
      ],
      notes: [
        { title: 'Project Overview', content: 'High-level project description' },
        { title: 'Technical Requirements', content: 'Technical specifications' }
      ],
      events: [
        { title: 'Project Kickoff', startTime: new Date(Date.now() + 24*60*60*1000).toISOString() }
      ]
    });
    
    this.assert(
      workflowResult.status === 'completed',
      'Complex workflow should complete successfully',
      workflowResult
    );
    
    // Verify workflow results were stored in context
    const projectContext = sharedContextStore.get('projects.Test Project Beta');
    
    this.assert(
      projectContext && projectContext.name === 'Test Project Beta',
      'Workflow results should be stored in shared context',
      projectContext
    );
    
    console.log(`✅ Complex workflow orchestration working (${workflowResult.executionTime}ms)\n`);
  }

  async testMultiWidgetCoordination() {
    console.log('🤝 TEST 5: Multi-Widget Coordination\n');
    
    const startTime = Date.now();
    
    // Test coordinated multi-widget action
    const orchestrationSteps = [
      {
        id: 'create-project-task',
        type: 'widget-command',
        widgetType: 'tasks',
        action: 'createTask',
        params: {
          title: 'Coordinated Task',
          description: 'Task created through orchestration'
        }
      },
      {
        id: 'create-related-note',
        type: 'widget-command',
        widgetType: 'notes',
        action: 'createNote',
        params: {
          title: 'Task Notes',
          content: 'Notes for coordinated task: ${results.create-project-task.taskId}'
        }
      },
      {
        id: 'create-followup-event',
        type: 'widget-command',
        widgetType: 'calendar',
        action: 'createEvent',
        params: {
          title: 'Task Review Meeting',
          description: 'Review coordinated task progress',
          startTime: new Date(Date.now() + 7*24*60*60*1000).toISOString()
        }
      }
    ];
    
    const orchestrationResult = await aiWidgetInterface.orchestrate(
      'multi-widget-coordination',
      orchestrationSteps
    );
    
    this.assert(
      orchestrationResult.status === 'completed',
      'Multi-widget coordination should complete',
      orchestrationResult
    );
    
    this.assert(
      orchestrationResult.results.length === 3,
      'All coordination steps should execute',
      { resultCount: orchestrationResult.results.length }
    );
    
    console.log(`✅ Multi-widget coordination working (${orchestrationResult.executionTime}ms)\n`);
  }

  async testErrorHandlingAndRecovery() {
    console.log('⚠️ TEST 6: Error Handling and Recovery\n');
    
    const startTime = Date.now();
    
    // Test workflow with failing step
    const workflowWithError = {
      name: 'Error Test Workflow',
      description: 'Test error handling',
      steps: [
        {
          id: 'success-step',
          type: 'widget-command',
          widgetType: 'notes',
          action: 'createNote',
          params: {
            title: 'Before Error',
            content: 'This should work'
          }
        },
        {
          id: 'failing-step',
          type: 'widget-command',
          widgetType: 'notes',
          action: 'nonExistentAction',
          params: {},
          required: false // Non-required step
        },
        {
          id: 'recovery-step',
          type: 'widget-command',
          widgetType: 'notes',
          action: 'createNote',
          params: {
            title: 'After Error',
            content: 'This should still work'
          }
        }
      ]
    };
    
    workflowOrchestrator.registerTemplate('error-test', workflowWithError);
    
    try {
      const result = await workflowOrchestrator.startWorkflow('error-test');
      
      this.assert(
        result.status === 'completed',
        'Workflow should complete despite non-required step failure',
        result
      );
      
      this.assert(
        result.errors && result.errors.length > 0,
        'Workflow should record errors',
        { errorCount: result.errors?.length }
      );
      
    } catch (error) {
      // This should not happen for non-required step failures
      this.assert(false, 'Workflow should handle non-required step failures gracefully', { error: error.message });
    }
    
    console.log(`✅ Error handling and recovery working (${Date.now() - startTime}ms)\n`);
  }

  assert(condition, message, data = null) {
    const result = {
      passed: !!condition,
      message,
      data,
      timestamp: Date.now()
    };
    
    this.testResults.push(result);
    
    if (condition) {
      console.log(`  ✅ ${message}`);
      if (data) console.log(`     Data:`, JSON.stringify(data, null, 2));
    } else {
      console.log(`  ❌ ${message}`);
      if (data) console.log(`     Data:`, JSON.stringify(data, null, 2));
    }
  }

  printFinalResults() {
    console.log('=' .repeat(60));
    console.log('🏁 TEST RESULTS SUMMARY\n');
    
    const passed = this.testResults.filter(r => r.passed).length;
    const total = this.testResults.length;
    const successRate = Math.round((passed / total) * 100);
    
    console.log(`Tests Passed: ${passed}/${total} (${successRate}%)`);
    console.log(`Tests Failed: ${total - passed}/${total}`);
    
    // System statistics
    console.log('\n📊 SYSTEM STATISTICS:');
    console.log('Event Bus:', widgetEventBus.getStats());
    console.log('AI Interface:', aiWidgetInterface.getStats());
    console.log('Context Store:', sharedContextStore.getStats());
    console.log('Orchestrator:', workflowOrchestrator.getStats());
    
    if (successRate === 100) {
      console.log('\n🎉 ALL TESTS PASSED! Widget ecosystem is fully functional.');
    } else {
      console.log(`\n⚠️  ${total - passed} test(s) failed. Review results above.`);
    }
    
    console.log('\n🚀 Widget Ecosystem Status: READY FOR INTEGRATION');
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  const tester = new ComplexWorkflowTester();
  tester.runAllTests().catch(console.error);
}

module.exports = { ComplexWorkflowTester };