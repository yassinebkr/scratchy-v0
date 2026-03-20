'use strict';

const fs = require('fs');
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

// ── Setup / Cleanup ──
const MEMORY_DIR = path.join(__dirname, '..', '..', '.scratchy-data', 'memory');
const TEST_USER_A = '__test_user_a__';
const TEST_USER_B = '__test_user_b__';
const TEST_USER_C = '__test_user_c__';
const TEST_USERS = [TEST_USER_A, TEST_USER_B, TEST_USER_C];

function cleanupTestUsers() {
  for (const u of TEST_USERS) {
    const fp = path.join(MEMORY_DIR, `${u}.json`);
    try { fs.unlinkSync(fp); } catch {}
  }
}

// Clean before run
cleanupTestUsers();

// ── Load module ──
const { MemoryStore } = require('../memory-store');

console.log('\n🧪 Memory Store Tests\n');

// ── 1. Add a fact memory → returned with id, timestamps, default relevance ──
test('Add a fact memory → has id, timestamps, relevance=1.0', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const entry = store.add(TEST_USER_A, { content: 'User likes dark mode', type: 'fact' });
  assert(typeof entry.id === 'string' && entry.id.length > 0, 'Should have an id');
  assert(typeof entry.createdAt === 'string', 'Should have createdAt');
  assert(typeof entry.updatedAt === 'string', 'Should have updatedAt');
  assertEqual(entry.relevance, 1.0);
  assertEqual(entry.type, 'fact');
  assertEqual(entry.content, 'User likes dark mode');
});

// ── 2. Add multiple → getAll returns them all ──
test('Add multiple memories → getAll returns them all', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'Fact one about apples', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Prefers vim over emacs', type: 'preference' });
  store.add(TEST_USER_A, { content: 'Deployed v2.0 yesterday', type: 'episode' });
  const all = store.getAll(TEST_USER_A);
  assertEqual(all.length, 3);
});

// ── 3. getByType filters correctly ──
test('getByType filters by type', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'Unique fact about zebras', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Likes TypeScript', type: 'preference' });
  store.add(TEST_USER_A, { content: 'Another fact about lions', type: 'fact' });
  const facts = store.getByType(TEST_USER_A, 'fact');
  assertEqual(facts.length, 2);
  for (const f of facts) assertEqual(f.type, 'fact');
  const prefs = store.getByType(TEST_USER_A, 'preference');
  assertEqual(prefs.length, 1);
  assertEqual(prefs[0].content, 'Likes TypeScript');
});

// ── 4. Search by keyword finds matching memories ──
test('Search by keyword finds matching memories', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'User enjoys mountain biking on weekends', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Prefers dark chocolate over milk', type: 'preference' });
  store.add(TEST_USER_A, { content: 'Went mountain climbing last summer', type: 'episode' });
  const results = store.search(TEST_USER_A, 'mountain');
  assert(results.length >= 2, `Expected at least 2 results for "mountain", got ${results.length}`);
});

// ── 5. Search returns empty for no matches (on old memories w/o recency boost) ──
test('Search returns empty array for no keyword matches on old memories', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const entry = store.add(TEST_USER_A, { content: 'Something about apples', type: 'fact' });

  // Backdate the memory beyond 7-day recency window so the +0.5 boost doesn't apply
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  store._cache.get(TEST_USER_A).memories[0].updatedAt = oldDate;
  store._save(TEST_USER_A);
  store._cache.delete(TEST_USER_A);

  const results = store.search(TEST_USER_A, 'xylophone');
  assertEqual(results.length, 0);
});

// ── 6. Search with empty query returns memories (up to limit) ──
test('Search with empty query returns memories up to limit', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'Memory alpha bravo', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Memory charlie delta', type: 'fact' });
  // Empty query has no words > 2 chars, so returns slice(0, limit)
  const results = store.search(TEST_USER_A, '', { limit: 5 });
  assertEqual(results.length, 2);
});

// ── 7. Update a memory's content ──
test('Update content → reflected in getAll', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const entry = store.add(TEST_USER_A, { content: 'Original content here', type: 'fact' });
  store.update(TEST_USER_A, entry.id, { content: 'Updated content here' });
  const all = store.getAll(TEST_USER_A);
  const updated = all.find(m => m.id === entry.id);
  assertEqual(updated.content, 'Updated content here');
});

// ── 8. Update tags → merges correctly ──
test('Update tags → replaced correctly', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const entry = store.add(TEST_USER_A, { content: 'Tagged memory', type: 'fact', tags: ['alpha'] });
  store.update(TEST_USER_A, entry.id, { tags: ['alpha', 'beta', 'gamma'] });
  const updated = store.getAll(TEST_USER_A).find(m => m.id === entry.id);
  assertEqual(updated.tags.length, 3);
  assert(updated.tags.includes('beta'), 'Should include beta tag');
  assert(updated.tags.includes('gamma'), 'Should include gamma tag');
});

// ── 9. Delete a memory ──
test('Delete a memory → no longer in getAll', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const e1 = store.add(TEST_USER_A, { content: 'Will be deleted soon', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Will survive deletion', type: 'fact' });
  const result = store.delete(TEST_USER_A, e1.id);
  assertEqual(result, true);
  const all = store.getAll(TEST_USER_A);
  assertEqual(all.length, 1);
  assertEqual(all[0].content, 'Will survive deletion');
});

// ── 10. Delete nonexistent → returns false ──
test('Delete nonexistent memory → returns false', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const result = store.delete(TEST_USER_A, 'nonexistent-id-12345');
  assertEqual(result, false);
});

// ── 11. Dedup: similar content updates existing ──
test('Dedup: similar content updates existing instead of creating new', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'User prefers dark mode in applications', type: 'preference' });
  store.add(TEST_USER_A, { content: 'User prefers dark mode in their applications', type: 'preference' });
  const all = store.getAll(TEST_USER_A);
  assertEqual(all.length, 1, `Dedup should merge similar content, got ${all.length} entries`);
  // Relevance should have been bumped
  assert(all[0].relevance > 1.0, `Relevance should be > 1.0 after dedup, got ${all[0].relevance}`);
});

// ── 12. Dedup: different content creates new entry ──
test('Dedup: different content creates new entry', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'User lives in Berlin Germany', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Favorite programming language is Rust', type: 'fact' });
  const all = store.getAll(TEST_USER_A);
  assertEqual(all.length, 2);
});

// ── 13. getCompactionContext formats sections by type ──
test('getCompactionContext formats sections by type', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'Prefers vim keybindings everywhere', type: 'preference' });
  store.add(TEST_USER_A, { content: 'Lives in Munich Germany currently', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Decided to use PostgreSQL database', type: 'decision' });
  const ctx = store.getCompactionContext(TEST_USER_A);
  assert(ctx.includes('### Preferences'), 'Should have Preferences section');
  assert(ctx.includes('### Known Facts'), 'Should have Known Facts section');
  assert(ctx.includes('### Past Decisions'), 'Should have Past Decisions section');
  assert(ctx.includes('vim keybindings'), 'Should contain preference content');
  assert(ctx.includes('Munich'), 'Should contain fact content');
});

// ── 14. getCompactionContext respects maxTokens limit ──
test('getCompactionContext respects maxTokens limit', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  // Add many memories
  for (let i = 0; i < 50; i++) {
    store.add(TEST_USER_A, { content: `Memory entry number ${i} with some padding text to make it longer and consume more tokens in output`, type: 'fact' });
  }
  const ctx = store.getCompactionContext(TEST_USER_A, { maxTokens: 100 });
  // 100 tokens ≈ 400 chars; context should not exceed this significantly
  assert(ctx.length <= 500, `Context length ${ctx.length} should be roughly within maxTokens*4 chars (400)`);
});

// ── 15. getCompactionContext with no memories → empty string ──
test('getCompactionContext with no memories → empty string', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const ctx = store.getCompactionContext(TEST_USER_A);
  assertEqual(ctx, '');
});

// ── 16. decayRelevance reduces old memory relevance ──
test('decayRelevance reduces old memory relevance', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const entry = store.add(TEST_USER_A, { content: 'Old memory that should decay', type: 'fact' });

  // Manually backdate the updatedAt to 14 days ago
  const memories = store.getAll(TEST_USER_A);
  const m = memories.find(x => x.id === entry.id);
  const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  // Need to access internal cache to backdate
  store._cache.get(TEST_USER_A).memories[0].updatedAt = oldDate;
  store._save(TEST_USER_A);

  // Force cache invalidation by clearing cache
  store._cache.delete(TEST_USER_A);

  const originalRelevance = store.getAll(TEST_USER_A)[0].relevance;
  const changed = store.decayRelevance(TEST_USER_A);
  assertEqual(changed, true);

  // Force reload
  store._cache.delete(TEST_USER_A);
  const decayed = store.getAll(TEST_USER_A)[0];
  assert(decayed.relevance < originalRelevance, `Relevance should have decreased from ${originalRelevance}, got ${decayed.relevance}`);
});

// ── 17. stats returns correct counts by type ──
test('stats returns correct counts by type', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'Fact alpha unique content', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Fact beta different content', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Preference gamma distinct', type: 'preference' });
  store.add(TEST_USER_A, { content: 'Episode delta happened recently', type: 'episode' });
  const s = store.stats(TEST_USER_A);
  assertEqual(s.total, 4);
  assertEqual(s.byType.fact, 2);
  assertEqual(s.byType.preference, 1);
  assertEqual(s.byType.episode, 1);
  assert(typeof s.oldestDate === 'string', 'Should have oldestDate');
  assert(typeof s.newestDate === 'string', 'Should have newestDate');
});

// ── 18. Persistence: memories survive across new MemoryStore instances ──
test('Persistence: memories survive across instances', () => {
  cleanupTestUsers();
  const store1 = new MemoryStore();
  store1.add(TEST_USER_A, { content: 'Persisted memory across instances', type: 'fact' });

  // New instance — should load from disk
  const store2 = new MemoryStore();
  const all = store2.getAll(TEST_USER_A);
  assertEqual(all.length, 1);
  assertEqual(all[0].content, 'Persisted memory across instances');
});

// ── 19. Atomic write: file is valid JSON ──
test('Atomic write: file is valid JSON after save', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'Test atomic write correctness', type: 'fact' });

  // Read file directly and verify valid JSON
  const filePath = path.join(MEMORY_DIR, `${TEST_USER_A}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('File is not valid JSON: ' + e.message);
  }
  assert(Array.isArray(data.memories), 'Should have memories array');
  assertEqual(data.memories.length, 1);
  assertEqual(data.userId, TEST_USER_A);
  assertEqual(data.version, 1);
  // Ensure no .tmp file left behind
  const tmpFiles = fs.readdirSync(MEMORY_DIR).filter(f => f.includes('.tmp.'));
  assertEqual(tmpFiles.length, 0, 'No temporary files should remain');
});

// ── 20. Edge case: very long content strings ──
test('Edge case: very long content (1000+ chars)', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const longContent = 'A'.repeat(2000);
  const entry = store.add(TEST_USER_A, { content: longContent, type: 'fact' });
  assertEqual(entry.content.length, 2000);
  const all = store.getAll(TEST_USER_A);
  assertEqual(all[0].content.length, 2000);
});

// ── 21. Edge case: special characters ──
test('Edge case: special characters (quotes, newlines, unicode)', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const special = 'He said "hello" & she replied \'hi\'\nNew line here\tTab here\n🎉 Unicode: ü ö ä ñ 中文';
  const entry = store.add(TEST_USER_A, { content: special, type: 'fact' });
  assertEqual(entry.content, special);

  // Persistence check: reload and verify
  const store2 = new MemoryStore();
  const all = store2.getAll(TEST_USER_A);
  assertEqual(all[0].content, special);
});

// ── 22. Edge case: multiple users don't interfere ──
test('Multiple users are isolated from each other', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  store.add(TEST_USER_A, { content: 'Alpha user private memory', type: 'fact' });
  store.add(TEST_USER_A, { content: 'Alpha user second memory', type: 'preference' });
  store.add(TEST_USER_B, { content: 'Beta user private memory', type: 'fact' });

  const allA = store.getAll(TEST_USER_A);
  const allB = store.getAll(TEST_USER_B);
  const allC = store.getAll(TEST_USER_C);

  assertEqual(allA.length, 2);
  assertEqual(allB.length, 1);
  assertEqual(allC.length, 0);

  // Ensure content doesn't leak
  assert(!allA.some(m => m.content.includes('Beta')), 'User A should not see User B data');
  assert(!allB.some(m => m.content.includes('Alpha')), 'User B should not see User A data');
});

// ── Bonus: update nonexistent memory returns null ──
test('Update nonexistent memory → returns null', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const result = store.update(TEST_USER_A, 'does-not-exist', { content: 'nope' });
  assertEqual(result, null);
});

// ── Bonus: default type is 'fact' if not specified ──
test('Default type is fact when not specified', () => {
  cleanupTestUsers();
  const store = new MemoryStore();
  const entry = store.add(TEST_USER_A, { content: 'No type specified here' });
  assertEqual(entry.type, 'fact');
});

// ── Cleanup ──
cleanupTestUsers();

// ── Summary ──
console.log(`\n📊 Memory Store: ${passed} passed, ${failed} failed (${passed + failed} total)\n`);
process.exit(failed > 0 ? 1 : 0);
