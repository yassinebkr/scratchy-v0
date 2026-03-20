'use strict';

const SUBTYPE_TO_CATEGORY = {
  gateway_error: 'gateway',
  ws_error: 'ws',
  widget_error: 'widget',
  user_facing_error: 'user_facing',
};

const ERROR_SUBTYPES = new Set(Object.keys(SUBTYPE_TO_CATEGORY));

/**
 * Aggregates raw error analytics events into categorized statistics.
 */
class ErrorAggregator {
  /**
   * Process an array of analytics events and produce error statistics.
   * @param {Array<Object>} events - Raw analytics events (may include non-error events).
   * @returns {Object} Aggregated error statistics.
   */
  aggregate(events) {
    const totalEvents = events.length;
    const errorEvents = events.filter((e) => ERROR_SUBTYPES.has(e.subtype));
    const totalErrors = errorEvents.length;

    const byCategory = { gateway: 0, ws: 0, widget: 0, user_facing: 0 };
    const byErrorType = {};
    const byProvider = {};
    const byWidget = {};

    let gatewayCount = 0;
    let retryableCount = 0;
    let userFacingCount = 0;
    let recoverableCount = 0;

    /** @type {Array<{ts: number, subtype: string, errorType: string, message: string, userId: string|undefined}>} */
    const allRecent = [];

    /** @type {Map<string, {category: string, errorType: string, count: number}>} */
    const hotspotMap = new Map();

    for (const event of errorEvents) {
      const category = SUBTYPE_TO_CATEGORY[event.subtype];
      const meta = event.meta || {};

      byCategory[category]++;

      // Track errorType across all subtypes that have one
      const errorType = meta.errorType;
      if (errorType) {
        byErrorType[errorType] = (byErrorType[errorType] || 0) + 1;

        const hotKey = `${category}::${errorType}`;
        if (hotspotMap.has(hotKey)) {
          hotspotMap.get(hotKey).count++;
        } else {
          hotspotMap.set(hotKey, { category, errorType, count: 1 });
        }
      }

      // Category-specific processing
      if (event.subtype === 'gateway_error') {
        gatewayCount++;
        if (meta.provider) {
          byProvider[meta.provider] = (byProvider[meta.provider] || 0) + 1;
        }
        if (meta.retryable) {
          retryableCount++;
        }
      } else if (event.subtype === 'widget_error') {
        if (meta.widget) {
          byWidget[meta.widget] = (byWidget[meta.widget] || 0) + 1;
        }
      } else if (event.subtype === 'user_facing_error') {
        userFacingCount++;
        if (meta.recoverable) {
          recoverableCount++;
        }
      }

      // Collect for recent list
      allRecent.push({
        ts: event.ts || event.timestamp || 0,
        subtype: event.subtype,
        errorType: errorType || null,
        message: meta.message || meta.displayedMessage || null,
        userId: meta.userId || event.userId || undefined,
      });
    }

    // Last 10 errors sorted by timestamp descending
    allRecent.sort((a, b) => b.ts - a.ts);
    const recent = allRecent.slice(0, 10);

    // Top 5 hotspots
    const errorHotspots = Array.from(hotspotMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const retryableRate = gatewayCount > 0 ? retryableCount / gatewayCount : 0;
    const recoverableRate = userFacingCount > 0 ? recoverableCount / userFacingCount : 0;
    const errorRate = totalEvents > 0 ? totalErrors / totalEvents : null;

    return {
      totalErrors,
      byCategory,
      byErrorType,
      byProvider,
      byWidget,
      retryableRate,
      recoverableRate,
      errorRate,
      recent,
      errorHotspots,
    };
  }

  /**
   * Merge multiple hourly aggregation slices into a single daily rollup.
   * @param {Array<Object>} hourlySlices - Array of hourly aggregation results.
   * @returns {Object} Merged daily rollup.
   */
  mergeDailyRollup(hourlySlices) {
    if (!hourlySlices || hourlySlices.length === 0) {
      return this.aggregate([]);
    }

    let totalErrors = 0;
    const byCategory = { gateway: 0, ws: 0, widget: 0, user_facing: 0 };
    const byErrorType = {};
    const byProvider = {};
    const byWidget = {};
    let allRecent = [];

    /** @type {Map<string, {category: string, errorType: string, count: number}>} */
    const hotspotMap = new Map();

    for (const slice of hourlySlices) {
      totalErrors += slice.totalErrors || 0;

      // Merge byCategory
      if (slice.byCategory) {
        for (const [cat, count] of Object.entries(slice.byCategory)) {
          byCategory[cat] = (byCategory[cat] || 0) + count;
        }
      }

      // Merge byErrorType
      _mergeCounts(byErrorType, slice.byErrorType);

      // Merge byProvider
      _mergeCounts(byProvider, slice.byProvider);

      // Merge byWidget
      _mergeCounts(byWidget, slice.byWidget);

      // Collect recent entries
      if (slice.recent && slice.recent.length > 0) {
        allRecent = allRecent.concat(slice.recent);
      }
    }

    // Recent: keep last 10 by timestamp
    allRecent.sort((a, b) => b.ts - a.ts);
    const recent = allRecent.slice(0, 10);

    // Recompute rates from merged category totals
    const gatewayTotal = byCategory.gateway || 0;
    const userFacingTotal = byCategory.user_facing || 0;

    // Recompute retryable/recoverable from slices
    let retryableCount = 0;
    let recoverableCount = 0;
    for (const slice of hourlySlices) {
      const sliceGateway = (slice.byCategory && slice.byCategory.gateway) || 0;
      retryableCount += (slice.retryableRate || 0) * sliceGateway;

      const sliceUF = (slice.byCategory && slice.byCategory.user_facing) || 0;
      recoverableCount += (slice.recoverableRate || 0) * sliceUF;
    }

    const retryableRate = gatewayTotal > 0 ? retryableCount / gatewayTotal : 0;
    const recoverableRate = userFacingTotal > 0 ? recoverableCount / userFacingTotal : 0;

    // Recompute errorHotspots from merged byErrorType + byCategory
    // Rebuild from byErrorType with best-effort category mapping
    for (const [errType, count] of Object.entries(byErrorType)) {
      // Distribute across categories using slice hotspot data
      for (const slice of hourlySlices) {
        if (slice.errorHotspots) {
          for (const hs of slice.errorHotspots) {
            if (hs.errorType === errType) {
              const key = `${hs.category}::${hs.errorType}`;
              if (hotspotMap.has(key)) {
                hotspotMap.get(key).count += hs.count;
              } else {
                hotspotMap.set(key, { category: hs.category, errorType: hs.errorType, count: hs.count });
              }
            }
          }
        }
      }
    }

    const errorHotspots = Array.from(hotspotMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // errorRate: null if we can't determine total events from slices
    let errorRate = null;

    return {
      totalErrors,
      byCategory,
      byErrorType,
      byProvider,
      byWidget,
      retryableRate,
      recoverableRate,
      errorRate,
      recent,
      errorHotspots,
    };
  }
}

/**
 * Merge counts from a source dict into a target dict.
 * @param {Object} target - Target dictionary to merge into.
 * @param {Object} [source] - Source dictionary to merge from.
 */
function _mergeCounts(target, source) {
  if (!source) return;
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] || 0) + count;
  }
}

/**
 * Factory function to create a new ErrorAggregator instance.
 * @returns {ErrorAggregator}
 */
function createErrorAggregator() {
  return new ErrorAggregator();
}

module.exports = { ErrorAggregator, createErrorAggregator };
