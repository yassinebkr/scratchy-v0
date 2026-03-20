'use strict';

/**
 * @typedef {Object} AnalyticsEvent
 * @property {string} id - Unique event identifier
 * @property {string} type - Event type (e.g. 'conversation', 'tool', 'error', 'session')
 * @property {string} subtype - Event subtype (e.g. 'user_message', 'assistant_response')
 * @property {number|string} ts - Timestamp
 * @property {string|null} userId - User identifier, null for system events
 * @property {string} sessionId - Session identifier
 * @property {Object} meta - Event metadata
 */

/**
 * @typedef {Object} UserStats
 * @property {number} messages - Count of conversation:user_message events
 * @property {number} responses - Count of conversation:assistant_response events
 * @property {number} toolCalls - Count of tool:tool_start events
 * @property {number} errors - Count of error:* events
 * @property {number} cost - Sum of assistant_response meta.cost
 * @property {string[]} features - Unique features from session:feature_use
 * @property {number[]} hourBuckets - Activity count per hour of day (0-23)
 * @property {number} peakHour - Hour with most activity
 * @property {number} activityScore - messages + toolCalls * 0.5
 * @property {string[]} sources - Unique message sources
 * @property {string[]} modelsUsed - Unique models from responses
 */

/**
 * @typedef {Object} TopUser
 * @property {string} userId
 * @property {number} activityScore
 * @property {number} messages
 * @property {number} cost
 */

/**
 * @typedef {Object} AggregateResult
 * @property {number} activeUsers - Number of unique active users
 * @property {Object<string, UserStats>} byUser - Per-user statistics
 * @property {TopUser[]} topUsers - Top 5 users by activityScore
 * @property {Object<string, number>} featureAdoption - Fraction of active users per feature
 */

/**
 * Aggregates analytics events to build per-user activity patterns.
 */
class UserAggregator {
  /**
   * Creates a fresh user stats object with zeroed counters.
   * @returns {UserStats}
   * @private
   */
  _createEmptyUserStats() {
    return {
      messages: 0,
      responses: 0,
      toolCalls: 0,
      errors: 0,
      cost: 0,
      features: [],
      hourBuckets: new Array(24).fill(0),
      peakHour: 0,
      activityScore: 0,
      sources: [],
      modelsUsed: [],
    };
  }

  /**
   * Processes an array of analytics events and returns per-user aggregated data.
   * @param {AnalyticsEvent[]} events - Array of analytics events
   * @returns {AggregateResult}
   */
  aggregate(events) {
    /** @type {Object<string, UserStats>} */
    const byUser = {};

    // Sets to track unique values per user before converting to arrays
    /** @type {Object<string, { features: Set<string>, sources: Set<string>, models: Set<string> }>} */
    const sets = {};

    for (const event of events) {
      if (event.userId == null) continue;

      const uid = event.userId;

      if (!byUser[uid]) {
        byUser[uid] = this._createEmptyUserStats();
        sets[uid] = { features: new Set(), sources: new Set(), models: new Set() };
      }

      const stats = byUser[uid];
      const userSets = sets[uid];
      const hour = new Date(event.ts).getHours();

      stats.hourBuckets[hour]++;

      if (event.type === 'conversation' && event.subtype === 'user_message') {
        stats.messages++;
        if (event.meta && event.meta.source) {
          userSets.sources.add(event.meta.source);
        }
      } else if (event.type === 'conversation' && event.subtype === 'assistant_response') {
        stats.responses++;
        if (event.meta) {
          if (typeof event.meta.cost === 'number') {
            stats.cost += event.meta.cost;
          }
          if (event.meta.model) {
            userSets.models.add(event.meta.model);
          }
        }
      } else if (event.type === 'tool' && event.subtype === 'tool_start') {
        stats.toolCalls++;
      } else if (event.type === 'error') {
        stats.errors++;
      } else if (event.type === 'session' && event.subtype === 'feature_use') {
        if (event.meta && event.meta.feature) {
          userSets.features.add(event.meta.feature);
        }
      }
    }

    // Finalize per-user stats: convert sets to arrays, compute derived fields
    for (const uid of Object.keys(byUser)) {
      const stats = byUser[uid];
      const userSets = sets[uid];

      stats.features = Array.from(userSets.features);
      stats.sources = Array.from(userSets.sources);
      stats.modelsUsed = Array.from(userSets.models);
      stats.activityScore = stats.messages + stats.toolCalls * 0.5;
      stats.peakHour = this._computePeakHour(stats.hourBuckets);
    }

    const activeUsers = Object.keys(byUser).length;
    const topUsers = this._computeTopUsers(byUser);
    const featureAdoption = this._computeFeatureAdoption(byUser, activeUsers);

    return { activeUsers, byUser, topUsers, featureAdoption };
  }

  /**
   * Merges multiple hourly aggregate slices into a single daily rollup.
   * @param {AggregateResult[]} hourlySlices - Array of hourly aggregate results
   * @returns {AggregateResult}
   */
  mergeDailyRollup(hourlySlices) {
    /** @type {Object<string, UserStats>} */
    const mergedByUser = {};

    /** @type {Object<string, { features: Set<string>, sources: Set<string>, models: Set<string> }>} */
    const mergedSets = {};

    for (const slice of hourlySlices) {
      if (!slice || !slice.byUser) continue;

      for (const [uid, stats] of Object.entries(slice.byUser)) {
        if (!mergedByUser[uid]) {
          mergedByUser[uid] = this._createEmptyUserStats();
          mergedSets[uid] = { features: new Set(), sources: new Set(), models: new Set() };
        }

        const merged = mergedByUser[uid];
        const mSets = mergedSets[uid];

        // Sum numeric fields
        merged.messages += stats.messages;
        merged.responses += stats.responses;
        merged.toolCalls += stats.toolCalls;
        merged.errors += stats.errors;
        merged.cost += stats.cost;

        // Sum hourBuckets element-wise
        for (let h = 0; h < 24; h++) {
          merged.hourBuckets[h] += (stats.hourBuckets[h] || 0);
        }

        // Union array fields
        if (stats.features) {
          for (const f of stats.features) mSets.features.add(f);
        }
        if (stats.sources) {
          for (const s of stats.sources) mSets.sources.add(s);
        }
        if (stats.modelsUsed) {
          for (const m of stats.modelsUsed) mSets.models.add(m);
        }
      }
    }

    // Finalize merged stats
    for (const uid of Object.keys(mergedByUser)) {
      const merged = mergedByUser[uid];
      const mSets = mergedSets[uid];

      merged.features = Array.from(mSets.features);
      merged.sources = Array.from(mSets.sources);
      merged.modelsUsed = Array.from(mSets.models);
      merged.activityScore = merged.messages + merged.toolCalls * 0.5;
      merged.peakHour = this._computePeakHour(merged.hourBuckets);
    }

    const activeUsers = Object.keys(mergedByUser).length;
    const topUsers = this._computeTopUsers(mergedByUser);
    const featureAdoption = this._computeFeatureAdoption(mergedByUser, activeUsers);

    return { activeUsers, byUser: mergedByUser, topUsers, featureAdoption };
  }

  /**
   * Finds the hour (0-23) with the highest activity count.
   * @param {number[]} hourBuckets - Array of 24 activity counts
   * @returns {number} The peak hour index
   * @private
   */
  _computePeakHour(hourBuckets) {
    let maxCount = 0;
    let peakHour = 0;
    for (let h = 0; h < 24; h++) {
      if (hourBuckets[h] > maxCount) {
        maxCount = hourBuckets[h];
        peakHour = h;
      }
    }
    return peakHour;
  }

  /**
   * Returns the top 5 users by activityScore.
   * @param {Object<string, UserStats>} byUser - Per-user stats map
   * @returns {TopUser[]}
   * @private
   */
  _computeTopUsers(byUser) {
    return Object.entries(byUser)
      .map(([userId, stats]) => ({
        userId,
        activityScore: stats.activityScore,
        messages: stats.messages,
        cost: stats.cost,
      }))
      .sort((a, b) => b.activityScore - a.activityScore)
      .slice(0, 5);
  }

  /**
   * Computes feature adoption as the fraction of active users who used each feature.
   * @param {Object<string, UserStats>} byUser - Per-user stats map
   * @param {number} activeUsers - Total number of active users
   * @returns {Object<string, number>} Feature name → adoption fraction (0-1)
   * @private
   */
  _computeFeatureAdoption(byUser, activeUsers) {
    if (activeUsers === 0) return {};

    /** @type {Object<string, number>} */
    const featureCounts = {};

    for (const stats of Object.values(byUser)) {
      for (const feature of stats.features) {
        featureCounts[feature] = (featureCounts[feature] || 0) + 1;
      }
    }

    /** @type {Object<string, number>} */
    const adoption = {};
    for (const [feature, count] of Object.entries(featureCounts)) {
      adoption[feature] = Math.round((count / activeUsers) * 1000) / 1000;
    }

    return adoption;
  }
}

/**
 * Factory function to create a new UserAggregator instance.
 * @returns {UserAggregator}
 */
function createUserAggregator() {
  return new UserAggregator();
}

module.exports = { UserAggregator, createUserAggregator };
