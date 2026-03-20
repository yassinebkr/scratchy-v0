/**
 * Session Store — Server-side session management
 * 
 * Manages user sessions with:
 * - Cryptographic session IDs (not sequential)
 * - Configurable expiry (default 30 days)
 * - Device tracking
 * - Concurrent session limits
 * - Session revocation
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SESSION_ID_BYTES = 32;
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_SESSIONS_PER_USER = 10;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

class SessionStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionsFile = path.join(dataDir, "sessions.json");
    this._sessions = new Map(); // sessionId → session
    this._userSessions = new Map(); // userId → Set<sessionId>
    this._cleanupTimer = null;
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this._load();
    this._cleanupExpired();
    // Periodic cleanup
    this._cleanupTimer = setInterval(() => this._cleanupExpired(), CLEANUP_INTERVAL_MS);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  shutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  // ── Persistence ──

  _load() {
    if (!fs.existsSync(this.sessionsFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.sessionsFile, "utf8"));
      this._sessions.clear();
      this._userSessions.clear();
      for (const session of data) {
        this._sessions.set(session.sessionId, session);
        if (!this._userSessions.has(session.userId)) {
          this._userSessions.set(session.userId, new Set());
        }
        this._userSessions.get(session.userId).add(session.sessionId);
      }
    } catch (err) {
      console.error("[SessionStore] Failed to load sessions:", err.message);
    }
  }

  _save() {
    const sessions = Array.from(this._sessions.values());
    const tmpFile = this.sessionsFile + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, this.sessionsFile);
  }

  // ── Session CRUD ──

  /**
   * Create a new session for a user
   * @returns {object} { sessionId, session }
   */
  createSession(userId, { userAgent, ip, fingerprint } = {}) {
    // Enforce concurrent session limit
    const userSessions = this._userSessions.get(userId);
    if (userSessions && userSessions.size >= MAX_SESSIONS_PER_USER) {
      // Evict oldest session
      let oldest = null;
      let oldestTime = Infinity;
      for (const sid of userSessions) {
        const s = this._sessions.get(sid);
        if (s && new Date(s.createdAt).getTime() < oldestTime) {
          oldest = sid;
          oldestTime = new Date(s.createdAt).getTime();
        }
      }
      if (oldest) this.revokeSession(oldest);
    }

    const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString("hex");
    const now = new Date().toISOString();

    const session = {
      sessionId,
      userId,
      deviceInfo: {
        userAgent: userAgent || null,
        ip: ip || null,
        fingerprint: fingerprint || null,
      },
      createdAt: now,
      expiresAt: new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString(),
      lastActiveAt: now,
    };

    this._sessions.set(sessionId, session);
    if (!this._userSessions.has(userId)) {
      this._userSessions.set(userId, new Set());
    }
    this._userSessions.get(userId).add(sessionId);
    this._save();

    return { sessionId, session };
  }

  /**
   * Validate and return a session
   * Returns null if session doesn't exist, is expired, or user is disabled
   */
  getSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;

    // Check expiry
    if (new Date(session.expiresAt) < new Date()) {
      this.revokeSession(sessionId);
      return null;
    }

    return session;
  }

  /**
   * Touch session (update lastActiveAt)
   */
  touchSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    session.lastActiveAt = new Date().toISOString();
    // Don't save on every touch — debounce
    if (!this._touchTimer) {
      this._touchTimer = setTimeout(() => {
        this._save();
        this._touchTimer = null;
      }, 30000); // Save at most every 30s
      if (this._touchTimer.unref) this._touchTimer.unref();
    }
  }

  /**
   * Revoke (delete) a session
   */
  revokeSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    this._sessions.delete(sessionId);
    const userSessions = this._userSessions.get(session.userId);
    if (userSessions) {
      userSessions.delete(sessionId);
      if (userSessions.size === 0) this._userSessions.delete(session.userId);
    }
    this._save();
    return true;
  }

  /**
   * Revoke all sessions for a user (force logout everywhere)
   */
  revokeAllUserSessions(userId) {
    const userSessions = this._userSessions.get(userId);
    if (!userSessions) return 0;

    let count = 0;
    for (const sid of Array.from(userSessions)) {
      this._sessions.delete(sid);
      count++;
    }
    this._userSessions.delete(userId);
    this._save();
    return count;
  }

  /**
   * List active sessions for a user (sanitized)
   */
  listUserSessions(userId) {
    const sids = this._userSessions.get(userId);
    if (!sids) return [];
    const sessions = [];
    for (const sid of sids) {
      const s = this._sessions.get(sid);
      if (s) {
        sessions.push({
          sessionId: sid.substring(0, 8) + "...", // Truncated for display
          deviceInfo: s.deviceInfo,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          expiresAt: s.expiresAt,
          isCurrent: false, // Caller sets this
        });
      }
    }
    return sessions.sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt));
  }

  /**
   * Count total active sessions
   */
  totalSessions() {
    return this._sessions.size;
  }

  // ── Cleanup ──

  _cleanupExpired() {
    const now = new Date();
    let removed = 0;
    for (const [sid, session] of this._sessions) {
      if (new Date(session.expiresAt) < now) {
        this._sessions.delete(sid);
        const userSessions = this._userSessions.get(session.userId);
        if (userSessions) {
          userSessions.delete(sid);
          if (userSessions.size === 0) this._userSessions.delete(session.userId);
        }
        removed++;
      }
    }
    if (removed > 0) {
      this._save();
      console.log(`[SessionStore] Cleaned up ${removed} expired sessions`);
    }
  }
}

module.exports = { SessionStore };
