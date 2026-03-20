'use strict';

/**
 * Compute the average of a numeric array.
 * @param {number[]} arr
 * @returns {number}
 */
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

/**
 * Compute the p-th percentile of a numeric array.
 * @param {number[]} arr
 * @param {number} p - Percentile (0–100).
 * @returns {number}
 */
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Aggregates raw tool analytics events into usage statistics.
 */
class ToolAggregator {
  /**
   * Aggregate an array of analytics events into tool usage statistics.
   * @param {Array<{subtype: string, meta: object}>} events
   * @returns {object} Aggregated tool statistics.
   */
  aggregate(events) {
    const starts = events.filter(e => e.subtype === 'tool_start');
    const ends = events.filter(e => e.subtype === 'tool_end');
    const errors = events.filter(e => e.subtype === 'tool_error');

    const totalToolCalls = starts.length;
    const totalErrors = errors.length;

    // Collect per-tool data from starts
    /** @type {Map<string, {calls: number, durations: number[], successes: number, failures: number, errorBreakdown: Map<string, number>}>} */
    const toolMap = new Map();

    const ensureTool = (name) => {
      if (!toolMap.has(name)) {
        toolMap.set(name, {
          calls: 0,
          durations: [],
          successes: 0,
          failures: 0,
          errorBreakdown: new Map(),
        });
      }
      return toolMap.get(name);
    };

    for (const ev of starts) {
      const name = ev.meta && ev.meta.toolName;
      if (!name) continue;
      ensureTool(name).calls++;
    }

    for (const ev of ends) {
      const { toolName, durationMs, success } = ev.meta || {};
      if (!toolName) continue;
      const entry = ensureTool(toolName);
      if (typeof durationMs === 'number') entry.durations.push(durationMs);
      if (success) {
        entry.successes++;
      } else {
        entry.failures++;
      }
    }

    for (const ev of errors) {
      const { toolName, durationMs, errorType } = ev.meta || {};
      if (!toolName) continue;
      const entry = ensureTool(toolName);
      if (typeof durationMs === 'number') entry.durations.push(durationMs);
      entry.failures++;
      const et = errorType || 'unknown';
      entry.errorBreakdown.set(et, (entry.errorBreakdown.get(et) || 0) + 1);
    }

    const successfulEnds = ends.filter(e => e.meta && e.meta.success).length;
    const overallSuccessRate = totalToolCalls > 0 ? successfulEnds / totalToolCalls : 0;

    // Build byTool
    const byTool = {};
    for (const [name, data] of toolMap) {
      const errBreakdown = {};
      for (const [et, count] of data.errorBreakdown) {
        errBreakdown[et] = count;
      }
      byTool[name] = {
        totalCalls: data.calls,
        successes: data.successes,
        failures: data.failures,
        successRate: data.calls > 0 ? data.successes / data.calls : 0,
        avgDurationMs: avg(data.durations),
        p95DurationMs: percentile(data.durations, 95),
        errorBreakdown: errBreakdown,
      };
    }

    // mostUsed: top 5 by call count
    const mostUsed = Object.entries(byTool)
      .sort((a, b) => b[1].totalCalls - a[1].totalCalls)
      .slice(0, 5)
      .map(([name]) => name);

    // slowest: top 5 by avg duration
    const slowest = Object.entries(byTool)
      .filter(([, v]) => v.avgDurationMs > 0)
      .sort((a, b) => b[1].avgDurationMs - a[1].avgDurationMs)
      .slice(0, 5)
      .map(([name]) => name);

    // errorHotspots: top 5 tool+errorType combos
    const hotspotMap = new Map();
    for (const ev of errors) {
      const { toolName, errorType } = ev.meta || {};
      if (!toolName) continue;
      const key = `${toolName}::${errorType || 'unknown'}`;
      hotspotMap.set(key, (hotspotMap.get(key) || 0) + 1);
    }
    const errorHotspots = [...hotspotMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => {
        const [tool, errorType] = key.split('::');
        return { tool, errorType, count };
      });

    return {
      totalToolCalls,
      totalErrors,
      overallSuccessRate,
      byTool,
      mostUsed,
      slowest,
      errorHotspots,
    };
  }

  /**
   * Merge an array of hourly aggregate slices into a single daily rollup.
   * @param {object[]} hourlySlices - Array of objects matching the aggregate() output shape.
   * @returns {object} Merged daily aggregate.
   */
  mergeDailyRollup(hourlySlices) {
    if (!hourlySlices || !hourlySlices.length) {
      return {
        totalToolCalls: 0,
        totalErrors: 0,
        overallSuccessRate: 0,
        byTool: {},
        mostUsed: [],
        slowest: [],
        errorHotspots: [],
      };
    }

    let totalToolCalls = 0;
    let totalErrors = 0;
    let totalSuccesses = 0;

    /** @type {Map<string, {totalCalls: number, successes: number, failures: number, durations: number[], errorBreakdown: Map<string, number>}>} */
    const mergedTools = new Map();
    /** @type {Map<string, number>} */
    const hotspotAccum = new Map();

    for (const slice of hourlySlices) {
      totalToolCalls += slice.totalToolCalls || 0;
      totalErrors += slice.totalErrors || 0;

      // Accumulate successes from byTool
      for (const [name, data] of Object.entries(slice.byTool || {})) {
        if (!mergedTools.has(name)) {
          mergedTools.set(name, {
            totalCalls: 0,
            successes: 0,
            failures: 0,
            durationSums: 0,
            durationCounts: 0,
            allAvgs: [],
            errorBreakdown: new Map(),
          });
        }
        const entry = mergedTools.get(name);
        entry.totalCalls += data.totalCalls || 0;
        entry.successes += data.successes || 0;
        entry.failures += data.failures || 0;
        // Weighted avg: accumulate sum and count
        if (data.avgDurationMs > 0 && data.totalCalls > 0) {
          entry.durationSums += data.avgDurationMs * data.totalCalls;
          entry.durationCounts += data.totalCalls;
        }
        // Collect per-slice avgs for rough p95 estimation
        if (data.p95DurationMs > 0) {
          entry.allAvgs.push(data.p95DurationMs);
        }
        for (const [et, count] of Object.entries(data.errorBreakdown || {})) {
          entry.errorBreakdown.set(et, (entry.errorBreakdown.get(et) || 0) + count);
        }
      }

      // Merge errorHotspots
      for (const hs of (slice.errorHotspots || [])) {
        const key = `${hs.tool}::${hs.errorType}`;
        hotspotAccum.set(key, (hotspotAccum.get(key) || 0) + hs.count);
      }
    }

    // Compute overall success rate from merged byTool successes
    for (const data of mergedTools.values()) {
      totalSuccesses += data.successes;
    }
    const overallSuccessRate = totalToolCalls > 0 ? totalSuccesses / totalToolCalls : 0;

    // Build merged byTool
    const byTool = {};
    for (const [name, data] of mergedTools) {
      const errBreakdown = {};
      for (const [et, count] of data.errorBreakdown) {
        errBreakdown[et] = count;
      }
      byTool[name] = {
        totalCalls: data.totalCalls,
        successes: data.successes,
        failures: data.failures,
        successRate: data.totalCalls > 0 ? data.successes / data.totalCalls : 0,
        avgDurationMs: data.durationCounts > 0 ? data.durationSums / data.durationCounts : 0,
        p95DurationMs: percentile(data.allAvgs, 95),
        errorBreakdown: errBreakdown,
      };
    }

    const mostUsed = Object.entries(byTool)
      .sort((a, b) => b[1].totalCalls - a[1].totalCalls)
      .slice(0, 5)
      .map(([name]) => name);

    const slowest = Object.entries(byTool)
      .filter(([, v]) => v.avgDurationMs > 0)
      .sort((a, b) => b[1].avgDurationMs - a[1].avgDurationMs)
      .slice(0, 5)
      .map(([name]) => name);

    const errorHotspots = [...hotspotAccum.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => {
        const [tool, errorType] = key.split('::');
        return { tool, errorType, count };
      });

    return {
      totalToolCalls,
      totalErrors,
      overallSuccessRate,
      byTool,
      mostUsed,
      slowest,
      errorHotspots,
    };
  }
}

/**
 * Factory function to create a new ToolAggregator instance.
 * @returns {ToolAggregator}
 */
function createToolAggregator() {
  return new ToolAggregator();
}

module.exports = { ToolAggregator, createToolAggregator };
