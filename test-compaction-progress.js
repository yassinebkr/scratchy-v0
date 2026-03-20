#!/usr/bin/env node
/**
 * Unit tests for compaction progress logic (client-side functions extracted for testing).
 * Tests Phase 1d (dynamic τ from real tokens) and Phase 2b (heartbeat handling).
 * Run: node test-compaction-progress.js
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

function assertApprox(actual, expected, tolerance, message) {
  return assert(
    Math.abs(actual - expected) <= tolerance,
    message + ' (got ' + actual + ', expected ~' + expected + '±' + tolerance + ')'
  );
}

// ── Extract the progress function logic from app.js ──
// This mirrors the exact implementation in web/js/app.js

function compactionProgress(elapsedMs, tokensBefore, contextEstTokens) {
  if (elapsedMs <= 0) return 0;
  var elapsed = elapsedMs / 1000;
  var tokens = tokensBefore || contextEstTokens || 100000;
  var tau = Math.max(3, Math.min(20, 2 + (tokens / 20000)));
  return Math.min(95, Math.round(100 * (1 - Math.exp(-elapsed / tau))));
}

function computeTau(tokens) {
  return Math.max(3, Math.min(20, 2 + ((tokens || 100000) / 20000)));
}

// ══════════════════════════════════════════════════════════
// Test Suite: Dynamic τ Calculation
// ══════════════════════════════════════════════════════════

console.log('\n═══ τ (tau) Calculation Tests ═══');

// computeTau(0) — 0 is falsy, falls through to 100k default → τ=7
assert(computeTau(0) === 7, 'τ = 7 for 0 tokens (0 is falsy, falls through to 100k default)');
assert(computeTau(20000) === 3, 'τ = 3 for 20k tokens (2 + 1 = 3)');
assert(computeTau(80000) === 6, 'τ = 6 for 80k tokens (2 + 4)');
assert(computeTau(100000) === 7, 'τ = 7 for 100k tokens (2 + 5)');
assertApprox(computeTau(150000), 9.5, 0.01, 'τ ≈ 9.5 for 150k tokens');
assert(computeTau(200000) === 12, 'τ = 12 for 200k tokens (2 + 10)');
assert(computeTau(360000) === 20, 'τ clamps to maximum 20 for 360k tokens');
assert(computeTau(500000) === 20, 'τ clamps to maximum 20 for 500k+ tokens');
assert(computeTau(null) === 7, 'τ fallback for null tokens uses 100k default');
assert(computeTau(undefined) === 7, 'τ fallback for undefined tokens uses 100k default');

// ══════════════════════════════════════════════════════════
// Test Suite: Progress Curve
// ══════════════════════════════════════════════════════════

console.log('\n═══ Progress Curve Tests ═══');

// At t=0, progress should be 0
assert(compactionProgress(0, 80000) === 0, 'Progress = 0 at t=0');

// Progress should never exceed 95%
assert(compactionProgress(600000, 80000) <= 95, 'Progress never exceeds 95% (t=600s, 80k)');
assert(compactionProgress(600000, 200000) <= 95, 'Progress never exceeds 95% (t=600s, 200k)');

// Small context (80k, τ=6) should progress faster than large (200k, τ=12)
var small6s = compactionProgress(6000, 80000);
var large6s = compactionProgress(6000, 200000);
assert(small6s > large6s, 'Small context progresses faster at 6s (' + small6s + '% vs ' + large6s + '%)');

// 80k tokens at 6s should be ~63% (τ=6, 1-e^(-1) ≈ 0.632)
assertApprox(compactionProgress(6000, 80000), 63, 2, '80k tokens at 6s ≈ 63%');

// 80k tokens at 8s should be ~74%
assertApprox(compactionProgress(8000, 80000), 74, 2, '80k tokens at 8s ≈ 74%');

// 150k tokens at 10s should be ~65% (τ=9.5, 1-e^(-10/9.5) ≈ 0.652)
assertApprox(compactionProgress(10000, 150000), 65, 3, '150k tokens at 10s ≈ 65%');

// 200k tokens at 15s should be ~71% (τ=12, 1-e^(-15/12) ≈ 0.713)
assertApprox(compactionProgress(15000, 200000), 71, 3, '200k tokens at 15s ≈ 71%');

// Progress should be monotonically increasing
var prev = 0;
var monotonic = true;
for (var t = 0; t <= 120000; t += 1000) {
  var p = compactionProgress(t, 100000);
  if (p < prev) { monotonic = false; break; }
  prev = p;
}
assert(monotonic, 'Progress is monotonically increasing over 120s');

// ══════════════════════════════════════════════════════════
// Test Suite: Server tokens vs Client estimate priority
// ══════════════════════════════════════════════════════════

console.log('\n═══ Token Source Priority Tests ═══');

// Server tokens should take priority
var withServer = compactionProgress(6000, 80000, 200000);
var withoutServer = compactionProgress(6000, null, 200000);
var withFallback = compactionProgress(6000, null, null);
assert(withServer !== withoutServer, 'Server tokens produce different progress than client estimate');
assert(withServer === compactionProgress(6000, 80000, null), 'Server tokens same regardless of client estimate');
assertApprox(withServer, 63, 2, 'Server 80k tokens → ~63% at 6s');
assertApprox(withoutServer, 39, 3, 'Client 200k tokens → ~39% at 6s');

// Fallback to 100k default
assertApprox(withFallback, compactionProgress(6000, null, 100000), 0, 'Null tokens falls back to 100k');

// ══════════════════════════════════════════════════════════
// Test Suite: Edge Cases
// ══════════════════════════════════════════════════════════

console.log('\n═══ Edge Case Tests ═══');

// Negative elapsed (shouldn't happen, but guard)
assert(compactionProgress(-1000, 80000) === 0, 'Negative elapsed returns 0');

// Very small token count
assert(compactionProgress(3000, 1) > 0, 'Very small token count still produces progress');
assertApprox(computeTau(1), 3, 0.01, 'τ = 3 for 1 token (minimum clamp)');

// Very large token count
assert(compactionProgress(1000, 10000000) > 0, 'Very large token count still produces progress');
assertApprox(computeTau(10000000), 20, 0.01, 'τ = 20 for 10M tokens (maximum clamp)');

// Zero tokens (edge) — 0 is falsy, uses 100k default
var zeroTau = computeTau(0);
assert(zeroTau === 7, 'τ = 7 for 0 tokens (falsy → 100k default)');

// NaN handling — in real code, `_compactionStartTime` null check prevents NaN from reaching Math
// But if it somehow does, the progress is NaN (not a crash, just invalid display)
// The real guard is the null check before _compactionProgress() is called
var nanProgress = compactionProgress(NaN, 80000);
// NaN propagates through Math.exp — this is expected
// The real code guards this with `if (!_compactionStartTime) return 0`
assert(isNaN(nanProgress) || nanProgress === 0, 'NaN elapsed: NaN or 0 (guarded in real code)');

// ══════════════════════════════════════════════════════════
// Test Suite: Heartbeat Frame Parsing
// ══════════════════════════════════════════════════════════

console.log('\n═══ Heartbeat Frame Tests ═══');

// Simulate compaction frames from serve.js
function parseCompactFrame(json) {
  try { return JSON.parse(json); } catch(e) { return null; }
}

// Start frame with enriched data
var startFrame = JSON.stringify({
  type: 'compaction', phase: 'start', ts: Date.now(),
  tokensBefore: 97000, contextWindow: 200000
});
var parsed = parseCompactFrame(startFrame);
assert(parsed.type === 'compaction', 'Start frame has type=compaction');
assert(parsed.phase === 'start', 'Start frame has phase=start');
assert(parsed.tokensBefore === 97000, 'Start frame includes tokensBefore');
assert(parsed.contextWindow === 200000, 'Start frame includes contextWindow');

// Progress heartbeat frame
var progressFrame = JSON.stringify({
  type: 'compaction', phase: 'progress',
  elapsed: 4000, tokensBefore: 97000, ts: Date.now()
});
parsed = parseCompactFrame(progressFrame);
assert(parsed.phase === 'progress', 'Progress frame has phase=progress');
assert(parsed.elapsed === 4000, 'Progress frame includes elapsed');
assert(parsed.tokensBefore === 97000, 'Progress frame includes tokensBefore');

// End frame with enriched data
var endFrame = JSON.stringify({
  type: 'compaction', phase: 'end', ts: Date.now(),
  tokensBefore: 97000, tokensAfter: 21000, contextWindow: 200000
});
parsed = parseCompactFrame(endFrame);
assert(parsed.phase === 'end', 'End frame has phase=end');
assert(parsed.tokensBefore === 97000, 'End frame includes tokensBefore');
assert(parsed.tokensAfter === 21000, 'End frame includes tokensAfter');

// Frame without enriched data (backward compat — old gateway)
var legacyFrame = JSON.stringify({ type: 'compaction', phase: 'start', ts: Date.now() });
parsed = parseCompactFrame(legacyFrame);
assert(parsed.tokensBefore === undefined, 'Legacy frame: tokensBefore is undefined');
assert(parsed.contextWindow === undefined, 'Legacy frame: contextWindow is undefined');

// ══════════════════════════════════════════════════════════
// Test Suite: Serve.js Heartbeat Timer Logic
// ══════════════════════════════════════════════════════════

console.log('\n═══ Serve.js Heartbeat Timer Tests ═══');

// Simulate the serve.js session state management
function SimSession() {
  this._compactionHeartbeat = null;
  this._compactionStartTs = null;
  this._compactionTokensBefore = null;
}

function handleCompactionEvent(session, phase, tokensBefore, tokensAfter) {
  if (phase === 'start') {
    if (session._compactionHeartbeat) {
      clearInterval(session._compactionHeartbeat);
    }
    session._compactionStartTs = Date.now();
    session._compactionTokensBefore = tokensBefore || null;
    session._compactionHeartbeat = setInterval(function() {}, 2000);
  } else if (phase === 'end') {
    if (session._compactionHeartbeat) {
      clearInterval(session._compactionHeartbeat);
      session._compactionHeartbeat = null;
    }
    session._compactionStartTs = null;
    session._compactionTokensBefore = null;
  }
}

var sess = new SimSession();

// Start should set up timer
handleCompactionEvent(sess, 'start', 97000);
assert(sess._compactionHeartbeat !== null, 'Start sets up heartbeat timer');
assert(sess._compactionStartTs !== null, 'Start sets compaction start time');
assert(sess._compactionTokensBefore === 97000, 'Start stores tokensBefore');

// End should clear timer
handleCompactionEvent(sess, 'end');
assert(sess._compactionHeartbeat === null, 'End clears heartbeat timer');
assert(sess._compactionStartTs === null, 'End clears compaction start time');
assert(sess._compactionTokensBefore === null, 'End clears tokensBefore');

// Double start (second compaction before first ends) — should clean up old timer
handleCompactionEvent(sess, 'start', 50000);
var firstTimer = sess._compactionHeartbeat;
handleCompactionEvent(sess, 'start', 80000);
assert(sess._compactionHeartbeat !== firstTimer, 'Double start creates new timer');
assert(sess._compactionTokensBefore === 80000, 'Double start uses latest tokensBefore');
clearInterval(sess._compactionHeartbeat); // cleanup

// Start without tokensBefore
sess = new SimSession();
handleCompactionEvent(sess, 'start', null);
assert(sess._compactionTokensBefore === null, 'Start without tokensBefore stores null');
assert(sess._compactionHeartbeat !== null, 'Start without tokensBefore still sets timer');
clearInterval(sess._compactionHeartbeat);

// ══════════════════════════════════════════════════════════
// Test Suite: Context Meter Update on End
// ══════════════════════════════════════════════════════════

console.log('\n═══ Context Meter Update Tests ═══');

function computePostCompactionPct(tokensAfter, contextWindow) {
  if (!tokensAfter || !contextWindow) return null;
  return Math.round((tokensAfter / contextWindow) * 100);
}

assert(computePostCompactionPct(21000, 200000) === 11, 'Post-compaction pct: 21k/200k = 11%');
assert(computePostCompactionPct(21000, 150000) === 14, 'Post-compaction pct: 21k/150k = 14%');
assert(computePostCompactionPct(50000, 200000) === 25, 'Post-compaction pct: 50k/200k = 25%');
assert(computePostCompactionPct(null, 200000) === null, 'Post-compaction pct: null tokensAfter → null');
assert(computePostCompactionPct(21000, null) === null, 'Post-compaction pct: null contextWindow → null');

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
