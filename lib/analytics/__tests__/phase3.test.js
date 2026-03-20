'use strict';

/**
 * Phase 3 Unit Tests — aggregators + rollup store + rollup scheduler
 * Run: node lib/analytics/__tests__/phase3.test.js
 */

const fs = require('fs');
const path = require('path');
const { ConversationAggregator } = require('../aggregators/conversation-aggregator');
const { ToolAggregator } = require('../aggregators/tool-aggregator');
const { ErrorAggregator } = require('../aggregators/error-aggregator');
const { UserAggregator } = require('../aggregators/user-aggregator');
const { RollupStore } = require('../stores/rollup-store');
const { RollupScheduler } = require('../aggregators/rollup-scheduler');
const { EventStore } = require('../stores/event-store');
const { AnalyticsEventBus } = require('../event-bus');

// ─── Harness ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function suite(name) { console.log(`\n━━━ ${name} ━━━`); }
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}`); console.log(`     ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m || ''}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const TEMP = path.join('/tmp', `p3-test-${Date.now()}`);
function clean() { if (fs.existsSync(TEMP)) fs.rmSync(TEMP, { recursive: true, force: true }); }

// ─── Test Data Helpers ───────────────────────────────────────────────────────

const now = Date.now();
function evt(type, subtype, userId, meta, tsOffset = 0) {
  return { id: `e${Math.random().toString(36).slice(2, 8)}`, type, subtype, ts: now + tsOffset, userId, sessionId: 's1', meta };
}

function makeConvEvents() {
  return [
    evt('conversation', 'user_message', 'u1', { length: 50, wordCount: 8, hasAttachment: false, source: 'webchat' }),
    evt('conversation', 'assistant_response', 'u1', { length: 200, wordCount: 30, responseTimeMs: 1500, totalTimeMs: 3000, model: 'claude-opus-4-6', provider: 'anthropic', inputTokens: 500, outputTokens: 80, cacheReadTokens: 200, cacheWriteTokens: 50, cost: 0.02, hasCanvasOps: true, canvasOpCount: 3, toolCallCount: 1 }, 100),
    evt('conversation', 'user_message', 'u2', { length: 30, wordCount: 5, hasAttachment: false, source: 'discord' }, 200),
    evt('conversation', 'assistant_response', 'u2', { length: 150, wordCount: 22, responseTimeMs: 800, totalTimeMs: 2000, model: 'claude-sonnet-4', provider: 'anthropic', inputTokens: 300, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 20, cost: 0.005, hasCanvasOps: false, canvasOpCount: 0, toolCallCount: 0 }, 300),
    evt('conversation', 'user_message', 'u1', { length: 80, wordCount: 12, hasAttachment: true, source: 'webchat' }, 400),
    evt('conversation', 'assistant_response', 'u1', { length: 500, wordCount: 75, responseTimeMs: 3000, totalTimeMs: 8000, model: 'claude-opus-4-6', provider: 'anthropic', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 100, cost: 0.05, hasCanvasOps: true, canvasOpCount: 5, toolCallCount: 3 }, 500),
  ];
}

function makeToolEvents() {
  return [
    evt('tool', 'tool_start', 'u1', { toolName: 'exec', callId: 'c1', argsPreview: 'ls' }),
    evt('tool', 'tool_end', 'u1', { toolName: 'exec', callId: 'c1', durationMs: 120, success: true, resultSizeBytes: 50, truncated: false }, 50),
    evt('tool', 'tool_start', 'u1', { toolName: 'web_search', callId: 'c2', argsPreview: 'query' }, 100),
    evt('tool', 'tool_error', 'u1', { toolName: 'web_search', callId: 'c2', durationMs: 5000, errorType: 'timeout', errorMessage: 'timed out' }, 200),
    evt('tool', 'tool_start', 'u1', { toolName: 'exec', callId: 'c3', argsPreview: 'cat' }, 300),
    evt('tool', 'tool_end', 'u1', { toolName: 'exec', callId: 'c3', durationMs: 80, success: true, resultSizeBytes: 200, truncated: false }, 350),
    evt('tool', 'tool_start', 'u1', { toolName: 'exec', callId: 'c4', argsPreview: 'rm' }, 400),
    evt('tool', 'tool_end', 'u1', { toolName: 'exec', callId: 'c4', durationMs: 50, success: false, resultSizeBytes: 0, truncated: false }, 420),
  ];
}

function makeErrorEvents() {
  return [
    evt('error', 'gateway_error', 'u1', { errorCode: 429, errorType: 'rate_limit', provider: 'anthropic', model: 'opus', message: 'rate limited', retryable: true }),
    evt('error', 'gateway_error', 'u1', { errorCode: 500, errorType: 'internal', provider: 'anthropic', model: 'opus', message: 'server error', retryable: false }, 100),
    evt('error', 'ws_error', 'u2', { errorType: 'disconnect', userId: 'u2', connectionDurationMs: 30000 }, 200),
    evt('error', 'widget_error', 'u1', { widget: 'calendar', action: 'cal-month', errorType: 'oauth', message: 'expired' }, 300),
    evt('error', 'widget_error', 'u1', { widget: 'calendar', action: 'cal-create', errorType: 'oauth', message: 'expired' }, 350),
    evt('error', 'user_facing_error', 'u1', { originalError: 'e1', displayedMessage: 'Something went wrong', recoverable: true }, 400),
    evt('error', 'user_facing_error', 'u2', { originalError: 'e2', displayedMessage: 'Fatal error', recoverable: false }, 500),
  ];
}

function makeAllEvents() {
  return [
    ...makeConvEvents(),
    ...makeToolEvents(),
    ...makeErrorEvents(),
    evt('session', 'session_start', 'u1', { source: 'webchat', userAgent: 'Mozilla', returning: false, daysSinceLastVisit: null }),
    evt('session', 'session_start', 'u2', { source: 'discord', userAgent: 'Chrome', returning: true, daysSinceLastVisit: 3 }, 50),
    evt('session', 'feature_use', 'u1', { feature: 'canvas', action: 'first_use', detail: 'dashboard' }, 200),
    evt('session', 'feature_use', 'u2', { feature: 'tts', action: 'first_use', detail: 'voice' }, 250),
    evt('session', 'feature_use', 'u1', { feature: 'tts', action: 'first_use', detail: null }, 300),
  ];
}

// ─── CONVERSATION AGGREGATOR ─────────────────────────────────────────────────

suite('ConversationAggregator');

test('aggregate with typical events', () => {
  const agg = new ConversationAggregator();
  const r = agg.aggregate(makeConvEvents());
  assertEqual(r.userMessages, 3, 'userMessages');
  assertEqual(r.assistantMessages, 3, 'assistantMessages');
  assertEqual(r.totalMessages, 6, 'totalMessages');
  assert(r.avgUserLength > 0, 'avgUserLength > 0');
  assert(r.avgAssistantLength > 0, 'avgAssistantLength > 0');
  assert(r.avgResponseTimeMs > 0, 'avgResponseTimeMs > 0');
  assert(r.p95ResponseTimeMs >= r.avgResponseTimeMs, 'p95 >= avg');
  assert(Math.abs(r.totalCost - 0.075) < 0.001, `totalCost should be ~0.075, got ${r.totalCost}`);
});

test('aggregate bySource counts', () => {
  const agg = new ConversationAggregator();
  const r = agg.aggregate(makeConvEvents());
  assertEqual(r.bySource.webchat, 2, 'webchat');
  assertEqual(r.bySource.discord, 1, 'discord');
});

test('aggregate byModel breakdown', () => {
  const agg = new ConversationAggregator();
  const r = agg.aggregate(makeConvEvents());
  assert(r.byModel['claude-opus-4-6'], 'Should have opus');
  assert(r.byModel['claude-sonnet-4'], 'Should have sonnet');
  assertEqual(r.byModel['claude-opus-4-6'].calls, 2, 'opus calls');
  assertEqual(r.byModel['claude-sonnet-4'].calls, 1, 'sonnet calls');
});

test('aggregate canvasResponseRate', () => {
  const agg = new ConversationAggregator();
  const r = agg.aggregate(makeConvEvents());
  // 2 out of 3 assistant responses have canvas ops
  assert(Math.abs(r.canvasResponseRate - 2/3) < 0.01, `canvasResponseRate should be ~0.67, got ${r.canvasResponseRate}`);
});

test('aggregate modelsUsed', () => {
  const agg = new ConversationAggregator();
  const r = agg.aggregate(makeConvEvents());
  assert(r.modelsUsed.includes('claude-opus-4-6'));
  assert(r.modelsUsed.includes('claude-sonnet-4'));
});

test('aggregate with empty events', () => {
  const agg = new ConversationAggregator();
  const r = agg.aggregate([]);
  assertEqual(r.totalMessages, 0);
  assertEqual(r.avgResponseTimeMs, 0);
  assertEqual(r.totalCost, 0);
});

test('aggregate ignores non-conversation events', () => {
  const agg = new ConversationAggregator();
  const r = agg.aggregate(makeToolEvents());
  assertEqual(r.totalMessages, 0);
});

test('aggregate tokens sum', () => {
  const agg = new ConversationAggregator();
  const r = agg.aggregate(makeConvEvents());
  assertEqual(r.totalInputTokens, 1800, 'inputTokens: 500+300+1000');
  assertEqual(r.totalOutputTokens, 330, 'outputTokens: 80+50+200');
});

test('mergeDailyRollup combines hourly slices', () => {
  const agg = new ConversationAggregator();
  const slice1 = agg.aggregate(makeConvEvents().slice(0, 2));
  const slice2 = agg.aggregate(makeConvEvents().slice(2, 4));
  const daily = agg.mergeDailyRollup([slice1, slice2]);
  assertEqual(daily.totalMessages, slice1.totalMessages + slice2.totalMessages);
  assert(daily.totalCost > 0);
});

// ─── TOOL AGGREGATOR ─────────────────────────────────────────────────────────

suite('ToolAggregator');

test('aggregate with typical events', () => {
  const agg = new ToolAggregator();
  const r = agg.aggregate(makeToolEvents());
  assertEqual(r.totalToolCalls, 4, 'totalToolCalls');
  assertEqual(r.totalErrors, 1, 'totalErrors');
});

test('aggregate byTool breakdown', () => {
  const agg = new ToolAggregator();
  const r = agg.aggregate(makeToolEvents());
  assert(r.byTool.exec, 'Should have exec');
  assertEqual(r.byTool.exec.totalCalls, 3, 'exec calls');
  assertEqual(r.byTool.exec.successes, 2, 'exec successes');
  assertEqual(r.byTool.exec.failures, 1, 'exec failures');
  assert(r.byTool.exec.avgDurationMs > 0, 'exec avgDuration');
});

test('aggregate overallSuccessRate', () => {
  const agg = new ToolAggregator();
  const r = agg.aggregate(makeToolEvents());
  // 2 successful ends out of 4 starts (exec x2 success + exec x1 fail + web_search error)
  // Actually: tool_end with success=true: c1(exec), c3(exec) = 2; tool_end with success=false: c4(exec) = not counted as success
  // tool_error: c2(web_search) = error
  // So successful = 2 out of 4 starts = 0.5
  assertEqual(r.overallSuccessRate, 0.5, 'overallSuccessRate');
});

test('aggregate mostUsed ranking', () => {
  const agg = new ToolAggregator();
  const r = agg.aggregate(makeToolEvents());
  assertEqual(r.mostUsed[0], 'exec', 'exec should be most used');
});

test('aggregate errorHotspots', () => {
  const agg = new ToolAggregator();
  const r = agg.aggregate(makeToolEvents());
  assert(r.errorHotspots.length > 0, 'Should have error hotspots');
  const timeout = r.errorHotspots.find(h => h.errorType === 'timeout');
  assert(timeout, 'Should have timeout hotspot');
});

test('aggregate with no tool events', () => {
  const agg = new ToolAggregator();
  const r = agg.aggregate([]);
  assertEqual(r.totalToolCalls, 0);
  assertEqual(r.totalErrors, 0);
});

test('aggregate ignores non-tool events', () => {
  const agg = new ToolAggregator();
  const r = agg.aggregate(makeConvEvents());
  assertEqual(r.totalToolCalls, 0);
});

test('p95 duration is >= average', () => {
  const agg = new ToolAggregator();
  const r = agg.aggregate(makeToolEvents());
  if (r.byTool.exec && r.byTool.exec.p95DurationMs !== undefined) {
    assert(r.byTool.exec.p95DurationMs >= r.byTool.exec.avgDurationMs, 'p95 >= avg');
  }
});

test('mergeDailyRollup combines slices', () => {
  const agg = new ToolAggregator();
  const s1 = agg.aggregate(makeToolEvents().slice(0, 4));
  const s2 = agg.aggregate(makeToolEvents().slice(4));
  const daily = agg.mergeDailyRollup([s1, s2]);
  assertEqual(daily.totalToolCalls, s1.totalToolCalls + s2.totalToolCalls);
});

// ─── ERROR AGGREGATOR ────────────────────────────────────────────────────────

suite('ErrorAggregator');

test('aggregate with typical events', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeErrorEvents());
  assertEqual(r.totalErrors, 7, 'totalErrors');
  assertEqual(r.byCategory.gateway, 2);
  assertEqual(r.byCategory.ws, 1);
  assertEqual(r.byCategory.widget, 2);
  assertEqual(r.byCategory.user_facing, 2);
});

test('aggregate byErrorType', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeErrorEvents());
  assertEqual(r.byErrorType.rate_limit, 1);
  assertEqual(r.byErrorType.internal, 1);
  assertEqual(r.byErrorType.disconnect, 1);
  assertEqual(r.byErrorType.oauth, 2);
});

test('aggregate byProvider (gateway only)', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeErrorEvents());
  assertEqual(r.byProvider.anthropic, 2);
});

test('aggregate byWidget', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeErrorEvents());
  assertEqual(r.byWidget.calendar, 2);
});

test('aggregate retryableRate', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeErrorEvents());
  // 1 retryable (429) out of 2 gateway errors = 0.5
  assertEqual(r.retryableRate, 0.5, 'retryableRate');
});

test('aggregate recoverableRate', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeErrorEvents());
  // 1 recoverable out of 2 user_facing = 0.5
  assertEqual(r.recoverableRate, 0.5, 'recoverableRate');
});

test('aggregate recent has up to 10 items', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeErrorEvents());
  assert(r.recent.length <= 10);
  assert(r.recent.length === 7, 'Should have all 7 since < 10');
});

test('aggregate errorHotspots', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeErrorEvents());
  assert(r.errorHotspots.length > 0);
  const oauthHot = r.errorHotspots.find(h => h.errorType === 'oauth');
  assert(oauthHot, 'oauth should be a hotspot');
  assertEqual(oauthHot.count, 2);
});

test('aggregate with empty events', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate([]);
  assertEqual(r.totalErrors, 0);
  assertEqual(r.retryableRate, 0);
});

test('aggregate ignores non-error events', () => {
  const agg = new ErrorAggregator();
  const r = agg.aggregate(makeConvEvents());
  assertEqual(r.totalErrors, 0);
});

test('mergeDailyRollup merges slices', () => {
  const agg = new ErrorAggregator();
  const s1 = agg.aggregate(makeErrorEvents().slice(0, 3));
  const s2 = agg.aggregate(makeErrorEvents().slice(3));
  const daily = agg.mergeDailyRollup([s1, s2]);
  assertEqual(daily.totalErrors, s1.totalErrors + s2.totalErrors);
});

// ─── USER AGGREGATOR ─────────────────────────────────────────────────────────

suite('UserAggregator');

test('aggregate activeUsers', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assertEqual(r.activeUsers, 2, 'activeUsers');
});

test('aggregate byUser message counts', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assert(r.byUser.u1, 'Should have u1');
  assert(r.byUser.u2, 'Should have u2');
  assertEqual(r.byUser.u1.messages, 2, 'u1 messages');
  assertEqual(r.byUser.u2.messages, 1, 'u2 messages');
});

test('aggregate byUser tool calls', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assertEqual(r.byUser.u1.toolCalls, 4, 'u1 toolCalls');
});

test('aggregate byUser cost', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assert(r.byUser.u1.cost > 0, 'u1 cost > 0');
  assert(Math.abs(r.byUser.u1.cost - 0.07) < 0.001, `u1 cost should be ~0.07, got ${r.byUser.u1.cost}`);
});

test('aggregate byUser features', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assert(r.byUser.u1.features.includes('canvas'), 'u1 has canvas');
  assert(r.byUser.u1.features.includes('tts'), 'u1 has tts');
  assert(r.byUser.u2.features.includes('tts'), 'u2 has tts');
});

test('aggregate byUser sources', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assert(r.byUser.u1.sources.includes('webchat'), 'u1 source webchat');
  assert(r.byUser.u2.sources.includes('discord'), 'u2 source discord');
});

test('aggregate byUser modelsUsed', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assert(r.byUser.u1.modelsUsed.includes('claude-opus-4-6'), 'u1 uses opus');
});

test('aggregate hourBuckets has 24 entries', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assertEqual(r.byUser.u1.hourBuckets.length, 24);
  const totalActivity = r.byUser.u1.hourBuckets.reduce((s, v) => s + v, 0);
  assert(totalActivity > 0, 'Should have some activity');
});

test('aggregate topUsers ranking', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assert(r.topUsers.length > 0, 'Should have topUsers');
  assertEqual(r.topUsers[0].userId, 'u1', 'u1 should be top (more activity)');
  assert(r.topUsers[0].activityScore > r.topUsers[1].activityScore, 'u1 score > u2 score');
});

test('aggregate featureAdoption', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate(makeAllEvents());
  assert(r.featureAdoption, 'Should have featureAdoption');
  // Both users use tts, only u1 uses canvas
  assertEqual(r.featureAdoption.tts, 1, 'tts adoption = 1.0 (both users)');
  assertEqual(r.featureAdoption.canvas, 0.5, 'canvas adoption = 0.5 (1/2 users)');
});

test('aggregate skips null userId events', () => {
  const agg = new UserAggregator();
  const events = [
    evt('system', 'startup', null, { version: '1.0' }),
    evt('conversation', 'user_message', 'u1', { length: 10, wordCount: 2, hasAttachment: false, source: 'webchat' }),
  ];
  const r = agg.aggregate(events);
  assertEqual(r.activeUsers, 1, 'Should only count u1');
  assert(!r.byUser[null], 'Should not have null user');
});

test('aggregate with empty events', () => {
  const agg = new UserAggregator();
  const r = agg.aggregate([]);
  assertEqual(r.activeUsers, 0);
  assertEqual(Object.keys(r.byUser).length, 0);
});

test('mergeDailyRollup merges user data', () => {
  const agg = new UserAggregator();
  const s1 = agg.aggregate(makeAllEvents().slice(0, 10));
  const s2 = agg.aggregate(makeAllEvents().slice(10));
  const daily = agg.mergeDailyRollup([s1, s2]);
  assert(daily.activeUsers > 0);
});

// ─── ROLLUP STORE ────────────────────────────────────────────────────────────

suite('RollupStore');

test('writeHourly + readHourly round-trip', () => {
  clean();
  const store = new RollupStore(TEMP);
  store.writeHourly('2026-02-23T11', { test: true, count: 42 });
  const r = store.readHourly('2026-02-23T11');
  assertEqual(r.test, true);
  assertEqual(r.count, 42);
  clean();
});

test('readHourly returns null for missing', () => {
  clean();
  const store = new RollupStore(TEMP);
  const r = store.readHourly('2026-01-01T00');
  assertEqual(r, null);
  clean();
});

test('listHourlyKeys for a date', () => {
  clean();
  const store = new RollupStore(TEMP);
  store.writeHourly('2026-02-23T09', { a: 1 });
  store.writeHourly('2026-02-23T10', { b: 2 });
  store.writeHourly('2026-02-23T11', { c: 3 });
  store.writeHourly('2026-02-24T00', { d: 4 }); // different date
  const keys = store.listHourlyKeys('2026-02-23');
  assertEqual(keys.length, 3);
  assertEqual(keys[0], '2026-02-23T09');
  clean();
});

test('readHourlyRange returns all for date', () => {
  clean();
  const store = new RollupStore(TEMP);
  store.writeHourly('2026-02-23T09', { hour: 9 });
  store.writeHourly('2026-02-23T10', { hour: 10 });
  const range = store.readHourlyRange('2026-02-23');
  assertEqual(range.length, 2);
  clean();
});

test('writeDaily + readDaily round-trip', () => {
  clean();
  const store = new RollupStore(TEMP);
  store.writeDaily('2026-02-23', { daily: true });
  const r = store.readDaily('2026-02-23');
  assertEqual(r.daily, true);
  clean();
});

test('readDailyRange filters by date', () => {
  clean();
  const store = new RollupStore(TEMP);
  store.writeDaily('2026-02-20', { d: 20 });
  store.writeDaily('2026-02-21', { d: 21 });
  store.writeDaily('2026-02-22', { d: 22 });
  store.writeDaily('2026-02-23', { d: 23 });
  const range = store.readDailyRange('2026-02-21', '2026-02-22');
  assertEqual(range.length, 2);
  clean();
});

test('handles corrupt JSON gracefully', () => {
  clean();
  const dir = path.join(TEMP, 'rollups', 'hourly');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-02-23T11.json'), 'NOT JSON!!!');
  const store = new RollupStore(TEMP);
  const origErr = console.error;
  console.error = () => {};
  const r = store.readHourly('2026-02-23T11');
  console.error = origErr;
  assertEqual(r, null, 'Should return null for corrupt JSON');
  clean();
});

test('atomic write survives (no .tmp leftover)', () => {
  clean();
  const store = new RollupStore(TEMP);
  store.writeHourly('2026-02-23T11', { ok: true });
  const dir = path.join(TEMP, 'rollups', 'hourly');
  const files = fs.readdirSync(dir);
  const tmpFiles = files.filter(f => f.includes('.tmp'));
  assertEqual(tmpFiles.length, 0, 'No .tmp files should remain');
  clean();
});

// ─── ROLLUP SCHEDULER ───────────────────────────────────────────────────────

suite('RollupScheduler');

// Note: RollupScheduler methods are async
// We'll use the asyncTests array and run them at the end

// ─── FULL PIPELINE INTEGRATION ───────────────────────────────────────────────

suite('Full Pipeline Integration');

// ─── ASYNC TESTS (RollupScheduler + Full Pipeline) ───────────────────────────

async function runAsyncTests() {
  suite('RollupScheduler (async)');

  await asyncTest('runHourlyRollup produces rollup', async () => {
    clean();
    const eventStore = new EventStore(TEMP);
    const rollupStore = new RollupStore(TEMP);
    const aggregators = {
      conversation: new ConversationAggregator(),
      tool: new ToolAggregator(),
      error: new ErrorAggregator(),
      user: new UserAggregator(),
    };

    for (const e of makeAllEvents()) eventStore.append(e);

    const scheduler = new RollupScheduler(eventStore, rollupStore, aggregators);
    const today = new Date().toISOString().slice(0, 10);
    const hour = today + 'T' + String(new Date().getUTCHours()).padStart(2, '0');

    await scheduler.runHourlyRollup(hour);
    const rollup = rollupStore.readHourly(hour);
    assert(rollup, 'Hourly rollup should exist');
    assert(rollup.aggregations, 'Should have aggregations');
    assert(rollup.aggregations.conversation, 'Should have conversation');
    assert(rollup.aggregations.tool, 'Should have tool');
    assert(rollup.aggregations.error, 'Should have error');
    assert(rollup.aggregations.user, 'Should have user');
    assert(rollup.aggregations.conversation.totalMessages > 0, 'Should have messages');
    clean();
  });

  await asyncTest('runDailyRollup merges hourly rollups', async () => {
    clean();
    const eventStore = new EventStore(TEMP);
    const rollupStore = new RollupStore(TEMP);
    const aggregators = {
      conversation: new ConversationAggregator(),
      tool: new ToolAggregator(),
      error: new ErrorAggregator(),
      user: new UserAggregator(),
    };

    for (const e of makeAllEvents()) eventStore.append(e);

    const scheduler = new RollupScheduler(eventStore, rollupStore, aggregators);
    const today = new Date().toISOString().slice(0, 10);
    const hour = today + 'T' + String(new Date().getUTCHours()).padStart(2, '0');

    await scheduler.runHourlyRollup(hour);
    await scheduler.runDailyRollup(today);
    const daily = rollupStore.readDaily(today);
    assert(daily, 'Daily rollup should exist');
    assert(daily.aggregations.conversation, 'Should have conversation');
    assert(daily.aggregations.conversation.totalMessages > 0, 'Should have messages in daily');
    clean();
  });

  await asyncTest('scheduler start/stop does not crash', async () => {
    clean();
    const eventStore = new EventStore(TEMP);
    const rollupStore = new RollupStore(TEMP);
    const aggregators = {
      conversation: new ConversationAggregator(),
      tool: new ToolAggregator(),
      error: new ErrorAggregator(),
      user: new UserAggregator(),
    };
    const scheduler = new RollupScheduler(eventStore, rollupStore, aggregators, { hourlyIntervalMs: 999999 });
    scheduler.start();
    await new Promise(r => setTimeout(r, 50)); // let the immediate hourly run
    scheduler.stop();
    clean();
  });

  await asyncTest('runHourlyRollup with no events produces empty rollup', async () => {
    clean();
    const eventStore = new EventStore(TEMP);
    const rollupStore = new RollupStore(TEMP);
    const aggregators = {
      conversation: new ConversationAggregator(),
      tool: new ToolAggregator(),
      error: new ErrorAggregator(),
      user: new UserAggregator(),
    };
    const scheduler = new RollupScheduler(eventStore, rollupStore, aggregators);
    await scheduler.runHourlyRollup('2026-01-01T00');
    const rollup = rollupStore.readHourly('2026-01-01T00');
    assert(rollup, 'Should still write rollup even with no events');
    assert(rollup.aggregations.conversation.totalMessages === 0);
    clean();
  });

  suite('Full Pipeline Integration (async)');

  await asyncTest('bus → store → aggregators → scheduler → rollup', async () => {
    clean();
    const bus = new AnalyticsEventBus();
    const eventStore = new EventStore(TEMP);
    const rollupStore = new RollupStore(TEMP);

    for (const t of ['conversation', 'tool', 'error', 'session', 'system']) {
      bus.on(t, e => eventStore.append(e));
    }

    bus.emitEvent('conversation', 'user_message', 'u1', 's1', { length: 50, wordCount: 8, hasAttachment: false, source: 'webchat' });
    bus.emitEvent('conversation', 'assistant_response', 'u1', 's1', { length: 300, wordCount: 45, responseTimeMs: 2000, totalTimeMs: 5000, model: 'claude-opus-4-6', provider: 'anthropic', inputTokens: 800, outputTokens: 120, cacheReadTokens: 300, cacheWriteTokens: 80, cost: 0.03, hasCanvasOps: false, canvasOpCount: 0, toolCallCount: 0 });
    bus.emitEvent('tool', 'tool_start', 'u1', 's1', { toolName: 'exec', callId: 't1', argsPreview: 'ls' });
    bus.emitEvent('tool', 'tool_end', 'u1', 's1', { toolName: 'exec', callId: 't1', durationMs: 150, success: true, resultSizeBytes: 100, truncated: false });
    bus.emitEvent('error', 'widget_error', 'u1', 's1', { widget: 'email', action: 'mail-send', errorType: 'smtp', message: 'SMTP timeout' });
    bus.emitEvent('session', 'feature_use', 'u1', 's1', { feature: 'widget', action: 'first_use', detail: 'email' });

    const aggregators = {
      conversation: new ConversationAggregator(),
      tool: new ToolAggregator(),
      error: new ErrorAggregator(),
      user: new UserAggregator(),
    };

    const scheduler = new RollupScheduler(eventStore, rollupStore, aggregators);
    const today = new Date().toISOString().slice(0, 10);
    const hour = today + 'T' + String(new Date().getUTCHours()).padStart(2, '0');

    await scheduler.runHourlyRollup(hour);
    const rollup = rollupStore.readHourly(hour);
    assert(rollup.aggregations.conversation.totalMessages === 2, 'Should have 2 messages');
    assert(rollup.aggregations.tool.totalToolCalls === 1, 'Should have 1 tool call');
    assert(rollup.aggregations.error.totalErrors === 1, 'Should have 1 error');
    assert(rollup.aggregations.user.activeUsers === 1, 'Should have 1 active user');
    clean();
  });
}

async function asyncTest(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}`); console.log(`     ${err.message}`); }
}

// ─── RUN ALL ─────────────────────────────────────────────────────────────────

runAsyncTests().then(() => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'═'.repeat(50)}`);
  clean();
  process.exit(failed > 0 ? 1 : 0);
});
