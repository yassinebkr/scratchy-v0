/**
 * WebAuthn / Passkey Routes — HTTP API endpoints for passkey management
 * 
 * Designed to be integrated into routes.js. Export a factory that returns
 * a handleWebAuthnRoute(req, res, url) → boolean dispatcher.
 * 
 * Endpoints:
 *   POST   /api/v2/auth/passkey/register/options  — (auth) generate registration challenge
 *   POST   /api/v2/auth/passkey/register/verify   — (auth) verify attestation, store credential
 *   POST   /api/v2/auth/passkey/login/options      — (public) generate authentication challenge
 *   POST   /api/v2/auth/passkey/login/verify       — (public) verify assertion, create session
 *   DELETE /api/v2/auth/passkey/:credentialId      — (auth) remove a passkey
 */

/**
 * Create WebAuthn route handlers bound to the auth system
 * 
 * @param {object} deps
 * @param {object} deps.userStore - UserStore instance
 * @param {object} deps.sessionStore - SessionStore instance
 * @param {object} deps.auth - Auth middleware (authenticateRequest, setSessionCookie)
 * @param {object} deps.webauthn - WebAuthn ceremony helpers (generateRegOptions, verifyRegResponse, etc.)
 * @param {function} deps.getClientIp - Extract client IP from request
 * @param {function} deps.setSecurityHeaders - Apply security headers to response
 * @returns {{ handleWebAuthnRoute: function }}
 */
function createWebAuthnRoutes({ userStore, sessionStore, auth, webauthn, getClientIp, setSecurityHeaders }) {

  const PREFIX = "/api/v2/auth/passkey";

  /**
   * Try to handle a WebAuthn request. Returns true if handled, false otherwise.
   * @param {import("http").IncomingMessage} req
   * @param {import("http").ServerResponse} res
   * @param {URL} url
   * @returns {boolean}
   */
  function handleWebAuthnRoute(req, res, url) {
    const p = url.pathname;

    // Quick prefix check to avoid unnecessary work
    if (!p.startsWith(PREFIX)) return false;

    // ── Registration routes (authenticated) ──

    if (p === PREFIX + "/register/options" && req.method === "POST") {
      return _handleRegisterOptions(req, res), true;
    }

    if (p === PREFIX + "/register/verify" && req.method === "POST") {
      return _handleRegisterVerify(req, res), true;
    }

    // ── Login routes (public) ──

    if (p === PREFIX + "/login/options" && req.method === "POST") {
      return _handleLoginOptions(req, res), true;
    }

    if (p === PREFIX + "/login/verify" && req.method === "POST") {
      return _handleLoginVerify(req, res), true;
    }

    // ── DELETE /api/v2/auth/passkey/:credentialId (authenticated) ──
    const deleteMatch = p.match(/^\/api\/v2\/auth\/passkey\/([A-Za-z0-9_\-=+/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      return _handleDeletePasskey(req, res, deleteMatch[1]), true;
    }

    return false;
  }

  // ── POST /api/v2/auth/passkey/register/options ──

  /**
   * Generate registration options for the authenticated user.
   * Returns challenge options + a challengeToken for verification.
   */
  function _handleRegisterOptions(req, res) {
    const authResult = auth.authenticateRequest(req);
    if (!authResult) return _json(res, 401, { error: "Authentication required" });

    (async () => {
      try {
        const user = userStore.getById(authResult.user.id);
        if (!user) return _json(res, 404, { error: "User not found" });

        if (user.status !== "active") {
          return _json(res, 403, { error: "Account is disabled" });
        }

        const { options, challengeToken } = await webauthn.generateRegOptions(user);

        console.log(`[WebAuthn] Registration challenge generated for ${user.email}`);

        _json(res, 200, {
          ok: true,
          options,
          challengeToken,
        });
      } catch (err) {
        console.error("[WebAuthn] Register options error:", err.message);
        _json(res, 500, { error: "Failed to generate registration options" });
      }
    })();
  }

  // ── POST /api/v2/auth/passkey/register/verify ──

  /**
   * Verify the registration response and store the new credential.
   * Expects JSON body: { challengeToken, credential, friendlyName? }
   */
  function _handleRegisterVerify(req, res) {
    const authResult = auth.authenticateRequest(req);
    if (!authResult) return _json(res, 401, { error: "Authentication required" });

    _readBody(req, res, async (body) => {
      try {
        const { challengeToken, credential, friendlyName } = body;

        if (!challengeToken || !credential) {
          return _json(res, 400, { error: "challengeToken and credential are required" });
        }

        // Retrieve and consume the challenge
        const stored = webauthn.challengeStore.get(challengeToken);
        if (!stored) {
          return _json(res, 400, { error: "Challenge expired or invalid" });
        }

        // Ensure the challenge was issued for this user
        if (stored.userId && stored.userId !== authResult.user.id) {
          return _json(res, 400, { error: "Challenge was not issued for this user" });
        }

        const user = userStore.getById(authResult.user.id);
        if (!user) return _json(res, 404, { error: "User not found" });

        // Verify the attestation response
        const passkey = await webauthn.verifyRegResponse(user, credential, stored.challenge);

        // Set friendly name if provided
        if (friendlyName && typeof friendlyName === "string") {
          passkey.friendlyName = friendlyName.slice(0, 64).trim();
        }

        // Store the credential
        userStore.addPasskey(user.id, passkey);

        console.log(`[WebAuthn] Passkey registered for ${user.email} (${passkey.credentialId.slice(0, 16)}...)`);

        _json(res, 201, {
          ok: true,
          passkey: {
            credentialId: passkey.credentialId,
            friendlyName: passkey.friendlyName,
            deviceType: passkey.deviceType,
            backedUp: passkey.backedUp,
          },
        });
      } catch (err) {
        console.error("[WebAuthn] Register verify error:", err.message);
        _json(res, 400, { error: err.message || "Registration verification failed" });
      }
    });
  }

  // ── POST /api/v2/auth/passkey/login/options ──

  /**
   * Generate authentication options for passkey login.
   * Optional JSON body: { email } — if provided, filters to that user's credentials (non-discoverable).
   * If no email, generates discoverable credential options.
   */
  function _handleLoginOptions(req, res) {
    _readBody(req, res, async (body) => {
      try {
        let allowCredentials = null;

        // If email provided, look up the user's credentials for non-discoverable flow
        if (body.email && typeof body.email === "string") {
          const user = userStore.getByEmail(body.email);
          if (user && user.status === "active" && user.passkeys && user.passkeys.length > 0) {
            allowCredentials = user.passkeys.map(pk => ({
              credentialId: pk.credentialId,
              transports: pk.transports || [],
            }));
          }
          // If user not found or has no passkeys, still generate discoverable options
          // (don't reveal whether the email exists)
        }

        const { options, challengeToken } = await webauthn.generateAuthOptions(allowCredentials);

        console.log(`[WebAuthn] Auth challenge generated${body.email ? ` for ${body.email}` : " (discoverable)"}`);

        _json(res, 200, {
          ok: true,
          options,
          challengeToken,
        });
      } catch (err) {
        console.error("[WebAuthn] Login options error:", err.message);
        _json(res, 500, { error: "Failed to generate authentication options" });
      }
    });
  }

  // ── POST /api/v2/auth/passkey/login/verify ──

  /**
   * Verify the authentication response and create a session.
   * Expects JSON body: { challengeToken, credential }
   */
  function _handleLoginVerify(req, res) {
    _readBody(req, res, async (body) => {
      try {
        const { challengeToken, credential } = body;

        if (!challengeToken || !credential) {
          return _json(res, 400, { error: "challengeToken and credential are required" });
        }

        // Retrieve and consume the challenge
        const stored = webauthn.challengeStore.get(challengeToken);
        if (!stored) {
          return _json(res, 400, { error: "Challenge expired or invalid" });
        }

        // Find the user by credential ID
        const credentialId = credential.id;
        if (!credentialId) {
          return _json(res, 400, { error: "Missing credential ID" });
        }

        const user = userStore.getByCredentialId(credentialId);
        if (!user) {
          return _json(res, 401, { error: "Unknown credential" });
        }

        if (user.status !== "active") {
          return _json(res, 403, { error: "Account is disabled. Contact an admin." });
        }

        // Find the stored passkey
        const storedPasskey = user.passkeys.find(pk => pk.credentialId === credentialId);
        if (!storedPasskey) {
          return _json(res, 401, { error: "Credential not found" });
        }

        // Verify the assertion
        const { verified, newCounter } = await webauthn.verifyAuthResponse(
          storedPasskey,
          credential,
          stored.challenge,
        );

        if (!verified) {
          return _json(res, 401, { error: "Passkey verification failed" });
        }

        // Update passkey metadata (counter + lastUsedAt)
        userStore.touchPasskey(user.id, credentialId);

        // Update last login timestamp
        userStore.updateUser(user.id, { lastLoginAt: new Date().toISOString() });

        // Create session
        const ip = getClientIp(req);
        const { sessionId } = sessionStore.createSession(user.id, {
          userAgent: req.headers["user-agent"],
          ip,
        });

        // Set session cookie
        auth.setSessionCookie(res, sessionId, { secure: true });

        const sanitized = userStore.sanitize(user);
        console.log(`[WebAuthn] Passkey login: ${user.email} (${user.role}) from ${ip}`);

        _json(res, 200, {
          ok: true,
          user: sanitized,
          sessionId,
          agentSessionKey: `main:webchat:${user.id}`,
        });
      } catch (err) {
        console.error("[WebAuthn] Login verify error:", err.message);
        _json(res, 401, { error: err.message || "Authentication failed" });
      }
    });
  }

  // ── DELETE /api/v2/auth/passkey/:credentialId ──

  /**
   * Remove a passkey from the authenticated user's account.
   */
  function _handleDeletePasskey(req, res, credentialId) {
    const authResult = auth.authenticateRequest(req);
    if (!authResult) return _json(res, 401, { error: "Authentication required" });

    try {
      const user = userStore.getById(authResult.user.id);
      if (!user) return _json(res, 404, { error: "User not found" });

      // Decode the credential ID (may be URL-encoded in the path)
      const decodedCredentialId = decodeURIComponent(credentialId);

      // Verify the passkey belongs to this user
      const passkey = (user.passkeys || []).find(pk => pk.credentialId === decodedCredentialId);
      if (!passkey) {
        return _json(res, 404, { error: "Passkey not found" });
      }

      // Prevent removing the last passkey if user has no password
      // (would lock them out)
      if (!user.passwordHash && user.passkeys.length <= 1) {
        return _json(res, 400, {
          error: "Cannot remove your only passkey — you have no password set. " +
                 "Add a password or another passkey first.",
        });
      }

      userStore.removePasskey(user.id, decodedCredentialId);

      console.log(`[WebAuthn] Passkey removed for ${user.email} (${decodedCredentialId.slice(0, 16)}...)`);

      _json(res, 200, { ok: true });
    } catch (err) {
      console.error("[WebAuthn] Delete passkey error:", err.message);
      _json(res, 500, { error: "Failed to remove passkey" });
    }
  }

  // ── Helpers ──

  /**
   * Send a JSON response with security headers
   */
  function _json(res, status, data) {
    setSecurityHeaders(res);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  /**
   * Read and parse JSON request body (max 16KB)
   */
  function _readBody(req, res, callback) {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 16384) { req.destroy(); return; }
    });
    req.on("end", () => {
      try {
        callback(body ? JSON.parse(body) : {});
      } catch {
        _json(res, 400, { error: "Invalid JSON body" });
      }
    });
  }

  return { handleWebAuthnRoute };
}

module.exports = { createWebAuthnRoutes };
