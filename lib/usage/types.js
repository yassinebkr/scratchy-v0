'use strict';

// types.js — Pure data factory module for usage tracking.
// No dependencies. Every factory returns a fresh, fully-initialized object.

/**
 * Create an empty UsageBucket with all counters at zero.
 * @returns {UsageBucket}
 */
function createEmptyBucket() {
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
 * Create an empty ModelBucket for per-model tracking.
 * @returns {ModelBucket}
 */
function createEmptyModelBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
    messages: 0,
  };
}

/**
 * Create an empty ProviderBucket for per-provider tracking.
 * @returns {ProviderBucket}
 */
function createEmptyProviderBucket() {
  return {
    cost: 0,
    messages: 0,
    models: [],
  };
}

/**
 * Create an empty UserAggregate with cumulative bucket,
 * empty daily map, empty recent-hours array, and empty bookmarks.
 * @returns {UserAggregate}
 */
function createEmptyUserAggregate() {
  return {
    cumulative: createEmptyBucket(),
    daily: {},
    recentHours: [],
    bookmarks: {},
  };
}

/**
 * Create an empty top-level UsageAggregate.
 * @param {string} [timezone='Europe/Berlin'] - IANA timezone identifier
 * @returns {UsageAggregate}
 */
function createEmptyAggregate(timezone = 'Europe/Berlin') {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    timezone,
    users: {},
  };
}

module.exports = {
  createEmptyBucket,
  createEmptyModelBucket,
  createEmptyProviderBucket,
  createEmptyUserAggregate,
  createEmptyAggregate,
};
