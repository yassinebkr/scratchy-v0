'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

/**
 * @typedef {Object} Bookmark
 * @property {string}  file       - JSONL filename (basename)
 * @property {number}  byteOffset - byte position up to which we've fully consumed
 * @property {number}  lineNumber - total lines processed so far
 */

/**
 * @typedef {Object} ParsedEntry
 * @property {string}   timestamp   - ISO string from the outer entry
 * @property {number}   input       - input tokens (non-cache)
 * @property {number}   output      - output tokens
 * @property {number}   cacheRead   - cache-read tokens
 * @property {number}   cacheWrite  - cache-write tokens
 * @property {number}   cost        - usage.cost.total in USD
 * @property {string}   model       - full model ID (e.g. "claude-opus-4-6")
 * @property {string}   provider    - provider name (e.g. "anthropic")
 * @property {string}   stopReason  - e.g. "toolUse", "endTurn", "error"
 * @property {string[]} toolNames   - names of tools called in this turn
 * @property {boolean}  isError     - true when stopReason === "error" or errorMessage present
 */

/**
 * Incremental JSONL session-file reader.
 *
 * Uses byte-offset bookmarks so that tailing a 27 MB file with 10 new lines
 * only reads ~5 KB of I/O.  Three-stage pipeline:
 *
 *  1. `fs.createReadStream({ start })` — kernel seeks past old bytes
 *  2. `readline` — streaming line-by-line, constant memory
 *  3. Fast string pre-filter — skip lines without `"usage"` before JSON.parse
 */
class JsonlTailer {
  /**
   * Read only NEW lines from a JSONL file since the given bookmark.
   *
   * Edge cases handled:
   *  - File doesn't exist → empty result
   *  - File truncated (bookmark.byteOffset > size) → full rescan
   *  - Partial last line (no trailing \\n) → skipped, bookmark stays before it
   *  - Malformed JSON → warning logged, line skipped
   *  - Missing usage fields → default to 0 / null
   *
   * @param {string}        filePath  - Absolute path to a .jsonl session file
   * @param {Bookmark|null} bookmark  - Previous position, or null for first read
   * @returns {Promise<{entries: ParsedEntry[], newBookmark: Bookmark}>}
   */
  async tail(filePath, bookmark) {
    const basename = path.basename(filePath);

    /** @returns {{entries: ParsedEntry[], newBookmark: Bookmark}} */
    const empty = (offset = 0, line = 0) => ({
      entries: [],
      newBookmark: { file: basename, byteOffset: offset, lineNumber: line },
    });

    // ── 1. Stat the file ────────────────────────────────────────────────
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return empty();
      throw err;
    }

    const fileSize = stat.size;
    if (fileSize === 0) return empty();

    // ── 2. Resolve start position ───────────────────────────────────────
    let startOffset = 0;
    let startLine = 0;

    if (bookmark) {
      if (bookmark.byteOffset > fileSize) {
        // File was truncated / rotated → full rescan from top
        startOffset = 0;
        startLine = 0;
      } else if (bookmark.byteOffset === fileSize) {
        // Nothing new
        return {
          entries: [],
          newBookmark: { ...bookmark },
        };
      } else {
        startOffset = bookmark.byteOffset;
        startLine = bookmark.lineNumber;
      }
    }

    // ── 3. Detect whether file ends with \n (for partial-line guard) ────
    const endsWithNewline = await this._endsWithNewline(filePath, fileSize);

    // ── 4. Stream lines from byte offset ────────────────────────────────
    /** @type {ParsedEntry[]} */
    const entries = [];
    /** @type {{lineBytes: number, hadUsage: boolean}[]} */
    const lineMeta = []; // track every line's byte size + whether it produced an entry

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, {
        start: startOffset,
        encoding: 'utf8',
        highWaterMark: 64 * 1024,
      });

      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n delimiter
        let hadUsage = false;

        // Fast pre-filter: skip lines that can't contain usage data
        if (line.includes('"usage"')) {
          const parsed = this._parseLine(line);
          if (parsed) {
            entries.push(parsed);
            hadUsage = true;
          }
        }

        lineMeta.push({ lineBytes, hadUsage });
      });

      rl.on('close', resolve);
      rl.on('error', reject);
      stream.on('error', reject);
    });

    // ── 5. Handle partial last line ─────────────────────────────────────
    // readline emits the last chunk even without a trailing \n.
    // We added +1 (for \n) to every line, but the last line might not have one.
    // If the file doesn't end with \n, the last "line" is partial/incomplete —
    // the writer may still be appending to it. We must NOT advance past it.
    let totalLines = lineMeta.length;

    if (totalLines > 0 && !endsWithNewline) {
      const last = lineMeta.pop();
      totalLines--;

      // If the partial line produced a ParsedEntry, remove it
      if (last.hadUsage) {
        entries.pop();
      }
    }

    // ── 6. Compute consumed bytes from complete lines ───────────────────
    let bytesConsumed = 0;
    for (const meta of lineMeta) {
      bytesConsumed += meta.lineBytes;
    }

    const newBookmark = {
      file: basename,
      byteOffset: startOffset + bytesConsumed,
      lineNumber: startLine + totalLines,
    };

    return { entries, newBookmark };
  }

  /**
   * Check whether a file's last byte is a newline (0x0A).
   *
   * @param {string} filePath
   * @param {number} fileSize - Known size from a previous stat call
   * @returns {Promise<boolean>}
   * @private
   */
  async _endsWithNewline(filePath, fileSize) {
    if (fileSize === 0) return false;

    const buf = Buffer.alloc(1);
    const fh = await fs.promises.open(filePath, 'r');
    try {
      await fh.read(buf, 0, 1, fileSize - 1);
      return buf[0] === 0x0A;
    } finally {
      await fh.close();
    }
  }

  /**
   * Parse a single JSONL line into a {@link ParsedEntry}.
   *
   * Returns `null` if the line is not a usage-bearing message entry.
   *
   * @param {string} line - Raw JSONL line (already pre-filtered to contain "usage")
   * @returns {ParsedEntry|null}
   * @private
   */
  _parseLine(line) {
    /** @type {*} */
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_err) {
      const preview = line.length > 100 ? line.slice(0, 100) + '...' : line;
      console.warn(`[jsonl-tailer] Malformed JSON, skipping: ${preview}`);
      return null;
    }

    // Must be a "message" type entry with nested usage
    if (!entry || entry.type !== 'message') return null;

    const msg = entry.message;
    if (!msg || typeof msg !== 'object') return null;

    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') return null;

    const cost = usage.cost;
    const stopReason = msg.stopReason || null;

    return {
      timestamp: entry.timestamp || null,
      input: usage.input || 0,
      output: usage.output || 0,
      cacheRead: usage.cacheRead || 0,
      cacheWrite: usage.cacheWrite || 0,
      cost: (cost && typeof cost === 'object' ? cost.total : 0) || 0,
      model: msg.model || null,
      provider: msg.provider || null,
      stopReason,
      toolNames: this._extractToolNames(msg.content),
      isError: stopReason === 'error' || !!msg.errorMessage,
    };
  }

  /**
   * Extract tool names from the message content array.
   *
   * Looks for items with `type: "toolCall"` (Claude) or `type: "tool_use"` (raw API)
   * and extracts the `.name` field from each.
   *
   * @param {Array<*>|undefined} content - The message.content array
   * @returns {string[]} Tool names in call order (may contain duplicates if a tool is called twice)
   * @private
   */
  _extractToolNames(content) {
    if (!Array.isArray(content)) return [];

    const names = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'toolCall' || item.type === 'tool_use') {
        if (typeof item.name === 'string') {
          names.push(item.name);
        }
      }
    }
    return names;
  }
}

module.exports = { JsonlTailer };

// ---------------------------------------------------------------------------
// Self-test (uncomment to run directly: node lib/usage/jsonl-tailer.js)
// ---------------------------------------------------------------------------
// (async () => {
//   const t = new JsonlTailer();
//   // First read — full scan from beginning
//   const result1 = await t.tail('/path/to/test.jsonl', null);
//   console.log('First read:', JSON.stringify(result1, null, 2));
//
//   // Incremental read — only new lines since last bookmark
//   const result2 = await t.tail('/path/to/test.jsonl', result1.newBookmark);
//   console.log('Incremental:', JSON.stringify(result2, null, 2));
// })();
