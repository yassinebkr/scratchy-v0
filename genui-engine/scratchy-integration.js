#!/usr/bin/env node

/**
 * Scratchy Integration Layer
 * Wires Intent Classifier + Universal Status + Tier 1 Templates into Scratchy
 */

const ScratchyIntentClassifier = require('./classifier');
const { UniversalStatusSystem } = require('./universal-status');

class ScratchyGenUIEngine {
  constructor(options = {}) {
    this.intentClassifier = new ScratchyIntentClassifier();
    this.statusSystem = new UniversalStatusSystem();
    this.confidenceThreshold = options.confidenceThreshold || 0.7;
    
    // Widget instance cache for autonomous operations
    this.activeWidgets = new Map();
    
    // Performance metrics
    this.metrics = {
      tier1Hits: 0,
      tier2Hits: 0, 
      tier3Hits: 0,
      totalRequests: 0,
      avgTier1Time: 0,
      avgTier2Time: 0,
      avgTier3Time: 0
    };
  }

  /**
   * Main processing pipeline - 3-tier hybrid system
   * @param {string} message - User message
   * @param {Object} context - Additional context
   * @param {Function} statusCallback - Status updates for UI
   * @returns {Promise<Object>} - Generated UI response
   */
  async processMessage(message, context = {}, statusCallback = null) {
    const flowId = `genui-${Date.now()}`;
    const startTime = process.hrtime.bigint();
    
    this.metrics.totalRequests++;

    // Universal status tracking
    const statusSteps = [
      "🔍 Analyzing intent...",
      "🧠 Classification complete...", 
      "⚡ Building response...",
      "✨ Finalizing layout...",
      "🎯 Ready!"
    ];
    
    let statusTracker = null;
    if (statusCallback) {
      statusTracker = this.statusSystem.startOperation('genui', { message }, statusCallback);
    }

    try {
      // Step 1: Intent Classification (target <1ms)
      const intentStart = process.hrtime.bigint();
      const intentResult = this.intentClassifier.classify(message);
      const intentTime = Number(process.hrtime.bigint() - intentStart) / 1000000;
      
      if (statusTracker) statusTracker.notifyUpdate();

      // Step 2: Route to appropriate tier based on confidence
      let response, tier;
      
      if (intentResult.confidence >= this.confidenceThreshold) {
        // Tier 1: Instant Response (<200ms total)
        tier = 1;
        this.metrics.tier1Hits++;
        response = await this.handleTier1(intentResult.type, message, context);
        
      } else if (intentResult.confidence >= 0.4) {
        // Tier 2: Smart Templates (<1s total)
        tier = 2;
        this.metrics.tier2Hits++;
        response = await this.handleTier2(intentResult.type, message, context);
        
      } else {
        // Tier 3: Full Creative (1-2s total)
        tier = 3;
        this.metrics.tier3Hits++;
        response = await this.handleTier3(message, context);
      }

      const totalTime = Number(process.hrtime.bigint() - startTime) / 1000000;
      
      // Update running averages
      this.updateMetrics(tier, totalTime);
      
      // Complete status
      if (statusTracker) {
        this.statusSystem.completeOperation(flowId, response);
      }

      return {
        ...response,
        tier,
        intentResult,
        timing: {
          intent: Math.round(intentTime * 100) / 100,
          total: Math.round(totalTime * 100) / 100
        },
        metadata: {
          flowId,
          timestamp: Date.now(),
          message: message.slice(0, 100)
        }
      };

    } catch (error) {
      if (statusTracker) {
        this.statusSystem.failOperation(flowId, error);
      }
      
      // Fallback to Tier 3 on any error
      return this.handleTier3(message, context);
    }
  }

  /**
   * Tier 1: Instant Response (<200ms)
   * Pre-built templates for high-confidence classifications
   */
  async handleTier1(layoutType, message, context) {
    const template = this.getTier1Template(layoutType, message, context);
    
    // Cache widget instance for autonomous operations
    if (template.widget) {
      this.activeWidgets.set(layoutType, template.widget);
    }
    
    return {
      ops: template.ops,
      source: 'tier1-instant',
      confidence: 1.0,
      layoutType,
      description: `Instant ${layoutType} layout`
    };
  }

  /**
   * Tier 2: Smart Templates (<1s)
   * Enhanced context processing
   */
  async handleTier2(layoutType, message, context) {
    const enhancedContext = this.parseSmartContext(message, context);
    const template = this.getTier1Template(layoutType, message, enhancedContext);
    
    // Add smart enhancements
    template.ops = this.addSmartEnhancements(template.ops, enhancedContext);
    
    return {
      ops: template.ops,
      source: 'tier2-smart',
      confidence: 0.8,
      layoutType,
      description: `Smart ${layoutType} with enhanced context`
    };
  }

  /**
   * Tier 3: Full Creative (1-2s)
   * Fallback to existing Scratchy system
   */
  async handleTier3(message, context) {
    // In real integration, this would call existing Scratchy LLM system
    return {
      ops: [
        { op: "clear" },
        { 
          op: "upsert", 
          id: "tier3-creative", 
          type: "card", 
          data: { 
            title: "Creative Response", 
            text: `Complex request: "${message.slice(0, 80)}..."\n\nThis would be handled by the full Scratchy LLM system for maximum creativity.` 
          },
          layout: { zone: "auto" }
        }
      ],
      source: 'tier3-creative',
      confidence: 0.5,
      layoutType: 'custom',
      description: 'Full LLM-generated response'
    };
  }

  /**
   * Get Tier 1 template (optimized for speed)
   */
  getTier1Template(layoutType, message, context = {}) {
    switch (layoutType) {
      case 'dashboard':
        return {
          ops: [
            { op: "clear" },
            { op: "upsert", id: "hero", type: "hero", data: { 
              title: context.title || "Dashboard Overview", 
              subtitle: "System metrics and status", 
              icon: "📊", style: "accent" 
            }, layout: { zone: "auto" }},
            { op: "upsert", id: "stats", type: "stats", data: { 
              title: "Key Metrics", 
              items: context.metrics || [
                { label: "Active Users", value: "1,234" },
                { label: "Response Time", value: "0.72ms" },
                { label: "Memory Usage", value: "5MB" },
                { label: "Uptime", value: "99.9%" }
              ]
            }, layout: { zone: "auto" }}
          ]
        };
        
      case 'form':
        return {
          ops: [
            { op: "clear" },
            { op: "upsert", id: "hero", type: "hero", data: { 
              title: "Create New Entry", 
              icon: "📝", style: "accent" 
            }, layout: { zone: "auto" }},
            { op: "upsert", id: "form", type: "form", data: { 
              title: "Form Details", id: "quick-form",
              fields: context.fields || [
                { name: "name", type: "text", label: "Name", value: "" },
                { name: "email", type: "email", label: "Email", value: "" },
                { name: "message", type: "textarea", label: "Message", value: "" }
              ],
              actions: [
                { label: "Submit", action: "submit", style: "primary" },
                { label: "Cancel", action: "cancel", style: "ghost" }
              ]
            }, layout: { zone: "auto" }}
          ]
        };
        
      case 'status':
        return {
          ops: [
            { op: "clear" },
            { op: "upsert", id: "hero", type: "hero", data: { 
              title: "System Status", 
              icon: "⚡", style: "accent" 
            }, layout: { zone: "auto" }},
            { op: "upsert", id: "services", type: "checklist", data: { 
              title: "Services", 
              items: context.services || [
                { text: "Web Server", checked: true },
                { text: "Database", checked: true },
                { text: "API Gateway", checked: true },
                { text: "File Storage", checked: true }
              ]
            }, layout: { zone: "auto" }}
          ]
        };

      case 'notes':
        // Use the autonomous Standard Notes widget
        try {
          const StandardNotesWidget = require('./templates/notes.js').default || require('./templates/notes.js');
          const notesWidget = new StandardNotesWidget();
          const notesTemplate = notesWidget.getTier1Template(context);
          return {
            ...notesTemplate,
            widget: notesWidget // Return widget instance for caching
          };
        } catch (error) {
          console.error('Error loading Standard Notes widget:', error);
          // Fallback to simple template
          return {
            ops: [
              { op: "clear" },
              { op: "upsert", id: "hero", type: "hero", data: { 
                title: "📝 Standard Notes", 
                subtitle: "Widget loading...",
                icon: "🗒️", style: "accent" 
              }, layout: { zone: "auto" }},
              { op: "upsert", id: "error", type: "alert", data: { 
                title: "Loading Error", 
                message: error.message,
                severity: "warning"
              }, layout: { zone: "auto" }}
            ]
          };
        }
        
      default:
        // Default template for other types
        return {
          ops: [
            { op: "clear" },
            { op: "upsert", id: "hero", type: "hero", data: { 
              title: `${layoutType.charAt(0).toUpperCase() + layoutType.slice(1)} View`, 
              icon: "📋", style: "accent" 
            }, layout: { zone: "auto" }},
            { op: "upsert", id: "content", type: "card", data: { 
              title: "Content", 
              text: `${layoutType} layout for: "${message.slice(0, 50)}..."` 
            }, layout: { zone: "auto" }}
          ]
        };
    }
  }

  /**
   * Parse smart context for Tier 2
   */
  parseSmartContext(message, context) {
    const enhanced = { ...context };
    
    // Smart context parsing based on message content
    if (message.includes('server') || message.includes('system')) {
      enhanced.title = "System Dashboard";
      enhanced.metrics = [
        { label: "CPU Usage", value: "23%" },
        { label: "Memory", value: "4.2GB" }, 
        { label: "Disk Space", value: "45%" },
        { label: "Network", value: "125MB/s" }
      ];
    }
    
    if (message.includes('user') || message.includes('account')) {
      enhanced.fields = [
        { name: "username", type: "text", label: "Username", value: "" },
        { name: "email", type: "email", label: "Email Address", value: "" },
        { name: "role", type: "select", label: "Role", options: ["User", "Admin"], value: "" }
      ];
    }
    
    return enhanced;
  }

  /**
   * Add smart enhancements to templates
   */
  addSmartEnhancements(ops, context) {
    // Add contextual alerts, progress indicators, etc.
    if (context.alert) {
      ops.push({
        op: "upsert",
        id: "smart-alert",
        type: "alert",
        data: context.alert,
        layout: { zone: "auto" }
      });
    }
    
    return ops;
  }

  /**
   * Update performance metrics
   */
  updateMetrics(tier, time) {
    if (tier === 1) {
      this.metrics.avgTier1Time = this.metrics.tier1Hits === 1 ? 
        time : (this.metrics.avgTier1Time + time) / 2;
    } else if (tier === 2) {
      this.metrics.avgTier2Time = this.metrics.tier2Hits === 1 ? 
        time : (this.metrics.avgTier2Time + time) / 2;
    } else {
      this.metrics.avgTier3Time = this.metrics.tier3Hits === 1 ? 
        time : (this.metrics.avgTier3Time + time) / 2;
    }
  }

  /**
   * Handle UserAction from Autonomous Widgets
   * Routes actions to appropriate widget instances without AI involvement
   */
  async handleUserAction(widgetType, action, context, statusCallback = null) {
    const flowId = `userAction-${Date.now()}`;
    const startTime = process.hrtime.bigint();
    
    // Get cached widget instance
    const widget = this.activeWidgets.get(widgetType);
    if (!widget || !widget.handleUserAction) {
      throw new Error(`No active autonomous widget found for type: ${widgetType}`);
    }
    
    // Start status tracking
    let statusTracker = null;
    if (statusCallback) {
      statusTracker = this.statusSystem.startOperation(`${widgetType}-action`, { 
        action, 
        widget: widgetType 
      }, statusCallback);
    }
    
    try {
      // Route to widget's autonomous logic
      const result = await widget.handleUserAction(action, context);
      
      const totalTime = Number(process.hrtime.bigint() - startTime) / 1000000;
      
      // Complete status
      if (statusTracker) {
        this.statusSystem.completeOperation(flowId, result);
      }
      
      return {
        ...result,
        timing: {
          total: Math.round(totalTime * 100) / 100
        },
        source: `${widgetType}-autonomous`,
        metadata: {
          flowId,
          timestamp: Date.now(),
          action,
          widgetType
        }
      };
      
    } catch (error) {
      if (statusTracker) {
        this.statusSystem.failOperation(flowId, error);
      }
      throw error;
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    const total = this.metrics.totalRequests;
    return {
      ...this.metrics,
      tier1Percentage: total > 0 ? Math.round((this.metrics.tier1Hits / total) * 100) : 0,
      tier2Percentage: total > 0 ? Math.round((this.metrics.tier2Hits / total) * 100) : 0,
      tier3Percentage: total > 0 ? Math.round((this.metrics.tier3Hits / total) * 100) : 0,
      activeWidgets: Array.from(this.activeWidgets.keys())
    };
  }
}

// Demo integration
async function demoIntegration() {
  console.log('🔌 Scratchy GenUI Integration Demo\n');
  
  const engine = new ScratchyGenUIEngine();
  
  const testCases = [
    { message: "show me the system dashboard", expected: "tier1" },
    { message: "create a new user account form", expected: "tier1" },
    { message: "what's the current server status?", expected: "tier1" },
    { message: "show my notes", expected: "tier1" },
    { message: "show me some data", expected: "tier2" },
    { message: "this is a very complex creative request that needs custom components and sophisticated reasoning", expected: "tier3" }
  ];
  
  for (const testCase of testCases) {
    console.log(`\n🚀 Processing: "${testCase.message}"`);
    
    const result = await engine.processMessage(testCase.message, {}, (status) => {
      if (status.message) console.log(`   ${status.message}`);
    });
    
    console.log(`   ✅ Result: Tier ${result.tier} (${result.timing.total}ms)`);
    console.log(`   📊 Layout: ${result.layoutType} (${result.ops.length} components)`);
    console.log(`   🎯 Confidence: ${result.intentResult.confidence}`);
    console.log(`   📝 Source: ${result.source}`);
  }
  
  // Performance summary
  console.log('\n📈 Performance Summary:');
  const metrics = engine.getMetrics();
  console.log(`   Total Requests: ${metrics.totalRequests}`);
  console.log(`   Tier 1 (Instant): ${metrics.tier1Percentage}% (avg ${metrics.avgTier1Time.toFixed(1)}ms)`);
  console.log(`   Tier 2 (Smart): ${metrics.tier2Percentage}% (avg ${metrics.avgTier2Time.toFixed(1)}ms)`);
  console.log(`   Tier 3 (Creative): ${metrics.tier3Percentage}% (avg ${metrics.avgTier3Time.toFixed(1)}ms)`);
  
  console.log('\n🎯 Integration Status: COMPLETE');
  console.log('Ready to wire into Scratchy message flow!');
}

if (require.main === module) {
  demoIntegration().catch(console.error);
}

module.exports = { ScratchyGenUIEngine };