// Scratchy — Configuration
//
// Default config values. Override in config.local.js (gitignored).
// Auth token is read from the HttpOnly cookie set by serve.js.

// Default config — override these in config.local.js
const SCRATCHY_CONFIG = {
  // Gateway WebSocket URL
  // "auto" = derive from page origin (use /ws proxy when served by serve.js)
  gatewayUrl: "auto",

  // Auth token — auto-read from cookie set by serve.js, or override in config.local.js
  // ⚠️ NEVER hardcode your real token here — use config.local.js for manual override
  authToken: (document.cookie.match(/(?:^|;\s*)scratchy_auth=([^;]+)/) || [])[1] || "",

  // Session to connect to — per-user sessions injected via window.__SCRATCHY_SESSION_KEY
  sessionKey: window.__SCRATCHY_SESSION_KEY || "agent:main:main",

  // How many history messages to load on connect
  historyLimit: 50,

  // Scratchy server URL for full history (including compacted transcripts)
  // Set to "" to disable and use gateway-only history
  // Set to "auto" to use the same origin as the page (when served by serve.js)
  serverUrl: "auto",
};
