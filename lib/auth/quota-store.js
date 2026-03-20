/**
 * Quota Store — Per-user resource limits and usage tracking
 * 
 * Tracks: messages/hour, messages/day, tokens/day, active sub-agents
 * Admin can adjust quotas per-user in real-time (no restart needed).
 * Usage counters reset on daily/hourly boundaries.
 * 
 * Storage: .scratchy-data/auth/quotas.json (usage counters)
 * Quota definitions live on the user object (via role defaults + overrides).
 */

const fs = require("fs");
const path = require("path");

// Default quotas per role
const ROLE_QUOTAS = {
  admin: null, // No limits
  operator: {
    maxSubAgents: 2,
    maxMessagesPerHour: 30,
    maxMessagesPerDay: 200,
    maxTokensPerDay: 500000,
    maxTtsSecondsPerDay: 30,         // 30s of normal TTS per day
    maxRealtimeTtsSecondsPerDay: 60, // 1min of streaming TTS per day
    allowedModels: ["sonnet", "haiku"],
    // Only block admin-level tools; allow read, write, edit, web_search, web_fetch, exec
    // so operators can code, build widgets, and search the web
    toolsBlacklist: ["gateway", "nodes", "cron", "message", "memory_search", "memory_get"],
  },
  viewer: {
    maxSubAgents: 0,
    maxMessagesPerHour: 0,
    maxMessagesPerDay: 0,
    maxTokensPerDay: 0,
    maxTtsSecondsPerDay: 0,
    maxRealtimeTtsSecondsPerDay: 0,
    allowedModels: [],
    toolsBlacklist: ["*"],
  },
};

class QuotaStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.usageFile = path.join(dataDir, "usage.json");
    this._usage = new Map(); // userId → usage object
    this._quotaOverrides = new Map(); // userId → partial quota overrides
    this._overridesFile = path.join(dataDir, "quota-overrides.json");
    this._saveTimer = null;
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this._loadUsage();
    this._loadOverrides();
  }

  // ── Usage Persistence ──

  _loadUsage() {
    if (!fs.existsSync(this.usageFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.usageFile, "utf8"));
      for (const [userId, usage] of Object.entries(data)) {
        this._usage.set(userId, usage);
      }
    } catch (err) {
      console.error("[QuotaStore] Failed to load usage:", err.message);
    }
  }

  _loadOverrides() {
    if (!fs.existsSync(this._overridesFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._overridesFile, "utf8"));
      for (const [userId, overrides] of Object.entries(data)) {
        this._quotaOverrides.set(userId, overrides);
      }
    } catch (err) {
      console.error("[QuotaStore] Failed to load overrides:", err.message);
    }
  }

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveUsage();
    }, 5000); // Save at most every 5s
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _saveUsage() {
    try {
      const data = {};
      for (const [userId, usage] of this._usage) data[userId] = usage;
      const tmp = this.usageFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.usageFile);
    } catch (err) {
      console.error("[QuotaStore] Failed to save usage:", err.message);
    }
  }

  _saveOverrides() {
    try {
      const data = {};
      for (const [userId, overrides] of this._quotaOverrides) data[userId] = overrides;
      const tmp = this._overridesFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._overridesFile);
    } catch (err) {
      console.error("[QuotaStore] Failed to save overrides:", err.message);
    }
  }

  // ── Usage Tracking ──

  _getUsage(userId) {
    let usage = this._usage.get(userId);
    if (!usage) {
      usage = {
        messagesThisHour: 0,
        messagesToday: 0,
        tokensToday: 0,
        ttsSecondsToday: 0,
        realtimeTtsSecondsToday: 0,
        activeSubAgents: 0,
        hourStart: this._currentHour(),
        dayStart: this._currentDay(),
        suspendStrikes: 0,
      };
      this._usage.set(userId, usage);
    }

    // Reset counters if period rolled over
    const now = Date.now();
    if (usage.hourStart !== this._currentHour()) {
      usage.messagesThisHour = 0;
      usage.hourStart = this._currentHour();
    }
    if (usage.dayStart !== this._currentDay()) {
      usage.messagesToday = 0;
      usage.tokensToday = 0;
      usage.ttsSecondsToday = 0;
      usage.realtimeTtsSecondsToday = 0;
      usage.dayStart = this._currentDay();
      usage.suspendStrikes = 0; // Reset strikes daily
    }

    return usage;
  }

  _currentHour() {
    return Math.floor(Date.now() / (60 * 60 * 1000));
  }

  _currentDay() {
    return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  }

  // ── Quota Resolution ──

  /**
   * Get effective quota for a user (role defaults merged with per-user overrides)
   * Returns null if no limits (admin role with no overrides).
   */
  getEffectiveQuota(user) {
    if (!user) return ROLE_QUOTAS.viewer; // Safety: no user = most restrictive

    // Use `in` check — ROLE_QUOTAS.admin is explicitly null (unlimited), not missing
    const roleQuota = (user.role in ROLE_QUOTAS) ? ROLE_QUOTAS[user.role] : ROLE_QUOTAS.operator;
    if (roleQuota === null && !this._quotaOverrides.has(user.id)) {
      return null; // Admin with no overrides = unlimited
    }

    const overrides = this._quotaOverrides.get(user.id) || {};
    if (roleQuota === null) {
      // Admin with overrides — start from unlimited, apply overrides
      return Object.keys(overrides).length > 0 ? { ...overrides } : null;
    }

    return { ...roleQuota, ...overrides };
  }

  // ── Quota Checks ──

  /**
   * Check if user can send a message. Returns { allowed, reason } 
   * BYOK users bypass message/token quotas — they pay for their own usage
   */
  checkMessageAllowed(user) {
    if (user && user.preferences && user.preferences.plan === 'own-key') return { allowed: true };
    const quota = this.getEffectiveQuota(user);
    if (!quota) return { allowed: true }; // No limits

    const usage = this._getUsage(user.id);

    if (quota.maxMessagesPerHour !== undefined && usage.messagesThisHour >= quota.maxMessagesPerHour) {
      return { allowed: false, reason: `Hourly message limit reached (${quota.maxMessagesPerHour}/hour)` };
    }

    if (quota.maxMessagesPerDay !== undefined && usage.messagesToday >= quota.maxMessagesPerDay) {
      return { allowed: false, reason: `Daily message limit reached (${quota.maxMessagesPerDay}/day)` };
    }

    if (quota.maxTokensPerDay !== undefined && usage.tokensToday >= quota.maxTokensPerDay) {
      return { allowed: false, reason: `Daily token limit reached (${(quota.maxTokensPerDay / 1000).toFixed(0)}K tokens/day)` };
    }

    return { allowed: true };
  }

  /**
   * Check if user can spawn a sub-agent
   */
  checkSubAgentAllowed(user) {
    if (user && user.preferences && user.preferences.plan === 'own-key') return { allowed: true };
    const quota = this.getEffectiveQuota(user);
    if (!quota) return { allowed: true };

    const usage = this._getUsage(user.id);

    if (quota.maxSubAgents !== undefined && usage.activeSubAgents >= quota.maxSubAgents) {
      return { allowed: false, reason: `Sub-agent limit reached (${quota.maxSubAgents} max)` };
    }

    return { allowed: true };
  }

  /**
   * Check if user can use TTS (normal or realtime).
   * @param {object} user
   * @param {"normal"|"realtime"} type - TTS type
   * @param {number} estimatedSeconds - estimated duration of the request
   * @returns {{ allowed: boolean, reason?: string, remainingSeconds?: number }}
   */
  checkTtsAllowed(user, type = "normal", estimatedSeconds = 5) {
    if (user && user.preferences && user.preferences.plan === 'own-key') return { allowed: true };
    const quota = this.getEffectiveQuota(user);
    if (!quota) return { allowed: true }; // No limits (admin)

    const usage = this._getUsage(user.id);

    if (type === "realtime") {
      const max = quota.maxRealtimeTtsSecondsPerDay;
      if (max !== undefined && usage.realtimeTtsSecondsToday >= max) {
        return { allowed: false, reason: `Streaming TTS limit reached (${max}s/day)`, remainingSeconds: 0 };
      }
      if (max !== undefined) {
        return { allowed: true, remainingSeconds: Math.max(0, max - usage.realtimeTtsSecondsToday) };
      }
    } else {
      const max = quota.maxTtsSecondsPerDay;
      if (max !== undefined && usage.ttsSecondsToday >= max) {
        return { allowed: false, reason: `TTS limit reached (${max}s/day)`, remainingSeconds: 0 };
      }
      if (max !== undefined) {
        return { allowed: true, remainingSeconds: Math.max(0, max - usage.ttsSecondsToday) };
      }
    }

    return { allowed: true };
  }

  /**
   * Record TTS usage in seconds.
   * @param {string} userId
   * @param {number} seconds - duration of audio generated
   * @param {"normal"|"realtime"} type
   */
  recordTtsUsage(userId, seconds, type = "normal") {
    const usage = this._getUsage(userId);
    if (type === "realtime") {
      usage.realtimeTtsSecondsToday += seconds;
    } else {
      usage.ttsSecondsToday += seconds;
    }
    this._debounceSave();
  }

  /**
   * Check if a model is allowed for this user
   * BYOK users (own-key plan) bypass model restrictions — they pay for their own usage
   */
  isModelAllowed(user, model) {
    // Own-key users have no model restrictions — their subscription, their choice
    if (user && user.preferences && user.preferences.plan === 'own-key') return true;

    const quota = this.getEffectiveQuota(user);
    if (!quota || !quota.allowedModels) return true;
    if (quota.allowedModels.length === 0) return false;

    // Check if any allowed model substring matches
    const modelLower = (model || "").toLowerCase();
    return quota.allowedModels.some(m => modelLower.includes(m.toLowerCase()));
  }

  /**
   * Check if a tool is blocked for this user
   */
  isToolBlocked(user, toolName) {
    const quota = this.getEffectiveQuota(user);
    if (!quota || !quota.toolsBlacklist) return false;
    if (quota.toolsBlacklist.includes("*")) return true;
    return quota.toolsBlacklist.includes(toolName);
  }

  // ── Usage Recording ──

  /**
   * Record a message sent by user
   */
  recordMessage(userId) {
    const usage = this._getUsage(userId);
    usage.messagesThisHour++;
    usage.messagesToday++;
    this._debounceSave();
  }

  /**
   * Record tokens consumed by user
   */
  recordTokens(userId, tokenCount) {
    const usage = this._getUsage(userId);
    usage.tokensToday += tokenCount;
    this._debounceSave();
  }

  /**
   * Record sub-agent spawn
   */
  recordSubAgentStart(userId) {
    const usage = this._getUsage(userId);
    usage.activeSubAgents++;
    this._debounceSave();
  }

  /**
   * Record sub-agent completion
   */
  recordSubAgentEnd(userId) {
    const usage = this._getUsage(userId);
    usage.activeSubAgents = Math.max(0, usage.activeSubAgents - 1);
    this._debounceSave();
  }

  /**
   * Record a quota violation attempt (for auto-suspend)
   */
  recordStrike(userId) {
    const usage = this._getUsage(userId);
    usage.suspendStrikes++;
    this._debounceSave();
    return usage.suspendStrikes;
  }

  // ── Admin Controls ──

  /**
   * Get usage stats for a user (for admin dashboard)
   */
  getUsageStats(userId) {
    const usage = this._getUsage(userId);
    return { ...usage };
  }

  /**
   * Get usage stats for ALL users (admin dashboard overview)
   */
  getAllUsageStats() {
    const result = {};
    for (const [userId, usage] of this._usage) {
      result[userId] = { ...usage };
    }
    return result;
  }

  /**
   * Set quota overrides for a user (admin action, takes effect immediately)
   */
  setQuotaOverrides(userId, overrides) {
    const existing = this._quotaOverrides.get(userId) || {};
    this._quotaOverrides.set(userId, { ...existing, ...overrides });
    this._saveOverrides();
  }

  /**
   * Remove all quota overrides for a user (revert to role defaults)
   */
  clearQuotaOverrides(userId) {
    this._quotaOverrides.delete(userId);
    this._saveOverrides();
  }

  /**
   * Get quota overrides for a user
   */
  getQuotaOverrides(userId) {
    return this._quotaOverrides.get(userId) || {};
  }

  /**
   * Reset usage counters for a user (admin action)
   */
  resetUsage(userId) {
    this._usage.delete(userId);
    this._debounceSave();
  }
}

module.exports = { QuotaStore, ROLE_QUOTAS };
