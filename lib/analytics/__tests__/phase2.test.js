'use strict';

/**
 * Phase 2 Unit Tests — collectors (conversation, tool, error, session)
 * Run: node lib/analytics/__tests__/phase2.test.js
 */

const fs = require('fs');
const path = require('path');
const { AnalyticsEventBus } = require('../event-bus');
const { EventStore } = require('../stores/event-store');
const { ConversationCollector } = require('../collectors/conversation-collector');
const { ToolCollector } = require('../collectors/tool-collector');
const { ErrorCollector } = require('../collectors/error-collector');
const { SessionCollector } = require('../collectors/session-collector');

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function suite(name) {
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

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const TEMP_DIR = path.join('/tmp', `p2-test-${Date.now()}`);
function cleanTemp() { if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true }); }

// Suppress stderr for expected warnings
const _origStderr = process.stderr.write.bind(process.stderr);
function muteStderr() { process.stderr.write = () => true; }
function unmuteStderr() { process.stderr.write = _origStderr; }
const _origWarn = console.warn;
function muteWarn() { console.warn = () => {}; }
function unmuteWarn() { console.warn = _origWarn; }

// Helper: collect all events from a bus into an array
function collectEvents(bus) {
  const events = [];
  for (const t of ['conversation', 'tool', 'error', 'session', 'system']) {
    bus.on(t, (evt) => events.push(evt));
  }
  return events;
}

// ─── CONVERSATION COLLECTOR ──────────────────────────────────────────────────

suite('ConversationCollector');

test('emits user_message with correct meta', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'Hello world' }, 'webchat', 's1');
  cc.destroy();

  assertEqual(events.length, 1);
  assertEqual(events[0].subtype, 'user_message');
  assertEqual(events[0].meta.length, 11);
  assertEqual(events[0].meta.wordCount, 2);
  assertEqual(events[0].meta.hasAttachment, false);
  assertEqual(events[0].meta.source, 'webchat');
});

test('emits user_message with attachment', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'Check this', attachment: { name: 'file.pdf' } }, 'whatsapp', 's1');
  cc.destroy();

  assertEqual(events[0].meta.hasAttachment, true);
});

test('handles empty/null message text', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: '' }, 'webchat', 's1');
  cc.onUserMessage('u2', null, 'webchat', 's1');
  cc.destroy();

  assertEqual(events[0].meta.length, 0);
  assertEqual(events[0].meta.wordCount, 0);
  assertEqual(events[1].meta.length, 0);
});

test('emits assistant_response with timing', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'Hello' }, 'webchat', 's1');
  // Small delay to get nonzero responseTimeMs
  const firstTokenTs = Date.now() + 50;
  cc.onAssistantResponse('u1', { text: 'Hi there!', firstTokenTs }, {
    model: 'claude-opus-4-6', provider: 'anthropic',
    input: 500, output: 20, cacheRead: 100, cacheWrite: 50,
    cost: 0.01, toolCalls: 0
  }, 's1');
  cc.destroy();

  const resp = events.find(e => e.subtype === 'assistant_response');
  assert(resp, 'Should have assistant_response event');
  assertEqual(resp.meta.model, 'claude-opus-4-6');
  assertEqual(resp.meta.provider, 'anthropic');
  assertEqual(resp.meta.inputTokens, 500);
  assertEqual(resp.meta.outputTokens, 20);
  assert(resp.meta.responseTimeMs >= 0, 'responseTimeMs should be >= 0');
  assert(resp.meta.totalTimeMs >= 0, 'totalTimeMs should be >= 0');
});

test('detects canvas ops in response', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'show dashboard' }, 'webchat', 's1');
  const response = '```scratchy-canvas\n{"op":"upsert","id":"g1","type":"gauge"}\n{"op":"upsert","id":"g2","type":"stats"}\n```';
  cc.onAssistantResponse('u1', { text: response }, { model: 'opus', provider: 'ant', cost: 0 }, 's1');
  cc.destroy();

  const resp = events.find(e => e.subtype === 'assistant_response');
  assertEqual(resp.meta.hasCanvasOps, true);
  assertEqual(resp.meta.canvasOpCount, 2);
});

test('no canvas ops detected in plain text', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'hi' }, 'webchat', 's1');
  cc.onAssistantResponse('u1', { text: 'Just a text reply' }, { model: 'opus', provider: 'ant', cost: 0 }, 's1');
  cc.destroy();

  const resp = events.find(e => e.subtype === 'assistant_response');
  assertEqual(resp.meta.hasCanvasOps, false);
  assertEqual(resp.meta.canvasOpCount, 0);
});

test('assistant_response without prior user message has zero timing', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  // No onUserMessage before this
  cc.onAssistantResponse('u1', { text: 'Unsolicited response' }, { model: 'opus', provider: 'ant', cost: 0 }, 's1');
  cc.destroy();

  const resp = events.find(e => e.subtype === 'assistant_response');
  assertEqual(resp.meta.responseTimeMs, 0);
  assertEqual(resp.meta.totalTimeMs, 0);
});

test('session_summary emitted on idle timeout', (done) => {
  return new Promise((resolve) => {
    const bus = new AnalyticsEventBus();
    const events = collectEvents(bus);
    const cc = new ConversationCollector(bus, { idleTimeoutMs: 100 }); // 100ms idle

    cc.onUserMessage('u1', { text: 'Hello' }, 'webchat', 's1');
    cc.onAssistantResponse('u1', { text: 'Hi!' }, { model: 'opus', provider: 'ant', cost: 0.01 }, 's1');

    setTimeout(() => {
      const summary = events.find(e => e.subtype === 'session_summary');
      assert(summary, 'Should emit session_summary on idle');
      assertEqual(summary.meta.messageCount, 2);
      assertEqual(summary.meta.userMessages, 1);
      assertEqual(summary.meta.assistantMessages, 1);
      assert(summary.meta.durationMs >= 0);
      cc.destroy();
      resolve();
    }, 200);
  });
});

test('session_summary on explicit onSessionEnd', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'Hello' }, 'webchat', 's1');
  cc.onAssistantResponse('u1', { text: 'Hi!' }, { model: 'opus', provider: 'ant', cost: 0.05 }, 's1');
  cc.onUserMessage('u1', { text: 'Bye' }, 'webchat', 's1');
  cc.onSessionEnd('u1', 'explicit_close');

  const summary = events.find(e => e.subtype === 'session_summary');
  assert(summary, 'Should emit session_summary');
  assertEqual(summary.meta.messageCount, 3);
  assertEqual(summary.meta.userMessages, 2);
  assertEqual(summary.meta.assistantMessages, 1);
  assert(summary.meta.modelsUsed.includes('opus'));
  cc.destroy();
});

test('onSessionEnd for unknown user is no-op', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onSessionEnd('nonexistent', 'disconnect');
  assertEqual(events.length, 0);
  cc.destroy();
});

test('cost accumulation across multiple responses', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'q1' }, 'webchat', 's1');
  cc.onAssistantResponse('u1', { text: 'a1' }, { model: 'opus', provider: 'ant', cost: 0.05 }, 's1');
  cc.onUserMessage('u1', { text: 'q2' }, 'webchat', 's1');
  cc.onAssistantResponse('u1', { text: 'a2' }, { model: 'opus', provider: 'ant', cost: 0.03 }, 's1');
  cc.onSessionEnd('u1');

  const summary = events.find(e => e.subtype === 'session_summary');
  assert(Math.abs(summary.meta.totalCost - 0.08) < 0.001, `Cost should be ~0.08, got ${summary.meta.totalCost}`);
  cc.destroy();
});

test('multiple users tracked independently', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'Hello from u1' }, 'webchat', 's1');
  cc.onUserMessage('u2', { text: 'Hello from u2' }, 'discord', 's2');
  cc.onAssistantResponse('u1', { text: 'Hi u1' }, { model: 'opus', provider: 'ant', cost: 0.01 }, 's1');
  cc.onSessionEnd('u1');

  const u1Summary = events.find(e => e.subtype === 'session_summary' && e.userId === 'u1');
  assert(u1Summary, 'u1 should have summary');
  assertEqual(u1Summary.meta.messageCount, 2);

  // u2 should NOT have summary yet
  const u2Summary = events.find(e => e.subtype === 'session_summary' && e.userId === 'u2');
  assert(!u2Summary, 'u2 should not have summary yet');
  cc.destroy();
});

test('backAndForthDepth calculation', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  // 3 consecutive user→assistant pairs
  for (let i = 0; i < 3; i++) {
    cc.onUserMessage('u1', { text: `q${i}` }, 'webchat', 's1');
    cc.onAssistantResponse('u1', { text: `a${i}` }, { model: 'opus', provider: 'ant', cost: 0 }, 's1');
  }
  cc.onSessionEnd('u1');

  const summary = events.find(e => e.subtype === 'session_summary');
  assert(summary.meta.backAndForthDepth >= 3, `backAndForthDepth should be >= 3, got ${summary.meta.backAndForthDepth}`);
  cc.destroy();
});

test('toolCalls as array accumulates toolsUsed', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 99999 });

  cc.onUserMessage('u1', { text: 'run something' }, 'webchat', 's1');
  cc.onAssistantResponse('u1', { text: 'done' }, {
    model: 'opus', provider: 'ant', cost: 0,
    toolCalls: [{ name: 'exec' }, { name: 'web_search' }]
  }, 's1');
  cc.onSessionEnd('u1');

  const summary = events.find(e => e.subtype === 'session_summary');
  assert(summary.meta.toolsUsed.includes('exec'));
  assert(summary.meta.toolsUsed.includes('web_search'));
  cc.destroy();
});

test('destroy clears all idle timers', () => {
  const bus = new AnalyticsEventBus();
  const cc = new ConversationCollector(bus, { idleTimeoutMs: 50 });

  cc.onUserMessage('u1', { text: 'a' }, 'webchat', 's1');
  cc.onUserMessage('u2', { text: 'b' }, 'webchat', 's2');
  cc.destroy(); // Should not crash, should clear timers
  // If timers weren't cleared, they'd fire after this test and potentially fail
});

// ─── TOOL COLLECTOR ──────────────────────────────────────────────────────────

suite('ToolCollector');

test('start → end flow with duration', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);

  tc.onToolStart('c1', 'exec', { command: 'ls -la' }, 'u1', 's1');
  // Simulate 50ms delay
  const startEvt = events.find(e => e.subtype === 'tool_start');
  assert(startEvt, 'Should emit tool_start');
  assertEqual(startEvt.meta.toolName, 'exec');
  assertEqual(startEvt.meta.callId, 'c1');

  tc.onToolEnd('c1', { output: 'file1.txt\nfile2.txt' }, 'u1', 's1');
  const endEvt = events.find(e => e.subtype === 'tool_end');
  assert(endEvt, 'Should emit tool_end');
  assertEqual(endEvt.meta.success, true);
  assert(typeof endEvt.meta.durationMs === 'number');
  assert(endEvt.meta.resultSizeBytes > 0);
  tc.destroy();
});

test('start → error flow', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);

  tc.onToolStart('c2', 'web_fetch', { url: 'http://x.com' }, 'u1', 's1');
  tc.onToolError('c2', new Error('Connection timed out'), 'u1', 's1');

  const errEvt = events.find(e => e.subtype === 'tool_error');
  assert(errEvt, 'Should emit tool_error');
  assertEqual(errEvt.meta.errorType, 'timeout');
  assert(errEvt.meta.errorMessage.includes('timed out'));
  assert(typeof errEvt.meta.durationMs === 'number');
  tc.destroy();
});

test('tool_end without matching start warns and emits null duration', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);

  muteWarn();
  tc.onToolEnd('orphan', { result: 'x' }, 'u1', 's1');
  unmuteWarn();

  const endEvt = events.find(e => e.subtype === 'tool_end');
  assert(endEvt, 'Should still emit');
  assertEqual(endEvt.meta.toolName, 'unknown');
  assertEqual(endEvt.meta.durationMs, null);
  tc.destroy();
});

test('tool_error without matching start', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);

  muteWarn();
  tc.onToolError('orphan', new Error('boom'), 'u1', 's1');
  unmuteWarn();

  const errEvt = events.find(e => e.subtype === 'tool_error');
  assertEqual(errEvt.meta.toolName, 'unknown');
  assertEqual(errEvt.meta.durationMs, null);
  tc.destroy();
});

test('sensitive args are redacted', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);

  tc.onToolStart('c3', 'exec', { command: 'curl -H "Authorization: Bearer sk-12345678abcdef"' }, 'u1', 's1');
  const startEvt = events.find(e => e.subtype === 'tool_start');
  assert(!startEvt.meta.argsPreview.includes('sk-12345678abcdef'), 'Secret should be redacted');
  assert(startEvt.meta.argsPreview.includes('REDACTED'));
  tc.destroy();
});

test('args preview truncated at 100 chars', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);

  const longArgs = { command: 'a'.repeat(200) };
  tc.onToolStart('c4', 'exec', longArgs, 'u1', 's1');
  const startEvt = events.find(e => e.subtype === 'tool_start');
  assert(startEvt.meta.argsPreview.length <= 105, `Should be truncated, got ${startEvt.meta.argsPreview.length}`);
  tc.destroy();
});

test('unserializable args handled', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);

  const circular = {};
  circular.self = circular;
  tc.onToolStart('c5', 'exec', circular, 'u1', 's1');
  const startEvt = events.find(e => e.subtype === 'tool_start');
  assert(startEvt.meta.argsPreview.includes('unserializable'));
  tc.destroy();
});

test('error classification: permission', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);
  tc.onToolStart('c6', 'exec', {}, 'u1', 's1');
  tc.onToolError('c6', new Error('Permission denied: EACCES'), 'u1', 's1');
  assertEqual(events.find(e => e.subtype === 'tool_error').meta.errorType, 'permission');
  tc.destroy();
});

test('error classification: validation', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);
  tc.onToolStart('c7', 'exec', {}, 'u1', 's1');
  tc.onToolError('c7', new Error('Invalid schema: missing field'), 'u1', 's1');
  assertEqual(events.find(e => e.subtype === 'tool_error').meta.errorType, 'validation');
  tc.destroy();
});

test('error classification: unknown', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);
  tc.onToolStart('c8', 'exec', {}, 'u1', 's1');
  tc.onToolError('c8', new Error('Something weird happened'), 'u1', 's1');
  assertEqual(events.find(e => e.subtype === 'tool_error').meta.errorType, 'unknown');
  tc.destroy();
});

test('result.truncated flag propagated', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);
  tc.onToolStart('c9', 'exec', {}, 'u1', 's1');
  tc.onToolEnd('c9', { output: 'abc', truncated: true }, 'u1', 's1');
  assertEqual(events.find(e => e.subtype === 'tool_end').meta.truncated, true);
  tc.destroy();
});

test('concurrent tool calls tracked independently', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const tc = new ToolCollector(bus);

  tc.onToolStart('a', 'exec', {}, 'u1', 's1');
  tc.onToolStart('b', 'web_search', {}, 'u1', 's1');
  tc.onToolEnd('b', { result: 'found' }, 'u1', 's1');
  tc.onToolEnd('a', { result: 'done' }, 'u1', 's1');

  const ends = events.filter(e => e.subtype === 'tool_end');
  assertEqual(ends.length, 2);
  assertEqual(ends[0].meta.toolName, 'web_search');
  assertEqual(ends[1].meta.toolName, 'exec');
  tc.destroy();
});

// ─── ERROR COLLECTOR ─────────────────────────────────────────────────────────

suite('ErrorCollector');

test('gateway error: 429 → rate_limit, retryable', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ status: 429, message: 'Too many requests' }, 'anthropic', 'opus', 'u1', 's1');
  const evt = events[0];
  assertEqual(evt.subtype, 'gateway_error');
  assertEqual(evt.meta.errorType, 'rate_limit');
  assertEqual(evt.meta.retryable, true);
  assertEqual(evt.meta.errorCode, 429);
});

test('gateway error: 401 → auth, not retryable', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ status: 401, message: 'Unauthorized' }, 'openai', 'gpt-4', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'auth');
  assertEqual(events[0].meta.retryable, false);
});

test('gateway error: 403 → auth', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ status: 403, message: 'Forbidden' }, 'anthropic', 'opus', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'auth');
});

test('gateway error: 500 → internal', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ status: 500, message: 'Internal server error' }, 'anthropic', 'opus', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'internal');
  assertEqual(events[0].meta.retryable, false);
});

test('gateway error: 503 → internal', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ status: 503, message: 'Service unavailable' }, 'anthropic', 'opus', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'internal');
});

test('gateway error: 408 → timeout, retryable', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ status: 408, message: 'Request timeout' }, 'anthropic', 'opus', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'timeout');
  assertEqual(events[0].meta.retryable, true);
});

test('gateway error: ETIMEDOUT → timeout', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ code: 'ETIMEDOUT', message: 'Connection timed out' }, 'anthropic', 'opus', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'timeout');
  assertEqual(events[0].meta.retryable, true);
});

test('gateway error: ECONNRESET → timeout', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ code: 'ECONNRESET', message: 'Connection reset' }, 'anthropic', 'opus', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'timeout');
});

test('gateway error: null error → api_error', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError(null, 'anthropic', 'opus', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'api_error');
  assertEqual(events[0].meta.retryable, false);
});

test('gateway error: generic 400 → api_error', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onGatewayError({ status: 400, message: 'Bad request' }, 'anthropic', 'opus', 'u1', 's1');
  assertEqual(events[0].meta.errorType, 'api_error');
});

test('ws_error types', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onWsError('disconnect', 'u1', 45000, 's1');
  assertEqual(events[0].subtype, 'ws_error');
  assertEqual(events[0].meta.errorType, 'disconnect');
  assertEqual(events[0].meta.connectionDurationMs, 45000);
});

test('widget_error extracts widget from prefix', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onWidgetError('cal-month', new Error('OAuth expired'), 'u1', 's1');
  assertEqual(events[0].meta.widget, 'calendar');
  assertEqual(events[0].meta.action, 'cal-month');

  ec.onWidgetError('mail-send', new Error('SMTP fail'), 'u1', 's1');
  assertEqual(events[1].meta.widget, 'email');

  ec.onWidgetError('sn-list', new Error('Not found'), 'u1', 's1');
  assertEqual(events[2].meta.widget, 'notes');
});

test('widget_error: unknown prefix → unknown widget', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onWidgetError('todo-list', new Error('Not implemented'), 'u1', 's1');
  assertEqual(events[0].meta.widget, 'unknown');
});

test('widget_error: null action → unknown widget', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onWidgetError(null, new Error('crash'), 'u1', 's1');
  assertEqual(events[0].meta.widget, 'unknown');
});

test('user_facing_error', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  ec.onUserFacingError('evt_123', 'Something went wrong, please try again', true, 'u1', 's1');
  assertEqual(events[0].subtype, 'user_facing_error');
  assertEqual(events[0].meta.originalError, 'evt_123');
  assertEqual(events[0].meta.recoverable, true);
});

test('error message truncated to 500 chars', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const ec = new ErrorCollector(bus);

  const longMsg = 'x'.repeat(1000);
  ec.onGatewayError({ status: 400, message: longMsg }, 'ant', 'opus', 'u1', 's1');
  assert(events[0].meta.message.length <= 500, `Should truncate, got ${events[0].meta.message.length}`);
});

// ─── SESSION COLLECTOR ───────────────────────────────────────────────────────

suite('SessionCollector');

test('session_start for first visit', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const sc = new SessionCollector(bus);

  sc.onSessionStart('u1', 'webchat', 'Mozilla/5.0', 's1');
  const evt = events[0];
  assertEqual(evt.subtype, 'session_start');
  assertEqual(evt.meta.source, 'webchat');
  assertEqual(evt.meta.returning, false);
  assertEqual(evt.meta.daysSinceLastVisit, null);
  sc.destroy();
});

test('session_end with correct duration', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const sc = new SessionCollector(bus);

  sc.onSessionStart('u1', 'webchat', 'Mozilla', 's1');
  sc.onSessionEnd('u1', 'explicit_close', 5);

  const endEvt = events.find(e => e.subtype === 'session_end');
  assert(endEvt, 'Should emit session_end');
  assertEqual(endEvt.meta.reason, 'explicit_close');
  assert(typeof endEvt.meta.durationMs === 'number');
  assertEqual(endEvt.meta.messagesExchanged, 5);
  sc.destroy();
});

test('returning user detected after session_end + new session_start', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const sc = new SessionCollector(bus);

  sc.onSessionStart('u1', 'webchat', 'Mozilla', 's1');
  sc.onSessionEnd('u1', 'idle_timeout', 3);

  // Second session
  sc.onSessionStart('u1', 'webchat', 'Mozilla', 's2');
  const secondStart = events.filter(e => e.subtype === 'session_start')[1];
  assertEqual(secondStart.meta.returning, true);
  assertEqual(secondStart.meta.daysSinceLastVisit, 0); // same day
  sc.destroy();
});

test('duplicate session_start auto-ends previous', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const sc = new SessionCollector(bus);

  sc.onSessionStart('u1', 'webchat', 'Mozilla', 's1');
  sc.onSessionStart('u1', 'webchat', 'Mozilla', 's2'); // duplicate

  const endEvts = events.filter(e => e.subtype === 'session_end');
  assertEqual(endEvts.length, 1, 'Should auto-end previous session');
  assertEqual(endEvts[0].meta.reason, 'ws_disconnect');
  sc.destroy();
});

test('session_end without session_start warns and emits null duration', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const sc = new SessionCollector(bus);

  muteWarn();
  sc.onSessionEnd('unknown_user', 'ws_disconnect', 0);
  unmuteWarn();

  const endEvt = events.find(e => e.subtype === 'session_end');
  assert(endEvt, 'Should still emit');
  assertEqual(endEvt.meta.durationMs, null);
  sc.destroy();
});

test('invalid reason defaults to error', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const sc = new SessionCollector(bus);

  sc.onSessionStart('u1', 'webchat', 'M', 's1');
  muteWarn();
  sc.onSessionEnd('u1', 'invalid_reason', 0);
  unmuteWarn();

  const endEvt = events.find(e => e.subtype === 'session_end');
  assertEqual(endEvt.meta.reason, 'error');
  sc.destroy();
});

test('feature_use: first_use detection', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const sc = new SessionCollector(bus);

  sc.onSessionStart('u1', 'webchat', 'M', 's1');
  sc.onFeatureUse('u1', 'canvas', 'month-calendar', 's1');
  sc.onFeatureUse('u1', 'canvas', 'dashboard', 's1');

  const featureEvts = events.filter(e => e.subtype === 'feature_use');
  assertEqual(featureEvts.length, 2);
  assertEqual(featureEvts[0].meta.action, 'first_use');
  assertEqual(featureEvts[1].meta.action, 'regular_use'); // second time
  sc.destroy();
});

test('feature_use: unknown feature is rejected', () => {
  const bus = new AnalyticsEventBus();
  const events = collectEvents(bus);
  const sc = new SessionCollector(bus);

  muteWarn();
  sc.onFeatureUse('u1', 'bogus_feature', null, 's1');
  unmuteWarn();

  const featureEvts = events.filter(e => e.subtype === 'feature_use');
  assertEqual(featureEvts.length, 0, 'Should not emit for unknown feature');
  sc.destroy();
});

test('getActiveSessions count', () => {
  const bus = new AnalyticsEventBus();
  const sc = new SessionCollector(bus);

  assertEqual(sc.getActiveSessions(), 0);
  sc.onSessionStart('u1', 'webchat', 'M', 's1');
  assertEqual(sc.getActiveSessions(), 1);
  sc.onSessionStart('u2', 'discord', 'M', 's2');
  assertEqual(sc.getActiveSessions(), 2);
  sc.onSessionEnd('u1', 'explicit_close', 0);
  assertEqual(sc.getActiveSessions(), 1);
  sc.destroy();
});

test('getSession returns session info', () => {
  const bus = new AnalyticsEventBus();
  const sc = new SessionCollector(bus);

  sc.onSessionStart('u1', 'webchat', 'Mozilla/5.0', 's1');
  const session = sc.getSession('u1');
  assert(session, 'Should return session');
  assertEqual(session.source, 'webchat');
  assertEqual(session.sessionId, 's1');
  assert(session.startTs > 0);
  sc.destroy();
});

test('history persistence: save and load', () => {
  cleanTemp();
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const histFile = path.join(TEMP_DIR, 'session-history.json');
  const bus = new AnalyticsEventBus();

  // First instance: create user history
  const sc1 = new SessionCollector(bus, { historyFile: histFile });
  sc1.onSessionStart('u1', 'webchat', 'M', 's1');
  sc1.onFeatureUse('u1', 'canvas', null, 's1');
  sc1.onFeatureUse('u1', 'tts', null, 's1');
  sc1.onSessionEnd('u1', 'explicit_close', 3);
  sc1.destroy(); // triggers save

  assert(fs.existsSync(histFile), 'History file should be saved');

  // Second instance: load and verify
  const events = collectEvents(bus);
  const sc2 = new SessionCollector(bus, { historyFile: histFile });
  sc2.onSessionStart('u1', 'webchat', 'M', 's2');

  const startEvt = events.find(e => e.subtype === 'session_start');
  assertEqual(startEvt.meta.returning, true, 'Should be returning user');

  // Canvas should now be regular_use
  sc2.onFeatureUse('u1', 'canvas', null, 's2');
  const featureEvt = events.find(e => e.subtype === 'feature_use');
  assertEqual(featureEvt.meta.action, 'regular_use', 'Canvas should be regular_use after history load');

  // But a new feature should be first_use
  sc2.onFeatureUse('u1', 'widget', 'calendar', 's2');
  const featureEvts = events.filter(e => e.subtype === 'feature_use');
  assertEqual(featureEvts[1].meta.action, 'first_use', 'Widget should be first_use');
  sc2.destroy();
  cleanTemp();
});

test('history file: missing file on first load is OK', () => {
  cleanTemp();
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const histFile = path.join(TEMP_DIR, 'nonexistent-history.json');
  const bus = new AnalyticsEventBus();

  // Should not throw
  const sc = new SessionCollector(bus, { historyFile: histFile });
  assertEqual(sc.getActiveSessions(), 0);
  sc.destroy();
  cleanTemp();
});

// ─── INTEGRATION: ALL COLLECTORS → STORE ─────────────────────────────────────

suite('Integration: All Collectors → Event Store');

test('full pipeline: all 4 collectors → bus → store', () => {
  cleanTemp();
  const bus = new AnalyticsEventBus();
  const store = new EventStore(TEMP_DIR);

  for (const t of ['conversation', 'tool', 'error', 'session']) {
    bus.on(t, evt => store.append(evt));
  }

  const conv = new ConversationCollector(bus, { idleTimeoutMs: 99999 });
  const tool = new ToolCollector(bus);
  const err = new ErrorCollector(bus);
  const sess = new SessionCollector(bus);

  // Simulate a realistic session
  sess.onSessionStart('u1', 'webchat', 'Mozilla', 's1');
  conv.onUserMessage('u1', { text: 'Hello, run ls please' }, 'webchat', 's1');
  sess.onFeatureUse('u1', 'canvas', 'first time', 's1');
  tool.onToolStart('t1', 'exec', { command: 'ls' }, 'u1', 's1');
  tool.onToolEnd('t1', { output: 'file.txt' }, 'u1', 's1');
  conv.onAssistantResponse('u1', { text: 'Here are your files' }, {
    model: 'opus', provider: 'anthropic', cost: 0.02, toolCalls: 1
  }, 's1');
  err.onWidgetError('cal-month', new Error('OAuth expired'), 'u1', 's1');
  conv.onSessionEnd('u1');
  sess.onSessionEnd('u1', 'explicit_close', 2);

  const today = new Date().toISOString().slice(0, 10);
  const all = store.queryDay(today);

  // Count by type
  const counts = {};
  for (const e of all) {
    counts[e.type] = (counts[e.type] || 0) + 1;
  }

  assert(counts.session >= 3, `session events: expected >= 3, got ${counts.session}`); // start + feature + end
  assert(counts.conversation >= 3, `conversation events: expected >= 3, got ${counts.conversation}`); // user + assistant + summary
  assert(counts.tool >= 2, `tool events: expected >= 2, got ${counts.tool}`); // start + end
  assert(counts.error >= 1, `error events: expected >= 1, got ${counts.error}`); // widget

  conv.destroy();
  sess.destroy();
  cleanTemp();
});

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

// Handle the async test
(async () => {
  // Run the async idle timeout test
  await testAsync('session_summary emitted on idle timeout', async () => {
    const bus = new AnalyticsEventBus();
    const events = collectEvents(bus);
    const cc = new ConversationCollector(bus, { idleTimeoutMs: 100 });

    cc.onUserMessage('u1', { text: 'Hello' }, 'webchat', 's1');
    cc.onAssistantResponse('u1', { text: 'Hi!' }, { model: 'opus', provider: 'ant', cost: 0.01 }, 's1');

    await new Promise(r => setTimeout(r, 250));

    const summary = events.find(e => e.subtype === 'session_summary');
    assert(summary, 'Should emit session_summary on idle');
    assertEqual(summary.meta.messageCount, 2);
    assertEqual(summary.meta.userMessages, 1);
    cc.destroy();
  });

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'═'.repeat(50)}`);

  cleanTemp();
  process.exit(failed > 0 ? 1 : 0);
})();
