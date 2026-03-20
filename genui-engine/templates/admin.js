/**
 * Admin Dashboard Widget — Scratchy GenUI
 * Manages users, quotas, sessions, and usage stats.
 * Prefix: admin-
 *
 * Accesses userStore/sessionStore/quotaStore directly (no HTTP).
 * Constructor: new AdminWidget({ userStore, sessionStore, quotaStore })
 */

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Role colors
const ROLE_COLORS = {
  admin: '#7c3aed',
  operator: '#3b82f6',
  viewer: '#6b7280',
};
const STATUS_COLORS = {
  active: '#10b981',
  disabled: '#ef4444',
};

class AdminWidget {
  constructor({ userStore, sessionStore, quotaStore, usageQuery, previewSessions, versionStore }) {
    this.userStore = userStore;
    this.sessionStore = sessionStore;
    this.quotaStore = quotaStore;
    this.usageQuery = usageQuery || null; // New usage system (Phase 29)
    this.previewSessions = previewSessions || new Set();
    this._versionStore = versionStore || null;
    this._deployWidget = null;
    this._connections = null;
    this._msgTimestamps = []; // rolling window for message rate calc
    // Pre-warm CPU snapshot so first render has a valid delta
    this._lastCpuSnapshot = this._snapshotCpu();
  }

  /** Inject the WS session isolator's connections Map */
  setConnections(connectionsMap) {
    this._connections = connectionsMap;
  }

  /** Snapshot CPU ticks for delta-based percentage */
  _snapshotCpu() {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times)) total += cpu.times[type];
      idle += cpu.times.idle;
    }
    return { idle, total, cores: cpus.length };
  }

  /** Record a message timestamp for rate tracking */
  recordMessage() {
    const now = Date.now();
    this._msgTimestamps.push(now);
    // Keep only last 5 minutes
    const cutoff = now - 5 * 60 * 1000;
    while (this._msgTimestamps.length > 0 && this._msgTimestamps[0] < cutoff) {
      this._msgTimestamps.shift();
    }
  }

  // ─── Entry Point ──────────────────────────────────────

  async handleAction(action, context) {
    try {
      switch (action) {
        case 'admin-dashboard':     return this._dashboard();
        case 'admin-list-users':    return this._listUsers();
        case 'admin-invite':        return this._inviteForm();
        case 'admin-invite-submit': return this._inviteSubmit(context);
        case 'admin-user-detail':   return this._userDetail(context);
        case 'admin-edit-role':     return this._editRole(context);
        case 'admin-toggle-status': return this._toggleStatus(context);
        case 'admin-edit-quota':    return this._editQuotaForm(context);
        case 'admin-save-quota':    return this._saveQuota(context);
        case 'admin-reset-usage':   return this._resetUsage(context);
        case 'admin-delete-user':
          console.log('[AdminWidget] DELETE USER called with context:', JSON.stringify(context));
          return this._deleteUser(context);
        case 'admin-cap-toggle':      return this._toggleCapability(context);
        case 'admin-cap-reset':      return this._resetCapabilities(context);
        case 'admin-change-password': return this._changePasswordForm(context);
        case 'admin-save-password': return this._savePassword(context);
        case 'admin-set-model': return this._setModelForm(context);
        case 'admin-save-model': return this._saveModel(context);
        case 'admin-send-invite':  return this._sendInviteEmail(context);
        case 'admin-monitor':       return this._monitor();
        case 'admin-quotas':        return this._quotas();
        case 'admin-providers':     return this._providers();
        case 'admin-subagents':     return this._subagentsTrigger();
        case 'admin-toggle-preview': return this._togglePreview(context);

        case 'admin-set-trial': {
          const { userId, days, hours } = context;
          if (!userId || (!days && !hours)) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'Missing userId or duration', severity: 'error' }}]};
          const ms = ((days || 0) * 24 * 60 * 60 * 1000) + ((hours || 0) * 60 * 60 * 1000);
          const expiresAt = new Date(Date.now() + ms).toISOString();
          this.userStore.updateUser(userId, { trialExpiresAt: expiresAt });
          return this._userDetail({ userId });
        }

        case 'admin-set-trial-custom': {
          const { userId } = context;
          if (!userId) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'Missing userId', severity: 'error' }}]};
          // Show a form to enter custom duration
          return { ops: [
            { op: 'clear' },
            ...this._nav(''),
            { op: 'upsert', id: 'admin-trial-custom-form', type: 'form', data: {
              title: '⏰ Set Custom Trial Duration',
              id: 'admin-trial-custom-form',
              fields: [
                { name: 'userId', type: 'hidden', value: userId },
                { name: 'days', type: 'number', label: 'Days', value: '0', placeholder: '0' },
                { name: 'hours', type: 'number', label: 'Hours', value: '0', placeholder: '0' },
              ],
              actions: [
                { label: '✅ Set Trial', action: 'admin-set-trial-custom-submit', style: 'primary' },
              ],
            }},
            { op: 'upsert', id: 'admin-trial-custom-back', type: 'buttons', data: {
              buttons: [
                { label: '← Back to User', action: 'admin-user-detail', style: 'ghost', context: { userId } },
              ],
            }},
          ] };
        }

        case 'admin-set-trial-custom-submit': {
          const { userId, days, hours } = context;
          const d = parseInt(days) || 0;
          const h = parseInt(hours) || 0;
          if (!userId || (d === 0 && h === 0)) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'Enter at least 1 hour or 1 day', severity: 'error' }}]};
          const ms = (d * 24 * 60 * 60 * 1000) + (h * 60 * 60 * 1000);
          const expiresAt = new Date(Date.now() + ms).toISOString();
          this.userStore.updateUser(userId, { trialExpiresAt: expiresAt });
          return this._userDetail({ userId });
        }

        case 'admin-extend-trial': {
          const { userId, days, hours } = context;
          if (!userId || (!days && !hours)) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'Missing userId or duration', severity: 'error' }}]};
          const user = this.userStore.getById(userId);
          const currentExpiry = user?.trialExpiresAt ? new Date(user.trialExpiresAt) : new Date();
          const base = currentExpiry > new Date() ? currentExpiry : new Date();
          const ms = ((days || 0) * 24 * 60 * 60 * 1000) + ((hours || 0) * 60 * 60 * 1000);
          const expiresAt = new Date(base.getTime() + ms).toISOString();
          this.userStore.updateUser(userId, { trialExpiresAt: expiresAt });
          return this._userDetail({ userId });
        }

        case 'admin-remove-trial': {
          const { userId } = context;
          if (!userId) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'Missing userId', severity: 'error' }}]};
          this.userStore.updateUser(userId, { trialExpiresAt: null });
          return this._userDetail({ userId });
        }

        // ── Deploy Manager (integrated) ──
        case 'admin-deploy':
        case 'admin-deploy-manager': return this._deployAction('deploy-manager', context);
        case 'admin-deploy-detail': return this._deployAction('deploy-detail', context);
        case 'admin-deploy-push':   return this._deployAction('deploy-push', context);
        case 'admin-deploy-push-all': return this._deployAction('deploy-push-all', context);
        case 'admin-deploy-revert': return this._deployAction('deploy-revert', context);
        case 'admin-deploy-set-default': return this._deployAction('deploy-set-default', context);
        case 'admin-deploy-purge':  return this._deployAction('deploy-purge', context);
        case 'admin-deploy-users':  return this._deployAction('deploy-users', context);

        default:
          return { ops: [
            { op: 'upsert', id: 'admin-error', type: 'alert', data: {
              title: 'Unknown Action', message: `No handler for: ${action}`, severity: 'error'
            }}
          ]};
      }
    } catch (err) {
      console.error('[AdminWidget]', err.message);
      return { ops: [
        { op: 'clear' },
        ...this._nav('error'),
        { op: 'upsert', id: 'admin-error', type: 'alert', data: {
          title: 'Error', message: err.message, severity: 'error'
        }}
      ]};
    }
  }

  // ─── Deploy Manager (delegated) ────────────────────────

  async _deployAction(originalAction, context) {
    if (!this._deployWidget) {
      const DeployManagerWidget = require('./deploy-manager.js');
      this._deployWidget = new DeployManagerWidget({
        versionStore: this._versionStore,
        userStore: this.userStore,
      });
    }
    const result = await this._deployWidget.handleAction(originalAction, context);
    if (result && result.ops) {
      // Remap deploy-* actions to admin-deploy-* in all ops
      for (const op of result.ops) {
        if (op.data) {
          // Remap action fields in cards
          if (op.data.action && op.data.action.startsWith('deploy-')) {
            op.data.action = 'admin-' + op.data.action;
          }
          // Remap action fields in buttons arrays
          if (op.data.buttons) {
            for (const btn of op.data.buttons) {
              if (btn.action && btn.action.startsWith('deploy-')) {
                btn.action = 'admin-' + btn.action;
              }
              // Keep admin-dashboard as-is (already correct prefix)
            }
          }
          // Remap action fields in table row objects
          if (op.data.rows) {
            for (const row of op.data.rows) {
              if (Array.isArray(row)) {
                for (const cell of row) {
                  if (cell && typeof cell === 'object' && cell.action && cell.action.startsWith('deploy-')) {
                    cell.action = 'admin-' + cell.action;
                  }
                }
              }
            }
          }
        }
      }
      // Inject admin nav at the top (after clear op if present)
      const navOps = this._nav('deploy');
      const clearIdx = result.ops.findIndex(op => op.op === 'clear');
      if (clearIdx >= 0) {
        result.ops.splice(clearIdx + 1, 0, ...navOps);
      } else {
        result.ops.unshift(...navOps);
      }
      // Remove the deploy-nav button (we have admin nav now)
      result.ops = result.ops.filter(op => op.id !== 'deploy-nav');
    }
    return result;
  }

  // ─── Navigation ───────────────────────────────────────

  _nav(active, extra = []) {
    const previewOn = this.previewSessions.size > 0;
    const tabs = [
      { label: '📊 Dashboard', action: 'admin-dashboard', style: active === 'dashboard' ? 'primary' : 'ghost' },
      { label: '🖥️ Monitor', action: 'admin-monitor', style: active === 'monitor' ? 'primary' : 'ghost' },
      { label: '👥 Users', action: 'admin-list-users', style: active === 'users' ? 'primary' : 'ghost' },
      { label: '📈 Quotas', action: 'admin-quotas', style: active === 'quotas' ? 'primary' : 'ghost' },
      { label: '🔑 Providers', action: 'admin-providers', style: active === 'providers' ? 'primary' : 'ghost' },
      { label: '➕ Invite', action: 'admin-invite', style: active === 'invite' ? 'primary' : 'ghost' },
      { label: '📊 Analytics', action: 'admin-analytics', style: active === 'analytics' ? 'primary' : 'ghost' },
      { label: '🤖 Sub-Agents', action: 'admin-subagents', style: active === 'subagents' ? 'primary' : 'ghost' },
      { label: '🚀 Deploy', action: 'admin-deploy', style: active === 'deploy' ? 'primary' : 'ghost' },
      { label: previewOn ? '🧪 Preview ✓' : '🧪 Preview', action: 'admin-toggle-preview', style: previewOn ? 'primary' : 'ghost' },
      ...extra,
    ];
    return [{ op: 'upsert', id: 'admin-nav', type: 'buttons', data: { buttons: tabs } }];
  }

  // ─── Helpers ──────────────────────────────────────────

  /**
   * Merge today + cumulative provider data for the detail view.
   * Returns entries with both tokensToday/costToday and cumulative cost/tokens.
   */
  /**
   * Merge today + cumulative provider data for the detail view.
   * UsageQuery byProvider format: { cost, messages, models[] }
   * Output format: { tokens, tokensToday, cost, costToday, models[] }
   */
  _mergeProviderData(todayByProvider, cumulativeByProvider) {
    const merged = {};
    // Start with cumulative data
    if (cumulativeByProvider) {
      for (const [prov, d] of Object.entries(cumulativeByProvider)) {
        merged[prov] = {
          tokens: d.messages || 0, // use messages as proxy for "activity"
          tokensToday: 0,
          cost: d.cost || 0,
          costToday: 0,
          models: Array.isArray(d.models) ? [...d.models] : [],
        };
      }
    }
    // Overlay today's data
    if (todayByProvider) {
      for (const [prov, d] of Object.entries(todayByProvider)) {
        if (!merged[prov]) {
          merged[prov] = { tokens: 0, tokensToday: 0, cost: 0, costToday: 0, models: [] };
        }
        merged[prov].tokensToday = d.messages || 0;
        merged[prov].costToday = d.cost || 0;
        // Merge model lists
        if (d.models && Array.isArray(d.models)) {
          const existing = new Set(merged[prov].models);
          d.models.forEach(m => existing.add(m));
          merged[prov].models = [...existing];
        }
      }
    }
    return merged;
  }

  _formatTokens(n) {
    if (n == null) return '∞';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return String(n);
  }

  _formatDate(isoStr) {
    if (!isoStr) return 'Never';
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now - d;
    if (diffMs < 60000) return 'Just now';
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
    if (diffMs < 604800000) return Math.floor(diffMs / 86400000) + 'd ago';
    return d.toISOString().substring(0, 10);
  }

  _roleColor(role) {
    return ROLE_COLORS[role] || '#6b7280';
  }

  _statusColor(status) {
    return STATUS_COLORS[status] || '#6b7280';
  }

  _roleEmoji(role) {
    if (role === 'admin') return '👑';
    if (role === 'operator') return '🔧';
    return '👁️';
  }

  _inviteEmailBody(name, email, tempPassword, role) {
    const firstName = name.split(/\s+/)[0];
    return [
      `Hi ${firstName},`,
      ``,
      `You've been invited to Scratchy as ${role}.`,
      ``,
      `Here are your credentials:`,
      `  Email: ${email}`,
      `  Temporary Password: ${tempPassword}`,
      ``,
      `Log in at: https://scratchy.example.com`,
      ``,
      `Please change your password after your first login.`,
      ``,
      `— Scratchy Admin`
    ].join('\n');
  }

  /**
   * Reset password for existing user + auto-open invite email compose
   * Password generated and stored server-side — never in WS payload or chat
   */
  async _sendInviteEmail(context) {
    const { userId } = context;
    if (!userId) return { ops: [{ op: 'upsert', id: 'admin-err', type: 'alert', data: { title: 'Error', message: 'No userId.', severity: 'error' } }] };

    const user = this.userStore.getById(userId);
    if (!user) return { ops: [{ op: 'upsert', id: 'admin-err', type: 'alert', data: { title: 'Error', message: 'User not found.', severity: 'error' } }] };

    // Generate new temp password + hash
    const tempPassword = this._generateTempPassword();
    const { hashPassword } = require('./../../lib/auth/password');
    const passwordHash = await hashPassword(tempPassword);

    // Update user's password
    this.userStore.updateUser(userId, { passwordHash });
    console.log(`[AdminWidget] Password reset for invite: ${user.email}`);

    // Build invite email data — stays server-side via pendingInvite
    const pendingInvite = {
      to: user.email,
      subject: 'Welcome to Scratchy — Your Account is Ready',
      body: this._inviteEmailBody(user.displayName, user.email, tempPassword, user.role),
      _returnUserId: user.id,
    };

    return {
      pendingInvite,
      ops: [
        { op: 'upsert', id: 'admin-invite-reset-ok', type: 'alert', data: {
          title: '🔑 Password Reset',
          message: `New temporary password generated for ${user.displayName}. Opening email compose...`,
          severity: 'success',
        }},
        { op: 'trigger', action: 'mail-compose-invite' },
      ],
    };
  }

  /**
   * Read token usage from session JSONL files (authoritative source).
   * Maps userId → {
   *   inputTokens, outputTokens, totalTokens, tokensToday,
   *   costTotal, costToday, msgCount, todayMsgCount,
   *   model, provider,
   *   byProvider: { [provider]: { tokens, tokensToday, cost, costToday, models: Set } }
   * }
   * Reads sessions.json for session ID mapping, then parses JSONL for usage data.
   * Caches results for 30s to avoid repeated file reads.
   */
  _getGatewayTokenUsage() {
    // Cache: avoid re-reading JSONL files on every dashboard render
    const now = Date.now();
    if (this._usageCache && (now - this._usageCacheTime) < 30000) {
      return this._usageCache;
    }

    const result = new Map();
    const sessionsDir = path.join(
      process.env.HOME || '.',
      '.openclaw', 'agents', 'main', 'sessions'
    );
    const sessionsFile = path.join(sessionsDir, 'sessions.json');

    try {
      if (!fs.existsSync(sessionsFile)) return result;
      const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));

      // Today's date string (YYYY-MM-DD) for daily filtering
      const todayStr = new Date().toISOString().slice(0, 10);

      for (const [key, session] of Object.entries(data)) {
        // Match both "main:webchat:{userId}" and "agent:main:webchat:{userId}"
        const match = key.match(/^(?:agent:)?main:webchat:(.+)$/);
        const isAdmin = key === 'agent:main:main';
        if (!match && !isAdmin) continue;

        let userId = match ? match[1] : null;
        // For admin main session, find the admin user in the user store
        if (isAdmin && !userId) {
          const adminUsers = this.userStore ? this.userStore.listUsers().filter(u => u.role === 'admin') : [];
          userId = adminUsers.length > 0 ? adminUsers[0].id : '_admin';
        }
        const sessionId = session.sessionId;
        if (!sessionId) continue;

        const jsonlFile = path.join(sessionsDir, `${sessionId}.jsonl`);
        if (!fs.existsSync(jsonlFile)) continue;

        // Parse JSONL for usage data
        let totalInput = 0, totalOutput = 0, totalTokens = 0, totalCost = 0;
        let todayInput = 0, todayOutput = 0, todayTokens = 0, todayCost = 0;
        let msgCount = 0, todayMsgCount = 0;
        const byProvider = {}; // provider → { tokens, tokensToday, cost, costToday, models }

        try {
          const content = fs.readFileSync(jsonlFile, 'utf8');
          const lines = content.split('\n');
          for (const line of lines) {
            if (!line.trim() || !line.includes('"usage"')) continue;
            try {
              const entry = JSON.parse(line);
              const msg = entry.message;
              if (!msg || !msg.usage) continue;

              const usage = msg.usage;
              const input = usage.input || 0;
              const output = usage.output || 0;
              // Use input+output as meaningful "consumed" tokens (totalTokens includes cache = context window size per turn)
              const tokens = input + output;
              const cost = usage.cost?.total || 0;
              const provider = msg.provider || 'unknown';
              const model = msg.model || 'unknown';

              totalInput += input;
              totalOutput += output;
              totalTokens += tokens;
              totalCost += cost;
              msgCount++;

              // Per-provider tracking
              if (!byProvider[provider]) {
                byProvider[provider] = { tokens: 0, tokensToday: 0, cost: 0, costToday: 0, models: new Set() };
              }
              byProvider[provider].tokens += tokens;
              byProvider[provider].cost += cost;
              byProvider[provider].models.add(model);

              // Check if this message is from today
              const ts = entry.timestamp || msg.timestamp;
              let dateStr = '';
              if (typeof ts === 'number') {
                dateStr = new Date(ts > 1e12 ? ts : ts * 1000).toISOString().slice(0, 10);
              } else if (typeof ts === 'string') {
                dateStr = ts.slice(0, 10);
              }
              if (dateStr === todayStr) {
                todayInput += input;
                todayOutput += output;
                todayTokens += tokens;
                todayCost += cost;
                todayMsgCount++;
                byProvider[provider].tokensToday += tokens;
                byProvider[provider].costToday += cost;
              }
            } catch (e) { /* skip malformed lines */ }
          }
        } catch (err) {
          console.error(`[AdminWidget] Failed to parse JSONL ${sessionId}:`, err.message);
        }

        // Convert Set → Array for serialization
        for (const p of Object.values(byProvider)) {
          p.models = [...p.models];
        }

        result.set(userId, {
          inputTokens: totalInput,
          outputTokens: totalOutput,
          totalTokens,
          tokensToday: todayTokens,
          costTotal: totalCost,
          costToday: todayCost,
          msgCount,
          todayMsgCount,
          model: session.model || null,
          provider: session.modelProvider || null,
          byProvider,
        });
      }
    } catch (err) {
      console.error('[AdminWidget] Failed to read gateway sessions:', err.message);
    }

    this._usageCache = result;
    this._usageCacheTime = now;
    return result;
  }

  _getEnrichedUsers() {
    const users = this.userStore.listUsers();

    // ── Phase 29: Use new UsageQuery if available (single source of truth) ──
    if (this.usageQuery) {
      return users.map(u => {
        const today = this.usageQuery.getTodayUsage(u.id);
        const cumulative = this.usageQuery.getCumulativeUsage(u.id);
        const isByok = u.preferences && u.preferences.plan === 'own-key';
        const mergedUsage = {
          // From UsageQuery — single source, no more dual-source merge
          messagesThisHour: this.usageQuery.getMessagesThisHour(u.id),
          messagesToday: today.messages || 0,
          tokensCumulative: cumulative.totalTokens || 0,
          tokensToday: today.totalTokens || 0,
          inputTokens: today.inputTokens || 0,
          outputTokens: today.outputTokens || 0,
          cacheReadTokens: today.cacheReadTokens || 0,
          cacheWriteTokens: today.cacheWriteTokens || 0,
          costTotal: cumulative.cost || 0,
          costToday: today.cost || 0,
          byProvider: this._mergeProviderData(today.byProvider, cumulative.byProvider),
          byModel: cumulative.byModel || {},
          toolUsage: cumulative.toolUsage || {},
          hourlyActivity: today.hourlyActivity || {},
          isByok,
          costSource: isByok ? 'user' : 'platform',
        };
        return {
          ...u,
          usage: mergedUsage,
          quotaOverrides: this.quotaStore.getQuotaOverrides(u.id),
          effectiveQuota: this.quotaStore.getEffectiveQuota(u),
          sessionCount: this.sessionStore.listUserSessions(u.id).length,
        };
      });
    }

    // ── Legacy fallback: old dual-source merge (will be removed) ──
    const gwUsage = this._getGatewayTokenUsage();
    return users.map(u => {
      const quotaUsage = this.quotaStore.getUsageStats(u.id);
      const gwTokens = gwUsage.get(u.id) || null;
      const isByok = u.preferences && u.preferences.plan === 'own-key';
      const mergedUsage = {
        ...quotaUsage,
        tokensCumulative: gwTokens ? gwTokens.totalTokens : 0,
        tokensToday: gwTokens ? gwTokens.tokensToday : 0,
        inputTokens: gwTokens ? gwTokens.inputTokens : 0,
        outputTokens: gwTokens ? gwTokens.outputTokens : 0,
        costTotal: gwTokens ? gwTokens.costTotal : 0,
        costToday: gwTokens ? gwTokens.costToday : 0,
        model: gwTokens ? gwTokens.model : null,
        provider: gwTokens ? gwTokens.provider : null,
        byProvider: gwTokens ? gwTokens.byProvider : {},
        isByok,
        costSource: isByok ? 'user' : 'platform',
      };
      return {
        ...u,
        usage: mergedUsage,
        quotaOverrides: this.quotaStore.getQuotaOverrides(u.id),
        effectiveQuota: this.quotaStore.getEffectiveQuota(u),
        sessionCount: this.sessionStore.listUserSessions(u.id).length,
      };
    });
  }

  // ─── Dashboard View ───────────────────────────────────

  _dashboard() {
    const users = this._getEnrichedUsers();
    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.status === 'active').length;
    const disabledUsers = users.filter(u => u.status === 'disabled').length;
    const totalSessions = this.sessionStore.totalSessions();

    // Aggregate usage across all users — split platform vs BYOK
    let totalMessagesToday = 0;
    let totalTokensCumulative = 0;
    let totalTokensToday = 0;
    let platformCostToday = 0, platformCostAll = 0;
    let byokCostToday = 0, byokCostAll = 0;
    let totalMessagesThisHour = 0;
    const providerTotals = {}; // provider → { tokensToday, costToday, tokens, cost }
    for (const u of users) {
      if (u.usage) {
        totalMessagesToday += u.usage.messagesToday || 0;
        totalTokensCumulative += u.usage.tokensCumulative || 0;
        totalTokensToday += u.usage.tokensToday || 0;
        totalMessagesThisHour += u.usage.messagesThisHour || 0;
        if (u.usage.costSource === 'user') {
          byokCostToday += u.usage.costToday || 0;
          byokCostAll += u.usage.costTotal || 0;
        } else {
          platformCostToday += u.usage.costToday || 0;
          platformCostAll += u.usage.costTotal || 0;
        }
        // Aggregate per-provider
        if (u.usage.byProvider) {
          for (const [prov, pd] of Object.entries(u.usage.byProvider)) {
            if (!providerTotals[prov]) providerTotals[prov] = { tokensToday: 0, costToday: 0, tokens: 0, cost: 0 };
            providerTotals[prov].tokensToday += pd.tokensToday || 0;
            providerTotals[prov].costToday += pd.costToday || 0;
            providerTotals[prov].tokens += pd.tokens || 0;
            providerTotals[prov].cost += pd.cost || 0;
          }
        }
      }
    }

    // Role distribution
    const admins = users.filter(u => u.role === 'admin').length;
    const operators = users.filter(u => u.role === 'operator').length;
    const viewers = users.filter(u => u.role === 'viewer').length;

    // Top users by messages today
    const topUsers = [...users]
      .filter(u => u.usage && u.usage.messagesToday > 0)
      .sort((a, b) => (b.usage.messagesToday || 0) - (a.usage.messagesToday || 0))
      .slice(0, 5);

    const ops = [
      { op: 'clear' },
      ...this._nav('dashboard'),

      // Overview stats
      { op: 'upsert', id: 'admin-stats', type: 'stats', data: {
        title: '🛡️ Admin Dashboard',
        items: [
          { label: 'Total Users', value: String(totalUsers) },
          { label: 'Active', value: String(activeUsers) },
          { label: 'Disabled', value: String(disabledUsers) },
          { label: 'Sessions', value: String(totalSessions) },
        ],
      }},

      // Usage gauges
      { op: 'upsert', id: 'admin-gauge-msgs-hour', type: 'gauge', data: {
        label: 'Messages This Hour',
        value: totalMessagesThisHour,
        max: Math.max(totalMessagesThisHour, 100),
        unit: 'msgs',
        color: '#3b82f6',
      }},
      { op: 'upsert', id: 'admin-gauge-msgs-day', type: 'gauge', data: {
        label: 'Messages Today',
        value: totalMessagesToday,
        max: Math.max(totalMessagesToday, 500),
        unit: 'msgs',
        color: '#8b5cf6',
      }},
      { op: 'upsert', id: 'admin-gauge-tokens', type: 'stats', data: {
        title: '🪙 Token Usage',
        items: [
          { label: 'Tokens Today (total)', value: this._formatTokens(totalTokensToday) },
          { label: 'Tokens All Time', value: this._formatTokens(totalTokensCumulative) },
          { label: '💰 Your Cost Today', value: `$${platformCostToday.toFixed(2)}` },
          { label: '💰 Your Cost Total', value: `$${platformCostAll.toFixed(2)}` },
          ...(byokCostAll > 0 ? [
            { label: '🔑 BYOK Cost Today', value: `$${byokCostToday.toFixed(2)}` },
            { label: '🔑 BYOK Cost Total', value: `$${byokCostAll.toFixed(2)}` },
          ] : []),
        ],
      }},

      // Role distribution
      { op: 'upsert', id: 'admin-roles', type: 'tags', data: {
        label: 'Roles',
        items: [
          { text: `${admins} Admin${admins !== 1 ? 's' : ''}`, color: ROLE_COLORS.admin },
          { text: `${operators} Operator${operators !== 1 ? 's' : ''}`, color: ROLE_COLORS.operator },
          { text: `${viewers} Viewer${viewers !== 1 ? 's' : ''}`, color: ROLE_COLORS.viewer },
        ],
      }},
    ];

    // Top users table (if any activity)
    if (topUsers.length > 0) {
      ops.push({ op: 'upsert', id: 'admin-top-users', type: 'table', data: {
        title: '🔥 Most Active Today',
        headers: ['Name', 'Role', 'Messages', 'Tokens Today', 'Cost', 'Key'],
        rows: topUsers.map(u => [
          u.displayName || u.email,
          u.role,
          String(u.usage.messagesToday || 0),
          this._formatTokens(u.usage.tokensToday || 0),
          `$${(u.usage.costToday || 0).toFixed(2)}`,
          u.usage.costSource === 'user' ? '🔑' : '💰',
        ]),
      }});
    }

    // Provider breakdown (if multiple providers or any usage)
    const provEntries = Object.entries(providerTotals).sort((a, b) => b[1].costToday - a[1].costToday);
    if (provEntries.length > 0) {
      const PROVIDER_LABELS = { anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI', 'google-ai': 'Google AI' };
      ops.push({ op: 'upsert', id: 'admin-providers-breakdown', type: 'table', data: {
        title: '🏢 Cost by Provider',
        headers: ['Provider', 'Tokens Today', 'Cost Today', 'Cost Total'],
        rows: provEntries.map(([prov, d]) => [
          PROVIDER_LABELS[prov] || prov,
          this._formatTokens(d.tokensToday),
          `$${d.costToday.toFixed(2)}`,
          `$${d.cost.toFixed(2)}`,
        ]),
      }});
    }

    // Gateway Sessions (same as monitor — shows all active sessions, models, sub-agents)
    try {
      const sessFile = path.join(process.env.HOME || '.', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
      const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      const shortModel = (m) => (m || '?').replace('anthropic/', '').replace('claude-', '').replace('-20250', '').replace('-latest', '').replace('-preview', '');
      const sessionRows = [];

      for (const [key, entry] of Object.entries(sessData)) {
        let type, name;
        if (key === 'agent:main:main') { type = '🏠 Main'; name = 'Main Agent'; }
        else if (key.includes(':cron:')) { type = '⏰ Cron'; name = 'Scheduled Job'; }
        else if (key.includes(':webchat:')) {
          const userId = key.split(':').pop();
          let userName = userId;
          try { const u = this.userStore.getById(userId); if (u) userName = u.displayName || u.email || userId; } catch(_) {}
          if (userName.startsWith('usr_')) userName = userName.slice(4, 14) + '…';
          type = '💬 Chat'; name = userName;
        } else if (key.includes(':isolated:') || key.includes(':subagent:') || entry.label) {
          type = '🤖 Sub-Agent'; name = entry.label || 'Unnamed Task';
        } else { type = '❓'; name = key.split(':').pop(); }

        const model = shortModel(entry.modelOverride || entry.model);
        const provider = (entry.providerOverride || entry.modelProvider || '').replace('-messages', '');
        const tokens = entry.totalTokens || 0;
        const tokenStr = tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
        let skillCount = 0;
        if (entry.skillsSnapshot && entry.skillsSnapshot.prompt) {
          skillCount = (entry.skillsSnapshot.prompt.match(/<name>/g) || []).length;
        }
        const now = Date.now();
        const agoMs = entry.updatedAt ? now - entry.updatedAt : 0;
        const ago = agoMs < 60000 ? 'just now' : agoMs < 3600000 ? `${Math.round(agoMs / 60000)}m ago` : agoMs < 86400000 ? `${Math.round(agoMs / 3600000)}h ago` : `${Math.round(agoMs / 86400000)}d ago`;
        sessionRows.push([type, name, `${provider ? provider + '/' : ''}${model}`, tokenStr, `${skillCount} skills`, ago]);
      }

      if (sessionRows.length > 0) {
        ops.push({ op: 'upsert', id: 'admin-dash-sessions', type: 'table', data: {
          title: `🔗 Gateway Sessions (${sessionRows.length})`,
          headers: ['Type', 'Name', 'Model', 'Tokens', 'Skills', 'Activity'],
          rows: sessionRows,
        }});
      }
    } catch (_) { /* non-fatal */ }

    return { ops };
  }

  // ─── User List ────────────────────────────────────────

  _listUsers() {
    const users = this._getEnrichedUsers();

    const rows = users.map(u => {
      const msgToday = u.usage ? String(u.usage.messagesToday || 0) : '0';
      const statusLabel = u.status === 'active' ? '✅' : '🚫';
      const roleLabel = `${this._roleEmoji(u.role)} ${u.role}`;

      return [
        u.displayName || u.email.split('@')[0],
        roleLabel,
        statusLabel,
        msgToday,
        // Inline action buttons (rendered as clickable buttons by table LiveComponent)
        { text: '🔍 Detail', action: 'admin-user-detail', context: { userId: u.id }, style: 'primary' },
        u.status === 'active'
          ? { text: '🚫 Disable', action: 'admin-toggle-status', context: { userId: u.id, currentStatus: 'active' } }
          : { text: '✅ Enable', action: 'admin-toggle-status', context: { userId: u.id, currentStatus: 'disabled' } },
      ];
    });

    return { ops: [
      { op: 'clear' },
      ...this._nav('users'),
      { op: 'upsert', id: 'admin-user-table', type: 'table', data: {
        title: `👥 All Users (${users.length})`,
        headers: ['Name', 'Role', 'Status', 'Msgs', '', ''],
        rows,
      }},
    ]};
  }

  // ─── Invite Form ──────────────────────────────────────

  _inviteForm() {
    return { ops: [
      { op: 'clear' },
      ...this._nav('invite'),
      { op: 'upsert', id: 'admin-invite-form', type: 'form', data: {
        id: 'admin-invite-form',
        title: '➕ Invite New User',
        fields: [
          { name: 'displayName', type: 'text', label: 'Display Name', placeholder: 'John Doe', required: true },
          { name: 'email', type: 'email', label: 'Email', placeholder: 'auto-generated from name, or type custom', required: false },
          { name: 'role', type: 'select', label: 'Role', value: 'operator', options: [
            { label: '👑 Admin', value: 'admin' },
            { label: '🔧 Operator', value: 'operator' },
            { label: '👁️ Viewer', value: 'viewer' },
          ]},
        ],
        actions: [
          { label: '← Back', action: 'admin-dashboard', style: 'ghost' },
          { label: 'Create User', action: 'admin-invite-submit', style: 'primary' },
        ],
      }},
    ]};
  }

  async _inviteSubmit(context) {
    let { email, displayName, role } = context;

    if (!displayName || displayName.trim().length < 2) {
      return { ops: [
        { op: 'upsert', id: 'admin-invite-error', type: 'alert', data: {
          title: 'Name Required', message: 'Please provide a display name (at least 2 characters).', severity: 'warning'
        }},
      ]};
    }

    displayName = displayName.trim();

    // Auto-generate email from display name if not provided
    if (!email || email.trim().length === 0) {
      const slug = displayName
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
        .replace(/[^a-z0-9]+/g, '.')                       // non-alphanum → dots
        .replace(/^\.+|\.+$/g, '');                        // trim dots
      email = `${slug}@example.com`;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ops: [
        { op: 'upsert', id: 'admin-invite-error', type: 'alert', data: {
          title: 'Invalid Email', message: 'Could not generate a valid email. Please enter one manually.', severity: 'warning'
        }},
      ]};
    }

    // Generate temp password
    const tempPassword = this._generateTempPassword();

    // Hash password using argon2id via the password module
    // Since we're accessing stores directly, we need to hash manually
    const { hashPassword } = require('./../../lib/auth/password');
    const passwordHash = await hashPassword(tempPassword);

    // Create user via userStore
    const userRole = ['admin', 'operator', 'viewer'].includes(role) ? role : 'operator';

    let user;
    try {
      user = this.userStore.createUser({
        email,
        displayName: displayName || email.split('@')[0],
        passwordHash,
        role: userRole,
        invitedBy: 'admin-widget',
      });
    } catch (err) {
      return { ops: [
        { op: 'clear' },
        ...this._nav('invite'),
        { op: 'upsert', id: 'admin-invite-error', type: 'alert', data: {
          title: 'Failed', message: err.message, severity: 'error'
        }},
      ]};
    }

    console.log(`[AdminWidget] User invited: ${email} (${userRole})`);

    // Side-channel: invite email data stays on the server, never in WS payload
    const pendingInvite = {
      to: user.email,
      subject: 'Welcome to Scratchy — Your Account is Ready',
      body: this._inviteEmailBody(user.displayName, user.email, tempPassword, user.role),
      _returnUserId: user.id,
    };

    return { pendingInvite, ops: [
      { op: 'clear' },
      ...this._nav('invite'),
      { op: 'upsert', id: 'admin-invite-success', type: 'alert', data: {
        title: 'User Created!',
        message: `${user.displayName} (${user.email}) has been created as ${userRole}.`,
        severity: 'success',
      }},
      { op: 'upsert', id: 'admin-invite-creds', type: 'kv', data: {
        title: '🔑 Temporary Credentials',
        items: [
          { key: 'Email', value: user.email },
          { key: 'Temp Password', value: tempPassword },
          { key: 'Role', value: `${this._roleEmoji(userRole)} ${userRole}` },
        ],
      }},
      // Auto-open email compose — trigger has NO password, data stays server-side
      { op: 'trigger', action: 'mail-compose-invite' },
    ]};
  }

  // ─── User Detail ──────────────────────────────────────

  _userDetail(context) {
    const { userId } = context;
    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [
        { op: 'clear' },
        ...this._nav('users'),
        { op: 'upsert', id: 'admin-error', type: 'alert', data: {
          title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
        }},
      ]};
    }

    const sanitized = this.userStore.sanitize(user);
    const quotaUsage = this.quotaStore.getUsageStats(userId);
    const isByok = user.preferences && user.preferences.plan === 'own-key';

    let usage;
    if (this.usageQuery) {
      // Phase 29: single source of truth from UsageQuery
      const today = this.usageQuery.getTodayUsage(userId);
      const cumulative = this.usageQuery.getCumulativeUsage(userId);
      usage = {
        ...quotaUsage,
        messagesThisHour: this.usageQuery.getMessagesThisHour(userId),
        messagesToday: today.messages || 0,
        tokensCumulative: cumulative.totalTokens || 0,
        tokensToday: today.totalTokens || 0,
        inputTokens: cumulative.inputTokens || 0,
        outputTokens: cumulative.outputTokens || 0,
        cacheReadTokens: cumulative.cacheReadTokens || 0,
        cacheWriteTokens: cumulative.cacheWriteTokens || 0,
        costTotal: cumulative.cost || 0,
        costToday: today.cost || 0,
        byProvider: this._mergeProviderData(today.byProvider, cumulative.byProvider),
        byModel: cumulative.byModel || {},
        toolUsage: cumulative.toolUsage || {},
        hourlyActivity: today.hourlyActivity || {},
        isByok,
        costSource: isByok ? 'user' : 'platform',
      };
    } else {
      // Legacy fallback
      const gwUsage = this._getGatewayTokenUsage();
      const gwTokens = gwUsage.get(userId) || null;
      usage = {
        ...quotaUsage,
        tokensCumulative: gwTokens ? gwTokens.totalTokens : 0,
        tokensToday: gwTokens ? gwTokens.tokensToday : 0,
        inputTokens: gwTokens ? gwTokens.inputTokens : 0,
        outputTokens: gwTokens ? gwTokens.outputTokens : 0,
        costTotal: gwTokens ? gwTokens.costTotal : 0,
        costToday: gwTokens ? gwTokens.costToday : 0,
        byProvider: gwTokens ? gwTokens.byProvider : {},
        isByok,
        costSource: isByok ? 'user' : 'platform',
      };
    }
    const quota = this.quotaStore.getEffectiveQuota(user);
    const overrides = this.quotaStore.getQuotaOverrides(userId);
    const sessions = this.sessionStore.listUserSessions(userId);

    // KV info
    const kvItems = [
      { key: 'ID', value: user.id },
      { key: 'Email', value: user.email },
      { key: 'Display Name', value: user.displayName || '-' },
      { key: 'Role', value: `${this._roleEmoji(user.role)} ${user.role}` },
      { key: 'Status', value: user.status === 'active' ? '✅ Active' : '🚫 Disabled' },
      { key: 'Created', value: this._formatDate(user.createdAt) },
      { key: 'Last Login', value: this._formatDate(user.lastLoginAt) },
      { key: 'Active Sessions', value: String(sessions.length) },
      { key: 'Passkeys', value: String(sanitized.passkeyCount || 0) },
      { key: 'Invited By', value: user.invitedBy || '-' },
    ];

    // Show current model override
    try {
      const sessFile = path.join(process.env.HOME || '.', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
      const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      const sessEntry = sessData[`agent:main:webchat:${user.id}`];
      const modelStr = sessEntry?.modelOverride
        ? `${sessEntry.providerOverride || ''}/${sessEntry.modelOverride}`.replace(/^\//, '')
        : 'Default (Opus)';
      kvItems.push({ key: '🤖 Model', value: modelStr });
    } catch(e) {
      kvItems.push({ key: '🤖 Model', value: 'Default (Opus)' });
    }

    const ops = [
      { op: 'clear' },
      ...this._nav('users'),

      // User info
      { op: 'upsert', id: 'admin-detail-kv', type: 'kv', data: {
        title: `${this._roleEmoji(user.role)} ${user.displayName || user.email}`,
        items: kvItems,
      }},

      // Role & status tags
      { op: 'upsert', id: 'admin-detail-tags', type: 'tags', data: {
        label: '',
        items: [
          { text: user.role, color: this._roleColor(user.role) },
          { text: user.status, color: this._statusColor(user.status) },
        ],
      }},
    ];

    // Trial period section (non-admin only)
    if (user.role !== 'admin') {
      const trialExpiry = user.trialExpiresAt ? new Date(user.trialExpiresAt) : null;
      const now = new Date();
      const isExpired = trialExpiry && trialExpiry < now;
      const msLeft = trialExpiry ? trialExpiry - now : 0;
      const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));
      const hoursLeft = Math.floor((msLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const timeLeftStr = daysLeft > 0 ? `${daysLeft}d ${hoursLeft}h` : hoursLeft > 0 ? `${hoursLeft}h` : `${Math.ceil(msLeft / 60000)}min`;

      ops.push({ op: 'upsert', id: 'admin-detail-trial', type: 'kv', data: {
        title: '⏰ Trial Period',
        items: [
          { key: 'Status', value: !trialExpiry ? '♾️ No Limit' : isExpired ? '🚫 Expired' : `✅ Active (${timeLeftStr} left)` },
          { key: 'Expires', value: trialExpiry ? trialExpiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never' },
        ],
      }});

      // Trial management buttons
      const trialButtons = [];
      if (!trialExpiry || isExpired) {
        trialButtons.push({ label: '⏱️ 1 Hour', action: 'admin-set-trial', style: 'ghost', context: { userId: user.id, hours: 1 } });
        trialButtons.push({ label: '📅 7 Days', action: 'admin-set-trial', style: 'primary', context: { userId: user.id, days: 7 } });
        trialButtons.push({ label: '📅 30 Days', action: 'admin-set-trial', style: 'primary', context: { userId: user.id, days: 30 } });
        trialButtons.push({ label: '🔧 Custom', action: 'admin-set-trial-custom', style: 'ghost', context: { userId: user.id } });
      } else {
        trialButtons.push({ label: '➕ 1 Hour', action: 'admin-extend-trial', style: 'ghost', context: { userId: user.id, hours: 1 } });
        trialButtons.push({ label: '➕ 7 Days', action: 'admin-extend-trial', style: 'ghost', context: { userId: user.id, days: 7 } });
        trialButtons.push({ label: '➕ 30 Days', action: 'admin-extend-trial', style: 'ghost', context: { userId: user.id, days: 30 } });
        trialButtons.push({ label: '🔧 Custom', action: 'admin-set-trial-custom', style: 'ghost', context: { userId: user.id } });
      }
      trialButtons.push({ label: '♾️ Remove Limit', action: 'admin-remove-trial', style: 'ghost', context: { userId: user.id } });

      ops.push({ op: 'upsert', id: 'admin-detail-trial-actions', type: 'buttons', data: {
        buttons: trialButtons,
      }});
    }

    // Usage gauges — null quota = admin/unlimited
    const isUnlimited = !quota;
    const maxPerHour = isUnlimited ? null : (quota.maxMessagesPerHour || 30);
    const maxPerDay = isUnlimited ? null : (quota.maxMessagesPerDay || 200);
    const maxTokens = isUnlimited ? null : (quota.maxTokensPerDay || 500000);

    ops.push(
      { op: 'upsert', id: 'admin-detail-gauge-hour', type: 'gauge', data: {
        label: 'Messages This Hour',
        value: usage.messagesThisHour || 0,
        max: isUnlimited ? 100 : maxPerHour,
        unit: isUnlimited ? '/ ∞' : `/ ${maxPerHour}`,
        color: '#3b82f6',
      }},
      { op: 'upsert', id: 'admin-detail-gauge-day', type: 'gauge', data: {
        label: 'Messages Today',
        value: usage.messagesToday || 0,
        max: isUnlimited ? 1000 : maxPerDay,
        unit: isUnlimited ? '/ ∞' : `/ ${maxPerDay}`,
        color: '#8b5cf6',
      }},
      { op: 'upsert', id: 'admin-detail-gauge-tokens', type: 'stats', data: {
        title: `🪙 Tokens ${usage.isByok ? '(🔑 Own Key — user pays)' : '(💰 Platform — you pay)'}`,
        items: [
          { label: 'Today (total)', value: this._formatTokens(usage.tokensToday || 0) },
          { label: 'All Time', value: this._formatTokens(usage.tokensCumulative || 0) },
          { label: 'Input', value: this._formatTokens(usage.inputTokens || 0) },
          { label: 'Output', value: this._formatTokens(usage.outputTokens || 0) },
          ...(usage.cacheReadTokens ? [{ label: 'Cache Read', value: this._formatTokens(usage.cacheReadTokens || 0) }] : []),
          ...(usage.cacheWriteTokens ? [{ label: 'Cache Write', value: this._formatTokens(usage.cacheWriteTokens || 0) }] : []),
          { label: 'Cost Today', value: `$${(usage.costToday || 0).toFixed(2)}` },
          { label: 'Cost Total', value: `$${(usage.costTotal || 0).toFixed(2)}` },
        ],
      }},

      // Per-model breakdown (shows which models the user consumed tokens on)
      ...(usage.byModel && Object.keys(usage.byModel).length > 0 ? [{
        op: 'upsert', id: 'admin-detail-models', type: 'table', data: {
          title: '🤖 Token Usage by Model',
          headers: ['Model', 'Messages', 'Input', 'Output', 'Cost'],
          rows: Object.entries(usage.byModel)
            .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0))
            .map(([model, d]) => [
              model.replace('anthropic/', '').replace('google/', ''),
              String(d.messages || 0),
              this._formatTokens(d.inputTokens || 0),
              this._formatTokens(d.outputTokens || 0),
              `$${(d.cost || 0).toFixed(2)}`,
            ]),
        },
      }] : []),
    );

    // ── Per-provider breakdown ──
    if (usage.byProvider && Object.keys(usage.byProvider).length > 0) {
      const PROVIDER_LABELS = { anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI', 'google-ai': 'Google AI' };
      const provEntries = Object.entries(usage.byProvider).sort((a, b) => b[1].cost - a[1].cost);
      ops.push({ op: 'upsert', id: 'admin-detail-providers', type: 'table', data: {
        title: '🏢 Usage by Provider',
        headers: ['Provider', 'Models', 'Msgs Today', 'Cost Today', 'Cost Total'],
        rows: provEntries.map(([prov, d]) => [
          PROVIDER_LABELS[prov] || prov,
          (d.models || []).join(', '),
          String(d.tokensToday || 0),
          `$${(d.costToday || 0).toFixed(2)}`,
          `$${(d.cost || 0).toFixed(2)}`,
        ]),
      }});
    }

    // ── Capabilities / Permissions panel ──
    // ── Capabilities / Permissions ──
    // Use effective quota (role defaults + overrides merged)
    const ALL_TOOLS = ['exec', 'gateway', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'browser', 'sessions_spawn', 'tts', 'image', 'cron', 'message', 'nodes'];
    const ALL_MODELS = ['opus', 'sonnet', 'haiku', 'gemini-3-pro', 'gemini-3.1-pro'];
    const blockedTools = (quota && Array.isArray(quota.toolsBlacklist)) ? quota.toolsBlacklist : [];
    const allowedModels = (quota && Array.isArray(quota.allowedModels)) ? quota.allowedModels : [];
    // isUnlimited already declared above (from quota check)
    const isBlockAll = blockedTools.includes('*');

    const capRows = ALL_TOOLS.map(tool => {
      const blocked = !isUnlimited && (isBlockAll || blockedTools.includes(tool));
      return [
        tool,
        blocked ? '🔴 Blocked' : '🟢 Allowed',
        blocked
          ? { text: '✅ Allow', action: 'admin-cap-toggle', context: { userId: user.id, capability: 'tool', name: tool, enable: true }, style: 'primary' }
          : { text: '🚫 Block', action: 'admin-cap-toggle', context: { userId: user.id, capability: 'tool', name: tool, enable: false } },
      ];
    });

    const modelRows = ALL_MODELS.map(model => {
      // BYOK users have unrestricted model access — they pay with their own key
      if (isByok) {
        return [model, '🟢 Own Key', '—'];
      }
      // If no allowedModels list → all allowed; if list exists, check membership
      const allowed = isUnlimited || allowedModels.length === 0 || allowedModels.some(m => model === m || model.includes(m) || m.includes(model));
      return [
        model,
        allowed ? '🟢 Allowed' : '🔴 Blocked',
        allowed
          ? { text: '🚫 Block', action: 'admin-cap-toggle', context: { userId: user.id, capability: 'model', name: model, enable: false } }
          : { text: '✅ Allow', action: 'admin-cap-toggle', context: { userId: user.id, capability: 'model', name: model, enable: true }, style: 'primary' },
      ];
    });

    const maxSubAgents = isUnlimited ? 999 : (quota?.maxSubAgents ?? 2);
    const maxTts = isUnlimited ? 999 : (quota?.maxTtsSecondsPerDay ?? 30);
    const featureRows = [
      ['Sub-agents', maxSubAgents === 0 ? '🔴 Disabled' : `🟢 Max ${maxSubAgents}`,
        maxSubAgents === 0
          ? { text: '✅ Enable (2)', action: 'admin-cap-toggle', context: { userId: user.id, capability: 'feature', name: 'maxSubAgents', value: 2 }, style: 'primary' }
          : { text: '🚫 Disable', action: 'admin-cap-toggle', context: { userId: user.id, capability: 'feature', name: 'maxSubAgents', value: 0 } }],
      ['TTS', maxTts === 0 ? '🔴 Disabled' : `🟢 ${maxTts}s/day`,
        maxTts === 0
          ? { text: '✅ Enable (30s)', action: 'admin-cap-toggle', context: { userId: user.id, capability: 'feature', name: 'maxTtsSecondsPerDay', value: 30 }, style: 'primary' }
          : { text: '🚫 Disable', action: 'admin-cap-toggle', context: { userId: user.id, capability: 'feature', name: 'maxTtsSecondsPerDay', value: 0 } }],
    ];

    ops.push(
      { op: 'upsert', id: 'admin-detail-cap-tools', type: 'table', data: {
        title: `🔧 Tool Permissions${Object.keys(overrides).length > 0 ? ' (customized)' : ' (role defaults)'}`,
        headers: ['Tool', 'Status', ''],
        rows: capRows,
      }},
      { op: 'upsert', id: 'admin-detail-cap-models', type: 'table', data: {
        title: `🤖 Model Access${isByok ? ' (BYOK — unrestricted)' : Object.keys(overrides).length > 0 ? ' (customized)' : ' (role defaults)'}`,
        headers: ['Model', 'Status', ''],
        rows: modelRows,
      }},
      { op: 'upsert', id: 'admin-detail-cap-features', type: 'table', data: {
        title: '⚡ Features',
        headers: ['Feature', 'Status', ''],
        rows: featureRows,
      }},
    );

    // Reset button + overrides display
    if (Object.keys(overrides).length > 0) {
      ops.push(
        { op: 'upsert', id: 'admin-detail-overrides', type: 'kv', data: {
          title: '⚙️ Active Overrides (vs role defaults)',
          items: Object.entries(overrides).map(([k, v]) => ({
            key: k,
            value: Array.isArray(v) ? v.join(', ') : String(v),
          })),
        }},
        { op: 'upsert', id: 'admin-detail-cap-reset', type: 'buttons', data: {
          buttons: [
            { label: '🔄 Reset All to Role Defaults', action: 'admin-cap-reset', style: 'ghost', context: { userId: user.id } },
          ],
        }},
      );
    }

    // Action buttons
    ops.push({ op: 'upsert', id: 'admin-detail-actions', type: 'buttons', data: {
      title: 'Actions',
      buttons: [
        { label: '← Users', action: 'admin-list-users', style: 'ghost' },
        { label: '🔒 Change Password', action: 'admin-change-password', style: 'primary', context: { userId: user.id } },
        { label: '🤖 Set Model', action: 'admin-set-model', style: 'primary', context: { userId: user.id } },
        { label: `${this._roleEmoji(user.role)} Change Role`, action: 'admin-edit-role', style: 'ghost', context: { userId: user.id, role: user.role } },
        { label: '📊 Edit Quota', action: 'admin-edit-quota', style: 'ghost', context: { userId: user.id } },
        user.status === 'active'
          ? { label: '🚫 Disable', action: 'admin-toggle-status', style: 'ghost', context: { userId: user.id, currentStatus: 'active' } }
          : { label: '✅ Enable', action: 'admin-toggle-status', style: 'ghost', context: { userId: user.id, currentStatus: 'disabled' } },
        { label: '📧 Send Invite', action: 'admin-send-invite', style: 'primary', context: { userId: user.id } },
        { label: '🔄 Reset Usage', action: 'admin-reset-usage', style: 'ghost', context: { userId: user.id } },
        { label: '🗑️ Delete User', action: 'admin-delete-user', style: 'ghost', context: { userId: user.id } },
      ],
    }});

    return { ops };
  }

  // ─── Edit Role ────────────────────────────────────────

  _editRole(context) {
    const { userId, role } = context;

    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    // If a new role is provided (from a form submission), apply it
    if (role && role !== user.role && ['admin', 'operator', 'viewer'].includes(role)) {
      try {
        this.userStore.updateUser(userId, { role });
        console.log(`[AdminWidget] Role changed: ${user.email} → ${role}`);
        // Refresh user detail
        const result = this._userDetail({ userId });
        result.ops.splice(2, 0, { op: 'upsert', id: 'admin-role-success', type: 'alert', data: {
          title: 'Role Updated',
          message: `${user.displayName || user.email} is now ${this._roleEmoji(role)} ${role}.`,
          severity: 'success',
        }});
        return result;
      } catch (err) {
        return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
          title: 'Error', message: err.message, severity: 'error'
        }}]};
      }
    }

    // Show role selection form
    return { ops: [
      { op: 'clear' },
      ...this._nav('users'),
      { op: 'upsert', id: 'admin-role-form', type: 'form', data: {
        id: 'admin-role-form',
        title: `Change Role — ${user.displayName || user.email}`,
        fields: [
          { name: 'userId', type: 'text', label: '', value: userId },
          { name: 'role', type: 'select', label: 'New Role', value: user.role, options: [
            { label: '👑 Admin — Full access, no limits', value: 'admin' },
            { label: '🔧 Operator — Can chat, has quotas', value: 'operator' },
            { label: '👁️ Viewer — Read-only access', value: 'viewer' },
          ]},
        ],
        actions: [
          { label: '← Back', action: 'admin-user-detail', style: 'ghost', context: { userId } },
          { label: 'Save Role', action: 'admin-edit-role', style: 'primary' },
        ],
      }},
    ]};
  }

  // ─── Toggle Status (Enable/Disable) ──────────────────

  _toggleStatus(context) {
    const { userId, currentStatus } = context;

    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    try {
      if (currentStatus === 'active' || user.status === 'active') {
        // Disable user
        this.userStore.disableUser(userId);
        // Revoke all sessions
        const revokedCount = this.sessionStore.revokeAllUserSessions(userId);
        console.log(`[AdminWidget] Disabled: ${user.email} (${revokedCount} sessions revoked)`);

        const result = this._listUsers();
        result.ops.splice(2, 0, { op: 'upsert', id: 'admin-status-msg', type: 'alert', data: {
          title: 'User Disabled',
          message: `${user.displayName || user.email} has been disabled. ${revokedCount} session(s) revoked.`,
          severity: 'warning',
        }});
        return result;
      } else {
        // Enable user
        this.userStore.updateUser(userId, { status: 'active' });
        console.log(`[AdminWidget] Enabled: ${user.email}`);

        const result = this._listUsers();
        result.ops.splice(2, 0, { op: 'upsert', id: 'admin-status-msg', type: 'alert', data: {
          title: 'User Enabled',
          message: `${user.displayName || user.email} is now active.`,
          severity: 'success',
        }});
        return result;
      }
    } catch (err) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: err.message, severity: 'error'
      }}]};
    }
  }

  // ─── Toggle Preview Mode ────────────────────────────────

  _togglePreview(context) {
    const userId = context?.userId;
    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-preview-msg', type: 'alert', data: {
        title: 'Error', message: 'No userId available.', severity: 'error'
      }}]};
    }
    if (this.previewSessions.has(userId)) {
      this.previewSessions.delete(userId);
      return { ops: [{ op: 'upsert', id: 'admin-preview-msg', type: 'alert', data: {
        title: '🧪 Preview Disabled', message: 'You are now viewing the production web/ files.', severity: 'info'
      }}]};
    } else {
      this.previewSessions.add(userId);
      return { ops: [{ op: 'upsert', id: 'admin-preview-msg', type: 'alert', data: {
        title: '🧪 Preview Enabled', message: 'You are now viewing web-preview/ files. Reload the page to see changes.', severity: 'success'
      }}]};
    }
  }

  // ─── Edit Quota Form ──────────────────────────────────

  _editQuotaForm(context) {
    const { userId } = context;

    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    const quota = this.quotaStore.getEffectiveQuota(user);
    const overrides = this.quotaStore.getQuotaOverrides(userId);

    // Merge current values (overrides take precedence over role defaults)
    const current = {
      maxMessagesPerHour: overrides.maxMessagesPerHour != null ? overrides.maxMessagesPerHour : (quota ? quota.maxMessagesPerHour : ''),
      maxMessagesPerDay: overrides.maxMessagesPerDay != null ? overrides.maxMessagesPerDay : (quota ? quota.maxMessagesPerDay : ''),
      maxTokensPerDay: overrides.maxTokensPerDay != null ? overrides.maxTokensPerDay : (quota ? quota.maxTokensPerDay : ''),
      maxSubAgents: overrides.maxSubAgents != null ? overrides.maxSubAgents : (quota ? quota.maxSubAgents : ''),
    };

    return { ops: [
      { op: 'clear' },
      ...this._nav('users'),
      { op: 'upsert', id: 'admin-quota-info', type: 'kv', data: {
        title: `📊 Quota — ${user.displayName || user.email}`,
        items: [
          { key: 'Current Role', value: `${this._roleEmoji(user.role)} ${user.role}` },
          { key: 'Has Overrides', value: Object.keys(overrides).length > 0 ? 'Yes' : 'No (using role defaults)' },
        ],
      }},
      { op: 'upsert', id: 'admin-quota-form', type: 'form', data: {
        id: 'admin-quota-form',
        title: 'Quota Overrides',
        fields: [
          { name: 'userId', type: 'text', label: '', value: userId },
          { name: 'maxMessagesPerHour', type: 'number', label: 'Max Messages / Hour', value: String(current.maxMessagesPerHour || ''), placeholder: 'Leave empty for role default' },
          { name: 'maxMessagesPerDay', type: 'number', label: 'Max Messages / Day', value: String(current.maxMessagesPerDay || ''), placeholder: 'Leave empty for role default' },
          { name: 'maxTokensPerDay', type: 'number', label: 'Max Tokens / Day', value: String(current.maxTokensPerDay || ''), placeholder: 'Leave empty for role default' },
          { name: 'maxSubAgents', type: 'number', label: 'Max Sub-Agents', value: String(current.maxSubAgents || ''), placeholder: 'Leave empty for role default' },
        ],
        actions: [
          { label: '← Back', action: 'admin-user-detail', style: 'ghost', context: { userId } },
          { label: 'Save Quota', action: 'admin-save-quota', style: 'primary' },
        ],
      }},
    ]};
  }

  // ─── Save Quota ───────────────────────────────────────

  _saveQuota(context) {
    const { userId, maxMessagesPerHour, maxMessagesPerDay, maxTokensPerDay, maxSubAgents } = context;

    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    // Build overrides from submitted values (skip empty/null)
    const overrides = {};
    if (maxMessagesPerHour != null && maxMessagesPerHour !== '') {
      overrides.maxMessagesPerHour = parseInt(maxMessagesPerHour, 10);
    }
    if (maxMessagesPerDay != null && maxMessagesPerDay !== '') {
      overrides.maxMessagesPerDay = parseInt(maxMessagesPerDay, 10);
    }
    if (maxTokensPerDay != null && maxTokensPerDay !== '') {
      overrides.maxTokensPerDay = parseInt(maxTokensPerDay, 10);
    }
    if (maxSubAgents != null && maxSubAgents !== '') {
      overrides.maxSubAgents = parseInt(maxSubAgents, 10);
    }

    // Validate numbers
    for (const [key, val] of Object.entries(overrides)) {
      if (isNaN(val) || val < 0) {
        return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
          title: 'Invalid Value', message: `${key} must be a non-negative number.`, severity: 'warning'
        }}]};
      }
    }

    try {
      // Clear existing overrides first if form has empty fields (revert to defaults)
      this.quotaStore.clearQuotaOverrides(userId);
      if (Object.keys(overrides).length > 0) {
        this.quotaStore.setQuotaOverrides(userId, overrides);
      }

      console.log(`[AdminWidget] Quota updated: ${user.email} →`, overrides);

      const result = this._userDetail({ userId });
      result.ops.splice(2, 0, { op: 'upsert', id: 'admin-quota-success', type: 'alert', data: {
        title: 'Quota Updated',
        message: Object.keys(overrides).length > 0
          ? `Custom quotas applied for ${user.displayName || user.email}.`
          : `Quotas reverted to role defaults for ${user.displayName || user.email}.`,
        severity: 'success',
      }});
      return result;
    } catch (err) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: err.message, severity: 'error'
      }}]};
    }
  }

  // ─── Reset Usage ──────────────────────────────────────

  _resetUsage(context) {
    const { userId } = context;

    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    try {
      this.quotaStore.resetUsage(userId);
      console.log(`[AdminWidget] Usage reset: ${user.email}`);

      const result = this._userDetail({ userId });
      result.ops.splice(2, 0, { op: 'upsert', id: 'admin-reset-success', type: 'alert', data: {
        title: 'Usage Reset',
        message: `All usage counters for ${user.displayName || user.email} have been reset to zero.`,
        severity: 'success',
      }});
      return result;
    } catch (err) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: err.message, severity: 'error'
      }}]};
    }
  }

  // ─── Delete User ──────────────────────────────────────

  _deleteUser(context) {
    const { userId } = context;

    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    try {
      // Revoke all sessions
      this.sessionStore.revokeAllUserSessions(userId);
      // Reset usage and quotas
      this.quotaStore.resetUsage(userId);
      this.quotaStore.clearQuotaOverrides(userId);
      // Delete user
      this.userStore.deleteUser(userId);

      console.log(`[AdminWidget] User deleted: ${user.email} (${userId})`);

      const result = this._listUsers();
      result.ops.splice(2, 0, { op: 'upsert', id: 'admin-delete-success', type: 'alert', data: {
        title: 'User Deleted',
        message: `${user.displayName || user.email} has been permanently deleted.`,
        severity: 'success',
      }});
      return result;
    } catch (err) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: err.message, severity: 'error'
      }}]};
    }
  }

  // ─── Toggle Capability ─────────────────────────────────

  _toggleCapability(context) {
    const { userId, capability, name, enable, value } = context;

    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    const overrides = this.quotaStore.getQuotaOverrides(userId);
    const ROLE_DEFAULTS = {
      operator: { toolsBlacklist: ['exec', 'gateway'], allowedModels: ['sonnet', 'haiku'], maxSubAgents: 2, maxTtsSecondsPerDay: 30 },
      viewer: { toolsBlacklist: ['*'], allowedModels: [], maxSubAgents: 0, maxTtsSecondsPerDay: 0 },
      admin: { toolsBlacklist: [], allowedModels: [], maxSubAgents: 999, maxTtsSecondsPerDay: 999 },
    };
    const roleDefaults = ROLE_DEFAULTS[user.role] || ROLE_DEFAULTS.operator;

    try {
      if (capability === 'tool') {
        // Get current blacklist (from overrides or role default)
        let blacklist = overrides.toolsBlacklist
          ? [...overrides.toolsBlacklist]
          : [...(roleDefaults.toolsBlacklist || [])];

        // Remove wildcard if present — we're switching to explicit list
        blacklist = blacklist.filter(t => t !== '*');

        if (enable) {
          // Remove from blacklist (allow the tool)
          blacklist = blacklist.filter(t => t !== name);
        } else {
          // Add to blacklist (block the tool)
          if (!blacklist.includes(name)) blacklist.push(name);
        }

        this.quotaStore.setQuotaOverrides(userId, { toolsBlacklist: blacklist });
        console.log(`[AdminWidget] Tool ${name} ${enable ? 'allowed' : 'blocked'} for ${user.email}: [${blacklist.join(', ')}]`);

      } else if (capability === 'model') {
        let allowed = overrides.allowedModels
          ? [...overrides.allowedModels]
          : [...(roleDefaults.allowedModels || [])];

        if (enable) {
          // Add to allowed list
          if (!allowed.includes(name)) allowed.push(name);
        } else {
          // Remove from allowed list
          allowed = allowed.filter(m => m !== name);
        }

        this.quotaStore.setQuotaOverrides(userId, { allowedModels: allowed });
        console.log(`[AdminWidget] Model ${name} ${enable ? 'allowed' : 'blocked'} for ${user.email}: [${allowed.join(', ')}]`);

      } else if (capability === 'feature') {
        // Direct numeric value set
        this.quotaStore.setQuotaOverrides(userId, { [name]: value });
        console.log(`[AdminWidget] Feature ${name}=${value} for ${user.email}`);
      }

      // Refresh user detail
      return this._userDetail({ userId });

    } catch (err) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: err.message, severity: 'error'
      }}]};
    }
  }

  // ─── Reset Capabilities ────────────────────────────────

  _resetCapabilities(context) {
    const { userId } = context;
    if (!userId) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'No userId.', severity: 'error' }}]};
    const user = this.userStore.getById(userId);
    if (!user) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Not Found', message: 'User not found.', severity: 'error' }}]};

    this.quotaStore.clearQuotaOverrides(userId);
    console.log(`[AdminWidget] Capabilities reset to role defaults for: ${user.email}`);

    const result = this._userDetail({ userId });
    result.ops.splice(2, 0, { op: 'upsert', id: 'admin-cap-reset-ok', type: 'alert', data: {
      title: 'Reset Complete',
      message: `All custom permissions cleared. ${user.displayName || user.email} is back to ${user.role} defaults.`,
      severity: 'success',
    }});
    return result;
  }

  // ─── Change Password ───────────────────────────────────

  _changePasswordForm(context) {
    const { userId } = context;
    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    return { ops: [
      { op: 'clear' },
      ...this._nav('users'),
      { op: 'upsert', id: 'admin-pwd-title', type: 'card', data: {
        title: `🔒 Change Password — ${user.displayName || user.email}`,
        text: 'Enter a new password. Must be at least 12 characters with uppercase, lowercase, numbers, and symbols.',
      }},
      { op: 'upsert', id: 'admin-pwd-form', type: 'form', data: {
        id: 'admin-pwd-form',
        title: 'New Password',
        fields: [
          { name: 'newPassword', type: 'password', label: 'New Password', placeholder: 'Min 12 characters', noPaste: true },
          { name: 'confirmPassword', type: 'password', label: 'Confirm Password', placeholder: 'Re-type the password', noPaste: true },
          { name: 'userId', type: 'hidden', value: userId },
        ],
        actions: [
          { label: '← Back', action: 'admin-user-detail', style: 'ghost', context: { userId } },
          { label: '🔒 Save Password', action: 'admin-save-password', style: 'primary' },
        ],
      }},
    ]};
  }

  async _savePassword(context) {
    const { newPassword, confirmPassword, userId } = context;

    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: 'No userId provided.', severity: 'error'
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Not Found', message: `User ${userId} not found.`, severity: 'error'
      }}]};
    }

    // Validate password
    if (!newPassword || newPassword.length < 12) {
      return { ops: [{ op: 'upsert', id: 'admin-pwd-error', type: 'alert', data: {
        title: 'Too Weak', message: 'Password must be at least 12 characters.', severity: 'warning'
      }}]};
    }

    if (newPassword !== confirmPassword) {
      return { ops: [{ op: 'upsert', id: 'admin-pwd-error', type: 'alert', data: {
        title: 'Mismatch', message: 'Passwords do not match. Please re-type carefully.', severity: 'warning'
      }}]};
    }

    // Strength check: require mixed character classes
    const hasUpper = /[A-Z]/.test(newPassword);
    const hasLower = /[a-z]/.test(newPassword);
    const hasDigit = /[0-9]/.test(newPassword);
    const hasSymbol = /[^A-Za-z0-9]/.test(newPassword);
    const classCount = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;

    if (classCount < 3) {
      return { ops: [{ op: 'upsert', id: 'admin-pwd-error', type: 'alert', data: {
        title: 'Too Weak',
        message: 'Password needs at least 3 of: uppercase, lowercase, numbers, symbols.',
        severity: 'warning'
      }}]};
    }

    try {
      const { hashPassword } = require('./../../lib/auth/password');
      const passwordHash = await hashPassword(newPassword);
      this.userStore.updateUser(userId, { passwordHash });

      console.log(`[AdminWidget] Password changed for: ${user.email}`);

      // Return to user detail with success message
      const result = this._userDetail({ userId });
      result.ops.splice(2, 0, { op: 'upsert', id: 'admin-pwd-success', type: 'alert', data: {
        title: 'Password Changed',
        message: `Password for ${user.displayName || user.email} has been updated successfully.`,
        severity: 'success',
      }});
      return result;
    } catch (err) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: {
        title: 'Error', message: err.message, severity: 'error'
      }}]};
    }
  }

  // ─── Set User Model ──────────────────────────────────────

  _setModelForm(context) {
    const { userId } = context;
    if (!userId) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'Missing userId', severity: 'error' }}]};
    const user = this.userStore.getById(userId);
    if (!user) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'User not found', severity: 'error' }}]};

    // Read current model from sessions.json
    const sessionsFile = path.join(process.env.HOME || '.', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
    let currentModel = 'default (Opus)';
    try {
      const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      const entry = data[`agent:main:webchat:${userId}`];
      if (entry?.modelOverride) {
        currentModel = entry.providerOverride ? `${entry.providerOverride}/${entry.modelOverride}` : entry.modelOverride;
      }
    } catch(e) {}

    return { ops: [
      { op: 'clear' },
      ...this._nav(''),
      { op: 'upsert', id: 'admin-model-info', type: 'kv', data: {
        title: `🤖 Set Model for ${user.displayName || user.email}`,
        items: [
          { key: 'Current', value: currentModel },
          { key: 'Role', value: user.role },
        ],
      }},
      { op: 'upsert', id: 'admin-model-form', type: 'form', data: {
        title: 'Select Model',
        id: 'admin-model-form',
        fields: [
          { name: 'userId', type: 'hidden', value: userId },
          { name: 'model', type: 'select', label: 'Model', value: currentModel === 'default (Opus)' ? '' : currentModel, options: [
            { value: '', label: '🔧 Default (agent default — Opus)' },
            { value: 'anthropic/claude-sonnet-4-20250514', label: '⚡ Claude Sonnet 4 (fast, cheap)' },
            { value: 'anthropic/claude-haiku-3-20240307', label: '🐇 Claude Haiku 3 (fastest, cheapest)' },
            { value: 'anthropic/claude-opus-4-6', label: '🧠 Claude Opus 4.6 (most capable, expensive)' },
            { value: 'google-gemini-cli/gemini-3-pro-preview', label: '💎 Gemini 3 Pro (Google, free tier)' },
            { value: 'google-gemini-cli/gemini-3.1-pro-preview', label: '💎 Gemini 3.1 Pro (Google, free tier)' },
          ]},
        ],
        actions: [
          { label: '✅ Save Model', action: 'admin-save-model', style: 'primary' },
        ],
      }},
      { op: 'upsert', id: 'admin-model-back', type: 'buttons', data: {
        buttons: [
          { label: '← Back to User', action: 'admin-user-detail', style: 'ghost', context: { userId } },
        ],
      }},
    ]};
  }

  _saveModel(context) {
    const { userId, model } = context;
    if (!userId) return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'Missing userId', severity: 'error' }}]};

    // Use the setUserModelOverride helper
    const sessionsFile = path.join(process.env.HOME || '.', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
    try {
      const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      const sessionKey = `agent:main:webchat:${userId}`;
      if (!data[sessionKey]) {
        return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: 'User session not found. User must log in first.', severity: 'error' }}]};
      }
      if (!model || model === 'default') {
        delete data[sessionKey].modelOverride;
        delete data[sessionKey].providerOverride;
      } else {
        let prov, mod;
        if (model.includes('/')) {
          const parts = model.split('/');
          prov = parts[0];
          mod = parts.slice(1).join('/');
        } else {
          mod = model;
        }
        data[sessionKey].modelOverride = mod;
        if (prov) data[sessionKey].providerOverride = prov;
      }
      data[sessionKey].updatedAt = Date.now();
      const tmp = sessionsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, sessionsFile);
      console.log(`[AdminWidget] Model override set for ${userId}: ${model || 'default'}`);
    } catch(err) {
      return { ops: [{ op: 'upsert', id: 'admin-error', type: 'alert', data: { title: 'Error', message: err.message, severity: 'error' }}]};
    }

    const user = this.userStore.getById(userId);
    const result = this._userDetail({ userId });
    result.ops.splice(2, 0, { op: 'upsert', id: 'admin-model-success', type: 'alert', data: {
      title: 'Model Updated',
      message: `${user?.displayName || 'User'} now uses: ${model || 'default (agent default)'}`,
      severity: 'success',
    }});
    return result;
  }

  // ─── Real-Time Monitor ─────────────────────────────────

  _monitor() {
    const ACCENT = '#7c3aed';
    const ops = [
      { op: 'clear' },
      ...this._nav('monitor'),
    ];

    // ── Connected Users ──
    const connectedUsers = [];
    let connectedCount = 0;
    const now = Date.now();

    if (this._connections && typeof this._connections.forEach === 'function') {
      this._connections.forEach((conn, key) => {
        connectedCount++;
        const user = conn.user || {};
        const connectedAt = conn.connectedAt || conn.createdAt || now;
        const lastActivity = conn.lastActivity || conn.lastMessage || connectedAt;
        const durationMs = now - connectedAt;
        const durationMin = Math.floor(durationMs / 60000);
        const durationStr = durationMin < 60
          ? `${durationMin}m`
          : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`;

        connectedUsers.push({
          name: user.displayName || user.email || key,
          role: user.role || 'unknown',
          lastActivity: this._formatDate(new Date(lastActivity).toISOString()),
          duration: durationStr,
        });
      });
    }

    ops.push({ op: 'upsert', id: 'admin-mon-header', type: 'stats', data: {
      title: '🖥️ Real-Time Monitor',
      items: [
        { label: 'Connected Users', value: String(connectedCount) },
        { label: 'Active Sessions', value: String(this.sessionStore.totalSessions()) },
        { label: 'Total Users', value: String(this.userStore.listUsers().length) },
      ],
    }});

    // ── Message Rate ──
    const nowMs = Date.now();
    const cutoff5 = nowMs - 5 * 60 * 1000;
    const recent = this._msgTimestamps.filter(t => t >= cutoff5);
    const ratePerMin = recent.length > 0 ? (recent.length / 5).toFixed(1) : '0';

    // Per-minute breakdown for last 5 minutes
    const minuteBuckets = [0, 0, 0, 0, 0];
    for (const ts of recent) {
      const minutesAgo = Math.floor((nowMs - ts) / 60000);
      if (minutesAgo < 5) minuteBuckets[4 - minutesAgo]++;
    }

    ops.push({ op: 'upsert', id: 'admin-mon-msgrate', type: 'stats', data: {
      title: '💬 Message Rate',
      items: [
        { label: 'Avg msgs/min (5m)', value: ratePerMin },
        { label: 'Total (5m)', value: String(recent.length) },
        { label: 'Last 1m', value: String(minuteBuckets[4]) },
        { label: '2m ago', value: String(minuteBuckets[3]) },
        { label: '3m ago', value: String(minuteBuckets[2]) },
      ],
    }});

    // ── System Resources ──
    // CPU (snapshot for delta-based live updates)
    const cpuSnap = this._snapshotCpu();
    let cpuPercent = 0;
    if (this._lastCpuSnapshot) {
      const idleDelta = cpuSnap.idle - this._lastCpuSnapshot.idle;
      const totalDelta = cpuSnap.total - this._lastCpuSnapshot.total;
      cpuPercent = totalDelta > 0 ? Math.round(100 - (idleDelta / totalDelta) * 100) : 0;
    }
    this._lastCpuSnapshot = cpuSnap;

    // Memory
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    const fmtMB = (bytes) => (bytes / (1024 * 1024)).toFixed(0);

    // Disk
    let diskUsed = '?', diskTotal = '?', diskPercent = 0;
    try {
      const dfOut = execSync('df -h / --output=used,size,pcent 2>/dev/null').toString();
      const lines = dfOut.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        diskUsed = parts[0] || '?';
        diskTotal = parts[1] || '?';
        diskPercent = parseInt((parts[2] || '0').replace('%', ''), 10) || 0;
      }
    } catch (_) { /* ignore */ }

    // Uptime
    const uptimeSec = os.uptime();
    const uptimeDays = Math.floor(uptimeSec / 86400);
    const uptimeHours = Math.floor((uptimeSec % 86400) / 3600);
    const uptimeMin = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = uptimeDays > 0
      ? `${uptimeDays}d ${uptimeHours}h ${uptimeMin}m`
      : `${uptimeHours}h ${uptimeMin}m`;

    // Node.js memory
    const procMem = process.memoryUsage();

    ops.push(
      { op: 'upsert', id: 'admin-mon-cpu', type: 'gauge', data: {
        label: 'CPU',
        value: cpuPercent,
        max: 100,
        unit: '%',
        color: cpuPercent > 80 ? '#ef4444' : cpuPercent > 60 ? '#f59e0b' : '#10b981',
      }},
      { op: 'upsert', id: 'admin-mon-ram', type: 'gauge', data: {
        label: `RAM ${fmtMB(usedMem)}/${fmtMB(totalMem)}MB`,
        value: memPercent,
        max: 100,
        unit: '%',
        color: memPercent > 85 ? '#ef4444' : memPercent > 70 ? '#f59e0b' : '#10b981',
      }},
      { op: 'upsert', id: 'admin-mon-disk', type: 'gauge', data: {
        label: `Disk ${diskUsed}/${diskTotal}`,
        value: diskPercent,
        max: 100,
        unit: '%',
        color: diskPercent > 90 ? '#ef4444' : diskPercent > 75 ? '#f59e0b' : '#10b981',
      }},
    );

    // Node.js process stats
    ops.push({ op: 'upsert', id: 'admin-mon-process', type: 'kv', data: {
      title: '⚙️ Node.js Process',
      items: [
        { key: 'Heap Used', value: `${fmtMB(procMem.heapUsed)}MB / ${fmtMB(procMem.heapTotal)}MB` },
        { key: 'RSS', value: `${fmtMB(procMem.rss)}MB` },
        { key: 'External', value: `${fmtMB(procMem.external)}MB` },
        { key: 'System Uptime', value: uptimeStr },
        { key: 'Node Version', value: process.version },
        { key: 'PID', value: String(process.pid) },
      ],
    }});

    // ── Gateway Status ──
    // Heuristic: check if _connections is injected and has entries
    const gwConnected = this._connections != null;
    ops.push({ op: 'upsert', id: 'admin-mon-gateway', type: 'tags', data: {
      label: 'Gateway Status',
      items: [
        gwConnected
          ? { text: '● Connected', color: '#10b981' }
          : { text: '● Disconnected', color: '#ef4444' },
      ],
    }});

    // ── Connected Users Table ──
    if (connectedUsers.length > 0) {
      ops.push({ op: 'upsert', id: 'admin-mon-conn-table', type: 'table', data: {
        title: `🟢 Connected Users (${connectedCount})`,
        headers: ['User', 'Role', 'Last Activity', 'Connected'],
        rows: connectedUsers.map(u => [
          u.name,
          u.role,
          u.lastActivity,
          u.duration,
        ]),
      }});
    } else {
      ops.push({ op: 'upsert', id: 'admin-mon-conn-none', type: 'alert', data: {
        title: 'No Connected Users',
        message: 'No WebSocket connections are currently active.',
        severity: 'info',
      }});
    }

    // High resource warnings
    if (cpuPercent > 80) {
      ops.push({ op: 'upsert', id: 'admin-mon-warn-cpu', type: 'alert', data: {
        title: 'High CPU Usage', message: `CPU at ${cpuPercent}% — consider checking running processes.`, severity: 'warning',
      }});
    }
    if (memPercent > 85) {
      ops.push({ op: 'upsert', id: 'admin-mon-warn-mem', type: 'alert', data: {
        title: 'High Memory Usage', message: `Memory at ${memPercent}% — ${fmtMB(freeMem)}MB free remaining.`, severity: 'warning',
      }});
    }
    if (diskPercent > 90) {
      ops.push({ op: 'upsert', id: 'admin-mon-warn-disk', type: 'alert', data: {
        title: 'Low Disk Space', message: `Disk at ${diskPercent}% — only ${diskTotal} - ${diskUsed} remaining.`, severity: 'error',
      }});
    }

    // ── Gateway Sessions / Sub-Agents ──
    try {
      const sessFile = path.join(process.env.HOME || '.', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
      const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));

      const sessionRows = [];
      const shortModel = (m) => (m || 'unknown').replace('anthropic/', '').replace('claude-', '').replace('-20250', '').replace('-latest', '').replace('-preview', '');

      for (const [key, entry] of Object.entries(sessData)) {
        // Determine session type and friendly name
        let type, name;
        if (key === 'agent:main:main') {
          type = '🏠 Main'; name = 'Main Agent';
        } else if (key.includes(':cron:')) {
          type = '⏰ Cron'; name = 'Scheduled Job';
        } else if (key.includes(':webchat:')) {
          const userId = key.split(':').pop();
          // Resolve user name
          let userName = userId;
          try { const u = this.userStore.getById(userId); if (u) userName = u.displayName || u.email || userId; } catch(_) {}
          if (userName.startsWith('usr_')) userName = userName.slice(4, 14) + '…';
          type = '💬 Chat'; name = userName;
        } else if (key.includes(':isolated:') || entry.label) {
          type = '🤖 Sub-Agent'; name = entry.label || 'Unnamed Task';
        } else {
          type = '❓ Other'; name = key.split(':').pop();
        }

        const model = shortModel(entry.modelOverride || entry.model);
        const provider = (entry.providerOverride || entry.modelProvider || '').replace('-messages', '');
        const tokens = entry.totalTokens || 0;
        const tokenStr = tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);

        // Parse skills from snapshot
        let skillCount = 0;
        let skillNames = [];
        if (entry.skillsSnapshot && entry.skillsSnapshot.prompt) {
          const matches = entry.skillsSnapshot.prompt.match(/<name>([^<]+)<\/name>/g) || [];
          skillNames = matches.map(m => m.replace(/<\/?name>/g, ''));
          skillCount = skillNames.length;
        }

        // Last activity
        const updatedAt = entry.updatedAt;
        const agoMs = updatedAt ? Date.now() - updatedAt : 0;
        const ago = agoMs < 60000 ? 'just now'
          : agoMs < 3600000 ? `${Math.round(agoMs / 60000)}m ago`
          : agoMs < 86400000 ? `${Math.round(agoMs / 3600000)}h ago`
          : `${Math.round(agoMs / 86400000)}d ago`;

        sessionRows.push([type, name, `${provider ? provider + '/' : ''}${model}`, tokenStr, `${skillCount} skills`, ago]);
      }

      if (sessionRows.length > 0) {
        ops.push({ op: 'upsert', id: 'admin-mon-sessions', type: 'table', data: {
          title: `🔗 Gateway Sessions (${sessionRows.length})`,
          headers: ['Type', 'Name', 'Model', 'Tokens', 'Skills', 'Activity'],
          rows: sessionRows,
        }});
      }
    } catch (e) {
      // Non-fatal — sessions.json might not be readable
      ops.push({ op: 'upsert', id: 'admin-mon-sessions', type: 'alert', data: {
        title: 'Sessions', message: 'Could not read gateway sessions: ' + e.message, severity: 'info',
      }});
    }

    // Refresh button
    ops.push({ op: 'upsert', id: 'admin-mon-refresh', type: 'buttons', data: {
      buttons: [
        { label: '🔄 Refresh', action: 'admin-monitor', style: 'primary' },
      ],
    }});

    return { ops };
  }

  // ─── Quota Usage Overview ─────────────────────────────

  _quotas() {
    const ACCENT = '#7c3aed';
    const users = this._getEnrichedUsers().filter(u => u.status === 'active');

    const ops = [
      { op: 'clear' },
      ...this._nav('quotas'),
      { op: 'upsert', id: 'admin-quota-header', type: 'stats', data: {
        title: '📈 Quota Usage Overview',
        items: [
          { label: 'Active Users', value: String(users.length) },
        ],
      }},
    ];

    if (users.length === 0) {
      ops.push({ op: 'upsert', id: 'admin-quota-empty', type: 'alert', data: {
        title: 'No Active Users', message: 'No active users to show quota data for.', severity: 'info',
      }});
      return { ops };
    }

    for (const u of users) {
      const usage = u.usage || {};
      const quota = u.effectiveQuota || {};
      const prefix = `admin-quota-${u.id}`;

      const msgsHour = usage.messagesThisHour || 0;
      const msgsDay = usage.messagesToday || 0;
      const tokensToday = usage.tokensToday || 0;
      const costToday = usage.costToday || 0;
      const maxMsgsHour = quota.maxMessagesPerHour || 0;
      const maxMsgsDay = quota.maxMessagesPerDay || 0;
      const maxTokensDay = quota.maxTokensPerDay || 0;
      const maxSubAgents = quota.maxSubAgents || 0;

      // Calculate percentages for color coding
      const hourPct = maxMsgsHour > 0 ? (msgsHour / maxMsgsHour) * 100 : 0;
      const dayPct = maxMsgsDay > 0 ? (msgsDay / maxMsgsDay) * 100 : 0;
      const tokenPct = maxTokensDay > 0 ? (tokensToday / maxTokensDay) * 100 : 0;

      const pickColor = (pct) => {
        if (pct > 90) return '#ef4444';
        if (pct > 70) return '#f59e0b';
        return ACCENT;
      };

      // User header
      ops.push({ op: 'upsert', id: `${prefix}-header`, type: 'kv', data: {
        title: `${this._roleEmoji(u.role)} ${u.displayName || u.email}`,
        items: [
          { key: 'Role', value: u.role },
          { key: 'Sessions', value: String(u.sessionCount || 0) },
          { key: 'Sub-Agents', value: maxSubAgents > 0 ? `${u.usage.subAgentsUsed || 0} / ${maxSubAgents}` : 'N/A' },
        ],
      }});

      // Progress bars for each quota dimension
      ops.push(
        { op: 'upsert', id: `${prefix}-msgs-hour`, type: 'progress', data: {
          label: `Msgs/Hour: ${msgsHour} / ${maxMsgsHour > 0 ? maxMsgsHour : '∞'}`,
          value: msgsHour,
          max: maxMsgsHour > 0 ? maxMsgsHour : Math.max(msgsHour, 1),
          icon: '💬',
          color: maxMsgsHour > 0 ? pickColor(hourPct) : '#6b7280',
        }},
        { op: 'upsert', id: `${prefix}-msgs-day`, type: 'progress', data: {
          label: `Msgs/Day: ${msgsDay} / ${maxMsgsDay > 0 ? maxMsgsDay : '∞'}`,
          value: msgsDay,
          max: maxMsgsDay > 0 ? maxMsgsDay : Math.max(msgsDay, 1),
          icon: '📊',
          color: maxMsgsDay > 0 ? pickColor(dayPct) : '#6b7280',
        }},
        { op: 'upsert', id: `${prefix}-tokens-day`, type: 'progress', data: {
          label: `Tokens/Day: ${this._formatTokens(tokensToday)} / ${maxTokensDay > 0 ? this._formatTokens(maxTokensDay) : '∞'} ($${costToday.toFixed(2)})`,
          value: tokensToday,
          max: maxTokensDay > 0 ? maxTokensDay : Math.max(tokensToday, 1),
          icon: usage.isByok ? '🔑' : '🪙',
          color: maxTokensDay > 0 ? pickColor(tokenPct) : '#6b7280',
        }},
      );

      // Edit quota + view detail buttons
      ops.push({ op: 'upsert', id: `${prefix}-actions`, type: 'buttons', data: {
        buttons: [
          { label: '📊 Edit Quota', action: 'admin-edit-quota', style: 'ghost', context: { userId: u.id } },
          { label: '👤 Detail', action: 'admin-user-detail', style: 'ghost', context: { userId: u.id } },
          { label: '🔄 Reset Usage', action: 'admin-reset-usage', style: 'ghost', context: { userId: u.id } },
        ],
      }});

      // Warnings for near-limit users
      if (hourPct > 90 && maxMsgsHour > 0) {
        ops.push({ op: 'upsert', id: `${prefix}-warn`, type: 'alert', data: {
          title: 'Near Hourly Limit',
          message: `${u.displayName || u.email} has used ${msgsHour}/${maxMsgsHour} messages this hour.`,
          severity: 'warning',
        }});
      } else if (dayPct > 90 && maxMsgsDay > 0) {
        ops.push({ op: 'upsert', id: `${prefix}-warn`, type: 'alert', data: {
          title: 'Near Daily Limit',
          message: `${u.displayName || u.email} has used ${msgsDay}/${maxMsgsDay} messages today.`,
          severity: 'warning',
        }});
      } else if (tokenPct > 90 && maxTokensDay > 0) {
        ops.push({ op: 'upsert', id: `${prefix}-warn`, type: 'alert', data: {
          title: 'Near Token Limit',
          message: `${u.displayName || u.email} has used ${this._formatTokens(tokensToday)}/${this._formatTokens(maxTokensDay)} tokens today.`,
          severity: 'warning',
        }});
      }
    }

    // Refresh button
    ops.push({ op: 'upsert', id: 'admin-quota-refresh', type: 'buttons', data: {
      buttons: [
        { label: '🔄 Refresh', action: 'admin-quotas', style: 'primary' },
      ],
    }});

    return { ops };
  }

  // ─── API Key Providers Overview ───────────────────────

  _providers() {
    const ACCENT = '#7c3aed';
    const users = this.userStore.listUsers();

    const ownKeyUsers = [];
    const hostedUsers = [];

    for (const u of users) {
      // Check if user has their own provider/API key configured
      // userStore.sanitize won't expose keys; we check raw user data for provider info
      const raw = this.userStore.getById(u.id);
      const provider = raw && raw.provider;

      if (provider && provider.name) {
        ownKeyUsers.push({
          name: u.displayName || u.email,
          email: u.email,
          role: u.role,
          status: u.status,
          providerName: provider.name,
          setupDate: provider.setupDate || provider.createdAt || u.createdAt,
        });
      } else {
        hostedUsers.push({
          name: u.displayName || u.email,
          email: u.email,
          role: u.role,
          status: u.status,
        });
      }
    }

    const ops = [
      { op: 'clear' },
      ...this._nav('providers'),
      { op: 'upsert', id: 'admin-prov-header', type: 'stats', data: {
        title: '🔑 API Key Providers',
        items: [
          { label: 'Total Users', value: String(users.length) },
          { label: 'Own Key', value: String(ownKeyUsers.length) },
          { label: 'Hosted Plan', value: String(hostedUsers.length) },
        ],
      }},
      { op: 'upsert', id: 'admin-prov-dist', type: 'tags', data: {
        label: 'Distribution',
        items: [
          { text: `${ownKeyUsers.length} Own Key`, color: '#10b981' },
          { text: `${hostedUsers.length} Hosted`, color: ACCENT },
        ],
      }},
    ];

    // Own-key users table
    if (ownKeyUsers.length > 0) {
      ops.push({ op: 'upsert', id: 'admin-prov-own-table', type: 'table', data: {
        title: '🟢 Users with Own API Keys',
        headers: ['User', 'Email', 'Role', 'Provider', 'Setup Date'],
        rows: ownKeyUsers.map(u => [
          u.name,
          u.email,
          `${this._roleEmoji(u.role)} ${u.role}`,
          u.providerName,
          this._formatDate(u.setupDate),
        ]),
      }});
    } else {
      ops.push({ op: 'upsert', id: 'admin-prov-own-none', type: 'alert', data: {
        title: 'No Own-Key Users',
        message: 'No users have configured their own API keys yet.',
        severity: 'info',
      }});
    }

    // Hosted plan users table
    if (hostedUsers.length > 0) {
      ops.push({ op: 'upsert', id: 'admin-prov-hosted-table', type: 'table', data: {
        title: '🟣 Users on Hosted Plan',
        headers: ['User', 'Email', 'Role', 'Status'],
        rows: hostedUsers.map(u => [
          u.name,
          u.email,
          `${this._roleEmoji(u.role)} ${u.role}`,
          u.status === 'active' ? '✅ Active' : '🚫 Disabled',
        ]),
      }});
    }

    // Refresh button
    ops.push({ op: 'upsert', id: 'admin-prov-refresh', type: 'buttons', data: {
      buttons: [
        { label: '🔄 Refresh', action: 'admin-providers', style: 'primary' },
      ],
    }});

    return { ops };
  }

  // ─── Real-Time Live Updates ────────────────────────────
  // Returns ONLY patch ops for data that changes every tick.
  // Called every ~3s by serve.js interval.

  _subagentsTrigger() {
    // Return a special marker so serve.js knows to activate the subagent monitor
    return { ops: [], _triggerSubagentMonitor: true };
  }

  getLiveUpdate(view) {
    try {
      switch (view) {
        case 'admin-dashboard':  return this._liveDashboard();
        case 'admin-monitor':    return this._liveMonitor();
        case 'admin-quotas':     return this._liveQuotas();
        case 'admin-providers':  return this._liveProviders();
        default: return null;
      }
    } catch (e) {
      console.error('[AdminWidget] Live update error:', e.message);
      return null;
    }
  }

  _liveDashboard() {
    const users = this._getEnrichedUsers();
    const totalSessions = this.sessionStore.totalSessions();

    let totalMessagesToday = 0, totalTokensToday = 0, totalMessagesThisHour = 0;
    let totalTokensCumulative = 0;
    let platformCostToday = 0, platformCostAll = 0;
    let byokCostToday = 0, byokCostAll = 0;
    for (const u of users) {
      if (u.usage) {
        totalMessagesToday += u.usage.messagesToday || 0;
        totalTokensToday += u.usage.tokensToday || 0;
        totalTokensCumulative += u.usage.tokensTotal || 0;
        totalMessagesThisHour += u.usage.messagesThisHour || 0;
        if (u.usage.costSource === 'user') {
          byokCostToday += u.usage.costToday || 0;
          byokCostAll += u.usage.costTotal || 0;
        } else {
          platformCostToday += u.usage.costToday || 0;
          platformCostAll += u.usage.costTotal || 0;
        }
      }
    }

    const activeUsers = users.filter(u => u.status === 'active').length;
    const disabledUsers = users.filter(u => u.status === 'disabled').length;

    // Top users
    const topUsers = [...users]
      .filter(u => u.usage && u.usage.messagesToday > 0)
      .sort((a, b) => (b.usage.messagesToday || 0) - (a.usage.messagesToday || 0))
      .slice(0, 5);

    const ops = [
      { op: 'patch', id: 'admin-stats', data: {
        items: [
          { label: 'Total Users', value: String(users.length) },
          { label: 'Active', value: String(activeUsers) },
          { label: 'Disabled', value: String(disabledUsers) },
          { label: 'Sessions', value: String(totalSessions) },
        ],
      }},
      { op: 'patch', id: 'admin-gauge-msgs-hour', data: {
        value: totalMessagesThisHour,
        max: Math.max(totalMessagesThisHour, 100),
      }},
      { op: 'patch', id: 'admin-gauge-msgs-day', data: {
        value: totalMessagesToday,
        max: Math.max(totalMessagesToday, 500),
      }},
      { op: 'patch', id: 'admin-gauge-tokens', data: {
        items: [
          { label: 'Tokens Today (total)', value: this._formatTokens(totalTokensToday) },
          { label: 'Tokens All Time', value: this._formatTokens(totalTokensCumulative) },
          { label: '💰 Your Cost Today', value: `$${platformCostToday.toFixed(2)}` },
          { label: '💰 Your Cost Total', value: `$${platformCostAll.toFixed(2)}` },
          ...(byokCostAll > 0 ? [
            { label: '🔑 BYOK Cost Today', value: `$${byokCostToday.toFixed(2)}` },
            { label: '🔑 BYOK Cost Total', value: `$${byokCostAll.toFixed(2)}` },
          ] : []),
        ],
      }},
    ];

    // Patch top users table
    if (topUsers.length > 0) {
      ops.push({ op: 'patch', id: 'admin-top-users', data: {
        rows: topUsers.map(u => [
          u.displayName || u.email,
          u.role,
          String(u.usage.messagesToday || 0),
          this._formatTokens(u.usage.tokensToday || 0),
          `$${(u.usage.costToday || 0).toFixed(2)}`,
          u.usage.costSource === 'user' ? '🔑' : '💰',
        ]),
      }});
    }

    // Gateway Sessions live patch
    try {
      const sessFile = path.join(process.env.HOME || '.', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
      const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      const shortModel = (m) => (m || '?').replace('anthropic/', '').replace('claude-', '').replace('-20250', '').replace('-latest', '').replace('-preview', '');
      const sessionRows = [];
      const now = Date.now();
      for (const [key, entry] of Object.entries(sessData)) {
        let type, name;
        if (key === 'agent:main:main') { type = '🏠 Main'; name = 'Main Agent'; }
        else if (key.includes(':cron:')) { type = '⏰ Cron'; name = 'Scheduled Job'; }
        else if (key.includes(':webchat:')) {
          const userId = key.split(':').pop();
          let userName = userId;
          try { const u = this.userStore.getById(userId); if (u) userName = u.displayName || u.email || userId; } catch(_) {}
          if (userName.startsWith('usr_')) userName = userName.slice(4, 14) + '…';
          type = '💬 Chat'; name = userName;
        } else if (key.includes(':isolated:') || key.includes(':subagent:') || entry.label) {
          type = '🤖 Sub-Agent'; name = entry.label || 'Unnamed Task';
        } else { type = '❓'; name = key.split(':').pop(); }
        const model = shortModel(entry.modelOverride || entry.model);
        const tokens = entry.totalTokens || 0;
        const tokenStr = tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
        const agoMs = entry.updatedAt ? now - entry.updatedAt : 0;
        const ago = agoMs < 60000 ? 'just now' : agoMs < 3600000 ? `${Math.round(agoMs / 60000)}m ago` : agoMs < 86400000 ? `${Math.round(agoMs / 3600000)}h ago` : `${Math.round(agoMs / 86400000)}d ago`;
        sessionRows.push([type, name, model, tokenStr, ago]);
      }
      if (sessionRows.length > 0) {
        ops.push({ op: 'patch', id: 'admin-dash-sessions', data: {
          title: `🔗 Gateway Sessions (${sessionRows.length})`,
          rows: sessionRows,
        }});
      }
    } catch (_) {}

    return { ops };
  }

  _liveMonitor() {
    const now = Date.now();
    const ops = [];

    // ── Connected users ──
    let connectedCount = 0;
    const connectedUsers = [];
    if (this._connections && typeof this._connections.forEach === 'function') {
      this._connections.forEach((conn, key) => {
        connectedCount++;
        const user = conn._userInfo?.user || {};
        const connectedAt = conn.connectedAt || conn.createdAt || now;
        const durationMs = now - connectedAt;
        const durationMin = Math.floor(durationMs / 60000);
        const durationStr = durationMin < 60
          ? `${durationMin}m`
          : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`;
        connectedUsers.push({
          name: user.displayName || user.email || key,
          role: user.role || 'unknown',
          lastActivity: this._formatDate(new Date(conn.lastActivity || connectedAt).toISOString()),
          duration: durationStr,
        });
      });
    }

    ops.push({ op: 'patch', id: 'admin-mon-header', data: {
      items: [
        { label: 'Connected Users', value: String(connectedCount) },
        { label: 'Active Sessions', value: String(this.sessionStore.totalSessions()) },
        { label: 'Total Users', value: String(this.userStore.listUsers().length) },
      ],
    }});

    // ── Message rate ──
    const cutoff5 = now - 5 * 60 * 1000;
    const recent = this._msgTimestamps.filter(t => t >= cutoff5);
    const ratePerMin = recent.length > 0 ? (recent.length / 5).toFixed(1) : '0';
    const minuteBuckets = [0, 0, 0, 0, 0];
    for (const ts of recent) {
      const minutesAgo = Math.floor((now - ts) / 60000);
      if (minutesAgo < 5) minuteBuckets[4 - minutesAgo]++;
    }

    ops.push({ op: 'patch', id: 'admin-mon-msgrate', data: {
      items: [
        { label: 'Avg msgs/min (5m)', value: ratePerMin },
        { label: 'Total (5m)', value: String(recent.length) },
        { label: 'Last 1m', value: String(minuteBuckets[4]) },
        { label: '2m ago', value: String(minuteBuckets[3]) },
        { label: '3m ago', value: String(minuteBuckets[2]) },
      ],
    }});

    // ── CPU (delta-based for accurate live reading) ──
    const cpuNow = this._snapshotCpu();
    let cpuPercent = 0;
    if (this._lastCpuSnapshot) {
      const idleDelta = cpuNow.idle - this._lastCpuSnapshot.idle;
      const totalDelta = cpuNow.total - this._lastCpuSnapshot.total;
      cpuPercent = totalDelta > 0 ? Math.round(100 - (idleDelta / totalDelta) * 100) : 0;
    }
    this._lastCpuSnapshot = cpuNow;

    // ── Memory ──
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    const fmtMB = (bytes) => (bytes / (1024 * 1024)).toFixed(0);

    ops.push(
      { op: 'patch', id: 'admin-mon-cpu', data: {
        label: 'CPU',
        value: cpuPercent,
        max: 100,
        unit: '%',
        color: cpuPercent > 80 ? '#ef4444' : cpuPercent > 60 ? '#f59e0b' : '#10b981',
      }},
      { op: 'patch', id: 'admin-mon-ram', data: {
        label: `RAM ${fmtMB(usedMem)}/${fmtMB(totalMem)}MB`,
        value: memPercent,
        max: 100,
        unit: '%',
        color: memPercent > 85 ? '#ef4444' : memPercent > 70 ? '#f59e0b' : '#10b981',
      }},
    );

    // Node.js process stats
    const procMem = process.memoryUsage();
    ops.push({ op: 'patch', id: 'admin-mon-process', data: {
      items: [
        { key: 'Heap Used', value: `${fmtMB(procMem.heapUsed)}MB / ${fmtMB(procMem.heapTotal)}MB` },
        { key: 'RSS', value: `${fmtMB(procMem.rss)}MB` },
        { key: 'External', value: `${fmtMB(procMem.external)}MB` },
      ],
    }});

    // Connected users table
    if (connectedUsers.length > 0) {
      ops.push({ op: 'patch', id: 'admin-mon-conn-table', data: {
        title: `🟢 Connected Users (${connectedCount})`,
        rows: connectedUsers.map(u => [u.name, u.role, u.lastActivity, u.duration]),
      }});
    }

    // ── Gateway Sessions (live refresh) ──
    try {
      const sessFile = path.join(process.env.HOME || '.', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
      const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      const shortModel = (m) => (m || '?').replace('anthropic/', '').replace('claude-', '').replace('-20250', '').replace('-latest', '').replace('-preview', '');
      const sessionRows = [];

      for (const [key, entry] of Object.entries(sessData)) {
        let type, name;
        if (key === 'agent:main:main') { type = '🏠 Main'; name = 'Main Agent'; }
        else if (key.includes(':cron:')) { type = '⏰ Cron'; name = 'Scheduled Job'; }
        else if (key.includes(':webchat:')) {
          const userId = key.split(':').pop();
          let userName = userId;
          try { const u = this.userStore.getById(userId); if (u) userName = u.displayName || u.email || userId; } catch(_) {}
          if (userName.startsWith('usr_')) userName = userName.slice(4, 14) + '…';
          type = '💬 Chat'; name = userName;
        } else if (key.includes(':isolated:') || entry.label) {
          type = '🤖 Sub-Agent'; name = entry.label || 'Unnamed Task';
        } else { type = '❓'; name = key.split(':').pop(); }

        const model = shortModel(entry.modelOverride || entry.model);
        const tokens = entry.totalTokens || 0;
        const tokenStr = tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
        let skillCount = 0;
        if (entry.skillsSnapshot && entry.skillsSnapshot.prompt) {
          skillCount = (entry.skillsSnapshot.prompt.match(/<name>/g) || []).length;
        }
        const agoMs = entry.updatedAt ? now - entry.updatedAt : 0;
        const ago = agoMs < 60000 ? 'just now' : agoMs < 3600000 ? `${Math.round(agoMs / 60000)}m ago` : agoMs < 86400000 ? `${Math.round(agoMs / 3600000)}h ago` : `${Math.round(agoMs / 86400000)}d ago`;
        sessionRows.push([type, name, model, tokenStr, `${skillCount}`, ago]);
      }

      if (sessionRows.length > 0) {
        ops.push({ op: 'patch', id: 'admin-mon-sessions', data: {
          title: `🔗 Gateway Sessions (${sessionRows.length})`,
          rows: sessionRows,
        }});
      }
    } catch (_) { /* non-fatal */ }

    return { ops };
  }

  _liveQuotas() {
    const users = this._getEnrichedUsers().filter(u => u.status === 'active');
    const ops = [];

    ops.push({ op: 'patch', id: 'admin-quota-header', data: {
      items: [{ label: 'Active Users', value: String(users.length) }],
    }});

    for (const u of users) {
      const usage = u.usage || {};
      const quota = u.effectiveQuota || {};
      const prefix = `admin-quota-${u.id}`;

      const msgsHour = usage.messagesThisHour || 0;
      const msgsDay = usage.messagesToday || 0;
      const tokensToday = usage.tokensToday || 0;
      const costToday = usage.costToday || 0;
      const maxMsgsHour = quota.maxMessagesPerHour || 0;
      const maxMsgsDay = quota.maxMessagesPerDay || 0;
      const maxTokensDay = quota.maxTokensPerDay || 0;

      const hourPct = maxMsgsHour > 0 ? (msgsHour / maxMsgsHour) * 100 : 0;
      const dayPct = maxMsgsDay > 0 ? (msgsDay / maxMsgsDay) * 100 : 0;
      const tokenPct = maxTokensDay > 0 ? (tokensToday / maxTokensDay) * 100 : 0;
      const pickColor = (pct) => pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#7c3aed';

      ops.push(
        { op: 'patch', id: `${prefix}-msgs-hour`, data: {
          label: `Msgs/Hour: ${msgsHour} / ${maxMsgsHour > 0 ? maxMsgsHour : '∞'}`,
          value: msgsHour,
          max: maxMsgsHour > 0 ? maxMsgsHour : Math.max(msgsHour, 1),
          color: maxMsgsHour > 0 ? pickColor(hourPct) : '#6b7280',
        }},
        { op: 'patch', id: `${prefix}-msgs-day`, data: {
          label: `Msgs/Day: ${msgsDay} / ${maxMsgsDay > 0 ? maxMsgsDay : '∞'}`,
          value: msgsDay,
          max: maxMsgsDay > 0 ? maxMsgsDay : Math.max(msgsDay, 1),
          color: maxMsgsDay > 0 ? pickColor(dayPct) : '#6b7280',
        }},
        { op: 'patch', id: `${prefix}-tokens-day`, data: {
          label: `Tokens/Day: ${this._formatTokens(tokensToday)} / ${maxTokensDay > 0 ? this._formatTokens(maxTokensDay) : '∞'} ($${costToday.toFixed(2)})`,
          value: tokensToday,
          max: maxTokensDay > 0 ? maxTokensDay : Math.max(tokensToday, 1),
          color: maxTokensDay > 0 ? pickColor(tokenPct) : '#6b7280',
        }},
      );
    }

    return { ops };
  }

  _liveProviders() {
    // Providers view rarely changes — minimal update
    const users = this.userStore.listUsers();
    let ownKeyCount = 0;
    for (const u of users) {
      const raw = this.userStore.getById(u.id);
      if (raw?.provider?.name) ownKeyCount++;
    }
    return { ops: [
      { op: 'patch', id: 'admin-prov-header', data: {
        items: [
          { label: 'Total Users', value: String(users.length) },
          { label: 'Own Key', value: String(ownKeyCount) },
          { label: 'Hosted Plan', value: String(users.length - ownKeyCount) },
        ],
      }},
    ]};
  }

  // ─── Temp Password Generator ──────────────────────────

  _generateTempPassword() {
    // 24-char cryptographically random password: upper, lower, digits, symbols
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%&*-_+=?';
    const all = upper + lower + digits + symbols;
    // Guarantee at least one from each class
    const parts = [
      upper[crypto.randomInt(upper.length)],
      lower[crypto.randomInt(lower.length)],
      digits[crypto.randomInt(digits.length)],
      symbols[crypto.randomInt(symbols.length)],
    ];
    for (let i = 0; i < 20; i++) {
      parts.push(all[crypto.randomInt(all.length)]);
    }
    // Shuffle with Fisher-Yates
    for (let i = parts.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [parts[i], parts[j]] = [parts[j], parts[i]];
    }
    return parts.join('');
  }
}

module.exports = AdminWidget;
