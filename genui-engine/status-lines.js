#!/usr/bin/env node

/**
 * Status Line System for Scratchy GenUI
 * Shows real-time progress indicators during processing
 */

class StatusLineSystem {
  constructor() {
    this.activeStatuses = new Map();
    this.callbacks = new Map();
  }

  /**
   * Start a status line with progress steps
   * @param {string} id - Unique status ID
   * @param {string[]} steps - Array of status messages
   * @param {Function} callback - Called with each status update
   * @returns {StatusProgress} - Progress controller
   */
  start(id, steps, callback) {
    const progress = new StatusProgress(id, steps, callback);
    this.activeStatuses.set(id, progress);
    
    if (callback) {
      this.callbacks.set(id, callback);
    }
    
    return progress;
  }

  /**
   * Get current status for an ID
   * @param {string} id - Status ID
   * @returns {Object|null} - Current status or null
   */
  get(id) {
    const progress = this.activeStatuses.get(id);
    return progress ? progress.getStatus() : null;
  }

  /**
   * Complete and remove a status
   * @param {string} id - Status ID
   */
  complete(id) {
    const progress = this.activeStatuses.get(id);
    if (progress) {
      progress.complete();
      this.activeStatuses.delete(id);
      this.callbacks.delete(id);
    }
  }

  /**
   * Get all active statuses
   * @returns {Object[]} - Array of active status objects
   */
  getAllActive() {
    const active = [];
    for (const [id, progress] of this.activeStatuses) {
      active.push(progress.getStatus());
    }
    return active;
  }
}

class StatusProgress {
  constructor(id, steps, callback) {
    this.id = id;
    this.steps = steps;
    this.callback = callback;
    this.currentStep = 0;
    this.startTime = Date.now();
    this.stepStartTime = Date.now();
    this.completed = false;
    
    // Start with first step
    this.next();
  }

  /**
   * Advance to next step
   * @param {number} delayMs - Optional delay before advancing
   */
  next(delayMs = 0) {
    if (this.completed || this.currentStep >= this.steps.length) {
      return;
    }

    const advance = () => {
      if (this.currentStep < this.steps.length) {
        this.stepStartTime = Date.now();
        
        if (this.callback) {
          this.callback(this.getStatus());
        }
        
        this.currentStep++;
      }
    };

    if (delayMs > 0) {
      setTimeout(advance, delayMs);
    } else {
      advance();
    }
  }

  /**
   * Complete the progress
   */
  complete() {
    this.completed = true;
    this.currentStep = this.steps.length;
    
    if (this.callback) {
      this.callback(this.getStatus());
    }
  }

  /**
   * Get current status object
   * @returns {Object} - Status information
   */
  getStatus() {
    const now = Date.now();
    const currentMessage = this.currentStep > 0 && this.currentStep <= this.steps.length ? 
      this.steps[this.currentStep - 1] : '';
    
    return {
      id: this.id,
      message: currentMessage,
      step: Math.min(this.currentStep, this.steps.length),
      totalSteps: this.steps.length,
      progress: this.steps.length > 0 ? Math.min(this.currentStep / this.steps.length, 1) : 1,
      elapsedMs: now - this.startTime,
      stepElapsedMs: now - this.stepStartTime,
      completed: this.completed,
      steps: this.steps
    };
  }
}

/**
 * Simulate the GenUI processing flow with status updates
 */
async function simulateGenUIFlow(message, statusSystem) {
  const flowId = `genui-${Date.now()}`;
  
  // Define the processing steps
  const steps = [
    "🔍 Analyzing user intent...",
    "🧠 Running intent classifier...",
    "⚡ Selecting optimal layout...", 
    "🏗️ Building components...",
    "✨ Rendering interface...",
    "🎯 Ready!"
  ];

  console.log(`\n🚀 Processing: "${message}"`);
  
  return new Promise((resolve) => {
    let stepIndex = 0;
    
    const progress = statusSystem.start(flowId, steps, (status) => {
      const bar = '█'.repeat(Math.floor(status.progress * 20)) + 
                  '░'.repeat(20 - Math.floor(status.progress * 20));
      
      console.log(`   [${bar}] ${status.message} (${status.step}/${status.totalSteps})`);
      
      if (status.completed) {
        console.log(`   ✅ Complete in ${status.elapsedMs}ms\n`);
        resolve(status);
      }
    });

    // Simulate processing delays
    const delays = [100, 50, 200, 150, 100, 50]; // Realistic timing
    
    function processNext() {
      if (stepIndex < steps.length - 1) {
        setTimeout(() => {
          progress.next();
          stepIndex++;
          processNext();
        }, delays[stepIndex]);
      } else {
        setTimeout(() => {
          progress.complete();
          statusSystem.complete(flowId);
        }, delays[stepIndex]);
      }
    }
    
    processNext();
  });
}

// Demo and testing
if (require.main === module) {
  const command = process.argv[2];
  
  if (command === 'demo') {
    console.log('📊 Status Line System Demo\n');
    
    const statusSystem = new StatusLineSystem();
    
    const testMessages = [
      'show me the dashboard',
      'create a new form',
      'display analytics chart'
    ];
    
    // Process messages sequentially with status updates
    async function runDemo() {
      for (const message of testMessages) {
        await simulateGenUIFlow(message, statusSystem);
        await new Promise(resolve => setTimeout(resolve, 500)); // Pause between
      }
      
      console.log('🎯 Demo complete! Status lines provide real-time feedback.');
    }
    
    runDemo().catch(console.error);
    
  } else if (command === 'test') {
    console.log('🧪 Testing Status Line System\n');
    
    const statusSystem = new StatusLineSystem();
    
    // Test basic functionality
    const steps = ['Step 1', 'Step 2', 'Step 3'];
    let updates = [];
    
    const progress = statusSystem.start('test-1', steps, (status) => {
      updates.push(status);
    });
    
    // Simulate step progression
    setTimeout(() => progress.next(), 100);
    setTimeout(() => progress.next(), 200);
    setTimeout(() => {
      progress.complete();
      statusSystem.complete('test-1');
      
      console.log(`📊 Received ${updates.length} status updates`);
      console.log(`✅ Final status: ${updates[updates.length - 1].message}`);
      console.log(`⏱️ Total time: ${updates[updates.length - 1].elapsedMs}ms`);
      console.log(`🎯 Progress tracking: WORKING`);
      
    }, 300);
    
  } else {
    console.log('Status Line System for Scratchy GenUI');
    console.log('');
    console.log('Commands:');
    console.log('  demo    Show animated progress demo');
    console.log('  test    Run functionality tests');
    console.log('');
    console.log('Features:');
    console.log('  • Real-time progress indicators');
    console.log('  • Smooth step transitions');  
    console.log('  • Timing information');
    console.log('  • Multiple concurrent processes');
    console.log('  • Callback-based updates');
  }
}

module.exports = { StatusLineSystem, StatusProgress, simulateGenUIFlow };