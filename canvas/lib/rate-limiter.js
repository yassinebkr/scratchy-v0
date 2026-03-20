// Rate Limiter — Token bucket + per-minute cap for WebSocket messages

class RateLimiter {
  constructor(options = {}) {
    this._clients = new Map();
    this._maxPerMinute = options.maxPerMinute || 60;
    this._maxPerSecond = options.maxPerSecond || 10;
    this._burstSize = options.burstSize || 15;
    this._windowMs = 60000;
  }

  _getOrCreate(clientId) {
    if (!this._clients.has(clientId)) {
      this._clients.set(clientId, {
        tokens: this._burstSize,
        lastRefill: Date.now(),
        messages: [],  // timestamps for rolling window
        blocked: false,
      });
    }
    return this._clients.get(clientId);
  }

  _refill(entry) {
    const now = Date.now();
    const elapsed = (now - entry.lastRefill) / 1000;
    entry.tokens = Math.min(this._burstSize, entry.tokens + elapsed * this._maxPerSecond);
    entry.lastRefill = now;
    // Prune old messages outside the rolling window
    const cutoff = now - this._windowMs;
    entry.messages = entry.messages.filter(t => t > cutoff);
  }

  check(clientId) {
    const entry = this._getOrCreate(clientId);
    this._refill(entry);

    if (entry.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - entry.tokens) / this._maxPerSecond * 1000);
      entry.blocked = true;
      return { allowed: false, retryAfterMs };
    }

    if (entry.messages.length >= this._maxPerMinute) {
      const oldest = entry.messages[0];
      const retryAfterMs = Math.ceil((oldest + this._windowMs) - Date.now());
      entry.blocked = true;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1) };
    }

    entry.blocked = false;
    return { allowed: true, retryAfterMs: 0 };
  }

  consume(clientId) {
    const entry = this._getOrCreate(clientId);
    entry.tokens -= 1;
    entry.messages.push(Date.now());
  }

  reset(clientId) {
    this._clients.delete(clientId);
  }

  stats(clientId) {
    if (!this._clients.has(clientId)) return null;
    const entry = this._clients.get(clientId);
    this._refill(entry);
    return {
      tokens: Math.floor(entry.tokens),
      messagesInWindow: entry.messages.length,
      blocked: entry.blocked,
    };
  }

  cleanup(maxAgeMs) {
    const age = maxAgeMs || 300000;
    const cutoff = Date.now() - age;
    for (const [id, entry] of this._clients) {
      if (entry.lastRefill < cutoff && entry.messages.length === 0) {
        this._clients.delete(id);
      }
    }
  }
}

module.exports = { RateLimiter };
