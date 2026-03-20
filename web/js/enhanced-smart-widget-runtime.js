/**
 * Enhanced Smart Widget Runtime - Phase 3
 * Integrates security manager with widget deployment
 */

// Global security manager instance
let globalSecurityManager = null;

// Initialize security manager
function initializeSecurityManager() {
  if (!globalSecurityManager) {
    globalSecurityManager = new WidgetSecurityManager();
    console.log('[SmartWidget] Security manager initialized');
  }
  return globalSecurityManager;
}

// Enhanced smart widget factory that uses security manager
function createSecureSmartWidget(widgetData, containerEl) {
  const securityManager = initializeSecurityManager();
  const widgetId = 'widget-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  
  return {
    async deploy() {
      try {
        // Deploy through security manager
        const monitoredWidget = await securityManager.validateAndDeploy(widgetId, widgetData);
        
        // Set up container
        monitoredWidget.runtime.container = containerEl;
        
        // Deploy the actual widget
        const deployedWidget = await monitoredWidget.runtime.deploy();
        
        return {
          ...deployedWidget,
          widgetId,
          securityManager,
          monitoredWidget,
          
          destroy() {
            // Clean termination through security manager
            securityManager.terminateWidget(widgetId, 'User requested destruction');
            if (deployedWidget.destroy) {
              deployedWidget.destroy();
            }
          },
          
          getSecurityInfo() {
            const widget = securityManager.widgets.get(widgetId);
            if (!widget) return null;
            
            return {
              widgetId,
              resourceUsage: widget.resourceTracker,
              uptime: Date.now() - widget.startTime,
              suspended: widget.suspended || false
            };
          }
        };
        
      } catch (error) {
        // Show security error in container
        containerEl.innerHTML = `
          <div style="padding: 16px; background: rgba(239,68,68,0.1); border: 1px solid #ef4444; border-radius: 6px; color: #ef4444;">
            <div style="font-weight: bold; margin-bottom: 4px;">🛡️ Security Error</div>
            <div style="font-size: 0.9rem;">${error.message}</div>
            <div style="font-size: 0.7rem; opacity: 0.8; margin-top: 4px;">Widget blocked by security manager</div>
          </div>
        `;
        
        throw error;
      }
    }
  };
}

// Enhanced live component for smart widgets with security
if (typeof _factories !== 'undefined') {
  _factories["smart-widget"] = function(d) {
    var r = el("div", {style: "padding: 12px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;"});
    var widget = null;
    var errorEl = null;
    var isDeploying = false;
    
    // Apply size class if specified
    var widgetSize = (d.config && d.config.size) || 'auto';
    if (widgetSize && widgetSize !== 'default') {
      r.setAttribute('data-widget-size', 'widget-' + widgetSize);
    }
    
    function createWidget() {
      if (isDeploying) return;
      isDeploying = true;
      
      // Clear any previous content
      r.innerHTML = "";
      if (errorEl) {
        errorEl = null;
      }
      
      // Show security validation state
      var loadingEl = el("div", {
        style: "color: #888; font-size: 0.8rem; padding: 8px; text-align: center; opacity: 0.7;"
      });
      loadingEl.innerHTML = "🛡️ Security validation...<br><span style='font-size: 0.7rem;'>Phase 3 protection active</span>";
      r.appendChild(loadingEl);
      
      // Create secure widget
      var secureWidget = createSecureSmartWidget(d, r);
      
      // Deploy with security validation
      secureWidget.deploy().then(function(deployedWidget) {
        isDeploying = false;
        
        // Remove loading indicator
        if (r.contains(loadingEl)) {
          r.removeChild(loadingEl);
        }
        
        widget = deployedWidget;
        console.log('[SmartWidget] Secure deployment successful:', deployedWidget.widgetId);
        
        // Add security indicator
        var securityIndicator = el("div", {
          style: "position: absolute; top: 2px; right: 2px; background: rgba(0,184,148,0.8); color: white; padding: 2px 4px; border-radius: 2px; font-size: 0.6rem; z-index: 10;"
        });
        securityIndicator.textContent = "🛡️";
        securityIndicator.title = "Phase 3 Security Active";
        r.style.position = "relative";
        r.appendChild(securityIndicator);
        
      }).catch(function(error) {
        isDeploying = false;
        console.error('[SmartWidget] Secure deployment failed:', error);
        
        // Remove loading indicator
        if (r.contains(loadingEl)) {
          r.removeChild(loadingEl);
        }
        
        // Error already shown by createSecureSmartWidget
      });
    }
    
    // Initialize widget
    createWidget();
    
    return {
      el: r,
      update: function(newData) {
        // Destroy current widget first
        if (widget && widget.destroy) {
          widget.destroy();
        }
        widget = null;
        
        // Update data and recreate
        d = newData;
        createWidget();
      },
      destroy: function() {
        if (widget && widget.destroy) {
          widget.destroy();
        }
        widget = null;
      },
      
      getSecurityInfo: function() {
        return widget ? widget.getSecurityInfo() : null;
      }
    };
  };
}

// Security dashboard utilities
function createSecurityDashboard() {
  const securityManager = initializeSecurityManager();
  
  return {
    getReport: () => securityManager.getSecurityReport(),
    exportAuditLog: (format) => securityManager.exportAuditLog(format),
    getActiveWidgets: () => Array.from(securityManager.widgets.keys()),
    terminateWidget: (widgetId, reason) => securityManager.terminateWidget(widgetId, reason)
  };
}

// Make available globally
window.initializeSecurityManager = initializeSecurityManager;
window.createSecureSmartWidget = createSecureSmartWidget;
window.createSecurityDashboard = createSecurityDashboard;