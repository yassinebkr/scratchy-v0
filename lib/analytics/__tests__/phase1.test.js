'use strict';

/**
 * Phase 1 Unit Tests — event-bus, event-types, event-store, retention-manager
 * Run: node lib/analytics/__tests__/phase1.test.js
 */

const fs = require('fs');
const path = require('path');
const { AnalyticsEventBus, analyticsEventBus, EVENT_TYPES: BUS_EVENT_TYPES } = require('../event-bus');
const { EVENT_TYPES, ENUMS, META_SCHEMAS, validateEvent, createEvent } = require('../schemas/event-types');
const { EventStore } = require('../stores/event-store');
const { RetentionManager } = require('../stores/retention-manager');

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n━━━ ${name} ━━━`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || 'assertDeepEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, message) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(message || 'Expected function to throw');
}

// Temp directory for file-based tests
const TEMP_DIR = path.join('/tmp', `analytics-test-${Date.now()}`);

function cleanTemp() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

// ─── EVENT BUS TESTS ─────────────────────────────────────────────────────────

suite('EventBus');

test('singleton exists and is an instance of AnalyticsEventBus', () => {
  assert(analyticsEventBus instanceof AnalyticsEventBus);
});

test('emitEvent delivers event to listener', () => {
  const bus = new AnalyticsEventBus();
  let received = null;
  bus.on('conversation', (evt) => { received = evt; });
  bus.emitEvent('conversation', 'user_message', 'usr_1', 'ses_1', { length: 42 });
  assert(received !== null, 'Should receive event');
  assertEqual(received.type, 'conversation');
  assertEqual(received.subtype, 'user_message');
  assertEqual(received.userId, 'usr_1');
  assertEqual(received.meta.length, 42);
});

test('auto-fills id and ts when missing', () => {
  const bus = new AnalyticsEventBus();
  let received = null;
  bus.on('tool', (evt) => { received = evt; });
  bus.emit('tool', { subtype: 'tool_start', meta: { toolName: 'exec' } });
  assert(received.id, 'Should have auto-generated id');
  assert(typeof received.id === 'string' && received.id.length > 0);
  assert(typeof received.ts === 'number' && received.ts > 0);
});

test('preserves explicit id and ts', () => {
  const bus = new AnalyticsEventBus();
  let received = null;
  bus.on('conversation', (evt) => { received = evt; });
  bus.emit('conversation', { id: 'custom-id', ts: 12345, subtype: 'user_message', meta: {} });
  assertEqual(received.id, 'custom-id');
  assertEqual(received.ts, 12345);
});

test('rejects event without subtype', () => {
  const bus = new AnalyticsEventBus();
  // Redirect stderr temporarily
  const origStderr = process.stderr.write;
  let stderrOutput = '';
  process.stderr.write = (msg) => { stderrOutput += msg; };
  const result = bus.emit('conversation', { meta: {} });
  process.stderr.write = origStderr;
  assertEqual(result, false, 'Should return false');
  assert(stderrOutput.includes('missing subtype'), 'Should log rejection');
});

test('rejects non-object payload', () => {
  const bus = new AnalyticsEventBus();
  const origStderr = process.stderr.write;
  let stderrOutput = '';
  process.stderr.write = (msg) => { stderrOutput += msg; };
  const result = bus.emit('conversation', 'not an object');
  process.stderr.write = origStderr;
  assertEqual(result, false);
  assert(stderrOutput.includes('payload must be an object'));
});

test('rejects null payload', () => {
  const bus = new AnalyticsEventBus();
  const origStderr = process.stderr.write;
  process.stderr.write = () => {};
  const result = bus.emit('conversation', null);
  process.stderr.write = process.stderr.write;
  assertEqual(result, false);
});

test('listener error does not crash bus', () => {
  const bus = new AnalyticsEventBus();
  let secondCalled = false;
  const origStderr = process.stderr.write;
  process.stderr.write = () => {}; // suppress error output
  bus.on('error', () => { throw new Error('Boom!'); });
  bus.on('error', () => { secondCalled = true; });
  // Should NOT throw
  bus.emit('error', { subtype: 'gateway_error', meta: {} });
  process.stderr.write = origStderr;
  assert(secondCalled, 'Second listener should still be called');
});

test('stats tracking', () => {
  const bus = new AnalyticsEventBus();
  bus.emitEvent('conversation', 'user_message', 'u1', 's1', {});
  bus.emitEvent('conversation', 'user_message', 'u1', 's1', {});
  bus.emitEvent('tool', 'tool_start', 'u1', 's1', {});
  const stats = bus.getStats();
  assertEqual(stats.totalEmitted, 3);
  assertEqual(stats.byType.conversation, 2);
  assertEqual(stats.byType.tool, 1);
  assert(stats.lastEventTs !== null);
});

test('resetStats clears counters', () => {
  const bus = new AnalyticsEventBus();
  bus.emitEvent('conversation', 'user_message', 'u1', 's1', {});
  bus.resetStats();
  const stats = bus.getStats();
  assertEqual(stats.totalEmitted, 0);
  assertEqual(stats.byType.conversation, 0);
  assertEqual(stats.lastEventTs, null);
});

test('non-analytics events pass through normally', () => {
  const bus = new AnalyticsEventBus();
  let received = false;
  bus.on('newListener', () => { received = true; });
  // Adding a listener triggers 'newListener' — built-in EventEmitter behavior
  bus.on('conversation', () => {});
  assert(received, 'newListener event should fire');
});

test('multiple listeners all receive event', () => {
  const bus = new AnalyticsEventBus();
  let count = 0;
  bus.on('session', () => count++);
  bus.on('session', () => count++);
  bus.on('session', () => count++);
  bus.emitEvent('session', 'session_start', 'u1', 's1', {});
  assertEqual(count, 3);
});

test('returns false when no listeners', () => {
  const bus = new AnalyticsEventBus();
  const result = bus.emitEvent('system', 'startup', null, null, {});
  assertEqual(result, false);
});

// ─── EVENT TYPES TESTS ──────────────────────────────────────────────────────

suite('Event Types');

test('EVENT_TYPES covers all 5 types', () => {
  const types = Object.keys(EVENT_TYPES);
  assertDeepEqual(types.sort(), ['conversation', 'error', 'session', 'system', 'tool']);
});

test('every type has subtypes array', () => {
  for (const [type, subtypes] of Object.entries(EVENT_TYPES)) {
    assert(Array.isArray(subtypes), `${type} subtypes should be array`);
    assert(subtypes.length > 0, `${type} should have at least 1 subtype`);
  }
});

test('every type:subtype has a META_SCHEMA', () => {
  for (const [type, subtypes] of Object.entries(EVENT_TYPES)) {
    for (const subtype of subtypes) {
      const key = `${type}:${subtype}`;
      assert(META_SCHEMAS[key], `Missing META_SCHEMA for ${key}`);
    }
  }
});

test('createEvent produces valid event for each type:subtype', () => {
  // Minimal valid meta for each type:subtype
  const metas = {
    'conversation:user_message': { length: 10, wordCount: 2, hasAttachment: false, source: 'webchat' },
    'conversation:assistant_response': { length: 100, wordCount: 15, responseTimeMs: 500, totalTimeMs: 1000, model: 'opus', provider: 'anthropic' },
    'conversation:session_summary': { durationMs: 5000, messageCount: 4, userMessages: 2, assistantMessages: 2 },
    'tool:tool_start': { toolName: 'exec', callId: 'c1' },
    'tool:tool_end': { toolName: 'exec', callId: 'c1', durationMs: 100, success: true },
    'tool:tool_error': { toolName: 'exec', callId: 'c1', durationMs: 5000, errorType: 'timeout', errorMessage: 'timed out' },
    'error:gateway_error': { errorCode: 400, errorType: 'api_error', provider: 'anthropic', model: 'opus', message: 'bad request', retryable: true },
    'error:ws_error': { errorType: 'disconnect' },
    'error:widget_error': { widget: 'calendar', action: 'cal-month', errorType: 'oauth', message: 'expired' },
    'error:user_facing_error': { originalError: 'e1', displayedMessage: 'oops', recoverable: true },
    'session:session_start': { source: 'webchat' },
    'session:session_end': { reason: 'idle_timeout', durationMs: 30000 },
    'session:feature_use': { feature: 'canvas', action: 'first_use' },
    'system:startup': { version: '1.0' },
    'system:shutdown': { reason: 'manual' },
    'system:config_change': { key: 'model', newValue: 'sonnet' },
  };

  for (const [key, meta] of Object.entries(metas)) {
    const [type, subtype] = key.split(':');
    const evt = createEvent(type, subtype, 'u1', 's1', meta);
    assert(evt.id, `${key}: should have id`);
    assert(evt.ts, `${key}: should have ts`);
    assertEqual(evt.type, type, `${key}: type`);
    assertEqual(evt.subtype, subtype, `${key}: subtype`);
    const v = validateEvent(evt);
    assert(v.valid, `${key}: validation failed: ${v.errors.join(', ')}`);
  }
});

test('validates unknown type', () => {
  const v = validateEvent({ type: 'bogus', subtype: 'nope', meta: {} });
  assert(!v.valid);
  assert(v.errors.some(e => e.includes('Unknown event type')));
});

test('validates unknown subtype for valid type', () => {
  const v = validateEvent({ type: 'conversation', subtype: 'bogus', meta: {} });
  assert(!v.valid);
  assert(v.errors.some(e => e.includes('Unknown subtype')));
});

test('validates missing required meta fields', () => {
  const v = validateEvent({ type: 'conversation', subtype: 'user_message', meta: {} });
  assert(!v.valid);
  assert(v.errors.some(e => e.includes('length')), 'Should flag missing length');
});

test('validates wrong type for meta field', () => {
  const v = validateEvent({
    type: 'conversation', subtype: 'user_message',
    meta: { length: 'not a number', wordCount: 5, hasAttachment: false, source: 'web' }
  });
  assert(!v.valid);
  assert(v.errors.some(e => e.includes('type number')));
});

test('validates invalid enum value', () => {
  const v = validateEvent({
    type: 'tool', subtype: 'tool_error',
    meta: { toolName: 'exec', callId: 'c1', durationMs: 100, errorType: 'not_real_type', errorMessage: 'x' }
  });
  assert(!v.valid);
  assert(v.errors.some(e => e.includes('must be one of')));
});

test('validates all enum values for tool_error.errorType', () => {
  for (const et of ENUMS.toolErrorType) {
    const v = validateEvent({
      type: 'tool', subtype: 'tool_error',
      meta: { toolName: 'x', callId: 'c', durationMs: 1, errorType: et, errorMessage: 'm' }
    });
    assert(v.valid, `errorType "${et}" should be valid`);
  }
});

test('validates all enum values for session_end.reason', () => {
  for (const r of ENUMS.sessionEndReason) {
    const v = validateEvent({
      type: 'session', subtype: 'session_end',
      meta: { reason: r, durationMs: 1000 }
    });
    assert(v.valid, `reason "${r}" should be valid`);
  }
});

test('createEvent throws on invalid', () => {
  assertThrows(() => createEvent('bogus', 'nope', null, null, {}));
});

test('createEvent throws on missing required meta', () => {
  assertThrows(() => createEvent('conversation', 'user_message', 'u1', 's1', {}));
});

test('null event is rejected', () => {
  const v = validateEvent(null);
  assert(!v.valid);
});

test('optional meta fields can be omitted', () => {
  const v = validateEvent({
    type: 'conversation', subtype: 'assistant_response',
    meta: { length: 100, wordCount: 10, responseTimeMs: 500, totalTimeMs: 1000, model: 'opus', provider: 'ant' }
    // all optional fields omitted (inputTokens, outputTokens, etc.)
  });
  assert(v.valid, `Should be valid: ${v.errors.join(', ')}`);
});

// ─── EVENT STORE TESTS ──────────────────────────────────────────────────────

suite('EventStore');

test('append creates directory structure', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const today = new Date().toISOString().slice(0, 10);
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  assert(fs.existsSync(path.join(TEMP_DIR, 'events', today)), 'Date dir should exist');
  assert(fs.existsSync(path.join(TEMP_DIR, 'events', today, 'conversation.jsonl')), 'JSONL file should exist');
  cleanTemp();
});

test('append writes valid JSONL', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const event = { type: 'tool', subtype: 'tool_start', ts: Date.now(), userId: 'u1', meta: { toolName: 'exec' } };
  store.append(event);
  const today = new Date().toISOString().slice(0, 10);
  const content = fs.readFileSync(path.join(TEMP_DIR, 'events', today, 'tool.jsonl'), 'utf8');
  const parsed = JSON.parse(content.trim());
  assertEqual(parsed.subtype, 'tool_start');
  assertEqual(parsed.meta.toolName, 'exec');
  cleanTemp();
});

test('multiple appends create multiple lines', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  for (let i = 0; i < 5; i++) {
    store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: { i } });
  }
  const today = new Date().toISOString().slice(0, 10);
  const lines = fs.readFileSync(path.join(TEMP_DIR, 'events', today, 'conversation.jsonl'), 'utf8')
    .split('\n').filter(l => l.trim());
  assertEqual(lines.length, 5);
  cleanTemp();
});

test('queryDay returns all events for a date', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const today = new Date().toISOString().slice(0, 10);
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  store.append({ type: 'tool', subtype: 'tool_start', ts: Date.now(), userId: 'u1', meta: {} });
  const results = store.queryDay(today);
  assertEqual(results.length, 2);
  cleanTemp();
});

test('query filters by type', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  store.append({ type: 'tool', subtype: 'tool_start', ts: Date.now(), userId: 'u1', meta: {} });
  const results = store.query({ type: 'conversation' });
  assertEqual(results.length, 1);
  assertEqual(results[0].type, 'conversation');
  cleanTemp();
});

test('query filters by subtype', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  store.append({ type: 'conversation', subtype: 'assistant_response', ts: Date.now(), userId: 'u1', meta: {} });
  const results = store.query({ subtype: 'user_message' });
  assertEqual(results.length, 1);
  cleanTemp();
});

test('query filters by userId', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u2', meta: {} });
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  const results = store.query({ userId: 'u1' });
  assertEqual(results.length, 2);
  cleanTemp();
});

test('query respects limit', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  for (let i = 0; i < 10; i++) {
    store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  }
  const results = store.query({ limit: 3 });
  assertEqual(results.length, 3);
  cleanTemp();
});

test('query caps limit at 10000', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  // Should not crash with huge limit
  const results = store.query({ limit: 99999 });
  assertEqual(results.length, 1);
  cleanTemp();
});

test('query defaults to today when no dates given', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  store.append({ type: 'session', subtype: 'session_start', ts: Date.now(), userId: 'u1', meta: {} });
  const results = store.query({});
  assertEqual(results.length, 1);
  cleanTemp();
});

test('query with date range', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);

  // Write to yesterday
  store.append({ type: 'conversation', subtype: 'user_message', ts: yesterday.getTime(), userId: 'u1', meta: {} });
  // Write to today
  store.append({ type: 'conversation', subtype: 'user_message', ts: today.getTime(), userId: 'u1', meta: {} });

  const results = store.query({ dateFrom: yesterdayStr, dateTo: todayStr });
  assertEqual(results.length, 2);
  cleanTemp();
});

test('queryHour filters by hour', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const now = new Date();
  const currentHour = now.getUTCHours();
  const hourKey = now.toISOString().slice(0, 10) + 'T' + String(currentHour).padStart(2, '0');

  store.append({ type: 'conversation', subtype: 'user_message', ts: now.getTime(), userId: 'u1', meta: {} });

  // Create event in a different hour
  const otherHour = new Date(now);
  otherHour.setUTCHours(currentHour === 23 ? 0 : currentHour + 1);
  store.append({ type: 'conversation', subtype: 'user_message', ts: otherHour.getTime(), userId: 'u2', meta: {} });

  const results = store.queryHour(hourKey);
  // At least 1 event in current hour
  assert(results.length >= 1, `Should have at least 1 event, got ${results.length}`);
  // All results should be in the right hour
  for (const r of results) {
    assertEqual(new Date(r.ts).getUTCHours(), currentHour, 'Event should be in queried hour');
  }
  cleanTemp();
});

test('handles corrupt JSONL lines gracefully', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(TEMP_DIR, 'events', today);
  fs.mkdirSync(dir, { recursive: true });

  // Write a file with a corrupt line
  const content = [
    JSON.stringify({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} }),
    'THIS IS NOT JSON {{{',
    JSON.stringify({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u2', meta: {} }),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'conversation.jsonl'), content + '\n');

  // Suppress stderr for corrupt line warning
  const origStderr = process.stderr.write;
  process.stderr.write = () => {};
  const results = store.queryDay(today);
  process.stderr.write = origStderr;

  assertEqual(results.length, 2, 'Should skip corrupt line and return 2 valid events');
  cleanTemp();
});

test('empty store returns empty results', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const results = store.queryDay('2026-01-01');
  assertEqual(results.length, 0);
  cleanTemp();
});

test('getDateDirs returns sorted dates', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const eventsDir = path.join(TEMP_DIR, 'events');
  fs.mkdirSync(path.join(eventsDir, '2026-02-23'), { recursive: true });
  fs.mkdirSync(path.join(eventsDir, '2026-02-21'), { recursive: true });
  fs.mkdirSync(path.join(eventsDir, '2026-02-22'), { recursive: true });
  fs.mkdirSync(path.join(eventsDir, 'not-a-date'), { recursive: true }); // should be filtered

  const dirs = store.getDateDirs();
  assertDeepEqual(dirs, ['2026-02-21', '2026-02-22', '2026-02-23']);
  cleanTemp();
});

test('deleteDate removes directory', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  const today = new Date().toISOString().slice(0, 10);
  assert(fs.existsSync(path.join(TEMP_DIR, 'events', today)));
  store.deleteDate(today);
  assert(!fs.existsSync(path.join(TEMP_DIR, 'events', today)));
  cleanTemp();
});

test('deleteDate on non-existent date does nothing', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  store.deleteDate('1999-01-01'); // Should not throw
  cleanTemp();
});

test('getStats computes correctly', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u2', meta: {} });
  store.append({ type: 'tool', subtype: 'tool_start', ts: Date.now(), userId: 'u1', meta: {} });

  const stats = store.getStats();
  assertEqual(stats.totalEvents, 3);
  assert(stats.sizeBytes > 0);
  assert(stats.oldestDate !== null);
  assert(stats.newestDate !== null);
  cleanTemp();
});

test('append rejects events without type', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const origStderr = process.stderr.write;
  process.stderr.write = () => {};
  store.append({ subtype: 'user_message', ts: Date.now() }); // no type
  process.stderr.write = origStderr;
  // Should not create any files
  assert(!fs.existsSync(path.join(TEMP_DIR, 'events')), 'Should not create dir for invalid event');
  cleanTemp();
});

test('append rejects events without ts', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  const origStderr = process.stderr.write;
  process.stderr.write = () => {};
  store.append({ type: 'conversation', subtype: 'user_message' }); // no ts
  process.stderr.write = origStderr;
  cleanTemp();
});

// ─── RETENTION MANAGER TESTS ────────────────────────────────────────────────

suite('RetentionManager');

test('default config', () => {
  const rm = new RetentionManager(TEMP_DIR);
  const config = rm.getRetentionConfig();
  assertEqual(config.rawEventsDays, 90);
  assertEqual(config.hourlyRollupDays, 90);
  assertEqual(config.dailyRollupDays, 365);
});

test('custom config overrides', () => {
  const rm = new RetentionManager(TEMP_DIR, { rawEventsDays: 30 });
  assertEqual(rm.getRetentionConfig().rawEventsDays, 30);
  assertEqual(rm.getRetentionConfig().hourlyRollupDays, 90); // default preserved
});

test('setRetentionConfig updates values', () => {
  const rm = new RetentionManager(TEMP_DIR);
  rm.setRetentionConfig({ dailyRollupDays: 180 });
  assertEqual(rm.getRetentionConfig().dailyRollupDays, 180);
});

test('cleanup with empty dirs returns zeros', () => {
  cleanTemp();
  fs.mkdirSync(path.join(TEMP_DIR, 'events'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'hourly'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'daily'), { recursive: true });
  const rm = new RetentionManager(TEMP_DIR);
  const result = rm.cleanup();
  assertEqual(result.deleted.events, 0);
  assertEqual(result.deleted.hourlyRollups, 0);
  assertEqual(result.deleted.dailyRollups, 0);
  assertEqual(result.freedBytes, 0);
  cleanTemp();
});

test('cleanup deletes old event directories', () => {
  cleanTemp();
  const eventsDir = path.join(TEMP_DIR, 'events');
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'hourly'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'daily'), { recursive: true });

  // Create an old date dir (200 days ago)
  const old = new Date();
  old.setDate(old.getDate() - 200);
  const oldStr = old.toISOString().slice(0, 10);
  const oldDir = path.join(eventsDir, oldStr);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'conversation.jsonl'), '{"test":true}\n');

  // Create a recent date dir (today)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayDir = path.join(eventsDir, todayStr);
  fs.mkdirSync(todayDir, { recursive: true });
  fs.writeFileSync(path.join(todayDir, 'conversation.jsonl'), '{"test":true}\n');

  const rm = new RetentionManager(TEMP_DIR); // 90 day default
  const result = rm.cleanup();

  assertEqual(result.deleted.events, 1, 'Should delete 1 old dir');
  assert(result.freedBytes > 0, 'Should free some bytes');
  assert(!fs.existsSync(oldDir), 'Old dir should be gone');
  assert(fs.existsSync(todayDir), 'Today dir should remain');
  cleanTemp();
});

test('cleanup preserves recent data', () => {
  cleanTemp();
  const eventsDir = path.join(TEMP_DIR, 'events');
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'hourly'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'daily'), { recursive: true });

  // Create dirs for last 5 days
  for (let i = 0; i < 5; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dir = path.join(eventsDir, d.toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test.jsonl'), '{"x":1}\n');
  }

  const rm = new RetentionManager(TEMP_DIR);
  const result = rm.cleanup();
  assertEqual(result.deleted.events, 0, 'No recent dirs should be deleted');
  cleanTemp();
});

test('cleanup deletes old hourly rollup files', () => {
  cleanTemp();
  fs.mkdirSync(path.join(TEMP_DIR, 'events'), { recursive: true });
  const hourlyDir = path.join(TEMP_DIR, 'rollups', 'hourly');
  fs.mkdirSync(hourlyDir, { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'daily'), { recursive: true });

  // Old hourly file (200 days ago)
  const old = new Date();
  old.setDate(old.getDate() - 200);
  const oldFile = `${old.toISOString().slice(0, 10)}T12.json`;
  fs.writeFileSync(path.join(hourlyDir, oldFile), '{}');

  // Recent hourly file
  const recentFile = `${new Date().toISOString().slice(0, 10)}T12.json`;
  fs.writeFileSync(path.join(hourlyDir, recentFile), '{}');

  const rm = new RetentionManager(TEMP_DIR);
  const result = rm.cleanup();
  assertEqual(result.deleted.hourlyRollups, 1);
  assert(!fs.existsSync(path.join(hourlyDir, oldFile)));
  assert(fs.existsSync(path.join(hourlyDir, recentFile)));
  cleanTemp();
});

test('getDiskUsage returns correct structure', () => {
  cleanTemp();
  const eventsDir = path.join(TEMP_DIR, 'events', '2026-02-23');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.writeFileSync(path.join(eventsDir, 'conversation.jsonl'), 'x'.repeat(100));
  fs.mkdirSync(path.join(TEMP_DIR, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(TEMP_DIR, 'profiles', 'u1.json'), '{}');

  const rm = new RetentionManager(TEMP_DIR);
  const usage = rm.getDiskUsage();
  assertEqual(usage.events.count, 1);
  assertEqual(usage.events.bytes, 100);
  assertEqual(usage.profiles.count, 1);
  assert(usage.total > 0);
  cleanTemp();
});

test('getOldestDate returns oldest event dir', () => {
  cleanTemp();
  const eventsDir = path.join(TEMP_DIR, 'events');
  fs.mkdirSync(path.join(eventsDir, '2026-01-15'), { recursive: true });
  fs.mkdirSync(path.join(eventsDir, '2026-02-20'), { recursive: true });
  fs.mkdirSync(path.join(eventsDir, '2026-02-23'), { recursive: true });

  const rm = new RetentionManager(TEMP_DIR);
  assertEqual(rm.getOldestDate(), '2026-01-15');
  cleanTemp();
});

test('getOldestDate returns null for empty store', () => {
  cleanTemp();
  const rm = new RetentionManager(TEMP_DIR);
  assertEqual(rm.getOldestDate(), null);
  cleanTemp();
});

test('ignores non-date entries in directories', () => {
  cleanTemp();
  const eventsDir = path.join(TEMP_DIR, 'events');
  fs.mkdirSync(path.join(eventsDir, 'not-a-date'), { recursive: true });
  fs.mkdirSync(path.join(eventsDir, '.DS_Store_dir'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'hourly'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'daily'), { recursive: true });

  const rm = new RetentionManager(TEMP_DIR);
  const result = rm.cleanup(); // Should not crash on non-date entries
  assertEqual(result.deleted.events, 0);
  cleanTemp();
});

// ─── INTEGRATION TESTS ──────────────────────────────────────────────────────

suite('Integration: Bus → Store Round-Trip');

test('event-bus emits → event-store appends → query reads back', () => {
  cleanTemp();
  const bus = new AnalyticsEventBus();
  const store = new EventStore(TEMP_DIR);

  // Wire bus to store
  bus.on('conversation', (evt) => store.append(evt));
  bus.on('tool', (evt) => store.append(evt));

  // Emit events
  bus.emitEvent('conversation', 'user_message', 'usr_1', 'ses_1', { length: 42 });
  bus.emitEvent('conversation', 'assistant_response', 'usr_1', 'ses_1', { length: 500 });
  bus.emitEvent('tool', 'tool_start', 'usr_1', 'ses_1', { toolName: 'exec' });

  // Query
  const allToday = store.queryDay(new Date().toISOString().slice(0, 10));
  assertEqual(allToday.length, 3);

  const convOnly = store.query({ type: 'conversation' });
  assertEqual(convOnly.length, 2);

  const toolOnly = store.query({ type: 'tool' });
  assertEqual(toolOnly.length, 1);

  cleanTemp();
});

test('createEvent + bus + store full pipeline', () => {
  cleanTemp();
  const bus = new AnalyticsEventBus();
  const store = new EventStore(TEMP_DIR);
  bus.on('conversation', (evt) => store.append(evt));

  // Use createEvent for validated event
  const evt = createEvent('conversation', 'user_message', 'usr_1', 'ses_1', {
    length: 100, wordCount: 15, hasAttachment: false, source: 'webchat'
  });
  bus.emit('conversation', evt);

  const results = store.query({ type: 'conversation', subtype: 'user_message' });
  assertEqual(results.length, 1);
  assertEqual(results[0].meta.source, 'webchat');
  assertEqual(results[0].meta.length, 100);
  assert(results[0].id, 'Should have event id');
  cleanTemp();
});

test('retention cleanup after store population', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'hourly'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'daily'), { recursive: true });

  // Add today's events
  store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: 'u1', meta: {} });

  // Fake an old directory
  const old = new Date();
  old.setDate(old.getDate() - 100);
  const oldStr = old.toISOString().slice(0, 10);
  const oldDir = path.join(TEMP_DIR, 'events', oldStr);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'conversation.jsonl'), '{"old":true}\n');

  const rm = new RetentionManager(TEMP_DIR);
  const result = rm.cleanup();
  assertEqual(result.deleted.events, 1);

  // Today's data should still be there
  const todayResults = store.queryDay(new Date().toISOString().slice(0, 10));
  assertEqual(todayResults.length, 1);

  cleanTemp();
});

// ─── EDGE CASES ──────────────────────────────────────────────────────────────

suite('Edge Cases');

test('event-store handles high-frequency appends', () => {
  cleanTemp();
  const store = new EventStore(TEMP_DIR);
  for (let i = 0; i < 100; i++) {
    store.append({ type: 'conversation', subtype: 'user_message', ts: Date.now(), userId: `u${i % 5}`, meta: { i } });
  }
  const results = store.queryDay(new Date().toISOString().slice(0, 10));
  assertEqual(results.length, 100);
  cleanTemp();
});

test('event-store with empty JSONL file', () => {
  cleanTemp();
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(TEMP_DIR, 'events', today);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversation.jsonl'), '');
  const store = new EventStore(TEMP_DIR);
  const results = store.queryDay(today);
  assertEqual(results.length, 0);
  cleanTemp();
});

test('event-store with only whitespace/empty lines in JSONL', () => {
  cleanTemp();
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(TEMP_DIR, 'events', today);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversation.jsonl'), '\n\n  \n\n');
  const store = new EventStore(TEMP_DIR);
  const results = store.queryDay(today);
  assertEqual(results.length, 0);
  cleanTemp();
});

test('event-bus handles rapid sequential emits', () => {
  const bus = new AnalyticsEventBus();
  let count = 0;
  bus.on('conversation', () => count++);
  for (let i = 0; i < 1000; i++) {
    bus.emitEvent('conversation', 'user_message', 'u1', 's1', {});
  }
  assertEqual(count, 1000);
  const stats = bus.getStats();
  assertEqual(stats.totalEmitted, 1000);
});

test('retention manager with very old data (> 1 year)', () => {
  cleanTemp();
  const eventsDir = path.join(TEMP_DIR, 'events');
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'hourly'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, 'rollups', 'daily'), { recursive: true });

  // 400 days ago
  const ancient = new Date();
  ancient.setDate(ancient.getDate() - 400);
  const ancientDir = path.join(eventsDir, ancient.toISOString().slice(0, 10));
  fs.mkdirSync(ancientDir, { recursive: true });
  fs.writeFileSync(path.join(ancientDir, 'data.jsonl'), 'old data\n');

  const rm = new RetentionManager(TEMP_DIR);
  const result = rm.cleanup();
  assertEqual(result.deleted.events, 1);
  cleanTemp();
});

test('event-types: array meta fields validated correctly', () => {
  const v = validateEvent({
    type: 'conversation', subtype: 'session_summary',
    meta: {
      durationMs: 1000, messageCount: 2, userMessages: 1, assistantMessages: 1,
      modelsUsed: ['opus', 'sonnet'], // array field
      toolsUsed: ['exec', 'web_search']
    }
  });
  assert(v.valid, `Should be valid: ${v.errors.join(', ')}`);
});

test('event-types: array field with wrong type', () => {
  const v = validateEvent({
    type: 'conversation', subtype: 'session_summary',
    meta: {
      durationMs: 1000, messageCount: 2, userMessages: 1, assistantMessages: 1,
      modelsUsed: 'not an array'
    }
  });
  assert(!v.valid);
  assert(v.errors.some(e => e.includes('array')));
});

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}`);

// Final cleanup
cleanTemp();

process.exit(failed > 0 ? 1 : 0);
