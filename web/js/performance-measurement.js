// ============================================
// Scratchy — Performance Measurement System
// ============================================
// Measures end-to-end latency from message send to first tile render

class ScratchyPerformanceMeasurement {
  constructor() {
    this.measurements = [];
    this.currentMeasurement = null;
    this.observers = [];
    this.setupMutationObserver();
  }

  // Start measuring when user sends a message
  startMeasurement(messageText) {
    this.currentMeasurement = {
      messageText: messageText.slice(0, 100),
      startTime: performance.now(),
      sendTime: null,
      firstResponseTime: null,
      firstTileTime: null,
      genUIProcessingTime: null,
      domRenderTime: null,
      totalLatency: null,
      tilesGenerated: 0,
      phase: 'sending'
    };
    
    console.log('[Perf] 📊 Starting measurement for:', messageText.slice(0, 50) + '...');
    return this.currentMeasurement;
  }

  // Mark when message is actually sent
  markSent() {
    if (this.currentMeasurement) {
      this.currentMeasurement.sendTime = performance.now();
      this.currentMeasurement.phase = 'waiting_response';
      console.log('[Perf] 📤 Message sent at:', this.currentMeasurement.sendTime - this.currentMeasurement.startTime, 'ms');
    }
  }

  // Mark when first response arrives
  markFirstResponse() {
    if (this.currentMeasurement && this.currentMeasurement.phase === 'waiting_response') {
      this.currentMeasurement.firstResponseTime = performance.now();
      this.currentMeasurement.phase = 'processing_response';
      console.log('[Perf] 📨 First response at:', this.currentMeasurement.firstResponseTime - this.currentMeasurement.startTime, 'ms');
    }
  }

  // Mark when first tile/component appears
  markFirstTile(tileType = 'unknown') {
    if (this.currentMeasurement && !this.currentMeasurement.firstTileTime) {
      this.currentMeasurement.firstTileTime = performance.now();
      this.currentMeasurement.phase = 'rendering';
      this.currentMeasurement.tilesGenerated++;
      
      const latency = this.currentMeasurement.firstTileTime - this.currentMeasurement.startTime;
      console.log('[Perf] 🎯 FIRST TILE rendered:', tileType, 'at', latency.toFixed(2), 'ms');
      
      // Check if we hit the target
      if (latency <= 200) {
        console.log('[Perf] ✅ TARGET ACHIEVED: Under 200ms!');
      } else {
        console.log('[Perf] ⚠️ TARGET MISSED: Over 200ms target');
      }
    }
  }

  // Mark when all rendering is complete
  markRenderComplete() {
    if (this.currentMeasurement && this.currentMeasurement.firstTileTime) {
      this.currentMeasurement.domRenderTime = performance.now();
      this.currentMeasurement.totalLatency = this.currentMeasurement.domRenderTime - this.currentMeasurement.startTime;
      this.currentMeasurement.phase = 'complete';
      
      console.log('[Perf] ✅ Render complete at:', this.currentMeasurement.totalLatency.toFixed(2), 'ms');
      
      this.measurements.push({ ...this.currentMeasurement });
      this.currentMeasurement = null;
      
      // Show summary
      this.showMeasurementSummary();
    }
  }

  // Setup mutation observer to detect when components are added
  setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!this.currentMeasurement) return;
      
      let foundTile = false;
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            // Detect canvas components or new message tiles
            if (node.nodeType === Node.ELEMENT_NODE) {
              const isCanvasTile = node.classList?.contains('canvas-tile') || 
                                   node.querySelector?.('.canvas-tile');
              const isLiveComponent = node.classList?.contains('live-component') ||
                                     node.querySelector?.('.live-component');
              const isGenUIContent = node.innerHTML?.includes('GenUI') || 
                                     node.innerHTML?.includes('scratchy-canvas');
              
              if (isCanvasTile || isLiveComponent || isGenUIContent) {
                foundTile = true;
                this.markFirstTile(node.className || node.tagName.toLowerCase());
              }
            }
          });
        }
      });
    });

    // Observe the main content areas
    const targets = ['#messages', '#canvas-grid', '.canvas-viewport'];
    targets.forEach(selector => {
      const target = document.querySelector(selector);
      if (target) {
        observer.observe(target, { 
          childList: true, 
          subtree: true,
          characterData: false 
        });
      }
    });

    this.observers.push(observer);
  }

  // Show measurement summary
  showMeasurementSummary() {
    const m = this.measurements[this.measurements.length - 1];
    if (!m) return;

    console.group('[Perf] 📊 MEASUREMENT COMPLETE');
    console.log('Message:', m.messageText);
    console.log('Send latency:', (m.sendTime - m.startTime).toFixed(2), 'ms');
    console.log('Response latency:', (m.firstResponseTime - m.startTime).toFixed(2), 'ms');
    console.log('First tile latency:', (m.firstTileTime - m.startTime).toFixed(2), 'ms');
    console.log('Total latency:', m.totalLatency.toFixed(2), 'ms');
    console.log('Tiles generated:', m.tilesGenerated);
    console.log('Target (200ms):', m.firstTileTime - m.startTime <= 200 ? '✅ ACHIEVED' : '❌ MISSED');
    console.groupEnd();
  }

  // Get performance statistics
  getStats() {
    if (this.measurements.length === 0) return null;
    
    const latencies = this.measurements.map(m => m.firstTileTime - m.startTime);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    const under200 = latencies.filter(l => l <= 200).length;
    
    return {
      totalMeasurements: this.measurements.length,
      averageLatency: avg.toFixed(2),
      minLatency: min.toFixed(2),
      maxLatency: max.toFixed(2),
      successRate: ((under200 / this.measurements.length) * 100).toFixed(1),
      measurements: this.measurements
    };
  }

  // Clear all measurements
  reset() {
    this.measurements = [];
    this.currentMeasurement = null;
    console.log('[Perf] 🧹 Performance measurements reset');
  }
}

// Global instance
window.ScratchyPerf = new ScratchyPerformanceMeasurement();

// Hook into send button
document.addEventListener('DOMContentLoaded', () => {
  // Hook regular chat input
  const sendBtn = document.getElementById('send-btn');
  const messageInput = document.getElementById('message-input');
  
  if (sendBtn && messageInput) {
    sendBtn.addEventListener('click', () => {
      const text = messageInput.value.trim();
      if (text) {
        window.ScratchyPerf.startMeasurement(text);
      }
    });
  }

  // Hook canvas chat input
  const canvasSendBtn = document.getElementById('canvas-send-btn');
  const canvasInput = document.getElementById('canvas-chat-input');
  
  if (canvasSendBtn && canvasInput) {
    canvasSendBtn.addEventListener('click', () => {
      const text = canvasInput.value.trim();
      if (text) {
        window.ScratchyPerf.startMeasurement(text);
      }
    });
  }

  // Add performance display to UI
  const headerRight = document.querySelector('.header-right');
  if (headerRight) {
    const perfBtn = document.createElement('button');
    perfBtn.id = 'perf-toggle';
    perfBtn.className = 'perf-toggle';
    perfBtn.title = 'Show performance stats';
    perfBtn.textContent = '📊';
    perfBtn.onclick = showPerformanceStats;
    headerRight.insertBefore(perfBtn, headerRight.firstChild);
  }
});

// Show performance stats
function showPerformanceStats() {
  const stats = window.ScratchyPerf.getStats();
  if (!stats) {
    alert('No performance measurements yet. Send a message to start measuring!');
    return;
  }
  
  const summary = `📊 PERFORMANCE STATS\n\n` +
    `Total measurements: ${stats.totalMeasurements}\n` +
    `Average latency: ${stats.averageLatency}ms\n` +
    `Best: ${stats.minLatency}ms | Worst: ${stats.maxLatency}ms\n` +
    `Success rate (< 200ms): ${stats.successRate}%\n\n` +
    `Recent measurements:\n` +
    stats.measurements.slice(-3).map(m => 
      `• ${m.messageText.slice(0, 30)}... → ${(m.firstTileTime - m.startTime).toFixed(1)}ms`
    ).join('\n');
  
  alert(summary);
}

console.log('[Perf] 📊 Performance measurement system loaded');