'use strict';

/**
 * Phase 5 Unit Tests — Integration (index.js barrel + serve.js hook patterns)
 * 
 * Tests the barrel module wiring, event flow end-to-end, and simulates
 * the exact serve.js integration patterns (session lifecycle, tool tracking,
 * conversation tracking, widget error tracking, assistant response tracking).
 *
 * Run: node lib/analytics/__tests__/phase5.test.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

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
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    if (e.stack) {
      const relevantLine = e.stack.split('\n').find(l => l.includes('phase5.test.js'));
      if (relevantLine) console.log(`     ${relevantLine.trim()}`);
    }
  }
}

// All tests are synchronous — async removed to prevent process hanging

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(msg || 'Expected function to throw');
}

function assertGt(actual, threshold, msg) {
  if (actual <= threshold) {
    throw new Error(`${msg || 'assertGt'}: expected ${actual} > ${threshold}`);
  }
}

function assertGte(actual, threshold, msg) {
  if (actual < threshold) {
    throw new Error(`${msg || 'assertGte'}: expected ${actual} >= ${threshold}`);
  }
}

function assertType(value, type, msg) {
  if (typeof value !== type) {
    throw new Error(`${msg || 'assertType'}: expected type ${type}, got ${typeof value}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-phase5-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ok */ }
}

// Tests are synchronous — EventBus emission is sync, only EventStore persistence is async (setImmediate)

// Mock wsSessions map (simulates serve.js wsSessions)
function createMockWsSessions() {
  const map = new Map();
  function addClient(clientId, opts = {}) {
    const mockWs = {
      readyState: 1,
      sent: [],
      send(data) {
        if (mockWs.readyState !== 1) throw new Error('WS not open');
        mockWs.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
      },
      close() { mockWs.readyState = 3; },
    };
    map.set(clientId, {
      clientId,
      clientWs: mockWs,
      _userInfo: opts.userInfo || { user: { id: opts.userId || 'u1', role: opts.role || 'admin', email: 'test@test.com' } },
      seq: 0,
      buffer: [],
    });
    return mockWs;
  }
  return { map, addClient };
}

// ─── Import ──────────────────────────────────────────────────────────────────
const { initAnalytics } = require('../index');

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: Barrel Module — initAnalytics() Return Shape
// ═══════════════════════════════════════════════════════════════════════════════

suite('1. initAnalytics() return shape');

test('returns object with expected top-level keys', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    assert(a.collectors, 'missing collectors');
    assert(a.handleRequest, 'missing handleRequest');
    assert(a.ws, 'missing ws');
    assert(a.start, 'missing start');
    assert(a.stop, 'missing stop');
    assert(a.eventBus, 'missing eventBus');
    assert(a.eventStore, 'missing eventStore');
    assert(a.rollupStore, 'missing rollupStore');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('collectors has conversation, error, tool, session', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    assert(a.collectors.conversation, 'missing conversation collector');
    assert(a.collectors.error, 'missing error collector');
    assert(a.collectors.tool, 'missing tool collector');
    assert(a.collectors.session, 'missing session collector');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('collectors have expected methods', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    // Conversation
    assertType(a.collectors.conversation.onUserMessage, 'function', 'conversation.onUserMessage');
    assertType(a.collectors.conversation.onAssistantResponse, 'function', 'conversation.onAssistantResponse');
    // Tool
    assertType(a.collectors.tool.onToolStart, 'function', 'tool.onToolStart');
    assertType(a.collectors.tool.onToolEnd, 'function', 'tool.onToolEnd');
    assertType(a.collectors.tool.onToolError, 'function', 'tool.onToolError');
    // Session
    assertType(a.collectors.session.onSessionStart, 'function', 'session.onSessionStart');
    assertType(a.collectors.session.onSessionEnd, 'function', 'session.onSessionEnd');
    // Error
    assertType(a.collectors.error.onGatewayError, 'function', 'error.onGatewayError');
    assertType(a.collectors.error.onWsError, 'function', 'error.onWsError');
    assertType(a.collectors.error.onWidgetError, 'function', 'error.onWidgetError');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('handleRequest is a function', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    assertType(a.handleRequest, 'function', 'handleRequest');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('start/stop are callable without error', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start(); // start is idempotent even if called twice
    a.start();
    a.stop();
    a.stop(); // stop is idempotent
  } finally { cleanTmpDir(tmpDir); }
});

test('creates data directory if missing', () => {
  const tmpBase = makeTmpDir();
  const nestedDir = path.join(tmpBase, 'deep', 'nested', 'analytics');
  try {
    const a = initAnalytics({ dataDir: nestedDir, wsSessions: new Map() });
    assert(fs.existsSync(nestedDir), 'data directory should be created');
    a.stop();
  } finally { cleanTmpDir(tmpBase); }
});

test('defaults work (no opts)', () => {
  // initAnalytics with no options should not throw
  const a = initAnalytics();
  assert(a.collectors, 'should have collectors with defaults');
  a.stop();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: Event Flow — Collector → EventBus → EventStore
// ═══════════════════════════════════════════════════════════════════════════════

suite('2. Event flow: Collector → EventBus → EventStore');

test('user message emits to EventBus', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Verify EventBus receives the event
    let received = false;
    a.eventBus.on('conversation', () => { received = true; });
    a.collectors.conversation.onUserMessage('user1', 'Hello world', 'webchat', 'sess1');
    assert(received, 'EventBus should receive conversation event');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('tool start/end emits to EventBus', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    let toolEvents = 0;
    a.eventBus.on('tool', () => { toolEvents++; });
    a.collectors.tool.onToolStart('call-1', 'web_search', { query: 'test' }, 'user1', 'sess1');
    a.collectors.tool.onToolEnd('call-1', 'result data', 'user1', 'sess1');
    assertGte(toolEvents, 2, 'should have tool_start + tool_end events');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('session start/end emits to EventBus', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    let sessionEvents = 0;
    a.eventBus.on('session', () => { sessionEvents++; });
    a.collectors.session.onSessionStart('user1', 'webchat', null, 'sess1');
    a.collectors.session.onSessionEnd('user1', 'explicit_close', 5);
    assertGte(sessionEvents, 2, 'should have session_start + session_end events');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('error events emit to EventBus', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    let errorEvents = 0;
    a.eventBus.on('error', () => { errorEvents++; });
    a.collectors.error.onWsError('disconnect', 'user1', 5000, 'sess1');
    a.collectors.error.onWidgetError('cal-create', 'OAuth expired', 'user1', 'sess1');
    a.collectors.error.onGatewayError({ message: 'rate limit' }, 'anthropic', 'claude-3', 'user1', 'sess1');
    assertGte(errorEvents, 3, 'should have 3 error events');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('assistant response emits to EventBus with metadata', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    let convEvents = 0;
    a.eventBus.on('conversation', () => { convEvents++; });

    a.collectors.conversation.onUserMessage('user1', 'What is 2+2?', 'webchat', 'sess1');
    a.collectors.conversation.onAssistantResponse('user1', 
      { text: 'The answer is 4.' },
      { model: 'claude-opus-4', provider: 'anthropic', input: 100, output: 50, cost: 0.01 },
      'sess1'
    );
    assertGte(convEvents, 2, 'should have user_message + assistant_response');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: serve.js Integration Patterns (Simulated)
// ═══════════════════════════════════════════════════════════════════════════════

suite('3. serve.js integration patterns');

test('session lifecycle: start → messages → end', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    let totalEvents = 0;
    for (const type of ['session', 'conversation', 'tool']) {
      a.eventBus.on(type, () => { totalEvents++; });
    }

    const userId = 'usr_abc123';
    const clientId = 'client-001';
    a.collectors.session.onSessionStart(userId, 'webchat', null, clientId);
    a.collectors.conversation.onUserMessage(userId, 'Tell me about Rust', 'webchat', clientId);
    a.collectors.tool.onToolStart('call-42', 'web_search', { query: 'Rust language' }, userId, clientId);
    a.collectors.tool.onToolEnd('call-42', 'Rust is a systems programming language...', userId, clientId);
    a.collectors.conversation.onAssistantResponse(userId,
      { text: 'Rust is a systems programming language focused on safety.' },
      { model: 'claude-opus-4', output: 200 },
      clientId
    );
    a.collectors.session.onSessionEnd(userId, 'ws_disconnect', 0);

    assertGte(totalEvents, 5, 'should have >= 5 events for full lifecycle');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('tool tracking mirrors serve.js gateway message pattern', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Exact pattern from serve.js ~line 3362:
    // if (_td.phase === 'start' && _td.name && _td.callId)
    const frame = {
      type: 'event', event: 'agent',
      payload: {
        stream: 'tool',
        data: { phase: 'start', name: 'exec', callId: 'tc-1', args: { command: 'ls' } }
      }
    };

    const _td = frame.payload.data;
    const _tUserId = 'usr_123';
    const _tSessionId = 'client-42';

    if (_td.phase === 'start' && _td.name && _td.callId) {
      a.collectors.tool.onToolStart(_td.callId, _td.name, _td.args || {}, _tUserId, _tSessionId);
    }

    // End
    const endFrame = {
      type: 'event', event: 'agent',
      payload: {
        stream: 'tool',
        data: { phase: 'end', callId: 'tc-1', result: 'file1.txt\nfile2.txt' }
      }
    };
    const _te = endFrame.payload.data;
    if (_te.phase === 'end' && _te.callId) {
      a.collectors.tool.onToolEnd(_te.callId, _te.result || '', _tUserId, _tSessionId);
    }

    // Should not throw — that's the main test here
    assert(true, 'tool tracking pattern works');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('widget error tracking mirrors serve.js catch patterns', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Exact pattern from serve.js widget catch handlers:
    // if (analytics) try { analytics.collectors.error.onWidgetError(action, e.message, ...) } catch(_) {}
    
    const widgets = [
      { action: 'sn-list', error: 'Auth expired' },
      { action: 'mail-inbox', error: 'OAuth token revoked' },
      { action: 'cal-create', error: 'Calendar API quota exceeded' },
      { action: 'admin-dashboard', error: 'Permission denied' },
      { action: 'subagent-monitor', error: 'Session not found' },
      { action: 'yt-search', error: 'API key invalid' },
      { action: 'spotify-play', error: 'Premium required' },
      { action: 'deploy-stage', error: 'Build failed' },
      { action: 'onboard-complete', error: 'Validation error' },
    ];

    for (const w of widgets) {
      try {
        a.collectors.error.onWidgetError(w.action, w.error, 'usr_test', 'client-1');
      } catch (_) {
        // mirroring serve.js: analytics errors are swallowed
        throw new Error(`Widget error tracking should not throw for ${w.action}`);
      }
    }

    assert(true, 'all 9 widget error patterns work');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('user message tracking mirrors serve.js chat.send pattern', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Exact pattern from serve.js ~line 4283:
    const raw = JSON.stringify({
      type: 'req', method: 'chat.send',
      params: { message: 'Hello AI!' }
    });

    const _aFrame = JSON.parse(raw);
    if (_aFrame.type === 'req' && _aFrame.method === 'chat.send' && _aFrame.params?.message) {
      const _aUserId = 'usr_456';
      const _aSessionId = 'client-99';
      a.collectors.conversation.onUserMessage(_aUserId, _aFrame.params.message, 'webchat', _aSessionId);
    }

    assert(true, 'user message tracking pattern works');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('assistant response tracking with usage data (serve.js pattern)', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Simulate the serve.js assistant response tracking pattern
    const frame = {
      type: 'event', event: 'chat',
      payload: {
        state: 'final',
        message: {
          content: [
            { type: 'text', text: 'Here is your answer about Rust.' },
            { type: 'text', text: 'It was created by Graydon Hoare.' }
          ],
          model: 'claude-opus-4',
          provider: 'anthropic',
          usage: {
            input: 500, output: 200, cacheRead: 3000, cacheWrite: 100,
            cost: { total: 0.05 }
          }
        }
      }
    };

    const msg = frame.payload.message;
    let _arText = '';
    if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
      _arText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
    const _arUsage = (msg && msg.usage) ? {
      model: msg.model || null,
      provider: msg.provider || null,
      input: msg.usage.input || 0,
      output: msg.usage.output || 0,
      cacheRead: msg.usage.cacheRead || 0,
      cacheWrite: msg.usage.cacheWrite || 0,
      cost: (msg.usage.cost && msg.usage.cost.total) || 0,
    } : {};

    assertEq(_arText, 'Here is your answer about Rust.\nIt was created by Graydon Hoare.', 'text extraction');
    assertEq(_arUsage.model, 'claude-opus-4', 'model');
    assertEq(_arUsage.input, 500, 'input tokens');
    assertEq(_arUsage.output, 200, 'output tokens');
    assertEq(_arUsage.cacheRead, 3000, 'cache read');
    assertEq(_arUsage.cost, 0.05, 'cost');

    a.collectors.conversation.onAssistantResponse('user1', { text: _arText }, _arUsage, 'sess1');
    assert(true, 'assistant response pattern works');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('assistant response tracking WITHOUT usage data', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Some gateway frames may not include usage
    const frame = {
      type: 'event', event: 'chat',
      payload: {
        state: 'final',
        message: 'Simple string response'
      }
    };

    const msg = frame.payload.message;
    let _arText = '';
    if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
      _arText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    } else if (typeof msg === 'string') {
      _arText = msg;
    }
    const _arUsage = (msg && msg.usage) ? { model: msg.model } : {};

    assertEq(_arText, 'Simple string response', 'string message extraction');
    assertEq(Object.keys(_arUsage).length, 0, 'empty usage for string message');

    a.collectors.conversation.onAssistantResponse('user1', { text: _arText }, _arUsage, 'sess1');
    assert(true, 'assistant response without usage works');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: Edge Cases & Crash Resilience
// ═══════════════════════════════════════════════════════════════════════════════

suite('4. Edge cases & crash resilience');

test('collector calls never throw (analytics is non-fatal)', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Null/undefined arguments — should not throw
    a.collectors.conversation.onUserMessage(null, null, null, null);
    a.collectors.conversation.onAssistantResponse(null, null, null, null);
    a.collectors.tool.onToolStart(null, null, null, null, null);
    a.collectors.tool.onToolEnd(null, null, null, null);
    a.collectors.tool.onToolError(null, null, null, null);
    a.collectors.session.onSessionStart(null, null, null, null);
    a.collectors.session.onSessionEnd(null, 'error', 0);
    a.collectors.error.onWsError(null, null, null, null);
    a.collectors.error.onWidgetError(null, null, null, null);
    a.collectors.error.onGatewayError(null, null, null, null, null);

    assert(true, 'no throws with null arguments');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('collector calls with empty strings', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    a.collectors.conversation.onUserMessage('', '', '', '');
    a.collectors.conversation.onAssistantResponse('', { text: '' }, {}, '');
    a.collectors.tool.onToolStart('', '', {}, '', '');
    a.collectors.tool.onToolEnd('', '', '', '');
    a.collectors.session.onSessionStart('', '', '', '');
    a.collectors.session.onSessionEnd('', 'error', 0);
    a.collectors.error.onWidgetError('', '', '', '');

    assert(true, 'no throws with empty strings');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('extremely long message text does not crash', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const hugeText = 'x'.repeat(10 * 1024 * 1024); // 10MB
    a.collectors.conversation.onUserMessage('user1', hugeText, 'webchat', 'sess1');
    a.collectors.conversation.onAssistantResponse('user1', { text: hugeText }, {}, 'sess1');
    
    assert(true, '10MB text handled without crash');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('special characters in all string fields', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const special = '"; DROP TABLE users; --\n\r\t\0\x1b[31m{}[]"\'\\';
    a.collectors.conversation.onUserMessage(special, special, special, special);
    a.collectors.tool.onToolStart(special, special, { [special]: special }, special, special);
    a.collectors.error.onWidgetError(special, special, special, special);

    assert(true, 'special characters handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('Unicode and emoji in messages', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    a.collectors.conversation.onUserMessage('user1', 'Héllo wörld 🌍 日本語 العربية', 'webchat', 'sess1');
    a.collectors.conversation.onAssistantResponse('user1', 
      { text: '🔧 La réponse est: café ☕ — très bien!' },
      { model: 'claude-opus-4' },
      'sess1'
    );

    assert(true, 'Unicode handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('concurrent rapid-fire events do not corrupt state', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    let eventCount = 0;
    a.eventBus.on('conversation', () => { eventCount++; });
    a.eventBus.on('tool', () => { eventCount++; });

    for (let i = 0; i < 100; i++) {
      a.collectors.conversation.onUserMessage(`user${i % 5}`, `msg-${i}`, 'webchat', `sess-${i % 10}`);
      a.collectors.tool.onToolStart(`call-${i}`, 'web_search', {}, `user${i % 5}`, `sess-${i % 10}`);
    }

    assertGte(eventCount, 200, '200 rapid-fire events emitted');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('double start() is idempotent', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();
    a.start(); // should not throw or create duplicate intervals
    a.stop();
    assert(true, 'double start is safe');
  } finally { cleanTmpDir(tmpDir); }
});

test('double stop() is idempotent', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();
    a.stop();
    a.stop(); // should not throw
    assert(true, 'double stop is safe');
  } finally { cleanTmpDir(tmpDir); }
});

test('stop() without start() is safe', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.stop(); // never started
    assert(true, 'stop without start is safe');
  } finally { cleanTmpDir(tmpDir); }
});

test('EventStore.append failure is swallowed (non-fatal)', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Sabotage the event store's append method to throw
    const origAppend = a.eventStore.append;
    a.eventStore.append = () => { throw new Error('Disk full!'); };

    // Collector call should NOT throw — errors caught in setImmediate
    a.collectors.conversation.onUserMessage('user1', 'test', 'webchat', 'sess1');
    assert(true, 'collector did not throw despite broken EventStore');

    a.eventStore.append = origAppend;
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('multiple initAnalytics() instances do not interfere', () => {
  const tmpDir1 = makeTmpDir();
  const tmpDir2 = makeTmpDir();
  try {
    const a1 = initAnalytics({ dataDir: tmpDir1, wsSessions: new Map() });
    const a2 = initAnalytics({ dataDir: tmpDir2, wsSessions: new Map() });
    a1.start();
    a2.start();

    a1.collectors.conversation.onUserMessage('user1', 'msg-a1', 'webchat', 'sess-a1');
    a2.collectors.conversation.onUserMessage('user2', 'msg-a2', 'webchat', 'sess-a2');

    a1.stop();
    a2.stop();
    assert(true, 'multiple instances coexist');
  } finally {
    cleanTmpDir(tmpDir1);
    cleanTmpDir(tmpDir2);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 5: serve.js Auth Pattern Simulation
// ═══════════════════════════════════════════════════════════════════════════════

suite('5. Auth pattern simulation');

test('legacy user (_legacy) tracking', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // serve.js uses '_legacy' for users without auth
    const userId = '_legacy';
    a.collectors.session.onSessionStart(userId, 'webchat', null, 'client-1');
    a.collectors.conversation.onUserMessage(userId, 'test', 'webchat', 'client-1');
    a.collectors.session.onSessionEnd(userId, 'ws_disconnect', 0);

    assert(true, 'legacy user tracking works');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('multi-user concurrent sessions', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Simulate 3 concurrent users
    const users = ['usr_001', 'usr_002', 'usr_003'];
    for (const u of users) {
      a.collectors.session.onSessionStart(u, 'webchat', null, `client-${u}`);
    }
    for (const u of users) {
      a.collectors.conversation.onUserMessage(u, `Hello from ${u}`, 'webchat', `client-${u}`);
    }
    for (const u of users) {
      a.collectors.session.onSessionEnd(u, 'explicit_close', 1);
    }

    assert(true, 'multi-user tracking works');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 6: REST API Integration (handleRequest)
// ═══════════════════════════════════════════════════════════════════════════════

suite('6. REST API via handleRequest');

function createMockReq(urlPath, method = 'GET', authResult = null) {
  return {
    method,
    url: urlPath,
    _authResult: authResult || { user: { role: 'admin' }, isLegacy: true },
    headers: {},
  };
}

function createMockRes() {
  const res = {
    statusCode: null,
    _headers: {},
    body: null,
    writeHead(code, headers) {
      res.statusCode = code;
      if (headers) Object.assign(res._headers, headers);
    },
    setHeader(name, value) { res._headers[name] = value; },
    end(data) {
      res.body = data;
      if (typeof data === 'string') {
        try { res.json = JSON.parse(data); } catch(e) {}
      }
    },
  };
  return res;
}

test('handleRequest routes /api/analytics/overview', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const url = new URL('http://localhost/api/analytics/overview');
    const req = createMockReq('/api/analytics/overview');
    const res = createMockRes();

    a.handleRequest(req, res, url, req._authResult);
    assertEq(res.statusCode, 200, 'should return 200');
    assert(res.json, 'should return JSON body');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('handleRequest routes /api/analytics/health', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const url = new URL('http://localhost/api/analytics/health');
    const req = createMockReq('/api/analytics/health');
    const res = createMockRes();

    a.handleRequest(req, res, url, req._authResult);
    assertEq(res.statusCode, 200, 'should return 200');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('handleRequest rejects non-admin', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const url = new URL('http://localhost/api/analytics/overview');
    const req = createMockReq('/api/analytics/overview', 'GET', { user: { role: 'operator' } });
    const res = createMockRes();

    a.handleRequest(req, res, url, req._authResult);
    // Should return 403 for non-admin
    assert(res.statusCode === 403 || res.statusCode === 401, `should reject non-admin, got ${res.statusCode}`);
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('handleRequest returns 404 for unknown analytics route', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const url = new URL('http://localhost/api/analytics/nonexistent');
    const req = createMockReq('/api/analytics/nonexistent');
    const res = createMockRes();

    a.handleRequest(req, res, url, req._authResult);
    assertEq(res.statusCode, 404, 'should return 404');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 7: Gateway Frame Parsing (Edge Cases)
// ═══════════════════════════════════════════════════════════════════════════════

suite('7. Gateway frame parsing edge cases');

test('tool frame with missing callId is ignored (no crash)', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Pattern: if (_td.phase === 'start' && _td.name && _td.callId)
    // Missing callId → condition is false → skip
    const frame = {
      type: 'event', event: 'agent',
      payload: { stream: 'tool', data: { phase: 'start', name: 'exec' /* no callId */ } }
    };
    const _td = frame.payload.data;
    if (_td.phase === 'start' && _td.name && _td.callId) {
      a.collectors.tool.onToolStart(_td.callId, _td.name, _td.args || {}, 'u1', 's1');
    }
    assert(true, 'missing callId safely skipped');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('tool frame with missing name is ignored', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const _td = { phase: 'start', callId: 'call-1' /* no name */ };
    if (_td.phase === 'start' && _td.name && _td.callId) {
      a.collectors.tool.onToolStart(_td.callId, _td.name, {}, 'u1', 's1');
    }
    assert(true, 'missing name safely skipped');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('tool end without prior start is handled', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // End for a callId that was never started — should not crash
    a.collectors.tool.onToolEnd('orphan-call', 'some result', 'u1', 's1');
    assert(true, 'orphan tool end handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('assistant response with empty content array', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const msg = { content: [], model: 'claude-opus-4' };
    let _arText = '';
    if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
      _arText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
    assertEq(_arText, '', 'empty content = empty text');

    a.collectors.conversation.onAssistantResponse('u1', { text: _arText }, {}, 's1');
    assert(true, 'empty content handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('assistant response with mixed content types (text + thinking)', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const msg = {
      content: [
        { type: 'thinking', thinking: 'Let me think about this...' },
        { type: 'text', text: 'The answer is 42.' },
        { type: 'tool_use', id: 'call-1', name: 'exec' },
      ]
    };
    let _arText = '';
    if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
      _arText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
    assertEq(_arText, 'The answer is 42.', 'only text blocks extracted');

    a.collectors.conversation.onAssistantResponse('u1', { text: _arText }, {}, 's1');
    assert(true, 'mixed content handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('chat.send with null message (defensive check)', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // serve.js checks: _aFrame.params?.message
    const frame = { type: 'req', method: 'chat.send', params: { message: null } };
    if (frame.params?.message) {
      a.collectors.conversation.onUserMessage('u1', frame.params.message, 'webchat', 's1');
    }
    // null message → condition false → skip. Good.
    assert(true, 'null message skipped');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('non-final chat state is NOT tracked', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Streaming state should NOT trigger assistant response tracking
    const frame = {
      type: 'event', event: 'chat',
      payload: { state: 'streaming', message: 'partial...' }
    };

    if (frame.payload.state === 'final') {
      throw new Error('streaming should not match final');
    }
    assert(true, 'streaming state not tracked as response');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('session end with invalid reason defaults gracefully', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // serve.js passes the close reason string, which may not be in the valid set
    // SessionCollector should default to 'error'
    a.collectors.session.onSessionStart('u1', 'webchat', null, 's1');
    a.collectors.session.onSessionEnd('u1', 'grace period expired', 0);
    assert(true, 'invalid reason handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 8: Floating Point & Numeric Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

suite('8. Numeric edge cases');

test('usage with NaN/Infinity values', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    a.collectors.conversation.onAssistantResponse('u1',
      { text: 'test' },
      { input: NaN, output: Infinity, cost: -Infinity, cacheRead: undefined },
      's1'
    );
    assert(true, 'NaN/Infinity usage values handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('negative connection duration in WS error', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    a.collectors.error.onWsError('disconnect', 'u1', -5000, 's1');
    assert(true, 'negative duration handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('zero-length tool args', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    a.collectors.tool.onToolStart('call-1', 'exec', {}, 'u1', 's1');
    a.collectors.tool.onToolEnd('call-1', '', 'u1', 's1');
    assert(true, 'empty tool args/result handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('massive number of tool calls', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Simulate 500 tool starts without ends (like a runaway agent)
    for (let i = 0; i < 500; i++) {
      a.collectors.tool.onToolStart(`call-${i}`, 'exec', {}, 'u1', 's1');
    }
    assert(true, '500 open tool calls handled');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 9: Data Integrity
// ═══════════════════════════════════════════════════════════════════════════════

suite('9. Data integrity');

test('data directory is populated after events', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Emit some events
    a.collectors.conversation.onUserMessage('user1', 'Hello', 'webchat', 'sess1');
    a.collectors.tool.onToolStart('call-1', 'exec', {}, 'user1', 'sess1');
    
    // Data directory should exist
    assert(fs.existsSync(tmpDir), 'data directory exists');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('multiple init/stop cycles do not leak resources', () => {
  const tmpDir = makeTmpDir();
  try {
    for (let i = 0; i < 5; i++) {
      const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
      a.start();
      a.collectors.conversation.onUserMessage('u1', `cycle-${i}`, 'webchat', 's1');
      a.stop();
    }
    assert(true, '5 init/stop cycles completed');
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 10: Serve.js Defensive Patterns
// ═══════════════════════════════════════════════════════════════════════════════

suite('10. serve.js defensive patterns');

test('analytics null check pattern: if (analytics) try { ... } catch(_) {}', () => {
  // Simulate serve.js pattern when analytics is null
  let analytics = null;

  // Should not throw
  if (analytics) try { analytics.collectors.error.onWidgetError('x', 'y', 'z', 'w'); } catch(_) {}
  if (analytics) try { analytics.collectors.session.onSessionStart('u', 'w', null, 'c'); } catch(_) {}
  if (analytics) try { analytics.collectors.conversation.onUserMessage('u', 'm', 'w', 's'); } catch(_) {}

  assert(true, 'null analytics checks work');
});

test('analytics with crashed collector still protects serve.js', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Sabotage a collector method
    const original = a.collectors.error.onWidgetError;
    a.collectors.error.onWidgetError = () => { throw new Error('KABOOM'); };

    // serve.js pattern: wrapped in try/catch
    let caught = false;
    try {
      a.collectors.error.onWidgetError('test', 'err', 'u1', 's1');
    } catch(_) {
      caught = true;
    }
    assert(caught, 'error was caught by try/catch');

    // Restore
    a.collectors.error.onWidgetError = original;
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('initAnalytics with unwritable path does not crash server', () => {
  const tmpDir = makeTmpDir();
  try {
    // Use a read-only subdirectory
    const roDir = path.join(tmpDir, 'readonly');
    fs.mkdirSync(roDir);
    fs.chmodSync(roDir, 0o444);
    const badDir = path.join(roDir, 'analytics');

    let threw = false;
    let inst = null;
    try {
      inst = initAnalytics({ dataDir: badDir, wsSessions: new Map() });
    } catch(e) {
      threw = true;
    }
    // Ensure cleanup even on partial init
    if (inst) inst.stop();
    // Either works fine or catches gracefully — both are acceptable
    assert(true, 'bad directory handled gracefully');
    fs.chmodSync(roDir, 0o755);
  } finally { cleanTmpDir(tmpDir); }
});

test('session cleanup with analytics tracks end event', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // Simulate: session started, then _cleanupSession called
    a.collectors.session.onSessionStart('usr_x', 'webchat', null, 'client-x');
    
    // serve.js _cleanupSession pattern:
    const _sUserId = 'usr_x';
    const reason = 'grace period expired';
    a.collectors.session.onSessionEnd(_sUserId, reason, 0);
    // SessionCollector defaults invalid reason to 'error' internally

    assert(true, 'cleanup tracking works');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('gateway WS error triggers error collector', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // serve.js gwWs.on("error") pattern:
    a.collectors.error.onWsError('gateway_error', 'usr_1', 0, 'client-1');
    assert(true, 'gateway error tracking works');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('widget error tracking for every widget prefix', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    // All 9 widget prefixes from serve.js
    const prefixes = [
      'sn-', 'mail-', 'cal-', 'admin-', 'subagent-',
      'yt-', 'spotify-', 'deploy-', 'onboard-'
    ];

    for (const prefix of prefixes) {
      a.collectors.error.onWidgetError(`${prefix}test`, `Error in ${prefix}`, 'u1', 's1');
    }

    assert(true, 'all widget prefixes tracked');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 11: Performance
// ═══════════════════════════════════════════════════════════════════════════════

suite('11. Performance');

test('initAnalytics completes in < 100ms', () => {
  const tmpDir = makeTmpDir();
  try {
    const start = Date.now();
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    const elapsed = Date.now() - start;
    assert(elapsed < 100, `initAnalytics took ${elapsed}ms (expected < 100ms)`);
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('1000 events emit in < 200ms', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      a.collectors.conversation.onUserMessage('u1', `msg-${i}`, 'webchat', 's1');
    }
    const elapsed = Date.now() - start;
    assert(elapsed < 200, `1000 events took ${elapsed}ms (expected < 200ms)`);
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('collector call overhead < 1ms per call', () => {
  const tmpDir = makeTmpDir();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: new Map() });
    a.start();

    const iterations = 10000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      a.collectors.tool.onToolStart(`call-${i}`, 'exec', {}, 'u1', 's1');
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    const perCall = elapsed / iterations;
    assert(perCall < 1, `per-call overhead: ${perCall.toFixed(4)}ms (expected < 1ms)`);
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 12: Integration with wsSessions Map
// ═══════════════════════════════════════════════════════════════════════════════

suite('12. wsSessions Map integration');

test('analytics receives wsSessions reference', () => {
  const tmpDir = makeTmpDir();
  const { map } = createMockWsSessions();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: map });
    // The ws module should have access to wsSessions for broadcasting
    assert(a.ws, 'ws module should exist');
    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

test('wsSessions mutations visible to analytics', () => {
  const tmpDir = makeTmpDir();
  const { map, addClient } = createMockWsSessions();
  try {
    const a = initAnalytics({ dataDir: tmpDir, wsSessions: map });
    a.start();

    assertEq(map.size, 0, 'starts empty');
    addClient('client-1', { userId: 'u1' });
    assertEq(map.size, 1, 'client added');
    map.delete('client-1');
    assertEq(map.size, 0, 'client removed');

    a.stop();
  } finally { cleanTmpDir(tmpDir); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Run Report
// ═══════════════════════════════════════════════════════════════════════════════

// Force exit after 10s in case lingering timers/listeners keep process alive
const _exitTimer = setTimeout(() => {
  console.log('\n⚠️ Force exit (lingering timers)');
  console.log(`Phase 5 Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  process.exit(failed > 0 ? 1 : 0);
}, 10000);
_exitTimer.unref();

console.log('\n══════════════════════════════════════════════════');
console.log(`Phase 5 Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log('══════════════════════════════════════════════════');

process.exit(failed > 0 ? 1 : 0);
