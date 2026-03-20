'use strict';

/**
 * TOON Round-Trip Test Suite
 *
 * Tests encode (JSON → TOON) then parse (TOON → JSON) round-trip fidelity.
 *
 * Dependencies (created by sibling sub-agents):
 *   - lib/toon-encoder.js   — server-side TOON encoder (CommonJS)
 *   - web/js/toon-parser.js — browser TOON parser (sets window.ToonParser)
 *
 * Usage:
 *   cd scratchy && node test/toon-roundtrip.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT         = path.resolve(__dirname, '..');
const ENCODER_PATH = path.join(ROOT, 'lib', 'toon-encoder.js');
const PARSER_PATH  = path.join(ROOT, 'web', 'js', 'toon-parser.js');

// ── Wait for files ───────────────────────────────────────────────────────────
const POLL_MS  = 5000;   // check every 5 s
const TIMEOUT  = 180000; // give up after 3 min

function filesReady() {
  return fs.existsSync(ENCODER_PATH) && fs.existsSync(PARSER_PATH);
}

async function waitForFiles() {
  if (filesReady()) return;
  const deadline = Date.now() + TIMEOUT;
  process.stdout.write('Waiting for encoder & parser to appear');
  while (!filesReady()) {
    if (Date.now() > deadline) {
      console.error('\n✗ Timeout: files not found after 3 minutes.');
      console.error('  Expected:\n    ' + ENCODER_PATH + '\n    ' + PARSER_PATH);
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  console.log(' ready!');
}

// ── Load modules ─────────────────────────────────────────────────────────────

function loadEncoder() {
  // CommonJS module — just require it
  return require(ENCODER_PATH);
}

function loadParser() {
  // Browser module — expects `window`. Create a minimal sandbox.
  const code = fs.readFileSync(PARSER_PATH, 'utf8');
  const window = {};
  const sandbox = { window, self: window, globalThis: window, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // The parser may attach to window.ToonParser or module.exports
  if (sandbox.window.ToonParser) return sandbox.window.ToonParser;
  if (sandbox.ToonParser)        return sandbox.ToonParser;

  // Try running with module shim
  const sandbox2 = { module: { exports: {} }, exports: {}, require, console, window: {} };
  vm.createContext(sandbox2);
  vm.runInContext(code, sandbox2);
  if (sandbox2.module.exports && typeof sandbox2.module.exports.parse === 'function') {
    return sandbox2.module.exports;
  }
  if (sandbox2.window.ToonParser) return sandbox2.window.ToonParser;

  throw new Error('Could not locate ToonParser after loading ' + PARSER_PATH);
}

// ── Deep equality ────────────────────────────────────────────────────────────
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  const isArrA = Array.isArray(a);
  const isArrB = Array.isArray(b);
  if (isArrA !== isArrB) return false;

  if (isArrA) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  if (!keysA.every((k, i) => k === keysB[i])) return false;
  return keysA.every(k => deepEqual(a[k], b[k]));
}

// ── Token estimation ─────────────────────────────────────────────────────────
function estimateTokens(str) {
  return Math.ceil(str.length / 4);
}

function savingsPct(jsonStr, toonStr) {
  const jt = estimateTokens(jsonStr);
  const tt = estimateTokens(toonStr);
  if (jt === 0) return 0;
  return Math.round(((jt - tt) / jt) * 100);
}

// ── Test cases ───────────────────────────────────────────────────────────────
const TEST_CASES = [
  {
    name: 'Simple flat object',
    input: {"op":"upsert","id":"card-1","type":"card","data":{"title":"Hello","text":"World"}}
  },
  {
    name: 'Nested object with tabular array',
    input: {"op":"upsert","id":"stats-1","type":"stats","data":{"title":"Server","items":[{"label":"CPU","value":"73%"},{"label":"RAM","value":"4.2GB"},{"label":"Disk","value":"52%"}]}}
  },
  {
    name: 'Multiple ops (array)',
    input: [{"op":"clear"},{"op":"upsert","id":"hero-1","type":"hero","data":{"title":"Dashboard","subtitle":"Welcome back","gradient":["#7c3aed","#3b82f6"]}}]
  },
  {
    name: 'Complex admin gauge widget',
    input: {"op":"upsert","id":"admin-gauge-cpu","type":"gauge","data":{"label":"CPU","value":45,"max":100,"unit":"%","color":"#3b82f6"}}
  },
  {
    name: 'Table with action buttons',
    input: {"op":"upsert","id":"user-table","type":"table","data":{"title":"Users","headers":["Name","Role",""],"rows":[["Alice","admin",{"text":"Detail","action":"admin-user-detail","context":{"userId":"abc123"},"style":"primary"}]]}}
  },
  {
    name: 'Edge: value with commas',
    input: {"text": "Hello, world"}
  },
  {
    name: 'Edge: value with colons (URL)',
    input: {"url": "https://example.com"}
  },
  {
    name: 'Edge: empty string value',
    input: {"key": "", "other": "value"}
  },
  {
    name: 'Edge: null values',
    input: {"a": null, "b": "ok", "c": null}
  },
  {
    name: 'Edge: boolean values',
    input: {"active": true, "deleted": false, "label": "Test"}
  },
  {
    name: 'Edge: deeply nested (3+ levels)',
    input: {"level1": {"level2": {"level3": {"level4": {"deep": "value"}}}}}
  },
  {
    name: 'Edge: array of primitives',
    input: [1, 2, 3]
  },
  {
    name: 'Edge: mixed array',
    input: [1, "two", true, null, {"key": "val"}]
  },
  {
    name: 'Edge: numeric values (int + float)',
    input: {"count": 0, "temperature": -3.14, "big": 999999}
  },
  {
    name: 'Edge: empty object and array',
    input: {"emptyObj": {}, "emptyArr": [], "ok": true}
  },
  {
    name: 'Realistic: multi-component dashboard ops',
    input: [
      {"op":"clear"},
      {"op":"upsert","id":"dash-hero","type":"hero","data":{"title":"System Dashboard","subtitle":"All systems nominal","gradient":["#10b981","#059669"]}},
      {"op":"upsert","id":"dash-cpu","type":"gauge","data":{"label":"CPU","value":67,"max":100,"unit":"%","color":"#3b82f6"}},
      {"op":"upsert","id":"dash-mem","type":"gauge","data":{"label":"Memory","value":8.2,"max":16,"unit":"GB","color":"#f59e0b"}},
      {"op":"upsert","id":"dash-table","type":"table","data":{"title":"Recent Events","headers":["Time","Event","Status"],"rows":[["10:01","Deploy v2.3","success"],["09:45","DB backup","success"],["09:30","Health check","warning"]]}}
    ]
  }
];

// ── Runner ───────────────────────────────────────────────────────────────────
async function main() {
  await waitForFiles();

  let encoder, parser;
  try {
    encoder = loadEncoder();
  } catch (err) {
    console.error('✗ Failed to load encoder:', err.message);
    process.exit(1);
  }
  try {
    parser = loadParser();
  } catch (err) {
    console.error('✗ Failed to load parser:', err.message);
    process.exit(1);
  }

  // Resolve encode/parse functions — handle various export shapes
  const encode = typeof encoder === 'function' ? encoder
    : encoder.encode || encoder.toToon || encoder.stringify || encoder.default;
  const parse  = typeof parser === 'function' ? parser
    : parser.parse  || parser.fromToon || parser.decode || parser.default;

  if (typeof encode !== 'function') {
    console.error('✗ Encoder does not export an encode function. Exports:', Object.keys(encoder));
    process.exit(1);
  }
  if (typeof parse !== 'function') {
    console.error('✗ Parser does not export a parse function. Exports:', Object.keys(parser));
    process.exit(1);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          TOON Round-Trip Test Suite                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  let passed = 0;
  let failed = 0;
  let totalJsonTokens = 0;
  let totalToonTokens = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    const num = String(i + 1).padStart(2, ' ');
    const jsonStr = JSON.stringify(tc.input);

    let toonStr, decoded, ok;
    let error = null;

    try {
      toonStr = encode(tc.input);
    } catch (err) {
      error = 'encode threw: ' + err.message;
    }

    if (!error) {
      try {
        decoded = parse(toonStr);
      } catch (err) {
        error = 'parse threw: ' + err.message;
      }
    }

    if (!error) {
      ok = deepEqual(tc.input, decoded);
    }

    const jTokens = estimateTokens(jsonStr);
    const tTokens = toonStr ? estimateTokens(toonStr) : jTokens;
    const savings = toonStr ? savingsPct(jsonStr, toonStr) : 0;

    totalJsonTokens += jTokens;
    totalToonTokens += tTokens;

    if (error) {
      failed++;
      console.log(`  Test ${num}: ${tc.name} ... \x1b[31mFAIL\x1b[0m`);
      console.log(`           Error: ${error}`);
    } else if (ok) {
      passed++;
      const savingsNote = savings > 0 ? ` (saved ${savings}% tokens: ${jTokens}→${tTokens})` : ` (${jTokens}→${tTokens} tokens)`;
      console.log(`  Test ${num}: ${tc.name} ... \x1b[32mPASS\x1b[0m${savingsNote}`);
    } else {
      failed++;
      console.log(`  Test ${num}: ${tc.name} ... \x1b[31mFAIL\x1b[0m`);
      console.log(`           Expected: ${jsonStr}`);
      console.log(`           Got:      ${JSON.stringify(decoded)}`);
      if (toonStr) {
        console.log(`           TOON:     ${toonStr.replace(/\n/g, '\\n')}`);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('');
  console.log('──────────────────────────────────────────────────────────');
  const overallSavings = totalJsonTokens > 0
    ? Math.round(((totalJsonTokens - totalToonTokens) / totalJsonTokens) * 100)
    : 0;
  console.log(`  Results: ${passed} passed, ${failed} failed, ${TEST_CASES.length} total`);
  console.log(`  Token estimate: JSON ~${totalJsonTokens} → TOON ~${totalToonTokens} (${overallSavings}% savings overall)`);
  console.log('──────────────────────────────────────────────────────────');
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
