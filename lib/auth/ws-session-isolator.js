/**
 * WS Session Isolator — Per-user WebSocket session isolation
 *
 * Provides helpers for serve.js's WS proxy to:
 * 1. Authenticate WS upgrade requests (multi-user session, legacy token, Bearer)
 * 2. Inject per-user agent session keys into gateway connect frames
 * 3. Enforce per-user message quotas
 * 4. Track connected users for admin dashboard
 *
 * Usage:
 *   const { createWsSessionIsolator } = require('./lib/auth/ws-session-isolator');
 *   const isolator = createWsSessionIsolator({ authSystem, AUTH_TOKEN, SESSION_SECRET });
 *   // In WS upgrade handler:
 *   const userInfo = isolator.authenticateWsUpgrade(req);
 *   // In connect frame interception:
 *   const modifiedFrame = isolator.injectSessionKey(frame, userInfo);
 *   // Before forwarding chat.send:
 *   const { allowed, reason } = isolator.checkMessageQuota(userInfo);
 */

const crypto = require("crypto");

/**
 * Create a WS session isolator bound to the auth system.
 *
 * @param {object} options
 * @param {object} options.authSystem - Initialized auth system from initAuth()
 *   - authSystem.auth.authenticateRequest(req) → { user, session, sessionId, isLegacy } | null
 *   - authSystem.quotaStore.checkMessageAllowed(user) → { allowed, reason }
 *   - authSystem.quotaStore.recordMessage(userId)
 * @param {string} options.AUTH_TOKEN - Gateway auth token (for legacy HMAC validation)
 * @param {string} options.SESSION_SECRET - Session secret (HMAC of gateway token), used
 *   to validate legacy scratchy_token cookies
 * @returns {object} Isolator instance with helper methods + connections Map
 */
function createWsSessionIsolator({ authSystem, AUTH_TOKEN, SESSION_SECRET }) {
  // Track connected users: userId → { connectedAt, clientId, lastActivity }
  const connections = new Map();

  /**
   * Parse cookies from a request's Cookie header.
   * @param {object} req - HTTP request
   * @returns {object} key-value cookie pairs
   */
  function _parseCookies(req) {
    const header = req.headers?.cookie || "";
    const cookies = {};
    header.split(";").forEach(c => {
      const [key, ...val] = c.trim().split("=");
      if (key) cookies[key.trim()] = val.join("=");
    });
    return cookies;
  }

  /**
   * Timing-safe string comparison.
   */
  function _timingSafeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /**
   * Derive the agent session key for a given user.
   *
   * - Legacy admin: "agent:main:main" (backward compat, full gateway session)
   * - Multi-user:   "main:webchat:{userId}" (isolated per-user session)
   *
   * @param {object} userInfo - Must have { user, isLegacy }
   * @returns {string} Agent session key
   */
  function getAgentSessionKey(userInfo) {
    if (!userInfo) return "agent:main:main"; // fallback
    if (userInfo.isLegacy) return "agent:main:main";
    return `agent:main:webchat:${userInfo.user.id}`;
  }

  /**
   * Authenticate a WebSocket upgrade request.
   *
   * Checks (in order):
   *   1. scratchy_session cookie (new multi-user session)
   *   2. scratchy_token cookie (legacy HMAC of gateway token)
   *   3. Authorization: Bearer header
   *
   * Uses authSystem.auth.authenticateRequest() which already handles
   * all three auth methods and returns a unified result.
   *
   * On success, also registers the user in the connections tracking Map.
   *
   * @param {object} req - HTTP upgrade request (has headers, url)
   * @returns {object|null} { user, sessionId, agentSessionKey, isLegacy } or null
   */
  function authenticateWsUpgrade(req) {
    // Delegate to the auth system's unified authenticateRequest
    // It handles: scratchy_session cookie, legacy scratchy_token, Bearer header
    const authResult = authSystem.auth.authenticateRequest(req);
    if (!authResult) return null;

    const { user, session, sessionId, isLegacy } = authResult;
    const agentSessionKey = getAgentSessionKey(authResult);

    // Extract clientId from URL for connection tracking
    let clientId = null;
    try {
      const url = new URL(req.url, "http://localhost");
      clientId = url.searchParams.get("clientId") || null;
    } catch (e) {
      // URL parsing failure is non-fatal for auth
    }

    const userInfo = {
      user,
      sessionId,
      agentSessionKey,
      isLegacy,
      clientId,
    };

    // Track connection
    const now = Date.now();
    connections.set(user.id, {
      connectedAt: connections.has(user.id)
        ? connections.get(user.id).connectedAt
        : now,
      clientId,
      lastActivity: now,
      user: {
        id: user.id,
        displayName: user.displayName,
        role: user.role,
      },
    });

    return userInfo;
  }

  /**
   * Modify a gateway connect frame to include the user's agent session key.
   *
   * The gateway uses the sessionKey param to route the connection to the
   * correct agent session (per-user isolation vs shared admin session).
   *
   * @param {object} connectFrame - Parsed connect frame: { type:"req", method:"connect", params:{...} }
   * @param {object} userInfo - From authenticateWsUpgrade: { agentSessionKey, ... }
   * @returns {object} Modified connect frame (mutated in place and returned)
   */
  function injectSessionKey(connectFrame, userInfo) {
    if (!connectFrame || !userInfo) return connectFrame;

    // Legacy admin: don't inject sessionKey — gateway handles routing via auth token
    // The gateway ConnectParams schema has additionalProperties:false,
    // so adding unknown properties causes a 1008 rejection.
    if (userInfo.isLegacy) return connectFrame;

    // Multi-user: store sessionKey on the frame object (NOT in params)
    // for serve.js to use when routing, but don't send it to the gateway
    // since the gateway schema doesn't support it yet.
    // Future: gateway needs a session routing mechanism for multi-user.
    connectFrame._sessionKey = userInfo.agentSessionKey;

    return connectFrame;
  }

  /**
   * Check if a user is allowed to send a message (quota + role check).
   *
   * Rules:
   * - Legacy admin: always allowed (no quota enforcement)
   * - Viewer role:  always blocked (read-only access)
   * - Others:       check quotaStore.checkMessageAllowed(user)
   *
   * @param {object} userInfo - From authenticateWsUpgrade: { user, isLegacy }
   * @returns {{ allowed: boolean, reason?: string }}
   */
  function checkMessageQuota(userInfo) {
    if (!userInfo || !userInfo.user) {
      return { allowed: false, reason: "Not authenticated" };
    }

    // Legacy admin — always allowed, no quota
    if (userInfo.isLegacy) {
      return { allowed: true };
    }

    // Viewer role — read-only, block all messages
    if (userInfo.user.role === "viewer") {
      return { allowed: false, reason: "Viewer accounts are read-only" };
    }

    // Delegate to quota store for operators and non-legacy admins
    return authSystem.quotaStore.checkMessageAllowed(userInfo.user);
  }

  /**
   * Record that a message was sent by a user (increment usage counters).
   *
   * Updates both quota store counters and connection activity tracking.
   * No-op for legacy admin users (they have no usage tracking).
   *
   * @param {object} userInfo - From authenticateWsUpgrade: { user, isLegacy }
   */
  function recordMessage(userInfo) {
    if (!userInfo || !userInfo.user) return;

    // Update last activity in connection tracking
    const conn = connections.get(userInfo.user.id);
    if (conn) {
      conn.lastActivity = Date.now();
    }

    // Record in quota store (including legacy admin — for dashboard visibility)
    authSystem.quotaStore.recordMessage(userInfo.user.id);
  }

  return {
    authenticateWsUpgrade,
    injectSessionKey,
    checkMessageQuota,
    recordMessage,
    getAgentSessionKey,
    connections,
  };
}

module.exports = { createWsSessionIsolator };
