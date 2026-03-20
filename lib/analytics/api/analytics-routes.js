'use strict';

/**
 * Analytics REST API Routes
 * 
 * Provides RESTful endpoints for analytics data access including:
 * - Overview aggregations across time ranges
 * - Conversation metrics and filtering
 * - Tool usage analytics 
 * - Error tracking and trends
 * - User activity and feature adoption
 * - System health monitoring
 */

/**
 * Create analytics routes handler
 * @param {Object} deps - Dependencies object
 * @param {EventStore} deps.eventStore - Event storage interface
 * @param {RollupStore} deps.rollupStore - Rollup data interface  
 * @param {AnalyticsEventBus} deps.eventBus - Event bus interface
 * @param {Object} deps.aggregators - Aggregator instances (conversation, tool, error, user)
 * @returns {Function} handleRequest function
 */
function createAnalyticsRoutes(deps) {
  const { eventStore, rollupStore, eventBus, aggregators } = deps;

  /**
   * Parse time range parameter into date boundaries
   * @param {string} rangeStr - Range specification (24h, 7d, 30d)
   * @returns {Object} { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', hours: number }
   */
  function parseRange(rangeStr) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    switch (rangeStr) {
      case '24h':
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        return {
          from: yesterday.toISOString().split('T')[0],
          to: today,
          hours: 24
        };
        
      case '7d':
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return {
          from: weekAgo.toISOString().split('T')[0],
          to: today,
          hours: 7 * 24
        };
        
      case '30d':
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return {
          from: monthAgo.toISOString().split('T')[0],
          to: today,
          hours: 30 * 24
        };
        
      default:
        // Default to 7d for invalid ranges
        const defaultWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return {
          from: defaultWeekAgo.toISOString().split('T')[0],
          to: today,
          hours: 7 * 24
        };
    }
  }

  /**
   * Build hourly time series from rollup data
   * @param {RollupStore} rollupStore - Rollup storage interface
   * @param {string} from - Start date YYYY-MM-DD
   * @param {string} to - End date YYYY-MM-DD
   * @param {string} domain - Data domain (conversation, tool, etc.)
   * @returns {Array} Array of hourly data points
   */
  function buildTimeSeries(rollupStore, from, to, domain) {
    try {
      const series = [];
      const fromDate = new Date(from);
      const toDate = new Date(to);
      
      // Generate hourly points for the range
      for (let d = new Date(fromDate); d <= toDate; d.setHours(d.getHours() + 1)) {
        const hourKey = d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
        const rollup = rollupStore.readHourly(hourKey);
        
        if (rollup && rollup.aggregations && rollup.aggregations[domain]) {
          const data = rollup.aggregations[domain];
          series.push({
            hour: hourKey,
            ...extractTimeSeriesData(data, domain)
          });
        } else {
          // Fill missing hours with zeros
          series.push({
            hour: hourKey,
            ...getZeroTimeSeriesData(domain)
          });
        }
      }
      
      return series;
    } catch (error) {
      console.error('[Analytics] Error building time series:', error);
      return [];
    }
  }

  /**
   * Extract relevant time series data from aggregation
   * @param {Object} data - Aggregated data
   * @param {string} domain - Data domain
   * @returns {Object} Time series point data
   */
  function extractTimeSeriesData(data, domain) {
    switch (domain) {
      case 'conversation':
        return {
          messages: data.totalMessages || 0,
          cost: data.totalCost || 0,
          avgResponseMs: data.avgResponseTimeMs || 0
        };
      case 'tool':
        return {
          calls: data.totalToolCalls || 0,
          errors: data.totalErrors || 0,
          successRate: data.overallSuccessRate || 0
        };
      case 'error':
        return {
          errors: data.totalErrors || 0,
          errorRate: data.errorRate || 0
        };
      case 'user':
        return {
          activeUsers: data.activeUsers || 0
        };
      default:
        return {};
    }
  }

  /**
   * Get zero-filled time series data for missing hours
   * @param {string} domain - Data domain
   * @returns {Object} Zero-filled data
   */
  function getZeroTimeSeriesData(domain) {
    switch (domain) {
      case 'conversation':
        return { messages: 0, cost: 0, avgResponseMs: 0 };
      case 'tool':
        return { calls: 0, errors: 0, successRate: 0 };
      case 'error':
        return { errors: 0, errorRate: 0 };
      case 'user':
        return { activeUsers: 0 };
      default:
        return {};
    }
  }

  /**
   * Send JSON response
   * @param {ServerResponse} res - HTTP response object
   * @param {number} statusCode - HTTP status code
   * @param {Object} data - Response data
   */
  function sendJson(res, statusCode, data) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Send error response
   * @param {ServerResponse} res - HTTP response object
   * @param {number} statusCode - HTTP status code
   * @param {string} message - Error message
   */
  function sendError(res, statusCode, message) {
    sendJson(res, statusCode, { error: message });
  }

  /**
   * Check if user has admin access
   * @param {Object} authResult - Authentication result
   * @returns {boolean} True if user has admin access
   */
  function isAdmin(authResult) {
    return authResult && authResult.user && 
           (authResult.user.role === 'admin' || authResult.isLegacy);
  }

  /**
   * Handle overview endpoint - aggregated metrics across time ranges
   */
  async function handleOverview(req, res, url, authResult) {
    if (!isAdmin(authResult)) {
      return sendError(res, 403, 'Admin access required');
    }

    try {
      const range = url.searchParams.get('range') || '7d';
      const { from, to, hours } = parseRange(range);
      
      let rollups = [];
      
      // For 24h, use hourly rollups; for longer periods, use daily rollups
      if (range === '24h') {
        // Get hourly rollups for today and yesterday
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const todayRollups = rollupStore.readHourlyRange(today);
        const yesterdayRollups = rollupStore.readHourlyRange(yesterday);
        rollups = [...yesterdayRollups, ...todayRollups];
      } else {
        // Use daily rollups for 7d and 30d
        rollups = rollupStore.readDailyRange(from, to);
      }

      // Extract aggregation slices for merging
      const conversationSlices = [];
      const toolSlices = [];
      const errorSlices = [];
      const userSlices = [];

      for (const rollup of rollups) {
        if (rollup.aggregations) {
          if (rollup.aggregations.conversation) conversationSlices.push(rollup.aggregations.conversation);
          if (rollup.aggregations.tool) toolSlices.push(rollup.aggregations.tool);
          if (rollup.aggregations.error) errorSlices.push(rollup.aggregations.error);
          if (rollup.aggregations.user) userSlices.push(rollup.aggregations.user);
        }
      }

      // Merge using aggregator methods
      const conversation = conversationSlices.length > 0 ? 
        aggregators.conversation.mergeDailyRollup(conversationSlices) : {};
      const tools = toolSlices.length > 0 ? 
        aggregators.tool.mergeDailyRollup(toolSlices) : {};
      const errors = errorSlices.length > 0 ? 
        aggregators.error.mergeDailyRollup(errorSlices) : {};
      const users = userSlices.length > 0 ? 
        aggregators.user.mergeDailyRollup(userSlices) : {};

      sendJson(res, 200, {
        conversation,
        tools,
        errors,
        users,
        meta: {
          range,
          from,
          to,
          generatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('[Analytics] Error in overview endpoint:', error);
      sendError(res, 500, 'Internal server error');
    }
  }

  /**
   * Handle conversations endpoint - conversation metrics with optional user filtering
   */
  async function handleConversations(req, res, url, authResult) {
    if (!isAdmin(authResult)) {
      return sendError(res, 403, 'Admin access required');
    }

    try {
      const range = url.searchParams.get('range') || '7d';
      const userId = url.searchParams.get('userId');
      const { from, to } = parseRange(range);

      // If userId filter is present, query events directly and build custom aggregation
      if (userId) {
        const events = eventStore.query({
          type: 'conversation',
          userId,
          dateFrom: from,
          dateTo: to,
          limit: 10000
        });

        // Build custom time series from events
        const timeSeries = buildTimeSeriesFromEvents(events, 'conversation');
        
        sendJson(res, 200, {
          timeSeries,
          userId,
          meta: { range, from, to, filteredBy: 'userId' }
        });
      } else {
        // Use rollup data for unfiltered view
        const timeSeries = buildTimeSeries(rollupStore, from, to, 'conversation');
        
        // Get merged rollup for breakdowns
        const rollups = range === '24h' ? 
          rollupStore.readHourlyRange(new Date().toISOString().split('T')[0]) :
          rollupStore.readDailyRange(from, to);
          
        const conversationSlices = rollups
          .filter(r => r.aggregations && r.aggregations.conversation)
          .map(r => r.aggregations.conversation);
          
        const merged = conversationSlices.length > 0 ? 
          aggregators.conversation.mergeDailyRollup(conversationSlices) : {};

        sendJson(res, 200, {
          timeSeries,
          modelBreakdown: merged.byModel || {},
          sourceBreakdown: merged.bySource || {},
          meta: { range, from, to }
        });
      }

    } catch (error) {
      console.error('[Analytics] Error in conversations endpoint:', error);
      sendError(res, 500, 'Internal server error');
    }
  }

  /**
   * Handle tools endpoint - tool usage analytics
   */
  async function handleTools(req, res, url, authResult) {
    if (!isAdmin(authResult)) {
      return sendError(res, 403, 'Admin access required');
    }

    try {
      const range = url.searchParams.get('range') || '7d';
      const { from, to } = parseRange(range);

      // Get timeline data
      const timeSeries = buildTimeSeries(rollupStore, from, to, 'tool');

      // Get merged rollup for breakdowns
      const rollups = range === '24h' ? 
        rollupStore.readHourlyRange(new Date().toISOString().split('T')[0]) :
        rollupStore.readDailyRange(from, to);
        
      const toolSlices = rollups
        .filter(r => r.aggregations && r.aggregations.tool)
        .map(r => r.aggregations.tool);
        
      const merged = toolSlices.length > 0 ? 
        aggregators.tool.mergeDailyRollup(toolSlices) : {};

      sendJson(res, 200, {
        timeSeries,
        toolBreakdown: merged.byTool || {},
        mostUsed: merged.mostUsed || [],
        slowest: merged.slowest || [],
        errorHotspots: merged.errorHotspots || [],
        meta: { range, from, to }
      });

    } catch (error) {
      console.error('[Analytics] Error in tools endpoint:', error);
      sendError(res, 500, 'Internal server error');
    }
  }

  /**
   * Handle errors endpoint - error tracking and trends
   */
  async function handleErrors(req, res, url, authResult) {
    if (!isAdmin(authResult)) {
      return sendError(res, 403, 'Admin access required');
    }

    try {
      const range = url.searchParams.get('range') || '7d';
      const { from, to, hours } = parseRange(range);

      // Get timeline data
      const timeSeries = buildTimeSeries(rollupStore, from, to, 'error');

      // Get merged rollup for categories
      const rollups = range === '24h' ? 
        rollupStore.readHourlyRange(new Date().toISOString().split('T')[0]) :
        rollupStore.readDailyRange(from, to);
        
      const errorSlices = rollups
        .filter(r => r.aggregations && r.aggregations.error)
        .map(r => r.aggregations.error);
        
      const merged = errorSlices.length > 0 ? 
        aggregators.error.mergeDailyRollup(errorSlices) : {};

      // Get recent errors
      const recentErrors = eventStore.query({
        type: 'error',
        dateFrom: from,
        dateTo: to,
        limit: 20
      });

      // Calculate trend (compare with previous period)
      const previousFrom = new Date(new Date(from).getTime() - hours * 60 * 60 * 1000).toISOString().split('T')[0];
      const previousRollups = range === '24h' ? 
        rollupStore.readHourlyRange(previousFrom) :
        rollupStore.readDailyRange(previousFrom, from);
        
      const previousErrorSlices = previousRollups
        .filter(r => r.aggregations && r.aggregations.error)
        .map(r => r.aggregations.error);
        
      const previousMerged = previousErrorSlices.length > 0 ? 
        aggregators.error.mergeDailyRollup(previousErrorSlices) : {};

      const currentErrorRate = merged.errorRate || 0;
      const previousErrorRate = previousMerged.errorRate || 0;
      const trend = currentErrorRate - previousErrorRate;

      sendJson(res, 200, {
        timeSeries,
        categories: merged.byCategory || {},
        errorTypes: merged.byErrorType || {},
        recentErrors: recentErrors.slice(0, 20),
        errorRate: currentErrorRate,
        trend,
        meta: { range, from, to }
      });

    } catch (error) {
      console.error('[Analytics] Error in errors endpoint:', error);
      sendError(res, 500, 'Internal server error');
    }
  }

  /**
   * Handle users endpoint - user activity and feature adoption
   */
  async function handleUsers(req, res, url, authResult) {
    if (!isAdmin(authResult)) {
      return sendError(res, 403, 'Admin access required');
    }

    try {
      const range = url.searchParams.get('range') || '30d';
      const { from, to } = parseRange(range);

      // Get merged rollup for user data
      const rollups = range === '24h' ? 
        rollupStore.readHourlyRange(new Date().toISOString().split('T')[0]) :
        rollupStore.readDailyRange(from, to);
        
      const userSlices = rollups
        .filter(r => r.aggregations && r.aggregations.user)
        .map(r => r.aggregations.user);
        
      const merged = userSlices.length > 0 ? 
        aggregators.user.mergeDailyRollup(userSlices) : {};

      sendJson(res, 200, {
        activeUsers: merged.activeUsers || 0,
        userList: Object.entries(merged.byUser || {}).map(([id, data]) => ({
          userId: id,
          ...data
        })),
        topUsers: merged.topUsers || [],
        featureAdoption: merged.featureAdoption || {},
        meta: { range, from, to }
      });

    } catch (error) {
      console.error('[Analytics] Error in users endpoint:', error);
      sendError(res, 500, 'Internal server error');
    }
  }

  /**
   * Handle health endpoint - system health monitoring
   */
  async function handleHealth(req, res, url, authResult) {
    try {
      const isAdminUser = isAdmin(authResult);
      
      // Basic health info (no auth required)
      const basicHealth = {
        status: 'ok',
        timestamp: new Date().toISOString()
      };

      // Full stats for admin users
      if (isAdminUser) {
        const eventStats = eventStore.getStats();
        const busStats = eventBus.getStats();
        
        // Count rollup data
        const today = new Date().toISOString().split('T')[0];
        const hourlyKeys = rollupStore.listHourlyKeys(today);
        
        sendJson(res, 200, {
          ...basicHealth,
          eventStore: eventStats,
          eventBus: busStats,
          rollups: {
            hourlyCount: hourlyKeys.length,
            lastHour: hourlyKeys[hourlyKeys.length - 1] || null
          }
        });
      } else {
        sendJson(res, 200, basicHealth);
      }

    } catch (error) {
      console.error('[Analytics] Error in health endpoint:', error);
      sendError(res, 500, 'Health check failed');
    }
  }

  /**
   * Build time series from raw events (for filtered queries)
   * @param {Array} events - Event array
   * @param {string} domain - Data domain
   * @returns {Array} Hourly time series
   */
  function buildTimeSeriesFromEvents(events, domain) {
    const hourlyData = {};
    
    for (const event of events) {
      const hour = new Date(event.ts).toISOString().slice(0, 13);
      if (!hourlyData[hour]) {
        hourlyData[hour] = { ...getZeroTimeSeriesData(domain), _responseCount: 0 };
      }
      
      const meta = event.meta || {};
      
      // Aggregate based on domain
      if (domain === 'conversation') {
        hourlyData[hour].messages++;
        if (typeof meta.cost === 'number') hourlyData[hour].cost += meta.cost;
        if (typeof meta.responseTimeMs === 'number' && meta.responseTimeMs > 0) {
          hourlyData[hour]._responseCount++;
          const n = hourlyData[hour]._responseCount;
          const prev = hourlyData[hour].avgResponseMs || 0;
          hourlyData[hour].avgResponseMs = prev + (meta.responseTimeMs - prev) / n;
        }
      }
    }
    
    // Remove internal counters
    for (const data of Object.values(hourlyData)) {
      delete data._responseCount;
    }
    
    return Object.entries(hourlyData)
      .map(([hour, data]) => ({ hour, ...data }))
      .sort((a, b) => a.hour.localeCompare(b.hour));
  }

  /**
   * Main request handler
   * @param {IncomingMessage} req - HTTP request
   * @param {ServerResponse} res - HTTP response 
   * @param {URL} url - Parsed URL object
   * @param {Object} authResult - Authentication result
   */
  function handleRequest(req, res, url, authResult) {
    // Only handle GET requests
    if (req.method !== 'GET') {
      return sendError(res, 405, 'Method not allowed');
    }

    // Route to appropriate handler
    const path = url.pathname;
    
    if (path === '/api/analytics/overview') {
      return handleOverview(req, res, url, authResult);
    } else if (path === '/api/analytics/conversations') {
      return handleConversations(req, res, url, authResult);
    } else if (path === '/api/analytics/tools') {
      return handleTools(req, res, url, authResult);
    } else if (path === '/api/analytics/errors') {
      return handleErrors(req, res, url, authResult);
    } else if (path === '/api/analytics/users') {
      return handleUsers(req, res, url, authResult);
    } else if (path === '/api/analytics/health') {
      return handleHealth(req, res, url, authResult);
    } else {
      return sendError(res, 404, 'Endpoint not found');
    }
  }

  return handleRequest;
}

module.exports = { createAnalyticsRoutes };