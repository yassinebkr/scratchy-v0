'use strict';

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

/**
 * Drives periodic analytics aggregation: hourly and daily rollups.
 */
class RollupScheduler {
  /**
   * @param {object} eventStore   - EventStore instance (must have queryHour()).
   * @param {object} rollupStore  - RollupStore instance.
   * @param {object} aggregators  - Map of aggregator instances keyed by name
   *   e.g. { conversation, tool, error, user }. Each must implement
   *   aggregate(events) and mergeDailyRollup(hourlyRollups).
   * @param {object} [opts]
   * @param {number} [opts.hourlyIntervalMs=3600000] - Interval between hourly rollups.
   * @param {string} [opts.timezone='UTC']           - IANA timezone for date calculations.
   */
  constructor(eventStore, rollupStore, aggregators, opts = {}) {
    /** @type {object} */
    this.eventStore = eventStore;
    /** @type {object} */
    this.rollupStore = rollupStore;
    /** @type {object} */
    this.aggregators = aggregators;

    /** @type {number} */
    this.hourlyIntervalMs = opts.hourlyIntervalMs ?? MS_PER_HOUR;
    /** @type {string} */
    this.timezone = opts.timezone ?? 'UTC';

    /** @private */
    this._hourlyTimer = null;
    /** @private */
    this._dailyTimer = null;
    /** @private */
    this._running = false;
  }

  /**
   * Start periodic rollup scheduling.
   * Runs an hourly rollup immediately, then on interval.
   * Schedules a daily rollup at the next midnight.
   */
  start() {
    if (this._running) return;
    this._running = true;

    // Run hourly immediately, then schedule on interval.
    this._safeRunHourly();
    this._hourlyTimer = setInterval(() => this._safeRunHourly(), this.hourlyIntervalMs);
    this._hourlyTimer.unref();

    // Schedule daily rollup at next midnight.
    this._scheduleDailyAtMidnight();
  }

  /**
   * Stop all timers.
   */
  stop() {
    this._running = false;
    if (this._hourlyTimer) {
      clearInterval(this._hourlyTimer);
      this._hourlyTimer = null;
    }
    if (this._dailyTimer) {
      clearTimeout(this._dailyTimer);
      this._dailyTimer = null;
    }
  }

  /**
   * Run an hourly rollup for a specific hour.
   * @param {string} [hourKey] - e.g. "2026-02-23T11". Defaults to the current hour.
   */
  async runHourlyRollup(hourKey) {
    const key = hourKey ?? this._currentHourKey();
    await this._runHourlyRollup(key);
  }

  /**
   * Run a daily rollup for a specific date.
   * @param {string} [dateStr] - e.g. "2026-02-23". Defaults to yesterday.
   */
  async runDailyRollup(dateStr) {
    const ds = dateStr ?? this._yesterdayDateStr();
    await this._runDailyRollup(ds);
  }

  // ---------------------------------------------------------------------------
  // Internal: hourly
  // ---------------------------------------------------------------------------

  /**
   * Execute an hourly rollup: read events, aggregate, store.
   * @param {string} hourKey
   * @private
   */
  async _runHourlyRollup(hourKey) {
    const events = await this.eventStore.queryHour(hourKey);
    const rollup = { hourKey, createdAt: new Date().toISOString(), aggregations: {} };

    for (const [name, aggregator] of Object.entries(this.aggregators)) {
      try {
        rollup.aggregations[name] = aggregator.aggregate(events);
      } catch (err) {
        console.error(`[RollupScheduler] Hourly aggregator "${name}" failed for ${hourKey}:`, err.message);
        rollup.aggregations[name] = null;
      }
    }

    this.rollupStore.writeHourly(hourKey, rollup);
  }

  /** @private */
  _safeRunHourly() {
    const key = this._currentHourKey();
    this._runHourlyRollup(key).catch((err) => {
      console.error(`[RollupScheduler] Hourly rollup failed for ${key}:`, err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: daily
  // ---------------------------------------------------------------------------

  /**
   * Execute a daily rollup: read hourly rollups, merge, store.
   * @param {string} dateStr
   * @private
   */
  async _runDailyRollup(dateStr) {
    const hourlyRollups = this.rollupStore.readHourlyRange(dateStr);
    const rollup = { dateStr, createdAt: new Date().toISOString(), aggregations: {} };

    for (const [name, aggregator] of Object.entries(this.aggregators)) {
      try {
        if (typeof aggregator.mergeDailyRollup === 'function') {
          // Extract per-aggregator slices from each hourly rollup
          const slices = hourlyRollups
            .map(h => (h.aggregations || h)[name])
            .filter(Boolean);
          rollup.aggregations[name] = aggregator.mergeDailyRollup(slices);
        }
      } catch (err) {
        console.error(`[RollupScheduler] Daily aggregator "${name}" failed for ${dateStr}:`, err.message);
        rollup.aggregations[name] = null;
      }
    }

    this.rollupStore.writeDaily(dateStr, rollup);
  }

  /** @private */
  _safeRunDaily() {
    const dateStr = this._yesterdayDateStr();
    this._runDailyRollup(dateStr)
      .catch((err) => {
        console.error(`[RollupScheduler] Daily rollup failed for ${dateStr}:`, err.message);
      })
      .finally(() => {
        // Re-schedule for the next midnight.
        if (this._running) {
          this._scheduleDailyAtMidnight();
        }
      });
  }

  // ---------------------------------------------------------------------------
  // Internal: scheduling helpers
  // ---------------------------------------------------------------------------

  /**
   * Schedule the daily rollup to fire at the next midnight in the configured timezone.
   * @private
   */
  _scheduleDailyAtMidnight() {
    const msUntilMidnight = this._msUntilNextMidnight();
    this._dailyTimer = setTimeout(() => this._safeRunDaily(), msUntilMidnight);
    this._dailyTimer.unref();
  }

  /**
   * Compute milliseconds until the next midnight in the configured timezone.
   * @returns {number}
   * @private
   */
  _msUntilNextMidnight() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayStr = formatter.format(now); // "YYYY-MM-DD"

    // Build a Date for tomorrow 00:00 in the target timezone by computing offset.
    const tomorrowStr = this._addDays(todayStr, 1);
    // Get epoch ms for midnight tomorrow in the target tz.
    const midnightTomorrow = this._dateStrToEpoch(tomorrowStr);

    const diff = midnightTomorrow - now.getTime();
    // Guard: if diff <= 0 (clock skew etc.), default to MS_PER_DAY.
    return diff > 0 ? diff : MS_PER_DAY;
  }

  /**
   * Get the current hour key in the configured timezone.
   * @returns {string} e.g. "2026-02-23T11"
   * @private
   */
  _currentHourKey() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const hour = get('hour').padStart(2, '0');
    return `${date}T${hour}`;
  }

  /**
   * Get yesterday's date string in the configured timezone.
   * @returns {string} e.g. "2026-02-22"
   * @private
   */
  _yesterdayDateStr() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayStr = formatter.format(now);
    return this._addDays(todayStr, -1);
  }

  /**
   * Add days to a YYYY-MM-DD string.
   * @param {string} dateStr
   * @param {number} days
   * @returns {string}
   * @private
   */
  _addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Convert a YYYY-MM-DD to epoch ms at midnight in the configured timezone.
   * @param {string} dateStr
   * @returns {number}
   * @private
   */
  _dateStrToEpoch(dateStr) {
    // Create a date formatter that resolves the offset for the target tz.
    const opts = { timeZone: this.timezone, hour12: false };
    // Approximate: interpret dateStr as midnight UTC, then adjust.
    const utcMidnight = new Date(dateStr + 'T00:00:00Z');
    const utcStr = utcMidnight.toLocaleString('en-US', opts);
    const localAtUtcMidnight = new Date(utcStr);
    const offsetMs = localAtUtcMidnight.getTime() - utcMidnight.getTime();
    // midnight in target tz = utcMidnight - offset
    return utcMidnight.getTime() - offsetMs;
  }
}

/**
 * Factory for creating a RollupScheduler with default wiring.
 * @param {object} eventStore
 * @param {object} rollupStore
 * @param {object} aggregators
 * @param {object} [opts]
 * @returns {RollupScheduler}
 */
function createRollupScheduler(eventStore, rollupStore, aggregators, opts = {}) {
  return new RollupScheduler(eventStore, rollupStore, aggregators, opts);
}

module.exports = { RollupScheduler, createRollupScheduler };
