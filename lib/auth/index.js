/**
 * Auth System — Main entry point
 * 
 * Initializes and exports the complete auth system:
 * - UserStore (encrypted user database)
 * - SessionStore (server-side sessions)
 * - QuotaStore (per-user resource limits + usage tracking)
 * - Password utilities (Argon2id)
 * - Auth middleware (HTTP + WS authentication)
 */

const path = require("path");
const { UserStore } = require("./user-store");
const { SessionStore } = require("./session-store");
const { QuotaStore, ROLE_QUOTAS } = require("./quota-store");
const { hashPassword, verifyPassword, validatePassword } = require("./password");
const { createAuthMiddleware, ROLE_PERMISSIONS } = require("./middleware");

/**
 * Initialize the complete auth system
 * 
 * @param {object} options
 * @param {string} options.dataDir - Base data directory (e.g., /home/user/scratchy/.scratchy-data)
 * @param {string} options.masterSecret - Secret for encryption key derivation (gateway token)
 * @param {string} options.legacyToken - Legacy gateway token for backward compat (optional)
 * @returns {object} { userStore, sessionStore, quotaStore, auth, password }
 */
function initAuth({ dataDir, masterSecret, legacyToken }) {
  const authDataDir = path.join(dataDir, "auth");

  // Initialize stores
  const userStore = new UserStore(authDataDir);
  userStore.init(masterSecret);

  const sessionStore = new SessionStore(authDataDir);
  sessionStore.init();

  const quotaStore = new QuotaStore(authDataDir);
  quotaStore.init();

  // Create middleware
  const auth = createAuthMiddleware({ userStore, sessionStore, legacyToken });

  // Password utilities
  const password = { hashPassword, verifyPassword, validatePassword };

  console.log(
    `[Auth] Initialized — ${userStore.count()} users, ` +
    `${sessionStore.totalSessions()} active sessions, ` +
    `admin exists: ${userStore.hasAdmin()}`
  );

  return { userStore, sessionStore, quotaStore, auth, password, ROLE_QUOTAS, ROLE_PERMISSIONS };
}

module.exports = { initAuth };
