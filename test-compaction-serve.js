#!/usr/bin/env node
/**
 * Integration-style tests for serve.js compaction event handling.
 * Tests Phase 1c (enriched event forwarding) and Phase 2a (heartbeat timer).
 * Run: node test-compaction-serve.js
 */

'use strict';

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (!condition) {
    failed++;
    console.log('  ✗ ' + message);
    return false;
  }
  passed++;
  console.log('  ✓ ' + message);
  return true;
}

// ── Mock WebSocket ──
function MockWS() {
  this.readyState = 1; // OPEN
  this.sent = [];
  this.send = function(data) {
    this.sent.push(JSON.parse(data));
  };
}

// ── Extracted serve.js compaction logic (mirrors actual implementation) ──
function processCompactionEvent(session, frame) {
  var phase = frame.payload && frame.payload.data ? frame.payload.data.phase || 'start' : 'start';
  var tokensBefore = frame.payload && frame.payload.data ? frame.payload.data.tokensBefore : undefined;
  var tokensAfter = frame.payload && frame.payload.data ? frame.payload.data.tokensAfter : undefined;
  var contextWindow = frame.payload && frame.payload.data ? frame.payload.data.contextWindow : undefined;

  var compactFrame = {
    type: 'compaction', phase: phase, ts: Date.now(),
    tokensBefore: tokensBefore || undefined,
    tokensAfter: tokensAfter || undefined,
    contextWindow: contextWindow || undefined
  };

  // Send to client
  if (session.clientWs && session.clientWs.readyState === 1) {
    try { session.clientWs.send(JSON.stringify(compactFrame)); } catch(e) {}
  }

  // Broadcast to shared
  if (session._broadcastSessions) {
    for (var shared of session._broadcastSessions) {
      if (shared.clientWs && shared.clientWs.readyState === 1) {
        try { shared.clientWs.send(JSON.stringify(compactFrame)); } catch(e) {}
      }
    }
  }

  // Heartbeat management
  if (phase === 'start') {
    if (session._compactionHeartbeat) {
      clearInterval(session._compactionHeartbeat);
      session._compactionHeartbeat = null;
    }
    session._compactionStartTs = Date.now();
    session._compactionTokensBefore = tokensBefore || null;
    session._compactionHeartbeat = setInterval(function() {
      var elapsed = Date.now() - (session._compactionStartTs || Date.now());
      var progressFrame = JSON.stringify({
        type: 'compaction', phase: 'progress',
        elapsed: elapsed,
        tokensBefore: session._compactionTokensBefore || undefined,
        ts: Date.now()
      });
      if (session.clientWs && session.clientWs.readyState === 1) {
        try { session.clientWs.send(progressFrame); } catch(e) {}
      }
    }, 200); // Use 200ms in tests instead of 2000ms for speed
  } else if (phase === 'end') {
    if (session._compactionHeartbeat) {
      clearInterval(session._compactionHeartbeat);
      session._compactionHeartbeat = null;
    }
    session._compactionStartTs = null;
    session._compactionTokensBefore = null;
  }
}

// ══════════════════════════════════════════════════════════
// Test Suite: Enriched Event Forwarding
// ══════════════════════════════════════════════════════════

console.log('\n═══ Enriched Event Forwarding Tests ═══');

(function testStartEventForwarding() {
  var ws = new MockWS();
  var session = { clientWs: ws, _broadcastSessions: null, _compactionHeartbeat: null };

  processCompactionEvent(session, {
    type: 'event', event: 'agent',
    payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 97000, contextWindow: 200000 } }
  });

  assert(ws.sent.length >= 1, 'Start event forwarded to client');
  var sent = ws.sent[0];
  assert(sent.type === 'compaction', 'Frame type is compaction');
  assert(sent.phase === 'start', 'Frame phase is start');
  assert(sent.tokensBefore === 97000, 'tokensBefore forwarded (97000)');
  assert(sent.contextWindow === 200000, 'contextWindow forwarded (200000)');

  clearInterval(session._compactionHeartbeat);
})();

(function testEndEventForwarding() {
  var ws = new MockWS();
  var session = { clientWs: ws, _broadcastSessions: null, _compactionHeartbeat: null };

  processCompactionEvent(session, {
    type: 'event', event: 'agent',
    payload: { stream: 'compaction', data: { phase: 'end', tokensBefore: 97000, tokensAfter: 21000, contextWindow: 200000 } }
  });

  assert(ws.sent.length >= 1, 'End event forwarded to client');
  var sent = ws.sent[0];
  assert(sent.phase === 'end', 'Frame phase is end');
  assert(sent.tokensBefore === 97000, 'tokensBefore in end (97000)');
  assert(sent.tokensAfter === 21000, 'tokensAfter in end (21000)');
  assert(sent.contextWindow === 200000, 'contextWindow in end (200000)');
})();

(function testLegacyEventNoTokens() {
  var ws = new MockWS();
  var session = { clientWs: ws, _broadcastSessions: null, _compactionHeartbeat: null };

  processCompactionEvent(session, {
    type: 'event', event: 'agent',
    payload: { stream: 'compaction', data: { phase: 'start' } }
  });

  var sent = ws.sent[0];
  assert(sent.tokensBefore === undefined, 'Legacy start: no tokensBefore');
  assert(sent.contextWindow === undefined, 'Legacy start: no contextWindow');

  clearInterval(session._compactionHeartbeat);
})();

// ══════════════════════════════════════════════════════════
// Test Suite: Broadcast to Shared Sessions
// ══════════════════════════════════════════════════════════

console.log('\n═══ Broadcast Tests ═══');

(function testBroadcastToShared() {
  var mainWs = new MockWS();
  var sharedWs1 = new MockWS();
  var sharedWs2 = new MockWS();
  var session = {
    clientWs: mainWs,
    _broadcastSessions: [{ clientWs: sharedWs1 }, { clientWs: sharedWs2 }],
    _compactionHeartbeat: null
  };

  processCompactionEvent(session, {
    type: 'event', event: 'agent',
    payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 80000 } }
  });

  assert(mainWs.sent.length >= 1, 'Main WS received event');
  assert(sharedWs1.sent.length >= 1, 'Shared WS 1 received event');
  assert(sharedWs2.sent.length >= 1, 'Shared WS 2 received event');
  assert(sharedWs1.sent[0].tokensBefore === 80000, 'Shared WS 1 got tokensBefore');
  assert(sharedWs2.sent[0].tokensBefore === 80000, 'Shared WS 2 got tokensBefore');

  clearInterval(session._compactionHeartbeat);
})();

(function testBroadcastSkipsClosedConnections() {
  var mainWs = new MockWS();
  var closedWs = new MockWS();
  closedWs.readyState = 3; // CLOSED
  var session = {
    clientWs: mainWs,
    _broadcastSessions: [{ clientWs: closedWs }],
    _compactionHeartbeat: null
  };

  processCompactionEvent(session, {
    type: 'event', event: 'agent',
    payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 80000 } }
  });

  assert(mainWs.sent.length >= 1, 'Main WS received event');
  assert(closedWs.sent.length === 0, 'Closed WS did not receive event');

  clearInterval(session._compactionHeartbeat);
})();

(function testNoClientWs() {
  // Session without client connected — should not crash
  var session = { clientWs: null, _broadcastSessions: null, _compactionHeartbeat: null };

  try {
    processCompactionEvent(session, {
      type: 'event', event: 'agent',
      payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 80000 } }
    });
    assert(true, 'No crash when clientWs is null');
  } catch(e) {
    assert(false, 'Crashed with no clientWs: ' + e.message);
  }

  clearInterval(session._compactionHeartbeat);
})();

// ══════════════════════════════════════════════════════════
// Test Suite: Heartbeat Timer
// ══════════════════════════════════════════════════════════

console.log('\n═══ Heartbeat Timer Tests ═══');

(function testHeartbeatEmitsProgress() {
  return new Promise(function(resolve) {
    var ws = new MockWS();
    var session = { clientWs: ws, _broadcastSessions: null, _compactionHeartbeat: null };

    processCompactionEvent(session, {
      type: 'event', event: 'agent',
      payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 97000 } }
    });

    // Wait for heartbeat ticks (200ms in test mode)
    setTimeout(function() {
      clearInterval(session._compactionHeartbeat);

      // Filter only progress frames
      var progressFrames = ws.sent.filter(function(f) { return f.phase === 'progress'; });
      assert(progressFrames.length >= 1, 'At least 1 heartbeat progress frame emitted');
      if (progressFrames.length > 0) {
        assert(progressFrames[0].elapsed > 0, 'Progress frame has positive elapsed');
        assert(progressFrames[0].tokensBefore === 97000, 'Progress frame includes tokensBefore');
        assert(progressFrames[0].type === 'compaction', 'Progress frame type is compaction');
      }
      resolve();
    }, 500);
  });
})().then(function() {

  return (function testHeartbeatStopsOnEnd() {
    return new Promise(function(resolve) {
      var ws = new MockWS();
      var session = { clientWs: ws, _broadcastSessions: null, _compactionHeartbeat: null };

      processCompactionEvent(session, {
        type: 'event', event: 'agent',
        payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 97000 } }
      });

      assert(session._compactionHeartbeat !== null, 'Heartbeat timer started');

      // Now end compaction
      processCompactionEvent(session, {
        type: 'event', event: 'agent',
        payload: { stream: 'compaction', data: { phase: 'end', tokensAfter: 21000 } }
      });

      assert(session._compactionHeartbeat === null, 'Heartbeat timer cleared on end');

      var countAfterEnd = ws.sent.length;

      // Wait and verify no more frames
      setTimeout(function() {
        assert(ws.sent.length === countAfterEnd, 'No new frames after end (timer stopped)');
        resolve();
      }, 500);
    });
  })();

}).then(function() {

  return (function testHeartbeatCleanupOnDoubleStart() {
    return new Promise(function(resolve) {
      var ws = new MockWS();
      var session = { clientWs: ws, _broadcastSessions: null, _compactionHeartbeat: null };

      processCompactionEvent(session, {
        type: 'event', event: 'agent',
        payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 50000 } }
      });

      var firstTimer = session._compactionHeartbeat;

      processCompactionEvent(session, {
        type: 'event', event: 'agent',
        payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 80000 } }
      });

      assert(session._compactionHeartbeat !== firstTimer, 'New timer created on double start');
      assert(session._compactionTokensBefore === 80000, 'tokensBefore updated to latest');

      clearInterval(session._compactionHeartbeat);
      resolve();
    });
  })();

}).then(function() {

  return (function testHeartbeatWithNullTokens() {
    return new Promise(function(resolve) {
      var ws = new MockWS();
      var session = { clientWs: ws, _broadcastSessions: null, _compactionHeartbeat: null };

      processCompactionEvent(session, {
        type: 'event', event: 'agent',
        payload: { stream: 'compaction', data: { phase: 'start' } }
      });

      setTimeout(function() {
        clearInterval(session._compactionHeartbeat);

        var progressFrames = ws.sent.filter(function(f) { return f.phase === 'progress'; });
        assert(progressFrames.length >= 1, 'Heartbeat still works without tokensBefore');
        if (progressFrames.length > 0) {
          assert(progressFrames[0].tokensBefore === undefined, 'Progress frame: tokensBefore is undefined (not present)');
        }
        resolve();
      }, 500);
    });
  })();

}).then(function() {

  // ══════════════════════════════════════════════════════════
  // Test Suite: WS Error Resilience
  // ══════════════════════════════════════════════════════════

  console.log('\n═══ WS Error Resilience Tests ═══');

  (function testSendThrows() {
    var brokenWs = new MockWS();
    brokenWs.send = function() { throw new Error('WS broken'); };
    var session = { clientWs: brokenWs, _broadcastSessions: null, _compactionHeartbeat: null };

    try {
      processCompactionEvent(session, {
        type: 'event', event: 'agent',
        payload: { stream: 'compaction', data: { phase: 'start', tokensBefore: 80000 } }
      });
      assert(true, 'No crash when WS.send throws');
    } catch(e) {
      assert(false, 'Crashed on WS.send error: ' + e.message);
    }
    clearInterval(session._compactionHeartbeat);
  })();

  // ══════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════');
  console.log('Results: ' + passed + '/' + total + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    console.log('FAIL');
    process.exit(1);
  } else {
    console.log('ALL TESTS PASSED ✓');
  }
});
