/**
 * WebAuthn / Passkey — Server-side ceremony helpers
 * 
 * Wraps @simplewebauthn/server to provide:
 * - Registration options + verification (adding a passkey to an existing account)
 * - Authentication options + verification (logging in with a passkey)
 * - In-memory challenge store with 5-minute TTL and automatic cleanup
 * 
 * rpID is auto-detected: "localhost" for local dev, "scratchy.clawos.fr" for production.
 * Origin follows suit: http://localhost:3001 (dev) or https://scratchy.clawos.fr (prod).
 */

const crypto = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

// ── Configuration ──

const RP_NAME = "Scratchy";
const PROD_RP_ID = "scratchy.clawos.fr";
const PROD_ORIGIN = "https://scratchy.clawos.fr";
const DEV_RP_ID = "localhost";
const DEV_ORIGIN = "http://localhost:3001";

/** Detect rpID based on hostname */
const hostname = require("os").hostname();
const isLocalDev = hostname === "localhost" || process.env.NODE_ENV === "development"
  || process.env.SCRATCHY_DEV === "1";

const rpID = isLocalDev ? DEV_RP_ID : PROD_RP_ID;
const expectedOrigin = isLocalDev ? DEV_ORIGIN : PROD_ORIGIN;

// ── Challenge Store ──

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000;   // Sweep every 60 seconds

/**
 * In-memory challenge store.
 * Challenges are keyed by a random token returned to the client.
 * Each entry stores { challenge, userId (optional), createdAt }.
 */
class ChallengeStore {
  constructor() {
    /** @type {Map<string, { challenge: string, userId: string|null, createdAt: number }>} */
    this._map = new Map();
    this._cleanupTimer = setInterval(() => this._sweep(), CLEANUP_INTERVAL_MS);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * Store a challenge and return the lookup token
   * @param {string} challenge - The WebAuthn challenge (base64url)
   * @param {string|null} userId - Optional user ID to bind the challenge to
   * @returns {string} Random token to send to the client
   */
  set(challenge, userId = null) {
    const token = crypto.randomBytes(32).toString("hex");
    this._map.set(token, {
      challenge,
      userId,
      createdAt: Date.now(),
    });
    return token;
  }

  /**
   * Retrieve and consume a challenge by token (one-time use)
   * @param {string} token - The token returned from set()
   * @returns {{ challenge: string, userId: string|null }|null}
   */
  get(token) {
    const entry = this._map.get(token);
    if (!entry) return null;

    // Remove immediately (one-time use)
    this._map.delete(token);

    // Check TTL
    if (Date.now() - entry.createdAt > CHALLENGE_TTL_MS) {
      return null;
    }

    return { challenge: entry.challenge, userId: entry.userId };
  }

  /** Remove expired entries */
  _sweep() {
    const now = Date.now();
    for (const [token, entry] of this._map) {
      if (now - entry.createdAt > CHALLENGE_TTL_MS) {
        this._map.delete(token);
      }
    }
  }

  /** Active challenge count (for diagnostics) */
  get size() {
    return this._map.size;
  }

  /** Shut down cleanup timer */
  shutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

/** Singleton challenge store */
const challengeStore = new ChallengeStore();

// ── Registration Ceremonies ──

/**
 * Generate registration options for adding a passkey to an existing account.
 * The user must already be authenticated.
 * 
 * @param {object} user - User object from userStore (must have id, email, passkeys[])
 * @returns {Promise<{ options: object, challengeToken: string }>}
 */
async function generateRegOptions(user) {
  // Build list of existing credentials to exclude (prevent re-registration)
  const excludeCredentials = (user.passkeys || []).map(pk => ({
    id: pk.credentialId,
    transports: pk.transports || [],
  }));

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.displayName || user.email,
    // Use user ID as the WebAuthn user handle (v13+ requires Uint8Array)
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  // Store challenge keyed by random token
  const challengeToken = challengeStore.set(options.challenge, user.id);

  return { options, challengeToken };
}

/**
 * Verify a registration response and return the credential to store.
 * 
 * @param {object} user - The authenticated user
 * @param {object} response - The attestation response from the browser
 * @param {string} expectedChallenge - The challenge string from the challenge store
 * @returns {Promise<object>} Credential object ready for userStore.addPasskey()
 */
async function verifyRegResponse(user, response, expectedChallenge) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Registration verification failed");
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  // Build credential object matching userPasskeySchema
  const passkey = {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
    counter: credential.counter,
    deviceType: credentialDeviceType === "singleDevice" ? "platform" : "cross-platform",
    backedUp: credentialBackedUp,
    transports: response.response?.transports || [],
    friendlyName: null, // Client can set this later
  };

  return passkey;
}

// ── Authentication Ceremonies ──

/**
 * Generate authentication options for passkey login.
 * Supports both discoverable credentials (no email) and non-discoverable (email provided).
 * 
 * @param {Array<{ credentialId: string, transports?: string[] }>} [allowCredentials] - Specific credentials to allow (for non-discoverable flow)
 * @returns {Promise<{ options: object, challengeToken: string }>}
 */
async function generateAuthOptions(allowCredentials) {
  const opts = {
    rpID,
    userVerification: "preferred",
  };

  // If allowCredentials provided, filter to specific credentials (non-discoverable flow)
  if (allowCredentials && allowCredentials.length > 0) {
    opts.allowCredentials = allowCredentials.map(cred => ({
      id: cred.credentialId,
      transports: cred.transports || [],
    }));
  }

  const options = await generateAuthenticationOptions(opts);

  // Store challenge (no userId — we don't know who's logging in yet)
  const challengeToken = challengeStore.set(options.challenge, null);

  return { options, challengeToken };
}

/**
 * Verify an authentication response.
 * 
 * @param {object} credential - The stored credential from userStore (must have credentialId, publicKey, counter)
 * @param {object} response - The assertion response from the browser
 * @param {string} expectedChallenge - The challenge string from the challenge store
 * @returns {Promise<{ verified: boolean, newCounter: number }>}
 */
async function verifyAuthResponse(credential, response, expectedChallenge) {
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: rpID,
    credential: {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey, "base64"),
      counter: credential.counter || 0,
    },
  });

  return {
    verified: verification.verified,
    newCounter: verification.authenticationInfo?.newCounter ?? credential.counter,
  };
}

module.exports = {
  generateRegOptions,
  verifyRegResponse,
  generateAuthOptions,
  verifyAuthResponse,
  challengeStore,
  rpID,
  expectedOrigin,
};
