'use strict';

/**
 * Analytics Dashboard Widget — v2 (UX Spec Rebuild)
 *
 * 6 views: Overview, Conversations, Tools, Errors, Users, Health
 * Multi-tier live updates: 3s (gauges/sparklines), 15s (stats/charts), 60s (timelines/tables)
 * Dynamic color thresholds, empty states, ring-buffer sparklines.
 *
 * Actions:
 *   admin-analytics              → Overview (war room)
 *   admin-analytics-conv         → Conversation details
 *   admin-analytics-tools        → Tool usage breakdown
 *   admin-analytics-errors       → Error tracking
 *   admin-analytics-users        → Per-user metrics
 *   admin-analytics-health       → System health
 *   admin-analytics-refresh      → Force full refresh of current view
 *   admin-analytics-range-*      → Change time range (24h/7d/30d)
 */

const os = require('os');

// ── Color constants ──────────────────────────────────────────────────────────

const C = {
  green: '#22c55e', orange: '#f97316', red: '#ef4444',
  blue: '#3b82f6', purple: '#8b5cf6', pink: '#ec4899',
  cyan: '#06b6d4', yellow: '#eab308',
  purpleDark: '#7c3aed', purpleLight: '#a78bfa', purpleFaint: '#c4b5fd',
  blueMid: '#60a5fa', rose: '#f43f5e',
};

const MODEL_COLORS = [C.purpleDark, C.purple, C.purpleLight, C.purpleFaint, C.blue, C.blueMid];
const ERROR_COLORS = [C.red, C.rose, C.orange, C.yellow];

// ── Threshold helpers ────────────────────────────────────────────────────────

function gaugeColor(value, greenMax, orangeMax) {
  if (value <= greenMax) return 'green';
  if (value <= orangeMax) return 'orange';
  return 'red';
}

function errorCountColor(n) {
  if (n === 0) return 'green';
  if (n < 10) return 'orange';
  return 'red';
}

// ── Ring buffer for sparkline data ───────────────────────────────────────────

class RingBuffer {
  constructor(size = 30) {
    this._buf = new Array(size).fill(0);
    this._pos = 0;
    this._filled = 0;
    this._size = size;
  }
  push(v) {
    this._buf[this._pos] = v;
    this._pos = (this._pos + 1) % this._size;
    if (this._filled < this._size) this._filled++;
  }
  toArray() {
    if (this._filled < this._size) return this._buf.slice(0, this._filled);
    return [...this._buf.slice(this._pos), ...this._buf.slice(0, this._pos)];
  }
}

// ═════════════════════════════════════════════════════════════════════════════

class AnalyticsDashboard {
  constructor(opts = {}) {
    this._analytics = opts.analyticsSystem || null;
    this._usageQuery = opts.usageQuery || null;
    this._userNameMap = opts.userNameMap || null; // { userId → displayName }
    this._currentView = null;
    this._range = '24h';

    // Live update tick counters
    this._tickCount = 0;
    this._lastPush3s = 0;
    this._lastPush15s = 0;
    this._lastPush60s = 0;

    // Overview sparkline ring buffers (30 data points, ~90s at 3s ticks)
    this._spark = {
      users:    new RingBuffer(30),
      latency:  new RingBuffer(30),
      errors:   new RingBuffer(30),
      cost:     new RingBuffer(30),
    };

    // Health sparkline ring buffers
    this._healthSpark = {
      cpu:    new RingBuffer(30),
      mem:    new RingBuffer(30),
      events: new RingBuffer(30),
      ws:     new RingBuffer(30),
    };

    // Startup timestamp
    this._startedAt = Date.now();
  }

  setAnalytics(system) { this._analytics = system; }

  // ── Action router ──────────────────────────────────────────────────────────

  async handleAction(action, context = {}) {
    if (!this._analytics) {
      return { ops: [
        { op: 'clear' },
        { op: 'upsert', id: 'analytics-error', type: 'alert', data: {
          title: 'Analytics Unavailable',
          message: 'Analytics system not initialized. Events will start collecting automatically.',
          severity: 'warning',
        }},
      ]};
    }

    // Range change
    if (action.startsWith('admin-analytics-range-')) {
      this._range = action.replace('admin-analytics-range-', '') || '24h';
      action = this._currentView || 'admin-analytics';
    }

    // Refresh
    if (action === 'admin-analytics-refresh') {
      action = this._currentView || 'admin-analytics';
    }

    switch (action) {
      case 'admin-analytics':        return this._overview(context);
      case 'admin-analytics-conv':   return this._conversations(context);
      case 'admin-analytics-tools':  return this._tools(context);
      case 'admin-analytics-errors': return this._errors(context);
      case 'admin-analytics-users':  return this._users(context);
      case 'admin-analytics-health': return this._health(context);
      default:
        return { ops: [{ op: 'upsert', id: 'a-error', type: 'alert', data: {
          title: 'Unknown Action', message: `Unknown analytics action: ${action}`, severity: 'error',
        }}]};
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERVIEW — "War Room"
  // ═══════════════════════════════════════════════════════════════════════════

  async _overview(ctx) {
    this._currentView = 'admin-analytics';
    const ops = [{ op: 'clear' }, { op: 'layout', mode: 'dashboard' }];

    const data = this._getData(this._range);
    const usage = this._getUsageData(this._range);
    const conv = data.conversation || {};
    const tool = data.tool || {};
    const err = data.error || {};
    const usr = data.user || {};
    const hasData = (usage && usage.messages > 0) || (conv.totalMessages || 0) > 0 || (tool.totalToolCalls || 0) > 0;

    // ── Row 0: Back + Nav + Hero ──
    ops.push(this._topBackButton());
    ops.push(this._navChips('overview'));

    const statusText = this._systemStatus(err);
    ops.push({
      op: 'upsert', id: 'ov-hero', type: 'hero', data: {
        title: 'Scratchy Analytics',
        subtitle: `${statusText} · Updated just now`,
        icon: 'activity',
      },
    });

    if (!hasData) return { ops: [...ops, ...this._emptyOverview()] };

    // ── Row 1: 4 Gauges — use REAL usage data when available ──
    const activeUsers = usage ? (usage.perUser || []).length : (usr.activeUsers || 0);
    const avgResp = conv.avgResponseTimeMs || 0;
    const avgRespSec = avgResp / 1000;
    const totalMsgsForRate = usage ? usage.messages : (conv.totalMessages || 0);
    const errorRate = totalMsgsForRate > 0
      ? ((err.totalErrors || 0) / totalMsgsForRate) * 100
      : 0;
    const totalCost = usage ? usage.cost : (conv.totalCost || 0);

    ops.push(
      { op: 'upsert', id: 'ov-gauge-users', type: 'gauge', data: {
        label: 'Active Users', value: activeUsers, max: Math.max(activeUsers * 2, 50),
        unit: 'users', color: 'blue',
      }},
      { op: 'upsert', id: 'ov-gauge-latency', type: 'gauge', data: {
        label: 'Avg Response', value: Math.round(avgRespSec * 10) / 10, max: 5,
        unit: 'sec', color: gaugeColor(avgRespSec, 2, 4),
      }},
      { op: 'upsert', id: 'ov-gauge-errors', type: 'gauge', data: {
        label: 'Error Rate', value: Math.round(errorRate * 10) / 10, max: 10,
        unit: '%', color: gaugeColor(errorRate, 2, 5),
      }},
      { op: 'upsert', id: 'ov-gauge-cost', type: 'gauge', data: {
        label: 'Total Cost', value: Math.round(totalCost * 100) / 100, max: Math.max(totalCost * 2, 10),
        unit: '$', color: 'orange',
      }},
    );

    // ── Row 2: 4 Sparklines ──
    this._spark.users.push(activeUsers);
    this._spark.latency.push(avgRespSec);
    this._spark.errors.push(errorRate);
    this._spark.cost.push(totalCost);

    ops.push(
      { op: 'upsert', id: 'ov-spark-users', type: 'sparkline', data: {
        label: 'Users (recent)', values: this._spark.users.toArray(), color: C.blue,
      }},
      { op: 'upsert', id: 'ov-spark-latency', type: 'sparkline', data: {
        label: 'Latency (recent)', values: this._spark.latency.toArray(), color: C.green,
      }},
      { op: 'upsert', id: 'ov-spark-errors', type: 'sparkline', data: {
        label: 'Errors (recent)', values: this._spark.errors.toArray(), color: C.green,
      }},
      { op: 'upsert', id: 'ov-spark-cost', type: 'sparkline', data: {
        label: 'Cost (recent)', values: this._spark.cost.toArray(), color: C.orange,
      }},
    );

    // ── Row 3: Today's stats + model pie — REAL data from usage system ──
    const totalMsgs = usage ? usage.messages : (conv.totalMessages || 0);
    const totalTokens = usage
      ? usage.totalTokens
      : ((conv.totalInputTokens || 0) + (conv.totalOutputTokens || 0) + (conv.totalCacheTokens || 0));
    const toolCalls = tool.totalToolCalls || 0;

    const statsItems = [
      { label: 'Total Messages', value: this._fmt(totalMsgs) },
      { label: 'Tool Calls', value: this._fmt(toolCalls) },
      { label: 'Total Cost', value: `$${totalCost.toFixed(2)}` },
      { label: 'Avg Response', value: avgResp > 0 ? `${(avgRespSec).toFixed(1)}s` : '—' },
      { label: 'Active Users', value: this._fmt(activeUsers) },
    ];

    // Add real token breakdown when available
    if (usage) {
      statsItems.splice(2, 0,
        { label: 'Input Tokens', value: this._fmtTokens(usage.inputTokens) },
        { label: 'Output Tokens', value: this._fmtTokens(usage.outputTokens) },
        { label: 'Cache Tokens', value: this._fmtTokens(usage.cacheReadTokens + usage.cacheWriteTokens) },
      );
    } else {
      statsItems.splice(2, 0, { label: 'Tokens Used', value: this._fmtTokens(totalTokens) });
    }

    ops.push({
      op: 'upsert', id: 'ov-stats', type: 'stats', data: {
        title: `Summary (${this._range})`,
        items: statsItems,
      },
    });

    // Model distribution pie — prefer usage system (has real model breakdown)
    const modelSource = usage && Object.keys(usage.byModel || {}).length > 0
      ? usage.byModel
      : (conv.byModel || {});
    const modelEntries = Object.entries(modelSource);
    if (modelEntries.length > 0) {
      const slices = modelEntries
        .sort((a, b) => (b[1].messages || b[1].calls || 0) - (a[1].messages || a[1].calls || 0))
        .slice(0, 6)
        .map(([model, d], i) => ({
          label: this._shortModel(model),
          value: d.messages || d.calls || 0,
          color: MODEL_COLORS[i % MODEL_COLORS.length],
        }));
      ops.push({ op: 'upsert', id: 'ov-pie-models', type: 'chart-pie', data: {
        title: 'Usage by Model', slices,
      }});
    }

    // Provider breakdown (from usage system only)
    if (usage && Object.keys(usage.byProvider || {}).length > 0) {
      const provSlices = Object.entries(usage.byProvider)
        .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0))
        .map(([prov, d], i) => ({
          label: prov, value: Math.round((d.cost || 0) * 100) / 100,
          color: [C.blue, C.purple, C.orange, C.pink][i % 4],
        }));
      ops.push({ op: 'upsert', id: 'ov-pie-providers', type: 'chart-pie', data: {
        title: 'Cost by Provider ($)', slices: provSlices,
      }});
    }

    // Activity chart — hourly for 24h, daily for 7d/30d
    if (this._range === '24h') {
      // Hourly activity bar chart (from usage system — real timezone-adjusted hours)
      if (usage && Object.keys(usage.hourlyActivity || {}).length > 0) {
        const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
        const hourData = hours.map(h => usage.hourlyActivity[h] || 0);
        if (hourData.some(v => v > 0)) {
          ops.push({ op: 'upsert', id: 'ov-bar-hours', type: 'chart-bar', data: {
            title: 'Activity by Hour (Berlin)',
            labels: hours.map(h => `${h}:00`),
            datasets: [{ label: 'Requests', data: hourData, color: C.purple }],
          }});
        }
      }
    } else {
      // Daily trend chart for 7d/30d
      const days = this._range === '7d' ? 7 : 30;
      const dailyTrend = this._getDailyTrend(days);
      if (dailyTrend.labels.length > 0 && dailyTrend.messages.some(v => v > 0)) {
        ops.push({ op: 'upsert', id: 'ov-bar-hours', type: 'chart-bar', data: {
          title: `Daily Activity (${this._range})`,
          labels: dailyTrend.labels,
          datasets: [
            { label: 'Messages', data: dailyTrend.messages, color: C.purple },
            { label: 'Cost ($)', data: dailyTrend.cost, color: C.orange },
          ],
        }});
      }
    }

    // ── Row 4: Activity timeline + error stacked-bar ──
    const recentErrors = (err.recent || []).slice(0, 6);
    if (recentErrors.length > 0) {
      ops.push({ op: 'upsert', id: 'ov-timeline', type: 'timeline', data: {
        title: 'Recent Activity',
        items: recentErrors.map(e => ({
          title: e.errorType || e.subtype || 'Error',
          text: e.message || '',
          time: e.ts ? this._relTime(e.ts) : '',
          icon: 'alert-triangle',
          status: 'error',
        })),
      }});
    }

    const cats = err.byCategory || {};
    const catEntries = Object.entries(cats).filter(([, v]) => v > 0);
    if (catEntries.length > 0) {
      ops.push({ op: 'upsert', id: 'ov-bar-errors', type: 'stacked-bar', data: {
        title: `Errors by Type (${this._range})`,
        items: catEntries.map(([label, value], i) => ({
          label: this._ucFirst(label), value, color: ERROR_COLORS[i % ERROR_COLORS.length],
        })),
      }});
    }

    // ── Row 5: Range + Quick actions ──
    ops.push(this._rangeChips());
    ops.push({
      op: 'upsert', id: 'ov-actions', type: 'buttons', data: {
        title: 'Quick Actions',
        buttons: [
          { label: 'Refresh All', action: 'admin-analytics-refresh', style: 'primary' },
          { label: '← Admin', action: 'admin-dashboard', style: 'ghost' },
        ],
      },
    });

    return { ops };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async _conversations(ctx) {
    this._currentView = 'admin-analytics-conv';
    const ops = [{ op: 'clear' }, { op: 'layout', mode: 'rows' }];
    ops.push(this._topBackButton());
    ops.push(this._navChips('conversations'));

    const data = this._getData(this._range);
    const usage = this._getUsageData(this._range);
    const conv = data.conversation || {};
    const hasData = (usage && usage.messages > 0) || (conv.totalMessages || 0) > 0;

    if (!hasData) {
      ops.push(
        { op: 'upsert', id: 'conv-stats', type: 'stats', data: {
          title: 'Conversations', items: [
            { label: 'Active Now', value: '0' }, { label: 'Today Total', value: '0' },
          ],
        }},
        { op: 'upsert', id: 'conv-empty', type: 'card', data: {
          title: 'No conversations yet',
          text: 'Conversation analytics appear when users start chatting. You will see response times, token usage, model breakdown, and cost tracking.',
        }},
      );
      ops.push(this._rangeChips());
      return { ops };
    }

    // ── Row 1: KPIs ──
    const userMsgs = conv.userMessages || 0;
    const assistMsgs = conv.assistantMessages || 0;
    const avgResp = conv.avgResponseTimeMs || 0;
    const p95 = conv.p95ResponseTimeMs || 0;
    const canvasRate = conv.canvasResponseRate || 0;

    ops.push({ op: 'upsert', id: 'conv-stats', type: 'stats', data: {
      title: `Conversation Metrics (${this._range})`,
      items: [
        { label: 'User Messages', value: this._fmt(userMsgs) },
        { label: 'AI Responses', value: this._fmt(assistMsgs) },
        { label: 'Avg Response', value: avgResp > 0 ? `${(avgResp / 1000).toFixed(1)}s` : '—' },
        { label: 'P95 Response', value: p95 > 0 ? `${(p95 / 1000).toFixed(1)}s` : '—' },
        { label: 'Canvas Rate', value: `${Math.round(canvasRate * 100)}%` },
        { label: 'Total Cost', value: `$${(conv.totalCost || 0).toFixed(2)}` },
      ],
    }});

    // ── Row 2: Response time gauge ──
    const respSec = avgResp / 1000;
    ops.push({ op: 'upsert', id: 'conv-gauge-resp', type: 'gauge', data: {
      label: 'Avg Response Time', value: Math.round(respSec * 10) / 10,
      max: 5, unit: 'sec', color: gaugeColor(respSec, 2, 4),
    }});

    // ── Row 3: Token usage stats — REAL data from usage system ──
    if (usage) {
      ops.push({ op: 'upsert', id: 'conv-tokens', type: 'stats', data: {
        title: 'Token Usage (Real)',
        items: [
          { label: 'Input', value: this._fmtTokens(usage.inputTokens) },
          { label: 'Output', value: this._fmtTokens(usage.outputTokens) },
          { label: 'Cache Read', value: this._fmtTokens(usage.cacheReadTokens) },
          { label: 'Cache Write', value: this._fmtTokens(usage.cacheWriteTokens) },
          { label: 'Total Tokens', value: this._fmtTokens(usage.totalTokens) },
          { label: 'Total Cost', value: `$${usage.cost.toFixed(2)}` },
        ],
      }});
    } else {
      ops.push({ op: 'upsert', id: 'conv-tokens', type: 'stats', data: {
        title: 'Token Usage',
        items: [
          { label: 'Input', value: this._fmtTokens(conv.totalInputTokens || 0) },
          { label: 'Output', value: this._fmtTokens(conv.totalOutputTokens || 0) },
          { label: 'Cache', value: this._fmtTokens(conv.totalCacheTokens || 0) },
          { label: 'Total Cost', value: `$${(conv.totalCost || 0).toFixed(2)}` },
        ],
      }});
    }

    // ── Row 4: Model breakdown ──
    if (conv.byModel && Object.keys(conv.byModel).length > 0) {
      const modelEntries = Object.entries(conv.byModel)
        .sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0));

      ops.push({ op: 'upsert', id: 'conv-pie-models', type: 'chart-pie', data: {
        title: 'Usage by Model',
        slices: modelEntries.map(([model, d], i) => ({
          label: this._shortModel(model), value: d.calls || 0,
          color: MODEL_COLORS[i % MODEL_COLORS.length],
        })),
      }});

      ops.push({ op: 'upsert', id: 'conv-table-models', type: 'table', data: {
        title: 'Model Performance',
        headers: ['Model', 'Calls', 'Cost', 'Avg Latency'],
        rows: modelEntries.map(([model, d]) => [
          this._shortModel(model),
          (d.calls || 0).toString(),
          `$${(d.cost || 0).toFixed(2)}`,
          d.avgLatency > 0 ? `${(d.avgLatency / 1000).toFixed(1)}s` : '—',
        ]),
      }});
    }

    // ── Row 5: Source breakdown ──
    if (conv.bySource && Object.keys(conv.bySource).length > 0) {
      ops.push({ op: 'upsert', id: 'conv-bar-sources', type: 'chart-bar', data: {
        title: 'Messages by Source',
        labels: Object.keys(conv.bySource),
        datasets: [{ label: 'Messages', data: Object.values(conv.bySource), color: C.blue }],
      }});
    }

    // ── Trend chart (range-aware: hourly for 24h, daily for 7d/30d) ──
    const trend = this._getRangeTrend();
    if (trend.data.labels.length > 0 && trend.data.messages.some(v => v > 0)) {
      ops.push({ op: 'upsert', id: 'conv-line-trend', type: 'chart-line', data: {
        title: trend.title,
        labels: trend.data.labels,
        datasets: [
          { label: 'Messages', data: trend.data.messages, color: C.blue },
          { label: 'Cost ($)', data: trend.data.cost, color: C.orange },
        ],
      }});
    }

    ops.push(this._rangeChips());
    return { ops };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOLS
  // ═══════════════════════════════════════════════════════════════════════════

  async _tools(ctx) {
    this._currentView = 'admin-analytics-tools';
    const ops = [{ op: 'clear' }, { op: 'layout', mode: 'rows' }];
    ops.push(this._topBackButton());
    ops.push(this._navChips('tools'));

    const data = this._getData(this._range);
    const tool = data.tool || {};
    const hasData = (tool.totalToolCalls || 0) > 0;

    if (!hasData) {
      ops.push({ op: 'upsert', id: 'tools-empty', type: 'card', data: {
        title: 'No tool calls yet',
        text: 'Tool analytics track web_search, exec, Read, Write, browser, and all other tools. Usage counts, error rates, and latency trends will appear as tools are invoked.',
      }});
      ops.push(this._rangeChips());
      return { ops };
    }

    const byTool = tool.byTool || {};
    const toolEntries = Object.entries(byTool).sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0));

    // ── Row 1: KPIs ──
    ops.push({ op: 'upsert', id: 'tools-stats', type: 'stats', data: {
      title: `Tool Usage (${this._range})`,
      items: [
        { label: 'Total Calls', value: this._fmt(tool.totalToolCalls || 0) },
        { label: 'Unique Tools', value: Object.keys(byTool).length.toString() },
        { label: 'Success Rate', value: `${Math.round((tool.overallSuccessRate || 0) * 100)}%` },
        { label: 'Total Errors', value: this._fmt(tool.totalErrors || 0) },
      ],
    }});

    // ── Row 2: Tool popularity bar chart ──
    ops.push({ op: 'upsert', id: 'tools-bar-calls', type: 'chart-bar', data: {
      title: 'Calls by Tool',
      labels: toolEntries.slice(0, 10).map(([n]) => n),
      datasets: [
        { label: 'Calls', data: toolEntries.slice(0, 10).map(([, v]) => v.calls || 0), color: C.purple },
        { label: 'Errors', data: toolEntries.slice(0, 10).map(([, v]) => v.errors || 0), color: C.red },
      ],
    }});

    // ── Row 3: Tool performance table ──
    ops.push({ op: 'upsert', id: 'tools-table', type: 'table', data: {
      title: 'Tool Performance',
      headers: ['Tool', 'Calls', 'Errors', 'Success %', 'Avg Duration', 'P95 Duration'],
      rows: toolEntries.map(([name, v]) => {
        const calls = v.calls || 0;
        const errors = v.errors || 0;
        const success = calls > 0 ? Math.round(((calls - errors) / calls) * 100) : 100;
        return [
          name, calls.toString(), errors.toString(), `${success}%`,
          v.avgDurationMs ? `${(v.avgDurationMs / 1000).toFixed(1)}s` : '—',
          v.p95DurationMs ? `${(v.p95DurationMs / 1000).toFixed(1)}s` : '—',
        ];
      }),
    }});

    // ── Row 4: Error hotspots ──
    const hotspots = tool.errorHotspots || [];
    if (hotspots.length > 0) {
      ops.push({ op: 'upsert', id: 'tools-bar-errors', type: 'stacked-bar', data: {
        title: 'Error Hotspots',
        items: hotspots.slice(0, 6).map((h, i) => ({
          label: `${h.toolName || h.tool}: ${h.errorType || 'unknown'}`,
          value: h.count || 0,
          color: ERROR_COLORS[i % ERROR_COLORS.length],
        })),
      }});
    }

    // ── Row 5: Slowest tools ──
    const slowest = tool.slowest || [];
    if (slowest.length > 0) {
      ops.push({ op: 'upsert', id: 'tools-table-slow', type: 'table', data: {
        title: 'Slowest Tools',
        headers: ['Tool', 'Avg Duration', 'P95 Duration', 'Calls'],
        rows: slowest.slice(0, 5).map(s => [
          s.toolName || s.tool || '?',
          s.avgDurationMs ? `${(s.avgDurationMs / 1000).toFixed(1)}s` : '—',
          s.p95DurationMs ? `${(s.p95DurationMs / 1000).toFixed(1)}s` : '—',
          (s.calls || 0).toString(),
        ]),
      }});
    }

    ops.push(this._rangeChips());
    return { ops };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ERRORS
  // ═══════════════════════════════════════════════════════════════════════════

  async _errors(ctx) {
    this._currentView = 'admin-analytics-errors';
    const ops = [{ op: 'clear' }, { op: 'layout', mode: 'rows' }];
    ops.push(this._topBackButton());
    ops.push(this._navChips('errors'));

    const data = this._getData(this._range);
    const err = data.error || {};
    const totalErrors = err.totalErrors || 0;
    const recentErrors = err.recent || [];

    // ── Row 1: Severity banner ──
    const recent5m = recentErrors.filter(e => e.ts && (Date.now() - e.ts) < 300_000);
    if (recent5m.length > 0) {
      ops.push({ op: 'upsert', id: 'err-alert', type: 'alert', data: {
        title: 'Active Errors',
        message: `${recent5m.length} error(s) in the last 5 minutes.`,
        severity: 'error',
      }});
    } else if (totalErrors === 0) {
      ops.push({ op: 'upsert', id: 'err-alert', type: 'alert', data: {
        title: 'All Clear',
        message: 'No errors recorded. The system is running cleanly.',
        severity: 'success',
      }});
    } else {
      ops.push({ op: 'upsert', id: 'err-alert', type: 'alert', data: {
        title: 'Stable',
        message: `${totalErrors} total error(s) in ${this._range}, but none in the last 5 minutes.`,
        severity: 'info',
      }});
    }

    if (totalErrors === 0) {
      ops.push({ op: 'upsert', id: 'err-empty', type: 'card', data: {
        title: 'Error tracking is active',
        text: 'Gateway, WebSocket, tool, and widget errors will appear here with full context, timing, and trends.',
      }});
      ops.push(this._rangeChips());
      return { ops };
    }

    // ── Row 2: Error gauges ──
    const cats = err.byCategory || {};
    const errorRate = Math.round((err.errorRate || 0) * 100);

    ops.push(
      { op: 'upsert', id: 'err-gauge-total', type: 'gauge', data: {
        label: `Errors (${this._range})`, value: totalErrors, max: Math.max(totalErrors * 2, 50),
        unit: 'errors', color: errorCountColor(totalErrors),
      }},
      { op: 'upsert', id: 'err-gauge-rate', type: 'gauge', data: {
        label: 'Error Rate', value: errorRate, max: 10,
        unit: '%', color: gaugeColor(errorRate, 2, 5),
      }},
    );

    // ── Row 3: Error distribution pie ──
    const byType = err.byErrorType || {};
    const typeEntries = Object.entries(byType).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (typeEntries.length > 0) {
      ops.push({ op: 'upsert', id: 'err-pie', type: 'chart-pie', data: {
        title: `Error Distribution (${this._range})`,
        slices: typeEntries.slice(0, 8).map(([label, value], i) => ({
          label, value, color: ERROR_COLORS[i % ERROR_COLORS.length],
        })),
      }});
    }

    // ── Row 4: By category stacked bar ──
    const catEntries = Object.entries(cats).filter(([, v]) => v > 0);
    if (catEntries.length > 0) {
      ops.push({ op: 'upsert', id: 'err-bar-cats', type: 'stacked-bar', data: {
        title: 'Errors by Category',
        items: catEntries.map(([label, value], i) => ({
          label: this._ucFirst(label), value, color: ERROR_COLORS[i % ERROR_COLORS.length],
        })),
      }});
    }

    // ── Row 5: Widget errors ──
    const byWidget = err.byWidget || {};
    const widgetEntries = Object.entries(byWidget).filter(([, v]) => v > 0);
    if (widgetEntries.length > 0) {
      ops.push({ op: 'upsert', id: 'err-bar-widgets', type: 'chart-bar', data: {
        title: 'Errors by Widget',
        labels: widgetEntries.map(([n]) => n),
        datasets: [{ label: 'Errors', data: widgetEntries.map(([, v]) => v), color: C.red }],
      }});
    }

    // ── Row 6: Recent errors log ──
    if (recentErrors.length > 0) {
      ops.push({ op: 'upsert', id: 'err-timeline', type: 'timeline', data: {
        title: 'Error Log',
        items: recentErrors.slice(0, 8).map(e => ({
          title: e.errorType || e.subtype || 'Error',
          text: e.message || e.provider || '',
          time: e.ts ? this._relTime(e.ts) : '',
          icon: 'x-circle',
          status: 'error',
        })),
      }});
    }

    // ── Row 7: Error hotspots ──
    const hotspots = err.errorHotspots || [];
    if (hotspots.length > 0) {
      ops.push({ op: 'upsert', id: 'err-table-hotspots', type: 'table', data: {
        title: 'Error Hotspots',
        headers: ['Category', 'Error Type', 'Count'],
        rows: hotspots.slice(0, 6).map(h => [
          this._ucFirst(h.category || ''), h.errorType || '?', (h.count || 0).toString(),
        ]),
      }});
    }

    ops.push(this._rangeChips());
    return { ops };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USERS
  // ═══════════════════════════════════════════════════════════════════════════

  async _users(ctx) {
    this._currentView = 'admin-analytics-users';
    const ops = [{ op: 'clear' }, { op: 'layout', mode: 'rows' }];
    ops.push(this._topBackButton());
    ops.push(this._navChips('users'));

    const data = this._getData(this._range);
    const usage = this._getUsageData(this._range);
    const usr = data.user || {};
    const activeUsers = usage ? (usage.perUser || []).length : (usr.activeUsers || 0);
    const byUser = usr.byUser || {};
    const hasData = activeUsers > 0 || (usage && usage.perUser && usage.perUser.length > 0);

    if (!hasData) {
      ops.push(
        { op: 'upsert', id: 'usr-gauge-active', type: 'gauge', data: {
          label: 'Active Users', value: 0, max: 50, unit: 'users', color: 'blue',
        }},
        { op: 'upsert', id: 'usr-empty', type: 'card', data: {
          title: 'Waiting for users',
          text: 'User analytics will show active sessions, engagement patterns, top users, and feature adoption once people start connecting.',
        }},
      );
      ops.push(this._rangeChips());
      return { ops };
    }

    // ── Row 1: KPIs ──
    const topUsers = usr.topUsers || [];
    const totalMsgs = Object.values(byUser).reduce((s, u) => s + (u.messages || 0), 0);
    const totalSessions = Object.values(byUser).reduce((s, u) => s + (u.responses || 0), 0);

    ops.push({ op: 'upsert', id: 'usr-stats', type: 'stats', data: {
      title: `Users (${this._range})`,
      items: [
        { label: 'Active Users', value: this._fmt(activeUsers) },
        { label: 'Total Messages', value: this._fmt(totalMsgs) },
        { label: 'Total Responses', value: this._fmt(totalSessions) },
        { label: 'Avg Msgs/User', value: activeUsers > 0 ? Math.round(totalMsgs / activeUsers).toString() : '—' },
      ],
    }});

    // ── Row 2: User gauge ──
    ops.push({ op: 'upsert', id: 'usr-gauge-active', type: 'gauge', data: {
      label: 'Active Users', value: activeUsers, max: Math.max(activeUsers * 2, 50),
      unit: 'users', color: 'blue',
    }});

    // ── Row 3: Top users table ──
    const userEntries = Object.entries(byUser)
      .sort((a, b) => (b[1].messages || 0) - (a[1].messages || 0));

    if (userEntries.length > 0) {
      ops.push({ op: 'upsert', id: 'usr-table-top', type: 'table', data: {
        title: 'Most Active Users',
        headers: ['User', 'Messages', 'Responses', 'Tool Calls', 'Cost', 'Errors'],
        rows: userEntries.slice(0, 10).map(([userId, u]) => [
          this._shortUser(userId),
          (u.messages || 0).toString(),
          (u.responses || 0).toString(),
          (u.toolCalls || 0).toString(),
          `$${(u.cost || 0).toFixed(2)}`,
          (u.errors || 0).toString(),
        ]),
      }});
    }

    // ── Row 3b: Per-user REAL usage from usage system ──
    if (usage && usage.perUser && usage.perUser.length > 0) {
      const sorted = [...usage.perUser].sort((a, b) => b.cost - a.cost);
      ops.push({ op: 'upsert', id: 'usr-table-usage', type: 'table', data: {
        title: 'Token Usage by User (Real)',
        headers: ['User', 'Messages', 'Input', 'Output', 'Cache', 'Cost'],
        rows: sorted.map(u => [
          this._shortUser(u.userId),
          u.messages.toString(),
          this._fmtTokens(u.inputTokens),
          this._fmtTokens(u.outputTokens),
          this._fmtTokens(u.cacheReadTokens),
          `$${u.cost.toFixed(2)}`,
        ]),
      }});
    }

    // ── Row 4: Feature adoption ──
    const adoption = usr.featureAdoption || {};
    const adoptionEntries = Object.entries(adoption).filter(([, v]) => v > 0);
    if (adoptionEntries.length > 0) {
      ops.push({ op: 'upsert', id: 'usr-bar-features', type: 'stacked-bar', data: {
        title: 'Feature Adoption',
        items: adoptionEntries.map(([label, value], i) => ({
          label: this._ucFirst(label),
          value: Math.round(value * 100),
          color: [C.blue, C.purple, C.pink, C.cyan, C.green, C.orange][i % 6],
        })),
      }});
    }

    // ── Row 5: Activity by hour ──
    const hourBuckets = new Array(24).fill(0);
    for (const u of Object.values(byUser)) {
      if (u.hourBuckets) {
        for (let i = 0; i < 24; i++) hourBuckets[i] += (u.hourBuckets[i] || 0);
      }
    }
    const hasHourData = hourBuckets.some(v => v > 0);
    if (hasHourData) {
      ops.push({ op: 'upsert', id: 'usr-bar-hours', type: 'chart-bar', data: {
        title: 'Activity by Hour',
        labels: Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`),
        datasets: [{ label: 'Events', data: hourBuckets, color: C.purple }],
      }});
    }

    ops.push(this._rangeChips());
    return { ops };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEALTH
  // ═══════════════════════════════════════════════════════════════════════════

  async _health(ctx) {
    this._currentView = 'admin-analytics-health';
    const ops = [{ op: 'clear' }, { op: 'layout', mode: 'dashboard' }];
    ops.push(this._topBackButton());
    ops.push(this._navChips('health'));

    // ── Row 1: System status banner ──
    const uptimeMs = process.uptime() * 1000;
    ops.push({ op: 'upsert', id: 'hlth-alert', type: 'alert', data: {
      title: 'System Health',
      message: `All services operational. Uptime: ${this._fmtDuration(uptimeMs)}.`,
      severity: 'success',
    }});

    // ── Row 2: Infrastructure gauges ──
    const cpuUsage = this._getCpuPercent();
    const memInfo = this._getMemInfo();
    const storeStats = this._getStoreStats();
    const wsConns = this._getWsConnCount();

    ops.push(
      { op: 'upsert', id: 'hlth-gauge-cpu', type: 'gauge', data: {
        label: 'CPU', value: cpuUsage, max: 100, unit: '%', color: gaugeColor(cpuUsage, 50, 80),
      }},
      { op: 'upsert', id: 'hlth-gauge-mem', type: 'gauge', data: {
        label: 'Memory', value: memInfo.pct, max: 100, unit: '%', color: gaugeColor(memInfo.pct, 60, 85),
      }},
      { op: 'upsert', id: 'hlth-gauge-events', type: 'gauge', data: {
        label: 'Events Today', value: storeStats.eventsToday, max: Math.max(storeStats.eventsToday * 2, 100),
        unit: 'events', color: 'green',
      }},
      { op: 'upsert', id: 'hlth-gauge-ws', type: 'gauge', data: {
        label: 'WS Connections', value: wsConns, max: Math.max(wsConns * 3, 50),
        unit: 'conns', color: 'blue',
      }},
    );

    // ── Row 3: Health sparklines ──
    this._healthSpark.cpu.push(cpuUsage);
    this._healthSpark.mem.push(memInfo.pct);
    this._healthSpark.events.push(storeStats.eventsToday);
    this._healthSpark.ws.push(wsConns);

    ops.push(
      { op: 'upsert', id: 'hlth-spark-cpu', type: 'sparkline', data: {
        label: 'CPU (recent)', values: this._healthSpark.cpu.toArray(), color: C.green,
      }},
      { op: 'upsert', id: 'hlth-spark-mem', type: 'sparkline', data: {
        label: 'Memory (recent)', values: this._healthSpark.mem.toArray(), color: C.orange,
      }},
      { op: 'upsert', id: 'hlth-spark-events', type: 'sparkline', data: {
        label: 'Events (recent)', values: this._healthSpark.events.toArray(), color: C.green,
      }},
      { op: 'upsert', id: 'hlth-spark-ws', type: 'sparkline', data: {
        label: 'WS Conns (recent)', values: this._healthSpark.ws.toArray(), color: C.blue,
      }},
    );

    // ── Row 4: Store & Internals KV ──
    ops.push({ op: 'upsert', id: 'hlth-kv', type: 'kv', data: {
      title: 'Store & Internals',
      items: [
        { key: 'Event Store', value: `${this._fmt(storeStats.totalEvents)} events (${(storeStats.sizeBytes / 1024 / 1024).toFixed(1)} MB)` },
        { key: 'Oldest Data', value: storeStats.oldestDate || 'none' },
        { key: 'Newest Data', value: storeStats.newestDate || 'none' },
        { key: 'WS Connections', value: wsConns.toString() },
        { key: 'Memory Used', value: `${memInfo.usedGB.toFixed(1)} / ${memInfo.totalGB.toFixed(1)} GB` },
        { key: 'Uptime', value: this._fmtDuration(uptimeMs) },
        { key: 'Node.js', value: process.version },
        { key: 'Platform', value: `${os.type()} ${os.release()}` },
      ],
    }});

    // ── Row 5: Component checklist ──
    const a = this._analytics;
    ops.push({ op: 'upsert', id: 'hlth-checklist', type: 'checklist', data: {
      title: 'Service Status',
      items: [
        { text: 'EventBus', checked: !!a.eventBus },
        { text: 'EventStore', checked: !!a.eventStore },
        { text: 'RollupStore', checked: !!a.rollupStore },
        { text: 'Conversation Collector', checked: !!(a.collectors && a.collectors.conversation) },
        { text: 'Tool Collector', checked: !!(a.collectors && a.collectors.tool) },
        { text: 'Error Collector', checked: !!(a.collectors && a.collectors.error) },
        { text: 'Session Collector', checked: !!(a.collectors && a.collectors.session) },
        { text: 'REST API', checked: !!a.handleRequest },
        { text: 'WS Push', checked: !!a.ws },
      ],
    }});

    // ── Row 6: EventBus listeners ──
    if (a.eventBus && typeof a.eventBus.listenerCount === 'function') {
      const types = ['conversation', 'tool', 'error', 'session'];
      ops.push({ op: 'upsert', id: 'hlth-kv-bus', type: 'kv', data: {
        title: 'EventBus Listeners',
        items: types.map(t => ({ key: t, value: (a.eventBus.listenerCount(t) || 0).toString() })),
      }});
    }

    return { ops };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIVE UPDATE — called every 3s by serve.js
  // ═══════════════════════════════════════════════════════════════════════════

  getLiveUpdate() {
    if (!this._currentView || !this._analytics) return null;

    const now = Date.now();
    this._tickCount++;

    // Determine which tiers to update this tick
    const do3s = (now - this._lastPush3s) >= 3000;
    const do15s = (now - this._lastPush15s) >= 15000;
    const do60s = (now - this._lastPush60s) >= 60000;

    if (!do3s) return null;
    this._lastPush3s = now;

    try {
      switch (this._currentView) {
        case 'admin-analytics':       return this._liveOverview(do15s, do60s);
        case 'admin-analytics-conv':  return do15s ? this._liveConversations() : null;
        case 'admin-analytics-tools': return do15s ? this._liveTools() : null;
        case 'admin-analytics-errors': return this._liveErrors(do15s, do60s);
        case 'admin-analytics-users': return do15s ? this._liveUsers() : null;
        case 'admin-analytics-health': return this._liveHealth(do15s);
        default: return null;
      }
    } catch (e) {
      return null;
    } finally {
      if (do15s) this._lastPush15s = now;
      if (do60s) this._lastPush60s = now;
    }
  }

  // ── Live: Overview ──

  _liveOverview(do15s, do60s) {
    const data = this._getData(this._range);
    const usage = this._getUsageData(this._range);
    const conv = data.conversation || {};
    const err = data.error || {};
    const usr = data.user || {};
    const tool = data.tool || {};

    const activeUsers = usage ? (usage.perUser || []).length : (usr.activeUsers || 0);
    const avgResp = conv.avgResponseTimeMs || 0;
    const avgRespSec = avgResp / 1000;
    const totalMsgsForRate = usage ? usage.messages : (conv.totalMessages || 0);
    const errorRate = totalMsgsForRate > 0
      ? ((err.totalErrors || 0) / totalMsgsForRate) * 100 : 0;
    const totalCost = usage ? usage.cost : (conv.totalCost || 0);

    // Update sparkline buffers
    this._spark.users.push(activeUsers);
    this._spark.latency.push(avgRespSec);
    this._spark.errors.push(errorRate);
    this._spark.cost.push(totalCost);

    const ops = [];

    // ── 3s tier: gauges + sparklines + hero subtitle ──
    ops.push(
      { op: 'patch', id: 'ov-hero', data: {
        subtitle: `${this._systemStatus(err)} · Updated ${Math.round((Date.now() - this._lastPush3s) / 1000) || 0}s ago`,
      }},
      { op: 'patch', id: 'ov-gauge-users', data: { value: activeUsers, max: Math.max(activeUsers * 2, 50) }},
      { op: 'patch', id: 'ov-gauge-latency', data: {
        value: Math.round(avgRespSec * 10) / 10, color: gaugeColor(avgRespSec, 2, 4),
      }},
      { op: 'patch', id: 'ov-gauge-errors', data: {
        value: Math.round(errorRate * 10) / 10, color: gaugeColor(errorRate, 2, 5),
      }},
      { op: 'patch', id: 'ov-gauge-cost', data: {
        value: Math.round(totalCost * 100) / 100, max: Math.max(totalCost * 2, 10),
      }},
      { op: 'patch', id: 'ov-spark-users', data: { values: this._spark.users.toArray() }},
      { op: 'patch', id: 'ov-spark-latency', data: { values: this._spark.latency.toArray() }},
      { op: 'patch', id: 'ov-spark-errors', data: { values: this._spark.errors.toArray() }},
      { op: 'patch', id: 'ov-spark-cost', data: { values: this._spark.cost.toArray() }},
    );

    // ── 15s tier: stats + pie chart ──
    if (do15s) {
      const totalMsgs = conv.totalMessages || 0;
      const totalTokens = (conv.totalInputTokens || 0) + (conv.totalOutputTokens || 0) + (conv.totalCacheTokens || 0);
      ops.push({ op: 'patch', id: 'ov-stats', data: {
        items: [
          { label: 'Total Messages', value: this._fmt(totalMsgs) },
          { label: 'Tool Calls', value: this._fmt(tool.totalToolCalls || 0) },
          { label: 'Tokens Used', value: this._fmtTokens(totalTokens) },
          { label: 'Total Cost', value: `$${totalCost.toFixed(2)}` },
          { label: 'Avg Response', value: avgResp > 0 ? `${avgRespSec.toFixed(1)}s` : '—' },
          { label: 'Active Users', value: this._fmt(activeUsers) },
        ],
      }});
    }

    // ── 60s tier: error stacked-bar ──
    if (do60s) {
      const cats = err.byCategory || {};
      const catEntries = Object.entries(cats).filter(([, v]) => v > 0);
      if (catEntries.length > 0) {
        ops.push({ op: 'patch', id: 'ov-bar-errors', data: {
          items: catEntries.map(([label, value], i) => ({
            label: this._ucFirst(label), value, color: ERROR_COLORS[i % ERROR_COLORS.length],
          })),
        }});
      }
    }

    return { ops };
  }

  // ── Live: Conversations ──

  _liveConversations() {
    const data = this._getData(this._range);
    const usage = this._getUsageData(this._range);
    const conv = data.conversation || {};
    if (!conv.totalMessages && !(usage && usage.messages)) return null;

    const avgResp = conv.avgResponseTimeMs || 0;
    const p95 = conv.p95ResponseTimeMs || 0;
    const canvasRate = conv.canvasResponseRate || 0;
    const cost = usage ? usage.cost : (conv.totalCost || 0);

    const ops = [
      { op: 'patch', id: 'conv-stats', data: {
        items: [
          { label: 'User Messages', value: this._fmt(conv.userMessages || 0) },
          { label: 'AI Responses', value: this._fmt(conv.assistantMessages || 0) },
          { label: 'Avg Response', value: avgResp > 0 ? `${(avgResp / 1000).toFixed(1)}s` : '—' },
          { label: 'P95 Response', value: p95 > 0 ? `${(p95 / 1000).toFixed(1)}s` : '—' },
          { label: 'Canvas Rate', value: `${Math.round(canvasRate * 100)}%` },
          { label: 'Total Cost', value: `$${cost.toFixed(2)}` },
        ],
      }},
      { op: 'patch', id: 'conv-gauge-resp', data: {
        value: Math.round((avgResp / 1000) * 10) / 10,
        color: gaugeColor(avgResp / 1000, 2, 4),
      }},
    ];

    // Token stats — prefer real usage data
    if (usage) {
      ops.push({ op: 'patch', id: 'conv-tokens', data: {
        items: [
          { label: 'Input', value: this._fmtTokens(usage.inputTokens) },
          { label: 'Output', value: this._fmtTokens(usage.outputTokens) },
          { label: 'Cache Read', value: this._fmtTokens(usage.cacheReadTokens) },
          { label: 'Cache Write', value: this._fmtTokens(usage.cacheWriteTokens) },
          { label: 'Total Tokens', value: this._fmtTokens(usage.totalTokens) },
          { label: 'Total Cost', value: `$${usage.cost.toFixed(2)}` },
        ],
      }});
    } else {
      ops.push({ op: 'patch', id: 'conv-tokens', data: {
        items: [
          { label: 'Input', value: this._fmtTokens(conv.totalInputTokens || 0) },
          { label: 'Output', value: this._fmtTokens(conv.totalOutputTokens || 0) },
          { label: 'Cache', value: this._fmtTokens(conv.totalCacheTokens || 0) },
          { label: 'Total Cost', value: `$${(conv.totalCost || 0).toFixed(2)}` },
        ],
      }});
    }

    return { ops };
  }

  // ── Live: Tools ──

  _liveTools() {
    const data = this._getData(this._range);
    const tool = data.tool || {};
    if (!tool.totalToolCalls) return null;

    return { ops: [
      { op: 'patch', id: 'tools-stats', data: {
        items: [
          { label: 'Total Calls', value: this._fmt(tool.totalToolCalls || 0) },
          { label: 'Unique Tools', value: Object.keys(tool.byTool || {}).length.toString() },
          { label: 'Success Rate', value: `${Math.round((tool.overallSuccessRate || 0) * 100)}%` },
          { label: 'Total Errors', value: this._fmt(tool.totalErrors || 0) },
        ],
      }},
    ]};
  }

  // ── Live: Errors ──

  _liveErrors(do15s, do60s) {
    const data = this._getData(this._range);
    const err = data.error || {};
    const totalErrors = err.totalErrors || 0;
    const recentErrors = err.recent || [];
    const recent5m = recentErrors.filter(e => e.ts && (Date.now() - e.ts) < 300_000);

    const ops = [];

    // 3s: alert banner + gauges
    if (recent5m.length > 0) {
      ops.push({ op: 'patch', id: 'err-alert', data: {
        title: 'Active Errors', message: `${recent5m.length} error(s) in the last 5 minutes.`, severity: 'error',
      }});
    } else {
      ops.push({ op: 'patch', id: 'err-alert', data: {
        title: totalErrors === 0 ? 'All Clear' : 'Stable',
        message: totalErrors === 0
          ? 'No errors recorded. The system is running cleanly.'
          : `${totalErrors} total error(s), but none in the last 5 minutes.`,
        severity: totalErrors === 0 ? 'success' : 'info',
      }});
    }

    ops.push(
      { op: 'patch', id: 'err-gauge-total', data: {
        value: totalErrors, max: Math.max(totalErrors * 2, 50), color: errorCountColor(totalErrors),
      }},
      { op: 'patch', id: 'err-gauge-rate', data: {
        value: Math.round((err.errorRate || 0) * 100), color: gaugeColor(Math.round((err.errorRate || 0) * 100), 2, 5),
      }},
    );

    // 60s: timeline
    if (do60s && recentErrors.length > 0) {
      ops.push({ op: 'patch', id: 'err-timeline', data: {
        items: recentErrors.slice(0, 8).map(e => ({
          title: e.errorType || e.subtype || 'Error',
          text: e.message || e.provider || '',
          time: e.ts ? this._relTime(e.ts) : '',
          icon: 'x-circle', status: 'error',
        })),
      }});
    }

    return { ops };
  }

  // ── Live: Users ──

  _liveUsers() {
    const data = this._getData(this._range);
    const usr = data.user || {};
    if (!usr.activeUsers) return null;

    const byUser = usr.byUser || {};
    const totalMsgs = Object.values(byUser).reduce((s, u) => s + (u.messages || 0), 0);
    const totalSessions = Object.values(byUser).reduce((s, u) => s + (u.responses || 0), 0);

    return { ops: [
      { op: 'patch', id: 'usr-stats', data: {
        items: [
          { label: 'Active Users', value: this._fmt(usr.activeUsers) },
          { label: 'Total Messages', value: this._fmt(totalMsgs) },
          { label: 'Total Responses', value: this._fmt(totalSessions) },
          { label: 'Avg Msgs/User', value: usr.activeUsers > 0 ? Math.round(totalMsgs / usr.activeUsers).toString() : '—' },
        ],
      }},
      { op: 'patch', id: 'usr-gauge-active', data: {
        value: usr.activeUsers, max: Math.max(usr.activeUsers * 2, 50),
      }},
    ]};
  }

  // ── Live: Health ──

  _liveHealth(do15s) {
    const cpuUsage = this._getCpuPercent();
    const memInfo = this._getMemInfo();
    const wsConns = this._getWsConnCount();

    this._healthSpark.cpu.push(cpuUsage);
    this._healthSpark.mem.push(memInfo.pct);
    this._healthSpark.ws.push(wsConns);

    const ops = [
      { op: 'patch', id: 'hlth-gauge-cpu', data: { value: cpuUsage, color: gaugeColor(cpuUsage, 50, 80) }},
      { op: 'patch', id: 'hlth-gauge-mem', data: { value: memInfo.pct, color: gaugeColor(memInfo.pct, 60, 85) }},
      { op: 'patch', id: 'hlth-gauge-ws', data: { value: wsConns, max: Math.max(wsConns * 3, 50) }},
      { op: 'patch', id: 'hlth-spark-cpu', data: { values: this._healthSpark.cpu.toArray() }},
      { op: 'patch', id: 'hlth-spark-mem', data: { values: this._healthSpark.mem.toArray() }},
      { op: 'patch', id: 'hlth-spark-ws', data: { values: this._healthSpark.ws.toArray() }},
    ];

    if (do15s) {
      const uptimeMs = process.uptime() * 1000;
      ops.push({ op: 'patch', id: 'hlth-alert', data: {
        message: `All services operational. Uptime: ${this._fmtDuration(uptimeMs)}.`,
      }});
      ops.push({ op: 'patch', id: 'hlth-kv', data: {
        items: [
          { key: 'Event Store', value: `${this._fmt(this._getStoreStats().totalEvents)} events` },
          { key: 'WS Connections', value: wsConns.toString() },
          { key: 'Memory Used', value: `${memInfo.usedGB.toFixed(1)} / ${memInfo.totalGB.toFixed(1)} GB` },
          { key: 'Uptime', value: this._fmtDuration(uptimeMs) },
          { key: 'Node.js', value: process.version },
          { key: 'Platform', value: `${os.type()} ${os.release()}` },
        ],
      }});
    }

    return { ops };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA ACCESS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get real usage data from the UsageQuery system.
   * Returns token counts, costs, model/provider breakdowns, hourly activity
   * from actual gateway JSONL files — the real numbers.
   *
   * @param {string} [range='24h'] - '24h', '7d', '30d'
   * @returns {{ totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost, messages, byModel, byProvider, toolUsage, hourlyActivity, perUser }}
   */
  _getUsageData(range) {
    if (!this._usageQuery) return null;

    try {
      const allUsers = this._usageQuery.getAllUsers();
      if (!allUsers || allUsers.length === 0) return null;

      // Merge across all users for the requested range
      let totals = {
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        totalTokens: 0, cost: 0, messages: 0,
        byModel: {}, byProvider: {}, toolUsage: {}, hourlyActivity: {},
        perUser: [],
      };

      for (const { userId, today, cumulative } of allUsers) {
        // Skip system users for display
        if (userId.startsWith('_')) continue;

        let bucket;
        if (range === '24h') {
          bucket = today;
        } else if (range === '7d' || range === '30d') {
          // For multi-day ranges, use getDateRange
          const days = range === '7d' ? 7 : 30;
          const todayStr = this._usageQuery._tz.today();
          const end = new Date(todayStr + 'T00:00:00');
          const start = new Date(end);
          start.setDate(start.getDate() - (days - 1));
          const fromDate = start.toISOString().slice(0, 10);
          const dayRange = this._usageQuery.getDateRange(userId, fromDate, todayStr);

          // Merge daily buckets
          bucket = {
            inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            totalTokens: 0, cost: 0, messages: 0,
            byModel: {}, byProvider: {}, toolUsage: {}, hourlyActivity: {},
          };
          for (const { bucket: db } of dayRange) {
            bucket.inputTokens += db.inputTokens || 0;
            bucket.outputTokens += db.outputTokens || 0;
            bucket.cacheReadTokens += db.cacheReadTokens || 0;
            bucket.cacheWriteTokens += db.cacheWriteTokens || 0;
            bucket.totalTokens += db.totalTokens || 0;
            bucket.cost += db.cost || 0;
            bucket.messages += db.messages || 0;

            // Merge byModel
            if (db.byModel) {
              for (const [model, md] of Object.entries(db.byModel)) {
                if (!bucket.byModel[model]) bucket.byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0, messages: 0 };
                const bm = bucket.byModel[model];
                bm.inputTokens += md.inputTokens || 0;
                bm.outputTokens += md.outputTokens || 0;
                bm.cacheReadTokens += md.cacheReadTokens || 0;
                bm.cost += md.cost || 0;
                bm.messages += md.messages || 0;
              }
            }
            // Merge byProvider
            if (db.byProvider) {
              for (const [prov, pd] of Object.entries(db.byProvider)) {
                if (!bucket.byProvider[prov]) bucket.byProvider[prov] = { cost: 0, messages: 0, models: [] };
                bucket.byProvider[prov].cost += pd.cost || 0;
                bucket.byProvider[prov].messages += pd.messages || 0;
              }
            }
            // Merge toolUsage
            if (db.toolUsage) {
              for (const [tool, count] of Object.entries(db.toolUsage)) {
                bucket.toolUsage[tool] = (bucket.toolUsage[tool] || 0) + count;
              }
            }
            // Merge hourlyActivity
            if (db.hourlyActivity) {
              for (const [hour, count] of Object.entries(db.hourlyActivity)) {
                bucket.hourlyActivity[hour] = (bucket.hourlyActivity[hour] || 0) + count;
              }
            }
          }
        } else {
          bucket = cumulative;
        }

        // Accumulate into totals
        totals.inputTokens += bucket.inputTokens || 0;
        totals.outputTokens += bucket.outputTokens || 0;
        totals.cacheReadTokens += bucket.cacheReadTokens || 0;
        totals.cacheWriteTokens += bucket.cacheWriteTokens || 0;
        totals.totalTokens += bucket.totalTokens || 0;
        totals.cost += bucket.cost || 0;
        totals.messages += bucket.messages || 0;

        // Merge byModel
        if (bucket.byModel) {
          for (const [model, md] of Object.entries(bucket.byModel)) {
            if (!totals.byModel[model]) totals.byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0, messages: 0 };
            const tm = totals.byModel[model];
            tm.inputTokens += md.inputTokens || 0;
            tm.outputTokens += md.outputTokens || 0;
            tm.cacheReadTokens += md.cacheReadTokens || 0;
            tm.cost += md.cost || 0;
            tm.messages += md.messages || 0;
          }
        }

        // Merge byProvider
        if (bucket.byProvider) {
          for (const [prov, pd] of Object.entries(bucket.byProvider)) {
            if (!totals.byProvider[prov]) totals.byProvider[prov] = { cost: 0, messages: 0, models: new Set() };
            totals.byProvider[prov].cost += pd.cost || 0;
            totals.byProvider[prov].messages += pd.messages || 0;
            if (pd.models) pd.models.forEach(m => totals.byProvider[prov].models.add(m));
          }
        }

        // Merge toolUsage
        if (bucket.toolUsage) {
          for (const [tool, count] of Object.entries(bucket.toolUsage)) {
            totals.toolUsage[tool] = (totals.toolUsage[tool] || 0) + count;
          }
        }

        // Merge hourlyActivity
        if (bucket.hourlyActivity) {
          for (const [hour, count] of Object.entries(bucket.hourlyActivity)) {
            totals.hourlyActivity[hour] = (totals.hourlyActivity[hour] || 0) + count;
          }
        }

        // Per-user summary
        totals.perUser.push({
          userId,
          messages: bucket.messages || 0,
          cost: bucket.cost || 0,
          inputTokens: bucket.inputTokens || 0,
          outputTokens: bucket.outputTokens || 0,
          cacheReadTokens: bucket.cacheReadTokens || 0,
          totalTokens: bucket.totalTokens || 0,
        });
      }

      // Convert Sets to arrays for serialization
      for (const prov of Object.values(totals.byProvider)) {
        if (prov.models instanceof Set) prov.models = [...prov.models];
      }

      return totals;
    } catch (e) {
      console.error('[AnalyticsDashboard] Usage data error:', e.message);
      return null;
    }
  }

  _getData(range) {
    const { rollupStore } = this._analytics;
    if (!rollupStore) return {};

    let rollups = [];
    try {
      if (range === '24h') {
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        rollups = [
          ...(rollupStore.readHourlyRange(yesterday) || []),
          ...(rollupStore.readHourlyRange(today) || []),
        ];
      } else {
        const to = new Date().toISOString().split('T')[0];
        const daysBack = range === '7d' ? 7 : 30;
        const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
        rollups = rollupStore.readDailyRange(from, to) || [];
      }
    } catch (e) {
      console.error('[AnalyticsDashboard] Rollup read error:', e.message);
      return {};
    }

    // Merge all rollup aggregations
    const slices = { conversation: [], tool: [], error: [], user: [] };
    for (const r of rollups) {
      if (!r.aggregations) continue;
      for (const key of Object.keys(slices)) {
        if (r.aggregations[key]) slices[key].push(r.aggregations[key]);
      }
    }

    return {
      conversation: this._mergeConversation(slices.conversation),
      tool: this._mergeTool(slices.tool),
      error: this._mergeError(slices.error),
      user: this._mergeUser(slices.user),
    };
  }

  _getHourlyTrend(type) {
    const { rollupStore } = this._analytics;
    const result = { labels: [], messages: [], cost: [] };
    if (!rollupStore) return result;

    try {
      const today = new Date().toISOString().split('T')[0];
      const rollups = rollupStore.readHourlyRange(today) || [];
      for (const r of rollups) {
        const hour = (r.hourKey || '').slice(11) || '?';
        result.labels.push(`${hour}:00`);
        const conv = (r.aggregations && r.aggregations.conversation) || {};
        result.messages.push(conv.totalMessages || 0);
        result.cost.push(Math.round((conv.totalCost || 0) * 100) / 100);
      }
    } catch (e) { /* non-fatal */ }

    return result;
  }

  /**
   * Get daily trend data for multi-day ranges (7d, 30d).
   * Uses usage system daily buckets for accurate per-day breakdowns.
   */
  _getDailyTrend(days) {
    const result = { labels: [], messages: [], cost: [] };
    if (!this._usageQuery) return result;

    try {
      const todayStr = this._usageQuery._tz.today();
      const end = new Date(todayStr + 'T00:00:00');
      const start = new Date(end);
      start.setDate(start.getDate() - (days - 1));
      const fromDate = start.toISOString().slice(0, 10);

      // Get all users and aggregate daily
      const allUsers = this._usageQuery.getAllUsers();
      const dailyTotals = {};

      for (const { userId } of allUsers) {
        if (userId.startsWith('_')) continue;
        const range = this._usageQuery.getDateRange(userId, fromDate, todayStr);
        for (const { date, bucket } of range) {
          if (!dailyTotals[date]) dailyTotals[date] = { messages: 0, cost: 0 };
          dailyTotals[date].messages += bucket.messages || 0;
          dailyTotals[date].cost += bucket.cost || 0;
        }
      }

      // Build sorted labels (short date format)
      const cursor = new Date(start);
      while (cursor <= end) {
        const ds = cursor.toISOString().slice(0, 10);
        const shortLabel = days <= 7
          ? new Date(ds + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })
          : new Date(ds + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
        result.labels.push(shortLabel);
        const dt = dailyTotals[ds] || { messages: 0, cost: 0 };
        result.messages.push(dt.messages);
        result.cost.push(Math.round(dt.cost * 100) / 100);
        cursor.setDate(cursor.getDate() + 1);
      }
    } catch (e) { /* non-fatal */ }

    return result;
  }

  /**
   * Get the right trend data for the current range.
   */
  _getRangeTrend() {
    if (this._range === '24h') return { data: this._getHourlyTrend('conversation'), title: 'Activity Over Time (24h)' };
    const days = this._range === '7d' ? 7 : 30;
    return { data: this._getDailyTrend(days), title: `Activity Over Time (${this._range})` };
  }

  // ── Typed merge functions ──

  _mergeConversation(slices) {
    if (slices.length === 0) return {};
    if (slices.length === 1) return { ...slices[0] };

    const n = slices.length;
    const r = {
      totalMessages: 0, userMessages: 0, assistantMessages: 0,
      avgResponseTimeMs: 0, p95ResponseTimeMs: 0,
      totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheTokens: 0,
      canvasResponseRate: 0, modelsUsed: [], bySource: {}, byModel: {},
    };

    let totalAssistWeighted = 0;
    const modelSet = new Set();

    for (const s of slices) {
      r.totalMessages += s.totalMessages || 0;
      r.userMessages += s.userMessages || 0;
      r.assistantMessages += s.assistantMessages || 0;
      r.totalCost += s.totalCost || 0;
      r.totalInputTokens += s.totalInputTokens || 0;
      r.totalOutputTokens += s.totalOutputTokens || 0;
      r.totalCacheTokens += s.totalCacheTokens || 0;

      // Weighted avg for response time
      const w = s.assistantMessages || 0;
      totalAssistWeighted += (s.avgResponseTimeMs || 0) * w;
      r.p95ResponseTimeMs = Math.max(r.p95ResponseTimeMs, s.p95ResponseTimeMs || 0);

      // Canvas rate weighted
      r.canvasResponseRate += (s.canvasResponseRate || 0) * w;

      if (s.modelsUsed) s.modelsUsed.forEach(m => modelSet.add(m));
      if (s.bySource) for (const [k, v] of Object.entries(s.bySource)) r.bySource[k] = (r.bySource[k] || 0) + v;
      if (s.byModel) {
        for (const [model, d] of Object.entries(s.byModel)) {
          if (!r.byModel[model]) r.byModel[model] = { calls: 0, cost: 0, avgLatency: 0, _wl: 0 };
          r.byModel[model].calls += d.calls || 0;
          r.byModel[model].cost += d.cost || 0;
          r.byModel[model]._wl += (d.avgLatency || 0) * (d.calls || 0);
        }
      }
    }

    if (r.assistantMessages > 0) {
      r.avgResponseTimeMs = totalAssistWeighted / r.assistantMessages;
      r.canvasResponseRate /= r.assistantMessages;
    }

    r.modelsUsed = [...modelSet];
    for (const m of Object.values(r.byModel)) {
      if (m.calls > 0) m.avgLatency = m._wl / m.calls;
      delete m._wl;
    }

    return r;
  }

  _mergeTool(slices) {
    if (slices.length === 0) return {};
    if (slices.length === 1) return { ...slices[0] };

    const r = { totalToolCalls: 0, totalErrors: 0, overallSuccessRate: 0, byTool: {}, mostUsed: [], slowest: [], errorHotspots: [] };

    for (const s of slices) {
      r.totalToolCalls += s.totalToolCalls || 0;
      r.totalErrors += s.totalErrors || 0;

      if (s.byTool) {
        for (const [name, d] of Object.entries(s.byTool)) {
          if (!r.byTool[name]) r.byTool[name] = { calls: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0, _wd: 0 };
          const t = r.byTool[name];
          t.calls += d.calls || 0;
          t.errors += d.errors || 0;
          t._wd += (d.avgDurationMs || 0) * (d.calls || 0);
          t.p95DurationMs = Math.max(t.p95DurationMs, d.p95DurationMs || 0);
        }
      }
    }

    r.overallSuccessRate = r.totalToolCalls > 0 ? (r.totalToolCalls - r.totalErrors) / r.totalToolCalls : 0;
    for (const t of Object.values(r.byTool)) {
      if (t.calls > 0) t.avgDurationMs = t._wd / t.calls;
      delete t._wd;
    }

    r.mostUsed = Object.entries(r.byTool)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 5)
      .map(([toolName, d]) => ({ toolName, ...d }));

    r.slowest = Object.entries(r.byTool)
      .filter(([, d]) => d.avgDurationMs > 0)
      .sort((a, b) => b[1].avgDurationMs - a[1].avgDurationMs)
      .slice(0, 5)
      .map(([toolName, d]) => ({ toolName, ...d }));

    return r;
  }

  _mergeError(slices) {
    if (slices.length === 0) return {};
    if (slices.length === 1) return { ...slices[0] };

    const r = {
      totalErrors: 0, byCategory: {}, byErrorType: {}, byProvider: {}, byWidget: {},
      retryableRate: 0, recoverableRate: 0, errorRate: 0, recent: [], errorHotspots: [],
    };

    let totalRetryable = 0, totalRecoverable = 0, totalEvents = 0;

    for (const s of slices) {
      r.totalErrors += s.totalErrors || 0;
      totalEvents += s.totalErrors || 0; // approximate

      if (s.byCategory) for (const [k, v] of Object.entries(s.byCategory)) r.byCategory[k] = (r.byCategory[k] || 0) + v;
      if (s.byErrorType) for (const [k, v] of Object.entries(s.byErrorType)) r.byErrorType[k] = (r.byErrorType[k] || 0) + v;
      if (s.byProvider) for (const [k, v] of Object.entries(s.byProvider)) r.byProvider[k] = (r.byProvider[k] || 0) + v;
      if (s.byWidget) for (const [k, v] of Object.entries(s.byWidget)) r.byWidget[k] = (r.byWidget[k] || 0) + v;

      totalRetryable += (s.retryableRate || 0) * (s.totalErrors || 0);
      totalRecoverable += (s.recoverableRate || 0) * (s.totalErrors || 0);

      if (s.recent) r.recent.push(...s.recent);
      if (s.errorHotspots) r.errorHotspots.push(...s.errorHotspots);
    }

    if (r.totalErrors > 0) {
      r.retryableRate = totalRetryable / r.totalErrors;
      r.recoverableRate = totalRecoverable / r.totalErrors;
    }

    // Sort recent by timestamp descending, keep top 20
    r.recent.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    r.recent = r.recent.slice(0, 20);

    // Dedupe hotspots
    const hotMap = new Map();
    for (const h of r.errorHotspots) {
      const key = `${h.category}::${h.errorType}`;
      const existing = hotMap.get(key);
      if (existing) existing.count += h.count || 0;
      else hotMap.set(key, { ...h });
    }
    r.errorHotspots = [...hotMap.values()].sort((a, b) => b.count - a.count).slice(0, 10);

    return r;
  }

  _mergeUser(slices) {
    if (slices.length === 0) return {};
    if (slices.length === 1) return { ...slices[0] };

    const allUsers = new Set();
    const byUser = {};
    const featureCount = {};

    for (const s of slices) {
      if (s.byUser) {
        for (const [userId, d] of Object.entries(s.byUser)) {
          allUsers.add(userId);
          if (!byUser[userId]) byUser[userId] = { messages: 0, responses: 0, toolCalls: 0, errors: 0, cost: 0, hourBuckets: new Array(24).fill(0) };
          const u = byUser[userId];
          u.messages += d.messages || 0;
          u.responses += d.responses || 0;
          u.toolCalls += d.toolCalls || 0;
          u.errors += d.errors || 0;
          u.cost += d.cost || 0;
          if (d.hourBuckets) for (let i = 0; i < 24; i++) u.hourBuckets[i] += (d.hourBuckets[i] || 0);
        }
      }
      if (s.featureAdoption) {
        for (const [f, v] of Object.entries(s.featureAdoption)) {
          featureCount[f] = (featureCount[f] || 0) + v;
        }
      }
    }

    const activeUsers = allUsers.size;
    const featureAdoption = {};
    for (const [f, total] of Object.entries(featureCount)) {
      featureAdoption[f] = slices.length > 0 ? total / slices.length : 0;
    }

    const topUsers = Object.entries(byUser)
      .map(([userId, d]) => ({ userId, activityScore: d.messages + d.toolCalls * 0.5, messages: d.messages, cost: d.cost }))
      .sort((a, b) => b.activityScore - a.activityScore)
      .slice(0, 5);

    return { activeUsers, byUser, topUsers, featureAdoption };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPTY STATES
  // ═══════════════════════════════════════════════════════════════════════════

  _emptyOverview() {
    const a = this._analytics;
    return [
      { op: 'upsert', id: 'ov-empty-card', type: 'card', data: {
        title: 'No data yet',
        text: 'Analytics will populate as users interact with Scratchy. Gauges, charts, and activity feeds will appear here automatically.',
      }},
      { op: 'upsert', id: 'ov-empty-check', type: 'checklist', data: {
        title: 'Getting Started',
        items: [
          { text: 'Analytics system initialized', checked: !!a },
          { text: 'EventBus running', checked: !!(a && a.eventBus) },
          { text: 'Event collection active', checked: !!(a && a.collectors) },
          { text: 'First user connected', checked: false },
          { text: 'First conversation completed', checked: false },
        ],
      }},
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED COMPONENTS
  // ═══════════════════════════════════════════════════════════════════════════

  _topBackButton() {
    return {
      op: 'upsert', id: 'analytics-back-top', type: 'buttons', data: {
        buttons: [{ label: '← Admin', action: 'admin-dashboard', style: 'ghost' }],
      },
    };
  }

  _navChips(active) {
    const views = [
      { text: 'Overview',      value: 'overview',      action: 'admin-analytics' },
      { text: 'Conversations', value: 'conversations', action: 'admin-analytics-conv' },
      { text: 'Tools',         value: 'tools',         action: 'admin-analytics-tools' },
      { text: 'Errors',        value: 'errors',        action: 'admin-analytics-errors' },
      { text: 'Users',         value: 'users',         action: 'admin-analytics-users' },
      { text: 'Health',        value: 'health',        action: 'admin-analytics-health' },
    ];
    return {
      op: 'upsert', id: 'analytics-nav', type: 'chips', data: {
        label: 'Analytics',
        chips: views.map(v => ({ text: v.text, value: v.action, checked: v.value === active })),
      },
    };
  }

  _rangeChips() {
    return {
      op: 'upsert', id: 'analytics-range', type: 'chips', data: {
        label: 'Time Range',
        chips: [
          { text: '24h', value: 'admin-analytics-range-24h', checked: this._range === '24h' },
          { text: '7d',  value: 'admin-analytics-range-7d',  checked: this._range === '7d' },
          { text: '30d', value: 'admin-analytics-range-30d', checked: this._range === '30d' },
        ],
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _systemStatus(err) {
    const total = err.totalErrors || 0;
    const recent = (err.recent || []).filter(e => e.ts && (Date.now() - e.ts) < 300_000);
    if (recent.length > 3) return `⚠️ Degraded — ${recent.length} errors in last 5m`;
    if (total === 0) return '✅ All systems operational';
    return '✅ All systems operational';
  }

  _getCpuPercent() {
    try {
      const cpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      for (const cpu of cpus) {
        for (const type of Object.keys(cpu.times)) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
      }
      return Math.round(((totalTick - totalIdle) / totalTick) * 100);
    } catch (e) { return 0; }
  }

  _getMemInfo() {
    try {
      const total = os.totalmem();
      const free = os.freemem();
      const used = total - free;
      return {
        pct: Math.round((used / total) * 100),
        usedGB: used / 1024 / 1024 / 1024,
        totalGB: total / 1024 / 1024 / 1024,
      };
    } catch (e) { return { pct: 0, usedGB: 0, totalGB: 0 }; }
  }

  _getStoreStats() {
    try {
      if (this._analytics && this._analytics.eventStore && this._analytics.eventStore.getStats) {
        return this._analytics.eventStore.getStats();
      }
    } catch (e) { /* non-fatal */ }
    return { totalEvents: 0, oldestDate: null, newestDate: null, sizeBytes: 0 };
  }

  _getWsConnCount() {
    // Attempt to get from analytics WS manager
    try {
      if (this._analytics && this._analytics.ws && this._analytics.ws._sessions) {
        return this._analytics.ws._sessions.size || 0;
      }
    } catch (e) { /* non-fatal */ }
    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FORMATTING HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _fmt(n) {
    if (n == null || isNaN(n)) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  }

  _fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
    return n.toString();
  }

  _fmtDuration(ms) {
    if (!ms || ms <= 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  _relTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }

  _shortModel(name) {
    return (name || 'unknown')
      .replace('anthropic/', '')
      .replace('claude-', '')
      .replace('-20250', '')
      .replace('-latest', '');
  }

  _shortUser(userId) {
    if (!userId) return '?';
    // Resolve display name from injected user map
    if (this._userNameMap && this._userNameMap[userId]) return this._userNameMap[userId];
    // Fallback: truncate raw IDs
    if (userId.startsWith('usr_')) return userId.slice(4, 14) + '…';
    if (userId.startsWith('_')) return userId; // system users (_system, _subagent)
    if (userId.length > 16) return userId.slice(0, 14) + '…';
    return userId;
  }

  _ucFirst(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
  }
}

module.exports = AnalyticsDashboard;
