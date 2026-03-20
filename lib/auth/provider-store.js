/**
 * Provider Store — Encrypted API key storage + validation
 *
 * Stores per-user LLM provider API keys encrypted with AES-256-GCM.
 * Validates keys by making minimal test calls to each provider.
 *
 * Storage: .scratchy-data/auth/providers/{userId}.json.enc
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const VALID_PROVIDERS = ["openai", "anthropic", "google"];

class ProviderStore {
  /**
   * @param {string} dataDir - Path to .scratchy-data/auth/
   * @param {Buffer} encryptionKey - 32-byte AES key (same as user store)
   */
  constructor(dataDir, encryptionKey) {
    this._dir = path.join(dataDir, "providers");
    this._key = encryptionKey;
    fs.mkdirSync(this._dir, { recursive: true });
  }

  _filePath(userId) {
    return path.join(this._dir, `${userId}.json.enc`);
  }

  _encrypt(data) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", this._key, iv);
    let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag();
    return { iv: iv.toString("hex"), tag: tag.toString("hex"), data: encrypted };
  }

  _decrypt(envelope) {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this._key,
      Buffer.from(envelope.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    let decrypted = decipher.update(envelope.data, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return JSON.parse(decrypted);
  }

  /**
   * Save a validated provider key for a user.
   * Overwrites any existing key.
   */
  save(userId, provider, apiKey) {
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new Error(`Invalid provider: ${provider}`);
    }
    const data = {
      provider,
      apiKey,
      savedAt: new Date().toISOString(),
    };
    const encrypted = this._encrypt(data);
    fs.writeFileSync(this._filePath(userId), JSON.stringify(encrypted));
  }

  /**
   * Get a user's provider config (decrypted).
   * @returns {{ provider, apiKey, savedAt } | null}
   */
  get(userId) {
    const fp = this._filePath(userId);
    if (!fs.existsSync(fp)) return null;
    try {
      const envelope = JSON.parse(fs.readFileSync(fp, "utf8"));
      return this._decrypt(envelope);
    } catch {
      return null;
    }
  }

  /**
   * Get provider info without the actual key (safe for API responses).
   */
  getInfo(userId) {
    const data = this.get(userId);
    if (!data) return null;
    return {
      provider: data.provider,
      savedAt: data.savedAt,
      hasKey: true,
    };
  }

  /**
   * Remove a user's provider key.
   */
  remove(userId) {
    const fp = this._filePath(userId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  /**
   * Validate an API key by making a minimal test call.
   * Does NOT save — caller should save after validation.
   *
   * @returns {{ valid: boolean, error?: string, provider: string }}
   */
  async validate(provider, apiKey) {
    if (!VALID_PROVIDERS.includes(provider)) {
      return { valid: false, error: "Unknown provider", provider };
    }
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
      return { valid: false, error: "API key too short", provider };
    }

    switch (provider) {
      case "openai":
        return this._validateOpenAI(apiKey.trim());
      case "anthropic":
        return this._validateAnthropic(apiKey.trim());
      case "google":
        return this._validateGoogle(apiKey.trim());
      default:
        return { valid: false, error: "Unknown provider", provider };
    }
  }

  /**
   * OpenAI: GET /v1/models (free, lists available models)
   * 401 = bad key, 200 = good key
   */
  _validateOpenAI(apiKey) {
    return new Promise((resolve) => {
      const req = https.get("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      }, (res) => {
        // Consume body to free socket
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve({ valid: true, provider: "openai" });
          } else if (res.statusCode === 401) {
            resolve({ valid: false, error: "Invalid API key", provider: "openai" });
          } else if (res.statusCode === 429) {
            resolve({ valid: false, error: "Rate limited — key may be valid, try again", provider: "openai" });
          } else {
            resolve({ valid: false, error: `Unexpected response (${res.statusCode})`, provider: "openai" });
          }
        });
      });
      req.on("error", (e) => resolve({ valid: false, error: `Connection failed: ${e.message}`, provider: "openai" }));
      req.on("timeout", () => { req.destroy(); resolve({ valid: false, error: "Request timed out", provider: "openai" }); });
    });
  }

  /**
   * Anthropic: POST /v1/messages with max_tokens:1 (costs ~$0.00001)
   * 401 = bad key, anything else = key is valid
   */
  _validateAnthropic(apiKey) {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      const req = https.request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: 15000,
      }, (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode === 401) {
            resolve({ valid: false, error: "Invalid API key", provider: "anthropic" });
          } else if (res.statusCode === 403) {
            resolve({ valid: false, error: "Key forbidden — check account permissions", provider: "anthropic" });
          } else {
            // 200, 400 (bad request but key valid), 429 (rate limit but key valid), etc.
            resolve({ valid: true, provider: "anthropic" });
          }
        });
      });
      req.on("error", (e) => resolve({ valid: false, error: `Connection failed: ${e.message}`, provider: "anthropic" }));
      req.on("timeout", () => { req.destroy(); resolve({ valid: false, error: "Request timed out", provider: "anthropic" }); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Google: GET /v1beta/models (free, lists available models)
   * 400/403 = bad key, 200 = good key
   */
  _validateGoogle(apiKey) {
    return new Promise((resolve) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const req = https.get(url, { timeout: 10000 }, (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve({ valid: true, provider: "google" });
          } else if (res.statusCode === 400 || res.statusCode === 403) {
            resolve({ valid: false, error: "Invalid API key", provider: "google" });
          } else if (res.statusCode === 429) {
            resolve({ valid: false, error: "Rate limited — key may be valid, try again", provider: "google" });
          } else {
            resolve({ valid: false, error: `Unexpected response (${res.statusCode})`, provider: "google" });
          }
        });
      });
      req.on("error", (e) => resolve({ valid: false, error: `Connection failed: ${e.message}`, provider: "google" }));
      req.on("timeout", () => { req.destroy(); resolve({ valid: false, error: "Request timed out", provider: "google" }); });
    });
  }
}

module.exports = { ProviderStore };
