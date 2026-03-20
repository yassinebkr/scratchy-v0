#!/usr/bin/env node
/**
 * Unit tests for Phase 3 compaction streaming progress (real pct from gateway).
 * Tests _compactionRealPct override, progress frame handling, and reset behavior.
 * Run: node test-compaction-phase3.js
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

// ── Extract the progress logic from app.js ──
// Mirrors the real implementation

var _compactionRealPct = null;
var _compactionStartTime = null;
var _compactionTokensBefore = null;

function compactionProgress(elapsedMs, tokensBefore, contextEstTokens) {
  // Prefer real streaming progress from gateway when available
  if (_compactionRealPct != null) return Math.min(95, _compactionRealPct);
  if (elapsedMs <= 0) return 0;
  var elapsed = elapsedMs / 1000;
  var tokens = tokensBefore || contextEstTokens || 100000;
  var tau = Math.max(3, Math.min(20, 2 + (tokens / 20000)));
  return Math.min(95, Math.round(100 * (1 - Math.exp(-elapsed / tau))));
}

function resetState() {
  _compactionRealPct = null;
  _compactionStartTime = null;
  _compactionTokensBefore = null;
}

// ══════════════════════════════════════════════════════════
// Test Suite: Real Progress Override
// ══════════════════════════════════════════════════════════

console.log('\n═══ Real Progress Override Tests ═══');

resetState();
_compactionRealPct = 42;
assert(compactionProgress(6000, 80000, 100000) === 42, 'Real pct (42) overrides estimation');

_compactionRealPct = 0;
assert(compactionProgress(6000, 80000, 100000) === 0, 'Real pct (0) overrides estimation — zero is valid');

_compactionRealPct = 95;
assert(compactionProgress(6000, 80000, 100000) === 95, 'Real pct (95) is capped at 95');

_compactionRealPct = 100;
assert(compactionProgress(6000, 80000, 100000) === 95, 'Real pct (100) capped to 95');

_compactionRealPct = 150;
assert(compactionProgress(6000, 80000, 100000) === 95, 'Real pct (150) capped to 95');

resetState();
_compactionRealPct = null;
var estimatedPct = compactionProgress(6000, 80000, 100000);
assert(estimatedPct > 0 && estimatedPct !== 42, 'Null realPct falls back to estimation (' + estimatedPct + '%)');

// ══════════════════════════════════════════════════════════
// Test Suite: Progress Frame Handling
// ══════════════════════════════════════════════════════════

console.log('\n═══ Progress Frame Handling Tests ═══');

// Simulate gateway progress frame with real pct
function handleProgressFrame(frame) {
  if (frame.phase === 'progress' && frame.pct != null) {
    _compactionRealPct = frame.pct;
    return true;
  }
  return false;
}

resetState();
var handled = handleProgressFrame({ phase: 'progress', pct: 35, tokensGenerated: 500, estimatedTotal: 2000 });
assert(handled, 'Progress frame with pct is handled');
assert(_compactionRealPct === 35, 'realPct set to 35 from gateway');
assert(compactionProgress(6000, 80000) === 35, 'Progress returns real 35% instead of estimate');

// Successive progress frames update pct
handleProgressFrame({ phase: 'progress', pct: 55 });
assert(_compactionRealPct === 55, 'realPct updated to 55');
assert(compactionProgress(6000, 80000) === 55, 'Progress returns real 55%');

handleProgressFrame({ phase: 'progress', pct: 80 });
assert(_compactionRealPct === 80, 'realPct updated to 80');
assert(compactionProgress(6000, 80000) === 80, 'Progress returns real 80%');

// Heartbeat progress frame (no pct) should NOT override realPct
resetState();
_compactionRealPct = 45;
var heartbeatHandled = handleProgressFrame({ phase: 'progress', elapsed: 4000 });
assert(!heartbeatHandled, 'Heartbeat without pct is NOT handled as real progress');
assert(_compactionRealPct === 45, 'realPct unchanged by heartbeat');

// ══════════════════════════════════════════════════════════
// Test Suite: Reset Behavior
// ══════════════════════════════════════════════════════════

console.log('\n═══ Reset Behavior Tests ═══');

// showCompactionIndicator should reset realPct
function showCompactionIndicator() {
  _compactionRealPct = null;
  _compactionStartTime = Date.now();
}

function hideCompactionIndicator() {
  _compactionRealPct = null;
  _compactionStartTime = null;
}

_compactionRealPct = 60;
showCompactionIndicator();
assert(_compactionRealPct === null, 'showCompactionIndicator resets realPct');

_compactionRealPct = 80;
hideCompactionIndicator();
assert(_compactionRealPct === null, 'hideCompactionIndicator resets realPct');

// ══════════════════════════════════════════════════════════
// Test Suite: Serve.js Real Progress Forwarding
// ══════════════════════════════════════════════════════════

console.log('\n═══ Serve.js Progress Forwarding Tests ═══');

function MockWS() {
  this.readyState = 1;
  this.sent = [];
  this.send = function(data) { this.sent.push(JSON.parse(data)); };
}

function processRealProgressEvent(session, data) {
  // Mirrors the logic in serve.js for real progress events
  if (data.phase === 'progress' && data.pct != null) {
    var frame = {
      type: 'compaction', phase: 'progress',
      pct: data.pct,
      tokensGenerated: data.tokensGenerated,
      estimatedTotal: data.estimatedTotal,
      ts: Date.now()
    };
    var json = JSON.stringify(frame);
    if (session.clientWs && session.clientWs.readyState === 1) {
      try { session.clientWs.send(json); } catch(e) {}
    }
    return true;
  }
  return false;
}

var ws = new MockWS();
var sess = { clientWs: ws };
var forwarded = processRealProgressEvent(sess, { phase: 'progress', pct: 42, tokensGenerated: 800, estimatedTotal: 2000 });
assert(forwarded, 'Real progress event forwarded');
assert(ws.sent.length === 1, 'One frame sent');
assert(ws.sent[0].pct === 42, 'pct forwarded correctly');
assert(ws.sent[0].tokensGenerated === 800, 'tokensGenerated forwarded');
assert(ws.sent[0].estimatedTotal === 2000, 'estimatedTotal forwarded');
assert(ws.sent[0].type === 'compaction', 'Frame type is compaction');

// Non-streaming progress (heartbeat) should not be caught by this handler
ws = new MockWS();
sess = { clientWs: ws };
forwarded = processRealProgressEvent(sess, { phase: 'progress', elapsed: 4000 });
assert(!forwarded, 'Heartbeat progress not caught by real progress handler');
assert(ws.sent.length === 0, 'No frame sent for heartbeat');

// ══════════════════════════════════════════════════════════
// Test Suite: Mixed Real + Heartbeat Progress
// ══════════════════════════════════════════════════════════

console.log('\n═══ Mixed Progress Tests ═══');

resetState();
// Initially no real progress — estimation used
assert(compactionProgress(3000, 80000) > 0, 'Before real progress: estimation works');
var estBefore = compactionProgress(3000, 80000);

// Real progress arrives — overrides
handleProgressFrame({ phase: 'progress', pct: 25 });
assert(compactionProgress(3000, 80000) === 25, 'After real progress: real pct used');

// More real progress
handleProgressFrame({ phase: 'progress', pct: 50 });
assert(compactionProgress(3000, 80000) === 50, 'Updated real progress used');

// Reset (compaction ends) — back to estimation
resetState();
assert(compactionProgress(3000, 80000) > 0, 'After reset: estimation resumes');
assert(compactionProgress(3000, 80000) === estBefore, 'After reset: same estimation as before');

// ══════════════════════════════════════════════════════════
// Test Suite: Edge Cases
// ══════════════════════════════════════════════════════════

console.log('\n═══ Edge Cases ═══');

resetState();

// pct = 0 is a valid real progress
_compactionRealPct = 0;
assert(compactionProgress(60000, 80000) === 0, 'pct=0 overrides even when estimation would be high');

// Negative pct (shouldn't happen, but handle gracefully)
_compactionRealPct = -5;
assert(compactionProgress(6000, 80000) === -5 || compactionProgress(6000, 80000) === 0,
  'Negative pct: returns -5 (min(95, -5) = -5, acceptable edge case)');

// Large estimatedTotal in progress frame
resetState();
handleProgressFrame({ phase: 'progress', pct: 1, tokensGenerated: 10, estimatedTotal: 100000 });
assert(_compactionRealPct === 1, 'Very low pct (1%) accepted from large compaction');

// Rapid successive frames
resetState();
for (var i = 0; i < 100; i++) {
  handleProgressFrame({ phase: 'progress', pct: i });
}
assert(_compactionRealPct === 99, 'After 100 rapid frames, pct = 99');
assert(compactionProgress(1000, 80000) === 95, 'pct 99 capped to 95');

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
