/**
 * Auth Routes — HTTP API endpoints for authentication & user management
 * 
 * Mounts on serve.js. All routes use /api/v2/auth/* and /api/v2/admin/*
 * 
 * Auth routes (public):
 *   POST /api/v2/auth/register   — create first admin or invite-based registration
 *   POST /api/v2/auth/login      — email + password login
 *   POST /api/v2/auth/logout     — invalidate session
 *   GET  /api/v2/auth/me         — current user info + quotas
 * 
 * Admin routes (admin role required):
 *   GET  /api/v2/admin/users            — list all users
 *   POST /api/v2/admin/users/invite     — create invite (generates user account)
 *   POST /api/v2/admin/users/:id/role   — change user role
 *   POST /api/v2/admin/users/:id/quota  — update quota overrides
 *   POST /api/v2/admin/users/:id/disable — disable user
 *   POST /api/v2/admin/users/:id/enable  — enable user
 *   DELETE /api/v2/admin/users/:id      — delete user
 *   GET  /api/v2/admin/usage            — usage stats for all users
 */

/**
 * Create route handler bound to auth system
 * @param {object} opts - { userStore, sessionStore, quotaStore, auth, password, getClientIp, setSecurityHeaders, generateCsrf, validateCsrf }
 * @returns {function} handleAuthRoute(req, res) — returns true if handled, false if not an auth route
 */
const { isOnboardingComplete } = require('./onboarding');

function createAuthRoutes({ userStore, sessionStore, quotaStore, auth, password, getClientIp, setSecurityHeaders, generateCsrf, validateCsrf, loginLimiter }) {

  /**
   * Try to handle a request. Returns true if handled, false otherwise.
   */
  function handleAuthRoute(req, res, url) {
    const p = url.pathname;

    // ── Public auth routes (no session required) ──
    if (p === "/api/v2/auth/register" && req.method === "POST") {
      return _handleRegister(req, res), true;
    }
    if (p === "/api/v2/auth/login" && req.method === "POST") {
      return _handleLogin(req, res), true;
    }

    // ── Authenticated routes ──
    const authResult = auth.authenticateRequest(req);

    if (p === "/api/v2/auth/logout" && req.method === "POST") {
      if (!authResult) { _json(res, 401, { error: "Not authenticated" }); return true; }
      return _handleLogout(req, res, authResult), true;
    }
    if (p === "/api/v2/auth/me" && req.method === "GET") {
      if (!authResult) {
        // Include bootstrap + passkey info so the login page knows which mode to show
        const needsBootstrap = !userStore.hasAdmin();
        let passkeysAvailable = false;
        if (!needsBootstrap) {
          try {
            const users = userStore.listUsers();
            passkeysAvailable = users.some(u => u.passkeys && u.passkeys.length > 0);
          } catch (e) { /* ignore */ }
        }
        _json(res, 401, {
          error: "Not authenticated",
          needsBootstrap,
          noAdmin: needsBootstrap,
          passkeysAvailable,
        });
        return true;
      }
      return _handleMe(req, res, authResult), true;
    }

    // ── Admin routes ──
    if (p.startsWith("/api/v2/admin/")) {
      if (!authResult) { _json(res, 401, { error: "Not authenticated" }); return true; }
      if (authResult.user.role !== "admin") { _json(res, 403, { error: "Admin access required" }); return true; }
      return _handleAdminRoute(req, res, url, authResult);
    }

    return false; // Not an auth route
  }

  // ── POST /api/v2/auth/register ──
  function _handleRegister(req, res) {
    _readBody(req, res, async (body) => {
      const ip = getClientIp(req);

      try {
        const { email, password: pw, displayName, inviteCode } = body;

        // Validate email
        if (!email || !_isValidEmail(email)) {
          return _json(res, 400, { error: "Valid email is required" });
        }

        // Check if this is the first user (bootstrap flow)
        const isBootstrap = !userStore.hasAdmin();

        if (!isBootstrap) {
          // After first user, registration is invite-only
          // For now, only admins can create users (via /admin/users/invite)
          return _json(res, 403, { error: "Registration is invite-only. Ask an admin to create your account." });
        }

        // Validate password
        if (!pw) {
          return _json(res, 400, { error: "Password is required" });
        }
        const pwCheck = password.validatePassword(pw);
        if (!pwCheck.valid) {
          return _json(res, 400, { error: pwCheck.errors[0], errors: pwCheck.errors });
        }

        // Hash password
        const passwordHash = await password.hashPassword(pw);

        // Create user
        const role = isBootstrap ? "admin" : "operator";
        const user = userStore.createUser({
          email,
          displayName: displayName || email.split("@")[0],
          passwordHash,
          role,
          invitedBy: isBootstrap ? "bootstrap" : null,
        });

        // Create session
        const { sessionId } = sessionStore.createSession(user.id, {
          userAgent: req.headers["user-agent"],
          ip,
        });

        // Set session cookie
        auth.setSessionCookie(res, sessionId, { secure: true });

        console.log(`[Auth] ${isBootstrap ? "Bootstrap admin" : "User"} registered: ${user.email} (${user.id})`);

        _json(res, 201, {
          ok: true,
          user,
          sessionId,
          isBootstrap,
          agentSessionKey: `main:webchat:${user.id}`,
        });
      } catch (err) {
        console.error("[Auth] Registration error:", err.message);
        _json(res, 400, { error: err.message });
      }
    });
  }

  // ── POST /api/v2/auth/login ──
  function _handleLogin(req, res) {
    _readBody(req, res, async (body) => {
      const ip = getClientIp(req);

      // Check lockout
      if (loginLimiter && loginLimiter.isLockedOut(ip)) {
        const remaining = loginLimiter.remainingLockout(ip);
        return _json(res, 429, {
          error: "Too many failed attempts. Try again later.",
          lockout: true,
          retryAfter: remaining,
        });
      }

      try {
        const { email, password: pw } = body;

        if (!email || !pw) {
          return _json(res, 400, { error: "Email and password are required" });
        }

        // Find user
        const user = userStore.getByEmail(email);
        if (!user) {
          if (loginLimiter) loginLimiter.recordFailure(ip);
          // Constant-time response to prevent user enumeration
          await password.verifyPassword("$argon2id$v=19$m=65536,t=3,p=4$dummysalt$dummyhash", "dummy");
          return _json(res, 401, { error: "Invalid email or password" });
        }

        // Check account status
        if (user.status !== "active") {
          if (loginLimiter) loginLimiter.recordFailure(ip);
          return _json(res, 403, { error: "Account is disabled. Contact an admin." });
        }

        // Verify password
        if (!user.passwordHash) {
          if (loginLimiter) loginLimiter.recordFailure(ip);
          return _json(res, 401, { error: "Invalid email or password" });
        }

        const valid = await password.verifyPassword(user.passwordHash, pw);
        if (!valid) {
          if (loginLimiter) loginLimiter.recordFailure(ip);
          return _json(res, 401, { error: "Invalid email or password" });
        }

        // Success
        if (loginLimiter) loginLimiter.recordSuccess(ip);

        // Update last login
        userStore.updateUser(user.id, { lastLoginAt: new Date().toISOString() });

        // Create session
        const { sessionId } = sessionStore.createSession(user.id, {
          userAgent: req.headers["user-agent"],
          ip,
        });

        // Set session cookie
        auth.setSessionCookie(res, sessionId, { secure: true });

        const sanitized = userStore.sanitize(user);
        console.log(`[Auth] Login: ${user.email} (${user.role}) from ${ip}`);

        _json(res, 200, {
          ok: true,
          user: sanitized,
          sessionId,
          agentSessionKey: `main:webchat:${user.id}`,
        });
      } catch (err) {
        console.error("[Auth] Login error:", err.message);
        _json(res, 500, { error: "Login failed" });
      }
    });
  }

  // ── POST /api/v2/auth/logout ──
  function _handleLogout(req, res, authResult) {
    if (authResult.sessionId) {
      sessionStore.revokeSession(authResult.sessionId);
    }
    auth.clearSessionCookie(res);
    _json(res, 200, { ok: true });
  }

  // ── GET /api/v2/auth/me ──
  function _handleMe(req, res, authResult) {
    const user = authResult.user;
    const quota = quotaStore.getEffectiveQuota(user);
    const usage = authResult.isLegacy ? null : quotaStore.getUsageStats(user.id);

    // Check if user needs onboarding (non-legacy users only)
    let needsOnboarding = false;
    try {
      if (!authResult.isLegacy && user.id) {
        needsOnboarding = !isOnboardingComplete(userStore, user.id);
      }
    } catch (e) {
      console.error('[Auth] Onboarding check error:', e.message);
    }

    _json(res, 200, {
      user: authResult.isLegacy ? user : userStore.sanitize(userStore.getById(user.id)),
      isLegacy: authResult.isLegacy,
      quota,
      usage,
      needsOnboarding,
      // All users share the same gateway session until per-user session isolation is supported
      agentSessionKey: "agent:main:main",
    });
  }

  // ── Admin routes ──
  function _handleAdminRoute(req, res, url, authResult) {
    const p = url.pathname;

    // GET /api/v2/admin/users
    if (p === "/api/v2/admin/users" && req.method === "GET") {
      const users = userStore.listUsers();
      // Enrich with usage stats
      const enriched = users.map(u => ({
        ...u,
        usage: quotaStore.getUsageStats(u.id),
        quotaOverrides: quotaStore.getQuotaOverrides(u.id),
        effectiveQuota: quotaStore.getEffectiveQuota(u),
      }));
      _json(res, 200, { users: enriched });
      return true;
    }

    // POST /api/v2/admin/users/invite
    if (p === "/api/v2/admin/users/invite" && req.method === "POST") {
      _readBody(req, res, async (body) => {
        try {
          const { email, displayName, role = "operator", tempPassword } = body;

          if (!email || !_isValidEmail(email)) {
            return _json(res, 400, { error: "Valid email is required" });
          }

          // Generate or validate temp password
          const pw = tempPassword || _generateTempPassword();
          const pwCheck = password.validatePassword(pw);
          if (!pwCheck.valid) {
            return _json(res, 400, { error: "Temp password too weak: " + pwCheck.errors[0] });
          }

          const passwordHash = await password.hashPassword(pw);
          const user = userStore.createUser({
            email,
            displayName,
            passwordHash,
            role: role === "admin" ? "admin" : "operator",
            invitedBy: authResult.user.id,
          });

          console.log(`[Auth] User invited by ${authResult.user.email}: ${email} (${role})`);

          _json(res, 201, {
            ok: true,
            user,
            tempPassword: pw, // Show once to admin for sharing
          });
        } catch (err) {
          _json(res, 400, { error: err.message });
        }
      });
      return true;
    }

    // Extract user ID from path: /api/v2/admin/users/:id/action
    const userMatch = p.match(/^\/api\/v2\/admin\/users\/([^/]+)\/(.+)$/);
    const userDeleteMatch = p.match(/^\/api\/v2\/admin\/users\/([^/]+)$/);

    // DELETE /api/v2/admin/users/:id
    if (userDeleteMatch && req.method === "DELETE") {
      const targetId = userDeleteMatch[1];
      if (targetId === authResult.user.id) {
        _json(res, 400, { error: "Cannot delete your own account" });
        return true;
      }
      const deleted = userStore.deleteUser(targetId);
      if (deleted) {
        sessionStore.revokeAllUserSessions(targetId);
        quotaStore.resetUsage(targetId);
        quotaStore.clearQuotaOverrides(targetId);
        console.log(`[Auth] User deleted by ${authResult.user.email}: ${targetId}`);
      }
      _json(res, 200, { ok: deleted });
      return true;
    }

    if (!userMatch) {
      _json(res, 404, { error: "Unknown admin endpoint" });
      return true;
    }

    const targetUserId = userMatch[1];
    const action = userMatch[2];

    // POST /api/v2/admin/users/:id/role
    if (action === "role" && req.method === "POST") {
      _readBody(req, res, (body) => {
        const { role } = body;
        if (!["admin", "operator", "viewer"].includes(role)) {
          return _json(res, 400, { error: "Role must be admin, operator, or viewer" });
        }
        if (targetUserId === authResult.user.id && role !== "admin") {
          return _json(res, 400, { error: "Cannot demote yourself" });
        }
        try {
          const updated = userStore.updateUser(targetUserId, { role });
          console.log(`[Auth] Role changed by ${authResult.user.email}: ${targetUserId} → ${role}`);
          _json(res, 200, { ok: true, user: updated });
        } catch (err) {
          _json(res, 400, { error: err.message });
        }
      });
      return true;
    }

    // POST /api/v2/admin/users/:id/quota
    if (action === "quota" && req.method === "POST") {
      _readBody(req, res, (body) => {
        const allowed = ["maxSubAgents", "maxMessagesPerHour", "maxMessagesPerDay", "maxTokensPerDay", "allowedModels", "toolsBlacklist"];
        const overrides = {};
        for (const key of allowed) {
          if (key in body) overrides[key] = body[key];
        }
        quotaStore.setQuotaOverrides(targetUserId, overrides);
        console.log(`[Auth] Quota updated by ${authResult.user.email}: ${targetUserId} →`, overrides);
        _json(res, 200, {
          ok: true,
          effectiveQuota: quotaStore.getEffectiveQuota(userStore.getById(targetUserId)),
          overrides: quotaStore.getQuotaOverrides(targetUserId),
        });
      });
      return true;
    }

    // POST /api/v2/admin/users/:id/disable
    if (action === "disable" && req.method === "POST") {
      if (targetUserId === authResult.user.id) {
        _json(res, 400, { error: "Cannot disable your own account" });
        return true;
      }
      try {
        const updated = userStore.disableUser(targetUserId);
        sessionStore.revokeAllUserSessions(targetUserId);
        console.log(`[Auth] User disabled by ${authResult.user.email}: ${targetUserId}`);
        _json(res, 200, { ok: true, user: updated });
      } catch (err) {
        _json(res, 400, { error: err.message });
      }
      return true;
    }

    // POST /api/v2/admin/users/:id/enable
    if (action === "enable" && req.method === "POST") {
      try {
        const updated = userStore.updateUser(targetUserId, { status: "active" });
        console.log(`[Auth] User enabled by ${authResult.user.email}: ${targetUserId}`);
        _json(res, 200, { ok: true, user: updated });
      } catch (err) {
        _json(res, 400, { error: err.message });
      }
      return true;
    }

    // POST /api/v2/admin/users/:id/reset-usage
    if (action === "reset-usage" && req.method === "POST") {
      quotaStore.resetUsage(targetUserId);
      console.log(`[Auth] Usage reset by ${authResult.user.email}: ${targetUserId}`);
      _json(res, 200, { ok: true });
      return true;
    }

    // GET /api/v2/admin/usage
    if (p === "/api/v2/admin/usage" && req.method === "GET") {
      _json(res, 200, { usage: quotaStore.getAllUsageStats() });
      return true;
    }

    _json(res, 404, { error: "Unknown admin action: " + action });
    return true;
  }

  // ── Helpers ──

  function _json(res, status, data) {
    setSecurityHeaders(res);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  function _readBody(req, res, callback) {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 16384) { req.destroy(); return; }
    });
    req.on("end", () => {
      try {
        callback(JSON.parse(body));
      } catch {
        _json(res, 400, { error: "Invalid JSON body" });
      }
    });
  }

  function _isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function _generateTempPassword() {
    // Generate a readable temp password: word-word-word-digits
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
      "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec",
      "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu"];
    const crypto = require("crypto");
    const w1 = words[crypto.randomInt(words.length)];
    const w2 = words[crypto.randomInt(words.length)];
    const w3 = words[crypto.randomInt(words.length)];
    const num = crypto.randomInt(100, 999);
    return `${w1}-${w2}-${w3}-${num}`;
  }

  return { handleAuthRoute };
}

module.exports = { createAuthRoutes };
