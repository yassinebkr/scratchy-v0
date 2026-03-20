'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Stores aggregated analytics rollups as JSON files.
 *
 * Layout:
 *   {dataDir}/rollups/hourly/{hourKey}.json
 *   {dataDir}/rollups/daily/{dateStr}.json
 */
class RollupStore {
  /**
   * @param {string} dataDir - Base analytics data directory.
   */
  constructor(dataDir) {
    /** @type {string} */
    this.hourlyDir = path.join(dataDir, 'rollups', 'hourly');
    /** @type {string} */
    this.dailyDir = path.join(dataDir, 'rollups', 'daily');
  }

  // ---------------------------------------------------------------------------
  // Hourly rollups
  // ---------------------------------------------------------------------------

  /**
   * Write an hourly rollup atomically.
   * @param {string} hourKey - e.g. "2026-02-23T11"
   * @param {object} rollup  - Aggregated rollup object.
   */
  writeHourly(hourKey, rollup) {
    this._writeAtomic(this.hourlyDir, `${hourKey}.json`, rollup);
  }

  /**
   * Read a single hourly rollup.
   * @param {string} hourKey
   * @returns {object|null}
   */
  readHourly(hourKey) {
    return this._readJson(path.join(this.hourlyDir, `${hourKey}.json`));
  }

  /**
   * Read all hourly rollups for a given date (up to 24).
   * @param {string} dateStr - e.g. "2026-02-23"
   * @returns {object[]}
   */
  readHourlyRange(dateStr) {
    const keys = this.listHourlyKeys(dateStr);
    const results = [];
    for (const key of keys) {
      const rollup = this.readHourly(key);
      if (rollup) results.push(rollup);
    }
    return results;
  }

  /**
   * List hourKey strings that exist for a given date.
   * @param {string} dateStr - e.g. "2026-02-23"
   * @returns {string[]}
   */
  listHourlyKeys(dateStr) {
    try {
      const files = fs.readdirSync(this.hourlyDir);
      return files
        .filter((f) => f.startsWith(dateStr) && f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
        .sort();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Daily rollups
  // ---------------------------------------------------------------------------

  /**
   * Write a daily rollup atomically.
   * @param {string} dateStr - e.g. "2026-02-23"
   * @param {object} rollup  - Aggregated daily rollup object.
   */
  writeDaily(dateStr, rollup) {
    this._writeAtomic(this.dailyDir, `${dateStr}.json`, rollup);
  }

  /**
   * Read a single daily rollup.
   * @param {string} dateStr
   * @returns {object|null}
   */
  readDaily(dateStr) {
    return this._readJson(path.join(this.dailyDir, `${dateStr}.json`));
  }

  /**
   * Read all daily rollups within a date range (inclusive).
   * @param {string} dateFrom - e.g. "2026-02-01"
   * @param {string} dateTo   - e.g. "2026-02-23"
   * @returns {object[]}
   */
  readDailyRange(dateFrom, dateTo) {
    try {
      const files = fs.readdirSync(this.dailyDir);
      const results = [];
      const sorted = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
        .filter((d) => d >= dateFrom && d <= dateTo)
        .sort();

      for (const dateStr of sorted) {
        const rollup = this.readDaily(dateStr);
        if (rollup) results.push(rollup);
      }
      return results;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Write JSON atomically: write to .tmp then rename.
   * @param {string} dir      - Target directory.
   * @param {string} filename - Target filename.
   * @param {object} data     - Data to serialise.
   * @private
   */
  _writeAtomic(dir, filename, data) {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, filename);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
  }

  /**
   * Read and parse a JSON file, returning null on missing or corrupt data.
   * @param {string} filePath
   * @returns {object|null}
   * @private
   */
  _readJson(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      console.error(`[RollupStore] Failed to read ${filePath}: ${err.message}`);
      return null;
    }
  }
}

module.exports = { RollupStore };
