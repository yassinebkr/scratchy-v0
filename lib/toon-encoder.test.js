#!/usr/bin/env node
/**
 * toon-encoder.test.js — Tests for the Scratchy TOON encoder.
 *
 * Run: node lib/toon-encoder.test.js
 */

'use strict';

const {
  toonEncode,
  toonDecode,
  toonEncodeOps,
  toonEncodeCanvasState,
  toonEncodeWidgetContext,
  encode,
  decode,
} = require('./toon-encoder');

let passed = 0;
let failed = 0;

function assert(cond, label, detail) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    if (detail) console.log(`     ${detail}`);
    failed++;
  }
}

function assertRoundTrip(obj, label) {
  const encoded = toonEncode(obj);
  const decoded = toonDecode(encoded);
  const match = JSON.stringify(decoded) === JSON.stringify(obj);
  assert(match, `Round-trip: ${label}`,
    match ? '' : `Expected: ${JSON.stringify(obj)}\n     Got:      ${JSON.stringify(decoded)}`);
  return encoded;
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 1: Simple card op');
{
  const op = { op: 'upsert', id: 'card-1', type: 'card', data: { title: 'Hello', text: 'World' } };
  const encoded = toonEncodeOps([op]);
  console.log(encoded);
  assert(encoded.includes('op: upsert'), 'Contains op: upsert');
  assert(encoded.includes('id: card-1'), 'Contains id');
  assert(encoded.includes('title: Hello'), 'Contains title');
  assert(encoded.includes('text: World'), 'Contains text');
  // Round-trip the data portion
  assertRoundTrip(op.data, 'card data');
  // Verify full op round-trip
  const decoded = decode(encoded);
  assert(decoded.op === 'upsert' && decoded.data.title === 'Hello', 'Full op decode');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 2: Stats with tabular items array');
{
  const op = {
    op: 'upsert', id: 'stats-1', type: 'stats',
    data: {
      title: 'Server',
      items: [{ label: 'CPU', value: '73%' }, { label: 'RAM', value: '4.2GB' }],
    },
  };
  const encoded = toonEncodeOps([op]);
  console.log(encoded);
  assert(encoded.includes('items[2]{label,value}:'), 'Tabular array header');
  assert(encoded.includes('CPU,73%'), 'Tabular row 1');
  assert(encoded.includes('RAM,4.2GB'), 'Tabular row 2');
  assertRoundTrip(op.data, 'stats data');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 3: Table with headers and rows');
{
  const op = {
    op: 'upsert', id: 'task-table', type: 'table',
    data: {
      title: 'Tasks',
      headers: ['Task', 'Status', 'Due'],
      rows: [
        ['Deploy API', 'In Progress', 'Feb 22'],
        ['Fix auth bug', 'Blocked', 'Feb 23'],
        ['Write docs', 'Done', 'Feb 21'],
      ],
    },
  };
  const buttonsOp = {
    op: 'upsert', id: 'task-actions', type: 'buttons',
    data: {
      title: 'Actions',
      buttons: [
        { label: 'Refresh', action: 'refresh', style: 'ghost' },
        { label: 'Add Task', action: 'add', style: 'primary' },
      ],
    },
  };
  const encoded = toonEncodeOps([op, buttonsOp]);
  console.log(encoded);
  assert(encoded.includes('---'), 'Contains separator');
  assert(encoded.includes('headers[3]: Task,Status,Due'), 'Headers as inline array');
  assert(encoded.includes('buttons[2]{label,action,style}:'), 'Buttons tabular');
  assert(encoded.includes('Refresh,refresh,ghost'), 'Button row');
  // Round-trip
  assertRoundTrip(op.data, 'table data');
  assertRoundTrip(buttonsOp.data, 'buttons data');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 4: Patch op');
{
  const op = { op: 'patch', id: 'gauge-1', data: { value: 85 } };
  const encoded = toonEncodeOps([op]);
  console.log(encoded);
  assert(encoded.includes('op: patch'), 'Patch op');
  assert(encoded.includes('value: 85'), 'Numeric value');
  assert(!encoded.includes('type:'), 'No type field for patch');
  const decoded = decode(encoded);
  assert(decoded.data.value === 85, 'Decoded value is number 85');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 5: Clear op');
{
  const op = { op: 'clear' };
  const encoded = toonEncodeOps([op]);
  console.log(encoded);
  assert(encoded.trim() === 'op: clear', 'Clear op is minimal');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 6: Special characters (quoting)');
{
  const data = { title: 'Hello, World', note: 'has: colon', multiline: 'Line1\nLine2' };
  const encoded = toonEncode(data);
  console.log(encoded);
  assert(encoded.includes('"Hello, World"'), 'Comma value quoted');
  assert(encoded.includes('"has: colon"'), 'Colon value quoted');
  assertRoundTrip(data, 'special chars');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 7: Canvas state encoding (Map)');
{
  const state = new Map();
  state.set('gauge-cpu', { type: 'gauge', data: { label: 'CPU', value: 73, max: 100 } });
  state.set('stats-1', { type: 'stats', data: { title: 'Info', items: [{ label: 'Up', value: '14d' }] } });
  const encoded = toonEncodeCanvasState(state);
  console.log(encoded);
  assert(encoded.includes('id: gauge-cpu'), 'State has gauge id');
  assert(encoded.includes('id: stats-1'), 'State has stats id');
  assert(encoded.includes('---'), 'State blocks separated');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 8: Widget context encoding');
{
  const ctx = {
    action: 'click',
    widgetId: 'btn-refresh',
    widgetType: 'buttons',
    value: 'refresh',
    formData: { name: 'Alice', email: 'alice@example.com' },
  };
  const encoded = toonEncodeWidgetContext(ctx);
  console.log(encoded);
  assert(encoded.includes('action: click'), 'Widget action');
  assert(encoded.includes('widgetId: btn-refresh'), 'Widget id');
  assertRoundTrip(ctx, 'widget context');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 9: Indentation option');
{
  const data = { title: 'Indented', value: 42 };
  const encoded = toonEncode(data, { indent: 2 });
  console.log(encoded);
  assert(encoded.startsWith('    '), 'Starts with 4 spaces (indent=2)');
  assert(encoded.includes('    title: Indented'), 'Key indented');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 10: Token savings estimate');
{
  const ops = [
    { op: 'upsert', id: 'g-cpu', type: 'gauge', data: { label: 'CPU', value: 73, max: 100, unit: '%', color: 'orange' } },
    { op: 'upsert', id: 'g-ram', type: 'gauge', data: { label: 'RAM', value: 4.2, max: 8, unit: 'GB', color: 'blue' } },
    { op: 'upsert', id: 'srv-stats', type: 'stats', data: { title: 'Services', items: [{ label: 'Uptime', value: '14d 3h' }, { label: 'Requests', value: '1.2M' }, { label: 'Errors', value: '0.03%' }] } },
  ];
  const toonStr = toonEncodeOps(ops);
  const jsonStr = ops.map(o => JSON.stringify(o)).join('\n');
  const savings = ((1 - toonStr.length / jsonStr.length) * 100).toFixed(1);
  console.log(`  JSON: ${jsonStr.length} chars`);
  console.log(`  TOON: ${toonStr.length} chars`);
  console.log(`  Savings: ${savings}%`);
  assert(toonStr.length < jsonStr.length, `TOON is smaller (${savings}% savings)`);
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 11: Empty / edge cases');
{
  assert(toonEncodeOps([]) === '', 'Empty ops array → empty string');
  assert(toonEncodeOps(null) === '', 'null ops → empty string');
  assert(toonEncodeCanvasState(null) === '', 'null state → empty string');
  assert(toonEncodeCanvasState(new Map()) === '', 'empty Map → empty string');
  assert(toonEncodeWidgetContext(null) === '', 'null context → empty string');
  assert(toonEncodeWidgetContext('string') === '', 'non-object context → empty string');
}

// ─────────────────────────────────────────────────────
console.log('\n🧪 Test 12: Official package re-export works');
{
  const obj = { a: 1, b: 'hello', c: [1, 2, 3] };
  const enc = encode(obj);
  const dec = decode(enc);
  assert(JSON.stringify(dec) === JSON.stringify(obj), 'encode/decode re-exports work');
}

// ─────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 All tests passed!\n');
}
