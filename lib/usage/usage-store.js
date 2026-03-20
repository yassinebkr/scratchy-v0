'use strict';

// usage-store.js — Persistent storage for the UsageAggregate.
// Reads/writes a single JSON file with atomic tmp+rename saves.
// Only Node.js built-ins (fs, path). No external deps.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createEmptyAggregate } = require('./types');

/** Default data directory (relative to cwd) */
const DEFAULT_DATA_DIR = '.scratchy-data/usage';

/** Aggregate filename within dataDir */
const AGGREGATE_FILENAME = 'usage-aggregate.json';

class UsageStore {
  /**
   * @param {string} [dataDir='.scratchy-data/usage/'] - Directory for aggregate file
   */
  constructor(dataDir = DEFAULT_DATA_DIR) {
    /** @type {string} */
    this.dataDir = dataDir;

    /** @type {string} Full path to the aggregate JSON file */
    this.filePath = path.join(dataDir, AGGREGATE_FILENAME);

    /**
     * In-memory cache. null = cold (never loaded from disk yet).
     * @private
     * @type {UsageAggregate|null}
     */
    this._cache = null;

    /**
     * Whether the on-disk file has been read at least once.
     * @private
     * @type {boolean}
     */
    this._loaded = false;
  }

  // ---------------------------------------------------------------------------
  // Initialisation — ensure dataDir exists
  // ---------------------------------------------------------------------------

  /**
   * Ensure the data directory exists. Call once at startup.
   * @returns {Promise<void>}
   */
  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Synchronous cache accessor. On the very first call (cold start),
   * reads from disk synchronously so callers can use the data immediately
   * without await. All subsequent calls return the in-memory copy.
   *
   * @returns {UsageAggregate}
   */
  getCached() {
    if (!this._loaded) {
      // Cold start — synchronous read
      this._cache = this._readSync();
      this._loaded = true;
    }
    return this._cache;
  }

  /**
   * Async load — always reads fresh from disk (for picking up external edits).
   * Updates the in-memory cache.
   *
   * @returns {Promise<UsageAggregate>}
   */
  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      this._cache = data;
      this._loaded = true;
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File doesn't exist yet — return fresh aggregate
        const empty = createEmptyAggregate();
        this._cache = empty;
        this._loaded = true;
        return empty;
      }
      // Corrupt JSON or other I/O error
      console.error(`[UsageStore] Failed to load ${this.filePath}: ${err.message}`);
      const empty = createEmptyAggregate();
      this._cache = empty;
      this._loaded = true;
      return empty;
    }
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Atomically save the aggregate to disk.
   * Writes to a temporary file first, then renames (atomic on same filesystem).
   * Also updates the in-memory cache.
   *
   * @param {UsageAggregate} aggregate
   * @returns {Promise<void>}
   */
  async save(aggregate) {
    // Ensure dataDir exists (idempotent)
    await fsp.mkdir(this.dataDir, { recursive: true });

    // Stamp the save time
    aggregate.lastUpdated = new Date().toISOString();

    const json = JSON.stringify(aggregate, null, 2);
    const tmpPath = `${this.filePath}.tmp.${process.pid}`;

    try {
      await fsp.writeFile(tmpPath, json, 'utf8');
      await fsp.rename(tmpPath, this.filePath);
      // Update in-memory cache
      this._cache = aggregate;
      this._loaded = true;
    } catch (err) {
      console.error(`[UsageStore] Failed to save ${this.filePath}: ${err.message}`);
      // Attempt cleanup of stale tmp file
      try { await fsp.unlink(tmpPath); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Cache control
  // ---------------------------------------------------------------------------

  /**
   * Invalidate the in-memory cache so the next getCached() or load()
   * will re-read from disk.
   */
  invalidateCache() {
    this._cache = null;
    this._loaded = false;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Synchronously read and parse the aggregate file.
   * Returns an empty aggregate on any error (missing file, corrupt JSON, etc.).
   * @private
   * @returns {UsageAggregate}
   */
  _readSync() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[UsageStore] Cold-start read failed for ${this.filePath}: ${err.message}`);
      }
      return createEmptyAggregate();
    }
  }
}

module.exports = { UsageStore };
