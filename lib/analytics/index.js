'use strict';

/**
 * Analytics System — Barrel Module
 *
 * Wires all analytics components together and provides a clean init interface
 * for serve.js. Single entry point for the entire UX analytics system.
 *
 * Usage in serve.js:
 *   const { initAnalytics } = require('./lib/analytics');
 *   const analytics = initAnalytics({ wsSessions });
 *   analytics.start();
 */

const path = require('path');
const fs = require('fs');

// Foundation
const { analyticsEventBus, EVENT_TYPES } = require('./event-bus');
const { EventStore } = require('./stores/event-store');
const { RollupStore } = require('./stores/rollup-store');
const { RetentionManager } = require('./stores/retention-manager');

// Collectors
const { createConversationCollector } = require('./collectors/conversation-collector');
const { createErrorCollector } = require('./collectors/error-collector');
const { createToolCollector } = require('./collectors/tool-collector');
const { createSessionCollector } = require('./collectors/session-collector');

// Aggregators
const { createConversationAggregator } = require('./aggregators/conversation-aggregator');
const { createToolAggregator } = require('./aggregators/tool-aggregator');
const { createErrorAggregator } = require('./aggregators/error-aggregator');
const { createUserAggregator } = require('./aggregators/user-aggregator');
const { createRollupScheduler } = require('./aggregators/rollup-scheduler');

// API
const { createAnalyticsRoutes } = require('./api/analytics-routes');
const { createAnalyticsWs } = require('./api/analytics-ws');

/**
 * Initialize the analytics system.
 *
 * Creates all components in dependency order, wires the EventBus → EventStore
 * pipeline, and returns collector handles + API handlers for serve.js integration.
 *
 * @param {Object} opts
 * @param {string} [opts.dataDir] - Storage directory (default: .scratchy-data/analytics/)
 * @param {Map}    opts.wsSessions - WS sessions map from serve.js
 * @param {number} [opts.retentionDays=30] - Event retention in days
 * @returns {Object} Analytics system interface
 */
function initAnalytics(opts = {}) {
  const dataDir = opts.dataDir || path.join(process.cwd(), '.scratchy-data', 'analytics');
  const wsSessions = opts.wsSessions || new Map();
  const retentionDays = opts.retentionDays || 30;

  // ── Ensure data directory exists ──
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    console.error('[Analytics] Failed to create data directory:', e.message);
  }

  // ── 1. Foundation ──
  const eventBus = analyticsEventBus;

  const eventStore = new EventStore(dataDir);
  const rollupStore = new RollupStore(dataDir);
  const retentionManager = new RetentionManager(dataDir, {
    rawEventsDays: retentionDays,
    hourlyRollupDays: retentionDays,
    dailyRollupDays: retentionDays * 12, // keep daily rollups ~1 year
  });

  // ── 2. Collectors (emit to EventBus) ──
  const conversationCollector = createConversationCollector(eventBus);
  const errorCollector = createErrorCollector(eventBus);
  const toolCollector = createToolCollector(eventBus);
  const sessionCollector = createSessionCollector(eventBus);

  // ── 3. Aggregators ──
  const aggregators = {
    conversation: createConversationAggregator(),
    tool: createToolAggregator(),
    error: createErrorAggregator(),
    user: createUserAggregator(),
  };

  // ── 4. Rollup Scheduler ──
  const rollupScheduler = createRollupScheduler(eventStore, rollupStore, aggregators);

  // ── 5. API Layer ──
  const handleRequest = createAnalyticsRoutes({ eventStore, rollupStore, eventBus, aggregators });
  const analyticsWs = createAnalyticsWs({ eventStore, rollupStore, eventBus, aggregators, wsSessions });

  // ── 6. Wire EventBus → EventStore (async, non-blocking) ──
  // Every analytics event emitted by collectors gets persisted.
  // Use setImmediate to avoid blocking the bus if store is slow.
  for (const type of EVENT_TYPES) {
    eventBus.on(type, (event) => {
      setImmediate(() => {
        try {
          eventStore.append(event);
        } catch (e) {
          console.error(`[Analytics] EventStore.addEvent failed for ${type}:`, e.message);
        }
      });
    });
  }

  // ── 7. Rollup completion → WS push ──
  // RollupScheduler currently runs fire-and-forget (no event emission).
  // When scheduler becomes an EventEmitter, wire:
  //   rollupScheduler.on('hourlyComplete', (rollup) => analyticsWs.pushRollupComplete(rollup));
  // For now, the 30s WS live-update polling handles real-time dashboard needs.

  // ── Lifecycle ──
  let _running = false;
  let _retentionInterval = null;

  function start() {
    if (_running) {
      console.log('[Analytics] System already running');
      return;
    }
    _running = true;

    // Start rollup scheduler (hourly + daily rollups)
    try {
      rollupScheduler.start();
    } catch (e) {
      console.error('[Analytics] Failed to start rollup scheduler:', e.message);
    }

    // Start WS live update interval (30s)
    try {
      analyticsWs.start();
    } catch (e) {
      console.error('[Analytics] Failed to start WS live updates:', e.message);
    }

    // Start retention cleanup (daily check)
    _retentionInterval = setInterval(() => {
      try {
        if (retentionManager.cleanup) {
          retentionManager.cleanup();
        } else if (retentionManager.run) {
          retentionManager.run();
        }
      } catch (e) {
        console.error('[Analytics] Retention cleanup error:', e.message);
      }
    }, 24 * 60 * 60 * 1000); // once per day
    if (_retentionInterval.unref) _retentionInterval.unref();

    console.log(`[Analytics] System started — dataDir=${dataDir} retentionDays=${retentionDays}`);
  }

  function stop() {
    if (!_running) return;
    _running = false;

    try { rollupScheduler.stop(); } catch (e) { /* ignore */ }
    try { analyticsWs.stop(); } catch (e) { /* ignore */ }
    if (_retentionInterval) {
      clearInterval(_retentionInterval);
      _retentionInterval = null;
    }

    console.log('[Analytics] System stopped');
  }

  // ── Return public interface ──
  return {
    // Collectors — serve.js calls these when events happen
    collectors: {
      conversation: conversationCollector,
      error: errorCollector,
      tool: toolCollector,
      session: sessionCollector,
    },

    // REST API handler — mount on /api/analytics/*
    handleRequest,

    // WS manager — call subscribe/unsubscribe for admin sessions
    ws: analyticsWs,

    // Lifecycle
    start,
    stop,

    // Internals (for debugging/health checks)
    eventBus,
    eventStore,
    rollupStore,
  };
}

module.exports = { initAnalytics };
