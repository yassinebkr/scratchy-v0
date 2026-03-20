// ============================================
// Test: toon-integration.js
// ============================================
// Run: node web/js/tests/test-toon-integration.js
// Mocks window.ToonParser since toon-parser.js may not exist yet.

var assert = require("assert");
var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.log("  ✗ " + name);
    console.log("    " + e.message);
  }
}

// ── Simulate browser globals ──
global.window = global;
global.console = console;

// ── Mock ToonParser ──
// Simulates what toon-parser.js will provide.
// parse(text) → single op object
// parseOps(text) → array of ops (splits on ---)
window.ToonParser = {
  parse: function(text) {
    // Minimal TOON parse mock: extract key: value pairs
    var lines = text.split("\n");
    var op = {};
    var inData = false;
    var data = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (!trimmed) continue;

      if (inData) {
        // Simple nested key: value
        var dMatch = trimmed.match(/^(\w+):\s*(.+)$/);
        if (dMatch) {
          data[dMatch[1]] = dMatch[2];
        }
        // Handle array shorthand (items[2]{label,value}:)
        var arrMatch = trimmed.match(/^(\w+)\[\d+\]\{[^}]+\}:\s*$/);
        if (arrMatch) {
          data[arrMatch[1]] = [];
          // next lines are array entries
        }
        // Array entry lines (CSV)
        if (trimmed.indexOf(",") !== -1 && !dMatch && !arrMatch) {
          // find last array key
          var keys = Object.keys(data);
          var lastArr = null;
          for (var k = keys.length - 1; k >= 0; k--) {
            if (Array.isArray(data[keys[k]])) { lastArr = keys[k]; break; }
          }
          if (lastArr) {
            var parts = trimmed.split(",");
            data[lastArr].push({ label: parts[0], value: parts[1] });
          }
        }
      } else {
        var m = trimmed.match(/^(\w+):\s*(.*)$/);
        if (m) {
          if (m[1] === "data" && !m[2]) {
            inData = true;
          } else {
            op[m[1]] = m[2];
          }
        }
      }
    }
    if (Object.keys(data).length > 0) op.data = data;
    return op;
  },

  parseOps: function(text) {
    var chunks = text.split(/^---$/m);
    var ops = [];
    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i].trim();
      if (!chunk) continue;
      var op = this.parse(chunk);
      if (op && op.op) ops.push(op);
    }
    return ops;
  }
};

// ── Load the integration module ──
require("../toon-integration.js");

var TI = window.ToonIntegration;

// ── Tests ──

console.log("\n== parseBlocks ==");

test("returns empty ops for plain text", function() {
  var result = TI.parseBlocks("Hello world, no canvas here.");
  assert.deepStrictEqual(result.ops, []);
  assert.strictEqual(result.cleanText, "Hello world, no canvas here.");
});

test("parses a single scratchy-toon block", function() {
  var text = "Here is your card:\n```scratchy-toon\nop: upsert\nid: card-1\ntype: card\ndata:\n  title: Hello\n  text: World\n```\nDone!";
  var result = TI.parseBlocks(text);
  assert.strictEqual(result.ops.length, 1);
  assert.strictEqual(result.ops[0].op, "upsert");
  assert.strictEqual(result.ops[0].id, "card-1");
  assert.strictEqual(result.ops[0].data.title, "Hello");
  assert.ok(result.cleanText.indexOf("scratchy-toon") === -1, "blocks stripped");
  assert.ok(result.cleanText.indexOf("Done!") !== -1, "surrounding text preserved");
});

test("parses multiple ops in one block (--- separator)", function() {
  var text = "```scratchy-toon\nop: upsert\nid: a\ntype: card\ndata:\n  title: A\n---\nop: upsert\nid: b\ntype: card\ndata:\n  title: B\n```";
  var result = TI.parseBlocks(text);
  assert.strictEqual(result.ops.length, 2);
  assert.strictEqual(result.ops[0].id, "a");
  assert.strictEqual(result.ops[1].id, "b");
});

test("parses multiple blocks in one message", function() {
  var text = "Block1:\n```scratchy-toon\nop: upsert\nid: x\ntype: card\ndata:\n  title: X\n```\nMiddle text\n```scratchy-toon\nop: remove\nid: y\n```\nEnd.";
  var result = TI.parseBlocks(text);
  assert.strictEqual(result.ops.length, 2);
  assert.strictEqual(result.ops[0].id, "x");
  assert.strictEqual(result.ops[1].op, "remove");
  assert.ok(result.cleanText.indexOf("Middle text") !== -1);
});

test("handles null/undefined/empty input", function() {
  assert.deepStrictEqual(TI.parseBlocks(null).ops, []);
  assert.deepStrictEqual(TI.parseBlocks(undefined).ops, []);
  assert.deepStrictEqual(TI.parseBlocks("").ops, []);
});

console.log("\n== createStreamParser ==");

test("streaming: emits ops as they complete (--- separator)", function() {
  var emitted = [];
  var sp = TI.createStreamParser({ onOp: function(op) { emitted.push(op); } });

  // Feed text incrementally — but as accumulated text each time
  var acc = "";

  acc += "Some chat text\n";
  sp.feed(acc);
  assert.strictEqual(emitted.length, 0);

  acc += "```scratchy-toon\n";
  sp.feed(acc);
  assert.strictEqual(emitted.length, 0);

  acc += "op: upsert\n";
  sp.feed(acc);
  assert.strictEqual(emitted.length, 0);

  acc += "id: card-1\n";
  sp.feed(acc);

  acc += "type: card\n";
  sp.feed(acc);

  acc += "data:\n";
  sp.feed(acc);

  acc += "  title: Hello\n";
  sp.feed(acc);

  // --- separator triggers emit
  acc += "---\n";
  sp.feed(acc);
  assert.strictEqual(emitted.length, 1, "should emit after ---");
  assert.strictEqual(emitted[0].op, "upsert");
  assert.strictEqual(emitted[0].id, "card-1");

  // Second op
  acc += "op: upsert\n";
  sp.feed(acc);
  acc += "id: card-2\n";
  sp.feed(acc);
  acc += "type: card\n";
  sp.feed(acc);
  acc += "data:\n";
  sp.feed(acc);
  acc += "  title: World\n";
  sp.feed(acc);

  // Close fence triggers emit
  acc += "```\n";
  sp.feed(acc);
  assert.strictEqual(emitted.length, 2, "should emit on block close");
  assert.strictEqual(emitted[1].id, "card-2");

  sp.finalize();
});

test("streaming: deduplicates identical ops", function() {
  var emitted = [];
  var sp = TI.createStreamParser({ onOp: function(op) { emitted.push(op); } });

  var block = "```scratchy-toon\nop: upsert\nid: dup-1\ntype: card\ndata:\n  title: Same\n---\nop: upsert\nid: dup-1\ntype: card\ndata:\n  title: Same\n```\n";
  sp.feed(block);
  assert.strictEqual(emitted.length, 1, "duplicate op should be deduped");
  sp.finalize();
});

test("streaming: handles partial lines (no newline yet)", function() {
  var emitted = [];
  var sp = TI.createStreamParser({ onOp: function(op) { emitted.push(op); } });

  // Feed text that ends mid-line (no trailing newline)
  sp.feed("```scratchy-toon\nop: upsert\nid: partial");
  assert.strictEqual(emitted.length, 0, "no emit for partial line");

  // Complete the line and the block
  sp.feed("```scratchy-toon\nop: upsert\nid: partial\ntype: card\ndata:\n  title: T\n```\n");
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].id, "partial");
  sp.finalize();
});

test("streaming: getOps returns all emitted ops", function() {
  var sp = TI.createStreamParser();
  var block = "```scratchy-toon\nop: upsert\nid: g1\ntype: card\ndata:\n  title: G\n```\n";
  sp.feed(block);
  var ops = sp.getOps();
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].id, "g1");
  sp.finalize();
});

test("streaming: finalize flushes pending op inside unclosed block", function() {
  var emitted = [];
  var sp = TI.createStreamParser({ onOp: function(op) { emitted.push(op); } });

  // Block never properly closed
  sp.feed("```scratchy-toon\nop: upsert\nid: unclosed\ntype: card\ndata:\n  title: Oops\n");
  assert.strictEqual(emitted.length, 0);
  sp.finalize();
  assert.strictEqual(emitted.length, 1, "finalize should flush pending op");
  assert.strictEqual(emitted[0].id, "unclosed");
});

test("_hashOp produces consistent hashes", function() {
  var h1 = TI._hashOp({ op: "upsert", id: "x", data: { a: 1 } });
  var h2 = TI._hashOp({ op: "upsert", id: "x", data: { a: 1 } });
  var h3 = TI._hashOp({ op: "upsert", id: "x", data: { a: 2 } });
  assert.strictEqual(h1, h2);
  assert.notStrictEqual(h1, h3);
});

// ── Summary ──
console.log("\n" + (passed + failed) + " tests: " + passed + " passed, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
