/**
 * Auth Middleware — HTTP + WebSocket authentication
 * 
 * Provides request authentication and authorization.
 * Extracts user from session cookie/header, checks permissions.
 */

const crypto = require("crypto");

/**
 * Create auth middleware functions bound to the stores
 */
function createAuthMiddleware({ userStore, sessionStore, legacyToken }) {
  const SESSION_COOKIE_NAME = "scratchy_session";

  /**
   * Extract session ID from request (cookie, header, or query param)
   */
  function extractSessionId(req) {
    // 1. Cookie
    const cookieHeader = req.headers?.cookie || "";
    const cookies = {};
    cookieHeader.split(";").forEach(c => {
      const [key, ...val] = c.trim().split("=");
      if (key) cookies[key.trim()] = val.join("=");
    });
    if (cookies[SESSION_COOKIE_NAME]) return cookies[SESSION_COOKIE_NAME];

    // 2. Authorization header
    const authHeader = req.headers?.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }

    // 3. X-Session-Key header (iOS PWA fallback)
    const sessionHeader = req.headers?.["x-session-key"];
    if (sessionHeader) return sessionHeader;

    return null;
  }

  /**
   * Authenticate a request — returns { user, session } or null
   */
  function authenticate(req) {
    const sessionId = extractSessionId(req);
    if (!sessionId) return null;

    const session = sessionStore.getSession(sessionId);
    if (!session) return null;

    const user = userStore.getById(session.userId);
    if (!user || user.status !== "active") return null;

    // Check trial expiry (admins are exempt)
    if (userStore.isTrialExpired(user)) {
      return { user, session, sessionId, trialExpired: true };
    }

    // Touch session (update last active)
    sessionStore.touchSession(sessionId);

    return { user, session, sessionId };
  }

  /**
   * Check if request is authenticated via legacy gateway token
   * (backward compatibility for single-user mode)
   */
  function isLegacyAuth(req) {
    if (!legacyToken) return false;

    const url = new URL(req.url, "http://localhost");
    const queryToken = url.searchParams.get("token");
    if (queryToken && timingSafeEqual(queryToken, legacyToken)) return true;

    // Check old cookie format
    const cookieHeader = req.headers?.cookie || "";
    const cookies = {};
    cookieHeader.split(";").forEach(c => {
      const [key, ...val] = c.trim().split("=");
      if (key) cookies[key.trim()] = val.join("=");
    });
    const legacySessionSecret = crypto.createHmac("sha256", legacyToken)
      .update("scratchy-session").digest("hex");
    if (cookies.scratchy_token && timingSafeEqual(cookies.scratchy_token, legacySessionSecret)) {
      return true;
    }

    const authHeader = req.headers?.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      const bearer = authHeader.slice(7);
      if (timingSafeEqual(bearer, legacyToken)) return true;
      if (timingSafeEqual(bearer, legacySessionSecret)) return true;
    }

    return false;
  }

  /**
   * Full authentication check — new auth system OR legacy token
   * Returns { user, session, sessionId, isLegacy }
   */
  function authenticateRequest(req) {
    // Try new auth first
    const auth = authenticate(req);
    if (auth) return { ...auth, isLegacy: false, trialExpired: auth.trialExpired || false };

    // Try legacy token
    if (isLegacyAuth(req)) {
      // Create a virtual admin user for legacy mode
      return {
        user: {
          id: "legacy_admin",
          email: "admin@local",
          displayName: "Admin (legacy)",
          role: "admin",
          status: "active",
        },
        session: null,
        sessionId: null,
        isLegacy: true,
      };
    }

    return null;
  }

  /**
   * Check if a user has a specific permission
   */
  function hasPermission(user, permission) {
    if (!user) return false;
    const rolePermissions = ROLE_PERMISSIONS[user.role];
    if (!rolePermissions) return false;
    return rolePermissions.includes(permission) || rolePermissions.includes("*");
  }

  /**
   * Set session cookie on response
   */
  function setSessionCookie(res, sessionId, { secure = false } = {}) {
    const maxAge = 30 * 24 * 60 * 60; // 30 days in seconds
    const cookie = `${SESSION_COOKIE_NAME}=${sessionId}; ` +
      `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` +
      (secure ? "; Secure" : "");
    // Append to existing Set-Cookie headers
    const existing = res.getHeader("Set-Cookie") || [];
    const cookies = Array.isArray(existing) ? existing : [existing].filter(Boolean);
    cookies.push(cookie);
    res.setHeader("Set-Cookie", cookies);
  }

  /**
   * Clear session cookie
   */
  function clearSessionCookie(res) {
    const cookie = `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    res.setHeader("Set-Cookie", cookie);
  }

  return {
    authenticate,
    authenticateRequest,
    isLegacyAuth,
    hasPermission,
    extractSessionId,
    setSessionCookie,
    clearSessionCookie,
    SESSION_COOKIE_NAME,
  };
}

// ── Role Permissions ──

const ROLE_PERMISSIONS = {
  admin: [
    "agent.full",
    "agent.chat",
    "agent.tools.safe",
    "agent.tools.dangerous",
    "widgets.all",
    "users.manage",
    "users.invite",
    "settings.all",
    "canvas.edit",
    "canvas.view",
    "sessions.own",
    "sessions.view_all",
  ],
  operator: [
    "agent.chat",
    "agent.tools.safe",
    "widgets.all",
    "canvas.edit",
    "canvas.view",
    "sessions.own",
  ],
  viewer: [
    "agent.view",
    "canvas.view",
    "sessions.own",
  ],
};

// ── Helpers ──

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { createAuthMiddleware, ROLE_PERMISSIONS };
