'use strict';

const path = require('path');

// ── Test Harness ──
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertDeepIncludes(obj, subset, msg) {
  for (const [k, v] of Object.entries(subset)) {
    if (obj[k] !== v) throw new Error(msg || `Expected ${k}=${JSON.stringify(v)}, got ${JSON.stringify(obj[k])}`);
  }
}

// ── Load module ──
const { WidgetRegionManager } = require('../widget-region');

console.log('\n🧪 Widget Region Manager Tests\n');

// ── 1. Constructor loads manifest correctly ──
test('Constructor loads manifest with 8 widgets', () => {
  const mgr = new WidgetRegionManager();
  assert(mgr.widgets && Array.isArray(mgr.widgets), 'widgets should be an array');
  assertEqual(mgr.widgets.length, 8, 'Should have exactly 8 widgets');
});

// ── 2. getWidget('email') returns the email widget ──
test("getWidget('email') returns email widget", () => {
  const mgr = new WidgetRegionManager();
  const w = mgr.getWidget('email');
  assert(w !== null, 'email widget should exist');
  assertEqual(w.id, 'email');
  assertEqual(w.name, 'Email');
  assertEqual(w.icon, '📧');
});

// ── 3. getWidget('nonexistent') returns null ──
test("getWidget('nonexistent') returns null", () => {
  const mgr = new WidgetRegionManager();
  const w = mgr.getWidget('nonexistent');
  assertEqual(w, null);
});

// ── 4. getWidgetByPrefix('sn-list') returns Standard Notes ──
test("getWidgetByPrefix('sn-list') returns Standard Notes", () => {
  const mgr = new WidgetRegionManager();
  const w = mgr.getWidgetByPrefix('sn-list');
  assert(w !== null, 'Should find Standard Notes');
  assertEqual(w.id, 'standard-notes');
  assertEqual(w.name, 'Standard Notes');
});

// ── 5. getWidgetByPrefix('cal-month') returns Calendar ──
test("getWidgetByPrefix('cal-month') returns Calendar", () => {
  const mgr = new WidgetRegionManager();
  const w = mgr.getWidgetByPrefix('cal-month');
  assert(w !== null, 'Should find Calendar');
  assertEqual(w.id, 'calendar');
});

// ── 6. getWidgetByPrefix('unknown-action') returns null ──
test("getWidgetByPrefix('unknown-action') returns null", () => {
  const mgr = new WidgetRegionManager();
  const w = mgr.getWidgetByPrefix('unknown-action');
  assertEqual(w, null);
});

// ── 7. matchIntent('show me my notes') → Standard Notes with high confidence ──
test("matchIntent('show me my notes') → Standard Notes high confidence", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent('show me my notes');
  assert(r.widget !== null, 'Should match a widget');
  assertEqual(r.widget.id, 'standard-notes');
  assert(r.confidence > 0.5, `Confidence ${r.confidence} should be > 0.5`);
});

// ── 8. matchIntent('check my emails') → Email with high confidence ──
test("matchIntent('check my emails') → Email high confidence", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent('check my emails');
  assert(r.widget !== null, 'Should match a widget');
  assertEqual(r.widget.id, 'email');
  assert(r.confidence > 0.5, `Confidence ${r.confidence} should be > 0.5`);
});

// ── 9. matchIntent("what's on my calendar this week") → Calendar (multi-word boost) ──
test("matchIntent('what\\'s on my calendar this week') → Calendar", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent("what's on my calendar this week");
  assert(r.widget !== null, 'Should match a widget');
  assertEqual(r.widget.id, 'calendar');
  // Multi-word phrases "what's on" and "this week" should push score higher
  assert(r.score > 1, `Score ${r.score} should be > 1 (multi-word match boost)`);
});

// ── 10. matchIntent('play some music') → Spotify ──
test("matchIntent('play some music') → Spotify", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent('play some music');
  assert(r.widget !== null, 'Should match a widget');
  assertEqual(r.widget.id, 'spotify');
});

// ── 11. matchIntent('search youtube for cats') → YouTube ──
test("matchIntent('search youtube for cats') → YouTube", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent('search youtube for cats');
  assert(r.widget !== null, 'Should match a widget');
  assertEqual(r.widget.id, 'youtube');
});

// ── 12. matchIntent('random unrelated text') → null (no match) ──
test("matchIntent('random unrelated text') → null", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent('random unrelated text');
  assertEqual(r.widget, null);
  assertEqual(r.confidence, 0);
});

// ── 13. matchIntent('') → null (empty input) ──
test("matchIntent('') → null (empty input)", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent('');
  assertEqual(r.widget, null);
  assertEqual(r.confidence, 0);
});

// ── 14. matchIntent('messages') → disambiguate or reasonable fallback ──
test("matchIntent('messages') → match with disambiguation or fallback", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent('messages');
  // 'messages' doesn't directly match any trigger phrase strongly
  // but 'message from' in email triggers partial match on 'message'
  // Either it matches something or returns null—either is acceptable
  if (r.widget !== null) {
    // If it matches, check disambiguation is set when confidence is low
    assert(typeof r.confidence === 'number', 'Should have a confidence score');
    assert(typeof r.needsDisambiguation === 'boolean', 'Should have disambiguation flag');
  } else {
    assertEqual(r.confidence, 0, 'No match means confidence 0');
  }
});

// ── 15. validateOps (match) ──
test("validateOps: matching ops and intent → valid", () => {
  const mgr = new WidgetRegionManager();
  const result = mgr.validateOps(
    [{ id: 'sn-1', op: 'upsert' }],
    ['show me my notes']
  );
  assertEqual(result.valid, true);
  assertEqual(result.reason, 'match');
});

// ── 16. validateOps (mismatch) ──
test("validateOps: mail ops but notes intent → invalid mismatch", () => {
  const mgr = new WidgetRegionManager();
  const result = mgr.validateOps(
    [{ id: 'mail-1', op: 'upsert' }],
    ['show me my notes']
  );
  assertEqual(result.valid, false);
  assertEqual(result.reason, 'mismatch');
  assertEqual(result.intended.id, 'standard-notes');
  assertEqual(result.attempted.id, 'email');
  assert(result.suggestedAction === 'sn-list', `Expected suggestedAction 'sn-list', got '${result.suggestedAction}'`);
});

// ── 17. validateOps (ad-hoc, no known widget) ──
test("validateOps: ad-hoc component → valid", () => {
  const mgr = new WidgetRegionManager();
  const result = mgr.validateOps(
    [{ id: 'custom-chart', op: 'upsert' }],
    ['make a chart']
  );
  assertEqual(result.valid, true);
  assertEqual(result.reason, 'ad-hoc');
});

// ── 18. getSkeletonConfig('email') ──
test("getSkeletonConfig('email') → correct skeleton", () => {
  const mgr = new WidgetRegionManager();
  const skel = mgr.getSkeletonConfig('email');
  assertEqual(skel.type, 'email');
  assertEqual(skel.icon, '📧');
  assertEqual(skel.title, 'Email');
});

// ── 19. getSkeletonConfig('nonexistent') → default skeleton ──
test("getSkeletonConfig('nonexistent') → default skeleton", () => {
  const mgr = new WidgetRegionManager();
  const skel = mgr.getSkeletonConfig('nonexistent');
  assertEqual(skel.type, 'default');
  assertEqual(skel.icon, '📦');
  assertEqual(skel.title, 'Loading...');
});

// ── 20. listWidgets returns all 8 widgets with correct shape ──
test('listWidgets() returns 8 widgets with correct shape', () => {
  const mgr = new WidgetRegionManager();
  const list = mgr.listWidgets();
  assertEqual(list.length, 8);
  for (const w of list) {
    assert(typeof w.id === 'string', `Widget id should be string, got ${typeof w.id}`);
    assert(typeof w.name === 'string', `Widget name should be string, got ${typeof w.name}`);
    assert(typeof w.icon === 'string', `Widget icon should be string, got ${typeof w.icon}`);
    assert(typeof w.prefix === 'string', `Widget prefix should be string, got ${typeof w.prefix}`);
    assert(Array.isArray(w.capabilities), 'capabilities should be an array');
    assert(typeof w.requiresAuth === 'string', `requiresAuth should be string`);
    // Ensure internal fields are NOT leaked
    assert(w.triggerPhrases === undefined, 'triggerPhrases should not be in listWidgets output');
    assert(w.antiPhrases === undefined, 'antiPhrases should not be in listWidgets output');
  }
});

// ── 21. Anti-phrases: 'play a video' should NOT match Spotify ──
test("Anti-phrase: matchIntent('play a video') does NOT match Spotify", () => {
  const mgr = new WidgetRegionManager();
  const r = mgr.matchIntent('play a video');
  // 'video' is an anti-phrase for Spotify, and a trigger for YouTube
  if (r.widget !== null) {
    assert(r.widget.id !== 'spotify', `Should NOT match Spotify, got ${r.widget.id}`);
    // Should prefer YouTube since 'video' is a YouTube trigger
    assertEqual(r.widget.id, 'youtube');
  }
  // null is also acceptable (if antiPhrase fully suppresses both)
});

// ── 22. Priority boost: high priority widgets score slightly higher ──
test('Priority boost: high priority widgets get +0.5 score boost', () => {
  const mgr = new WidgetRegionManager();
  // Both 'notes' and email could match something generic
  // But high-priority widgets get +0.5 boost
  // Test: Standard Notes (high) vs Admin (low) — if both match "dashboard"
  // Actually test directly: ensure high priority widget gets the boost
  const r1 = mgr.matchIntent('notes');
  assert(r1.widget !== null, 'Should match');
  assertEqual(r1.widget.id, 'standard-notes');
  // Standard Notes is high priority → score should include +0.5 boost
  // 'notes' matches trigger phrase 'notes' (1 word = 1) + 0.5 priority = 1.5
  assert(r1.score >= 1.5, `High priority widget score should be >= 1.5, got ${r1.score}`);

  // Compare with a low priority widget
  const r2 = mgr.matchIntent('deploy');
  assert(r2.widget !== null, 'Should match');
  assertEqual(r2.widget.id, 'deploy');
  // Deploy is low priority → score should be just 1 (no boost)
  assertEqual(r2.score, 1);
});

// ── Bonus: reload() reloads manifest ──
test('reload() reloads the manifest', () => {
  const mgr = new WidgetRegionManager();
  assertEqual(mgr.widgets.length, 8);
  mgr.reload();
  assertEqual(mgr.widgets.length, 8, 'Should still have 8 widgets after reload');
});

// ── Bonus: getWidgetByPrefix(null/undefined) returns null ──
test("getWidgetByPrefix(null) returns null", () => {
  const mgr = new WidgetRegionManager();
  assertEqual(mgr.getWidgetByPrefix(null), null);
  assertEqual(mgr.getWidgetByPrefix(undefined), null);
  assertEqual(mgr.getWidgetByPrefix(''), null);
});

// ── Bonus: validateOps with no clear intent → valid (no-clear-intent) ──
test("validateOps: no clear intent in messages → valid", () => {
  const mgr = new WidgetRegionManager();
  const result = mgr.validateOps(
    [{ id: 'mail-1', op: 'upsert' }],
    ['hello there', 'how are you']
  );
  assertEqual(result.valid, true);
  assertEqual(result.reason, 'no-clear-intent');
});

// ── Summary ──
console.log(`\n📊 Widget Region: ${passed} passed, ${failed} failed (${passed + failed} total)\n`);
process.exit(failed > 0 ? 1 : 0);
