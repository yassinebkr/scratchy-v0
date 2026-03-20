'use strict';
const fs = require('fs');
const path = require('path');

const AGENTS_BASE = path.join(__dirname, '..', '..', '..', '.openclaw', 'agents');
const SESSIONS_DIR = path.join(AGENTS_BASE, 'main', 'sessions');
const STORE_FILE = path.join(SESSIONS_DIR, 'sessions.json');

// Discover ALL agent directories (sub-agents run under their own model slug)
function _getAllSessionDirs() {
  const dirs = [];
  try {
    for (const entry of fs.readdirSync(AGENTS_BASE, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const sessDir = path.join(AGENTS_BASE, entry.name, 'sessions');
        if (fs.existsSync(path.join(sessDir, 'sessions.json'))) {
          dirs.push(sessDir);
        }
      }
    }
  } catch (e) {
    console.error('[SubagentMonitor] Failed to scan agent dirs:', e.message);
    dirs.push(SESSIONS_DIR); // fallback
  }
  return dirs;
}

/**
 * Sub-agent Monitor — Real-time Edition v2
 * 
 * Two modes:
 *   - POLL mode (default): 3s interval — lightweight
 *   - LIVE mode (admin-only): fs.watch on each JSONL file — instant updates
 * 
 * Features:
 *   - Per-agent progress gauge (time-based: elapsed / timeout)
 *   - Real-time activity streaming (tool calls, thinking, text)
 *   - Click-to-detail: full event timeline per agent
 *   - Auto-discovery of recent sub-agent sessions
 */
class SubagentMonitor {
  constructor() {
    this._trackedSessions = new Map();
    this._startTime = null;
    this._liveMode = false;
    this._watchers = new Map();
    this._pushFn = null;
    this._defaultTimeout = 300; // 5 min default
    this._currentView = 'overview'; // 'overview' | 'detail'
    this._detailSessionKey = null;  // which agent's detail is open
  }

  setPushFn(fn) { this._pushFn = fn; }

  async handleAction(action, context) {
    switch (action) {
      case 'subagent-monitor': return this._startMonitor(context);
      case 'subagent-detail':  return this._showDetail(context);
      case 'subagent-back':    this._currentView = 'overview'; this._detailSessionKey = null; return { ops: this._renderFull() };
      case 'subagent-stop':    return this._stopMonitor();
      default: return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Start / Stop
  // ═══════════════════════════════════════════════════════

  _startMonitor(context) {
    this._stopWatchers();
    this._trackedSessions.clear();
    this._startTime = Date.now();
    this._liveMode = !!(context && context.live);

    if (context && context.sessionKeys && Array.isArray(context.sessionKeys)) {
      for (const key of context.sessionKeys) {
        const label = (context.labels && context.labels[key]) || key.split(':').pop().slice(0, 8);
        const timeout = (context.timeouts && context.timeouts[key]) || this._defaultTimeout;
        this._trackedSessions.set(key, this._newTracked(label, timeout));
      }
    } else {
      this._autoDiscover();
    }

    // If nothing to track (all sessions already completed), return immediately — no polling
    if (this._trackedSessions.size === 0) {
      return { ops: this._renderFull(), _noPoll: true };
    }

    if (this._liveMode) this._startWatchers();
    return { ops: this._renderFull() };
  }

  _stopMonitor() {
    this._stopWatchers();
    this._trackedSessions.clear();
    this._startTime = null;
    this._liveMode = false;
    return { ops: [{ op: 'clear' }] };
  }

  _newTracked(label, timeoutSec) {
    return {
      label,
      status: 'running',
      startTime: Date.now(),
      lastUpdate: Date.now(),
      tokens: 0,
      lastActivity: '',
      messageCount: 0,
      sessionId: null,
      timeoutMs: (timeoutSec || this._defaultTimeout) * 1000,
      eventLog: [] // { time, type, text } for detail view
    };
  }

  _autoDiscover() {
    try {
      const cutoff = Date.now() - 10 * 60 * 1000;
      const allDirs = _getAllSessionDirs();

      for (const sessDir of allDirs) {
        let store;
        try { store = JSON.parse(fs.readFileSync(path.join(sessDir, 'sessions.json'), 'utf-8')); } catch { continue; }

        for (const [key, entry] of Object.entries(store)) {
          if (!key.includes(':subagent:')) continue;
          if ((entry.updatedAt || 0) < cutoff) continue;
          if (this._trackedSessions.has(key)) continue; // already tracking

          // Skip already-completed sessions: check if JSONL shows end_turn/stop
          if (entry.sessionId) {
            const completionStatus = this._quickCompletionCheck(entry.sessionId, sessDir);
            if (completionStatus === 'complete' || completionStatus === 'failed') continue;
          }

          const label = entry.label || key.split(':').pop().slice(0, 8);
          const tracked = this._newTracked(label, this._defaultTimeout);
          tracked.startTime = entry.createdAt || entry.updatedAt || Date.now();
          tracked.lastUpdate = entry.updatedAt || Date.now();
          tracked.tokens = entry.totalTokens || 0;
          tracked.sessionId = entry.sessionId || null;
          tracked._sessionsDir = sessDir; // remember which dir this came from
          this._trackedSessions.set(key, tracked);
        }
      }
    } catch (e) {
      console.error('[SubagentMonitor] Auto-discover error:', e.message);
    }
  }

  /** Quick check if a session is already done (no full parse, just tail of JSONL). */
  _quickCompletionCheck(sessionId, sessDir) {
    try {
      let filePath = path.join(sessDir, sessionId + '.jsonl');
      if (!fs.existsSync(filePath)) {
        // Deleted file = completed session
        const deleted = this._findDeletedFile(sessionId, sessDir);
        if (deleted) return 'complete';
        // No file at all + updated > 5min ago → assume complete
        return 'unknown';
      }
      const stat = fs.statSync(filePath);
      // Stale file (not modified in 5+ minutes) → likely complete
      if (Date.now() - stat.mtimeMs > 300000) return 'complete';
      // Read tail of file for stop_reason
      const fd = fs.openSync(filePath, 'r');
      const readSize = Math.min(stat.size, 2048);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        try {
          const obj = JSON.parse(lines[i]);
          const msg = obj.message || obj;
          const sr = msg.stopReason || msg.stop_reason || '';
          if (sr === 'end_turn' || sr === 'stop') return 'complete';
          if (msg.error || obj.error) return 'failed';
        } catch { continue; }
      }
      return 'running';
    } catch { return 'unknown'; }
  }

  // ═══════════════════════════════════════════════════════
  //  LIVE MODE — fs.watch
  // ═══════════════════════════════════════════════════════

  _startWatchers() {
    // Build a merged store from all agent directories
    const mergedStore = {};
    for (const sessDir of _getAllSessionDirs()) {
      try {
        const store = JSON.parse(fs.readFileSync(path.join(sessDir, 'sessions.json'), 'utf-8'));
        for (const [k, v] of Object.entries(store)) {
          mergedStore[k] = { ...v, _sessionsDir: sessDir };
        }
      } catch {}
    }

    for (const [key, tracked] of this._trackedSessions) {
      const entry = mergedStore[key];
      if (!entry || !entry.sessionId) continue;
      tracked.sessionId = entry.sessionId;
      tracked._sessionsDir = entry._sessionsDir || SESSIONS_DIR;
      this._startWatcherForKey(key, entry);
    }
  }

  _startWatcherForKey(key, entry) {
    const sessDir = entry._sessionsDir || (this._trackedSessions.get(key)?._sessionsDir) || SESSIONS_DIR;
    const filePath = path.join(sessDir, entry.sessionId + '.jsonl');
    try {
      const watchState = { offset: 0, buffer: '' };

      if (fs.existsSync(filePath)) {
        // ── Catch-up read: process ENTIRE existing file first ──
        // This ensures already-complete sessions are detected immediately
        this._catchUpRead(key, filePath, watchState);

        // Only start watching if still running after catch-up
        const tracked = this._trackedSessions.get(key);
        if (tracked && tracked.status === 'running') {
          const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
            if (eventType === 'change') this._onFileChange(key, filePath, watchState);
          });
          this._watchers.set(key, { watcher, watchState });
        }
      } else {
        // Check for .deleted variants (OpenClaw renames completed sessions)
        const deletedFile = this._findDeletedFile(entry.sessionId);
        if (deletedFile) {
          this._catchUpRead(key, deletedFile, watchState);
        } else {
          // Watch dir for file creation
          const dirWatcher = fs.watch(sessDir, { persistent: false }, (_, filename) => {
            if (filename === entry.sessionId + '.jsonl') {
              dirWatcher.close();
              this._catchUpRead(key, filePath, watchState);
              const tracked = this._trackedSessions.get(key);
              if (tracked && tracked.status === 'running') {
                const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
                  if (eventType === 'change') this._onFileChange(key, filePath, watchState);
                });
                this._watchers.set(key, { watcher, watchState });
              }
            }
          });
          this._watchers.set(key, { watcher: dirWatcher, watchState });
        }
      }
    } catch (e) {
      console.error(`[SubagentMonitor] Watch error ${key}:`, e.message);
    }
  }

  _catchUpRead(key, filePath, watchState) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      watchState.offset = Buffer.byteLength(data, 'utf-8');
      const tracked = this._trackedSessions.get(key);
      if (!tracked) return;

      const lines = data.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const msg = obj.message || obj;
          this._processMessage(tracked, msg, obj);
        } catch { continue; }
      }

      // Push initial state if we found anything
      if (tracked.messageCount > 0 && this._pushFn) {
        const ops = this._buildAgentPatch(key, tracked);
        if (ops.length > 0) this._pushFn(ops);
      }
    } catch (e) {
      console.error(`[SubagentMonitor] Catch-up read error:`, e.message);
    }
  }

  _findDeletedFile(sessionId, sessDir) {
    const dirsToCheck = sessDir ? [sessDir] : _getAllSessionDirs();
    for (const dir of dirsToCheck) {
      try {
        const files = fs.readdirSync(dir);
        const prefix = sessionId + '.jsonl.deleted';
        const match = files.find(f => f.startsWith(prefix));
        if (match) return path.join(dir, match);
      } catch {}
    }
    return null;
  }

  _onFileChange(sessionKey, filePath, watchState) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= watchState.offset) return;

      const newSize = stat.size - watchState.offset;
      const buf = Buffer.alloc(newSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, newSize, watchState.offset);
      fs.closeSync(fd);
      watchState.offset = stat.size;

      const text = watchState.buffer + buf.toString('utf-8');
      const lines = text.split('\n');
      watchState.buffer = lines.pop() || '';

      const tracked = this._trackedSessions.get(sessionKey);
      if (!tracked) return;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const msg = obj.message || obj;
          this._processMessage(tracked, msg, obj);
        } catch { continue; }
      }

      // Push live update — detail or overview depending on current view
      if (this._currentView === 'detail' && this._detailSessionKey === sessionKey) {
        // Re-render the full detail view with updated data
        const detailResult = this._renderDetail(sessionKey, tracked);
        if (this._pushFn) this._pushFn(detailResult.ops);
      } else {
        const ops = this._buildAgentPatch(sessionKey, tracked);
        if (this._pushFn && ops.length > 0) this._pushFn(ops);
      }

      // Check all done
      this._checkAllDone();
    } catch (e) {
      console.error(`[SubagentMonitor] File change error:`, e.message);
    }
  }

  _processMessage(tracked, msg, obj) {
    tracked.messageCount++;
    tracked.lastUpdate = Date.now();

    const activity = this._extractActivity(msg);
    if (activity) {
      tracked.lastActivity = activity.text;
      tracked.eventLog.push({
        time: Date.now() - tracked.startTime,
        type: activity.type,
        text: activity.text
      });
      // Cap event log at 100 entries
      if (tracked.eventLog.length > 100) tracked.eventLog.shift();
    }

    const stopReason = msg.stopReason || msg.stop_reason || '';
    if ((stopReason === 'end_turn' || stopReason === 'stop') && tracked.status !== 'complete') {
      tracked.status = 'complete';
      tracked.eventLog.push({ time: Date.now() - tracked.startTime, type: 'complete', text: '✅ Task complete' });
    } else if ((msg.error || obj.error) && tracked.status !== 'failed') {
      tracked.status = 'failed';
      tracked.eventLog.push({ time: Date.now() - tracked.startTime, type: 'error', text: '❌ ' + (msg.error || obj.error || 'Failed') });
    }

    if (msg.usage && msg.usage.totalTokens) {
      tracked.tokens = msg.usage.totalTokens;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Activity Extraction
  // ═══════════════════════════════════════════════════════

  _extractActivity(msg) {
    const content = msg.content;
    if (!content || !Array.isArray(content)) return null;

    for (const block of content) {
      if (block.type === 'toolCall' || block.type === 'tool_use') {
        const name = block.name || block.toolName || '';
        const args = block.arguments || block.input || {};
        let detail = '';
        if (args.file_path || args.path) {
          detail = ' → ' + (args.file_path || args.path).split('/').pop();
        } else if (args.command) {
          detail = ' → ' + args.command.slice(0, 40);
        } else if (args.query) {
          detail = ' → "' + args.query.slice(0, 30) + '"';
        }
        const labels = {
          'Read': '📄 Reading', 'read': '📄 Reading',
          'Write': '✍️ Writing', 'write': '✍️ Writing',
          'Edit': '✏️ Editing', 'edit': '✏️ Editing',
          'exec': '⚡ Running', 'web_search': '🔍 Searching',
          'web_fetch': '🌐 Fetching', 'image': '🖼️ Analyzing',
        };
        return { type: 'tool', text: (labels[name] || `🔧 ${name}`) + detail };
      }
      if (block.type === 'thinking' && block.thinking) {
        const preview = block.thinking.slice(0, 80).replace(/\n/g, ' ').trim();
        return { type: 'thinking', text: '🧠 ' + preview + (block.thinking.length > 80 ? '...' : '') };
      }
      if (block.type === 'text' && block.text && msg.role === 'assistant') {
        const preview = block.text.slice(0, 80).replace(/\n/g, ' ').trim();
        return { type: 'text', text: '💬 ' + preview + (block.text.length > 80 ? '...' : '') };
      }
      if (block.type === 'text' && (msg.role === 'toolResult' || msg.toolCallId)) {
        const preview = block.text.slice(0, 60).replace(/\n/g, ' ').trim();
        return { type: 'result', text: '📋 ' + preview + (block.text.length > 60 ? '...' : '') };
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════
  //  Progress Calculation
  // ═══════════════════════════════════════════════════════

  _getProgress(tracked) {
    if (tracked.status === 'complete') return 100;
    if (tracked.status === 'failed') return 0;
    const elapsed = Date.now() - tracked.startTime;
    // Use smooth easing: fast early, slows down approaching 95%
    // This feels more natural than linear
    const linear = Math.min(elapsed / tracked.timeoutMs, 1);
    const eased = 1 - Math.pow(1 - linear, 0.6); // ease-out curve
    return Math.min(95, Math.round(eased * 100));
  }

  // ═══════════════════════════════════════════════════════
  //  Build Ops
  // ═══════════════════════════════════════════════════════

  _buildAgentPatch(sessionKey, tracked) {
    const ops = [];
    const safeId = this._safeId(sessionKey);
    const elapsed = this._formatElapsed(Date.now() - tracked.startTime);
    const tokenStr = tracked.tokens > 1000 ? (tracked.tokens / 1000).toFixed(1) + 'k' : String(tracked.tokens);
    const pct = this._getProgress(tracked);
    const color = tracked.status === 'complete' ? '#22c55e' : tracked.status === 'failed' ? '#ef4444' : '#8b5cf6';

    // Progress bar
    ops.push({ op: 'patch', id: `sa-prog-${safeId}`, data: {
      label: `${tracked.label} — ${pct}%`,
      value: pct,
      max: 100,
      color
    }});

    // Activity card
    ops.push({ op: 'patch', id: `sa-card-${safeId}`, data: {
      title: tracked.lastActivity || tracked.status,
      text: `⏱ ${elapsed} · 🪙 ${tokenStr} tokens · 📝 ${tracked.messageCount} msgs`
    }});

    // Stats + header
    let active = 0, complete = 0, failed = 0;
    for (const [, t] of this._trackedSessions) {
      if (t.status === 'complete') complete++;
      else if (t.status === 'failed') failed++;
      else active++;
    }

    // Overall progress: average of all agents
    let totalPct = 0;
    for (const [, t] of this._trackedSessions) totalPct += this._getProgress(t);
    const overallPct = Math.round(totalPct / this._trackedSessions.size);

    ops.push({ op: 'patch', id: 'sa-overall', data: {
      label: 'Overall',
      value: overallPct,
      max: 100,
      unit: '%',
      color: active === 0 ? '#22c55e' : '#8b5cf6'
    }});

    ops.push({ op: 'patch', id: 'sa-stats', data: {
      items: [
        { label: 'Active', value: String(active) },
        { label: 'Complete', value: String(complete) },
        { label: 'Failed', value: String(failed) }
      ]
    }});

    ops.push({ op: 'patch', id: 'sa-header', data: {
      subtitle: `${this._trackedSessions.size} agents · ${this._formatElapsed(Date.now() - this._startTime)}` +
        (this._liveMode ? ' · 🔴 LIVE' : '') + ` · ${overallPct}%`
    }});

    return ops;
  }

  _checkAllDone() {
    let active = 0, complete = 0, failed = 0;
    for (const [, t] of this._trackedSessions) {
      if (t.status === 'complete') complete++;
      else if (t.status === 'failed') failed++;
      else active++;
    }

    if (active === 0 && this._trackedSessions.size > 0) {
      const ops = [{ op: 'patch', id: 'sa-header', data: {
        title: '🤖 Sprint Complete',
        subtitle: `${complete} done, ${failed} failed · ${this._formatElapsed(Date.now() - this._startTime)}`
      }},
      { op: 'patch', id: 'sa-overall', data: {
        value: 100, color: failed > 0 ? '#ef4444' : '#22c55e'
      }}];
      if (this._pushFn) this._pushFn(ops);
      this._stopWatchers();
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Detail View (click on agent → timeline)
  // ═══════════════════════════════════════════════════════

  _showDetail(context) {
    const sessionKey = context && context.sessionKey;
    if (!sessionKey) return { ops: this._renderFull() };

    const tracked = this._trackedSessions.get(sessionKey);
    if (!tracked) {
      // Try to find by label
      for (const [key, t] of this._trackedSessions) {
        if (t.label === sessionKey) {
          this._currentView = 'detail';
          this._detailSessionKey = key;
          return this._renderDetail(key, t);
        }
      }
      return { ops: [{ op: 'upsert', id: 'sa-err', type: 'alert', data: {
        title: 'Not Found', message: 'Session not found.', severity: 'warning'
      }}]};
    }

    this._currentView = 'detail';
    this._detailSessionKey = sessionKey;
    return this._renderDetail(sessionKey, tracked);
  }

  _renderDetail(sessionKey, tracked) {
    const elapsed = this._formatElapsed(Date.now() - tracked.startTime);
    const tokenStr = tracked.tokens > 1000 ? (tracked.tokens / 1000).toFixed(1) + 'k' : String(tracked.tokens);
    const pct = this._getProgress(tracked);
    const statusIcon = tracked.status === 'complete' ? '✅' : tracked.status === 'failed' ? '❌' : '⏳';

    const ops = [
      { op: 'clear' },
      { op: 'upsert', id: 'sa-detail-header', type: 'hero', data: {
        title: `${statusIcon} ${tracked.label}`,
        subtitle: `${elapsed} · ${tokenStr} tokens · ${tracked.messageCount} messages · ${pct}%`,
        icon: '🔍'
      }},
      { op: 'upsert', id: 'sa-detail-progress', type: 'progress', data: {
        label: `Progress — ${pct}%`,
        value: pct,
        max: 100,
        color: tracked.status === 'complete' ? '#22c55e' : tracked.status === 'failed' ? '#ef4444' : '#8b5cf6'
      }},
      { op: 'upsert', id: 'sa-detail-info', type: 'stats', data: {
        title: 'Agent Info',
        items: [
          { label: 'Status', value: tracked.status },
          { label: 'Tokens', value: tokenStr },
          { label: 'Messages', value: String(tracked.messageCount) },
          { label: 'Events', value: String(tracked.eventLog.length) }
        ]
      }}
    ];

    // Build timeline from event log
    if (tracked.eventLog.length > 0) {
      const timelineItems = tracked.eventLog.slice(-50).map(evt => {
        const timeStr = this._formatElapsed(evt.time);
        const iconMap = {
          'tool': '🔧', 'thinking': '🧠', 'text': '💬',
          'result': '📋', 'complete': '✅', 'error': '❌'
        };
        return {
          title: evt.text,
          text: `+${timeStr}`,
          icon: iconMap[evt.type] || '📌',
          status: evt.type === 'complete' ? 'complete' : evt.type === 'error' ? 'error' : undefined
        };
      });

      ops.push({ op: 'upsert', id: 'sa-detail-timeline', type: 'timeline', data: {
        title: `Event Log (last ${timelineItems.length})`,
        items: timelineItems
      }});
    } else {
      ops.push({ op: 'upsert', id: 'sa-detail-empty', type: 'card', data: {
        title: 'No events yet',
        text: 'Waiting for agent to start producing output...'
      }});
    }

    // Back button
    ops.push({ op: 'upsert', id: 'sa-detail-back', type: 'buttons', data: {
      buttons: [{ label: '← Back to Monitor', action: 'subagent-back', style: 'ghost' }]
    }});

    return { ops };
  }

  // ═══════════════════════════════════════════════════════
  //  Full Render (initial + back)
  // ═══════════════════════════════════════════════════════

  _renderFull() {
    // Nothing to show — single concise tile
    if (this._trackedSessions.size === 0) {
      return [
        { op: 'clear' },
        { op: 'upsert', id: 'sa-empty', type: 'alert', data: {
          title: 'No active sub-agents',
          message: 'Sub-agents will appear here when spawned.',
          severity: 'info'
        }}
      ];
    }

    const modeLabel = this._liveMode ? '🔴 LIVE' : '📡 Poll';
    let totalPct = 0;
    for (const [, t] of this._trackedSessions) totalPct += this._getProgress(t);
    const overallPct = this._trackedSessions.size > 0
      ? Math.round(totalPct / this._trackedSessions.size) : 0;

    const ops = [
      { op: 'clear' },
      { op: 'upsert', id: 'sa-header', type: 'hero', data: {
        title: '🤖 Sub-agent Sprint',
        subtitle: `${this._trackedSessions.size} agents · ${modeLabel} · ${overallPct}%`,
        icon: '⚡',
        gradient: true
      }},
      // Overall progress gauge
      { op: 'upsert', id: 'sa-overall', type: 'gauge', data: {
        label: 'Overall',
        value: overallPct,
        max: 100,
        unit: '%',
        color: '#8b5cf6'
      }},
      { op: 'upsert', id: 'sa-stats', type: 'stats', data: {
        title: 'Progress',
        items: [
          { label: 'Active', value: String(this._trackedSessions.size) },
          { label: 'Complete', value: '0' },
          { label: 'Failed', value: '0' }
        ]
      }}
    ];

    // Per-agent: progress bar + activity card + detail button
    for (const [key, tracked] of this._trackedSessions) {
      const safeId = this._safeId(key);
      const pct = this._getProgress(tracked);
      const color = tracked.status === 'complete' ? '#22c55e' : tracked.status === 'failed' ? '#ef4444' : '#8b5cf6';

      ops.push({ op: 'upsert', id: `sa-prog-${safeId}`, type: 'progress', data: {
        label: `${tracked.label} — ${pct}%`,
        value: pct,
        max: 100,
        color
      }});

      ops.push({ op: 'upsert', id: `sa-card-${safeId}`, type: 'card', data: {
        title: tracked.lastActivity || 'Starting...',
        text: `⏱ ${this._formatElapsed(Date.now() - tracked.startTime)} · 🪙 ${tracked.tokens > 1000 ? (tracked.tokens / 1000).toFixed(1) + 'k' : tracked.tokens} tokens`
      }});

      ops.push({ op: 'upsert', id: `sa-btn-${safeId}`, type: 'buttons', data: {
        buttons: [{ label: '📋 Detail', action: 'subagent-detail', style: 'ghost', context: { sessionKey: key } }]
      }});
    }

    ops.push({ op: 'upsert', id: 'sa-stop', type: 'buttons', data: {
      buttons: [{ label: '⏹ Stop Monitoring', action: 'subagent-stop', style: 'ghost' }]
    }});

    return ops;
  }

  // ═══════════════════════════════════════════════════════
  //  POLL MODE — 3s interval (called by serve.js)
  // ═══════════════════════════════════════════════════════

  getLiveUpdate() {
    if (this._trackedSessions.size === 0) return null;

    // Build merged store from ALL agent directories
    let store = {};
    for (const sessDir of _getAllSessionDirs()) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessDir, 'sessions.json'), 'utf-8'));
        for (const [k, v] of Object.entries(s)) {
          store[k] = { ...v, _sessionsDir: sessDir };
        }
      } catch {}
    }
    if (Object.keys(store).length === 0) return null;

    let active = 0, complete = 0, failed = 0;
    const ops = [];

    for (const [key, tracked] of this._trackedSessions) {
      const entry = store[key];
      if (!entry) continue;

      if (entry.totalTokens) tracked.tokens = entry.totalTokens;
      tracked.lastUpdate = entry.updatedAt || tracked.lastUpdate;

      if (!tracked.sessionId && entry.sessionId) {
        tracked.sessionId = entry.sessionId;
        if (this._liveMode && !this._watchers.has(key)) {
          this._startWatcherForKey(key, entry);
        }
      }

      // Always check JSONL for completion (safety net for both modes)
      // LIVE mode can miss final writes due to race conditions
      if (tracked.status === 'running') {
        const done = this._isSessionComplete(entry);
        if (done === 'complete') {
          tracked.status = 'complete';
          tracked.eventLog.push({ time: Date.now() - tracked.startTime, type: 'complete', text: '✅ Task complete' });
        } else if (done === 'failed') {
          tracked.status = 'failed';
          tracked.eventLog.push({ time: Date.now() - tracked.startTime, type: 'error', text: '❌ Failed' });
        }

        if (tracked.status === 'running') {
          tracked.lastActivity = this._getLastActivity(entry) || tracked.lastActivity;
        }
      }

      if (tracked.status === 'complete') complete++;
      else if (tracked.status === 'failed') failed++;
      else active++;

      // Per-agent patches (only for overview mode)
      if (this._currentView !== 'detail') {
        const patchOps = this._buildAgentPatch(key, tracked);
        ops.push(...patchOps);
      }
    }

    // If in detail view, push incremental patches (not full re-render)
    if (this._currentView === 'detail' && this._detailSessionKey) {
      const tracked = this._trackedSessions.get(this._detailSessionKey);
      if (tracked) {
        const detailOps = [];
        // Patch progress bar
        const elapsed = Date.now() - tracked.startTime;
        const progress = tracked.status === 'complete' ? 100 : tracked.status === 'failed' ? 100 : Math.min(95, Math.round(20 * Math.log10(1 + elapsed / 10000)));
        detailOps.push({ op: 'patch', id: 'sa-detail-progress', data: {
          value: progress,
          label: tracked.status === 'complete' ? '✅ Complete' : tracked.status === 'failed' ? '❌ Failed' : `⏱️ ${this._formatElapsed(elapsed)}`,
          color: tracked.status === 'complete' ? '#22c55e' : tracked.status === 'failed' ? '#ef4444' : '#6366f1',
        }});
        // Patch stats
        const tokenStr = tracked.tokens >= 1000 ? `${Math.round(tracked.tokens / 1000)}K` : String(tracked.tokens || 0);
        detailOps.push({ op: 'patch', id: 'sa-detail-info', data: {
          items: [
            { label: 'Status', value: tracked.status },
            { label: 'Elapsed', value: this._formatElapsed(elapsed) },
            { label: 'Tokens', value: tokenStr },
            { label: 'Events', value: String(tracked.eventLog.length) },
          ],
        }});
        // Patch timeline if new events
        if (tracked.eventLog.length > 0) {
          detailOps.push({ op: 'patch', id: 'sa-detail-timeline', data: {
            items: tracked.eventLog.slice(-15).map(e => ({
              title: e.type,
              text: e.text || '',
              time: this._formatElapsed(e.time),
              icon: e.type === 'complete' ? '✅' : e.type === 'error' ? '❌' : e.type === 'tool' ? '🔧' : e.type === 'thinking' ? '🧠' : '📝',
            })),
          }});
        }
        return { ops: detailOps };
      }
    }

    if (active === 0 && this._trackedSessions.size > 0) {
      ops.push({ op: 'patch', id: 'sa-header', data: {
        title: '🤖 Sprint Complete',
        subtitle: `${complete} done, ${failed} failed · ${this._formatElapsed(Date.now() - this._startTime)}`
      }});
      ops.push({ op: 'patch', id: 'sa-overall', data: { value: 100, color: failed > 0 ? '#ef4444' : '#22c55e' }});
      this._stopWatchers();
      return { ops, done: true };
    }

    return ops.length > 0 ? { ops } : null;
  }

  _isSessionComplete(entry) {
    if (!entry.sessionId) return 'running';
    try {
      const sessDir = entry._sessionsDir || SESSIONS_DIR;
      let filePath = path.join(sessDir, entry.sessionId + '.jsonl');
      if (!fs.existsSync(filePath)) {
        // Check for deleted/renamed variants — OpenClaw renames on cleanup
        const deleted = this._findDeletedFile(entry.sessionId, sessDir);
        if (deleted) return 'complete'; // File was cleaned up = session finished
        // Also check all dirs in case the entry didn't have _sessionsDir
        const deletedAny = this._findDeletedFile(entry.sessionId);
        if (deletedAny) return 'complete';
        return 'running';
      }

      const stat = fs.statSync(filePath);
      const fd = fs.openSync(filePath, 'r');
      const readSize = Math.min(stat.size, 3072);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);

      const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());

      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        try {
          const obj = JSON.parse(lines[i]);
          const msg = obj.message || obj;
          const sr = msg.stopReason || msg.stop_reason || '';
          if (sr === 'end_turn' || sr === 'stop') return 'complete';
          if (msg.error || obj.error) return 'failed';
        } catch { continue; }
      }

      if (Date.now() - stat.mtimeMs > 300000) return 'complete';
      return 'running';
    } catch { return 'running'; }
  }

  _getLastActivity(entry) {
    if (!entry.sessionId) return '';
    try {
      const sessDir = entry._sessionsDir || SESSIONS_DIR;
      let filePath = path.join(sessDir, entry.sessionId + '.jsonl');
      if (!fs.existsSync(filePath)) {
        const deleted = this._findDeletedFile(entry.sessionId, sessDir);
        if (!deleted) return '';
        filePath = deleted;
      }

      const stat = fs.statSync(filePath);
      const fd = fs.openSync(filePath, 'r');
      const readSize = Math.min(stat.size, 4096);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);

      const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
        try {
          const obj = JSON.parse(lines[i]);
          const msg = obj.message || obj;
          const activity = this._extractActivity(msg);
          if (activity) return activity.text;
        } catch { continue; }
      }
      return '';
    } catch { return ''; }
  }

  _stopWatchers() {
    for (const [, { watcher }] of this._watchers) {
      try { watcher.close(); } catch {}
    }
    this._watchers.clear();
  }

  // ═══════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════

  _safeId(key) {
    return key.replace(/[^a-zA-Z0-9]/g, '-').slice(-20);
  }

  _formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return `${m}m ${r}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
}

module.exports = SubagentMonitor;
