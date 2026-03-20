'use strict';

// Lazy requires — resolved at runtime (modules built in parallel)
const getTypes = () => require('./types');
const getTZ = () => require('./timezone-helper');
const getStore = () => require('./usage-store');

/**
 * UsageQuery — the SINGLE synchronous interface for all usage data consumers.
 *
 * Every method reads from store.getCached() (in-memory). Zero file I/O in
 * the query path. Used by both the dashboard API and quota enforcement.
 */
class UsageQuery {
  /**
   * @param {import('./usage-store').UsageStore} store
   * @param {import('./timezone-helper').TimezoneHelper} timezoneHelper
   */
  constructor(store, timezoneHelper) {
    /** @private */
    this._store = store;
    /** @private */
    this._tz = timezoneHelper;
  }

  // ─── Internal helpers ────────────────────────────────────────────────

  /**
   * Return the in-memory aggregate (synchronous).
   * @private
   * @returns {import('./SPEC').UsageAggregate}
   */
  _agg() {
    return this._store.getCached() || { version: 1, users: {} };
  }

  /**
   * Return a UserAggregate for a given userId, or a blank one.
   * @private
   * @param {string} userId
   * @returns {import('./SPEC').UserAggregate}
   */
  _user(userId) {
    const agg = this._agg();
    return agg.users && agg.users[userId]
      ? agg.users[userId]
      : { cumulative: this._emptyBucket(), daily: {}, recentHours: [], bookmarks: {} };
  }

  /**
   * Return an empty UsageBucket with all counters zeroed.
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

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Get today's usage bucket for a user (local timezone).
   * @param {string} userId
   * @returns {import('./SPEC').UsageBucket}
   */
  getTodayUsage(userId) {
    const today = this._tz.today();
    return this.getDailyUsage(userId, today);
  }

  /**
   * Get the cumulative (all-time) usage bucket for a user.
   * @param {string} userId
   * @returns {import('./SPEC').UsageBucket}
   */
  getCumulativeUsage(userId) {
    const user = this._user(userId);
    return user.cumulative || this._emptyBucket();
  }

  /**
   * Get usage for a specific local date ("YYYY-MM-DD").
   * @param {string} userId
   * @param {string} dateStr — "YYYY-MM-DD"
   * @returns {import('./SPEC').UsageBucket}
   */
  getDailyUsage(userId, dateStr) {
    const user = this._user(userId);
    return (user.daily && user.daily[dateStr]) || this._emptyBucket();
  }

  /**
   * Get an array of {date, bucket} for every day in [fromDate, toDate].
   * Missing days return an empty bucket.
   * @param {string} userId
   * @param {string} fromDate — "YYYY-MM-DD"
   * @param {string} toDate   — "YYYY-MM-DD"
   * @returns {Array<{date: string, bucket: import('./SPEC').UsageBucket}>}
   */
  getDateRange(userId, fromDate, toDate) {
    const user = this._user(userId);
    const results = [];

    // Walk day-by-day using simple date arithmetic
    const start = new Date(fromDate + 'T00:00:00');
    const end = new Date(toDate + 'T00:00:00');

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return results;
    }

    const cursor = new Date(start);
    while (cursor <= end) {
      const ds = cursor.toISOString().slice(0, 10);
      results.push({
        date: ds,
        bucket: (user.daily && user.daily[ds]) || this._emptyBucket(),
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    return results;
  }

  /**
   * Get the number of messages sent today by a user.
   * Used for daily message quota enforcement.
   * @param {string} userId
   * @returns {number}
   */
  getMessagesToday(userId) {
    return this.getTodayUsage(userId).messages;
  }

  /**
   * Get the number of tokens consumed today by a user.
   * Used for daily token quota enforcement.
   * @param {string} userId
   * @returns {number}
   */
  getTokensToday(userId) {
    return this.getTodayUsage(userId).totalTokens;
  }

  /**
   * Get the number of messages sent in the current local hour by a user.
   * Reads from the recentHours array for fast rate-limit checks.
   * @param {string} userId
   * @returns {number}
   */
  getMessagesThisHour(userId) {
    const user = this._user(userId);
    const currentHour = this._tz.currentHourKey();

    if (!user.recentHours || !Array.isArray(user.recentHours)) {
      return 0;
    }

    for (const entry of user.recentHours) {
      if (entry.hour === currentHour) {
        return entry.count || 0;
      }
    }

    return 0;
  }

  /**
   * Get total USD cost incurred today by a user.
   * @param {string} userId
   * @returns {number}
   */
  getCostToday(userId) {
    return this.getTodayUsage(userId).cost;
  }

  /**
   * Get a summary for every tracked user.
   * @returns {Array<{userId: string, today: import('./SPEC').UsageBucket, cumulative: import('./SPEC').UsageBucket}>}
   */
  getAllUsers() {
    const agg = this._agg();
    const today = this._tz.today();
    const result = [];

    if (!agg.users) return result;

    for (const userId of Object.keys(agg.users)) {
      const user = agg.users[userId];
      result.push({
        userId,
        today: (user.daily && user.daily[today]) || this._emptyBucket(),
        cumulative: user.cumulative || this._emptyBucket(),
      });
    }

    return result;
  }

  /**
   * Aggregate provider-level statistics across ALL users (all-time cumulative).
   * @returns {Object<string, {cost: number, messages: number, models: string[]}>}
   */
  getProviderBreakdown() {
    const agg = this._agg();
    /** @type {Object<string, {cost: number, messages: number, models: Set<string>}>} */
    const providers = {};

    if (!agg.users) return {};

    for (const userId of Object.keys(agg.users)) {
      const cum = agg.users[userId].cumulative;
      if (!cum || !cum.byProvider) continue;

      for (const provider of Object.keys(cum.byProvider)) {
        const pb = cum.byProvider[provider];
        if (!providers[provider]) {
          providers[provider] = { cost: 0, messages: 0, models: new Set() };
        }
        providers[provider].cost += pb.cost || 0;
        providers[provider].messages += pb.messages || 0;
        if (Array.isArray(pb.models)) {
          for (const m of pb.models) providers[provider].models.add(m);
        }
      }
    }

    // Convert Sets → arrays for serialization
    const out = {};
    for (const p of Object.keys(providers)) {
      out[p] = {
        cost: providers[p].cost,
        messages: providers[p].messages,
        models: Array.from(providers[p].models),
      };
    }

    return out;
  }

  /**
   * Compute analytics for a user over the last N days.
   * @param {string} userId
   * @param {number} [days=7]
   * @returns {{avgMsgsPerDay: number, avgCostPerDay: number, topTools: string[], topModels: string[], peakHours: string[]}}
   */
  getUserAnalytics(userId, days = 7) {
    const today = this._tz.today();
    const end = new Date(today + 'T00:00:00');
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    const fromDate = start.toISOString().slice(0, 10);

    const range = this.getDateRange(userId, fromDate, today);

    let totalMsgs = 0;
    let totalCost = 0;
    /** @type {Object<string, number>} */
    const toolCounts = {};
    /** @type {Object<string, number>} */
    const modelCounts = {};
    /** @type {Object<string, number>} */
    const hourCounts = {};

    for (const { bucket } of range) {
      totalMsgs += bucket.messages;
      totalCost += bucket.cost;

      // Aggregate tool usage
      if (bucket.toolUsage) {
        for (const [tool, count] of Object.entries(bucket.toolUsage)) {
          toolCounts[tool] = (toolCounts[tool] || 0) + count;
        }
      }

      // Aggregate model usage
      if (bucket.byModel) {
        for (const [model, mb] of Object.entries(bucket.byModel)) {
          modelCounts[model] = (modelCounts[model] || 0) + (mb.messages || 0);
        }
      }

      // Aggregate hourly activity
      if (bucket.hourlyActivity) {
        for (const [hour, count] of Object.entries(bucket.hourlyActivity)) {
          hourCounts[hour] = (hourCounts[hour] || 0) + count;
        }
      }
    }

    const daysCount = range.length || 1;

    // Sort and pick top entries
    const topTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    const topModels = Object.entries(modelCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    const peakHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour]) => hour);

    return {
      avgMsgsPerDay: totalMsgs / daysCount,
      avgCostPerDay: totalCost / daysCount,
      topTools,
      topModels,
      peakHours,
    };
  }
}

module.exports = { UsageQuery };
