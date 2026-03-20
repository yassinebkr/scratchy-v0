'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lazy requires for sibling modules
const getTypes = () => require('./types');

/**
 * @typedef {Object} DailyUserSnapshot
 * @property {number} messages
 * @property {number} cost
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number, total: number }} tokens
 * @property {Array<{ name: string, count: number }>} topTools
 * @property {Array<{ name: string, count: number, cost: number }>} topModels
 * @property {Array<{ hour: string, count: number }>} peakHours
 * @property {number} cacheHitRatio
 * @property {number} errorRate
 * @property {number} avgTokensPerMsg
 */

/**
 * @typedef {Object} DailySnapshot
 * @property {string} date
 * @property {string} generatedAt
 * @property {Object<string, DailyUserSnapshot>} users
 * @property {{ messages: number, cost: number, tokens: { input: number, output: number, cacheRead: number, cacheWrite: number, total: number } }} totals
 */

/**
 * @typedef {Object} CostTrendEntry
 * @property {string} date
 * @property {number} totalCost
 * @property {Object<string, number>} byUser
 */

/**
 * @typedef {Object} AnomalyAlert
 * @property {string} metric
 * @property {number} today
 * @property {number} average
 * @property {number} ratio
 */

/**
 * @typedef {Object} AnomalyResult
 * @property {boolean} isAnomaly
 * @property {AnomalyAlert[]} alerts
 */

/**
 * @typedef {Object} UserTrendEntry
 * @property {string} date
 * @property {number} messages
 * @property {number} cost
 * @property {string|null} topModel
 * @property {string|null} topTool
 */

/**
 * @typedef {Object} PruneResult
 * @property {number} deletedDaily
 * @property {number} deletedWeekly
 */

/**
 * Generates daily/weekly/monthly analytics snapshots from usage aggregates.
 * Enables historical queries, cost forecasting, and anomaly detection.
 */
class AnalyticsSnapshots {
  /**
   * @param {Object} options
   * @param {string} options.dataDir - Path to analytics data directory (e.g. .scratchy-data/usage/analytics/)
   * @param {Object} options.timezoneHelper - TimezoneHelper instance for date conversions
   */
  constructor({ dataDir, timezoneHelper }) {
    this.dataDir = dataDir;
    this.timezoneHelper = timezoneHelper;
    this.dailyDir = path.join(dataDir, 'daily');
    this.weeklyDir = path.join(dataDir, 'weekly');
    this.monthlyDir = path.join(dataDir, 'monthly');
    this._dirsEnsured = false;
  }

  /**
   * Ensure all subdirectories exist. Called lazily on first write.
   * @returns {Promise<void>}
   */
  async _ensureDirs() {
    if (this._dirsEnsured) return;
    await fs.promises.mkdir(this.dailyDir, { recursive: true });
    await fs.promises.mkdir(this.weeklyDir, { recursive: true });
    await fs.promises.mkdir(this.monthlyDir, { recursive: true });
    this._dirsEnsured = true;
  }

  /**
   * Atomically write JSON data to a file using tmp+rename pattern.
   * @param {string} filePath - Destination file path
   * @param {Object} data - Data to serialize as JSON
   * @returns {Promise<void>}
   */
  async _atomicWrite(filePath, data) {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpFile = filePath + '.tmp.' + crypto.randomBytes(6).toString('hex');
    try {
      await fs.promises.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      await fs.promises.rename(tmpFile, filePath);
    } catch (err) {
      // Clean up tmp file on failure
      try { await fs.promises.unlink(tmpFile); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  /**
   * Safely read and parse a JSON file. Returns null if file missing or corrupt.
   * @param {string} filePath - Path to JSON file
   * @returns {Promise<Object|null>}
   */
  async _readJson(filePath) {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // Corrupt JSON — log and skip
      console.error(`[analytics-snapshots] Failed to read ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract a DailyUserSnapshot from a UsageBucket.
   * @param {import('./SPEC').UsageBucket} bucket - The usage bucket for a user on a given day
   * @returns {DailyUserSnapshot}
   */
  _extractUserSnapshot(bucket) {
    const messages = bucket.messages || 0;
    const cost = bucket.cost || 0;
    const inputTokens = bucket.inputTokens || 0;
    const outputTokens = bucket.outputTokens || 0;
    const cacheReadTokens = bucket.cacheReadTokens || 0;
    const cacheWriteTokens = bucket.cacheWriteTokens || 0;
    const totalTokens = bucket.totalTokens || 0;
    const errorCount = bucket.errorCount || 0;

    // Top 5 tools by call count
    const toolUsage = bucket.toolUsage || {};
    const topTools = Object.entries(toolUsage)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Top 3 models by message count
    const byModel = bucket.byModel || {};
    const topModels = Object.entries(byModel)
      .map(([name, m]) => ({ name, count: m.messages || 0, cost: m.cost || 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    // Peak hours sorted descending by count
    const hourlyActivity = bucket.hourlyActivity || {};
    const peakHours = Object.entries(hourlyActivity)
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => b.count - a.count);

    // Cache hit ratio: cacheRead / totalTokens
    const cacheHitRatio = totalTokens > 0 ? cacheReadTokens / totalTokens : 0;

    // Error rate: errorCount / messages
    const errorRate = messages > 0 ? errorCount / messages : 0;

    // Average tokens per message
    const avgTokensPerMsg = messages > 0 ? totalTokens / messages : 0;

    return {
      messages,
      cost,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        total: totalTokens,
      },
      topTools,
      topModels,
      peakHours,
      cacheHitRatio,
      errorRate,
      avgTokensPerMsg,
    };
  }

  /**
   * Save a daily analytics snapshot for a specific date.
   * @param {string} dateStr - Date string in "YYYY-MM-DD" format
   * @param {Array<{ userId: string, bucket: import('./SPEC').UsageBucket }>} allUsersData - Per-user usage buckets
   * @returns {Promise<void>}
   */
  async saveDailySnapshot(dateStr, allUsersData) {
    await this._ensureDirs();

    const users = {};
    const totals = {
      messages: 0,
      cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    for (const { userId, bucket } of allUsersData) {
      if (!bucket) continue;

      const userSnapshot = this._extractUserSnapshot(bucket);
      users[userId] = userSnapshot;

      // Accumulate totals
      totals.messages += userSnapshot.messages;
      totals.cost += userSnapshot.cost;
      totals.tokens.input += userSnapshot.tokens.input;
      totals.tokens.output += userSnapshot.tokens.output;
      totals.tokens.cacheRead += userSnapshot.tokens.cacheRead;
      totals.tokens.cacheWrite += userSnapshot.tokens.cacheWrite;
      totals.tokens.total += userSnapshot.tokens.total;
    }

    /** @type {DailySnapshot} */
    const snapshot = {
      date: dateStr,
      generatedAt: new Date().toISOString(),
      users,
      totals,
    };

    const filePath = path.join(this.dailyDir, `${dateStr}.json`);
    await this._atomicWrite(filePath, snapshot);
  }

  /**
   * Load a specific daily snapshot.
   * @param {string} dateStr - Date string in "YYYY-MM-DD" format
   * @returns {Promise<DailySnapshot|null>}
   */
  async getDailySnapshot(dateStr) {
    const filePath = path.join(this.dailyDir, `${dateStr}.json`);
    return this._readJson(filePath);
  }

  /**
   * Load a specific weekly snapshot.
   * @param {string} weekStr - ISO week string in "YYYY-Www" format (e.g. "2026-W08")
   * @returns {Promise<Object|null>}
   */
  async getWeeklySnapshot(weekStr) {
    const filePath = path.join(this.weeklyDir, `${weekStr}.json`);
    return this._readJson(filePath);
  }

  /**
   * Load a specific monthly snapshot.
   * @param {string} monthStr - Month string in "YYYY-MM" format
   * @returns {Promise<Object|null>}
   */
  async getMonthlySnapshot(monthStr) {
    const filePath = path.join(this.monthlyDir, `${monthStr}.json`);
    return this._readJson(filePath);
  }

  /**
   * Get the ISO week string ("YYYY-Www") for a given date string.
   * Uses ISO 8601 week numbering: weeks start on Monday,
   * week 1 is the week containing the first Thursday of the year.
   * @param {string} dateStr - Date string in "YYYY-MM-DD" format
   * @returns {string} ISO week string (e.g. "2026-W08")
   */
  _getISOWeekString(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC to avoid DST issues
    // ISO day of week: Mon=1 .. Sun=7
    const dayOfWeek = d.getUTCDay() || 7; // convert Sun(0) to 7
    // Set to nearest Thursday: current date + 4 - dayOfWeek
    d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
    // Get first day of year
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    // Calculate week number
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    const year = d.getUTCFullYear();
    return `${year}-W${String(weekNo).padStart(2, '0')}`;
  }

  /**
   * Get the 7 date strings (Mon-Sun) for a given ISO week string.
   * @param {string} weekStr - ISO week string (e.g. "2026-W08")
   * @returns {string[]} Array of 7 "YYYY-MM-DD" date strings
   */
  _getWeekDates(weekStr) {
    const match = weekStr.match(/^(\d{4})-W(\d{2})$/);
    if (!match) return [];

    const year = parseInt(match[1], 10);
    const week = parseInt(match[2], 10);

    // Find Jan 4 of that year (always in ISO week 1)
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4DayOfWeek = jan4.getUTCDay() || 7; // Mon=1, Sun=7

    // Monday of ISO week 1
    const week1Monday = new Date(jan4.getTime());
    week1Monday.setUTCDate(jan4.getUTCDate() - (jan4DayOfWeek - 1));

    // Monday of the target week
    const targetMonday = new Date(week1Monday.getTime());
    targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(targetMonday.getTime());
      d.setUTCDate(targetMonday.getUTCDate() + i);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      dates.push(`${yyyy}-${mm}-${dd}`);
    }
    return dates;
  }

  /**
   * Get all date strings in a given month.
   * @param {string} monthStr - Month string in "YYYY-MM" format
   * @returns {string[]} Array of "YYYY-MM-DD" date strings for every day in the month
   */
  _getMonthDates(monthStr) {
    const match = monthStr.match(/^(\d{4})-(\d{2})$/);
    if (!match) return [];

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10); // 1-12

    // Days in month: day 0 of next month = last day of this month
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const dates = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const mm = String(month).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      dates.push(`${year}-${mm}-${dd}`);
    }
    return dates;
  }

  /**
   * Merge multiple daily snapshots into a single aggregate structure.
   * @param {DailySnapshot[]} dailySnapshots - Array of daily snapshots
   * @returns {{ users: Object, totals: Object, dayCount: number }}
   */
  _mergeDailySnapshots(dailySnapshots) {
    const mergedUsers = {};
    const mergedTotals = {
      messages: 0,
      cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    let dayCount = 0;

    for (const snapshot of dailySnapshots) {
      if (!snapshot || !snapshot.users) continue;
      dayCount++;

      // Aggregate totals
      if (snapshot.totals) {
        mergedTotals.messages += snapshot.totals.messages || 0;
        mergedTotals.cost += snapshot.totals.cost || 0;
        if (snapshot.totals.tokens) {
          mergedTotals.tokens.input += snapshot.totals.tokens.input || 0;
          mergedTotals.tokens.output += snapshot.totals.tokens.output || 0;
          mergedTotals.tokens.cacheRead += snapshot.totals.tokens.cacheRead || 0;
          mergedTotals.tokens.cacheWrite += snapshot.totals.tokens.cacheWrite || 0;
          mergedTotals.tokens.total += snapshot.totals.tokens.total || 0;
        }
      }

      // Aggregate per-user data
      for (const [userId, userData] of Object.entries(snapshot.users)) {
        if (!mergedUsers[userId]) {
          mergedUsers[userId] = {
            messages: 0,
            cost: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            _toolCounts: {},
            _modelCounts: {},
            _modelCosts: {},
            _hourCounts: {},
            _totalErrorMessages: 0,
            _totalMessages: 0,
          };
        }

        const merged = mergedUsers[userId];
        merged.messages += userData.messages || 0;
        merged.cost += userData.cost || 0;
        merged._totalMessages += userData.messages || 0;

        if (userData.tokens) {
          merged.tokens.input += userData.tokens.input || 0;
          merged.tokens.output += userData.tokens.output || 0;
          merged.tokens.cacheRead += userData.tokens.cacheRead || 0;
          merged.tokens.cacheWrite += userData.tokens.cacheWrite || 0;
          merged.tokens.total += userData.tokens.total || 0;
        }

        // Accumulate tool counts
        if (userData.topTools) {
          for (const tool of userData.topTools) {
            merged._toolCounts[tool.name] = (merged._toolCounts[tool.name] || 0) + tool.count;
          }
        }

        // Accumulate model counts and costs
        if (userData.topModels) {
          for (const model of userData.topModels) {
            merged._modelCounts[model.name] = (merged._modelCounts[model.name] || 0) + model.count;
            merged._modelCosts[model.name] = (merged._modelCosts[model.name] || 0) + model.cost;
          }
        }

        // Accumulate hourly activity
        if (userData.peakHours) {
          for (const hour of userData.peakHours) {
            merged._hourCounts[hour.hour] = (merged._hourCounts[hour.hour] || 0) + hour.count;
          }
        }

        // Estimate error count from errorRate
        if (userData.errorRate && userData.messages) {
          merged._totalErrorMessages += Math.round(userData.errorRate * userData.messages);
        }
      }
    }

    // Finalize per-user aggregates
    const finalUsers = {};
    for (const [userId, merged] of Object.entries(mergedUsers)) {
      const totalTokens = merged.tokens.total;
      const messages = merged.messages;

      const topTools = Object.entries(merged._toolCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      const topModels = Object.entries(merged._modelCounts)
        .map(([name, count]) => ({
          name,
          count,
          cost: merged._modelCosts[name] || 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);

      const peakHours = Object.entries(merged._hourCounts)
        .map(([hour, count]) => ({ hour, count }))
        .sort((a, b) => b.count - a.count);

      finalUsers[userId] = {
        messages,
        cost: merged.cost,
        tokens: { ...merged.tokens },
        topTools,
        topModels,
        peakHours,
        cacheHitRatio: totalTokens > 0 ? merged.tokens.cacheRead / totalTokens : 0,
        errorRate: messages > 0 ? merged._totalErrorMessages / messages : 0,
        avgTokensPerMsg: messages > 0 ? totalTokens / messages : 0,
      };
    }

    return { users: finalUsers, totals: mergedTotals, dayCount };
  }

  /**
   * Generate a weekly rollup from daily snapshot files for a given ISO week.
   * Reads up to 7 daily files, aggregates, and saves as a weekly snapshot.
   * @param {string} weekStr - ISO week string (e.g. "2026-W08")
   * @returns {Promise<void>}
   */
  async generateWeeklyRollup(weekStr) {
    await this._ensureDirs();

    const dates = this._getWeekDates(weekStr);
    if (dates.length === 0) {
      console.error(`[analytics-snapshots] Invalid week string: ${weekStr}`);
      return;
    }

    const dailySnapshots = [];
    for (const dateStr of dates) {
      const snapshot = await this.getDailySnapshot(dateStr);
      if (snapshot) {
        dailySnapshots.push(snapshot);
      }
      // Missing daily files are skipped gracefully
    }

    if (dailySnapshots.length === 0) {
      // No data for this week at all — skip
      return;
    }

    const { users, totals, dayCount } = this._mergeDailySnapshots(dailySnapshots);

    const rollup = {
      week: weekStr,
      dateRange: { start: dates[0], end: dates[6] },
      generatedAt: new Date().toISOString(),
      daysWithData: dayCount,
      users,
      totals,
    };

    const filePath = path.join(this.weeklyDir, `${weekStr}.json`);
    await this._atomicWrite(filePath, rollup);
  }

  /**
   * Generate a monthly rollup from daily snapshot files for a given month.
   * Reads all daily files in the month, aggregates, and saves as a monthly snapshot.
   * @param {string} monthStr - Month string in "YYYY-MM" format (e.g. "2026-02")
   * @returns {Promise<void>}
   */
  async generateMonthlyRollup(monthStr) {
    await this._ensureDirs();

    const dates = this._getMonthDates(monthStr);
    if (dates.length === 0) {
      console.error(`[analytics-snapshots] Invalid month string: ${monthStr}`);
      return;
    }

    const dailySnapshots = [];
    for (const dateStr of dates) {
      const snapshot = await this.getDailySnapshot(dateStr);
      if (snapshot) {
        dailySnapshots.push(snapshot);
      }
      // Missing daily files are skipped gracefully
    }

    if (dailySnapshots.length === 0) {
      // No data for this month at all — skip
      return;
    }

    const { users, totals, dayCount } = this._mergeDailySnapshots(dailySnapshots);

    const rollup = {
      month: monthStr,
      generatedAt: new Date().toISOString(),
      daysWithData: dayCount,
      totalDaysInMonth: dates.length,
      users,
      totals,
    };

    const filePath = path.join(this.monthlyDir, `${monthStr}.json`);
    await this._atomicWrite(filePath, rollup);
  }

  /**
   * Get the cost trend over the last N days.
   * Returns an array of per-day cost breakdowns, sorted chronologically.
   * @param {number} [days=30] - Number of days to look back
   * @returns {Promise<CostTrendEntry[]>}
   */
  async getCostTrend(days = 30) {
    const today = this.timezoneHelper.today();
    const todayDate = new Date(today + 'T12:00:00Z');
    const results = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayDate.getTime());
      d.setUTCDate(d.getUTCDate() - i);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;

      const snapshot = await this.getDailySnapshot(dateStr);
      if (!snapshot) {
        // Include zero entries for missing days to maintain continuity
        results.push({ date: dateStr, totalCost: 0, byUser: {} });
        continue;
      }

      const byUser = {};
      if (snapshot.users) {
        for (const [userId, userData] of Object.entries(snapshot.users)) {
          byUser[userId] = userData.cost || 0;
        }
      }

      results.push({
        date: dateStr,
        totalCost: (snapshot.totals && snapshot.totals.cost) || 0,
        byUser,
      });
    }

    return results;
  }

  /**
   * Detect usage anomalies for a specific user by comparing today's usage
   * against the 7-day rolling average. Flags if any metric exceeds 3x the average.
   * @param {string} userId - User ID to check
   * @param {Array<{ userId: string, bucket: import('./SPEC').UsageBucket }>} allUsersData - Today's per-user usage data
   * @returns {Promise<AnomalyResult>}
   */
  async getAnomalies(userId, allUsersData) {
    const alerts = [];

    // Find today's data for this user
    const todayEntry = allUsersData.find(u => u.userId === userId);
    if (!todayEntry || !todayEntry.bucket) {
      return { isAnomaly: false, alerts: [] };
    }

    const todayBucket = todayEntry.bucket;
    const todayMessages = todayBucket.messages || 0;
    const todayCost = todayBucket.cost || 0;
    const todayTokens = todayBucket.totalTokens || 0;

    // Load last 7 days of daily snapshots (excluding today)
    const today = this.timezoneHelper.today();
    const todayDate = new Date(today + 'T12:00:00Z');

    let totalMessages = 0;
    let totalCost = 0;
    let totalTokens = 0;
    let daysWithData = 0;

    for (let i = 1; i <= 7; i++) {
      const d = new Date(todayDate.getTime());
      d.setUTCDate(d.getUTCDate() - i);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;

      const snapshot = await this.getDailySnapshot(dateStr);
      if (!snapshot || !snapshot.users || !snapshot.users[userId]) continue;

      const userData = snapshot.users[userId];
      totalMessages += userData.messages || 0;
      totalCost += userData.cost || 0;
      totalTokens += (userData.tokens && userData.tokens.total) || 0;
      daysWithData++;
    }

    // If no historical data, can't detect anomalies
    if (daysWithData === 0) {
      return { isAnomaly: false, alerts: [] };
    }

    const avgMessages = totalMessages / daysWithData;
    const avgCost = totalCost / daysWithData;
    const avgTokens = totalTokens / daysWithData;

    // Check messages
    if (avgMessages > 0 && todayMessages > 3 * avgMessages) {
      alerts.push({
        metric: 'messages',
        today: todayMessages,
        average: avgMessages,
        ratio: todayMessages / avgMessages,
      });
    }

    // Check cost
    if (avgCost > 0 && todayCost > 3 * avgCost) {
      alerts.push({
        metric: 'cost',
        today: todayCost,
        average: avgCost,
        ratio: todayCost / avgCost,
      });
    }

    // Check tokens
    if (avgTokens > 0 && todayTokens > 3 * avgTokens) {
      alerts.push({
        metric: 'tokens',
        today: todayTokens,
        average: avgTokens,
        ratio: todayTokens / avgTokens,
      });
    }

    return {
      isAnomaly: alerts.length > 0,
      alerts,
    };
  }

  /**
   * Get per-user daily breakdown for the last N days.
   * Returns daily messages, cost, top model, and top tool for the specified user.
   * @param {string} userId - User ID to query
   * @param {number} [days=7] - Number of days to look back
   * @returns {Promise<UserTrendEntry[]>}
   */
  async getUserTrend(userId, days = 7) {
    const today = this.timezoneHelper.today();
    const todayDate = new Date(today + 'T12:00:00Z');
    const results = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayDate.getTime());
      d.setUTCDate(d.getUTCDate() - i);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;

      const snapshot = await this.getDailySnapshot(dateStr);
      if (!snapshot || !snapshot.users || !snapshot.users[userId]) {
        results.push({
          date: dateStr,
          messages: 0,
          cost: 0,
          topModel: null,
          topTool: null,
        });
        continue;
      }

      const userData = snapshot.users[userId];
      const topModel = (userData.topModels && userData.topModels.length > 0)
        ? userData.topModels[0].name
        : null;
      const topTool = (userData.topTools && userData.topTools.length > 0)
        ? userData.topTools[0].name
        : null;

      results.push({
        date: dateStr,
        messages: userData.messages || 0,
        cost: userData.cost || 0,
        topModel,
        topTool,
      });
    }

    return results;
  }

  /**
   * Format a Date object as "YYYY-MM-DD" (UTC).
   * @param {Date} d
   * @returns {string}
   */
  _formatDateUTC(d) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Prune old snapshot files to conserve disk space.
   * - Deletes daily files older than retainDailyDays
   * - Deletes weekly files older than retainWeeklyMonths
   * - Monthly files are kept forever
   * @param {number} [retainDailyDays=90] - Number of days to retain daily snapshots
   * @param {number} [retainWeeklyMonths=12] - Number of months to retain weekly snapshots
   * @returns {Promise<PruneResult>}
   */
  async pruneOldSnapshots(retainDailyDays = 90, retainWeeklyMonths = 12) {
    let deletedDaily = 0;
    let deletedWeekly = 0;

    const today = this.timezoneHelper.today();
    const todayDate = new Date(today + 'T12:00:00Z');

    // Prune daily files
    try {
      const dailyFiles = await fs.promises.readdir(this.dailyDir);
      const cutoffDate = new Date(todayDate.getTime());
      cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retainDailyDays);

      for (const file of dailyFiles) {
        if (!file.endsWith('.json')) continue;
        const dateStr = file.replace('.json', '');
        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

        const fileDate = new Date(dateStr + 'T12:00:00Z');
        if (fileDate < cutoffDate) {
          try {
            await fs.promises.unlink(path.join(this.dailyDir, file));
            deletedDaily++;
          } catch (err) {
            console.error(`[analytics-snapshots] Failed to delete daily file ${file}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[analytics-snapshots] Failed to read daily directory: ${err.message}`);
      }
    }

    // Prune weekly files
    try {
      const weeklyFiles = await fs.promises.readdir(this.weeklyDir);
      // Cutoff: go back retainWeeklyMonths months from today
      const cutoffMonthDate = new Date(todayDate.getTime());
      cutoffMonthDate.setUTCMonth(cutoffMonthDate.getUTCMonth() - retainWeeklyMonths);

      for (const file of weeklyFiles) {
        if (!file.endsWith('.json')) continue;
        const weekStr = file.replace('.json', '');
        // Validate week format
        if (!/^\d{4}-W\d{2}$/.test(weekStr)) continue;

        // Get the Monday of this week to determine its age
        const weekDates = this._getWeekDates(weekStr);
        if (weekDates.length === 0) continue;

        const weekStart = new Date(weekDates[0] + 'T12:00:00Z');
        if (weekStart < cutoffMonthDate) {
          try {
            await fs.promises.unlink(path.join(this.weeklyDir, file));
            deletedWeekly++;
          } catch (err) {
            console.error(`[analytics-snapshots] Failed to delete weekly file ${file}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[analytics-snapshots] Failed to read weekly directory: ${err.message}`);
      }
    }

    return { deletedDaily, deletedWeekly };
  }
}

module.exports = { AnalyticsSnapshots };
