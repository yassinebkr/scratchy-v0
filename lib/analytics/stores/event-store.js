'use strict';

const fs = require('fs');
const path = require('path');

/**
 * EventStore — Raw analytics event storage as JSONL files, date-partitioned by type.
 *
 * Storage layout:
 *   {dataDir}/events/{YYYY-MM-DD}/{type}.jsonl
 */
class EventStore {
  /**
   * @param {string} dataDir - Base analytics directory (e.g. `.scratchy-data/analytics`)
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.eventsDir = path.join(dataDir, 'events');
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Full path to a date directory.
   * @param {string} dateStr - "YYYY-MM-DD"
   * @returns {string}
   */
  _datePath(dateStr) {
    return path.join(this.eventsDir, dateStr);
  }

  /**
   * Full path to a JSONL file for a given date and event type.
   * @param {string} dateStr - "YYYY-MM-DD"
   * @param {string} type - Event type (e.g. "conversation", "tool")
   * @returns {string}
   */
  _filePath(dateStr, type) {
    return path.join(this.eventsDir, dateStr, `${type}.jsonl`);
  }

  /**
   * Ensure a directory exists (recursive).
   * @param {string} dirPath
   */
  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Read a JSONL file, applying an optional filter function and limit.
   * Corrupt lines are skipped gracefully.
   * @param {string} filePath
   * @param {Function|null} filterFn - Optional filter predicate `(event) => boolean`
   * @param {number} limit - Max events to return
   * @returns {object[]}
   */
  _readJsonl(filePath, filterFn, limit) {
    const results = [];
    if (!fs.existsSync(filePath)) {
      return results;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`[EventStore] Failed to read ${filePath}: ${err.message}`);
      return results;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= limit) break;

      const line = lines[i].trim();
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        console.error(`[EventStore] Corrupt line in ${filePath}:${i + 1}, skipping`);
        continue;
      }

      if (filterFn && !filterFn(event)) continue;
      results.push(event);
    }

    return results;
  }

  /**
   * Today's date as "YYYY-MM-DD".
   * @returns {string}
   */
  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Extract "YYYY-MM-DD" from an ISO timestamp.
   * @param {string} ts - ISO timestamp
   * @returns {string}
   */
  _dateFromTs(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  /**
   * List all JSONL type files in a date directory.
   * @param {string} dateStr
   * @returns {string[]} - Type names (without .jsonl extension)
   */
  _listTypes(dateStr) {
    const dir = this._datePath(dateStr);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace(/\.jsonl$/, ''));
    } catch (err) {
      console.error(`[EventStore] Failed to list types for ${dateStr}: ${err.message}`);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  /**
   * Append an event to the correct JSONL file based on event.type and event.ts.
   * @param {object} event - Must have `type` and `ts` properties.
   */
  append(event) {
    if (!event || !event.type || !event.ts) {
      console.error('[EventStore] append: event must have type and ts');
      return;
    }

    const dateStr = this._dateFromTs(event.ts);
    const dirPath = this._datePath(dateStr);
    this._ensureDir(dirPath);

    const filePath = this._filePath(dateStr, event.type);
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(filePath, line, 'utf8');
  }

  /**
   * Query events with filters.
   * @param {object} [opts={}]
   * @param {string} [opts.type] - Filter by event type
   * @param {string} [opts.subtype] - Filter by event subtype
   * @param {string} [opts.userId] - Filter by userId
   * @param {string} [opts.dateFrom] - Start date "YYYY-MM-DD" (inclusive, defaults to today)
   * @param {string} [opts.dateTo] - End date "YYYY-MM-DD" (inclusive, defaults to today)
   * @param {number} [opts.limit=1000] - Max results (capped at 10000)
   * @returns {object[]}
   */
  query(opts = {}) {
    const today = this._todayStr();
    const dateFrom = opts.dateFrom || today;
    const dateTo = opts.dateTo || today;
    let limit = opts.limit || 1000;
    if (limit > 10000) limit = 10000;

    const filterFn = (event) => {
      if (opts.type && event.type !== opts.type) return false;
      if (opts.subtype && event.subtype !== opts.subtype) return false;
      if (opts.userId && event.userId !== opts.userId) return false;
      return true;
    };

    const results = [];
    const dateDirs = this._getDateRange(dateFrom, dateTo);

    for (const dateStr of dateDirs) {
      if (results.length >= limit) break;

      const types = opts.type ? [opts.type] : this._listTypes(dateStr);
      for (const type of types) {
        if (results.length >= limit) break;
        const filePath = this._filePath(dateStr, type);
        const remaining = limit - results.length;
        const events = this._readJsonl(filePath, filterFn, remaining);
        results.push(...events);
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Read all events for a specific hour.
   * @param {string} hourKey - Format: "YYYY-MM-DDTHH" (e.g. "2026-02-23T11")
   * @returns {object[]}
   */
  queryHour(hourKey) {
    const dateStr = hourKey.slice(0, 10);
    const hour = parseInt(hourKey.slice(11), 10);

    const filterFn = (event) => {
      if (!event.ts) return false;
      const eventHour = new Date(event.ts).getUTCHours();
      return eventHour === hour;
    };

    const results = [];
    const types = this._listTypes(dateStr);

    for (const type of types) {
      const filePath = this._filePath(dateStr, type);
      const events = this._readJsonl(filePath, filterFn, 10000);
      results.push(...events);
    }

    return results;
  }

  /**
   * Read all events for a specific day.
   * @param {string} dateStr - Format: "YYYY-MM-DD"
   * @returns {object[]}
   */
  queryDay(dateStr) {
    const results = [];
    const types = this._listTypes(dateStr);

    for (const type of types) {
      const filePath = this._filePath(dateStr, type);
      const events = this._readJsonl(filePath, null, 10000);
      results.push(...events);
    }

    return results;
  }

  /**
   * List all date directories in the events folder.
   * @returns {string[]} - Sorted array of date strings ("YYYY-MM-DD")
   */
  getDateDirs() {
    if (!fs.existsSync(this.eventsDir)) return [];

    try {
      return fs.readdirSync(this.eventsDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
    } catch (err) {
      console.error(`[EventStore] Failed to list date dirs: ${err.message}`);
      return [];
    }
  }

  /**
   * Remove an entire date directory (for retention cleanup).
   * @param {string} dateStr - Format: "YYYY-MM-DD"
   */
  deleteDate(dateStr) {
    const dirPath = this._datePath(dateStr);
    if (!fs.existsSync(dirPath)) return;

    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (err) {
      console.error(`[EventStore] Failed to delete ${dateStr}: ${err.message}`);
    }
  }

  /**
   * Get stats about the event store.
   * @returns {{ totalEvents: number, oldestDate: string|null, newestDate: string|null, sizeBytes: number }}
   */
  getStats() {
    const dates = this.getDateDirs();
    let totalEvents = 0;
    let sizeBytes = 0;

    for (const dateStr of dates) {
      const dirPath = this._datePath(dateStr);
      let files;
      try {
        files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      } catch (err) {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          sizeBytes += stat.size;

          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n').filter(l => l.trim().length > 0);
          totalEvents += lines.length;
        } catch (err) {
          console.error(`[EventStore] Failed to stat ${filePath}: ${err.message}`);
        }
      }
    }

    return {
      totalEvents,
      oldestDate: dates.length > 0 ? dates[0] : null,
      newestDate: dates.length > 0 ? dates[dates.length - 1] : null,
      sizeBytes,
    };
  }

  // ---------------------------------------------------------------------------
  // Private utilities
  // ---------------------------------------------------------------------------

  /**
   * Generate an array of date strings between dateFrom and dateTo (inclusive).
   * @param {string} dateFrom - "YYYY-MM-DD"
   * @param {string} dateTo - "YYYY-MM-DD"
   * @returns {string[]}
   */
  _getDateRange(dateFrom, dateTo) {
    const dates = [];
    const start = new Date(dateFrom + 'T00:00:00Z');
    const end = new Date(dateTo + 'T00:00:00Z');

    const current = new Date(start);
    while (current <= end) {
      dates.push(current.toISOString().slice(0, 10));
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
  }
}

module.exports = { EventStore };
