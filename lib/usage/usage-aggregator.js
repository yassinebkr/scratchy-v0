'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// Lazy requires — resolved at runtime (modules built in parallel)
const getTypes = () => require('./types');
const getTZ = () => require('./timezone-helper');
const getStore = () => require('./usage-store');
const getTailer = () => require('./jsonl-tailer');
const getQuery = () => require('./usage-query');

/**
 * UsageAggregator — the main engine that ties everything together.
 *
 * Watches session JSONL files, incrementally tails new entries,
 * accumulates into per-user daily + cumulative buckets, and persists
 * the aggregate atomically. Extends EventEmitter; emits 'updated'
 * after each successful update cycle.
 *
 * @extends EventEmitter
 */
class UsageAggregator extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.timezone      — IANA timezone (e.g. "Europe/Berlin")
   * @param {string} opts.sessionsDir   — path to sessions directory
   * @param {string} opts.dataDir       — path to usage data directory
   * @param {string} [opts.adminUserId] — fallback userId for agent:main:main sessions
   */
  constructor({ timezone, sessionsDir, dataDir, adminUserId }) {
    super();

    /** @private */
    this._timezone = timezone || 'Europe/Berlin';
    /** @private */
    this._sessionsDir = sessionsDir;
    /** @private */
    this._dataDir = dataDir;
    /** @private */
    this._adminUserId = adminUserId || '_admin';

    /** @private @type {import('./timezone-helper').TimezoneHelper|null} */
    this._tz = null;
    /** @private @type {import('./usage-store').UsageStore|null} */
    this._store = null;
    /** @private @type {import('./jsonl-tailer').JsonlTailer|null} */
    this._tailer = null;
    /** @private @type {import('./usage-query').UsageQuery|null} */
    this._query = null;

    /** @private @type {fs.FSWatcher|null} */
    this._watcher = null;
    /** @private @type {ReturnType<typeof setTimeout>|null} */
    this._debounceTimer = null;
    /** @private */
    this._updating = false;
    /** @private */
    this._pendingUpdate = false;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Initialize the aggregator: instantiate helpers, load or build
   * the aggregate from scratch.
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      const { TimezoneHelper } = getTZ();
      const { UsageStore } = getStore();
      const { JsonlTailer } = getTailer();
      const { UsageQuery } = getQuery();

      this._tz = new TimezoneHelper(this._timezone);
      this._store = new UsageStore(this._dataDir);
      this._tailer = new JsonlTailer();
      this._query = new UsageQuery(this._store, this._tz);

      // Ensure data directory exists
      await this._store.init();

      // Load existing aggregate (or empty default)
      await this._store.load();

      const agg = this._store.getCached();

      // If there are no users yet, do a full scan
      if (!agg || !agg.users || Object.keys(agg.users).length === 0) {
        await this.update();
      }
    } catch (err) {
      console.error('[UsageAggregator] initialize failed:', err.message || err);
    }
  }

  /**
   * Incremental update: tail all session files for new entries,
   * accumulate into the aggregate, save atomically, emit 'updated'.
   * @returns {Promise<void>}
   */
  async update() {
    // Prevent concurrent updates; queue one follow-up at most
    if (this._updating) {
      this._pendingUpdate = true;
      return;
    }
    this._updating = true;

    try {
      await this._doUpdate();
    } catch (err) {
      console.error('[UsageAggregator] update failed:', err.message || err);
    } finally {
      this._updating = false;
      if (this._pendingUpdate) {
        this._pendingUpdate = false;
        // Yield to event loop then run queued update
        setImmediate(() => this.update().catch(() => {}));
      }
    }
  }

  /**
   * Internal update logic — separated for cleaner error handling.
   * @private
   * @returns {Promise<void>}
   */
  async _doUpdate() {
    const agg = this._store.getCached() || this._freshAggregate();

    // ── 1. Discover session files ──────────────────────────────────
    const sessionsJsonPath = path.join(this._sessionsDir, 'sessions.json');
    let sessionsMap = {};
    try {
      const raw = await fs.promises.readFile(sessionsJsonPath, 'utf8');
      sessionsMap = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[UsageAggregator] failed reading sessions.json:', err.message);
      }
      return; // Nothing to process
    }

    let changed = false;

    // ── 2. Process each session ────────────────────────────────────
    for (const [sessionKey, sessionObj] of Object.entries(sessionsMap)) {
      try {
        // Determine the JSONL file path
        const sessionId = (sessionObj && (sessionObj.sessionId || sessionObj.id)) || sessionKey;
        const filePath = path.join(this._sessionsDir, sessionId + '.jsonl');

        // Skip excluded files
        if (this._isExcluded(filePath)) continue;

        // Check file exists
        try {
          await fs.promises.access(filePath, fs.constants.R_OK);
        } catch (_) {
          continue; // File missing — skip
        }

        // Resolve userId from session key
        const userId = this._resolveUserId(sessionKey);
        if (!userId) continue;

        // Ensure user aggregate exists
        if (!agg.users[userId]) {
          agg.users[userId] = this._freshUserAggregate();
        }
        const userAgg = agg.users[userId];

        // Lookup bookmark for this session file
        const bookmarkKey = sessionId;
        const bookmark = (userAgg.bookmarks && userAgg.bookmarks[bookmarkKey]) || null;

        // Tail the file
        const { entries, newBookmark } = await this._tailer.tail(filePath, bookmark);

        if (!entries || entries.length === 0) {
          // Still save the bookmark so we don't re-scan unchanged files
          if (newBookmark) {
            userAgg.bookmarks[bookmarkKey] = newBookmark;
          }
          continue;
        }

        // ── 3. Accumulate entries ────────────────────────────────
        for (const entry of entries) {
          this._accumulateEntry(userAgg, entry);
        }

        // Save bookmark
        userAgg.bookmarks[bookmarkKey] = newBookmark;
        changed = true;
      } catch (err) {
        console.error('[UsageAggregator] error processing session', sessionKey, ':', err.message || err);
      }
    }

    // ── 4. Save and emit ────────────────────────────────────────────
    if (changed) {
      agg.lastUpdated = new Date().toISOString();
      agg.timezone = this._timezone;
      agg.version = 1;

      try {
        await this._store.save(agg);
      } catch (err) {
        console.error('[UsageAggregator] save failed:', err.message || err);
      }

      this.emit('updated');
    }
  }

  // ─── File watching ───────────────────────────────────────────────────

  /**
   * Start watching the sessions directory for changes.
   * Debounces at 2 seconds — multiple rapid writes collapse into one update.
   */
  startWatching() {
    if (this._watcher) return; // Already watching

    try {
      this._watcher = fs.watch(this._sessionsDir, { persistent: false }, (eventType, filename) => {
        // Only care about .jsonl changes
        if (!filename || !filename.endsWith('.jsonl')) return;
        if (this._isExcluded(filename)) return;

        this._scheduleUpdate();
      });

      this._watcher.on('error', (err) => {
        console.error('[UsageAggregator] fs.watch error:', err.message || err);
        // Try to recover by restarting the watcher
        this.stopWatching();
        setTimeout(() => {
          try {
            this.startWatching();
          } catch (_) { /* give up silently */ }
        }, 5000);
      });
    } catch (err) {
      console.error('[UsageAggregator] failed to start watcher:', err.message || err);
    }
  }

  /**
   * Stop watching the sessions directory.
   */
  stopWatching() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._watcher) {
      try {
        this._watcher.close();
      } catch (_) { /* ignore */ }
      this._watcher = null;
    }
  }

  /**
   * Schedule a debounced update (max once every 2 seconds).
   * @private
   */
  _scheduleUpdate() {
    if (this._debounceTimer) return; // Already scheduled

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.update().catch((err) => {
        console.error('[UsageAggregator] scheduled update failed:', err.message || err);
      });
    }, 2000);
  }

  // ─── Query accessor ─────────────────────────────────────────────────

  /**
   * Return the UsageQuery instance backed by this aggregator's store.
   * @returns {import('./usage-query').UsageQuery}
   */
  getQuery() {
    if (!this._query) {
      // Fallback: build one on demand
      const { UsageQuery } = getQuery();
      const { TimezoneHelper } = getTZ();
      this._query = new UsageQuery(
        this._store,
        this._tz || new TimezoneHelper(this._timezone)
      );
    }
    return this._query;
  }

  // ─── Internal helpers ────────────────────────────────────────────────

  /**
   * Check if a filename / path should be excluded from processing.
   * @private
   * @param {string} filePathOrName
   * @returns {boolean}
   */
  _isExcluded(filePathOrName) {
    const base = path.basename(filePathOrName);
    if (base.includes('.deleted.')) return true;
    if (base.includes('.backup')) return true;
    if (base.includes('.security-backup-')) return true;
    if (base.includes('.tmp')) return true;
    return false;
  }

  /**
   * Resolve a session key to a userId.
   *
   * Patterns:
   *   agent:main:main                 → adminUserId / '_admin'
   *   *:webchat:{userId}              → userId
   *   *:discord:{userId}              → userId
   *   *:telegram:{userId}             → userId
   *   *:subagent:{id}                 → '_subagent'
   *   *:cron:{id}                     → '_system'
   *
   * @private
   * @param {string} sessionKey
   * @returns {string|null}
   */
  _resolveUserId(sessionKey) {
    if (!sessionKey || typeof sessionKey !== 'string') return null;

    const parts = sessionKey.split(':');

    // agent:main:main → admin
    if (sessionKey === 'agent:main:main') {
      return this._adminUserId || '_admin';
    }

    // Match from the right: the second-to-last segment determines the channel
    // e.g. "agent:main:webchat:user123" → parts = ['agent','main','webchat','user123']
    // e.g. "main:webchat:user123"       → parts = ['main','webchat','user123']
    if (parts.length >= 3) {
      const channel = parts[parts.length - 2];
      const id = parts[parts.length - 1];

      switch (channel) {
        case 'webchat':
        case 'discord':
        case 'telegram':
          return id;
        case 'subagent':
          return '_subagent';
        case 'cron':
          return '_system';
      }
    }

    // Two-segment fallback for edge cases (e.g. "main:main")
    if (parts.length === 2 && parts[0] === 'main' && parts[1] === 'main') {
      return this._adminUserId || '_admin';
    }

    // Unknown pattern — attribute to _unknown
    return '_unknown';
  }

  /**
   * Accumulate a single parsed entry into a user's aggregate.
   * @private
   * @param {import('./SPEC').UserAggregate} userAgg
   * @param {import('./jsonl-tailer').ParsedEntry} entry
   */
  _accumulateEntry(userAgg, entry) {
    try {
      const timestamp = entry.timestamp;

      // Determine local date & hour
      const localDate = this._tz.toLocalDateString(timestamp);
      const localHour = this._tz.toLocalHourString(timestamp);

      // ── Daily bucket ───────────────────────────────────────────
      if (!userAgg.daily[localDate]) {
        userAgg.daily[localDate] = this._emptyBucket();
      }
      const daily = userAgg.daily[localDate];
      this._addToBucket(daily, entry, localHour);

      // ── Cumulative bucket ──────────────────────────────────────
      if (!userAgg.cumulative) {
        userAgg.cumulative = this._emptyBucket();
      }
      this._addToBucket(userAgg.cumulative, entry, localHour);

      // ── Recent hours (sliding window, last 2 hours) ────────────
      this._updateRecentHours(userAgg, localHour);
    } catch (err) {
      console.error('[UsageAggregator] accumulateEntry error:', err.message || err);
    }
  }

  /**
   * Add a parsed entry's data into a UsageBucket.
   * @private
   * @param {import('./SPEC').UsageBucket} bucket
   * @param {import('./jsonl-tailer').ParsedEntry} entry
   * @param {string} hourKey — "HH"
   */
  _addToBucket(bucket, entry, hourKey) {
    // Token counts
    bucket.inputTokens += entry.input || 0;
    bucket.outputTokens += entry.output || 0;
    bucket.cacheReadTokens += entry.cacheRead || 0;
    bucket.cacheWriteTokens += entry.cacheWrite || 0;
    bucket.totalTokens += (entry.input || 0) + (entry.output || 0) +
                          (entry.cacheRead || 0) + (entry.cacheWrite || 0);

    // Cost & message count
    bucket.cost += entry.cost || 0;
    bucket.messages += 1;

    // Error tracking
    if (entry.isError) {
      bucket.errorCount = (bucket.errorCount || 0) + 1;
    }

    // ── Per-model breakdown ──────────────────────────────────────
    if (entry.model) {
      if (!bucket.byModel) bucket.byModel = {};
      if (!bucket.byModel[entry.model]) {
        bucket.byModel[entry.model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
          messages: 0,
        };
      }
      const mb = bucket.byModel[entry.model];
      mb.inputTokens += entry.input || 0;
      mb.outputTokens += entry.output || 0;
      mb.cacheReadTokens += entry.cacheRead || 0;
      mb.cost += entry.cost || 0;
      mb.messages += 1;
    }

    // ── Per-provider breakdown ───────────────────────────────────
    if (entry.provider) {
      if (!bucket.byProvider) bucket.byProvider = {};
      if (!bucket.byProvider[entry.provider]) {
        bucket.byProvider[entry.provider] = {
          cost: 0,
          messages: 0,
          models: [],
        };
      }
      const pb = bucket.byProvider[entry.provider];
      pb.cost += entry.cost || 0;
      pb.messages += 1;

      // Track unique models per provider
      if (entry.model && !pb.models.includes(entry.model)) {
        pb.models.push(entry.model);
      }
    }

    // ── Tool usage ───────────────────────────────────────────────
    if (entry.toolNames && Array.isArray(entry.toolNames)) {
      if (!bucket.toolUsage) bucket.toolUsage = {};
      for (const toolName of entry.toolNames) {
        bucket.toolUsage[toolName] = (bucket.toolUsage[toolName] || 0) + 1;
      }
    }

    // ── Hourly activity ──────────────────────────────────────────
    if (hourKey) {
      if (!bucket.hourlyActivity) bucket.hourlyActivity = {};
      bucket.hourlyActivity[hourKey] = (bucket.hourlyActivity[hourKey] || 0) + 1;
    }
  }

  /**
   * Update the recentHours sliding window (keep only the last 2 local hours).
   * @private
   * @param {import('./SPEC').UserAggregate} userAgg
   * @param {string} hourKey — "HH" string
   */
  _updateRecentHours(userAgg, hourKey) {
    if (!userAgg.recentHours) {
      userAgg.recentHours = [];
    }

    const currentHour = this._tz.currentHourKey();

    // Calculate the previous hour
    const curNum = parseInt(currentHour, 10);
    const prevNum = (curNum - 1 + 24) % 24;
    const prevHour = String(prevNum).padStart(2, '0');

    // Find existing entry for this hourKey
    const existing = userAgg.recentHours.find((e) => e.hour === hourKey);
    if (existing) {
      existing.count += 1;
    } else {
      userAgg.recentHours.push({ hour: hourKey, count: 1 });
    }

    // Prune: keep only entries for current hour and previous hour
    userAgg.recentHours = userAgg.recentHours.filter(
      (e) => e.hour === currentHour || e.hour === prevHour
    );
  }

  /**
   * Return an empty UsageBucket.
   * @private
   * @returns {import('./SPEC').UsageBucket}
   */
  _emptyBucket() {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cost: 0,
      messages: 0,
      byModel: {},
      byProvider: {},
      toolUsage: {},
      hourlyActivity: {},
      errorCount: 0,
    };
  }

  /**
   * Return a fresh UserAggregate structure.
   * @private
   * @returns {import('./SPEC').UserAggregate}
   */
  _freshUserAggregate() {
    return {
      cumulative: this._emptyBucket(),
      daily: {},
      recentHours: [],
      bookmarks: {},
    };
  }

  /**
   * Return a fresh UsageAggregate structure.
   * @private
   * @returns {import('./SPEC').UsageAggregate}
   */
  _freshAggregate() {
    return {
      version: 1,
      lastUpdated: new Date().toISOString(),
      timezone: this._timezone,
      users: {},
    };
  }
}

module.exports = { UsageAggregator };
