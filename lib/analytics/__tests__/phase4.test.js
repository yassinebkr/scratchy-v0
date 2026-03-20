'use strict';

/**
 * Phase 4 Unit Tests — analytics-routes (REST API) + analytics-ws (WebSocket push)
 * Run: node lib/analytics/__tests__/phase4.test.js
 */

const { createAnalyticsRoutes } = require('../api/analytics-routes');
const { createAnalyticsWs } = require('../api/analytics-ws');

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
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'assertDeep'}: expected ${b}, got ${a}`);
}

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) { res.headers[name] = value; },
    end(data) { res.body = data ? JSON.parse(data) : null; }
  };
  return res;
}

function createMockReq(method = 'GET') {
  return { method };
}

function createMockUrl(pathname, params = {}) {
  const sp = new URLSearchParams(params);
  return { pathname, searchParams: sp };
}

function adminAuth() {
  return { user: { role: 'admin', id: 'admin-1' }, isLegacy: false };
}

function legacyAuth() {
  // Legacy auth in Scratchy = gateway token auth pre-multi-user.
  // isAdmin() requires authResult.user to be truthy, so legacy needs a user stub.
  return { isLegacy: true, user: { role: 'legacy' } };
}

function operatorAuth() {
  return { user: { role: 'operator', id: 'op-1' }, isLegacy: false };
}

function noAuth() {
  return null;
}

function createMockEventStore(events = []) {
  return {
    query(opts) {
      let results = [...events];
      if (opts.type) results = results.filter(e => e.type === opts.type);
      if (opts.userId) results = results.filter(e => e.userId === opts.userId);
      if (opts.limit) results = results.slice(0, opts.limit);
      return results;
    },
    getStats() {
      return { totalEvents: events.length, filesOpen: 1 };
    }
  };
}

function createMockRollupStore(hourlyData = {}, dailyData = {}) {
  return {
    readHourly(hourKey) {
      return hourlyData[hourKey] || null;
    },
    readHourlyRange(date) {
      // Return all hourly rollups matching date prefix
      return Object.entries(hourlyData)
        .filter(([k]) => k.startsWith(date))
        .map(([, v]) => v);
    },
    readDailyRange(from, to) {
      return Object.entries(dailyData)
        .filter(([k]) => k >= from && k <= to)
        .map(([, v]) => v);
    },
    listHourlyKeys(date) {
      return Object.keys(hourlyData).filter(k => k.startsWith(date));
    }
  };
}

function createMockEventBus() {
  return {
    getStats() {
      return { listenersCount: 3, totalEmitted: 42 };
    }
  };
}

function createMockAggregators() {
  return {
    conversation: {
      mergeDailyRollup(slices) {
        const total = slices.reduce((sum, s) => sum + (s.totalMessages || 0), 0);
        return { totalMessages: total, byModel: { 'opus': total }, bySource: { webchat: total } };
      }
    },
    tool: {
      mergeDailyRollup(slices) {
        const total = slices.reduce((sum, s) => sum + (s.totalToolCalls || 0), 0);
        return { totalToolCalls: total, byTool: { read: 5 }, mostUsed: ['read'], slowest: ['browser'], errorHotspots: [] };
      }
    },
    error: {
      mergeDailyRollup(slices) {
        const total = slices.reduce((sum, s) => sum + (s.totalErrors || 0), 0);
        return { totalErrors: total, errorRate: 0.02, byCategory: { auth: 1 }, byErrorType: { '401': 1 } };
      }
    },
    user: {
      mergeDailyRollup(slices) {
        const total = slices.reduce((sum, s) => sum + (s.activeUsers || 0), 0);
        return { activeUsers: total, byUser: { 'u1': { messages: 5 } }, topUsers: ['u1'], featureAdoption: { tts: 0.5 } };
      }
    }
  };
}

function createMockWsSession(id, isAdmin = true, wsOpen = true) {
  return {
    id,
    authResult: isAdmin ? adminAuth() : operatorAuth(),
    clientWs: {
      readyState: wsOpen ? 1 : 3,
      sent: [],
      send(data) {
        if (this.readyState !== 1) throw new Error('WS closed');
        this.sent.push(JSON.parse(data));
      }
    }
  };
}

// ─── Helper: run a route call ────────────────────────────────────────────────

function callRoute(handler, pathname, params, auth, method) {
  const req = createMockReq(method || 'GET');
  const res = createMockRes();
  const url = createMockUrl(pathname, params);
  // Pass auth exactly as given — null means no auth
  handler(req, res, url, arguments.length >= 4 ? auth : adminAuth());
  return res;
}

// ═════════════════════════════════════════════════════════════════════════════
// ██ PART A: analytics-routes.js
// ═════════════════════════════════════════════════════════════════════════════

suite('createAnalyticsRoutes — factory');

test('returns a function', () => {
  const handler = createAnalyticsRoutes({
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  });
  assertEq(typeof handler, 'function');
});

// ─── Routing ─────────────────────────────────────────────────────────────────

suite('Routes — method and path routing');

const routeDeps = {
  eventStore: createMockEventStore(),
  rollupStore: createMockRollupStore(),
  eventBus: createMockEventBus(),
  aggregators: createMockAggregators()
};
const routeHandler = createAnalyticsRoutes(routeDeps);

test('POST returns 405', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', {}, adminAuth(), 'POST');
  assertEq(res.statusCode, 405);
  assertEq(res.body.error, 'Method not allowed');
});

test('PUT returns 405', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', {}, adminAuth(), 'PUT');
  assertEq(res.statusCode, 405);
});

test('unknown path returns 404', () => {
  const res = callRoute(routeHandler, '/api/analytics/nonexistent', {}, adminAuth());
  assertEq(res.statusCode, 404);
  assertEq(res.body.error, 'Endpoint not found');
});

test('/api/analytics prefix required', () => {
  const res = callRoute(routeHandler, '/api/overview', {}, adminAuth());
  assertEq(res.statusCode, 404);
});

// ─── Auth checks ─────────────────────────────────────────────────────────────

suite('Routes — authentication');

const authEndpoints = [
  '/api/analytics/overview',
  '/api/analytics/conversations',
  '/api/analytics/tools',
  '/api/analytics/errors',
  '/api/analytics/users'
];

for (const ep of authEndpoints) {
  const name = ep.split('/').pop();

  test(`${name}: operator gets 403`, () => {
    const res = callRoute(routeHandler, ep, {}, operatorAuth());
    assertEq(res.statusCode, 403);
    assertEq(res.body.error, 'Admin access required');
  });

  test(`${name}: null auth gets 403`, () => {
    const res = callRoute(routeHandler, ep, {}, noAuth());
    assertEq(res.statusCode, 403);
  });

  test(`${name}: admin gets 200`, () => {
    const res = callRoute(routeHandler, ep, {}, adminAuth());
    assertEq(res.statusCode, 200);
  });

  test(`${name}: legacy auth gets 200`, () => {
    const res = callRoute(routeHandler, ep, {}, legacyAuth());
    assertEq(res.statusCode, 200);
  });
}

// ─── Health endpoint special auth ────────────────────────────────────────────

suite('Routes — health endpoint auth');

test('health: non-admin gets basic health (200)', () => {
  const res = callRoute(routeHandler, '/api/analytics/health', {}, operatorAuth());
  assertEq(res.statusCode, 200);
  assertEq(res.body.status, 'ok');
  assert(!res.body.eventStore, 'non-admin should not see eventStore stats');
});

test('health: null auth gets basic health (200)', () => {
  const res = callRoute(routeHandler, '/api/analytics/health', {}, noAuth());
  assertEq(res.statusCode, 200);
  assertEq(res.body.status, 'ok');
});

test('health: admin gets full stats', () => {
  const res = callRoute(routeHandler, '/api/analytics/health', {}, adminAuth());
  assertEq(res.statusCode, 200);
  assertEq(res.body.status, 'ok');
  assert(res.body.eventStore, 'admin should see eventStore stats');
  assert(res.body.eventBus, 'admin should see eventBus stats');
  assert(res.body.rollups !== undefined, 'admin should see rollup info');
});

// ─── Overview endpoint ───────────────────────────────────────────────────────

suite('Routes — overview endpoint');

test('overview: returns conversation, tools, errors, users, meta', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', {}, adminAuth());
  assertEq(res.statusCode, 200);
  assert(res.body.conversation !== undefined, 'missing conversation');
  assert(res.body.tools !== undefined, 'missing tools');
  assert(res.body.errors !== undefined, 'missing errors');
  assert(res.body.users !== undefined, 'missing users');
  assert(res.body.meta, 'missing meta');
});

test('overview: default range is 7d', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', {}, adminAuth());
  assertEq(res.body.meta.range, '7d');
});

test('overview: respects range=24h', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', { range: '24h' }, adminAuth());
  assertEq(res.body.meta.range, '24h');
});

test('overview: respects range=30d', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', { range: '30d' }, adminAuth());
  assertEq(res.body.meta.range, '30d');
});

test('overview: invalid range defaults to 7d', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', { range: 'invalid' }, adminAuth());
  assertEq(res.body.meta.range, 'invalid'); // range param is passed through, parseRange defaults internally
});

test('overview: meta includes from, to, generatedAt', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', {}, adminAuth());
  assert(res.body.meta.from, 'missing from');
  assert(res.body.meta.to, 'missing to');
  assert(res.body.meta.generatedAt, 'missing generatedAt');
});

// Overview with actual rollup data
test('overview: merges rollup data correctly', () => {
  const today = new Date().toISOString().split('T')[0];
  const dailyData = {};
  dailyData[today] = {
    aggregations: {
      conversation: { totalMessages: 10 },
      tool: { totalToolCalls: 5 },
      error: { totalErrors: 2 },
      user: { activeUsers: 3 }
    }
  };
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, dailyData),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 200);
  assertEq(res.body.conversation.totalMessages, 10);
  assertEq(res.body.tools.totalToolCalls, 5);
});

// ─── Conversations endpoint ──────────────────────────────────────────────────

suite('Routes — conversations endpoint');

test('conversations: returns timeSeries and breakdowns', () => {
  const res = callRoute(routeHandler, '/api/analytics/conversations', {}, adminAuth());
  assertEq(res.statusCode, 200);
  assert(Array.isArray(res.body.timeSeries), 'timeSeries should be array');
  assert(res.body.meta, 'missing meta');
});

test('conversations: userId filter changes response shape', () => {
  const events = [
    { type: 'conversation', userId: 'u1', ts: Date.now(), meta: { cost: 0.01, responseTimeMs: 100 } },
    { type: 'conversation', userId: 'u1', ts: Date.now() - 1000, meta: { cost: 0.02 } },
    { type: 'conversation', userId: 'u2', ts: Date.now(), meta: {} }
  ];
  const deps = {
    eventStore: createMockEventStore(events),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1' }, adminAuth());
  assertEq(res.statusCode, 200);
  assertEq(res.body.userId, 'u1');
  assertEq(res.body.meta.filteredBy, 'userId');
  assert(Array.isArray(res.body.timeSeries), 'timeSeries should be array');
});

test('conversations: userId filter only includes matching events', () => {
  const now = Date.now();
  const events = [
    { type: 'conversation', userId: 'u1', ts: now, meta: {} },
    { type: 'conversation', userId: 'u1', ts: now - 500, meta: {} },
    { type: 'conversation', userId: 'u2', ts: now, meta: {} }
  ];
  const deps = {
    eventStore: createMockEventStore(events),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1', range: '24h' }, adminAuth());
  assertEq(res.statusCode, 200);
  // Time series should only have u1's data — 2 messages in the same hour bucket
  const totalMessages = res.body.timeSeries.reduce((sum, p) => sum + (p.messages || 0), 0);
  assertEq(totalMessages, 2, 'should have 2 messages for u1');
});

// ─── Tools endpoint ──────────────────────────────────────────────────────────

suite('Routes — tools endpoint');

test('tools: returns expected fields', () => {
  const res = callRoute(routeHandler, '/api/analytics/tools', {}, adminAuth());
  assertEq(res.statusCode, 200);
  assert(Array.isArray(res.body.timeSeries), 'timeSeries should be array');
  assert(res.body.meta, 'missing meta');
  // With empty rollup, these should be empty defaults
  assertDeep(res.body.toolBreakdown, {});
  assertDeep(res.body.mostUsed, []);
  assertDeep(res.body.slowest, []);
  assertDeep(res.body.errorHotspots, []);
});

test('tools: with rollup data returns breakdowns', () => {
  const today = new Date().toISOString().split('T')[0];
  const dailyData = {};
  dailyData[today] = {
    aggregations: { tool: { totalToolCalls: 15 } }
  };
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, dailyData),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/tools', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 200);
  assert(res.body.toolBreakdown.read === 5, 'should have tool breakdown');
  assertDeep(res.body.mostUsed, ['read']);
});

// ─── Errors endpoint ─────────────────────────────────────────────────────────

suite('Routes — errors endpoint');

test('errors: returns expected fields', () => {
  const res = callRoute(routeHandler, '/api/analytics/errors', {}, adminAuth());
  assertEq(res.statusCode, 200);
  assert(Array.isArray(res.body.timeSeries), 'timeSeries should be array');
  assert(Array.isArray(res.body.recentErrors), 'recentErrors should be array');
  assert(typeof res.body.errorRate === 'number', 'errorRate should be number');
  assert(typeof res.body.trend === 'number', 'trend should be number');
  assert(res.body.meta, 'missing meta');
});

test('errors: recentErrors limited to 20', () => {
  const events = [];
  for (let i = 0; i < 30; i++) {
    events.push({ type: 'error', ts: Date.now() - i * 1000, meta: {} });
  }
  const deps = {
    eventStore: createMockEventStore(events),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/errors', {}, adminAuth());
  assert(res.body.recentErrors.length <= 20, 'should cap at 20 recent errors');
});

test('errors: with rollup data returns categories', () => {
  const today = new Date().toISOString().split('T')[0];
  const dailyData = {};
  dailyData[today] = {
    aggregations: { error: { totalErrors: 3, errorRate: 0.05 } }
  };
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, dailyData),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/errors', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 200);
  assert(res.body.categories.auth === 1, 'should have error categories');
});

// ─── Users endpoint ──────────────────────────────────────────────────────────

suite('Routes — users endpoint');

test('users: returns expected fields', () => {
  const res = callRoute(routeHandler, '/api/analytics/users', {}, adminAuth());
  assertEq(res.statusCode, 200);
  assert(typeof res.body.activeUsers === 'number', 'activeUsers should be number');
  assert(Array.isArray(res.body.userList), 'userList should be array');
  assert(Array.isArray(res.body.topUsers), 'topUsers should be array');
  assert(res.body.meta, 'missing meta');
});

test('users: default range is 30d', () => {
  const res = callRoute(routeHandler, '/api/analytics/users', {}, adminAuth());
  assertEq(res.body.meta.range, '30d');
});

test('users: with rollup data returns user list', () => {
  const today = new Date().toISOString().split('T')[0];
  const dailyData = {};
  dailyData[today] = {
    aggregations: { user: { activeUsers: 2 } }
  };
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, dailyData),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/users', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 200);
  assertEq(res.body.activeUsers, 2);
  assert(res.body.userList.length === 1, 'should have 1 user in list');
  assertEq(res.body.userList[0].userId, 'u1');
});

// ─── Response format ─────────────────────────────────────────────────────────

suite('Routes — response format');

test('Content-Type is application/json', () => {
  const res = callRoute(routeHandler, '/api/analytics/health', {}, adminAuth());
  assertEq(res.headers['Content-Type'], 'application/json');
});

test('error responses have error field', () => {
  const res = callRoute(routeHandler, '/api/analytics/overview', {}, operatorAuth());
  assertEq(res.statusCode, 403);
  assert(typeof res.body.error === 'string', 'error should be string');
});

// ═════════════════════════════════════════════════════════════════════════════
// ██ PART B: analytics-ws.js
// ═════════════════════════════════════════════════════════════════════════════

suite('createAnalyticsWs — factory');

test('returns expected interface', () => {
  const wsSessions = new Map();
  const ws = createAnalyticsWs({
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators(),
    wsSessions
  });
  assertEq(typeof ws.handleSubscribe, 'function');
  assertEq(typeof ws.handleUnsubscribe, 'function');
  assertEq(typeof ws.pushLiveUpdate, 'function');
  assertEq(typeof ws.pushInsight, 'function');
  assertEq(typeof ws.pushRollupComplete, 'function');
  assertEq(typeof ws.start, 'function');
  assertEq(typeof ws.stop, 'function');
  assertEq(typeof ws.getSubscriberCount, 'function');
});

// ─── Subscription management ─────────────────────────────────────────────────

suite('WebSocket — subscription');

function createWsDeps(events) {
  const wsSessions = new Map();
  return {
    eventStore: createMockEventStore(events || []),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators(),
    wsSessions
  };
}

test('subscribe adds session, getSubscriberCount reflects', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  assertEq(ws.getSubscriberCount(), 1);
});

test('subscribe sends immediate live update', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  assert(session.clientWs.sent.length >= 1, 'should have sent immediate update');
  assertEq(session.clientWs.sent[0].type, 'analytics:live');
});

test('subscribe rejects non-admin', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s2', false);
  deps.wsSessions.set('s2', session);
  ws.handleSubscribe(session);
  assertEq(ws.getSubscriberCount(), 0, 'non-admin should not subscribe');
});

test('subscribe rejects null session', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  ws.handleSubscribe(null);
  assertEq(ws.getSubscriberCount(), 0);
});

test('subscribe rejects session without id', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  ws.handleSubscribe({ authResult: adminAuth() });
  assertEq(ws.getSubscriberCount(), 0);
});

test('unsubscribe removes session', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  assertEq(ws.getSubscriberCount(), 1);
  ws.handleUnsubscribe(session);
  assertEq(ws.getSubscriberCount(), 0);
});

test('unsubscribe is idempotent (no error on double unsubscribe)', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  ws.handleUnsubscribe(session);
  ws.handleUnsubscribe(session); // second call should not throw
  assertEq(ws.getSubscriberCount(), 0);
});

test('unsubscribe with null session does not throw', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  ws.handleUnsubscribe(null); // should not throw
  assertEq(ws.getSubscriberCount(), 0);
});

test('multiple subscribers tracked correctly', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  for (let i = 1; i <= 5; i++) {
    const session = createMockWsSession(`s${i}`, true);
    deps.wsSessions.set(`s${i}`, session);
    ws.handleSubscribe(session);
  }
  assertEq(ws.getSubscriberCount(), 5);
  ws.handleUnsubscribe({ id: 's3' });
  assertEq(ws.getSubscriberCount(), 4);
});

// ─── pushLiveUpdate ──────────────────────────────────────────────────────────

suite('WebSocket — pushLiveUpdate');

test('skips when no subscribers', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  // Should not throw
  ws.pushLiveUpdate();
  assertEq(ws.getSubscriberCount(), 0);
});

test('sends live data to subscribers', () => {
  const now = Date.now();
  const events = [
    { type: 'conversation', userId: 'u1', ts: now - 1000, meta: { cost: 0.05, responseTimeMs: 200 } },
    { type: 'conversation', userId: 'u2', ts: now - 2000, meta: { cost: 0.03 } },
    { type: 'error', userId: 'u1', ts: now - 3000, meta: {} }
  ];
  const deps = createWsDeps(events);
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);

  // Clear the immediate update
  session.clientWs.sent.length = 0;

  ws.pushLiveUpdate();
  assertEq(session.clientWs.sent.length, 1, 'should have sent 1 update');
  assertEq(session.clientWs.sent[0].type, 'analytics:live');
  const data = session.clientWs.sent[0].data;
  assert(typeof data.activeUsers === 'number', 'should have activeUsers');
  assert(typeof data.messagesLast5min === 'number', 'should have messagesLast5min');
  assert(typeof data.costLast5min === 'number', 'should have costLast5min');
  assert(typeof data.errorsLast5min === 'number', 'should have errorsLast5min');
  assert(typeof data.avgResponseMsLast5min === 'number', 'should have avgResponseMsLast5min');
});

test('cleans up dead sessions on push', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);

  // Add a live session
  const liveSession = createMockWsSession('live', true);
  deps.wsSessions.set('live', liveSession);
  ws.handleSubscribe(liveSession);

  // Add a dead session (WS closed)
  const deadSession = createMockWsSession('dead', true, false); // wsOpen=false
  deps.wsSessions.set('dead', deadSession);
  ws.handleSubscribe(deadSession); // won't send immediate update (ws closed)

  // Subscriber count includes dead one initially (subscribe skips send but still adds)
  // Actually let's check — the subscribe still adds to the set even if send fails
  // Push will clean it up
  ws.pushLiveUpdate();

  // After push, dead session should be cleaned up
  // Live session should still be there
  assertEq(ws.getSubscriberCount(), 1, 'dead session should be cleaned up');
});

test('cleans up removed sessions on push', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);

  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  // Remove session from wsSessions map (simulating disconnect)
  deps.wsSessions.delete('s1');

  ws.pushLiveUpdate();
  assertEq(ws.getSubscriberCount(), 0, 'removed session should be cleaned');
});

// ─── _calculateLiveMetrics ───────────────────────────────────────────────────

suite('WebSocket — _calculateLiveMetrics');

test('empty events returns zeros', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const metrics = ws._calculateLiveMetrics([]);
  assertEq(metrics.activeUsers, 0);
  assertEq(metrics.messagesLast5min, 0);
  assertEq(metrics.costLast5min, 0);
  assertEq(metrics.errorsLast5min, 0);
  assertEq(metrics.avgResponseMsLast5min, 0);
});

test('counts unique active users', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'conversation', userId: 'u1', ts: Date.now() },
    { type: 'conversation', userId: 'u1', ts: Date.now() },
    { type: 'conversation', userId: 'u2', ts: Date.now() },
    { type: 'error', userId: 'u3', ts: Date.now() }
  ];
  const metrics = ws._calculateLiveMetrics(events);
  assertEq(metrics.activeUsers, 3, 'should count 3 unique users');
});

test('sums conversation messages', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'conversation', ts: Date.now(), meta: {} },
    { type: 'conversation', ts: Date.now(), meta: {} },
    { type: 'error', ts: Date.now(), meta: {} }
  ];
  const metrics = ws._calculateLiveMetrics(events);
  assertEq(metrics.messagesLast5min, 2);
});

test('sums cost and rounds to 2 decimals', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'conversation', ts: Date.now(), meta: { cost: 0.015 } },
    { type: 'conversation', ts: Date.now(), meta: { cost: 0.023 } }
  ];
  const metrics = ws._calculateLiveMetrics(events);
  assertEq(metrics.costLast5min, 0.04); // 0.038 → rounded to 0.04
});

test('counts errors', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'error', ts: Date.now(), meta: {} },
    { type: 'error', ts: Date.now(), meta: {} },
    { type: 'conversation', ts: Date.now(), meta: {} }
  ];
  const metrics = ws._calculateLiveMetrics(events);
  assertEq(metrics.errorsLast5min, 2);
});

test('calculates average response time', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'conversation', ts: Date.now(), meta: { responseTimeMs: 100 } },
    { type: 'conversation', ts: Date.now(), meta: { responseTimeMs: 200 } },
    { type: 'conversation', ts: Date.now(), meta: {} } // no responseTimeMs — excluded
  ];
  const metrics = ws._calculateLiveMetrics(events);
  assertEq(metrics.avgResponseMsLast5min, 150);
});

test('handles events with no meta gracefully', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'conversation', ts: Date.now() },
    { type: 'error', ts: Date.now() }
  ];
  const metrics = ws._calculateLiveMetrics(events);
  assertEq(metrics.messagesLast5min, 1);
  assertEq(metrics.errorsLast5min, 1);
  assertEq(metrics.costLast5min, 0);
});

// ─── pushInsight ─────────────────────────────────────────────────────────────

suite('WebSocket — pushInsight');

test('sends insight to subscribers', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushInsight({ id: 'i1', severity: 'warning', title: 'High error rate', message: 'Error rate exceeded 5%' });
  assertEq(session.clientWs.sent.length, 1);
  assertEq(session.clientWs.sent[0].type, 'analytics:insight');
  assertEq(session.clientWs.sent[0].data.id, 'i1');
  assertEq(session.clientWs.sent[0].data.severity, 'warning');
  assertEq(session.clientWs.sent[0].data.title, 'High error rate');
});

test('defaults severity to info', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushInsight({ id: 'i2', title: 'Test', message: 'msg' });
  assertEq(session.clientWs.sent[0].data.severity, 'info');
});

test('skips invalid insight (missing id)', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushInsight({ title: 'Test', message: 'msg' }); // no id
  assertEq(session.clientWs.sent.length, 0, 'should not send invalid insight');
});

test('skips invalid insight (missing title)', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushInsight({ id: 'i3', message: 'msg' }); // no title
  assertEq(session.clientWs.sent.length, 0);
});

test('skips insight when no subscribers', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  // Should not throw
  ws.pushInsight({ id: 'i1', severity: 'error', title: 'Test', message: 'test' });
  assertEq(ws.getSubscriberCount(), 0);
});

// ─── pushRollupComplete ──────────────────────────────────────────────────────

suite('WebSocket — pushRollupComplete');

test('sends rollup notification to subscribers', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushRollupComplete({
    hourKey: '2026-02-23T14',
    aggregations: {
      conversation: { totalMessages: 50, totalCost: 1.23 },
      error: { totalErrors: 2 }
    }
  });
  assertEq(session.clientWs.sent.length, 1);
  assertEq(session.clientWs.sent[0].type, 'analytics:rollup');
  assertEq(session.clientWs.sent[0].data.hourKey, '2026-02-23T14');
  assertEq(session.clientWs.sent[0].data.summary.messages, 50);
  assertEq(session.clientWs.sent[0].data.summary.cost, 1.23);
  assertEq(session.clientWs.sent[0].data.summary.errors, 2);
});

test('rollup with no aggregations sends zero summary', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushRollupComplete({ hourKey: '2026-02-23T15' });
  assertEq(session.clientWs.sent[0].data.summary.messages, 0);
  assertEq(session.clientWs.sent[0].data.summary.cost, 0);
  assertEq(session.clientWs.sent[0].data.summary.errors, 0);
});

test('skips invalid rollup (no hourKey)', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushRollupComplete({ aggregations: {} }); // no hourKey
  assertEq(session.clientWs.sent.length, 0);
});

test('skips rollup when no subscribers', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  ws.pushRollupComplete({ hourKey: '2026-02-23T14', aggregations: {} });
  assertEq(ws.getSubscriberCount(), 0);
});

// ─── start/stop lifecycle ────────────────────────────────────────────────────

suite('WebSocket — start/stop lifecycle');

test('start and stop do not throw', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  ws.start();
  ws.stop();
  // No error = pass
  assert(true);
});

test('double start does not throw', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  ws.start();
  ws.start(); // second call should warn but not throw
  ws.stop();
  assert(true);
});

test('double stop does not throw', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  ws.start();
  ws.stop();
  ws.stop(); // second call safe
  assert(true);
});

test('stop without start does not throw', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  ws.stop(); // never started
  assert(true);
});

// ─── _cleanupDeadSessions ───────────────────────────────────────────────────

suite('WebSocket — dead session cleanup');

test('removes sessions with closed WS', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);

  const liveSession = createMockWsSession('live', true, true);
  deps.wsSessions.set('live', liveSession);
  ws.handleSubscribe(liveSession);

  const deadSession = createMockWsSession('dead', true, false);
  deps.wsSessions.set('dead', deadSession);
  // Manually add to subscribers (subscribe might fail to send)
  ws.handleSubscribe(deadSession);

  ws._cleanupDeadSessions();
  assertEq(ws.getSubscriberCount(), 1, 'should keep only live session');
});

test('removes sessions no longer in wsSessions map', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);

  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);

  deps.wsSessions.delete('s1'); // simulate disconnect

  ws._cleanupDeadSessions();
  assertEq(ws.getSubscriberCount(), 0, 'should remove orphaned subscription');
});

// ─── Multi-subscriber broadcast ──────────────────────────────────────────────

suite('WebSocket — multi-subscriber broadcast');

test('live update reaches all subscribers', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);

  const sessions = [];
  for (let i = 1; i <= 3; i++) {
    const s = createMockWsSession(`s${i}`, true);
    deps.wsSessions.set(`s${i}`, s);
    ws.handleSubscribe(s);
    s.clientWs.sent.length = 0; // clear immediate update
    sessions.push(s);
  }

  ws.pushLiveUpdate();

  for (const s of sessions) {
    assertEq(s.clientWs.sent.length, 1, `subscriber ${s.id} should get update`);
    assertEq(s.clientWs.sent[0].type, 'analytics:live');
  }
});

test('insight reaches all subscribers', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);

  const s1 = createMockWsSession('s1', true);
  const s2 = createMockWsSession('s2', true);
  deps.wsSessions.set('s1', s1);
  deps.wsSessions.set('s2', s2);
  ws.handleSubscribe(s1);
  ws.handleSubscribe(s2);
  s1.clientWs.sent.length = 0;
  s2.clientWs.sent.length = 0;

  ws.pushInsight({ id: 'i1', title: 'Test', message: 'msg' });

  assertEq(s1.clientWs.sent.length, 1);
  assertEq(s2.clientWs.sent.length, 1);
  assertEq(s1.clientWs.sent[0].data.id, 'i1');
  assertEq(s2.clientWs.sent[0].data.id, 'i1');
});

// ═════════════════════════════════════════════════════════════════════════════
// ██ PART C: HARDENED EDGE CASES
// ═════════════════════════════════════════════════════════════════════════════

// ─── parseRange date verification ────────────────────────────────────────────

suite('Routes — parseRange date correctness');

test('24h range: from is yesterday, to is today', () => {
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '24h' }, adminAuth());
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  assertEq(res.body.meta.to, today, 'to should be today');
  assertEq(res.body.meta.from, yesterday, 'from should be yesterday');
});

test('7d range: from is 7 days ago', () => {
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '7d' }, adminAuth());
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  assertEq(res.body.meta.to, today);
  assertEq(res.body.meta.from, weekAgo);
});

test('30d range: from is 30 days ago', () => {
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '30d' }, adminAuth());
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  assertEq(res.body.meta.to, today);
  assertEq(res.body.meta.from, monthAgo);
});

test('invalid range gets same from/to as 7d', () => {
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res7d = callRoute(handler, '/api/analytics/overview', { range: '7d' }, adminAuth());
  const resInvalid = callRoute(handler, '/api/analytics/overview', { range: 'garbage' }, adminAuth());
  assertEq(resInvalid.body.meta.from, res7d.body.meta.from, 'invalid range from should match 7d');
  assertEq(resInvalid.body.meta.to, res7d.body.meta.to, 'invalid range to should match 7d');
});

// ─── Aggregator crash resilience ─────────────────────────────────────────────

suite('Routes — aggregator crash resilience');

test('overview returns 500 when aggregator throws', () => {
  const today = new Date().toISOString().split('T')[0];
  const dailyData = {};
  dailyData[today] = {
    aggregations: { conversation: { totalMessages: 5 } }
  };
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, dailyData),
    eventBus: createMockEventBus(),
    aggregators: {
      conversation: {
        mergeDailyRollup() { throw new Error('Aggregator exploded'); }
      },
      tool: createMockAggregators().tool,
      error: createMockAggregators().error,
      user: createMockAggregators().user
    }
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 500, 'should return 500 on aggregator crash');
  assert(res.body.error, 'should have error message');
});

test('conversations returns 500 when eventStore.query throws', () => {
  const deps = {
    eventStore: {
      query() { throw new Error('EventStore read failure'); },
      getStats() { return {}; }
    },
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1' }, adminAuth());
  assertEq(res.statusCode, 500);
});

test('tools returns 500 when rollupStore throws', () => {
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: {
      readHourlyRange() { throw new Error('Disk I/O error'); },
      readDailyRange() { throw new Error('Disk I/O error'); },
      readHourly() { return null; },
      listHourlyKeys() { return []; }
    },
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/tools', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 500);
});

test('health returns 500 when eventStore.getStats throws', () => {
  const deps = {
    eventStore: {
      query() { return []; },
      getStats() { throw new Error('Stats broken'); }
    },
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/health', {}, adminAuth());
  assertEq(res.statusCode, 500, 'health should 500 on getStats crash');
});

test('errors endpoint handles rollupStore crash gracefully', () => {
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: {
      readHourlyRange() { throw new Error('Rollup corrupted'); },
      readDailyRange() { throw new Error('Rollup corrupted'); },
      readHourly() { return null; },
      listHourlyKeys() { return []; }
    },
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/errors', { range: '30d' }, adminAuth());
  assertEq(res.statusCode, 500);
});

// ─── Rollup data shapes ─────────────────────────────────────────────────────

suite('Routes — malformed rollup data');

test('overview handles rollup with null aggregations', () => {
  const today = new Date().toISOString().split('T')[0];
  const dailyData = {};
  dailyData[today] = { aggregations: null };
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, dailyData),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 200, 'should handle null aggregations');
});

test('overview handles rollup with missing aggregation domains', () => {
  const today = new Date().toISOString().split('T')[0];
  const dailyData = {};
  dailyData[today] = { aggregations: { conversation: { totalMessages: 3 } } }; // only conversation, no tool/error/user
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, dailyData),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 200);
  assertEq(res.body.conversation.totalMessages, 3, 'conversation should merge');
  // Other domains should be empty objects (no slices → empty)
  assertDeep(res.body.tools, {});
  assertDeep(res.body.errors, {});
  assertDeep(res.body.users, {});
});

test('overview handles empty rollup array', () => {
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, {}), // no data at all
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 200);
  assertDeep(res.body.conversation, {});
  assertDeep(res.body.tools, {});
});

// ─── buildTimeSeriesFromEvents edge cases ────────────────────────────────────

suite('Routes — buildTimeSeriesFromEvents edge cases');

test('conversations with userId: events spanning multiple hours produce sorted series', () => {
  const now = Date.now();
  const hour1 = now - 2 * 60 * 60 * 1000; // 2 hours ago
  const hour2 = now - 1 * 60 * 60 * 1000; // 1 hour ago
  const events = [
    { type: 'conversation', userId: 'u1', ts: hour2, meta: { cost: 0.01 } },
    { type: 'conversation', userId: 'u1', ts: hour1, meta: { cost: 0.02 } },
    { type: 'conversation', userId: 'u1', ts: hour2 + 1000, meta: { cost: 0.03 } },
  ];
  const deps = {
    eventStore: createMockEventStore(events),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1', range: '24h' }, adminAuth());
  assertEq(res.statusCode, 200);
  const ts = res.body.timeSeries;
  assert(ts.length >= 2, 'should have at least 2 hour buckets');
  // Verify sorted by hour
  for (let i = 1; i < ts.length; i++) {
    assert(ts[i].hour >= ts[i - 1].hour, `timeSeries not sorted: ${ts[i - 1].hour} > ${ts[i].hour}`);
  }
});

test('conversations with userId: running average responseTimeMs is correct', () => {
  const now = Date.now();
  const events = [
    { type: 'conversation', userId: 'u1', ts: now, meta: { responseTimeMs: 100 } },
    { type: 'conversation', userId: 'u1', ts: now + 1, meta: { responseTimeMs: 300 } },
    { type: 'conversation', userId: 'u1', ts: now + 2, meta: { responseTimeMs: 200 } },
  ];
  const deps = {
    eventStore: createMockEventStore(events),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1', range: '24h' }, adminAuth());
  const ts = res.body.timeSeries;
  assert(ts.length >= 1, 'should have at least 1 bucket');
  // All 3 in same hour → avg should be 200
  const bucket = ts[0];
  assertEq(bucket.messages, 3, 'should have 3 messages');
  assertEq(bucket.avgResponseMs, 200, 'running average of 100,300,200 should be 200');
});

test('conversations with userId: zero responseTimeMs excluded from average', () => {
  const now = Date.now();
  const events = [
    { type: 'conversation', userId: 'u1', ts: now, meta: { responseTimeMs: 0 } },
    { type: 'conversation', userId: 'u1', ts: now + 1, meta: { responseTimeMs: 400 } },
  ];
  const deps = {
    eventStore: createMockEventStore(events),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1', range: '24h' }, adminAuth());
  const ts = res.body.timeSeries;
  const bucket = ts[0];
  assertEq(bucket.avgResponseMs, 400, 'responseTimeMs=0 should be excluded, leaving only 400');
});

test('conversations with userId: negative responseTimeMs excluded', () => {
  const now = Date.now();
  const events = [
    { type: 'conversation', userId: 'u1', ts: now, meta: { responseTimeMs: -50 } },
    { type: 'conversation', userId: 'u1', ts: now + 1, meta: { responseTimeMs: 300 } },
  ];
  const deps = {
    eventStore: createMockEventStore(events),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1', range: '24h' }, adminAuth());
  const ts = res.body.timeSeries;
  const bucket = ts[0];
  assertEq(bucket.avgResponseMs, 300, 'negative responseTimeMs should be excluded');
});

test('conversations with userId: empty event list returns empty timeSeries', () => {
  const deps = {
    eventStore: createMockEventStore([]),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1', range: '24h' }, adminAuth());
  assertEq(res.statusCode, 200);
  assertDeep(res.body.timeSeries, []);
});

// ─── Floating point accumulation ─────────────────────────────────────────────

suite('Routes — floating point');

test('cost accumulation across many small values', () => {
  const now = Date.now();
  const events = [];
  for (let i = 0; i < 100; i++) {
    events.push({ type: 'conversation', userId: 'u1', ts: now + i, meta: { cost: 0.001 } });
  }
  const deps = {
    eventStore: createMockEventStore(events),
    rollupStore: createMockRollupStore(),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/conversations', { userId: 'u1', range: '24h' }, adminAuth());
  const totalCost = res.body.timeSeries.reduce((sum, p) => sum + (p.cost || 0), 0);
  // 100 × 0.001 = 0.1 — but floating point might give 0.10000000000000002
  // As long as it's in a reasonable ballpark (±1% of 0.1)
  assert(totalCost > 0.099 && totalCost < 0.101,
    `cost should be ~0.1, got ${totalCost}`);
});

// ─── WS _calculateLiveMetrics edge cases ─────────────────────────────────────

suite('WebSocket — _calculateLiveMetrics edge cases');

test('events without userId not counted in activeUsers', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'conversation', ts: Date.now(), meta: {} },      // no userId
    { type: 'conversation', userId: null, ts: Date.now(), meta: {} }, // null userId
    { type: 'conversation', userId: '', ts: Date.now(), meta: {} },   // empty string userId
    { type: 'conversation', userId: 'real-user', ts: Date.now(), meta: {} }
  ];
  const metrics = ws._calculateLiveMetrics(events);
  // Only 'real-user' should be counted (null and '' are falsy)
  assertEq(metrics.activeUsers, 1, 'only truthy userIds should count');
});

test('large event volume does not crash', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [];
  const now = Date.now();
  for (let i = 0; i < 10000; i++) {
    events.push({
      type: i % 10 === 0 ? 'error' : 'conversation',
      userId: `user-${i % 50}`,
      ts: now - i * 100,
      meta: { cost: 0.001, responseTimeMs: 100 + (i % 200) }
    });
  }
  const metrics = ws._calculateLiveMetrics(events);
  assertEq(metrics.activeUsers, 50, 'should count 50 unique users');
  assertEq(metrics.messagesLast5min, 9000, '90% are conversations');
  assertEq(metrics.errorsLast5min, 1000, '10% are errors');
  assert(metrics.costLast5min > 0, 'cost should be > 0');
  assert(metrics.avgResponseMsLast5min > 0, 'avg response time should be > 0');
});

test('cost rounding: 0.1 + 0.2 scenario', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'conversation', ts: Date.now(), meta: { cost: 0.1 } },
    { type: 'conversation', ts: Date.now(), meta: { cost: 0.2 } }
  ];
  const metrics = ws._calculateLiveMetrics(events);
  // 0.1 + 0.2 = 0.30000000000000004 in JS — should round to 0.3
  assertEq(metrics.costLast5min, 0.3, 'should round 0.1+0.2 to 0.3');
});

test('all events are non-conversation, non-error type', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const events = [
    { type: 'session', userId: 'u1', ts: Date.now(), meta: {} },
    { type: 'tool', userId: 'u2', ts: Date.now(), meta: {} }
  ];
  const metrics = ws._calculateLiveMetrics(events);
  assertEq(metrics.activeUsers, 2, 'session/tool events have userIds');
  assertEq(metrics.messagesLast5min, 0, 'no conversation events');
  assertEq(metrics.errorsLast5min, 0, 'no error events');
  assertEq(metrics.costLast5min, 0);
  assertEq(metrics.avgResponseMsLast5min, 0);
});

// ─── WS send failure resilience ──────────────────────────────────────────────

suite('WebSocket — send failure resilience');

test('send failure on one subscriber does not block others', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);

  // Subscriber 1: will throw on send
  const badSession = createMockWsSession('bad', true);
  badSession.clientWs.send = function() { throw new Error('Connection reset'); };
  deps.wsSessions.set('bad', badSession);
  ws.handleSubscribe(badSession);

  // Subscriber 2: healthy
  const goodSession = createMockWsSession('good', true);
  deps.wsSessions.set('good', goodSession);
  ws.handleSubscribe(goodSession);
  goodSession.clientWs.sent.length = 0;

  ws.pushLiveUpdate();

  // Good session should still receive the update
  assertEq(goodSession.clientWs.sent.length, 1, 'healthy subscriber should get update');
  // Bad session should be cleaned up
  assert(ws.getSubscriberCount() <= 1, 'broken subscriber should be removed');
});

test('all subscribers broken does not crash', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);

  for (let i = 0; i < 5; i++) {
    const s = createMockWsSession(`s${i}`, true);
    s.clientWs.send = function() { throw new Error('All broken'); };
    deps.wsSessions.set(`s${i}`, s);
    ws.handleSubscribe(s);
  }

  // Should not throw
  ws.pushLiveUpdate();
  ws.pushInsight({ id: 'i1', title: 'Test', message: 'msg' });
  ws.pushRollupComplete({ hourKey: '2026-02-23T15', aggregations: {} });

  assertEq(ws.getSubscriberCount(), 0, 'all broken subscribers should be cleaned');
});

// ─── WS _queryRecentEvents filtering ─────────────────────────────────────────

suite('WebSocket — _queryRecentEvents time filtering');

test('filters to events within last 5 minutes', () => {
  const now = Date.now();
  const events = [
    { type: 'conversation', ts: now - 1000, meta: {} },         // 1s ago — recent
    { type: 'conversation', ts: now - 4 * 60 * 1000, meta: {} }, // 4 min ago — recent
    { type: 'conversation', ts: now - 6 * 60 * 1000, meta: {} }, // 6 min ago — stale
    { type: 'conversation', ts: now - 60 * 60 * 1000, meta: {} } // 1 hour ago — stale
  ];
  const deps = createWsDeps(events);
  const ws = createAnalyticsWs(deps);
  const recent = ws._queryRecentEvents(5);
  // eventStore.query returns all (mock doesn't filter by date well)
  // but _queryRecentEvents filters by ts cutoff
  assertEq(recent.length, 2, 'should only include events from last 5 minutes');
});

test('custom minutes parameter works', () => {
  const now = Date.now();
  const events = [
    { type: 'conversation', ts: now - 1000, meta: {} },
    { type: 'conversation', ts: now - 8 * 60 * 1000, meta: {} },
    { type: 'conversation', ts: now - 15 * 60 * 1000, meta: {} },
  ];
  const deps = createWsDeps(events);
  const ws = createAnalyticsWs(deps);
  const recent10 = ws._queryRecentEvents(10);
  assertEq(recent10.length, 2, 'within 10 min should include 2 events');
  const recent1 = ws._queryRecentEvents(1);
  assertEq(recent1.length, 1, 'within 1 min should include only 1 event');
});

// ─── Rollup data merging across multiple days ────────────────────────────────

suite('Routes — multi-day rollup merging');

test('overview merges multiple daily rollups', () => {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const dailyData = {};
  dailyData[today] = {
    aggregations: { conversation: { totalMessages: 10 }, tool: { totalToolCalls: 5 } }
  };
  dailyData[yesterday] = {
    aggregations: { conversation: { totalMessages: 20 }, tool: { totalToolCalls: 8 } }
  };
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore({}, dailyData),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '7d' }, adminAuth());
  assertEq(res.statusCode, 200);
  // Mock aggregator sums totalMessages across slices
  assertEq(res.body.conversation.totalMessages, 30, 'should sum 10 + 20 across days');
  assertEq(res.body.tools.totalToolCalls, 13, 'should sum 5 + 8 across days');
});

test('24h range uses hourly rollups, not daily', () => {
  const today = new Date().toISOString().split('T')[0];
  const hour = today + 'T10';
  const hourlyData = {};
  hourlyData[hour] = {
    aggregations: { conversation: { totalMessages: 7 } }
  };
  // Also put different data in daily (should NOT be used for 24h)
  const dailyData = {};
  dailyData[today] = {
    aggregations: { conversation: { totalMessages: 999 } }
  };
  const deps = {
    eventStore: createMockEventStore(),
    rollupStore: createMockRollupStore(hourlyData, dailyData),
    eventBus: createMockEventBus(),
    aggregators: createMockAggregators()
  };
  const handler = createAnalyticsRoutes(deps);
  const res = callRoute(handler, '/api/analytics/overview', { range: '24h' }, adminAuth());
  assertEq(res.statusCode, 200);
  // Should use hourly data (7), not daily (999)
  assertEq(res.body.conversation.totalMessages, 7, '24h should use hourly rollups');
});

// ─── Health endpoint edge cases ──────────────────────────────────────────────

suite('Routes — health edge cases');

test('health includes timestamp in ISO format', () => {
  const res = callRoute(routeHandler, '/api/analytics/health', {}, adminAuth());
  assert(res.body.timestamp.includes('T'), 'timestamp should be ISO format');
  // Verify it's a valid date
  const d = new Date(res.body.timestamp);
  assert(!isNaN(d.getTime()), 'timestamp should be parseable');
});

test('health admin: rollups.lastHour is null when no data', () => {
  const res = callRoute(routeHandler, '/api/analytics/health', {}, adminAuth());
  assertEq(res.body.rollups.lastHour, null, 'no hourly data → lastHour null');
  assertEq(res.body.rollups.hourlyCount, 0);
});

// ─── pushInsight edge cases ──────────────────────────────────────────────────

suite('WebSocket — pushInsight edge cases');

test('pushInsight with null data does not crash', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushInsight(null);
  assertEq(session.clientWs.sent.length, 0, 'null insight should be rejected');
});

test('pushInsight with undefined data does not crash', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushInsight(undefined);
  assertEq(session.clientWs.sent.length, 0);
});

test('pushInsight with empty string fields rejected', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushInsight({ id: '', title: 'Test', message: 'msg' });
  // Empty string id is falsy → should be rejected
  assertEq(session.clientWs.sent.length, 0, 'empty id should be rejected');
});

// ─── pushRollupComplete edge cases ───────────────────────────────────────────

suite('WebSocket — pushRollupComplete edge cases');

test('rollup with partial aggregations only extracts present domains', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushRollupComplete({
    hourKey: '2026-02-23T16',
    aggregations: {
      conversation: { totalMessages: 10, totalCost: 0.5 }
      // no error domain
    }
  });
  const summary = session.clientWs.sent[0].data.summary;
  assertEq(summary.messages, 10);
  assertEq(summary.cost, 0.5);
  assertEq(summary.errors, 0, 'missing error domain should default to 0');
});

test('pushRollupComplete with null does not crash', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = createMockWsSession('s1', true);
  deps.wsSessions.set('s1', session);
  ws.handleSubscribe(session);
  session.clientWs.sent.length = 0;

  ws.pushRollupComplete(null);
  assertEq(session.clientWs.sent.length, 0);
});

// ─── WS subscribe with legacy auth ──────────────────────────────────────────

suite('WebSocket — subscribe auth edge cases');

test('legacy admin session can subscribe', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = {
    id: 'legacy-1',
    authResult: { isLegacy: true },
    clientWs: { readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); } }
  };
  deps.wsSessions.set('legacy-1', session);
  ws.handleSubscribe(session);
  // isLegacy without user → non-admin path. Let's check the actual behavior:
  // The code checks: !session.authResult.isLegacy && (!user || user.role !== 'admin')
  // If isLegacy=true → first condition is false → whole AND is false → NOT rejected
  assertEq(ws.getSubscriberCount(), 1, 'legacy auth should be accepted');
});

test('session with no authResult rejected', () => {
  const deps = createWsDeps();
  const ws = createAnalyticsWs(deps);
  const session = {
    id: 'no-auth',
    clientWs: { readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); } }
  };
  deps.wsSessions.set('no-auth', session);
  ws.handleSubscribe(session);
  assertEq(ws.getSubscriberCount(), 0, 'no authResult should be rejected');
});

// ═════════════════════════════════════════════════════════════════════════════
// ██ Results
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════════════');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('══════════════════════════════════════════════════');

process.exit(failed > 0 ? 1 : 0);
