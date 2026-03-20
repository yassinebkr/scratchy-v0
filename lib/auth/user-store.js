/**
 * User Store — File-based encrypted user database
 * 
 * Storage: .scratchy-data/users.json (AES-256-GCM encrypted at rest)
 * 
 * Each user has: id, email, displayName, role, passwordHash, passkeys[], 
 * status, createdAt, lastLoginAt, invitedBy
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

class UserStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.usersFile = path.join(dataDir, "users.json.enc");
    this.keyFile = path.join(dataDir, "encryption.key");
    this._users = new Map(); // id → user
    this._emailIndex = new Map(); // email → id
    this._encryptionKey = null;
    this._dirty = false;
  }

  // ── Initialization ──

  /**
   * Initialize the store. Creates data directory and encryption key if needed.
   * @param {string} masterSecret - Used to derive encryption key (gateway token or admin password)
   */
  init(masterSecret) {
    fs.mkdirSync(this.dataDir, { recursive: true });

    // Derive encryption key from master secret
    if (fs.existsSync(this.keyFile)) {
      // Load existing salt
      const salt = fs.readFileSync(this.keyFile);
      this._encryptionKey = crypto.pbkdf2Sync(masterSecret, salt, 100000, KEY_LENGTH, "sha512");
    } else {
      // First run — generate salt and derive key
      const salt = crypto.randomBytes(SALT_LENGTH);
      fs.writeFileSync(this.keyFile, salt, { mode: 0o600 });
      this._encryptionKey = crypto.pbkdf2Sync(masterSecret, salt, 100000, KEY_LENGTH, "sha512");
    }

    // Load existing users
    this._load();
  }

  // ── Encryption ──

  _encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this._encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv (16) + tag (16) + ciphertext
    return Buffer.concat([iv, tag, encrypted]);
  }

  _decrypt(buffer) {
    const iv = buffer.subarray(0, IV_LENGTH);
    const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, this._encryptionKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext, null, "utf8") + decipher.final("utf8");
  }

  // ── Persistence ──

  _load() {
    if (!fs.existsSync(this.usersFile)) {
      this._users.clear();
      this._emailIndex.clear();
      return;
    }
    try {
      const encrypted = fs.readFileSync(this.usersFile);
      const json = this._decrypt(encrypted);
      const users = JSON.parse(json);
      this._users.clear();
      this._emailIndex.clear();
      for (const user of users) {
        this._users.set(user.id, user);
        if (user.email) this._emailIndex.set(user.email.toLowerCase(), user.id);
      }
    } catch (err) {
      console.error("[UserStore] Failed to load users:", err.message);
      // Don't overwrite — might be a key mismatch
      throw new Error("Failed to decrypt user database. Wrong master secret?");
    }
  }

  _save() {
    const users = Array.from(this._users.values());
    const json = JSON.stringify(users, null, 2);
    const encrypted = this._encrypt(json);
    // Atomic write (write to temp, rename)
    const tmpFile = this.usersFile + ".tmp";
    fs.writeFileSync(tmpFile, encrypted, { mode: 0o600 });
    fs.renameSync(tmpFile, this.usersFile);
    this._dirty = false;
  }

  // ── User CRUD ──

  /**
   * Create a new user account
   * @returns {object} The created user (without passwordHash)
   */
  createUser({ email, displayName, passwordHash, role = "operator", invitedBy = null }) {
    const emailLower = email.toLowerCase().trim();

    // Check for duplicate email
    if (this._emailIndex.has(emailLower)) {
      throw new Error("Email already registered");
    }

    const user = {
      id: "usr_" + crypto.randomBytes(12).toString("hex"),
      email: emailLower,
      displayName: displayName || email.split("@")[0],
      role,
      passwordHash: passwordHash || null,
      passkeys: [],
      preferences: {},
      status: "active",
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      invitedBy,
    };

    this._users.set(user.id, user);
    this._emailIndex.set(emailLower, user.id);
    this._save();

    return this.sanitize(user);
  }

  /**
   * Get user by ID
   */
  getById(userId) {
    return this._users.get(userId) || null;
  }

  /**
   * Get user by email
   */
  getByEmail(email) {
    const id = this._emailIndex.get(email.toLowerCase().trim());
    return id ? this._users.get(id) : null;
  }

  /**
   * Get user by passkey credential ID
   */
  getByCredentialId(credentialId) {
    for (const user of this._users.values()) {
      if (user.passkeys.some(p => p.credentialId === credentialId)) {
        return user;
      }
    }
    return null;
  }

  /**
   * Update user fields
   */
  updateUser(userId, updates) {
    const user = this._users.get(userId);
    if (!user) throw new Error("User not found");

    // Allowed update fields
    const allowed = ["displayName", "role", "passwordHash", "status", "lastLoginAt", "passkeys", "preferences", "trialExpiresAt", "onboardingComplete"];
    for (const key of allowed) {
      if (key in updates) {
        user[key] = updates[key];
      }
    }

    // If email changed, update index
    if (updates.email && updates.email.toLowerCase() !== user.email) {
      this._emailIndex.delete(user.email);
      user.email = updates.email.toLowerCase().trim();
      this._emailIndex.set(user.email, userId);
    }

    this._save();
    return this.sanitize(user);
  }

  /**
   * Add a passkey to user
   */
  addPasskey(userId, passkey) {
    const user = this._users.get(userId);
    if (!user) throw new Error("User not found");
    user.passkeys.push({
      ...passkey,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    this._save();
  }

  /**
   * Remove a passkey from user
   */
  removePasskey(userId, credentialId) {
    const user = this._users.get(userId);
    if (!user) throw new Error("User not found");
    user.passkeys = user.passkeys.filter(p => p.credentialId !== credentialId);
    this._save();
  }

  /**
   * Update passkey last used timestamp
   */
  touchPasskey(userId, credentialId) {
    const user = this._users.get(userId);
    if (!user) return;
    const pk = user.passkeys.find(p => p.credentialId === credentialId);
    if (pk) {
      pk.lastUsedAt = new Date().toISOString();
      pk.counter = (pk.counter || 0) + 1;
      this._save();
    }
  }

  /**
   * Disable a user account
   */
  disableUser(userId) {
    return this.updateUser(userId, { status: "disabled" });
  }

  /**
   * Delete a user account (hard delete)
   */
  deleteUser(userId) {
    const user = this._users.get(userId);
    if (!user) return false;
    this._emailIndex.delete(user.email);
    this._users.delete(userId);
    this._save();
    return true;
  }

  /**
   * List all users (sanitized — no password hashes)
   */
  listUsers() {
    return Array.from(this._users.values()).map(u => this.sanitize(u));
  }

  /**
   * Count total users
   */
  count() {
    return this._users.size;
  }

  /**
   * Check if any admin exists (for bootstrap flow)
   */
  hasAdmin() {
    for (const user of this._users.values()) {
      if (user.role === "admin" && user.status === "active") return true;
    }
    return false;
  }

  /**
   * Check if a user's trial has expired
   * Returns false for admins (never expire) and users with no trial set
   */
  isTrialExpired(user) {
    if (!user) return false;
    if (user.role === "admin") return false;
    if (!user.trialExpiresAt) return false;
    return new Date(user.trialExpiresAt) < new Date();
  }

  /**
   * Remove sensitive fields for API responses
   */
  sanitize(user) {
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return {
      ...safe,
      hasPassword: !!passwordHash,
      passkeyCount: (user.passkeys || []).length,
      passkeys: (user.passkeys || []).map(p => ({
        credentialId: p.credentialId,
        friendlyName: p.friendlyName,
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt,
        deviceType: p.deviceType,
        backedUp: p.backedUp,
      })),
    };
  }
}

module.exports = { UserStore };
