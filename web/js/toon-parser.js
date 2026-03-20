/**
 * ToonParser — Token-Oriented Object Notation parser
 * Compact, human-readable encoding of JSON for Scratchy GenUI.
 *
 * Pure vanilla JS, no dependencies. IIFE → window.ToonParser
 */
(function (root) {
  'use strict';

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Coerce a raw string value into its JS primitive when appropriate.
   *   "42" → 42, "true" → true, "null" → null, etc.
   */
  function coerce(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') return v;
    var t = v.trim();
    if (t === '') return null;
    if (t === 'null') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === '""') return '';
    // Number detection — don't coerce strings that look like version numbers,
    // hex codes, or have leading zeros (except "0" and "0.x").
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) {
      var n = Number(t);
      if (isFinite(n)) return n;
    }
    return t;
  }

  /**
   * Parse a single CSV-ish value, respecting double-quote escaping.
   * Returns { value: string, next: number } where next is the index after
   * the consumed value (past the comma or at end-of-string).
   */
  function readCsvValue(line, start) {
    var i = start;
    var len = line.length;

    // skip leading whitespace
    while (i < len && line[i] === ' ') i++;

    if (i >= len) return { value: '', next: len };

    if (line[i] === '"') {
      // quoted value — consume until closing quote
      i++; // skip opening quote
      var buf = '';
      while (i < len) {
        if (line[i] === '\\' && i + 1 < len && line[i + 1] === '"') {
          buf += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          // advance past comma
          while (i < len && line[i] === ' ') i++;
          if (i < len && line[i] === ',') i++;
          return { value: buf, next: i };
        } else {
          buf += line[i];
          i++;
        }
      }
      // unterminated quote — return what we have
      return { value: buf, next: i };
    }

    // Check if value starts with '{' — grab the full JSON object
    if (line[i] === '{') {
      var depth = 0;
      var objStart = i;
      while (i < len) {
        if (line[i] === '{') depth++;
        else if (line[i] === '}') { depth--; if (depth === 0) { i++; break; } }
        else if (line[i] === '"') {
          i++;
          while (i < len && line[i] !== '"') {
            if (line[i] === '\\') i++;
            i++;
          }
          if (i < len) i++;
          continue;
        }
        i++;
      }
      var objStr = line.substring(objStart, i);
      // advance past comma
      while (i < len && line[i] === ' ') i++;
      if (i < len && line[i] === ',') i++;
      return { value: objStr, next: i, isJson: true };
    }

    // unquoted — read until next comma
    var vstart = i;
    while (i < len && line[i] !== ',') i++;
    var raw = line.substring(vstart, i);
    // trim trailing whitespace
    raw = raw.replace(/\s+$/, '');
    if (i < len && line[i] === ',') i++;
    return { value: raw, next: i };
  }

  /**
   * Split a line into CSV values, respecting quotes and JSON objects.
   */
  function splitCsv(line) {
    var values = [];
    var pos = 0;
    while (pos < line.length) {
      var prevPos = pos;
      var r = readCsvValue(line, pos);
      if (r.isJson) {
        try { values.push(JSON.parse(r.value)); }
        catch (_) { values.push(r.value); }
      } else {
        values.push(r.value);
      }
      pos = r.next;
      // if we haven't advanced, break to avoid infinite loop
      if (pos === prevPos) break;
    }
    return values;
  }

  /**
   * Split a CSV line into exactly N fields for tabular arrays.
   *
   * Uses an "anchor both ends" strategy to handle unquoted commas in
   * middle fields (the most common case in TOON — short labels at edges,
   * prose with commas in the middle):
   *
   *   n=1  → entire line
   *   n=2  → first value + everything remaining
   *   n≥3  → first from left, last from right, middle absorbs excess
   *
   * If the line has N or fewer comma-separated values, returns them as-is.
   * Quoting is always respected — quoted values with commas are never split.
   *
   * @param {string} line — CSV row content (already trimmed of leading indent)
   * @param {number} n — number of fields expected
   * @returns {Array} — exactly n (or fewer) values
   */
  function splitCsvN(line, n) {
    if (n <= 0) return [];
    if (n === 1) return [line];

    // First, split into all values using the full quote/JSON-aware parser
    var allValues = splitCsv(line);

    // Exact or fewer values: no redistribution needed
    if (allValues.length <= n) return allValues;

    // n=2: first value from left, rest of line joined as second value
    if (n === 2) {
      var rest = [];
      for (var j = 1; j < allValues.length; j++) {
        rest.push(typeof allValues[j] === 'object' ? JSON.stringify(allValues[j]) : allValues[j]);
      }
      return [allValues[0], rest.join(',')];
    }

    // n≥3: anchor first and last from edges, middle fields absorb excess
    var result = [];

    // First field (anchored from left)
    result.push(allValues[0]);

    // Middle values (everything between first and last)
    var middleValues = allValues.slice(1, allValues.length - 1);
    var middleFieldCount = n - 2;

    if (middleFieldCount === 1) {
      // Single middle field absorbs all middle values
      var joined = [];
      for (var k = 0; k < middleValues.length; k++) {
        joined.push(typeof middleValues[k] === 'object' ? JSON.stringify(middleValues[k]) : middleValues[k]);
      }
      result.push(joined.join(','));
    } else {
      // Multiple middle fields: first (middleFieldCount-1) get one value each,
      // the last middle field absorbs any remaining
      for (var m = 0; m < middleFieldCount - 1 && m < middleValues.length; m++) {
        result.push(middleValues[m]);
      }
      var leftover = middleValues.slice(Math.min(middleFieldCount - 1, middleValues.length));
      if (leftover.length > 0) {
        var joined2 = [];
        for (var p = 0; p < leftover.length; p++) {
          joined2.push(typeof leftover[p] === 'object' ? JSON.stringify(leftover[p]) : leftover[p]);
        }
        result.push(joined2.join(','));
      }
    }

    // Last field (anchored from right)
    result.push(allValues[allValues.length - 1]);

    return result;
  }

  /**
   * Parse a key declaration like `items[3]{label,value}` and return:
   *   { key: "items", arrayLen: 3|null, fields: ["label","value"]|null }
   */
  function parseKeyDecl(raw) {
    var key = raw;
    var arrayLen = null;
    var fields = null;

    // extract [N]
    var bracketMatch = key.match(/^(.+?)\[(\d+)\]/);
    if (bracketMatch) {
      key = bracketMatch[1];
      arrayLen = parseInt(bracketMatch[2], 10);
    }

    // extract {field1,field2,...}
    var remaining = raw.substring((bracketMatch ? bracketMatch[0] : key).length);
    var fieldMatch = remaining.match(/^\{([^}]+)\}/);
    if (fieldMatch) {
      fields = fieldMatch[1].split(',').map(function (f) { return f.trim(); });
    }

    return { key: key, arrayLen: arrayLen, fields: fields };
  }

  /**
   * Extract the value part from a "key: value" line.
   * Handles quoted strings (with escaped quotes) and bare values.
   */
  function extractValue(raw) {
    var trimmed = raw.trim();
    if (trimmed === '') return null;

    // Check for quoted string
    if (trimmed[0] === '"') {
      var end = 1;
      while (end < trimmed.length) {
        if (trimmed[end] === '\\' && end + 1 < trimmed.length) { end += 2; continue; }
        if (trimmed[end] === '"') break;
        end++;
      }
      var inner = trimmed.substring(1, end);
      // unescape
      return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }

    return trimmed;
  }

  // ── main parser ────────────────────────────────────────────────────────

  /**
   * Parse a single TOON block (no `---` separators) into a JS object.
   */
  function parseBlock(text) {
    if (!text || typeof text !== 'string') return null;

    var lines = text.split('\n');
    var root = {};

    // Stack of { obj, indent } — the objects we're currently building into
    var stack = [{ obj: root, indent: -1 }];

    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      // strip trailing whitespace
      var stripped = line.replace(/\s+$/, '');

      // skip blank lines and comments
      if (stripped === '' || /^\s*#/.test(stripped)) { i++; continue; }

      // measure indentation (number of leading spaces)
      var indent = 0;
      while (indent < line.length && line[indent] === ' ') indent++;

      var content = stripped.substring(indent);

      // find the colon that separates key from value
      // must handle quoted values and colons inside keys (unlikely but safe)
      var colonIdx = -1;
      var inQuote = false;
      for (var c = 0; c < content.length; c++) {
        if (content[c] === '"') inQuote = !inQuote;
        if (!inQuote && content[c] === ':') { colonIdx = c; break; }
      }

      if (colonIdx === -1) {
        // No colon — skip malformed line
        i++;
        continue;
      }

      var rawKey = content.substring(0, colonIdx);
      var rawValue = content.substring(colonIdx + 1);

      var decl = parseKeyDecl(rawKey.trim());
      var valueStr = rawValue.trim();

      // Pop stack to find the right parent for this indentation level
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      var parent = stack[stack.length - 1].obj;

      // Determine what kind of value this is
      if (decl.fields !== null) {
        // Tabular array: items[N]{field1,field2}:
        // Following indented lines are CSV rows
        var rows = [];
        var childIndent = indent + 2;
        i++;
        while (i < lines.length) {
          var rowLine = lines[i];
          var rowStripped = rowLine.replace(/\s+$/, '');
          if (rowStripped === '' || /^\s*#/.test(rowStripped)) { i++; continue; }
          var rowIndent = 0;
          while (rowIndent < rowLine.length && rowLine[rowIndent] === ' ') rowIndent++;
          if (rowIndent < childIndent) break;
          var rowContent = rowStripped.substring(rowIndent);
          var csvValues = splitCsvN(rowContent, decl.fields.length);
          var rowObj = {};
          for (var f = 0; f < decl.fields.length; f++) {
            var cellVal = f < csvValues.length ? csvValues[f] : null;
            if (typeof cellVal === 'object') {
              rowObj[decl.fields[f]] = cellVal;
            } else {
              rowObj[decl.fields[f]] = coerce(cellVal);
            }
          }
          rows.push(rowObj);
          i++;
        }
        parent[decl.key] = rows;
        continue;
      }

      if (decl.arrayLen !== null && valueStr !== '') {
        // Inline array: items[3]: a,b,c
        var csvVals = splitCsv(valueStr);
        parent[decl.key] = csvVals.map(function (v) {
          return typeof v === 'object' ? v : coerce(v);
        });
        i++;
        continue;
      }

      if (decl.arrayLen !== null && valueStr === '') {
        // Array with rows on following lines (no field headers — plain values)
        var arr = [];
        var arrChildIndent = indent + 2;
        i++;
        while (i < lines.length) {
          var aLine = lines[i];
          var aStripped = aLine.replace(/\s+$/, '');
          if (aStripped === '' || /^\s*#/.test(aStripped)) { i++; continue; }
          var aIndent = 0;
          while (aIndent < aLine.length && aLine[aIndent] === ' ') aIndent++;
          if (aIndent < arrChildIndent) break;
          var aContent = aStripped.substring(aIndent);
          arr.push(coerce(aContent));
          i++;
        }
        parent[decl.key] = arr;
        continue;
      }

      if (valueStr === '') {
        // No value after colon — this is a nested object
        var childObj = {};
        parent[decl.key] = childObj;
        stack.push({ obj: childObj, indent: indent });
        i++;
        continue;
      }

      // Simple key: value
      var finalValue = extractValue(rawValue);
      // Check if original trimmed value was a quoted string — preserve as string
      var rawTrimmed = rawValue.trim();
      var wasQuoted = rawTrimmed.length >= 2 && rawTrimmed[0] === '"';

      if (typeof finalValue === 'string' && !wasQuoted) {
        // Check if entire value is a JSON object/array
        var fv = finalValue.trim();
        if (fv.length > 0 &&
            ((fv[0] === '{' && fv[fv.length - 1] === '}') ||
             (fv[0] === '[' && fv[fv.length - 1] === ']'))) {
          try {
            parent[decl.key] = JSON.parse(fv);
            i++;
            continue;
          } catch (_) { /* fall through to coerce */ }
        }
      }
      // If quoted, keep as literal string (including empty string)
      parent[decl.key] = wasQuoted ? finalValue : coerce(finalValue);
      i++;
    }

    return root;
  }

  /**
   * Split text on `---` block separators. Each separator must be on its own
   * line (with optional surrounding whitespace).
   */
  function splitBlocks(text) {
    var blocks = [];
    var current = [];
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*---\s*$/.test(lines[i])) {
        var block = current.join('\n');
        if (block.trim() !== '') blocks.push(block);
        current = [];
      } else {
        current.push(lines[i]);
      }
    }
    var last = current.join('\n');
    if (last.trim() !== '') blocks.push(last);
    return blocks;
  }

  /**
   * Parse TOON text. If multiple `---`-separated blocks are present, returns
   * an array of objects; otherwise returns a single object.
   */
  function parse(text) {
    if (!text || typeof text !== 'string') return null;
    var blocks = splitBlocks(text);
    if (blocks.length === 0) return null;
    if (blocks.length === 1) return parseBlock(blocks[0]);
    return blocks.map(parseBlock);
  }

  /**
   * Parse `---`-separated TOON ops. Always returns an array.
   */
  function parseOps(text) {
    if (!text || typeof text !== 'string') return [];
    var blocks = splitBlocks(text);
    return blocks.map(parseBlock);
  }

  // ── public API ─────────────────────────────────────────────────────────

  var ToonParser = {
    parse: parse,
    parseBlock: parseBlock,
    parseOps: parseOps,
    // expose helpers for advanced use / testing
    _coerce: coerce,
    _splitCsv: splitCsv,
    _parseKeyDecl: parseKeyDecl
  };

  // Expose globally
  if (typeof root !== 'undefined') {
    root.ToonParser = ToonParser;
  }
  // CommonJS / Node
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ToonParser;
  }

})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);


// ── inline tests (Node.js only) ─────────────────────────────────────────
if (typeof module !== 'undefined' && require.main === module) {
  (function () {
    var T = module.exports;
    var pass = 0;
    var fail = 0;

    function assert(cond, msg) {
      if (cond) { pass++; }
      else { fail++; console.error('FAIL:', msg); }
    }

    function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

    // ─ Test 1: simple key-value ─
    var t1 = T.parseBlock('op: upsert\nid: stats-1\ntype: stats');
    assert(deepEq(t1, { op: 'upsert', id: 'stats-1', type: 'stats' }), 'simple kv');

    // ─ Test 2: nested object ─
    var t2 = T.parseBlock('data:\n  title: Hello\n  count: 42');
    assert(deepEq(t2, { data: { title: 'Hello', count: 42 } }), 'nested object');

    // ─ Test 3: tabular array ─
    var t3 = T.parseBlock('items[3]{label,value}:\n  CPU,73%\n  RAM,4.2 GB\n  Disk,52%');
    assert(deepEq(t3, {
      items: [
        { label: 'CPU', value: '73%' },
        { label: 'RAM', value: '4.2 GB' },
        { label: 'Disk', value: '52%' }
      ]
    }), 'tabular array');

    // ─ Test 4: inline array ─
    var t4 = T.parseBlock('tags[3]: red,green,blue');
    assert(deepEq(t4, { tags: ['red', 'green', 'blue'] }), 'inline array');

    // ─ Test 5: auto-coercion ─
    var t5 = T.parseBlock('a: 42\nb: true\nc: false\nd: null\ne: hello');
    assert(deepEq(t5, { a: 42, b: true, c: false, d: null, e: 'hello' }), 'auto coercion');

    // ─ Test 6: quoted value with comma ─
    var t6 = T.parseBlock('msg: "hello, world"');
    assert(t6.msg === 'hello, world', 'quoted value with comma');

    // ─ Test 7: quoted value with escaped quote ─
    var t7 = T.parseBlock('msg: "he said \\"hi\\""');
    assert(t7.msg === 'he said "hi"', 'escaped quotes');

    // ─ Test 8: multi-block parse ─
    var t8 = T.parse('op: a\n---\nop: b');
    assert(Array.isArray(t8) && t8.length === 2 && t8[0].op === 'a' && t8[1].op === 'b', 'multi-block');

    // ─ Test 9: single block parse returns object ─
    var t9 = T.parse('x: 1');
    assert(!Array.isArray(t9) && t9.x === 1, 'single block returns object');

    // ─ Test 10: parseOps always returns array ─
    var t10 = T.parseOps('op: a');
    assert(Array.isArray(t10) && t10.length === 1, 'parseOps returns array');

    // ─ Test 11: comments ignored ─
    var t11 = T.parseBlock('# comment\nfoo: bar\n  # indented comment');
    assert(deepEq(t11, { foo: 'bar' }), 'comments ignored');

    // ─ Test 12: empty value → null ─
    var t12 = T.parseBlock('x:');
    // 'x:' with nothing after = nested object (empty). But if next line is not indented, stays {}
    // Actually per spec, empty value with no children = nested empty object.
    // Let's test explicit null
    var t12b = T.parseBlock('x: null');
    assert(t12b.x === null, 'explicit null');

    // ─ Test 13: empty string ─
    var t13 = T.parseBlock('x: ""');
    assert(t13.x === '', 'empty string via ""');

    // ─ Test 14: full Scratchy example ─
    var toonText = [
      'op: upsert',
      'id: stats-1',
      'type: stats',
      'data:',
      '  title: Server Status',
      '  items[3]{label,value}:',
      '    CPU,73%',
      '    RAM,4.2 GB',
      '    Disk,52%'
    ].join('\n');
    var t14 = T.parseBlock(toonText);
    assert(t14.op === 'upsert', 'full example: op');
    assert(t14.id === 'stats-1', 'full example: id');
    assert(t14.type === 'stats', 'full example: type');
    assert(t14.data.title === 'Server Status', 'full example: nested title');
    assert(t14.data.items.length === 3, 'full example: items length');
    assert(t14.data.items[0].label === 'CPU', 'full example: first item label');
    assert(t14.data.items[1].value === '4.2 GB', 'full example: second item value');

    // ─ Test 15: deeply nested ─
    var t15 = T.parseBlock('a:\n  b:\n    c: deep');
    assert(t15.a.b.c === 'deep', 'deeply nested');

    // ─ Test 16: number-like strings that shouldn't coerce ─
    assert(T._coerce('007') === '007', 'leading zero not coerced');
    assert(T._coerce('1.2.3') === '1.2.3', 'version string not coerced');
    assert(T._coerce('0') === 0, 'zero coerced');
    assert(T._coerce('0.5') === 0.5, 'decimal coerced');

    // ─ Test 17: JSON cell in tabular array ─
    var t17 = T.parseBlock('rows[1]{name,meta}:\n  foo,{"x":1}');
    assert(t17.rows[0].name === 'foo', 'json cell: name');
    assert(typeof t17.rows[0].meta === 'object' && t17.rows[0].meta.x === 1, 'json cell: parsed');

    // ─ Test 18: parseOps with multiple blocks ─
    var t18 = T.parseOps('op: upsert\nid: a\n---\nop: remove\nid: b\n---\nop: clear');
    assert(t18.length === 3, 'parseOps 3 blocks');
    assert(t18[0].op === 'upsert' && t18[1].op === 'remove' && t18[2].op === 'clear', 'parseOps ops');

    // ─ Test 19: inline JSON value ─
    var t19 = T.parseBlock('config: {"a":1,"b":"two"}');
    assert(typeof t19.config === 'object' && t19.config.a === 1, 'inline JSON object');

    // ─ Test 20: trailing whitespace ─
    var t20 = T.parseBlock('key: value   \n');
    assert(t20.key === 'value', 'trailing whitespace trimmed');

    // ─ Test 21: plain array (no field headers) ─
    var t21 = T.parseBlock('colors[3]:\n  red\n  green\n  blue');
    assert(deepEq(t21, { colors: ['red', 'green', 'blue'] }), 'plain array with rows');

    // ─ Test 22: mixed siblings after nested object ─
    var t22 = T.parseBlock('a:\n  x: 1\nb: 2');
    assert(t22.a.x === 1 && t22.b === 2, 'sibling after nested');

    // Summary
    console.log('\n' + (pass + fail) + ' tests, ' + pass + ' passed, ' + fail + ' failed');
    if (fail > 0) process.exit(1);
  })();
}
