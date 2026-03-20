/**
 * Widget Security Manager - Phase 3
 * Resource quotas, audit logging, and security validation
 */

class WidgetSecurityManager {
  constructor() {
    this.widgets = new Map();
    this.auditLog = [];
    this.resourceLimits = {
      maxCPUPercent: 10,        // Max 10% CPU per widget
      maxMemoryMB: 50,          // Max 50MB memory per widget
      maxAPICallsPerMinute: 30, // Max 30 API calls per minute
      maxExecutionTimeMs: 5000, // Max 5 seconds execution time
      maxWorkers: 10            // Max 10 concurrent widgets
    };
    
    this.startMonitoring();
  }
  
  async validateAndDeploy(widgetId, widgetData) {
    try {
      // Step 1: Static code analysis
      const codeAnalysis = await this.analyzeCode(widgetData.code);
      this.auditLog.push({
        timestamp: Date.now(),
        widgetId,
        action: 'code_analysis',
        result: codeAnalysis.safe ? 'passed' : 'failed',
        details: codeAnalysis
      });
      
      if (!codeAnalysis.safe) {
        throw new Error(`Code analysis failed: ${codeAnalysis.issues.join(', ')}`);
      }
      
      // Step 2: Check resource limits
      if (this.widgets.size >= this.resourceLimits.maxWorkers) {
        throw new Error(`Maximum widget limit reached (${this.resourceLimits.maxWorkers})`);
      }
      
      // Step 3: Create monitored widget context
      const monitoredWidget = await this.createMonitoredWidget(widgetId, widgetData);
      
      // Step 4: Register widget for monitoring
      this.widgets.set(widgetId, monitoredWidget);
      
      this.auditLog.push({
        timestamp: Date.now(),
        widgetId,
        action: 'widget_deployed',
        result: 'success',
        details: { size: widgetData.config?.size, apis: widgetData.config?.apis }
      });
      
      console.log('[SecurityManager] Widget deployed with monitoring:', widgetId);
      return monitoredWidget;
      
    } catch (error) {
      this.auditLog.push({
        timestamp: Date.now(),
        widgetId,
        action: 'deployment_failed',
        result: 'error',
        details: { error: error.message }
      });
      
      throw error;
    }
  }
  
  async analyzeCode(code) {
    const issues = [];
    let riskScore = 0;
    
    // Check for dangerous patterns
    const dangerousPatterns = [
      { pattern: /eval\s*\(/, risk: 10, message: 'eval() usage detected' },
      { pattern: /Function\s*\(/, risk: 8, message: 'Dynamic function creation' },
      { pattern: /setTimeout\s*\(\s*[\"']/, risk: 6, message: 'String-based setTimeout' },
      { pattern: /setInterval\s*\(\s*[\"']/, risk: 6, message: 'String-based setInterval' },
      { pattern: /document\.write/, risk: 8, message: 'document.write usage' },
      { pattern: /innerHTML\s*=/, risk: 4, message: 'innerHTML assignment' },
      { pattern: /outerHTML\s*=/, risk: 6, message: 'outerHTML assignment' },
      { pattern: /javascript:/, risk: 9, message: 'javascript: protocol usage' },
      { pattern: /on\w+\s*=/, risk: 7, message: 'Inline event handlers' }
    ];
    
    // Check for resource-intensive patterns
    const resourcePatterns = [
      { pattern: /while\s*\(\s*true/, risk: 10, message: 'Infinite while loop detected' },
      { pattern: /for\s*\(\s*;\s*;\s*\)/, risk: 10, message: 'Infinite for loop detected' },
      { pattern: /setInterval\s*\([^,]+,\s*[0-9]{1,2}\)/, risk: 7, message: 'High-frequency interval (<100ms)' },
      { pattern: /new\s+Array\s*\(\s*\d{7,}/, risk: 8, message: 'Large array allocation' },
      { pattern: /\*\s*1024\s*\*\s*1024/, risk: 6, message: 'Large number calculations' }
    ];
    
    const allPatterns = [...dangerousPatterns, ...resourcePatterns];
    
    for (const { pattern, risk, message } of allPatterns) {
      if (pattern.test(code)) {
        issues.push(message);
        riskScore += risk;
      }
    }
    
    // Check code complexity
    const codeLength = code.length;
    if (codeLength > 10000) {
      issues.push('Code is very large (>10KB)');
      riskScore += 3;
    }
    
    // Check for excessive nested functions
    const functionDepth = (code.match(/function/g) || []).length;
    if (functionDepth > 5) {
      issues.push('High function nesting detected');
      riskScore += 2;
    }
    
    return {
      safe: riskScore < 15, // Risk threshold
      riskScore,
      issues,
      codeLength,
      analysis: {
        functionCount: functionDepth,
        complexity: codeLength > 5000 ? 'high' : codeLength > 2000 ? 'medium' : 'low'
      }
    };
  }
  
  async createMonitoredWidget(widgetId, widgetData) {
    const startTime = Date.now();
    const resourceTracker = {
      cpuUsage: 0,
      memoryUsage: 0,
      apiCalls: [],
      executionTime: 0,
      errors: [],
      warnings: []
    };
    
    // Create enhanced Web Worker runtime with monitoring
    const monitoredRuntime = new MonitoredWebWorkerRuntime(widgetData, null, {
      widgetId,
      resourceTracker,
      securityManager: this
    });
    
    // Set up resource monitoring
    const monitoringInterval = setInterval(() => {
      this.checkResourceUsage(widgetId, resourceTracker);
    }, 2000); // Check every 2 seconds
    
    // Set up execution timeout
    const executionTimeout = setTimeout(() => {
      this.handleExecutionTimeout(widgetId);
    }, this.resourceLimits.maxExecutionTimeMs);
    
    return {
      runtime: monitoredRuntime,
      resourceTracker,
      monitoringInterval,
      executionTimeout,
      startTime
    };
  }
  
  checkResourceUsage(widgetId, resourceTracker) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return;
    
    // Simulate resource monitoring (in real implementation, this would use Performance API)
    const now = Date.now();
    const runTime = now - widget.startTime;
    
    // Check API call rate
    const recentCalls = resourceTracker.apiCalls.filter(call => 
      now - call.timestamp < 60000 // Last minute
    );
    
    if (recentCalls.length > this.resourceLimits.maxAPICallsPerMinute) {
      this.handleResourceViolation(widgetId, 'api_rate_limit', {
        current: recentCalls.length,
        limit: this.resourceLimits.maxAPICallsPerMinute
      });
    }
    
    // Log resource status
    this.auditLog.push({
      timestamp: now,
      widgetId,
      action: 'resource_check',
      result: 'info',
      details: {
        runTime,
        apiCallsLastMinute: recentCalls.length,
        errorCount: resourceTracker.errors.length
      }
    });
  }
  
  handleResourceViolation(widgetId, violationType, details) {
    console.warn(`[SecurityManager] Resource violation for ${widgetId}:`, violationType, details);
    
    this.auditLog.push({
      timestamp: Date.now(),
      widgetId,
      action: 'resource_violation',
      result: 'warning',
      details: { violationType, ...details }
    });
    
    // Take action based on violation severity
    if (violationType === 'api_rate_limit' || violationType === 'memory_exceeded') {
      this.suspendWidget(widgetId, `Resource limit exceeded: ${violationType}`);
    }
  }
  
  handleExecutionTimeout(widgetId) {
    console.error(`[SecurityManager] Execution timeout for widget ${widgetId}`);
    
    this.auditLog.push({
      timestamp: Date.now(),
      widgetId,
      action: 'execution_timeout',
      result: 'error',
      details: { timeoutMs: this.resourceLimits.maxExecutionTimeMs }
    });
    
    this.terminateWidget(widgetId, 'Execution timeout exceeded');
  }
  
  suspendWidget(widgetId, reason) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return;
    
    console.warn(`[SecurityManager] Suspending widget ${widgetId}: ${reason}`);
    
    // Pause widget execution (implementation would depend on worker controls)
    widget.suspended = true;
    
    this.auditLog.push({
      timestamp: Date.now(),
      widgetId,
      action: 'widget_suspended',
      result: 'warning',
      details: { reason }
    });
  }
  
  terminateWidget(widgetId, reason) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return;
    
    console.error(`[SecurityManager] Terminating widget ${widgetId}: ${reason}`);
    
    // Clean up monitoring
    if (widget.monitoringInterval) {
      clearInterval(widget.monitoringInterval);
    }
    if (widget.executionTimeout) {
      clearTimeout(widget.executionTimeout);
    }
    
    // Terminate the runtime
    if (widget.runtime && widget.runtime.destroy) {
      widget.runtime.destroy();
    }
    
    this.widgets.delete(widgetId);
    
    this.auditLog.push({
      timestamp: Date.now(),
      widgetId,
      action: 'widget_terminated',
      result: 'error',
      details: { reason }
    });
  }
  
  logAPICall(widgetId, apiType, details) {
    const widget = this.widgets.get(widgetId);
    if (widget) {
      widget.resourceTracker.apiCalls.push({
        timestamp: Date.now(),
        apiType,
        details
      });
    }
    
    this.auditLog.push({
      timestamp: Date.now(),
      widgetId,
      action: 'api_call',
      result: 'info',
      details: { apiType, ...details }
    });
  }
  
  getSecurityReport() {
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;
    
    const recentLogs = this.auditLog.filter(log => log.timestamp > last24h);
    
    const report = {
      timestamp: now,
      activeWidgets: this.widgets.size,
      maxWidgets: this.resourceLimits.maxWorkers,
      last24Hours: {
        totalEvents: recentLogs.length,
        deployments: recentLogs.filter(log => log.action === 'widget_deployed').length,
        violations: recentLogs.filter(log => log.result === 'warning' || log.result === 'error').length,
        apiCalls: recentLogs.filter(log => log.action === 'api_call').length
      },
      resourceLimits: this.resourceLimits,
      topIssues: this.getTopSecurityIssues(recentLogs)
    };
    
    return report;
  }
  
  getTopSecurityIssues(logs) {
    const issues = {};
    
    logs.filter(log => log.result === 'warning' || log.result === 'error')
        .forEach(log => {
          const key = log.action;
          issues[key] = (issues[key] || 0) + 1;
        });
    
    return Object.entries(issues)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([issue, count]) => ({ issue, count }));
  }
  
  startMonitoring() {
    console.log('[SecurityManager] Starting security monitoring...');
    
    // Clean up old audit logs (keep last 1000 entries)
    setInterval(() => {
      if (this.auditLog.length > 1000) {
        this.auditLog = this.auditLog.slice(-1000);
      }
    }, 60000); // Every minute
  }
  
  exportAuditLog(format = 'json') {
    const timestamp = new Date().toISOString();
    
    if (format === 'csv') {
      const headers = 'Timestamp,Widget ID,Action,Result,Details\
';
      const rows = this.auditLog.map(log => 
        `${new Date(log.timestamp).toISOString()},${log.widgetId || ''},${log.action},${log.result},\"${JSON.stringify(log.details || {})}\"`
      ).join('\
');
      
      return headers + rows;
    }
    
    return JSON.stringify({
      exportTimestamp: timestamp,
      totalEntries: this.auditLog.length,
      logs: this.auditLog
    }, null, 2);
  }
}

// Enhanced Web Worker Runtime with monitoring
class MonitoredWebWorkerRuntime extends WebWorkerRuntime {
  constructor(widgetData, containerEl, monitoringConfig) {
    super(widgetData, containerEl);
    this.monitoringConfig = monitoringConfig;
    this.securityManager = monitoringConfig.securityManager;
  }
  
  async handleAPICall(messageId, apiData) {
    // Log API call for monitoring
    this.securityManager.logAPICall(
      this.monitoringConfig.widgetId,
      apiData.type,
      { endpoint: apiData.endpoint, options: apiData.options }
    );
    
    // Call parent implementation
    return super.handleAPICall(messageId, apiData);
  }
  
  handleWorkerError(errorData) {
    // Track errors for security analysis
    if (this.monitoringConfig.resourceTracker) {
      this.monitoringConfig.resourceTracker.errors.push({
        timestamp: Date.now(),
        error: errorData.error,
        stack: errorData.stack
      });
    }
    
    // Call parent implementation
    super.handleWorkerError(errorData);
  }
}

// Make available globally
window.WidgetSecurityManager = WidgetSecurityManager;
window.MonitoredWebWorkerRuntime = MonitoredWebWorkerRuntime;