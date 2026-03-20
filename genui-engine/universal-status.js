#!/usr/bin/env node

/**
 * Universal Status Line System for OpenClaw
 * Shows progress for ALL tool calls: files, web, system operations
 * With foldable detail sections
 */

class UniversalStatusSystem {
  constructor() {
    this.activeOperations = new Map();
    this.callbacks = new Map();
    this.operationHistory = [];
  }

  /**
   * Start tracking an OpenClaw operation
   * @param {string} toolName - Name of the OpenClaw tool
   * @param {Object} params - Tool parameters
   * @param {Function} callback - Status update callback
   * @returns {OperationTracker} - Operation tracker
   */
  startOperation(toolName, params, callback) {
    const opId = `${toolName}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const tracker = new OperationTracker(opId, toolName, params, callback);
    
    this.activeOperations.set(opId, tracker);
    if (callback) {
      this.callbacks.set(opId, callback);
    }

    // Add to history
    this.operationHistory.push({
      id: opId,
      tool: toolName,
      params: this.sanitizeParams(params),
      startTime: Date.now(),
      status: 'started'
    });

    return tracker;
  }

  /**
   * Complete an operation
   * @param {string} opId - Operation ID
   * @param {Object} result - Operation result
   */
  completeOperation(opId, result) {
    const tracker = this.activeOperations.get(opId);
    if (tracker) {
      tracker.complete(result);
      this.activeOperations.delete(opId);
      
      // Update history
      const historyItem = this.operationHistory.find(h => h.id === opId);
      if (historyItem) {
        historyItem.status = 'completed';
        historyItem.endTime = Date.now();
        historyItem.duration = historyItem.endTime - historyItem.startTime;
        historyItem.result = this.sanitizeResult(result);
      }
    }
  }

  /**
   * Fail an operation
   * @param {string} opId - Operation ID  
   * @param {Error} error - Error object
   */
  failOperation(opId, error) {
    const tracker = this.activeOperations.get(opId);
    if (tracker) {
      tracker.fail(error);
      this.activeOperations.delete(opId);
      
      // Update history
      const historyItem = this.operationHistory.find(h => h.id === opId);
      if (historyItem) {
        historyItem.status = 'failed';
        historyItem.endTime = Date.now();
        historyItem.duration = historyItem.endTime - historyItem.startTime;
        historyItem.error = error.message;
      }
    }
  }

  /**
   * Get operation-specific status message and details
   * @param {string} toolName - OpenClaw tool name
   * @param {Object} params - Tool parameters
   * @returns {Object} - {message, details}
   */
  getOperationStatus(toolName, params) {
    const statusMap = {
      // File Operations
      read: {
        message: `📖 Reading file...`,
        details: [`File: ${params.path || params.file_path}`, `Limit: ${params.limit || 'full file'}`]
      },
      write: {
        message: `✍️ Writing file...`,
        details: [`Path: ${params.path || params.file_path}`, `Size: ${params.content?.length || 0} chars`]
      },
      edit: {
        message: `✏️ Editing file...`,
        details: [`File: ${params.path || params.file_path}`, `Change: ${params.oldText?.slice(0, 50)}... → ${params.newText?.slice(0, 50)}...`]
      },

      // Web Operations
      web_search: {
        message: `🔍 Searching web...`,
        details: [`Query: "${params.query}"`, `Results: ${params.count || 10}`, `Region: ${params.country || 'US'}`]
      },
      web_fetch: {
        message: `🌐 Fetching webpage...`,
        details: [`URL: ${params.url}`, `Mode: ${params.extractMode || 'markdown'}`, `Max chars: ${params.maxChars || 'unlimited'}`]
      },
      browser: {
        message: `🖥️ Browser action...`,
        details: [`Action: ${params.action}`, `Target: ${params.targetUrl || 'current page'}`, `Profile: ${params.profile || 'default'}`]
      },

      // System Operations  
      exec: {
        message: `⚡ Running command...`,
        details: [`Command: ${params.command}`, `Working dir: ${params.workdir || 'current'}`, `Timeout: ${params.timeout || 'none'}s`]
      },
      memory_search: {
        message: `🧠 Searching memory...`,
        details: [`Query: "${params.query}"`, `Max results: ${params.maxResults || 10}`, `Min score: ${params.minScore || 0}`]
      },
      memory_get: {
        message: `📋 Getting memory...`,
        details: [`Path: ${params.path}`, `Lines: ${params.from || 1}-${(params.from || 1) + (params.lines || 50)}`]
      },

      // Communication
      message: {
        message: `💬 Sending message...`,
        details: [`Action: ${params.action}`, `Channel: ${params.channel || 'current'}`, `Target: ${params.target || params.to || 'default'}`]
      },
      sessions_spawn: {
        message: `🤖 Spawning sub-agent...`,
        details: [`Agent: ${params.agentId}`, `Task: ${params.task?.slice(0, 100)}...`, `Timeout: ${params.runTimeoutSeconds || 300}s`]
      },

      // Gateway Operations
      gateway: {
        message: `⚙️ Gateway operation...`,
        details: [`Action: ${params.action}`, `Config: ${params.raw ? 'raw update' : 'standard'}`, `Restart: ${params.restartDelayMs ? 'yes' : 'no'}`]
      }
    };

    return statusMap[toolName] || {
      message: `🔧 ${toolName} operation...`,
      details: [`Tool: ${toolName}`, `Params: ${Object.keys(params).length} parameters`]
    };
  }

  /**
   * Sanitize parameters for logging (remove sensitive data)
   * @param {Object} params - Raw parameters
   * @returns {Object} - Sanitized parameters
   */
  sanitizeParams(params) {
    const sanitized = { ...params };
    
    // Remove sensitive fields
    const sensitiveFields = ['content', 'raw', 'gatewayToken', 'buffer'];
    sensitiveFields.forEach(field => {
      if (sanitized[field]) {
        sanitized[field] = `[${typeof sanitized[field]}:${sanitized[field].length || 'unknown'} chars]`;
      }
    });
    
    return sanitized;
  }

  /**
   * Sanitize results for logging
   * @param {Object} result - Operation result
   * @returns {Object} - Sanitized result
   */
  sanitizeResult(result) {
    if (typeof result === 'string') {
      return result.length > 200 ? `${result.slice(0, 200)}... [${result.length} total chars]` : result;
    }
    
    return result;
  }

  /**
   * Get recent operation history
   * @param {number} limit - Number of recent operations
   * @returns {Array} - Recent operations
   */
  getHistory(limit = 10) {
    return this.operationHistory.slice(-limit);
  }
}

class OperationTracker {
  constructor(id, toolName, params, callback) {
    this.id = id;
    this.toolName = toolName;
    this.params = params;
    this.callback = callback;
    this.startTime = Date.now();
    this.status = 'running';
    this.result = null;
    this.error = null;
    
    // Get operation-specific status
    const statusSystem = new UniversalStatusSystem();
    const opStatus = statusSystem.getOperationStatus(toolName, params);
    this.message = opStatus.message;
    this.details = opStatus.details;

    // Notify start
    this.notifyUpdate();
  }

  complete(result) {
    this.status = 'completed';
    this.result = result;
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    
    // Update message for completion
    this.message = this.message.replace(/\.\.\.$/, ' ✅');
    
    this.notifyUpdate();
  }

  fail(error) {
    this.status = 'failed';
    this.error = error;
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    
    // Update message for failure
    this.message = this.message.replace(/\.\.\.$/, ' ❌');
    this.details.push(`Error: ${error.message}`);
    
    this.notifyUpdate();
  }

  getStatus() {
    return {
      id: this.id,
      tool: this.toolName,
      message: this.message,
      details: this.details,
      status: this.status,
      duration: this.duration || (Date.now() - this.startTime),
      startTime: this.startTime,
      endTime: this.endTime,
      result: this.result,
      error: this.error
    };
  }

  notifyUpdate() {
    if (this.callback) {
      this.callback(this.getStatus());
    }
  }
}

/**
 * Demo function showing universal status tracking
 */
async function demoUniversalStatus() {
  console.log('🔍 Universal Status System Demo\n');
  
  const statusSystem = new UniversalStatusSystem();
  
  // Simulate various OpenClaw operations
  const operations = [
    { tool: 'read', params: { path: '/home/user/document.txt', limit: 100 } },
    { tool: 'web_search', params: { query: 'OpenClaw status system', count: 5 } },
    { tool: 'exec', params: { command: 'ls -la', workdir: '/tmp' } },
    { tool: 'write', params: { path: '/tmp/output.json', content: '{"test": true}' } }
  ];

  const promises = operations.map(async (op, index) => {
    return new Promise((resolve) => {
      const tracker = statusSystem.startOperation(op.tool, op.params, (status) => {
        console.log(`[${status.id.split('-')[0]}] ${status.message}`);
        
        if (status.details.length > 0) {
          console.log(`   Details:`);
          status.details.forEach(detail => console.log(`   • ${detail}`));
        }
        
        if (status.status === 'completed') {
          console.log(`   ✅ Complete in ${status.duration}ms\n`);
          resolve();
        } else if (status.status === 'failed') {
          console.log(`   ❌ Failed in ${status.duration}ms: ${status.error}\n`);
          resolve();
        }
      });
      
      // Simulate operation completion
      setTimeout(() => {
        if (Math.random() > 0.2) {
          statusSystem.completeOperation(tracker.id, `Mock result for ${op.tool}`);
        } else {
          statusSystem.failOperation(tracker.id, new Error('Simulated failure'));
        }
      }, 100 + Math.random() * 500);
    });
  });
  
  await Promise.all(promises);
  
  console.log('📊 Operation History:');
  const history = statusSystem.getHistory(5);
  history.forEach(op => {
    const status = op.status === 'completed' ? '✅' : op.status === 'failed' ? '❌' : '🔄';
    console.log(`   ${status} ${op.tool} (${op.duration}ms)`);
  });
}

// CLI interface
if (require.main === module) {
  const command = process.argv[2];
  
  if (command === 'demo') {
    demoUniversalStatus().catch(console.error);
  } else {
    console.log('Universal Status System for OpenClaw');
    console.log('');
    console.log('Commands:');
    console.log('  demo    Show status tracking demo');
    console.log('');
    console.log('Features:');
    console.log('  • Track ALL OpenClaw tool calls');
    console.log('  • Show file names, URLs, commands');
    console.log('  • Foldable detail sections');
    console.log('  • Real-time progress updates');
    console.log('  • Operation history');
  }
}

module.exports = { UniversalStatusSystem, OperationTracker };