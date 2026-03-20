'use strict';

// --- Helper functions ---

/**
 * Average of a number array. Returns 0 for empty.
 * @param {number[]} arr
 * @returns {number}
 */
function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return sum(arr) / arr.length;
}

/**
 * Sum of a number array.
 * @param {number[]} arr
 * @returns {number}
 */
function sum(arr) {
  if (!arr || arr.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < arr.length; i++) total += arr[i];
  return total;
}

/**
 * Compute the p-th percentile of a number array (0-100). Returns 0 for empty.
 * @param {number[]} arr
 * @param {number} p - percentile (0-100)
 * @returns {number}
 */
function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const frac = idx - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

/**
 * Weighted average across slices for a given field, weighted by weightField.
 * @param {object[]} slices
 * @param {string} field
 * @param {string} weightField
 * @returns {number}
 */
function weightedAvg(slices, field, weightField) {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const s of slices) {
    const w = s[weightField] || 0;
    const v = s[field] || 0;
    weightedSum += v * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

// --- Aggregator class ---

class ConversationAggregator {
  /**
   * Aggregate raw conversation events into summary statistics.
   * @param {Array<{id: string, type: string, subtype: string, ts: number, userId: string, sessionId: string, meta: object}>} events
   * @returns {object} Aggregated conversation statistics
   */
  aggregate(events) {
    const convEvents = events.filter(e => e.type === 'conversation');

    const userMsgs = convEvents.filter(e => e.subtype === 'user_message');
    const assistantMsgs = convEvents.filter(e => e.subtype === 'assistant_response');

    const userLengths = userMsgs.map(e => (e.meta && e.meta.length) || 0);
    const assistantLengths = assistantMsgs.map(e => (e.meta && e.meta.length) || 0);

    // Response times: from assistant_response meta.responseTimeMs
    const responseTimes = assistantMsgs
      .map(e => e.meta && e.meta.responseTimeMs)
      .filter(v => typeof v === 'number' && v >= 0);

    // Cost and token aggregation from assistant responses
    const costs = assistantMsgs.map(e => (e.meta && e.meta.cost) || 0);
    const inputTokens = assistantMsgs.map(e => (e.meta && e.meta.inputTokens) || 0);
    const outputTokens = assistantMsgs.map(e => (e.meta && e.meta.outputTokens) || 0);
    const cacheTokens = assistantMsgs.map(e => {
      if (!e.meta) return 0;
      return ((e.meta.cacheReadTokens || 0) + (e.meta.cacheWriteTokens || 0));
    });

    // Unique models
    const modelSet = new Set();
    for (const e of assistantMsgs) {
      if (e.meta && e.meta.model) modelSet.add(e.meta.model);
    }

    // Canvas response rate
    const canvasResponses = assistantMsgs.filter(
      e => e.meta && e.meta.hasCanvasOps
    ).length;
    const canvasResponseRate = assistantMsgs.length > 0
      ? canvasResponses / assistantMsgs.length
      : 0;

    // bySource: count user messages by meta.source
    const bySource = {};
    for (const e of userMsgs) {
      const src = (e.meta && e.meta.source) || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }

    // byModel: { model: { calls, cost, avgLatency } }
    const byModel = {};
    for (const e of assistantMsgs) {
      const model = (e.meta && e.meta.model) || 'unknown';
      if (!byModel[model]) {
        byModel[model] = { calls: 0, cost: 0, _latencies: [] };
      }
      byModel[model].calls += 1;
      byModel[model].cost += (e.meta && e.meta.cost) || 0;
      if (e.meta && typeof e.meta.responseTimeMs === 'number') {
        byModel[model]._latencies.push(e.meta.responseTimeMs);
      }
    }
    // Finalize byModel: compute avgLatency, remove internal _latencies
    for (const model of Object.keys(byModel)) {
      byModel[model].avgLatency = avg(byModel[model]._latencies);
      delete byModel[model]._latencies;
    }

    return {
      totalMessages: userMsgs.length + assistantMsgs.length,
      userMessages: userMsgs.length,
      assistantMessages: assistantMsgs.length,
      avgUserLength: avg(userLengths),
      avgAssistantLength: avg(assistantLengths),
      avgResponseTimeMs: avg(responseTimes),
      p95ResponseTimeMs: percentile(responseTimes, 95),
      totalCost: sum(costs),
      totalInputTokens: sum(inputTokens),
      totalOutputTokens: sum(outputTokens),
      totalCacheTokens: sum(cacheTokens),
      modelsUsed: [...modelSet],
      canvasResponseRate,
      bySource,
      byModel,
    };
  }

  /**
   * Merge an array of hourly aggregate slices into a single daily rollup.
   * Sums numeric fields, computes weighted averages, merges dictionaries.
   * @param {object[]} hourlySlices - Array of hourly aggregate objects (output of aggregate())
   * @returns {object} Merged daily aggregate
   */
  mergeDailyRollup(hourlySlices) {
    if (!hourlySlices || hourlySlices.length === 0) {
      return this.aggregate([]);
    }

    const totalMessages = sum(hourlySlices.map(s => s.totalMessages));
    const userMessages = sum(hourlySlices.map(s => s.userMessages));
    const assistantMessages = sum(hourlySlices.map(s => s.assistantMessages));

    const avgUserLength = weightedAvg(hourlySlices, 'avgUserLength', 'userMessages');
    const avgAssistantLength = weightedAvg(hourlySlices, 'avgAssistantLength', 'assistantMessages');
    const avgResponseTimeMs = weightedAvg(hourlySlices, 'avgResponseTimeMs', 'assistantMessages');

    // p95 can't be perfectly merged from hourly p95s; use weighted avg as best approximation
    const p95ResponseTimeMs = weightedAvg(hourlySlices, 'p95ResponseTimeMs', 'assistantMessages');

    const totalCost = sum(hourlySlices.map(s => s.totalCost));
    const totalInputTokens = sum(hourlySlices.map(s => s.totalInputTokens));
    const totalOutputTokens = sum(hourlySlices.map(s => s.totalOutputTokens));
    const totalCacheTokens = sum(hourlySlices.map(s => s.totalCacheTokens));

    // Union modelsUsed
    const modelSet = new Set();
    for (const s of hourlySlices) {
      if (s.modelsUsed) {
        for (const m of s.modelsUsed) modelSet.add(m);
      }
    }

    // Recompute canvasResponseRate from totals
    // We need to derive canvas count from rate * assistantMessages per slice
    let totalCanvasResponses = 0;
    for (const s of hourlySlices) {
      totalCanvasResponses += (s.canvasResponseRate || 0) * (s.assistantMessages || 0);
    }
    const canvasResponseRate = assistantMessages > 0
      ? totalCanvasResponses / assistantMessages
      : 0;

    // Merge bySource
    const bySource = {};
    for (const s of hourlySlices) {
      if (!s.bySource) continue;
      for (const [src, count] of Object.entries(s.bySource)) {
        bySource[src] = (bySource[src] || 0) + count;
      }
    }

    // Merge byModel
    const byModel = {};
    for (const s of hourlySlices) {
      if (!s.byModel) continue;
      for (const [model, data] of Object.entries(s.byModel)) {
        if (!byModel[model]) {
          byModel[model] = { calls: 0, cost: 0, _weightedLatency: 0 };
        }
        byModel[model].calls += data.calls || 0;
        byModel[model].cost += data.cost || 0;
        byModel[model]._weightedLatency += (data.avgLatency || 0) * (data.calls || 0);
      }
    }
    for (const model of Object.keys(byModel)) {
      byModel[model].avgLatency = byModel[model].calls > 0
        ? byModel[model]._weightedLatency / byModel[model].calls
        : 0;
      delete byModel[model]._weightedLatency;
    }

    return {
      totalMessages,
      userMessages,
      assistantMessages,
      avgUserLength,
      avgAssistantLength,
      avgResponseTimeMs,
      p95ResponseTimeMs,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      modelsUsed: [...modelSet],
      canvasResponseRate,
      bySource,
      byModel,
    };
  }
}

/**
 * Factory function to create a ConversationAggregator instance.
 * @returns {ConversationAggregator}
 */
function createConversationAggregator() {
  return new ConversationAggregator();
}

module.exports = { ConversationAggregator, createConversationAggregator };
