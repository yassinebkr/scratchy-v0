#!/usr/bin/env node
// ============================================
// Scratchy — Server
// ============================================
// Serves the web/ directory AND provides an API endpoint
// to load older (compacted) session transcripts.
//
// Usage: node serve.js [port]
// Default port: 3001
//
// Auth: reads the gateway token from OpenClaw config.
// All requests (pages + API) require a valid token via:
//   - Cookie: scratchy_token=<token>  (set after login)
//   - Query:  ?token=<token>          (for initial login)
//
// API:
//   GET /api/history?session=<sessionKey>
//     Returns all messages from ALL transcript files for the session.

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");

// (singleton guard is at server.listen — see EADDRINUSE handler below)

// Phase 19: Multi-User Auth System
const { initAuth } = require("./lib/auth");
const { createAuthRoutes } = require("./lib/auth/routes");
const { UsageAggregator } = require("./lib/usage/usage-aggregator");
const { createWebAuthnRoutes } = require("./lib/auth/webauthn-routes");
const { createWsSessionIsolator } = require("./lib/auth/ws-session-isolator");
const { ProviderStore } = require("./lib/auth/provider-store");

// Phase 25: Version-Controlled Deployment
const { VersionStore } = require("./lib/version-store");

// Phase 30: UX Analytics System
const { initAnalytics } = require("./lib/analytics");

// Phase 31: Widget Region Manager + Memory Store
const { WidgetRegionManager } = require('./lib/widget-region');
const { MemoryStore } = require('./lib/memory-store');
const { readWidgetState, writeWidgetState } = require('./lib/widget-state');

// Phase 29: Cross-device real-time sync
const DeviceSync = require("./lib/device-sync");
const deviceSync = new DeviceSync();

// Per-user model override is handled by admin.js _saveModel() method
// which writes directly to the gateway's sessions.json

// Phase 26: Session Isolation (per-user history, search, send, WS filtering)
let sessionIsolation = null;
try {
  sessionIsolation = require("./lib/session-isolation");
} catch (e) {
  console.warn("[Scratchy] Session isolation module not found, skipping:", e.message);
}

// Phase 3: Complete Widget Ecosystem Integration with DIRECT ROUTING
let ScratchyCompleteIntegration = null;
let DirectWidgetRouting = null;
try {
  const { scratchyCompleteIntegration } = require("./genui-engine/scratchy-complete-integration.js");
  ScratchyCompleteIntegration = scratchyCompleteIntegration;
  console.log("[Scratchy] ✅ Complete Widget Ecosystem loaded successfully");
  console.log("[Scratchy] 🌐 Registered widgets:", ScratchyCompleteIntegration.getStatus().registeredWidgets.join(', '));
  console.log("[Scratchy] 🔧 Ecosystem health:", ScratchyCompleteIntegration.getStatus().health.status);
  
  // Load Direct Widget Routing (BYPASS CHAT)
  const { isolatedWidgetBridge } = require("./web/js/isolated-widget-bridge.js");
  DirectWidgetRouting = isolatedWidgetBridge;
  console.log("[Scratchy] 🎯 Direct Widget Routing initialized - CHAT BYPASSED");
  console.log("[Scratchy] 🔒 Widget isolation active - forms route directly to widgets");
} catch (e) {
  console.error("[Scratchy] ❌ Widget Ecosystem loading error:", e);
  console.error("[Scratchy] Stack:", e.stack);
}

// P3: Global error handlers to prevent silent crashes
process.on('uncaughtException', function(err) {
  console.error('[Scratchy] Uncaught exception:', err);
});
process.on('unhandledRejection', function(reason) {
  console.error('[Scratchy] Unhandled rejection:', reason);
});

// Load .env file if present
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  });
  console.error("[Scratchy] .env loaded — VOICE=" + process.env.ELEVENLABS_VOICE_ID +
    " MODEL=" + process.env.ELEVENLABS_MODEL);
}

// Build version — computed once at startup
const BUILD_HASH = (() => {
  try {
    return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
})();
const BUILD_TIMESTAMP = new Date().toISOString();
// Extract version tag from index.html (e.g. "20260224ap" from ?v=20260224ap)
const BUILD_VERSION = (() => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8');
    const m = html.match(/\?v=([0-9a-z]+)/);
    return m ? m[1] : null;
  } catch { return null; }
})();

const PORT = parseInt(process.argv[2] || "3001", 10);
const GATEWAY_PORT = parseInt(process.argv[3] || "28945", 10);
const WEB_DIR = path.join(__dirname, "web");
const PREVIEW_DIR = path.join(__dirname, "web-preview");
const previewSessions = new Set();
const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const SESSIONS_DIR = path.join(OPENCLAW_DIR, "agents", "main", "sessions");
const STORE_FILE = path.join(SESSIONS_DIR, "sessions.json");

// ── Load auth token from OpenClaw config ──
function loadAuthToken() {
  // Try config.yaml first
  const configPaths = [
    path.join(OPENCLAW_DIR, "openclaw.json"),
    path.join(OPENCLAW_DIR, "config.yaml"),
    path.join(OPENCLAW_DIR, "config.yml"),
    path.join(OPENCLAW_DIR, "config.json"),
  ];

  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;
    const content = fs.readFileSync(configPath, "utf-8");

    // Try JSON parse first
    if (configPath.endsWith(".json")) {
      try {
        const cfg = JSON.parse(content);
        // Look for gateway.auth.token
        const token = cfg?.gateway?.auth?.token;
        if (token) return token;
      } catch { /* fall through to regex */ }
    }

    // Fallback: regex for YAML or other formats
    // Match "token": "value" or token: value (but not maxTokens etc)
    const tokenMatch = content.match(/"token":\s*"([^"]+)"/);
    if (tokenMatch) return tokenMatch[1];
    const yamlMatch = content.match(/\btoken:\s+["']?([^\s"',}]+)/);
    if (yamlMatch) return yamlMatch[1];
  }

  // Fallback: environment variable
  if (process.env.SCRATCHY_TOKEN) return process.env.SCRATCHY_TOKEN;

  return null;
}

// ── Load OpenAI API key from auth profiles ──
function loadOpenAIKey() {
  // Try env first
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  // Try OpenClaw auth profiles
  const authProfilePaths = [
    path.join(OPENCLAW_DIR, "agents", "main", "agent", "auth-profiles.json"),
  ];

  for (const p of authProfilePaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      const profiles = data.profiles || {};
      for (const [key, profile] of Object.entries(profiles)) {
        if (profile.provider === "openai" && profile.token) {
          return profile.token;
        }
      }
    } catch { /* skip */ }
  }

  return null;
}

const AUTH_TOKEN = loadAuthToken();
if (!AUTH_TOKEN) {
  console.error("⚠️  No auth token found. Set SCRATCHY_TOKEN env var or configure gateway.auth.token in OpenClaw config.");
  console.error("   Scratchy will NOT start without authentication.");
  process.exit(1);
}

// Derive a session token (so we don't expose the raw gateway token in cookies)
const SESSION_SECRET = crypto.createHmac("sha256", AUTH_TOKEN).update("scratchy-session").digest("hex");

// ── Phase 19: Initialize multi-user auth system ──
const DATA_DIR = path.join(__dirname, ".scratchy-data");
let authSystem = null;
let authRoutes = null;
try {
  authSystem = initAuth({
    dataDir: DATA_DIR,
    masterSecret: AUTH_TOKEN,
    legacyToken: AUTH_TOKEN,
  });
  console.log("[Scratchy] ✅ Multi-user auth system initialized");

  // One-time cleanup: remove clientVersion from admin users
  // Admin should always see the dev version, never be pinned to a snapshot
  try {
    const allUsers = authSystem.userStore.listUsers();
    for (const u of allUsers) {
      if (u.role === 'admin' && u.preferences?.clientVersion) {
        const prefs = { ...(u.preferences) };
        delete prefs.clientVersion;
        authSystem.userStore.updateUser(u.id, { preferences: prefs });
        console.log(`[Scratchy] Cleaned admin clientVersion for ${u.displayName || u.email}`);
      }
    }
  } catch (e) {
    console.error("[Scratchy] Admin clientVersion cleanup failed:", e.message);
  }
} catch (err) {
  console.error("[Scratchy] ⚠️ Auth system init failed (falling back to legacy auth):", err.message);
}

// ── Phase 19: Initialize provider key store ──
let providerStore = null;
if (authSystem) {
  try {
    const encKeyPath = path.join(DATA_DIR, "auth", "encryption.key");
    const encKey = fs.readFileSync(encKeyPath);
    providerStore = new ProviderStore(path.join(DATA_DIR, "auth"), encKey);
    console.log("[Scratchy] ✅ Provider store initialized");
  } catch (err) {
    console.error("[Scratchy] ⚠️ Provider store init failed:", err.message);
  }
}

// ── Phase 29: Initialize usage aggregator (replaces JSONL full-scan) ──
let usageAggregator = null;
let usageQuery = null;
try {
  const sessionsDir = path.join(
    process.env.HOME || '.',
    '.openclaw', 'agents', 'main', 'sessions'
  );
  usageAggregator = new UsageAggregator({
    timezone: 'Europe/Berlin',
    sessionsDir,
    dataDir: path.join(DATA_DIR, 'usage'),
    adminUserId: authSystem ? (authSystem.userStore.listUsers().find(u => u.role === 'admin')?.id || '_admin') : '_admin',
  });
  // Initialize async (first run = full scan, then incremental)
  usageAggregator.initialize().then(() => {
    usageQuery = usageAggregator.getQuery();
    usageAggregator.startWatching();
    console.log('[Scratchy] ✅ Usage aggregator initialized + watching');
  }).catch(err => {
    console.error('[Scratchy] ⚠️ Usage aggregator init failed:', err.message);
  });
} catch (err) {
  console.error('[Scratchy] ⚠️ Usage aggregator creation failed:', err.message);
}

// ── Phase 25: Initialize version store ──
let versionStore = null;
try {
  versionStore = new VersionStore(__dirname).init();
  console.log(`[Scratchy] ✅ Version store initialized — ${versionStore.list().length} versions`);
} catch (err) {
  console.error("[Scratchy] ⚠️ Version store init failed:", err.message);
}

// Rate limiting: simple in-memory tracker
const rateLimiter = {
  requests: new Map(), // ip -> { count, resetAt }
  maxPerMinute: 300,

  check(ip) {
    const now = Date.now();
    const entry = this.requests.get(ip);
    if (!entry || now > entry.resetAt) {
      this.requests.set(ip, { count: 1, resetAt: now + 60000 });
      return true;
    }
    entry.count++;
    return entry.count <= this.maxPerMinute;
  },

  // Cleanup old entries every 5 minutes
  cleanup() {
    const now = Date.now();
    for (const [ip, entry] of this.requests) {
      if (now > entry.resetAt) this.requests.delete(ip);
    }
  },
};
setInterval(() => rateLimiter.cleanup(), 300000);

// ── Login rate limiting + brute force protection ──
const loginLimiter = {
  attempts: new Map(),    // ip -> { count, resetAt }
  lockouts: new Map(),    // ip -> lockoutUntil timestamp
  maxAttempts: 3,         // per window
  windowMs: 5 * 60000,   // 5 minutes
  lockoutThreshold: 6,    // total failures before lockout
  lockoutMs: 60 * 60000,  // 1 hour lockout

  isLockedOut(ip) {
    const until = this.lockouts.get(ip);
    if (!until) return false;
    if (Date.now() > until) { this.lockouts.delete(ip); return false; }
    return true;
  },

  remainingLockout(ip) {
    const until = this.lockouts.get(ip);
    if (!until) return 0;
    return Math.max(0, until - Date.now());
  },

  recordFailure(ip) {
    const now = Date.now();
    const entry = this.attempts.get(ip) || { count: 0, total: 0, resetAt: now + this.windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + this.windowMs; }
    entry.count++;
    entry.total = (entry.total || 0) + 1;
    this.attempts.set(ip, entry);

    if (entry.total >= this.lockoutThreshold) {
      this.lockouts.set(ip, now + this.lockoutMs);
      console.warn(`[Security] IP ${ip} locked out for ${this.lockoutMs / 60000}min (${entry.total} failed attempts)`);
    }
    return entry.count <= this.maxAttempts;
  },

  recordSuccess(ip) {
    this.attempts.delete(ip);
    this.lockouts.delete(ip);
  },

  cleanup() {
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      if (now > entry.resetAt) this.attempts.delete(ip);
    }
    for (const [ip, until] of this.lockouts) {
      if (now > until) this.lockouts.delete(ip);
    }
  },
};
setInterval(() => loginLimiter.cleanup(), 300000);

// ── CSRF tokens ──
const csrfTokens = new Map(); // token -> expiresAt
function generateCsrf() {
  const token = crypto.randomBytes(32).toString("hex");
  csrfTokens.set(token, Date.now() + 10 * 60000); // valid 10 minutes
  return token;
}
function validateCsrf(token) {
  if (!token) return false;
  const expires = csrfTokens.get(token);
  if (!expires) return false;
  csrfTokens.delete(token); // one-time use
  return Date.now() < expires;
}
// Cleanup expired CSRF tokens
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of csrfTokens) { if (now > exp) csrfTokens.delete(t); }
}, 300000);

// ── Phase 19: Create auth routes (after loginLimiter and helpers are defined) ──
let webauthnRoutes = null;
let wsIsolator = null;
if (authSystem) {
  authRoutes = createAuthRoutes({
    userStore: authSystem.userStore,
    sessionStore: authSystem.sessionStore,
    quotaStore: authSystem.quotaStore,
    auth: authSystem.auth,
    password: authSystem.password,
    getClientIp,
    setSecurityHeaders,
    generateCsrf,
    validateCsrf,
    loginLimiter,
  });

  // WebAuthn/Passkey routes
  const webauthn = require("./lib/auth/webauthn");
  webauthnRoutes = createWebAuthnRoutes({
    userStore: authSystem.userStore,
    sessionStore: authSystem.sessionStore,
    auth: authSystem.auth,
    webauthn,
    getClientIp,
    setSecurityHeaders,
  });

  // WS session isolator (per-user session keys + quota enforcement)
  wsIsolator = createWsSessionIsolator({
    authSystem,
    AUTH_TOKEN,
    SESSION_SECRET,
  });

  console.log("[Scratchy] ✅ Auth routes + WebAuthn + WS isolator initialized");
}

// P2: Safe IP extraction — only trust X-Forwarded-For from trusted proxies (localhost = Cloudflare tunnel)
function getClientIp(req) {
  var remoteIp = req.socket.remoteAddress;
  if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
    var xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return remoteIp || 'unknown';
}

// MIME types for static files
const WORKSPACE_DIR = path.join(OPENCLAW_DIR, "workspace");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

// ── Auth helpers ──
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((c) => {
    const [key, ...val] = c.trim().split("=");
    if (key) cookies[key] = val.join("=");
  });
  return cookies;
}

function isAuthenticated(req) {
  // Phase 19: Check multi-user auth system first
  if (authSystem) {
    const authResult = authSystem.auth.authenticateRequest(req);
    if (authResult) {
      // Attach auth result to request for downstream use
      req._authResult = authResult;
      return true;
    }
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Check query param token (for initial login / bookmarkable URL)
  const queryToken = url.searchParams.get("token");
  if (queryToken && timingSafeEqual(queryToken, AUTH_TOKEN)) return true;

  // Check cookie session token
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.scratchy_token && timingSafeEqual(cookies.scratchy_token, SESSION_SECRET)) return true;

  // Check Authorization header (Bearer token — used by iOS PWA localStorage fallback)
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice(7);
    if (timingSafeEqual(bearer, AUTH_TOKEN)) return true;
    // Also accept session secret as Bearer token (iOS PWA sends this)
    if (timingSafeEqual(bearer, SESSION_SECRET)) return true;
  }

  // Check X-Session-Key header (iOS PWA fallback)
  const sessionHeader = req.headers["x-session-key"];
  if (sessionHeader && timingSafeEqual(sessionHeader, SESSION_SECRET)) return true;

  return false;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sendUnauthorized(req, res) {
  // Serve the login page with CSRF token injected
  // Use login-v2 when multi-user auth system is active
  const loginFile = authSystem ? "login-v2.html" : "login.html";
  const loginPath = path.join(WEB_DIR, loginFile);
  try {
    let html = fs.readFileSync(loginPath, "utf-8");
    // Inject CSRF token as meta tag
    const csrf = generateCsrf();
    html = html.replace("</head>", `  <meta name="csrf-token" content="${csrf}">\n</head>`);
    setSecurityHeaders(res);
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    // Fallback to legacy login or error
    const fallbackPath = path.join(WEB_DIR, "login.html");
    try {
      let html = fs.readFileSync(fallbackPath, "utf-8");
      const csrf = generateCsrf();
      html = html.replace("</head>", `  <meta name="csrf-token" content="${csrf}">\n</head>`);
      setSecurityHeaders(res);
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized. Login page not found.");
    }
  }
}

// Security headers for all responses
function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

// ── Parse messages from a JSONL transcript file ──
function isSystemMessage(text) {
  if (!text) return false;
  const t = text.trim();
  // Strip ProteClaw injections before checking — these are prepended to all user messages by ProteClaw plugin
  const stripped = t
    .replace(/\[ProteClaw Memory\] Auto-recalled[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |$)/g, "")
    .replace(/\[ProteClaw Canary\][^\n]*/g, "")
    .trim();
  if (!stripped) return true; // Message was ONLY ProteClaw injections — treat as system
  return t.startsWith('[ProteClaw L') ||
         t.startsWith('[ProteClaw:') ||
         t.startsWith('System:') ||
         t.startsWith('GatewayRestart:') ||
         t.includes('[proteclaw:source=') ||
         /(?:^|\s)HEARTBEAT_OK(?:\s|$)/.test(t) ||
         /(?:^|\s)NO_REPLY(?:\s|$)/.test(t) ||
         t.startsWith('Read HEARTBEAT.md') ||
         stripped.startsWith('A background task ') ||
         stripped.includes('Summarize this naturally') ||
         stripped.includes('sessionKey agent:main:subagent:');
}

// Strip ProteClaw injections from user messages before sending to client
function cleanProteClawInjections(text) {
  return (text || "")
    // Strip ProteClaw auto-recalled memory sections
    .replace(/\[ProteClaw Memory\] Auto-recalled[\s\S]*?(?=\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |$)/g, "")
    // Strip ProteClaw canary tokens
    .replace(/\[ProteClaw Canary\][^\n]*/g, "")
    // Strip gateway system notes (abort notices, etc.)
    .replace(/^Note: The previous agent run was aborted[^\n]*\n?/gm, "")
    // Strip message_id and genui tags
    .replace(/\n?\[message_id:[^\]]*\]/g, "")
    .replace(/\n?\[genui:\w+\]/g, "")
    // Clean up empty lines first, then strip gateway timestamp prefix
    .replace(/^\s*\n/gm, "")
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[^\]]*\]\s*/g, "")
    .trim();
}

function parseTranscript(filePath) {
  if (!fs.existsSync(filePath)) return { messages: [], compactionDate: null };

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const messages = [];
  let compactionDate = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      if (entry.type === "compaction" && entry.timestamp) {
        compactionDate = entry.timestamp;
      }

      if (entry.message) {
        const msg = entry.message;
        const role = msg.role;
        if (role !== "user" && role !== "assistant") continue;

        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text)
            .join("\n");
        }
        if (!text.trim()) continue;
        if (isSystemMessage(text)) continue;

        // Strip ProteClaw injections from user messages (auto-recall + canary)
        if (role === "user") {
          text = cleanProteClawInjections(text);
          if (!text) continue; // Was only ProteClaw metadata
        }

        messages.push({
          role,
          text,
          timestamp: msg.timestamp || entry.timestamp || null,
        });
      }
    } catch {
      // skip bad lines
    }
  }

  return { messages, compactionDate };
}

// ── Find all transcript files for a session ──
function findTranscriptFiles(sessionId) {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  const baseId = sessionId.split(".jsonl.deleted.")[0];
  const allFiles = fs.readdirSync(SESSIONS_DIR);
  const matching = allFiles
    .filter((f) => {
      if (!f.startsWith(baseId)) return false;
      if (f.endsWith(".lock")) return false;
      if (f.includes(".proteclaw-backup")) return false;  // Skip ProteClaw backup files
      return f.includes(".jsonl");
    })
    .map((f) => ({
      name: f,
      path: path.join(SESSIONS_DIR, f),
      isArchived: f.includes(".deleted."),
      stat: fs.statSync(path.join(SESSIONS_DIR, f)),
    }))
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

  return matching;
}

// ── Session chain tracking ──
// The gateway rotates session IDs on compaction/restart. This tracks ALL session
// IDs ever used for a session key so history can span across rotations.
const SESSION_CHAINS_DIR = path.join(__dirname, ".scratchy-data", "session-chains");

function _loadSessionChain(sessionKey) {
  const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
  const chainPath = path.join(SESSION_CHAINS_DIR, safeName);
  try {
    return JSON.parse(fs.readFileSync(chainPath, "utf-8"));
  } catch {
    return { sessionIds: [] };
  }
}

function _saveSessionChain(sessionKey, chain) {
  const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
  if (!fs.existsSync(SESSION_CHAINS_DIR)) fs.mkdirSync(SESSION_CHAINS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_CHAINS_DIR, safeName), JSON.stringify(chain));
}

/**
 * Record a session ID for a session key. Returns the full chain of known IDs.
 */
function trackSessionId(sessionKey, sessionId) {
  const chain = _loadSessionChain(sessionKey);
  if (!chain.sessionIds.includes(sessionId)) {
    chain.sessionIds.push(sessionId);
    _saveSessionChain(sessionKey, chain);
  }
  return chain.sessionIds;
}

/**
 * Find transcript files across ALL known session IDs for a session key.
 */
function findAllTranscriptFiles(sessionKey, currentSessionId) {
  const allIds = trackSessionId(sessionKey, currentSessionId);
  const allFiles = [];
  const seen = new Set();

  for (const sid of allIds) {
    const files = findTranscriptFiles(sid);
    for (const f of files) {
      if (!seen.has(f.name)) {
        seen.add(f.name);
        allFiles.push(f);
      }
    }
  }

  // Sort all files by modification time (oldest first)
  allFiles.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  return allFiles;
}

// ── API: GET /api/history ──
// ── API: POST /api/auth ──
// Login endpoint. Validates token via POST body (never in URL).
// Sets HttpOnly session cookie + JS-readable auth cookie.
// Returns JSON { ok: true } or { ok: false, error: "..." }
function handleAuthApi(req, res) {
  setSecurityHeaders(res);
  const ip = getClientIp(req);

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  // Check lockout BEFORE reading body
  if (loginLimiter.isLockedOut(ip)) {
    const remaining = loginLimiter.remainingLockout(ip);
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      error: "Too many failed attempts. Try again later.",
      lockout: true,
      retryAfter: remaining
    }));
    return;
  }

  // Read body
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) { req.destroy(); return; } // prevent large payloads
  });
  req.on("end", () => {
    let token, csrf;
    try {
      const parsed = JSON.parse(body);
      token = parsed.token;
      csrf = parsed.csrf;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Invalid request" }));
      return;
    }

    // Validate CSRF token
    if (!validateCsrf(csrf)) {
      console.warn(`[Security] Invalid CSRF from ${ip}`);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Invalid session. Please refresh and try again." }));
      return;
    }

    // Check rate limit (within window)
    if (!loginLimiter.recordFailure(ip)) {
      // This just records — check lockout again
      if (loginLimiter.isLockedOut(ip)) {
        const remaining = loginLimiter.remainingLockout(ip);
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          error: "Too many failed attempts. Try again later.",
          lockout: true,
          retryAfter: remaining
        }));
        return;
      }
    }

    // Validate token (timing-safe)
    if (!token || !timingSafeEqual(token, AUTH_TOKEN)) {
      console.warn(`[Security] Failed login from ${ip} at ${new Date().toISOString()}`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Invalid token." }));
      return;
    }

    // Success — set cookies
    loginLimiter.recordSuccess(ip);
    console.log(`[Security] Successful login from ${ip}`);

    const sessionCookie = `scratchy_token=${SESSION_SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
    // SECURITY RISK (C3): non-HttpOnly cookie exposes raw AUTH_TOKEN to JS. See C3 note above.
    const authCookie = `scratchy_auth=${AUTH_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": [sessionCookie, authCookie],
    });
    // Return session key for localStorage persistence (iOS PWA loses cookies on restart)
    res.end(JSON.stringify({ ok: true, sessionKey: SESSION_SECRET }));
  });
}

function handleHistoryApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let sessionKey = url.searchParams.get("session") || "agent:main:main";
  console.log(`[Scratchy] /api/history request — session=${sessionKey}`);

  // Validate session key format (prevent path traversal)
  if (!/^[a-zA-Z0-9:._-]+$/.test(sessionKey)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid session key" }));
    return;
  }

  // SECURITY: Session isolation — enforce per-user history access
  if (sessionIsolation && authSystem) {
    const isoResult = sessionIsolation.enforceHistorySession(req, authSystem);
    if (isoResult.blocked) {
      console.log(`[Scratchy] /api/history blocked by session isolation`);
      res.writeHead(403);
      res.end('{}');
      return;
    }
    sessionKey = isoResult.sessionKey;
  } else if (authSystem) {
    // Fallback: non-admin users get empty history (legacy behavior)
    const authResult = authSystem.authenticateRequest(req);
    if (authResult && authResult.user && authResult.user.role !== 'admin' && !authResult.isLegacy) {
      console.log(`[Scratchy] /api/history blocked for non-admin user: ${authResult.user.email}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessionId: 'isolated', messages: [] }));
      return;
    }
  }

  let sessionId = null;
  try {
    const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
    const entry = store[sessionKey];
    if (entry && entry.sessionId) {
      sessionId = entry.sessionId;
    }
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "failed to read session store" }));
    return;
  }

  if (!sessionId) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "session not found" }));
    return;
  }

  // Use chain-aware lookup for ALL sessions (spans across gateway session rotations)
  // Previously only operator sessions used this — but gateway rotates main session too
  const files = findAllTranscriptFiles(sessionKey, sessionId);
  const allMessages = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const { messages, compactionDate } = parseTranscript(file.path);

    if (i > 0 && (file.isArchived || file._fromPreviousSession)) {
      const dateMatch = file.name.match(/\.deleted\.(\d{4}-\d{2}-\d{2})T/);
      allMessages.push({
        role: "compaction",
        text: "older messages compacted",
        timestamp: dateMatch ? dateMatch[1] : compactionDate,
      });
    }

    allMessages.push(...messages);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  const responseJson = JSON.stringify({ sessionId, messages: allMessages });
  console.log(`[Scratchy] /api/history response — ${allMessages.length} messages, ${(responseJson.length/1024).toFixed(0)}KB`);
  res.end(responseJson);
}

// ── Static file server ──
function serveStatic(req, res) {
  const urlPath = req.url.split("?")[0];
  const relPath = urlPath === "/" ? "index.html" : urlPath;

  // Determine which directory to serve from (priority order):
  // 1. Admin preview mode (if admin has preview enabled)
  // 2. Per-user version (if user has a specific clientVersion assigned)
  // 3. Default WEB_DIR (latest/current)
  let baseDir = WEB_DIR;
  const authResult = req._authResult;

  // Admin preview mode: try PREVIEW_DIR first if enabled
  if (authResult?.user?.role === 'admin' && previewSessions.has(authResult.user?.id)) {
    const previewPath = path.normalize(path.join(PREVIEW_DIR, relPath));
    if (previewPath.startsWith(PREVIEW_DIR) && fs.existsSync(PREVIEW_DIR) && fs.existsSync(previewPath) && !fs.statSync(previewPath).isDirectory()) {
      baseDir = PREVIEW_DIR;
    }
  }

  // Per-user version routing (Phase 25): serve from versioned snapshot if assigned
  // Users without explicit version get the default stable version (NOT the dev web/ directory)
  const _isAdmin = authResult?.user?.role === 'admin' || authResult?.isLegacy;
  if (baseDir === WEB_DIR && versionStore && authResult?.user?.id) {
    const user = authSystem?.userStore?.getById(authResult.user.id);
    // Admin never gets pinned to a versioned snapshot — always sees dev web/
    let clientVersion = _isAdmin ? null : (user?.preferences?.clientVersion || null);

    // If no explicit version, non-admin users get the default stable version
    if (!clientVersion && !_isAdmin) {
      const versions = versionStore.list();
      const defaultVer = versions.find(v => v._isDefault) || versions.find(v => v.status === 'live');
      if (defaultVer) clientVersion = defaultVer.tag;
    }

    if (clientVersion) {
      const versionWebDir = versionStore.getWebDir(clientVersion);
      if (versionWebDir) {
        const versionPath = path.normalize(path.join(versionWebDir, relPath));
        if (versionPath.startsWith(versionWebDir) && fs.existsSync(versionPath) && !fs.statSync(versionPath).isDirectory()) {
          baseDir = versionWebDir;
        }
        // If file doesn't exist in version dir, fall back to WEB_DIR (graceful degradation)
      }
    }

    // ── ENFORCEMENT: Non-admin users must NEVER see dev web/ directly ──
    // If no live version exists yet, serve a maintenance page instead of raw dev files.
    // This prevents the agent from deploying to users by modifying web/ + restarting.
    if (!clientVersion && !_isAdmin && baseDir === WEB_DIR) {
      setSecurityHeaders(res);
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Updating</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.c{text-align:center;max-width:400px;padding:2rem}.s{font-size:3rem;margin-bottom:1rem}p{color:#888;line-height:1.6}</style></head>
<body><div class="c"><div class="s">🔧</div><h2>Service Update in Progress</h2><p>A new version is being prepared. Please check back shortly.</p></div></body></html>`);
      return;
    }
  }

  let filePath = path.join(baseDir, relPath);
  filePath = path.normalize(filePath);

  // Security: don't serve files outside the chosen base dir
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);

  // ETag for conditional requests (304 Not Modified)
  const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
  if ((ext === ".html" || relPath === "index.html") && req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  let content = fs.readFileSync(filePath);

  // Phase 26: Session isolation — inject per-user sessionKey into index.html
  if (sessionIsolation && authSystem && relPath === 'index.html') {
    try {
      const clientConfig = sessionIsolation.getClientSessionConfig(req, authSystem);
      if (clientConfig.sessionKey !== 'agent:main:main') {
        let html = content.toString('utf-8');
        html = html.replace('</head>', `<script>window.__SCRATCHY_SESSION_KEY="${clientConfig.sessionKey}";</script></head>`);
        content = Buffer.from(html, 'utf-8');
      }
    } catch (e) {
      console.error('[Scratchy] Session isolation config injection error:', e.message);
    }
  }

  // Cache headers — override the global "no-store" from setSecurityHeaders
  const hasVersionQuery = req.url.includes("?v=");
  if (ext === ".html" || relPath === "index.html") {
    // Always revalidate HTML — browser checks for new version on each load
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    // ETag based on final content size + mtime (after any session injection)
    res.setHeader("ETag", `"${Buffer.byteLength(content).toString(36)}-${stat.mtimeMs.toString(36)}"`);
  } else if (hasVersionQuery) {
    // Versioned assets (CSS/JS with ?v=xxx) — cache for 1 year, immutable
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    // Other static assets (images, fonts) — cache 1 hour, revalidate
    res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
  }

  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

// ── Media file server (workspace files) ──
function serveMedia(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relPath = urlPath.replace(/^\/media\//, "");

  // H6: Reject null bytes (path truncation attack)
  if (relPath.includes('\0')) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  let filePath = path.join(WORKSPACE_DIR, relPath);
  filePath = path.normalize(filePath);

  // Security: don't serve files outside workspace
  if (!filePath.startsWith(WORKSPACE_DIR + path.sep) && filePath !== WORKSPACE_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);

  // P3: Force download for user-uploaded files to prevent XSS via uploaded content
  const isUpload = filePath.startsWith(path.join(WORKSPACE_DIR, "uploads") + path.sep);
  const extraHeaders = {};
  if (isUpload) {
    extraHeaders["Content-Disposition"] = "attachment; filename=\"" + path.basename(filePath).replace(/"/g, '\\"') + "\"";
  }

  // Support range requests for video seeking
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

    // H7: Validate range values
    if (isNaN(start) || isNaN(end) || start < 0 || start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, Object.assign({
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
    }, extraHeaders));
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, Object.assign({
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
    }, extraHeaders));
    fs.createReadStream(filePath).pipe(res);
  }
}

// ── Transcription rate limiter ──
const transcribeRateLimiter = {
  requests: new Map(),
  maxPerMinute: 10,
  check(ip) {
    const now = Date.now();
    const entry = this.requests.get(ip);
    if (!entry || now > entry.resetAt) {
      this.requests.set(ip, { count: 1, resetAt: now + 60000 });
      return true;
    }
    entry.count++;
    return entry.count <= this.maxPerMinute;
  },
};

// ── API: POST /api/tts ──
// Text-to-speech via ElevenLabs. Streams audio back as mp3.
// POST body: { "text": "...", "voice": "optional-voice-id" }
function handleTtsApi(req, res) {
  // Accept both GET (for streaming audio element) and POST
  if (req.method !== "POST" && req.method !== "GET") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  // GET: text in query param (for <audio src="/api/tts?text=...">)
  if (req.method === "GET") {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const text = url.searchParams.get("text");
    const voice = url.searchParams.get("voice");
    if (!text) {
      res.writeHead(400);
      res.end("Missing text param");
      return;
    }
    return doTts(req, res, text, voice);
  }

  let body = "";
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 16384) { req.destroy(); return; }
  });
  req.on("end", () => {
    let text, voice;
    try {
      const parsed = JSON.parse(body);
      text = parsed.text;
      voice = parsed.voice;
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    doTts(req, res, text, voice);
  });
}

function doTts(req, res, text, voice) {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: "ElevenLabs API key not configured" }));
    return;
  }

  const voiceId = voice || process.env.ELEVENLABS_VOICE_ID || "SAz9YHcvj6GT2YYXdXww";

  if (!text || !text.trim()) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "No text provided" }));
    return;
  }

  // TTS quota check (multi-user mode)
  if (authSystem) {
    const authResult = authSystem.auth.authenticateRequest(req);
    if (authResult && authResult.user && !authResult.isLegacy) {
      // Estimate ~15 chars/second for speech duration
      const estimatedSeconds = Math.max(1, Math.ceil(text.length / 15));
      const isStreaming = req.headers["x-tts-mode"] === "realtime";
      const ttsType = isStreaming ? "realtime" : "normal";
      const check = authSystem.quotaStore.checkTtsAllowed(authResult.user, ttsType, estimatedSeconds);
      if (!check.allowed) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: check.reason, remainingSeconds: 0 }));
        return;
      }
      // Record usage (estimated — actual duration may differ slightly)
      authSystem.quotaStore.recordTtsUsage(authResult.user.id, estimatedSeconds, ttsType);
    }
  }

  // Cap input to avoid huge TTS bills
  const cappedText = text.length > 8000 ? text.slice(0, 8000) : text;

  // Check if message has complex content that needs LLM narration
  const needsNarration =
    /```/.test(cappedText) ||               // code blocks
    /\|.+\|.+\|/.test(cappedText) ||        // tables
    /```scratchy-ui/.test(cappedText) ||     // GenUI components
    /https?:\/\/\S+/.test(cappedText);       // URLs

  if (needsNarration) {
    // Complex content: use LLM to narrate naturally
    console.error("[TTS] Complex content detected — using LLM narration. Triggers: " +
      [/```/.test(cappedText) && "code", /\|.+\|.+\|/.test(cappedText) && "table",
       /```scratchy-ui/.test(cappedText) && "genui", /https?:\/\/\S+/.test(cappedText) && "url"]
        .filter(Boolean).join(", "));
    narrateForSpeech(cappedText, function(err, narrated) {
      if (err) {
        console.error("[TTS] Narration error:", err);
        narrated = basicCleanup(cappedText);
      }
      if (!narrated || !narrated.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "No speakable text" }));
        return;
      }
      narrated = replaceEmojis(narrated);
      if (narrated.length > 5000) narrated = narrated.slice(0, 5000);
      speakWithElevenLabs(elevenKey, voiceId, narrated, req, res);
    });
  } else {
    // Plain text: strip markdown markers and send directly to TTS
    let clean = replaceEmojis(basicCleanup(cappedText));
    console.error("[TTS] Plain text — direct to ElevenLabs (" + clean.length + " chars)");
    if (!clean) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "No speakable text" }));
      return;
    }
    if (clean.length > 5000) clean = clean.slice(0, 5000);
    speakWithElevenLabs(elevenKey, voiceId, clean, req, res);
  }
}

// Emoji/icon → spoken word map
const EMOJI_WORDS = {
  "🔊": "speaker", "🔇": "muted", "🔈": "low volume", "🔉": "medium volume",
  "🎉": "party!", "🎊": "celebration", "🥳": "party face",
  "✅": "check", "❌": "cross", "⚠️": "warning", "🚨": "alert",
  "🔧": "", "🔨": "hammer", "🛠️": "tools", "⚙️": "gear",
  "🚀": "rocket", "💡": "idea", "🔥": "fire", "💥": "boom",
  "👍": "thumbs up", "👎": "thumbs down", "👀": "eyes", "🤔": "hmm",
  "😂": "haha", "😅": "heh", "😭": "crying", "😊": "smile",
  "💀": "dead", "🙌": "hands up", "👏": "clap", "🤝": "handshake",
  "❤️": "love", "💔": "heartbreak", "💪": "strong", "🧠": "brain",
  "📝": "note", "📊": "chart", "📁": "folder", "📂": "open folder",
  "🗑️": "trash", "📌": "pin", "🔗": "link", "🔒": "locked", "🔓": "unlocked",
  "⏳": "hourglass", "⏸": "pause", "▶️": "play", "⏹️": "stop",
  "🐱": "meow", "🐛": "bug", "🦞": "lobster",
  "→": ", ", "←": ", ", "↑": "up", "↓": "down", "—": ", ",
  "•": "", "·": "",
};

function replaceEmojis(text) {
  for (const [emoji, word] of Object.entries(EMOJI_WORDS)) {
    text = text.replaceAll(emoji, word ? " " + word + " " : " ");
  }
  // Catch remaining emojis — strip silently
  text = text.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{200D}]|[\u{20E3}]|[\u{FE0F}]/gu, "");
  return text.replace(/\s{2,}/g, " ").trim();
}

// Basic markdown cleanup for plain text messages (no LLM needed)
function basicCleanup(text) {
  return text
    .replace(/#{1,6}\s*/g, "")
    .replace(/[*_~]/g, "")
    .replace(/>\s/g, "")
    .replace(/\n{2,}/g, ", ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\.+$/g, "")                  // strip trailing periods
    .replace(/\.\s*\./g, ".")              // double periods
    .trim();
}

// Use a fast LLM to convert raw markdown/technical content into natural speech
function narrateForSpeech(rawText, callback) {
  const openaiKey = loadOpenAIKey();
  if (!openaiKey) {
    // No OpenAI key — fall back to raw text
    return callback(null, rawText);
  }

  const systemPrompt = `You are a voice narration preprocessor. Convert the following assistant message into natural, spoken language — as if you're explaining it out loud to a friend.

Rules:
- Describe tables conversationally (e.g. "the table shows X has a value of Y")
- Describe code blocks briefly (e.g. "there's a bash command that restarts the service")
- Read URLs as just the domain name (e.g. "scratchy dot proteclaw dot fr")
- Convert technical notation into plain speech
- Keep the same meaning and information — don't add or remove ideas
- Keep it concise — spoken language should be shorter than written
- Don't add intro phrases like "here's what the message says"
- Output ONLY the narration text, nothing else
- Use natural speech patterns: contractions, pauses (commas), emphasis`;

  const postData = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: rawText }
    ],
    max_tokens: 1500,
    temperature: 0.3,
  });

  const options = {
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const llmReq = https.request(options, llmRes => {
    let body = "";
    llmRes.on("data", c => { body += c; });
    llmRes.on("end", () => {
      try {
        const data = JSON.parse(body);
        const narration = data.choices?.[0]?.message?.content?.trim();
        if (narration) {
          console.log("[TTS] Narrated:", narration.slice(0, 80) + "...");
          callback(null, narration);
        } else {
          callback(new Error("Empty narration response"));
        }
      } catch (e) {
        callback(e);
      }
    });
  });

  llmReq.on("error", callback);
  llmReq.setTimeout(8000, () => {
    llmReq.destroy();
    callback(new Error("Narration timeout"));
  });

  llmReq.write(postData);
  llmReq.end();
}

// Stream audio from ElevenLabs to the client
function speakWithElevenLabs(apiKey, voiceId, text, req, res) {
  const model = process.env.ELEVENLABS_MODEL || "eleven_v3";
  console.error("[TTS] Speaking with voice=" + voiceId + " model=" + model + " text=" + text.slice(0, 60) + "...");
  const postData = JSON.stringify({
    text: text,
    model_id: model,
    output_format: "mp3_44100_128",
    voice_settings: {
      stability: 0.0,
      similarity_boost: 0.8,
    },
  });

  const options = {
    hostname: "api.elevenlabs.io",
    path: `/v1/text-to-speech/${voiceId}/stream`,
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const elevenReq = https.request(options, elevenRes => {
    if (elevenRes.statusCode !== 200) {
      let errBody = "";
      elevenRes.on("data", c => { errBody += c; });
      elevenRes.on("end", () => {
        console.error("[TTS] ElevenLabs error:", elevenRes.statusCode, errBody);
        if (!res.headersSent) {
          res.writeHead(elevenRes.statusCode);
          res.end(JSON.stringify({ error: "ElevenLabs error", status: elevenRes.statusCode }));
        }
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "Accept-Ranges": "none",
    });
    elevenRes.pipe(res);
  });

  elevenReq.on("error", err => {
    console.error("[TTS] Request error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: "TTS request failed" }));
    }
  });

  elevenReq.write(postData);
  elevenReq.end();
}

// ── API: POST /api/transcribe ──
// Receives audio blob, transcribes via OpenAI Whisper, returns text.
// Max 5MB audio, rate limited.
function handleTranscribeApi(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const ip = getClientIp(req);
  if (!transcribeRateLimiter.check(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "transcription rate limit exceeded" }));
    return;
  }

  const apiKey = loadOpenAIKey();
  if (!apiKey) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "OpenAI API key not found" }));
    return;
  }

  // Accept optional language hint from query param or header
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const langHint = reqUrl.searchParams.get("lang") || req.headers["x-audio-language"] || "";

  const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5 MB
  const chunks = [];
  let totalBytes = 0;

  req.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_AUDIO_BYTES) {
      req.destroy();
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "audio too large (max 5MB)" }));
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (totalBytes > MAX_AUDIO_BYTES) return; // already responded
    if (totalBytes === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "empty audio body" }));
      return;
    }

    const audioBuffer = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "audio/webm";

    // Determine file extension from content type
    const extMap = {
      "audio/webm": ".webm",
      "audio/ogg": ".ogg",
      "audio/mp4": ".m4a",
      "audio/mpeg": ".mp3",
      "audio/wav": ".wav",
      "audio/x-m4a": ".m4a",
    };
    const mimeBase = contentType.split(";")[0].trim().toLowerCase();
    const ext = extMap[mimeBase] || ".webm";
    const fileName = `voice${ext}`;

    // Build multipart/form-data for OpenAI Whisper API
    const boundary = "----ScratchyBoundary" + crypto.randomBytes(8).toString("hex");
    const parts = [];

    // file field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeBase}\r\n\r\n`
    );
    parts.push(audioBuffer);
    parts.push("\r\n");

    // model field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n`
    );

    // response_format field — use verbose_json to get detected language back
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `verbose_json\r\n`
    );

    // language hint field (ISO-639-1) — improves accuracy when provided
    if (langHint) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${langHint}\r\n`
      );
    }

    parts.push(`--${boundary}--\r\n`);

    // Concatenate into single buffer
    const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
    const body = Buffer.concat(bodyParts);

    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/audio/transcriptions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    console.log(`[Scratchy] Transcribing ${(totalBytes / 1024).toFixed(0)}KB audio via Whisper...`);

    const apiReq = https.request(options, (apiRes) => {
      const resChunks = [];
      apiRes.on("data", (c) => resChunks.push(c));
      apiRes.on("end", () => {
        const resBody = Buffer.concat(resChunks).toString("utf-8");
        if (apiRes.statusCode !== 200) {
          console.error(`[Scratchy] Whisper API error (${apiRes.statusCode}):`, resBody.slice(0, 200));
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "transcription failed", status: apiRes.statusCode }));
          return;
        }
        try {
          const result = JSON.parse(resBody);
          const text = (result.text || "").trim();
          const detectedLang = result.language || langHint || "";
          if (!text) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ text: "", empty: true, language: detectedLang }));
            return;
          }
          console.log(`[Scratchy] Transcribed (${detectedLang || "?"}): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text, language: detectedLang }));
        } catch (e) {
          console.error("[Scratchy] Whisper response parse error:", e.message);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid transcription response" }));
        }
      });
    });

    apiReq.on("error", (err) => {
      console.error("[Scratchy] Whisper API request error:", err.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "transcription request failed" }));
    });

    apiReq.write(body);
    apiReq.end();
  });
}

// ── API: POST /api/send ──
// Sends a chat message with optional image attachments via the gateway.
// Images are uploaded via HTTP (handles large files through Cloudflare)
// then relayed to the gateway over localhost WebSocket (no size limit).
//
// Expects multipart/form-data with:
//   - "message" field (text, optional if images present)
//   - "image" field(s) (file uploads, max 10MB each, max 5 files)
//   - "sessionKey" field (optional, defaults to "agent:main:main")
function handleSendApi(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected multipart/form-data" }));
    return;
  }

  const MAX_BODY = 50 * 1024 * 1024; // 50MB total
  const chunks = [];
  let totalBytes = 0;

  req.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY) {
      req.destroy();
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request too large" }));
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (totalBytes > MAX_BODY) return;
    const body = Buffer.concat(chunks);

    // Parse multipart form data
    const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
    if (!boundaryMatch) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no boundary in content-type" }));
      return;
    }
    const boundary = boundaryMatch[1].replace(/^["']|["']$/g, "");

    let message = "";
    let sessionKey = "agent:main:main";
    const attachments = []; // { type, mimeType, content }

    try {
      const parts = parseMultipart(body, boundary);
      for (const part of parts) {
        if (part.name === "message") {
          message = part.data.toString("utf-8");
        } else if (part.name === "sessionKey") {
          sessionKey = part.data.toString("utf-8");
        } else if (part.name === "image" || part.name === "file") {
          if (attachments.length >= 5) continue;
          if (part.data.length > 10 * 1024 * 1024) continue; // 10MB per file
          const mimeType = part.contentType || "application/octet-stream";
          const filename = part.filename || "";

          // Validate file type
          if (!isFileAllowed(filename, mimeType)) {
            console.warn(`[Scratchy] Blocked file: ${filename} (${mimeType})`);
            continue;
          }

          const mimeBase = mimeType.split(";")[0].trim().toLowerCase();

          // For text-based files: read content and include as text
          if (isTextMime(mimeType)) {
            const textContent = part.data.toString("utf-8");
            const ext = getExtFromFilename(filename);
            const label = filename || ("file" + ext);
            // Append file content to message text
            message = (message ? message + "\n\n" : "") +
              `📎 File: ${label}\n\`\`\`\n${textContent}\n\`\`\``;
          } else if (mimeBase.startsWith("image/")) {
            // Images: send as image attachment
            attachments.push({
              type: "image",
              mimeType: mimeBase,
              content: part.data.toString("base64"),
            });
          } else {
            // Binary files (PDF, zip, etc.): save to disk, reference in message.
            // The agent reads the file directly with its tools (full fidelity).
            // This avoids gateway WS frame limits (code 1009 for >1MB).
            // TODO: When gateway supports larger frames or REST API, switch to
            //       sending attachments directly (option 2/3).
            const label = filename || "file";
            const safeName = label.replace(/[^a-zA-Z0-9._-]/g, "_");
            const uploadDir = path.join(os.homedir(), ".openclaw", "workspace", "uploads");
            try { fs.mkdirSync(uploadDir, { recursive: true }); } catch {}
            const uploadPath = path.join(uploadDir, Date.now() + "-" + safeName);
            fs.writeFileSync(uploadPath, part.data);
            const sizeKB = (part.data.length / 1024).toFixed(0);
            message = (message ? message + "\n\n" : "") +
              `📎 Attached file: ${label} (${sizeKB}KB, ${mimeBase})\nSaved to: ${uploadPath}\nPlease read and analyze this file.`;
            console.log(`[Scratchy] Saved upload: ${uploadPath} (${sizeKB}KB, ${mimeBase})`);
          }
        }
      }
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "failed to parse multipart: " + e.message }));
      return;
    }

    if (!message.trim() && attachments.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "message or file required" }));
      return;
    }

    // Phase 26: Session isolation — rewrite sessionKey for non-admin users
    if (sessionIsolation && authSystem) {
      sessionKey = sessionIsolation.enforceSendSession(sessionKey, req, authSystem);
    }

    const totalB64KB = attachments.reduce((sum, att) => sum + (att.content ? att.content.length : 0), 0) / 1024;
    console.log(`[Scratchy] /api/send — text: ${message.length} chars, attachments: ${attachments.length} (~${totalB64KB.toFixed(0)}KB b64), session: ${sessionKey}`);

    // Send to gateway via localhost WebSocket
    sendToGateway(sessionKey, message, attachments, (err, result) => {
      if (err) {
        console.error("[Scratchy] Gateway send error:", err);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gateway error: " + err }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, runId: result?.runId }));
      }
    });
  });
}

// Simple multipart parser
function parseMultipart(body, boundary) {
  const parts = [];
  const sep = Buffer.from("--" + boundary);
  const end = Buffer.from("--" + boundary + "--");

  let pos = 0;
  // Find first boundary
  pos = bufferIndexOf(body, sep, pos);
  if (pos < 0) return parts;
  pos += sep.length;
  // Skip CRLF after boundary
  if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;

  while (pos < body.length) {
    // Check for end boundary
    const nextBound = bufferIndexOf(body, sep, pos);
    if (nextBound < 0) break;

    // Parse headers until double CRLF
    const headerEnd = bufferIndexOf(body, Buffer.from("\r\n\r\n"), pos);
    if (headerEnd < 0 || headerEnd > nextBound) break;

    const headerStr = body.slice(pos, headerEnd).toString("utf-8");
    const dataStart = headerEnd + 4;
    // Data ends 2 bytes before next boundary (CRLF before boundary)
    const dataEnd = nextBound - 2;
    const data = body.slice(dataStart, dataEnd > dataStart ? dataEnd : dataStart);

    // Parse part headers
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: ctMatch ? ctMatch[1].trim() : null,
      data: data,
    });

    pos = nextBound + sep.length;
    // Check if this is the end boundary
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // "--"
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
  }

  return parts;
}

function bufferIndexOf(buf, search, fromIndex) {
  for (let i = fromIndex || 0; i <= buf.length - search.length; i++) {
    let match = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

// Send message to gateway via the existing session's gateway WebSocket.
// This avoids origin-check failures that occur when opening a new WS.
function sendToGateway(sessionKey, message, attachments, callback) {
  // Find an active session with a ready gateway WS
  let session = null;
  for (const [, s] of wsSessions) {
    if (s.gatewayWs && s.gatewayWs.readyState === 1 && s._gwReady) {
      session = s;
      break;
    }
  }

  if (!session) {
    console.error("[Scratchy] sendToGateway: no active gateway WS session found");
    callback("no active gateway connection — please reload the page");
    return;
  }

  const reqId = "upload-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
  const sendFrame = {
    type: "req",
    id: reqId,
    method: "chat.send",
    params: {
      sessionKey: sessionKey,
      message: message || "",
      idempotencyKey: reqId,
      attachments: attachments.length > 0 ? attachments : undefined,
    },
  };

  let done = false;
  const timeout = setTimeout(() => {
    if (!done) {
      done = true;
      delete session._uploadCallbacks[reqId];
      callback("timeout");
    }
  }, 30000);

  // Register a one-shot callback for the response
  if (!session._uploadCallbacks) session._uploadCallbacks = {};
  session._uploadCallbacks[reqId] = (frame) => {
    done = true;
    clearTimeout(timeout);
    delete session._uploadCallbacks[reqId];
    if (frame.ok) {
      callback(null, frame.payload);
    } else {
      callback("send failed: " + JSON.stringify(frame.error));
    }
  };

  try {
    console.log(`[Scratchy] sendToGateway: relaying via existing session WS (reqId=${reqId})`);
    session.gatewayWs.send(JSON.stringify(sendFrame));
  } catch (e) {
    done = true;
    clearTimeout(timeout);
    delete session._uploadCallbacks[reqId];
    callback("WS send error: " + e.message);
  }
}

// ── Search rate limiter ──
const searchRateLimiter = {
  requests: new Map(),
  maxPerMinute: 20,
  check(ip) {
    const now = Date.now();
    const entry = this.requests.get(ip);
    if (!entry || now > entry.resetAt) {
      this.requests.set(ip, { count: 1, resetAt: now + 60000 });
      return true;
    }
    entry.count++;
    return entry.count <= this.maxPerMinute;
  },
};

// Generate a friendly name for a session
function friendlySessionLabel(key, entry) {
  const channel = entry.lastChannel || (entry.origin && entry.origin.provider) || "";

  // Main sessions
  if (key === "agent:main:main") return "Main Chat";
  if (key === "main") return "Main (legacy)";

  // Channel-specific sessions — extract group/channel info if available
  if (key.startsWith("agent:main:whatsapp:")) {
    const suffix = key.split("agent:main:whatsapp:")[1] || "";
    if (suffix.startsWith("group:")) return "WhatsApp Group";
    return "WhatsApp";
  }
  if (key.startsWith("agent:main:telegram:")) {
    const suffix = key.split("agent:main:telegram:")[1] || "";
    if (suffix.startsWith("group:")) return "Telegram Group";
    return "Telegram";
  }
  if (key.startsWith("agent:main:discord:")) {
    const suffix = key.split("agent:main:discord:")[1] || "";
    if (suffix.startsWith("channel:")) return "Discord Channel";
    return "Discord";
  }
  if (key.startsWith("agent:main:signal:")) return "Signal";
  if (key.startsWith("agent:main:slack:")) return "Slack";
  if (key.startsWith("agent:main:webchat:")) return "Webchat";

  // Sub-agents: use the label if available (set by sessions_spawn)
  if (key.includes(":subagent:")) {
    if (entry.label) return entry.label;
    const uuid = key.split(":subagent:")[1] || "";
    return "Sub-agent " + uuid.slice(0, 6);
  }

  // Cron jobs
  if (key.includes(":cron:")) {
    if (entry.label) return entry.label;
    const uuid = key.split(":cron:")[1] || "";
    return "Cron " + uuid.slice(0, 6);
  }

  // Heartbeat
  if (key.includes("heartbeat")) return "Heartbeat";

  // Fallback: channel name or last part of key
  if (channel && channel !== "unknown") {
    return channel.charAt(0).toUpperCase() + channel.slice(1);
  }

  const parts = key.split(":");
  const last = parts[parts.length - 1] || key;
  if (/^[0-9a-f]{8}-/.test(last)) return "Session " + last.slice(0, 6);
  return last.charAt(0).toUpperCase() + last.slice(1);
}

// Categorize a session: "conversation" | "background" | "archived" | "hidden"
function categorizeSession(key, entry, lastActivity) {
  const isSubagent = key.includes(":subagent:");
  const isCron = key.includes(":cron:");
  const isHeartbeat = key.includes("heartbeat");
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  // Legacy "main" key — always hide, it's a duplicate of agent:main:main
  if (key === "main") return "hidden";

  // Background: sub-agents, cron, heartbeat
  if (isSubagent || isCron || isHeartbeat) {
    if (lastActivity < sevenDaysAgo) return "archived";
    return "background";
  }

  // Channel conversations inactive > 30 days → archived
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  if (key !== "agent:main:main" && lastActivity < thirtyDaysAgo) return "archived";

  return "conversation";
}

// Get the icon for a session based on its key
function sessionIcon(key, entry) {
  if (key === "agent:main:main") return "💬";
  if (key === "main") return "💬";
  if (key.startsWith("agent:main:whatsapp:")) return "📱";
  if (key.startsWith("agent:main:telegram:")) return "✈️";
  if (key.startsWith("agent:main:discord:")) return "🎮";
  if (key.startsWith("agent:main:signal:")) return "🔒";
  if (key.startsWith("agent:main:slack:")) return "💼";
  if (key.startsWith("agent:main:webchat:")) return "🌐";
  if (key.includes(":subagent:")) return "🤖";
  if (key.includes(":cron:")) return "⏰";
  if (key.includes("heartbeat")) return "💓";
  return "💬";
}

// Read last message from a JSONL transcript (reads from end of file)
function getLastMessagePreview(sessionId, maxChars) {
  maxChars = maxChars || 60;
  if (!sessionId) return "";
  try {
    const sessionFile = path.join(SESSIONS_DIR, sessionId + ".jsonl");
    if (!fs.existsSync(sessionFile)) return "";

    // Read last 4KB of file to find the last message
    const stat = fs.statSync(sessionFile);
    const readSize = Math.min(stat.size, 4096);
    const fd = fs.openSync(sessionFile, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    // Walk backwards to find last user or assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.role === "assistant" || entry.role === "user") {
          let text = "";
          if (entry.content && Array.isArray(entry.content)) {
            text = entry.content
              .filter(b => b.type === "text" && b.text)
              .map(b => b.text)
              .join(" ");
          } else if (typeof entry.content === "string") {
            text = entry.content;
          }
          if (!text) continue;
          // Clean up and truncate
          text = text.replace(/\s+/g, " ").trim();
          if (text.length > maxChars) text = text.slice(0, maxChars) + "…";
          return text;
        }
      } catch { continue; }
    }
  } catch { /* skip */ }
  return "";
}

// Format token count: 1234 → "1.2K", 123456 → "123K"
function formatTokens(tokens) {
  if (!tokens || tokens < 100) return "";
  if (tokens < 1000) return tokens + "";
  if (tokens < 100000) return (tokens / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return Math.round(tokens / 1000) + "K";
}

// ── API: GET /api/workspace-file ──
// Serves .md files from the OpenClaw workspace (read-only)
function handleWorkspaceFileApi(req, res, url) {
  setSecurityHeaders(res);
  if (!isAuthenticated(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }

  const WORKSPACE_ROOT = path.join(os.homedir(), '.openclaw', 'workspace');
  const MAX_FILE_SIZE = 100 * 1024; // 100KB

  const filePath = url.searchParams.get('path');
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing path parameter' }));
    return;
  }

  // Security: reject path traversal
  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  // Only allow .md files
  if (!filePath.endsWith('.md')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Only .md files are allowed' }));
    return;
  }

  const resolved = path.resolve(WORKSPACE_ROOT, filePath);
  // Double-check resolved path is still inside workspace
  if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) && resolved !== WORKSPACE_ROOT) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not a file' }));
      return;
    }
    if (stat.size > MAX_FILE_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File too large (max 100KB)' }));
      return;
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content, path: filePath }));
  } catch(e) {
    if (e.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

// ── API: GET/POST /api/workspace ──
function handleWorkspaceApi(req, res) {
  setSecurityHeaders(res);
  if (!isAuthenticated(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
  const userInfo = getUserFromRequest(req);
  const userId = userInfo?.user?.id || '_legacy';

  if (req.method === 'GET') {
    try {
      const data = readWidgetState(userId, 'workspace-state.json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || { pins: {}, layout: { columns: 0, mode: 'auto' }, history: [], version: 0 }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pins: {}, layout: { columns: 0, mode: 'auto' }, history: [], version: 0 }));
    }
  } else if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        writeWidgetState(userId, 'workspace-state.json', data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(405);
    res.end('Method Not Allowed');
  }
}

// ── API: GET /api/canvas-history ──
function handleCanvasHistoryApi(req, res) {
  setSecurityHeaders(res);
  if (!isAuthenticated(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  // Return without full component data (just metadata)
  const list = _canvasHistory.map(h => ({ ts: h.ts, title: h.title, count: h.count }));
  res.end(JSON.stringify({ history: list }));
}

// ── API: POST /api/canvas-history/restore ──
function handleCanvasRestoreApi(req, res) {
  setSecurityHeaders(res);
  if (!isAuthenticated(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end('Method not allowed'); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { index } = JSON.parse(body);
      if (typeof index !== 'number' || !_canvasHistory[index]) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid index' })); return;
      }
      const entry = _canvasHistory[index];
      // Snapshot current before restoring
      _snapshotCanvasToHistory();
      // Clear and restore
      _serverCanvasState.clear();
      const ops = [{ op: 'clear' }];
      for (const comp of entry.components) {
        _serverCanvasState.set(comp.id, { ...comp });
        ops.push(comp);
      }
      _persistCanvasState();
      // Broadcast to all connected clients
      for (const [, s] of wsSessions) {
        if (s.clientWs && s.clientWs.readyState === 1) {
          try {
            s.clientWs.send(JSON.stringify({
              type: "event", event: "canvas-update",
              payload: { ops }
            }));
          } catch(e) {}
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, restored: entry.title, count: entry.count }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── API: GET /api/context ──
function handleContextApi(req, res) {
  setSecurityHeaders(res);
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  try {
    const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
    const session = store["agent:main:main"];
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session not found" }));
      return;
    }
    const contextWindow = session.contextTokens || 800000;
    const totalTokens = session.totalTokens || 0;
    const pct = contextWindow > 0 ? Math.min(100, Math.round((totalTokens / contextWindow) * 100)) : 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      totalTokens,
      contextWindow,
      inputTokens: session.inputTokens || 0,
      outputTokens: session.outputTokens || 0,
      compactionCount: session.compactionCount || 0,
      pct
    }));
  } catch(e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── API: GET /api/sessions ──
function handleSessionsApi(req, res) {
  setSecurityHeaders(res);
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "failed to read sessions" }));
    return;
  }

  // Scope sessions to current user (non-admin users only see their own)
  const authResult = authSystem ? authSystem.auth.authenticateRequest(req) : null;
  const userRole = authResult?.user?.role || 'admin';
  const userId = authResult?.user?.id;

  const sessions = [];
  for (const [key, entry] of Object.entries(store)) {
    // Security (H3): wrap per-session logic in try/catch to prevent TOCTOU crashes
    // (e.g., file deleted between existsSync and statSync)
    try {
      // Non-admin: only show sessions belonging to this user
      if (userRole !== 'admin' && userId) {
        const userPrefix = `main:webchat:${userId}`;
        // Also match webchat:{userId} pattern (gateway creates these)
        const gwPrefix = `webchat:${userId}`;
        if (!key.startsWith(userPrefix) && !key.startsWith(gwPrefix) && !key.includes(userId)) {
          continue; // Skip sessions that don't belong to this user
        }
      }

      const label = friendlySessionLabel(key, entry);
      const icon = sessionIcon(key, entry);

      // Approximate message count from file size
      let messageCount = 0;
      let lastActivity = entry.updatedAt || 0;
      if (entry.sessionId) {
        try {
          const sessionFile = path.join(SESSIONS_DIR, entry.sessionId + ".jsonl");
          if (fs.existsSync(sessionFile)) {
            const stat = fs.statSync(sessionFile);
            messageCount = Math.max(1, Math.round(stat.size / 500));
            if (stat.mtimeMs > lastActivity) lastActivity = stat.mtimeMs;
          }
        } catch { /* skip */ }
      }

      const totalTokens = entry.totalTokens || 0;
      const category = categorizeSession(key, entry, lastActivity);

      // Skip hidden sessions (legacy duplicates)
      if (category === "hidden") continue;

      // Skip empty background sessions (noise)
      if (category === "background" && totalTokens < 500 && messageCount < 2) continue;

      const lastMessage = getLastMessagePreview(entry.sessionId, 60);

      sessions.push({
        sessionKey: key,
        label: label,
        icon: icon,
        category: category,
        lastActivity: lastActivity,
        messageCount: messageCount,
        totalTokens: totalTokens,
        formattedTokens: formatTokens(totalTokens),
        chatType: entry.chatType || "unknown",
        channel: entry.lastChannel || (entry.origin && entry.origin.provider) || "unknown",
        spawnedBy: entry.spawnedBy || null,
        lastMessage: lastMessage,
      });
    } catch (e) {
      console.error("[Scratchy] Error processing session", key, e.message);
      continue;
    }
  }

  // Sort by last activity, newest first
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessions }));
}

// ── API: GET /api/search ──
// ─── Attachment download/preview API ───
function handleAttachmentApi(req, res) {
  setSecurityHeaders(res);
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const messageId = url.searchParams.get("messageId");
  const attachmentId = url.searchParams.get("attachmentId");
  const filename = url.searchParams.get("filename") || "attachment";
  const mimeType = url.searchParams.get("mimeType") || "application/octet-stream";
  const mode = url.searchParams.get("mode") || "download"; // "download" or "inline"

  if (!messageId || !attachmentId) {
    res.writeHead(400, {"Content-Type":"application/json"});
    res.end(JSON.stringify({error:"Missing messageId or attachmentId"}));
    return;
  }

  try {
    const fs = require('fs');
    const sessPath = require('path').join(__dirname, '.gcal-session.json');
    const credsPath = require('path').join(__dirname, '.gcal-creds.json');
    if (!fs.existsSync(sessPath) || !fs.existsSync(credsPath)) {
      res.writeHead(401, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error:"Not authenticated"}));
      return;
    }
    const sess = JSON.parse(fs.readFileSync(sessPath, 'utf8'));
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
    oauth2Client.setCredentials(sess.tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    gmail.users.messages.attachments.get({
      userId: 'me', messageId, id: attachmentId
    }).then(attRes => {
      const data = Buffer.from(attRes.data.data, 'base64url');
      const disposition = mode === "inline" ? "inline" : `attachment; filename="${filename.replace(/"/g, '\\"')}"`;
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Disposition": disposition,
        "Content-Length": data.length,
        "Cache-Control": "private, max-age=3600"
      });
      res.end(data);
    }).catch(err => {
      console.error('[Scratchy] Attachment fetch error:', err.message);
      res.writeHead(500, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error: err.message}));
    });
  } catch(e) {
    console.error('[Scratchy] Attachment API error:', e.message);
    res.writeHead(500, {"Content-Type":"application/json"});
    res.end(JSON.stringify({error: e.message}));
  }
}

function handleSearchApi(req, res) {
  setSecurityHeaders(res);
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const ip = getClientIp(req);
  if (!searchRateLimiter.check(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "search rate limit exceeded" }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const query = (url.searchParams.get("q") || "").trim();
  let sessionFilter = url.searchParams.get("session") || "all";

  // Phase 26: Session isolation — enforce per-user search scope
  if (sessionIsolation && authSystem) {
    const isoResult = sessionIsolation.enforceSearchSession(req, authSystem);
    if (isoResult.blocked) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "access denied" }));
      return;
    }
    sessionFilter = isoResult.sessionFilter;
  }

  if (query.length < 2) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "query too short (min 2 chars)" }));
    return;
  }
  if (query.length > 200) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "query too long (max 200 chars)" }));
    return;
  }

  // Escape regex special chars to prevent ReDoS
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let regex;
  try {
    regex = new RegExp(escaped, "i");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid search term" }));
    return;
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "failed to read sessions" }));
    return;
  }

  // Validate session filter
  if (sessionFilter !== "all" && !/^[a-zA-Z0-9:._-]+$/.test(sessionFilter)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid session key" }));
    return;
  }

  const results = [];
  const MAX_RESULTS = 50;
  const MAX_TEXT_LEN = 200;

  const sessionsToSearch = sessionFilter === "all"
    ? Object.entries(store)
    : Object.entries(store).filter(([k]) => k === sessionFilter);

  for (const [sessionKey, entry] of sessionsToSearch) {
    if (results.length >= MAX_RESULTS) break;
    if (!entry.sessionId) continue;

    // Use chain-aware lookup for ALL sessions (spans gateway session rotations)
    let files = findAllTranscriptFiles(sessionKey, entry.sessionId);
    // P2: Limit search scope to prevent event loop blocking
    var MAX_SEARCH_FILES = 50;
    if (files.length > MAX_SEARCH_FILES) {
      files = files.slice(-MAX_SEARCH_FILES); // Only search most recent
    }
    for (const file of files) {
      if (results.length >= MAX_RESULTS) break;
      try {
        const { messages } = parseTranscript(file.path);
        for (const msg of messages) {
          if (results.length >= MAX_RESULTS) break;
          if (regex.test(msg.text)) {
            results.push({
              sessionKey: sessionKey,
              role: msg.role,
              text: msg.text.length > MAX_TEXT_LEN ? msg.text.slice(0, MAX_TEXT_LEN) + "..." : msg.text,
              timestamp: msg.timestamp || null,
            });
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ results, query }));
}

// ── File upload constants ──
const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg", "image/png", "image/gif", "image/webp",
  // Documents
  "application/pdf", "text/plain", "text/markdown", "text/csv",
  // Code
  "text/x-python", "text/javascript", "application/json",
  "text/x-rust", "text/yaml", "text/xml",
  // Archives
  "application/zip",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".pdf", ".txt", ".md", ".csv",
  ".py", ".json", ".rs", ".yaml", ".yml", ".xml",
  ".zip",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".sh", ".bat", ".cmd", ".ps1", ".dll", ".so",
  ".dmg", ".app", ".msi", ".com", ".scr", ".pif",
]);

const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv",
  "text/x-python", "text/javascript", "application/json",
  "text/x-rust", "text/yaml", "text/xml",
]);

function getExtFromFilename(filename) {
  if (!filename) return "";
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "";
  return filename.slice(idx).toLowerCase();
}

function isFileAllowed(filename, contentType) {
  const ext = getExtFromFilename(filename);
  // Block executables by extension regardless
  if (BLOCKED_EXTENSIONS.has(ext)) return false;
  // Check extension allowlist
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  // Check MIME type allowlist (if provided)
  if (contentType) {
    const mimeBase = contentType.split(";")[0].trim().toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mimeBase)) return false;
  }
  return true;
}

function isTextMime(contentType) {
  if (!contentType) return false;
  const mimeBase = contentType.split(";")[0].trim().toLowerCase();
  return TEXT_MIME_TYPES.has(mimeBase);
}

// ── Server ──
const server = http.createServer((req, res) => {
  setSecurityHeaders(res);

  // Rate limiting
  const ip = getClientIp(req);
  if (!rateLimiter.check(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "too many requests" }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Phase 19: Multi-user auth routes (register + login are public, rest need auth)
  if (url.pathname.startsWith("/api/v2/")) {
    if (authRoutes) {
      const handled = authRoutes.handleAuthRoute(req, res, url);
      if (handled) return;
    }
    if (webauthnRoutes) {
      const handled = webauthnRoutes.handleWebAuthnRoute(req, res, url);
      if (handled) return;
    }
  }

  // Phase 19: Plan choice endpoint (save user's AI plan preference)
  if (url.pathname === "/api/v2/auth/plan" && req.method === "POST") {
    setSecurityHeaders(res);
    if (!authSystem) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Multi-user auth not enabled" }));
      return;
    }
    // Authenticate
    const authResult = authSystem.auth.authenticateRequest(req);
    if (!authResult || !authResult.user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not authenticated" }));
      return;
    }
    // Parse body
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { plan } = JSON.parse(body);
        if (plan !== "own-key" && plan !== "hosted") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid plan. Use 'own-key' or 'hosted'." }));
          return;
        }
        const user = authSystem.userStore.getById(authResult.user.id);
        const prefs = user.preferences || {};
        prefs.plan = plan;
        authSystem.userStore.updateUser(authResult.user.id, { preferences: prefs });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, plan }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request body" }));
      }
    });
    return;
  }

  // Phase 19: Provider key — validate + save encrypted API key
  if (url.pathname === "/api/v2/auth/provider-key" && (req.method === "POST" || req.method === "GET" || req.method === "DELETE")) {
    setSecurityHeaders(res);
    if (!authSystem || !providerStore) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Provider store not available" }));
      return;
    }
    const authResult = authSystem.auth.authenticateRequest(req);
    if (!authResult || !authResult.user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not authenticated" }));
      return;
    }

    // GET — check if user has a key (never returns the actual key)
    if (req.method === "GET") {
      const info = providerStore.getInfo(authResult.user.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(info || { hasKey: false }));
      return;
    }

    // DELETE — remove user's provider key
    if (req.method === "DELETE") {
      providerStore.remove(authResult.user.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST — validate and save
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { provider, apiKey } = JSON.parse(body);
        if (!provider || !apiKey) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing provider or apiKey" }));
          return;
        }

        // Validate the key
        const result = await providerStore.validate(provider, apiKey);
        if (!result.valid) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, valid: false, error: result.error }));
          return;
        }

        // Save encrypted
        providerStore.save(authResult.user.id, provider, apiKey);

        // Also update user preferences
        const user = authSystem.userStore.getById(authResult.user.id);
        const prefs = user.preferences || {};
        prefs.plan = "own-key";
        prefs.provider = provider;
        authSystem.userStore.updateUser(authResult.user.id, { preferences: prefs });

        console.log(`[Scratchy] ✅ Provider key saved for user=${authResult.user.email} provider=${provider}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, valid: true, provider }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request body" }));
      }
    });
    return;
  }

  // Phase 19: Save language preference (pre-auth, stored in user prefs after login)
  if (url.pathname === "/api/v2/auth/language" && req.method === "POST") {
    setSecurityHeaders(res);
    if (!authSystem) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Multi-user auth not enabled" }));
      return;
    }
    const authResult = authSystem.auth.authenticateRequest(req);
    if (!authResult || !authResult.user) {
      // Pre-auth: just acknowledge (language saved in localStorage)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, note: "Saved locally, will sync after login" }));
      return;
    }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { language } = JSON.parse(body);
        if (!["en", "fr", "ar", "it"].includes(language)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid language" }));
          return;
        }
        const user = authSystem.userStore.getById(authResult.user.id);
        const prefs = user.preferences || {};
        prefs.language = language;
        authSystem.userStore.updateUser(authResult.user.id, { preferences: prefs });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, language }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request body" }));
      }
    });
    return;
  }

  // Build version endpoint — no auth required
  if (url.pathname === "/api/version") {
    setSecurityHeaders(res);

    // ── Authenticate the request to know who's asking ──
    // This endpoint is pre-auth, so we must explicitly authenticate here.
    let vAuthResult = null;
    if (authSystem) {
      try { vAuthResult = authSystem.auth.authenticateRequest(req); } catch (_e) {}
    }

    let userVersion = BUILD_VERSION;
    let userHash = BUILD_HASH;
    const isAdmin = vAuthResult?.user?.role === 'admin' || vAuthResult?.isLegacy;
    const vUserId = vAuthResult?.user?.id || null;

    if (versionStore && vUserId) {
      const vUser = authSystem?.userStore?.getById(vUserId);
      const cv = vUser?.preferences?.clientVersion || null;
      const effectiveVersion = (isAdmin ? null : cv) || (() => {
        if (isAdmin) return null; // Admin always sees dev version (BUILD_VERSION)
        const versions = versionStore.list();
        const def = versions.find(v => v._isDefault) || versions.find(v => v.status === 'live');
        return def ? def.tag : null;
      })();
      if (effectiveVersion) {
        // Read version tag from the versioned index.html
        const vWebDir = versionStore.getWebDir(effectiveVersion);
        if (vWebDir) {
          try {
            const vHtml = fs.readFileSync(path.join(vWebDir, 'index.html'), 'utf8');
            const vm = vHtml.match(/\?v=([0-9a-z]+)/);
            if (vm) userVersion = vm[1];
            userHash = effectiveVersion; // Use version tag as hash for comparison
          } catch(e) {}
        }
      }
    } else if (!isAdmin) {
      // Unauthenticated or non-admin without version store — return a stable
      // fallback so dev cache bumps and restarts don't trigger update toasts.
      // Use the default/live version from the store if available.
      if (versionStore) {
        const versions = versionStore.list();
        const def = versions.find(v => v._isDefault) || versions.find(v => v.status === 'live');
        if (def) {
          const vWebDir = versionStore.getWebDir(def.tag);
          if (vWebDir) {
            try {
              const vHtml = fs.readFileSync(path.join(vWebDir, 'index.html'), 'utf8');
              const vm = vHtml.match(/\?v=([0-9a-z]+)/);
              if (vm) userVersion = vm[1];
              userHash = def.tag;
            } catch(e) {}
          }
        }
      }
    }
    // Admin (or no version store) falls through to BUILD_VERSION + BUILD_HASH

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hash: userHash, version: userVersion, timestamp: BUILD_TIMESTAMP }));
    return;
  }

  // Phase 25: Stage a new version (POST, admin auth required via token header)
  if (url.pathname === "/api/deploy/stage" && req.method === "POST") {
    setSecurityHeaders(res);
    // Authenticate: require gateway token in Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
    if (!versionStore) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Version store not initialized" }));
      return;
    }
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { description, tag } = JSON.parse(body || "{}");
        const version = versionStore.stage({ description: description || "Staged via API", tag });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Phase 25: List versions (GET, admin auth required)
  if (url.pathname === "/api/deploy/versions" && req.method === "GET") {
    setSecurityHeaders(res);
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
    if (!versionStore) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Version store not initialized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, versions: versionStore.list() }));
    return;
  }

  // Phase 19: Bootstrap check endpoint (login page checks if admin exists)
  if (url.pathname === "/api/v2/auth/status" && req.method === "GET") {
    setSecurityHeaders(res);
    const hasAdmin = authSystem ? authSystem.userStore.hasAdmin() : true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasAdmin, multiUser: !!authSystem }));
    return;
  }

  // /api/auth is the ONLY endpoint that doesn't require auth (it IS the auth)
  // /js/login.js must also be accessible for the login page to work
  if (url.pathname === "/api/auth") {
    handleAuthApi(req, res);
    return;
  }
  if (url.pathname === "/js/login.js" || url.pathname === "/js/login-v2.js" || url.pathname === "/js/i18n.js") {
    serveStatic(req, res);
    return;
  }

  // Session restoration (iOS PWA cookie loss workaround)
  if (url.pathname === "/api/restore-session" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (data.sessionKey && timingSafeEqual(data.sessionKey, SESSION_SECRET)) {
          // Valid session — re-set cookies
          const sessionCookie = `scratchy_token=${SESSION_SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
          const authCookie = `scratchy_auth=${AUTH_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
          setSecurityHeaders(res);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": [sessionCookie, authCookie],
          });
          res.end(JSON.stringify({ ok: true }));
          console.log(`[Security] Session restored via localStorage fallback`);
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // Logout — clears HttpOnly auth cookies server-side
  if (url.pathname === "/api/logout" && req.method === "POST") {
    setSecurityHeaders(res);
    const clearSession = `scratchy_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    const clearAuth = `scratchy_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": [clearSession, clearAuth],
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Google OAuth callback — must be BEFORE auth check (user arrives from Google with no session cookie)
  if (url.pathname === "/auth/google/callback") {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing authorization code');
      return;
    }
    const calModPath = require.resolve('./genui-engine/templates/calendar.js');
    delete require.cache[calModPath];
    const GoogleCalendarWidget = require('./genui-engine/templates/calendar.js');
    // Try to resolve user from cookies for per-user session storage
    const _oauthAuthResult = authSystem ? authSystem.auth.authenticateRequest(req) : null;
    const _oauthUserId = _oauthAuthResult?.user?.id || '_legacy';
    const tempWidget = new GoogleCalendarWidget(_oauthUserId);
    if (!tempWidget.creds) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('No Google OAuth credentials configured. Set up via the Calendar widget first.');
      return;
    }
    const oauthState = url.searchParams.get('state') || '';
    const isOnboarding = oauthState === 'onboarding';
    const isOnboardingGemini = oauthState === 'onboarding-gemini';
    tempWidget.exchangeCode(code).then(() => {
      // Set auth cookies directly and serve inline success page
      const sessionCookie = `scratchy_token=${SESSION_SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
      const authCookie = `scratchy_auth=${AUTH_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
      const postAuthWidget = isOnboardingGemini ? 'onboard-plan-oauth-google-check' : isOnboarding ? 'onboard-google-check' : 'cal-month';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': [sessionCookie, authCookie]
      });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0a0a0f;color:#e4e4e7;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{text-align:center;padding:40px;border-radius:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);}
h1{font-size:1.5rem;margin:0 0 8px;}p{color:#aaa;margin:0 0 16px;}
.spinner{width:24px;height:24px;border:3px solid rgba(124,58,237,0.2);border-top-color:#7c3aed;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto;}
@keyframes spin{to{transform:rotate(360deg);}}</style>
</head><body><div class="card"><h1>✅ Connected!</h1><p>Google Calendar + Gmail authorized</p><div class="spinner"></div><p style="font-size:0.8rem;margin-top:12px;">Redirecting to Scratchy...</p></div>
<script>localStorage.setItem("scratchy-post-auth-widget","${postAuthWidget}");setTimeout(function(){window.location.href="/";},1500);</script></body></html>`);
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('OAuth error: ' + e.message);
    });
    return;
  }

  // Block direct access to login.html when authenticated (no reason to see it)
  if (url.pathname === "/login.html" && isAuthenticated(req)) {
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  // Allow manifest.json without auth (needed for PWA install)
  if (url.pathname === "/manifest.json") {
    serveStatic(req, res);
    return;
  }

  // Auth check
  if (!isAuthenticated(req)) {
    sendUnauthorized(req, res);
    return;
  }

  // Trial expiry check — serve landing page for expired non-admin users
  if (req._authResult?.trialExpired) {
    // Allow API endpoints to return JSON errors (not HTML page)
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "trial_expired", message: "Your trial period has ended." }));
      return;
    }
    // Serve trial-expired landing page
    try {
      const trialPage = fs.readFileSync(path.join(WEB_DIR, "trial-expired.html"), "utf-8");
      setSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(trialPage);
    } catch (e) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Your trial period has ended. Contact your administrator.");
    }
    return;
  }

  // If authenticated via query token, set cookies and redirect to clean URL
  if (url.searchParams.has("token")) {
    const sessionCookie = `scratchy_token=${SESSION_SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
    // SECURITY RISK (C3): This non-HttpOnly cookie exposes the raw AUTH_TOKEN to JavaScript.
    // Any XSS vulnerability can steal the gateway token. The WS proxy at /ws already
    // authenticates via the HttpOnly cookie, so this cookie should eventually be removed
    // in favor of proxy-only auth. Requires refactoring the client's WebSocket handshake
    // to not send auth tokens directly. TODO: Remove after client migration.
    const authCookie = `scratchy_auth=${AUTH_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
    res.writeHead(302, {
      "Set-Cookie": [sessionCookie, authCookie],
      Location: url.pathname,
    });
    res.end();
    return;
  }

  // Ensure the JS-readable auth cookie exists on every authenticated request
  // SECURITY RISK (C3): This non-HttpOnly cookie exposes the raw AUTH_TOKEN to JS.
  // TODO: Remove after migrating client to proxy-only auth.
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies.scratchy_auth) {
    // Prevent redirect loop: if we already tried setting the cookie (indicated by _sc query param), skip
    if (url.searchParams.has('_sc')) {
      // Cookie still missing after redirect — browser rejected it (PWA, incognito, etc.)
      // Continue without auth cookie — WS auth uses scratchy_token (HttpOnly) anyway
    } else if (url.pathname === "/" || url.pathname.endsWith(".html")) {
      const authCookie = `scratchy_auth=${AUTH_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
      const sessionCookie = `scratchy_token=${SESSION_SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
      const sep = url.pathname.includes('?') ? '&' : '?';
      res.writeHead(302, {
        "Set-Cookie": [sessionCookie, authCookie],
        Location: url.pathname + sep + '_sc=1',
      });
      res.end();
      return;
    }
  }

  // Google OAuth callback — exchange code and redirect back
  // Route
  // Phase 31: Widget manifest API
  if (url.pathname === '/api/widget-manifest') {
    try {
      const manifest = widgetRegionManager.listWidgets();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ widgets: manifest }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Phase 31: Memory API (admin only)
  if (url.pathname.startsWith('/api/memory/') && req._authResult) {
    const userId = req._authResult.user?.id || '_legacy';
    const isAdmin = req._authResult.user?.role === 'admin' || req._authResult.legacy;
    const memUserId = url.pathname.split('/')[3] || userId;

    // Non-admin can only access own memories
    if (memUserId !== userId && !isAdmin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    if (url.pathname === `/api/memory/${memUserId}` && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memories: memoryStore.getAll(memUserId), stats: memoryStore.stats(memUserId) }));
      return;
    }

    if (url.pathname === `/api/memory/${memUserId}/search` && req.method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const results = memoryStore.search(memUserId, query, { limit: 20 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
      return;
    }

    if (url.pathname === `/api/memory/${memUserId}/context` && req.method === 'GET') {
      const context = memoryStore.getCompactionContext(memUserId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ context }));
      return;
    }
  }

  // Phase 30: Analytics API
  if (url.pathname.startsWith("/api/analytics/") && analytics) {
    try { analytics.handleRequest(req, res, url, req._authResult); } catch(e) {
      console.error('[Scratchy] Analytics route error:', e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  } else if (url.pathname === "/api/ecosystem") {
    handleEcosystemApi(req, res);
  } else if (url.pathname === "/api/tts") {
    handleTtsApi(req, res);
  } else if (url.pathname === "/api/transcribe") {
    handleTranscribeApi(req, res);
  } else if (url.pathname === "/api/send") {
    handleSendApi(req, res);
  } else if (url.pathname === "/api/context") {
    handleContextApi(req, res);
  } else if (url.pathname === "/api/sessions") {
    handleSessionsApi(req, res);
  } else if (url.pathname === "/api/search") {
    handleSearchApi(req, res);
  } else if (url.pathname.startsWith("/api/history")) {
    handleHistoryApi(req, res);
  } else if (url.pathname === "/api/canvas-history") {
    handleCanvasHistoryApi(req, res);
  } else if (url.pathname === "/api/canvas-history/restore") {
    handleCanvasRestoreApi(req, res);
  } else if (url.pathname === "/api/workspace-file") {
    handleWorkspaceFileApi(req, res, url);
  } else if (url.pathname === "/api/workspace") {
    handleWorkspaceApi(req, res);
  } else if (url.pathname === "/api/attachment") {
    handleAttachmentApi(req, res);
  } else if (url.pathname.startsWith("/media/")) {
    // Media files are admin-only (workspace contains sensitive data)
    const _mediaAuth = req._authResult;
    if (!_mediaAuth?.isLegacy && _mediaAuth?.user?.role !== 'admin') {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    serveMedia(req, res);
  } else {
    serveStatic(req, res);
  }
});

// ── API: GET/POST /api/ecosystem ──
function handleEcosystemApi(req, res) {
  setSecurityHeaders(res);
  
  if (req.method === "GET") {
    // Get ecosystem status
    if (!ScratchyCompleteIntegration) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        error: "Widget ecosystem not available",
        status: "unavailable" 
      }));
      return;
    }

    try {
      const status = ScratchyCompleteIntegration.getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "operational",
        timestamp: new Date().toISOString(),
        ...status
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        error: "Failed to get ecosystem status", 
        details: error.message 
      }));
    }
    return;
  }

  if (req.method === "POST") {
    // Handle ecosystem commands (debug mode, workflows, etc.)
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        handleEcosystemCommand(data, res);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          error: "Invalid JSON", 
          details: error.message 
        }));
      }
    });
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

function handleEcosystemCommand(data, res) {
  if (!ScratchyCompleteIntegration) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      error: "Widget ecosystem not available" 
    }));
    return;
  }

  const { command, params = {} } = data;

  try {
    switch (command) {
      case "setDebugMode":
        ScratchyCompleteIntegration.setDebugMode(!!params.enabled);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: true, 
          debugMode: !!params.enabled 
        }));
        break;

      case "startWorkflow":
        ScratchyCompleteIntegration.startWorkflow(
          params.templateId, 
          params.params || {}, 
          params.context || {}
        ).then(result => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ 
            success: true, 
            workflow: result 
          }));
        }).catch(error => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ 
            error: "Workflow failed", 
            details: error.message 
          }));
        });
        break;

      case "exportState":
        const state = ScratchyCompleteIntegration.exportSystemState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: true, 
          state 
        }));
        break;

      default:
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          error: `Unknown command: ${command}`,
          availableCommands: ["setDebugMode", "startWorkflow", "exportState"]
        }));
    }
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      error: "Command execution failed", 
      details: error.message 
    }));
  }
}

// ── WebSocket proxy: /ws → gateway (with session continuity) ──
// Smart proxy that keeps gateway WS alive across client reconnects.
// Client sends clientId + lastSeq in query params. Server buffers events
// during disconnection and replays on reconnect.
const WebSocketServer = require("ws").Server;
const WebSocketClient = require("ws");

// Per-client persistent sessions
// clientId → { gatewayWs, buffer[], seq, clientWs, graceTimer, handshakeComplete }
const wsSessions = new Map();

// Phase 31: Widget region manager + memory store
const widgetRegionManager = new WidgetRegionManager();
const memoryStore = new MemoryStore();

// ── Phase 30: Initialize Analytics System ──
let analytics = null;
try {
  analytics = initAnalytics({ wsSessions });
  analytics.start();
} catch (e) {
  console.error('[Scratchy] Analytics init failed (non-fatal):', e.message);
}

// ── Server-side canvas state (shared across all clients) ──
// Mirrors the client-side CanvasState: tracks components by ID
const _serverCanvasState = new Map(); // id → { op, id, type, data, layout }
const _canvasStatePath = path.join(__dirname, '.canvas-state.json');
const _canvasHistoryPath = path.join(__dirname, '.canvas-history.json');
let _canvasHistory = []; // [{ ts, title, components: [...] }]
const MAX_CANVAS_HISTORY = 50;

// Restore canvas history
try {
  if (fs.existsSync(_canvasHistoryPath)) {
    _canvasHistory = JSON.parse(fs.readFileSync(_canvasHistoryPath, 'utf-8')) || [];
  }
} catch(e) {}

function _snapshotCanvasToHistory() {
  if (_serverCanvasState.size === 0) return; // don't save empty canvas
  const components = [];
  for (const comp of _serverCanvasState.values()) components.push({ ...comp });
  // Derive title from first component with a title, or first component type
  let title = 'Canvas';
  for (const c of components) {
    if (c.data && c.data.title) { title = c.data.title; break; }
  }
  _canvasHistory.unshift({ ts: Date.now(), title, count: components.length, components });
  if (_canvasHistory.length > MAX_CANVAS_HISTORY) _canvasHistory = _canvasHistory.slice(0, MAX_CANVAS_HISTORY);
  try { fs.writeFileSync(_canvasHistoryPath, JSON.stringify(_canvasHistory), { mode: 0o600 }); } catch(e) {}
}


// Restore canvas state from disk on startup
try {
  if (fs.existsSync(_canvasStatePath)) {
    const saved = JSON.parse(fs.readFileSync(_canvasStatePath, 'utf-8'));
    if (Array.isArray(saved)) {
      for (const comp of saved) {
        if (comp.id) _serverCanvasState.set(comp.id, comp);
      }
      console.log(`[Scratchy] Restored canvas state: ${_serverCanvasState.size} components`);
    }
  }
} catch(e) { console.error('[Scratchy] Canvas state restore failed:', e.message); }

// ── Active Widget Tracking ──
// Track which widget "list" views are active per user.
// On reconnect, these get re-triggered to restore visible widget regions with fresh data.
const _WIDGET_LIST_ACTIONS = new Set([
  'sn-list', 'sn-back', 'sn-back-to-list',
  'cal-month', 'cal-back',
  'mail-inbox', 'mail-back',
  'admin-dashboard', 'admin-monitor', 'admin-quotas', 'admin-providers'
]);

function _trackActiveWidget(session, action) {
  if (!_WIDGET_LIST_ACTIONS.has(action)) return;
  const userId = session._userInfo?.user?.id || (session._userInfo?.isLegacy ? '_legacy' : null);
  if (!userId) return;
  // Extract widget prefix
  const prefix = action.split('-')[0];
  if (!session._activeWidgets) session._activeWidgets = {};
  session._activeWidgets[prefix] = action;
  // Persist per user
  try {
    const existing = readWidgetState(userId, 'active-widgets.json') || {};
    existing[prefix] = action;
    writeWidgetState(userId, 'active-widgets.json', existing);
  } catch(e) {}
}

function _clearActiveWidget(session, prefix) {
  const userId = session._userInfo?.user?.id || (session._userInfo?.isLegacy ? '_legacy' : null);
  if (!userId) return;
  if (session._activeWidgets) delete session._activeWidgets[prefix];
  // Also clear singular _activeWidget if it matches
  // Mapping: prefix 'sa' → _activeWidget 'subagent-monitor', prefix 'admin' → 'admin-*'
  if (session._activeWidget) {
    const aw = session._activeWidget;
    if (aw === prefix || aw.startsWith(prefix + '-') || (prefix === 'sa' && aw === 'subagent-monitor')) {
      session._activeWidget = null;
    }
  }
  try {
    const existing = readWidgetState(userId, 'active-widgets.json') || {};
    delete existing[prefix];
    writeWidgetState(userId, 'active-widgets.json', existing);
  } catch(e) {}
  // Also clear dismissed widget's components from canvas state
  // so they don't reappear on page refresh
  if (session._canvasState) {
    const toDelete = [];
    for (const [id] of session._canvasState) {
      if (id.startsWith(prefix + '-') || id === prefix) toDelete.push(id);
    }
    if (toDelete.length > 0) {
      for (const id of toDelete) session._canvasState.delete(id);
      // Persist the cleaned state
      _persistUserCanvasState(session);
      console.log(`[Scratchy] Cleared ${toDelete.length} canvas components for dismissed widget: ${prefix}`);
    }
  }
}

function _getActiveWidgets(userId) {
  try {
    return readWidgetState(userId, 'active-widgets.json') || {};
  } catch(e) { return {}; }
}

// Debounced persist to disk
let _canvasPersistTimer = null;
function _persistCanvasState() {
  if (_canvasPersistTimer) clearTimeout(_canvasPersistTimer);
  _canvasPersistTimer = setTimeout(() => {
    try {
      const snapshot = [];
      for (const comp of _serverCanvasState.values()) snapshot.push(comp);
      fs.writeFileSync(_canvasStatePath, JSON.stringify(snapshot), { mode: 0o600 });
    } catch(e) {}
  }, 1000);
}

function _applyCanvasOp(op) {
  if (!op || !op.op) return;
  switch (op.op) {
    case 'clear':
      _snapshotCanvasToHistory();
      _serverCanvasState.clear();
      break;
    case 'upsert':
      if (op.id) _serverCanvasState.set(op.id, { op: 'upsert', id: op.id, type: op.type, data: op.data, layout: op.layout });
      break;
    case 'patch':
      if (op.id && _serverCanvasState.has(op.id)) {
        const existing = _serverCanvasState.get(op.id);
        existing.data = { ...existing.data, ...(op.data || {}) };
      }
      break;
    case 'remove':
      if (op.id) _serverCanvasState.delete(op.id);
      break;
    case 'move':
      if (op.id && _serverCanvasState.has(op.id)) {
        _serverCanvasState.get(op.id).layout = op.layout;
      }
      break;
    // trigger, toast, overlay etc. are ephemeral — don't track
  }
  _persistCanvasState();
}

// ── Per-session canvas state (multi-user isolation) ──
function _applySessionCanvasOp(session, op) {
  if (!op || !op.op || !session || !session._canvasState) return;
  switch (op.op) {
    case 'clear':
      session._canvasState.clear();
      break;
    case 'upsert':
      if (op.id) session._canvasState.set(op.id, { op: 'upsert', id: op.id, type: op.type, data: op.data, layout: op.layout });
      break;
    case 'patch':
      if (op.id && session._canvasState.has(op.id)) {
        const existing = session._canvasState.get(op.id);
        existing.data = { ...existing.data, ...(op.data || {}) };
      }
      break;
    case 'remove':
      if (op.id) session._canvasState.delete(op.id);
      break;
    case 'move':
      if (op.id && session._canvasState.has(op.id)) {
        session._canvasState.get(op.id).layout = op.layout;
      }
      break;
  }
  _persistUserCanvasState(session);
}

// Persist per-user canvas state to disk (debounced per user)
const _userCanvasPersistTimers = {};
function _persistUserCanvasState(session) {
  const userId = session._userInfo?.user?.id || (session._userInfo?.isLegacy ? '_legacy' : null);
  if (!userId || !session._canvasState) return;
  if (_userCanvasPersistTimers[userId]) return; // already scheduled
  _userCanvasPersistTimers[userId] = setTimeout(() => {
    delete _userCanvasPersistTimers[userId];
    try {
      const snapshot = [];
      for (const comp of session._canvasState.values()) snapshot.push({ ...comp });
      writeWidgetState(userId, 'canvas-state.json', snapshot);
    } catch(e) { console.error('[Scratchy] Canvas state persist failed:', e.message); }
  }, 1000);
}

// Restore per-user canvas state from disk
function _restoreUserCanvasState(session) {
  const userId = session._userInfo?.user?.id || (session._userInfo?.isLegacy ? '_legacy' : null);
  if (!userId) return;
  try {
    const saved = readWidgetState(userId, 'canvas-state.json');
    if (saved && Array.isArray(saved) && saved.length > 0) {
      for (const comp of saved) {
        if (comp.id) session._canvasState.set(comp.id, comp);
      }
      console.log(`[Scratchy] Restored ${session._canvasState.size} canvas components for user ${userId}`);
    }
  } catch(e) {}
}

function _extractAndTrackSessionCanvasOps(session, text) {
  if (!text || typeof text !== 'string' || !session || !session._canvasState) return;
  const re = /```scratchy-canvas\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const lines = match[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const op = JSON.parse(trimmed);
        if (op && op.op) _applySessionCanvasOp(session, op);
      } catch(e) {}
    }
  }
  if (toonEncoder) {
    const toonRe = /```scratchy-toon\s*\n([\s\S]*?)```/g;
    let toonMatch;
    while ((toonMatch = toonRe.exec(text)) !== null) {
      try {
        const decoded = toonEncoder.toonDecode(toonMatch[1]);
        const ops = Array.isArray(decoded) ? decoded : [decoded];
        for (const op of ops) {
          if (op && op.op) _applySessionCanvasOp(session, op);
        }
      } catch(e) {
        console.error('[Scratchy] TOON session parse error:', e.message);
      }
    }
  }
}

function _getSessionCanvasSnapshot(session) {
  if (!session || !session._canvasState || session._canvasState.size === 0) return null;
  const ops = [{ op: 'clear' }];
  for (const comp of session._canvasState.values()) {
    ops.push(comp);
  }
  return ops;
}

// TOON encoder for server-side use
let toonEncoder = null;
try {
  toonEncoder = require('./lib/toon-encoder');
  console.log('[Scratchy] ✅ TOON encoder loaded');
} catch(e) {
  console.log('[Scratchy] ⚠️ TOON encoder not available:', e.message);
}

function _extractAndTrackCanvasOps(text) {
  if (!text || typeof text !== 'string') return;
  // Track JSON canvas ops
  const re = /```scratchy-canvas\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const lines = match[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const op = JSON.parse(trimmed);
        if (op && op.op) _applyCanvasOp(op);
      } catch(e) {}
    }
  }
  // Track TOON canvas ops
  if (toonEncoder) {
    const toonRe = /```scratchy-toon\s*\n([\s\S]*?)```/g;
    let toonMatch;
    while ((toonMatch = toonRe.exec(text)) !== null) {
      try {
        const decoded = toonEncoder.toonDecode(toonMatch[1]);
        // decoded could be a single op or array of ops (if --- separated)
        const ops = Array.isArray(decoded) ? decoded : [decoded];
        for (const op of ops) {
          if (op && op.op) _applyCanvasOp(op);
        }
      } catch(e) {
        console.error('[Scratchy] TOON parse error:', e.message);
      }
    }
  }
}

function _getCanvasSnapshot() {
  // Return current canvas state as an array of upsert ops (prefixed with clear)
  if (_serverCanvasState.size === 0) return null;
  const ops = [{ op: 'clear' }];
  for (const comp of _serverCanvasState.values()) {
    ops.push(comp);
  }
  return ops;
}
const WS_GRACE_PERIOD = 180000;   // 3min before closing orphaned gateway WS (train dead zones, tunnels)
const WS_BUFFER_MAX = 500;        // Max events to buffer per session
const WS_SESSION_TTL = 300000;    // 5min max session lifetime without client

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  // Auth check (Phase 19: multi-user aware)
  let wsUserInfo = null;
  if (wsIsolator) {
    wsUserInfo = wsIsolator.authenticateWsUpgrade(req);
  }
  if (!wsUserInfo && !isAuthenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    console.log("[Scratchy] WS upgrade rejected — no valid auth");
    return;
  }

  // Block trial-expired users from WS
  if (wsUserInfo?.user && authSystem?.userStore?.isTrialExpired(wsUserInfo.user)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nX-Trial-Expired: true\r\n\r\n");
    socket.destroy();
    console.log(`[Scratchy] WS upgrade rejected — trial expired for ${wsUserInfo.user.email}`);
    return;
  }

  const clientId = url.searchParams.get("clientId");
  const lastSeq = parseInt(url.searchParams.get("lastSeq") || "0", 10);
  const deviceId = url.searchParams.get("deviceId") || null;

  // No clientId → fall back to raw pipe (backward compat)
  if (!clientId) {
    console.log("[Scratchy] WS upgrade (legacy, no clientId) — raw pipe proxy");
    _legacyPipeProxy(req, socket, head);
    return;
  }

  const wsUserAgent = req.headers['user-agent'] || '';
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    _handleSmartProxy(clientWs, clientId, lastSeq, wsUserInfo, deviceId, wsUserAgent);
  });
});

// ── Smart session-aware proxy ──
function _handleSmartProxy(clientWs, clientId, lastSeq, userInfo, deviceId, userAgent) {
  const existing = wsSessions.get(clientId);
  console.log(`[Scratchy] _handleSmartProxy clientId=${clientId} existing=${!!existing} gwState=${existing?.gatewayWs?.readyState} hsComplete=${existing?.handshakeComplete} sessions=${wsSessions.size} user=${userInfo?.user?.email || 'legacy'}`);

  if (existing && existing.gatewayWs && existing.gatewayWs.readyState === WebSocketClient.OPEN) {
    // ── Reconnect to existing session ──
    console.log(`[Scratchy] WS reconnect — clientId=${clientId.slice(0,8)}… lastSeq=${lastSeq} buffered=${existing.buffer.length}`);

    // Cancel grace timer
    if (existing.graceTimer) {
      clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
    }

    // Detach old client if somehow still around
    if (existing.clientWs && existing.clientWs.readyState === WebSocketClient.OPEN) {
      try { existing.clientWs.close(1000, "replaced"); } catch(e) {}
    }
    existing.clientWs = clientWs;
    existing._deviceId = deviceId; // Update device ID on reconnect
    if (userAgent) existing._userAgent = userAgent; // Update user-agent on reconnect

    // Clear ephemeral subagent monitor on reconnect — it's auto-triggered, not user-requested
    if (existing._subagentAutoTriggered) {
      if (existing._subagentInterval) { clearInterval(existing._subagentInterval); existing._subagentInterval = null; }
      existing._subagentAutoTriggered = false;
      existing._subagentMonitor = null;
      if (existing._activeWidget === 'subagent-monitor') existing._activeWidget = null;
      // Remove sa-* components from canvas state (ephemeral, don't restore)
      if (existing._canvasState) {
        const saKeys = [];
        for (const [id] of existing._canvasState) { if (id.startsWith('sa-')) saKeys.push(id); }
        for (const k of saKeys) existing._canvasState.delete(k);
        if (saKeys.length > 0) console.log('[Scratchy] Cleared ' + saKeys.length + ' ephemeral sa-* components on reconnect');
      }
    }

    // Send synthetic handshake success (gateway handshake already done)
    clientWs.send(JSON.stringify({
      type: "res", id: "reconnect", ok: true,
      payload: { protocol: 3, resumed: true, bufferedEvents: existing.buffer.length }
    }));

    // Send user role info
    if (existing._userInfo?.user) {
      try { clientWs.send(JSON.stringify({ type: "user-info", user: { email: existing._userInfo.user.email, role: existing._userInfo.user.role, displayName: existing._userInfo.user.displayName } })); } catch(e) {}
    }

    // Replay buffered events
    const toReplay = existing.buffer.filter(e => e.seq > lastSeq);
    if (toReplay.length > 0) {
      clientWs.send(JSON.stringify({ type: "replay_start", fromSeq: toReplay[0].seq, toSeq: toReplay[toReplay.length - 1].seq, count: toReplay.length }));
      for (const entry of toReplay) {
        try { clientWs.send(JSON.stringify({ seq: entry.seq, frame: entry.frame })); } catch(e) { break; }
      }
      clientWs.send(JSON.stringify({ type: "replay_end" }));
      console.log(`[Scratchy] Replayed ${toReplay.length} events (seq ${toReplay[0].seq}→${toReplay[toReplay.length - 1].seq})`);
    }

    // Push per-session canvas state on reconnect (multi-user isolation)
    console.log(`[Scratchy] Canvas state on reconnect: ${existing._canvasState ? existing._canvasState.size : 'null'} components`);
    if (existing._canvasState && existing._canvasState.size > 0) {
      const ops = [{ op: 'clear' }];
      for (const [id, comp] of existing._canvasState) {
        ops.push(comp); // already in {op:'upsert', id, type, data, layout} format
      }
      existing.seq++;
      try {
        clientWs.send(JSON.stringify({
          seq: existing.seq,
          frame: { type: "event", event: "canvas-update", payload: { ops, restore: true } }
        }));
        console.log(`[Scratchy] Pushed ${existing._canvasState.size} canvas components on reconnect (restore)`);
      } catch(e) {}
    }

    // Push compaction state on reconnect — if compaction is active, client should show indicator
    if (existing._compactionStartTs) {
      try {
        var elapsed = Date.now() - existing._compactionStartTs;
        clientWs.send(JSON.stringify({
          type: 'compaction', phase: 'start',
          tokensBefore: existing._compactionTokensBefore || undefined,
          ts: existing._compactionStartTs,
          reconnect: true
        }));
        // Also send a progress update with elapsed time
        clientWs.send(JSON.stringify({
          type: 'compaction', phase: 'progress',
          elapsed: elapsed,
          tokensBefore: existing._compactionTokensBefore || undefined,
          ts: Date.now()
        }));
        console.log(`[Scratchy] Pushed compaction state on reconnect (elapsed=${Math.round(elapsed/1000)}s)`);
      } catch(e) {}
    }

    // If admin live monitoring is active, re-send initial render so patches have targets
    if (existing._adminLiveView && existing._adminWidget) {
      try {
        existing._adminWidget.handleAction(existing._adminLiveView, {})
          .then((result) => {
            if (result && result.ops) {
              existing.seq++;
              clientWs.send(JSON.stringify({
                seq: existing.seq,
                frame: { type: "event", event: "canvas-update", payload: { ops: result.ops } }
              }));
              console.log(`[Scratchy] Re-sent admin ${existing._adminLiveView} render on reconnect`);
            }
          }).catch(() => {});
      } catch(e) {}
    }

    // Wire client→gateway forwarding
    _wireClientToGateway(clientWs, existing);
    return;
  }

  // ── New session — try to take over existing session from same user ──
  // When the same user reconnects with a new clientId (page reload, tab switch),
  // take over the old session instead of creating a new one. This prevents:
  // - Orphaned gateway WS connections receiving broadcasts with no client to deliver to
  // - Agent responses going to dead sessions while the active client shows "thinking" forever
  // - Accumulation of zombie sessions during the grace period
  let reuseGw = null;
  const _userId = userInfo?.user?.id || (userInfo?.isLegacy ? '_admin' : null);
  if (_userId) {
    for (const [existingClientId, existingSession] of wsSessions) {
      if (existingClientId === clientId) continue; // Skip self
      const existingUserId = existingSession._userInfo?.user?.id || (existingSession._userInfo?.isLegacy ? '_admin' : null);
      if (existingUserId !== _userId) continue;
      // Found another session for the same user
      if (existingSession.gatewayWs && existingSession.gatewayWs.readyState === WebSocketClient.OPEN && existingSession.handshakeComplete) {
        reuseGw = existingSession;
        console.log(`[Scratchy] ♻️ Found existing session for user ${_userId.slice(-8)} — taking over clientId=${existingClientId.slice(0,12)} (gwReady=${existingSession._gwReady} buffer=${existingSession.buffer.length})`);
        break;
      } else {
        // Clean up orphaned session (no live gateway WS or handshake incomplete)
        console.log(`[Scratchy] 🧹 Cleaning orphaned session for user ${_userId.slice(-8)} — clientId=${existingClientId.slice(0,12)}`);
        _cleanupSession(existingClientId, "orphan cleanup on new connection");
      }
    }
  }

  if (reuseGw) {
    console.log(`[Scratchy] WS new session — clientId=${clientId.slice(0,8)}… REUSING gateway WS from ${reuseGw.clientId.slice(0,8)}…`);
  } else {
    console.log(`[Scratchy] WS new session — clientId=${clientId.slice(0,8)}…`);
  }

  // ── Session takeover: reuse existing gateway WS from same user ──
  // Must happen BEFORE creating a new session to avoid orphaned objects.
  const syncUserId = userInfo?.user?.id || (userInfo?.isLegacy ? '_admin' : null);
  if (reuseGw) {
    // ── Full session takeover: keep the old session object (with its gateway WS
    // handler closures) but swap in the new clientWs and clientId. This ensures
    // that agent responses flowing through the existing gateway WS reach the
    // new client connection immediately — no orphaned sessions, no lost events.
    const oldClientId = reuseGw.clientId;

    // Cancel grace timer
    if (reuseGw.graceTimer) {
      clearTimeout(reuseGw.graceTimer);
      reuseGw.graceTimer = null;
    }

    // Close old client WS if somehow still alive
    if (reuseGw.clientWs && reuseGw.clientWs.readyState === WebSocketClient.OPEN) {
      try { reuseGw.clientWs.close(1000, "taken over by new connection"); } catch(e) {}
    }

    // Swap: update the session identity + client WS
    reuseGw.clientWs = clientWs;
    reuseGw.clientId = clientId;
    reuseGw._deviceId = deviceId;
    if (userAgent) reuseGw._userAgent = userAgent; // Update user-agent on reuse
    reuseGw._userInfo = userInfo || reuseGw._userInfo; // Refresh user info

    // Move session map entry from old clientId to new one
    wsSessions.delete(oldClientId);
    wsSessions.set(clientId, reuseGw);

    // Update device sync registration
    if (syncUserId) {
      deviceSync.unregister(syncUserId, reuseGw); // Remove old entry
      deviceSync.register(syncUserId, reuseGw);    // Re-register with updated session
    }

    console.log(`[Scratchy] ♻️ Session takeover complete: ${oldClientId.slice(0,12)} → ${clientId.slice(0,12)} (buffer=${reuseGw.buffer.length} seq=${reuseGw.seq})`);

    // Send synthetic handshake success
    clientWs.send(JSON.stringify({
      type: "res", id: "takeover", ok: true,
      payload: { protocol: 3, resumed: true, bufferedEvents: reuseGw.buffer.length }
    }));

    // Send user role info
    if (reuseGw._userInfo?.user) {
      try { clientWs.send(JSON.stringify({ type: "user-info", user: { email: reuseGw._userInfo.user.email, role: reuseGw._userInfo.user.role, displayName: reuseGw._userInfo.user.displayName } })); } catch(e) {}
    }

    // Replay buffered events (so client catches up on anything missed)
    const toReplay = reuseGw.buffer.filter(e => e.seq > lastSeq);
    if (toReplay.length > 0) {
      clientWs.send(JSON.stringify({ type: "replay_start", fromSeq: toReplay[0].seq, toSeq: toReplay[toReplay.length - 1].seq, count: toReplay.length }));
      for (const entry of toReplay) {
        try { clientWs.send(JSON.stringify({ seq: entry.seq, frame: entry.frame })); } catch(e) { break; }
      }
      clientWs.send(JSON.stringify({ type: "replay_end" }));
      console.log(`[Scratchy] Replayed ${toReplay.length} events (seq ${toReplay[0].seq}→${toReplay[toReplay.length - 1].seq})`);
    }

    // Push canvas state
    const canvasSnap = _getSessionCanvasSnapshot(reuseGw);
    if (canvasSnap) {
      try {
        clientWs.send(JSON.stringify({
          type: "event", event: "canvas-update",
          payload: { ops: canvasSnap, restore: true }
        }));
      } catch(e) {}
    }

    // Wire client→gateway forwarding for the new WS
    _wireClientToGateway(clientWs, reuseGw);
    return;
  }

  // ── No existing session to reuse — create fresh ──
  const session = {
    clientId,
    gatewayWs: null,
    clientWs,
    buffer: [],      // { seq, frame }[]
    seq: 0,
    graceTimer: null,
    handshakeComplete: false,
    handshakePending: null,
    _userInfo: userInfo || null, // Phase 19: per-user session info
    _canvasState: new Map(),     // Per-session canvas state (multi-user isolation)
    _deviceId: deviceId,         // Phase 29: cross-device sync
    _userAgent: userAgent || '', // Device context for operator sessions
  };
  wsSessions.set(clientId, session);

  // Restore per-user canvas state from disk (survives service restarts)
  _restoreUserCanvasState(session);

  // Phase 29: Register device for cross-device sync
  if (syncUserId) {
    deviceSync.register(syncUserId, session);
  }

  // Open WS to gateway
  const gwWs = new WebSocketClient(`ws://127.0.0.1:${GATEWAY_PORT}/`, {
    headers: { Origin: process.env.SCRATCHY_ORIGIN || "https://localhost:3001" }
  });
  session.gatewayWs = gwWs;

  // Queue client messages until gateway WS is ready
  session._pendingClientMessages = [];
  session._gwReady = false;

  gwWs.on("open", () => {
    console.log(`[Scratchy] Gateway WS open for clientId=${clientId.slice(0,8)}…`);
    session._gwReady = true;
    // Flush any queued client messages (handshake frame is always first)
    for (const msg of session._pendingClientMessages) {
      try { gwWs.send(msg); } catch(e) {}
    }
    session._pendingClientMessages = [];
  });

  gwWs.on("message", (data) => {
    const raw = data.toString();
    let frame;
    try { frame = JSON.parse(raw); } catch(e) {
      // Forward unparseable data as-is
      if ((clientWs || session.clientWs) && (clientWs || session.clientWs).readyState === 1) {
        try { session.clientWs.send(raw); } catch(e2) {}
      }
      return;
    }

    // Intercept handshake response from gateway
    if (!session.handshakeComplete && frame.type === "res") {
      session.handshakeComplete = true;
      console.log(`[Scratchy] Gateway handshake OK for clientId=${clientId.slice(0,8)}…`);
      // Phase 30: Track session start
      if (analytics) {
        try {
          const _sUserId = session._userInfo?.user?.id || '_legacy';
          const _sSource = 'webchat';
          analytics.collectors.session.onSessionStart(_sUserId, _sSource, null, clientId);
        } catch(e) { /* analytics non-fatal */ }
      }
      // Forward the raw handshake response to the client (no seq wrapper — client expects raw)
      if ((clientWs || session.clientWs) && (clientWs || session.clientWs).readyState === 1) {
        try { session.clientWs.send(JSON.stringify(frame)); } catch(e) {}
        // Send user role info
        if (session._userInfo?.user) {
          try { session.clientWs.send(JSON.stringify({ type: "user-info", user: { email: session._userInfo.user.email, role: session._userInfo.user.role, displayName: session._userInfo.user.displayName } })); } catch(e) {}
        }
        // Push per-session canvas state to newly connected client (multi-user isolation)
        // Flagged as restore so client applies to canvasState without creating widget regions
        const canvasSnap = _getSessionCanvasSnapshot(session);
        if (canvasSnap) {
          console.log(`[Scratchy] Pushing canvas state (${canvasSnap.length - 1} components) to client`);
          try {
            session.clientWs.send(JSON.stringify({
              type: "event",
              event: "canvas-update",
              payload: { ops: canvasSnap, restore: true }
            }));
          } catch(e) {}
        }
      }

      // ─── Widget auto-init: check if any widgets have saved state ───
      const _preWarmUserId = session._userInfo?.user?.id || '_legacy';
      setTimeout(() => {
        try {
          const modPath = require.resolve('./genui-engine/templates/notes.js');
          delete require.cache[modPath];
          const StandardNotesWidget = require('./genui-engine/templates/notes.js');
          if (!session._notesWidget) session._notesWidget = new StandardNotesWidget(_preWarmUserId);
          // If widget has saved creds, pre-load the widget state (don't push to client yet)
          // Widget will be ready when user interacts
          if (session._notesWidget.creds) {
            console.log('[Scratchy] 🔄 Notes widget: session found, pre-warming...');
            session._notesWidget.sync().then(() => {
              console.log('[Scratchy] ✅ Notes widget ready (' + session._notesWidget.notes.length + ' notes)');
            }).catch(() => {});
          }
        } catch(e) { console.error('[Scratchy] Widget init error:', e.message); }

        // Pre-warm Google Calendar widget
        try {
          const calModPath = require.resolve('./genui-engine/templates/calendar.js');
          delete require.cache[calModPath];
          const GoogleCalendarWidget = require('./genui-engine/templates/calendar.js');
          if (!session._calendarWidget) session._calendarWidget = new GoogleCalendarWidget(_preWarmUserId);
          if (session._calendarWidget.creds && session._calendarWidget.session) {
            console.log('[Scratchy] 🔄 Calendar widget: session found, pre-warming...');
          }
        } catch(e) { console.error('[Scratchy] Calendar init error:', e.message); }

        // Pre-warm Email widget
        try {
          const emailModPath = require.resolve('./genui-engine/templates/email.js');
          delete require.cache[emailModPath];
          const EmailWidget = require('./genui-engine/templates/email.js');
          if (!session._emailWidget) session._emailWidget = new EmailWidget(_preWarmUserId);
          if (session._emailWidget.isConnected()) {
            console.log('[Scratchy] 🔄 Email widget: session found, pre-warming...');
          }
        } catch(e) { console.error('[Scratchy] Email init error:', e.message); }

        // ─── Re-trigger active widgets after reconnect ───
        // Wait for pre-warming to complete, then re-run saved widget actions
        // This creates visible widget regions with fresh data (not stale restore snapshots)
        setTimeout(() => {
          const activeWidgets = _getActiveWidgets(_preWarmUserId);
          const activeActions = Object.values(activeWidgets);
          if (activeActions.length === 0) return;
          console.log('[Scratchy] 🔄 Re-triggering active widgets:', activeActions.join(', '));

          for (const action of activeActions) {
            // Simulate widget-action by directly calling the handler
            // This creates a proper canvas-update (not restore) → client creates widget region
            try {
              let widgetPromise = null;
              if (action.startsWith('sn-') && session._notesWidget) {
                widgetPromise = session._notesWidget.handleAction(action, {});
              } else if (action.startsWith('cal-') && session._calendarWidget) {
                widgetPromise = session._calendarWidget.handleAction(action, {});
              } else if (action.startsWith('mail-') && session._emailWidget) {
                widgetPromise = session._emailWidget.handleAction(action, {});
              } else if (action.startsWith('admin')) {
                // Initialize admin widget if needed (lost on server restart)
                if (!session._adminWidget) {
                  try {
                    const AdminWidget = require('./genui-engine/templates/admin.js');
                    session._adminWidget = new AdminWidget({
                      userStore: authSystem?.userStore,
                      sessionStore: authSystem?.sessionStore,
                      quotaStore: authSystem?.quotaStore,
                      usageQuery: usageQuery,
                      previewSessions,
                      versionStore,
                    });
                    if (wsSessions) session._adminWidget.setConnections(wsSessions);
                    console.log('[Scratchy] 🔧 Admin widget initialized during re-trigger');
                  } catch(e) { console.error('[Scratchy] Admin widget init error:', e.message); }
                }
                if (session._adminWidget) {
                  widgetPromise = session._adminWidget.handleAction(action, {});
                }
              }
              if (widgetPromise && typeof widgetPromise.then === 'function') {
                widgetPromise.then(result => {
                  if (result && result.ops && result.ops.length > 0) {
                    for (const op of result.ops) _applySessionCanvasOp(session, op);
                    session.seq++;
                    const ws = session.clientWs;
                    if (ws && ws.readyState === 1) {
                      ws.send(JSON.stringify({
                        seq: session.seq,
                        frame: { type: "event", event: "canvas-update", payload: { ops: result.ops, autoRestore: true } }
                      }));
                      console.log('[Scratchy] ✅ Restored widget:', action, '(' + result.ops.length + ' ops)');
                    }
                  }
                }).catch(e => console.error('[Scratchy] Widget restore error (' + action + '):', e.message));
              }
            } catch(e) { console.error('[Scratchy] Widget restore error:', e.message); }
          }
        }, 2000); // 2s delay: let pre-warming finish + client render history first
      }, 500);

      return;
    }

    // Intercept upload response callbacks (from sendToGateway relay)
    if (frame.type === "res" && frame.id && session._uploadCallbacks && session._uploadCallbacks[frame.id]) {
      console.log(`[Scratchy] Upload response received: ${frame.id} ok=${frame.ok}`);
      session._uploadCallbacks[frame.id](frame);
      // Don't forward upload responses to client — they're internal
      return;
    }

    // ── Filter tool results from chat.history responses ──
    // Gateway returns ALL message roles (user, assistant, toolResult, toolCall).
    // Client should only see user + assistant messages. Filter server-side
    // to prevent raw tool output (web_fetch JSON, etc.) from leaking into chat.
    if (frame.type === "res" && frame.ok && frame.payload?.messages) {
      frame.payload.messages = frame.payload.messages.filter(m =>
        m.role === "user" || m.role === "assistant"
      );
    }

    // Skip tick/health events from logging


    // Normal event/response — assign seq, buffer, forward
    // ── Phase 30: Track tool events in analytics ──
    // Compaction events from gateway — forward as dedicated WS event for reliable indicator
    if (frame.type === 'event' && frame.event === 'agent' && frame.payload && frame.payload.stream === 'compaction') {
      const phase = frame.payload.data?.phase || 'start';
      const tokensBefore = frame.payload.data?.tokensBefore;
      const tokensAfter = frame.payload.data?.tokensAfter;
      const contextWindow = frame.payload.data?.contextWindow;
      console.log(`[Scratchy] 🔄 Compaction event: phase=${phase} tokens=${tokensBefore ?? '?'}→${tokensAfter ?? '?'} clientId=${clientId.slice(0,8)}…`);

      // If this is a real progress event from streaming compaction, forward it directly
      if (phase === 'progress' && frame.payload.data?.pct != null) {
        var streamProgressFrame = JSON.stringify({
          type: 'compaction', phase: 'progress',
          pct: frame.payload.data.pct,
          tokensGenerated: frame.payload.data.tokensGenerated,
          estimatedTotal: frame.payload.data.estimatedTotal,
          ts: Date.now()
        });
        // Send to client and broadcast sessions
        var ws = session.clientWs;
        if (ws && ws.readyState === 1) { try { ws.send(streamProgressFrame); } catch(e) {} }
        if (session._broadcastSessions) {
          for (var s of session._broadcastSessions) {
            var sws = s.clientWs;
            if (sws && sws.readyState === 1) { try { sws.send(streamProgressFrame); } catch(e) {} }
          }
        }
        return; // Don't process as a normal compaction event
      }

      // Build enriched compaction frame
      const compactFrame = JSON.stringify({
        type: 'compaction', phase, ts: Date.now(),
        tokensBefore: tokensBefore || undefined,
        tokensAfter: tokensAfter || undefined,
        contextWindow: contextWindow || undefined
      });

      // Helper: send to a WS connection
      function _sendCompactFrame(ws) {
        if (ws && ws.readyState === 1) { try { ws.send(compactFrame); } catch(e) {} }
      }

      _sendCompactFrame(session.clientWs);
      // Also broadcast to shared sessions
      if (session._broadcastSessions) {
        for (const shared of session._broadcastSessions) {
          _sendCompactFrame(shared.clientWs);
        }
      }

      // ── Phase 2: Compaction heartbeat — emit progress frames every 2s ──
      if (phase === 'start') {
        // Clear any existing heartbeat from a previous compaction
        if (session._compactionHeartbeat) {
          clearInterval(session._compactionHeartbeat);
          session._compactionHeartbeat = null;
        }
        session._compactionStartTs = Date.now();
        session._compactionTokensBefore = tokensBefore || null;
        session._compactionHeartbeat = setInterval(function() {
          var elapsed = Date.now() - (session._compactionStartTs || Date.now());
          var progressFrame = JSON.stringify({
            type: 'compaction', phase: 'progress',
            elapsed: elapsed,
            tokensBefore: session._compactionTokensBefore || undefined,
            ts: Date.now()
          });
          _sendCompactFrame.call ? void 0 : null; // no-op, redefine for interval scope
          var ws = session.clientWs;
          if (ws && ws.readyState === 1) { try { ws.send(progressFrame); } catch(e) {} }
          if (session._broadcastSessions) {
            for (var s of session._broadcastSessions) {
              var sws = s.clientWs;
              if (sws && sws.readyState === 1) { try { sws.send(progressFrame); } catch(e) {} }
            }
          }
        }, 2000);
      } else if (phase === 'end') {
        // Stop heartbeat
        if (session._compactionHeartbeat) {
          clearInterval(session._compactionHeartbeat);
          session._compactionHeartbeat = null;
        }
        session._compactionStartTs = null;
        session._compactionTokensBefore = null;
      }
      return; // Don't forward compaction events through seq buffer (already sent as dedicated frame)
    }

    // Diagnostic: log all agent events (temporary — remove after debugging)
    if (frame.type === 'event' && frame.event === 'agent' && frame.payload) {
      const stream = frame.payload.stream || '?';
      if (stream !== 'assistant') { // don't spam with text deltas
        const sk = frame.payload.sessionKey || 'none';
        console.log(`[Scratchy] 📡 Agent event: stream=${stream} phase=${frame.payload.data?.phase || '?'} sessionKey=${sk} clientId=${clientId.slice(0,8)}… clientWs=${session.clientWs?.readyState}`);
      }
    }

    if (analytics && frame.type === 'event' && frame.event === 'agent' && frame.payload && frame.payload.stream === 'tool') {
      try {
        const _td = frame.payload.data;
        const _tUserId = session._userInfo?.user?.id || '_legacy';
        const _tSessionId = session.clientId;
        if (_td) {
          if (_td.phase === 'start' && _td.name && _td.callId) {
            analytics.collectors.tool.onToolStart(_td.callId, _td.name, _td.args || {}, _tUserId, _tSessionId);
          } else if (_td.phase === 'end' && _td.callId) {
            analytics.collectors.tool.onToolEnd(_td.callId, _td.result || '', _tUserId, _tSessionId);
          } else if (_td.phase === 'error' && _td.callId) {
            analytics.collectors.tool.onToolError(_td.callId, _td.error || 'unknown', _tUserId, _tSessionId);
          }
        }
      } catch(e) { /* analytics non-fatal */ }
    }

    // ── Sub-agent monitor (disabled auto-trigger — was causing widget flash/scroll/respawn) ──
    // Sub-agent spawns are now silent; users see results when the agent reports them.
    // Manual trigger via admin widget still works.
    if (false && frame.type === 'event' && frame.event === 'agent' && frame.payload) {
      const toolData = frame.payload.data;
      if (frame.payload.stream === 'tool' && toolData && toolData.phase === 'start' && toolData.name === 'sessions_spawn') {
        console.log('[Scratchy] 🚀 sessions_spawn detected — triggering sub-agent monitor');
        
        // Stop any competing live widget (admin-dashboard, etc.)
        if (session._adminLiveInterval) {
          clearInterval(session._adminLiveInterval);
          session._adminLiveInterval = null;
          console.log('[Scratchy] ⏸️ Paused admin-dashboard live tick for sub-agent monitor');
        }
        session._activeWidget = 'subagent-monitor';
        
        // If monitor already active, just let it pick up the new agent on next poll
        if (session._subagentAutoTriggered && session._subagentInterval) {
          console.log('[Scratchy] 📡 Sub-agent monitor already active — new spawn will appear on next poll');
          // Force an immediate refresh by triggering handleAction again
          if (session._subagentMonitor) {
            const _saUserRole2 = session._userInfo?.user?.role;
            const ctx2 = { live: (_saUserRole2 === 'admin' || session._userInfo?.isLegacy) };
            session._subagentMonitor.handleAction('subagent-monitor', ctx2).then((result) => {
              if (result && result.ops && result.ops.length > 0) {
                for (const op of result.ops) _applySessionCanvasOp(session, op);
                session.seq++;
                const ws = session.clientWs;
                if (ws && ws.readyState === 1) {
                  ws.send(JSON.stringify({ seq: session.seq, frame: { type: "event", event: "canvas-update", payload: { ops: result.ops } } }));
                }
              }
            }).catch(() => {});
          }
          return; // Don't re-init
        }
        
        session._subagentAutoTriggered = true;
        
        // Simulate widget-action for subagent-monitor
        setTimeout(() => {
          try {
            const subMonPath = require.resolve('./genui-engine/templates/subagent-monitor.js');
            delete require.cache[subMonPath];
            const SubagentMonitor = require('./genui-engine/templates/subagent-monitor.js');
            
            const _initAutoMonitor = () => {
              session._subagentMonitor = new SubagentMonitor();
              session._subagentMonitor.setPushFn((ops) => {
                try {
                  const ws = session.clientWs;
                  if (!ws || ws.readyState !== 1) return;
                  // Only push if sub-agent monitor is still the active widget
                  if (session._activeWidget !== 'subagent-monitor') return;
                  for (const op of ops) {
                    if (op && op.op) _applySessionCanvasOp(session, op);
                  }
                  session.seq++;
                  ws.send(JSON.stringify({
                    seq: session.seq,
                    frame: { type: "event", event: "canvas-update", payload: { ops } }
                  }));
                } catch (e) {
                  console.error('[Scratchy] Sub-agent auto-push error:', e.message);
                }
              });
            };

            _initAutoMonitor();
            
            const _saUserRole = session._userInfo?.user?.role;
            const ctx = { live: (_saUserRole === 'admin' || session._userInfo?.isLegacy) };
            
            session._subagentMonitor.handleAction('subagent-monitor', ctx).then((result) => {
              if (result && result.ops && result.ops.length > 0) {
                for (const op of result.ops) _applySessionCanvasOp(session, op);
                // Send as canvas-update (not chat) so it renders in canvas view properly
                session.seq++;
                const ws = session.clientWs;
                if (ws && ws.readyState === 1) {
                  ws.send(JSON.stringify({
                    seq: session.seq,
                    frame: { type: "event", event: "canvas-update", payload: { ops: result.ops } }
                  }));
                }
                // Also send a brief chat message so the user knows
                session.seq++;
                const chatFrame = { type: "event", event: "chat", payload: { state: "final", message: "🤖 Sub-agent monitor active — switch to canvas view (🖼) to see progress." } };
                session.buffer.push({ seq: session.seq, frame: chatFrame });
                _trimBuffer(session);
                if (ws && ws.readyState === 1) {
                  ws.send(JSON.stringify({ seq: session.seq, frame: chatFrame }));
                }
              }
              
              // Start live polling
              if (session._subagentInterval) { clearInterval(session._subagentInterval); session._subagentInterval = null; }
              session._subagentInterval = setInterval(() => {
                try {
                  const ws = session.clientWs;
                  if (!ws || ws.readyState !== 1) { clearInterval(session._subagentInterval); session._subagentInterval = null; return; }
                  // Stop if another widget took over
                  if (session._activeWidget !== 'subagent-monitor') {
                    clearInterval(session._subagentInterval); session._subagentInterval = null;
                    return;
                  }
                  const update = session._subagentMonitor.getLiveUpdate();
                  if (update && update.ops && update.ops.length > 0) {
                    for (const op of update.ops) { if (op && op.op) _applySessionCanvasOp(session, op); }
                    session.seq++;
                    ws.send(JSON.stringify({ seq: session.seq, frame: { type: "event", event: "canvas-update", payload: { ops: update.ops } } }));
                  }
                  if (update && update.done) {
                    clearInterval(session._subagentInterval);
                    session._subagentInterval = null;
                    session._subagentAutoTriggered = false; // Reset for next spawn
                    // Clear stale sa-* components from canvas state so they don't reappear on reconnect
                    if (session._canvasState) {
                      const saKeys = [];
                      for (const [id] of session._canvasState) { if (id.startsWith('sa-')) saKeys.push(id); }
                      for (const k of saKeys) session._canvasState.delete(k);
                      if (saKeys.length > 0) {
                        _persistUserCanvasState(session);
                        console.log('[Scratchy] Cleared ' + saKeys.length + ' stale sa-* components after sub-agent completion');
                      }
                    }
                    session._activeWidget = null;
                  }
                } catch (e) {
                  console.error('[Scratchy] Sub-agent auto-poll error:', e.message);
                  clearInterval(session._subagentInterval);
                  session._subagentInterval = null;
                }
              }, 3000);
            }).catch(e => console.error('[Scratchy] Sub-agent auto-trigger error:', e.message));
          } catch (e) {
            console.error('[Scratchy] Sub-agent auto-trigger init error:', e.message);
          }
        }, 500); // Small delay to let the spawn complete
      }
    }

    // Phase 26: Session isolation — filter inbound events for non-admin users
    if (sessionIsolation && session._userInfo) {
      try {
        if (!sessionIsolation.filterInboundEvent(frame, session._userInfo)) {
          return;
        }
      } catch (e) {
        console.error('[Scratchy] Session isolation inbound filter error:', e.message);
      }
    }

    session.seq++;
    const entry = { seq: session.seq, frame };
    session.buffer.push(entry);
    _trimBuffer(session);

    // Track canvas ops per-session for multi-user isolation
    // Accumulate streaming text in deltas, extract canvas ops on final
    if (frame.type === "event" && frame.event === "chat" && frame.payload) {
      const msg = frame.payload.message;
      const state = frame.payload.state;
      
      // On delta: accumulate the latest text snapshot
      if (state === 'delta' && msg && typeof msg === 'object' && Array.isArray(msg.content)) {
        let fullText = '';
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) fullText += block.text;
        }
        if (fullText) session._accumulatedChatText = fullText;
      } else if (state === 'delta' && typeof msg === 'string') {
        session._accumulatedChatText = msg;
      }
      
      // On final: extract canvas ops from the accumulated text
      if (state === 'final' && session._accumulatedChatText) {
        _extractAndTrackSessionCanvasOps(session, session._accumulatedChatText);
        session._accumulatedChatText = '';
      }

      // Token usage is now read from JSONL session files by admin.js (authoritative source)
      // Gateway WS frames don't include usage data — removed broken WS interception

      // Phase 30: Track assistant responses in analytics
      if (analytics && frame.payload.state === 'final') {
        try {
          const _arUserId = session._userInfo?.user?.id || '_legacy';
          const _arSessionId = session.clientId;
          let _arText = '';
          if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
            _arText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          } else if (typeof msg === 'string') {
            _arText = msg;
          }
          const _arUsage = (msg && msg.usage) ? {
            model: msg.model || null,
            provider: msg.provider || null,
            input: msg.usage.input || 0,
            output: msg.usage.output || 0,
            cacheRead: msg.usage.cacheRead || 0,
            cacheWrite: msg.usage.cacheWrite || 0,
            cost: (msg.usage.cost && msg.usage.cost.total) || 0,
          } : {};
          analytics.collectors.conversation.onAssistantResponse(_arUserId, { text: _arText }, _arUsage, _arSessionId);
        } catch(e) { /* analytics non-fatal */ }
      }
    }

    // Phase 3: GenUI Processing - Enhance assistant messages with GenUI
    processGenUIIfNeeded(frame, (enhancedFrame) => {
      const finalFrame = enhancedFrame || frame;
      const targetWs = session.clientWs;
      if (targetWs && targetWs.readyState === 1) {
        try {
          targetWs.send(JSON.stringify({ seq: session.seq, frame: finalFrame }));
        } catch(e) {
          console.error("[Scratchy] Failed to forward to client:", e.message);
        }
      } else {
        console.log(`[Scratchy] ⚠️ No live client WS for seq ${session.seq} (clientWs=${!!targetWs} state=${targetWs?.readyState})`);
      }
      // Broadcast to shared sessions (other tabs reusing this gateway WS)
      if (session._broadcastSessions) {
        for (const shared of session._broadcastSessions) {
          shared.seq = session.seq;
          shared.buffer.push(entry);
          _trimBuffer(shared);
          const sharedWs = shared.clientWs;
          if (sharedWs && sharedWs.readyState === 1) {
            try { sharedWs.send(JSON.stringify({ seq: session.seq, frame: finalFrame })); } catch(e) {}
          }
        }
      }

      // Phase 29: Cross-device sync — broadcast to other devices of the same user
      const _syncUserId = session._syncUserId || session._userInfo?.user?.id || (session._userInfo?.isLegacy ? '_admin' : null);
      if (_syncUserId && deviceSync.getDeviceCount(_syncUserId) > 1) {
        deviceSync.broadcastFrame(_syncUserId, finalFrame, session);
      }
    });
  });

  gwWs.on("close", (code, reason) => {
    console.log(`[Scratchy] Gateway WS closed for clientId=${clientId.slice(0,8)}… code=${code}`);
    _cleanupSession(clientId, "gateway closed");
  });

  gwWs.on("error", (err) => {
    console.error(`[Scratchy] Gateway WS error for clientId=${clientId.slice(0,8)}…:`, err.message);
    if (analytics) try { analytics.collectors.error.onWsError('gateway_error', session._userInfo?.user?.id || '_legacy', 0, clientId); } catch(_) {}
    if ((clientWs || session.clientWs) && (clientWs || session.clientWs).readyState === 1) {
      session.clientWs.close(1011, "gateway error");
    }
    _cleanupSession(clientId, "gateway error");
  });

  // Wire client→gateway (including handshake interception)
  _wireClientToGateway(clientWs, session);
}

function _wireClientToGateway(clientWs, session) {
  // Ping/pong keep-alive with zombie detection
  // - Ping every 15s (Cloudflare idle timeout ~100s, so 15s gives ~6 chances)
  // - If client doesn't pong within 5s, socket is zombie → terminate it
  if (session._pingInterval) clearInterval(session._pingInterval);
  session._pongReceived = true; // Assume alive at start
  clientWs.on("pong", () => { session._pongReceived = true; });
  session._pingInterval = setInterval(() => {
    if (clientWs.readyState !== WebSocketClient.OPEN) {
      clearInterval(session._pingInterval);
      return;
    }
    if (!session._pongReceived) {
      // Previous ping got no pong — zombie socket
      console.log(`[Scratchy] ⚠️ Zombie socket detected (no pong) — terminating clientWs`);
      clearInterval(session._pingInterval);
      try { clientWs.terminate(); } catch(e) {}
      return;
    }
    session._pongReceived = false;
    try { clientWs.ping(); } catch(e) {}
  }, 15000); // ping every 15s

  clientWs.on("message", (data) => {
    let raw = data.toString();

    // Client keepalive ping — respond with pong, don't forward
    if (raw.includes('"type":"ping"')) {
      try {
        const frame = JSON.parse(raw);
        if (frame.type === "ping") {
          clientWs.send(JSON.stringify({ type: "pong", ts: frame.ts }));
          return;
        }
      } catch(e) {}
    }

    // Intercept client handshake and forward to gateway
    if (!session.handshakeComplete) {
      try {
        const frame = JSON.parse(raw);
        if (frame.type === "req" && frame.method === "connect") {
          // Replace client auth with server-side auth token
          frame.params = frame.params || {};
          frame.params.auth = { token: AUTH_TOKEN };
          // Phase 30: Request tool events for activity indicator
          frame.params.caps = ['tool-events'];
          // Phase 19: per-user session info (logged for debugging)
          // NOTE: The gateway ConnectParams schema validates client.id against a fixed enum
          // (webchat, cli, webchat-ui, etc.) with additionalProperties:false on all objects.
          // Per-user session isolation via client.id is NOT supported by the gateway.
          // All webchat users share the same gateway session (agent:main:main).
          // Scratchy handles UI-level isolation (separate localStorage, user context injection).
          // Future: gateway needs a session routing mechanism for multi-user webchat.
          {
            const userEmail = session._userInfo?.user?.email || 'unknown';
            const userRole = session._userInfo?.isLegacy ? 'legacy-admin' : (session._userInfo?.user?.role || 'unknown');
            console.log(`[Scratchy] Gateway connect for user=${userEmail} role=${userRole}`);
          }
          const msg = JSON.stringify(frame);
          // Queue if gateway WS not ready yet, otherwise send immediately
          if (session._gwReady && session.gatewayWs && session.gatewayWs.readyState === WebSocketClient.OPEN) {
            session.gatewayWs.send(msg);
          } else {
            session._pendingClientMessages.push(msg);
          }
          return;
        }
      } catch(e) {}
    }

    // Handle widget-dismiss: remove widget from active tracking
    if (raw.includes('"type":"widget-dismiss"')) {
      try {
        const frame = JSON.parse(raw);
        if (frame.prefix) {
          _clearActiveWidget(session, frame.prefix);
          // Stop admin live interval if the dismissed widget is admin
          if (frame.prefix === 'admin' && session._adminLiveInterval) {
            clearInterval(session._adminLiveInterval);
            session._adminLiveInterval = null;
            session._adminLiveView = null;
            console.log('[Scratchy] ⏸️ Admin live push stopped (widget dismissed)');
          }
          // Stop subagent monitor interval if dismissed (prefix is 'sa' from sa-header etc.)
          if ((frame.prefix === 'sa' || frame.prefix === 'subagent') && session._subagentInterval) {
            clearInterval(session._subagentInterval);
            session._subagentInterval = null;
            session._activeWidget = null;
            session._subagentAutoTriggered = false;
            console.log('[Scratchy] ⏸️ Sub-agent monitor stopped (widget dismissed)');
          }
          console.log('[Scratchy] Widget dismissed:', frame.prefix);
        }
      } catch(e) {}
      return;
    }

    // Handle canvas-refresh: push per-session canvas state to client (multi-user isolation)
    if (raw.includes('"type":"canvas-refresh"')) {
      if (session._canvasState && session._canvasState.size > 0) {
        const ops = [{ op: 'clear' }];
        for (const [id, comp] of session._canvasState) {
          ops.push({ ...comp });
        }
        session.seq++;
        try {
          ws.send(JSON.stringify({
            seq: session.seq,
            frame: { type: "event", event: "canvas-update", payload: { ops } }
          }));
          console.log(`[Scratchy] Canvas refresh: pushed ${session._canvasState.size} components`);
        } catch(e) {}
      }
      // Re-trigger admin live view if active
      if (session._adminLiveView && session._adminWidget) {
        try {
          session._adminWidget.handleAction(session._adminLiveView, {})
            .then((result) => {
              if (result && result.ops) {
                session.seq++;
                ws.send(JSON.stringify({
                  seq: session.seq,
                  frame: { type: "event", event: "canvas-update", payload: { ops: result.ops } }
                }));
                console.log(`[Scratchy] Re-sent admin ${session._adminLiveView} render on canvas-refresh`);
              }
            }).catch(() => {});
        } catch(e) {}
      }
      return; // Don't forward to gateway
    }

    // Handle widget-action messages: process LOCALLY only — NEVER forward to gateway/agent
    if (raw.includes('"type":"widget-action"')) {
      try {
        const frame = JSON.parse(raw);
        if (frame.type === "widget-action") {
          // Log action name only — NEVER log context (may contain credentials)
          let action = frame.data.action || 'unknown';
          console.log('[Scratchy] 🎯 Widget action (local):', action);
          
          let context = frame.data.context || {};
          
          const _sendToClient = (text) => {
            console.log('[Scratchy] 📤 _sendToClient called (' + text.length + ' chars)');
            session.seq++;
            const responseFrame = {
              type: "event", event: "chat",
              payload: { state: "final", message: text }
            };
            session.buffer.push({ seq: session.seq, frame: responseFrame });
            _trimBuffer(session);
            try {
              // Always use session.clientWs — it's updated on reconnect, unlike the closure's clientWs
              const ws = session.clientWs;
              if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ seq: session.seq, frame: responseFrame }));
                console.log('[Scratchy] ✅ Widget response sent');
              } else {
                console.error('[Scratchy] ❌ WS not open. State:', ws ? ws.readyState : 'null');
              }
            } catch(e) { console.error('[Scratchy] Send error:', e.message); }
          };

          const _sendOps = (result, _userInitiated = true) => {
            if (result && result.ops && result.ops.length > 0) {
              // Track canvas state per-session (multi-user isolation)
              for (const op of result.ops) _applySessionCanvasOp(session, op);
              // Send as canvas-update (not chat message) — direct to widget renderer,
              // no message bubble, no chat history noise, smooth in-place updates
              session.seq++;
              const updateFrame = {
                type: "event", event: "canvas-update",
                payload: { ops: result.ops, userInitiated: _userInitiated }
              };
              try {
                const ws = session.clientWs;
                if (ws && ws.readyState === 1) {
                  ws.send(JSON.stringify({ seq: session.seq, frame: updateFrame }));
                }
              } catch(e) { console.error('[Scratchy] _sendOps send error:', e.message); }
              // Broadcast canvas update to OTHER connected clients
              if (session._broadcastSessions) {
                for (const shared of session._broadcastSessions) {
                  if (shared !== session && shared.clientWs && shared.clientWs.readyState === 1) {
                    try {
                      shared.clientWs.send(JSON.stringify({
                        type: "event", event: "canvas-update",
                        payload: { ops: result.ops }
                      }));
                    } catch(e) {}
                  }
                }
              }
            } else {
              _sendToClient('⚠️ No response from widget');
            }
          };

          // Stop admin live push if switching to any non-admin widget
          if (!action.startsWith('admin-') && session._adminLiveInterval) {
            clearInterval(session._adminLiveInterval);
            session._adminLiveInterval = null;
            session._adminLiveView = null;
          }

          // Stop sub-agent live push if switching to any non-subagent widget
          if (!action.startsWith('subagent-') && session._subagentInterval) {
            clearInterval(session._subagentInterval);
            session._subagentInterval = null;
          }

          // Per-user widget state: extract userId for widget isolation
          const _widgetUserId = session._userInfo?.user?.id || '_legacy';

          // Phase 31: Intent validation — log mismatches (non-blocking)
          try {
            const intentResult = widgetRegionManager.matchIntent(action);
            if (intentResult.widget) {
              console.log(`[Widget] Intent: ${action} → ${intentResult.widget.name} (conf: ${intentResult.confidence.toFixed(2)})`);
            }
          } catch (_intentErr) { /* non-fatal */ }

          // Track active widget for reconnect restore
          _trackActiveWidget(session, action);

          // Route to the right widget based on action prefix

          // Gemini CLI OAuth — secure credential entry (never in chat)
          if (action.startsWith('gemini-')) {
            if (action === 'gemini-oauth-submit' && context.auth_code) {
              const code = context.auth_code.trim();
              if (!code) {
                _sendOps({ ops: [{ op: "upsert", id: "gemini-auth-result", type: "alert",
                  data: { title: "⚠️ Empty Code", message: "Please paste the authorization code from Google.", severity: "warning" },
                  layout: { zone: "auto" } }] });
                return;
              }
              // Basic format validation — Google OAuth codes start with "4/" and are 60-100 chars
              if (!code.startsWith('4/') || code.length < 20) {
                _sendOps({ ops: [{ op: "upsert", id: "gemini-auth-result", type: "alert",
                  data: { title: "⚠️ Invalid Format", message: "That doesn't look like a Google authorization code. It should start with '4/' and be fairly long.", severity: "warning" },
                  layout: { zone: "auto" } }] });
                return;
              }
              // Check for reused code — compare with last submitted code
              const codePath = '/tmp/.gemini-auth-code';
              const lastCodePath = '/tmp/.gemini-auth-code-last';
              const fs = require('fs');
              try {
                const lastCode = fs.existsSync(lastCodePath) ? fs.readFileSync(lastCodePath, 'utf-8').trim() : '';
                if (lastCode === code) {
                  _sendOps({ ops: [{ op: "upsert", id: "gemini-auth-result", type: "alert",
                    data: { title: "⚠️ Code Already Used", message: "This code was already submitted. Google auth codes are single-use — open the OAuth link again to get a fresh one.", severity: "warning" },
                    layout: { zone: "auto" } }] });
                  return;
                }
                // Save code + track last used
                fs.writeFileSync(codePath, code, { mode: 0o600 });
                fs.writeFileSync(lastCodePath, code, { mode: 0o600 });
                console.log('[Scratchy] 🔐 Gemini OAuth code saved to', codePath, '(' + code.length + ' chars)');
                _sendOps({ ops: [{ op: "upsert", id: "gemini-auth-result", type: "alert",
                  data: { title: "✅ Code Received", message: "Authorization code accepted. Exchanging for tokens...", severity: "success" },
                  layout: { zone: "auto" } }] });
              } catch (e) {
                console.error('[Scratchy] ❌ Failed to save OAuth code:', e.message);
                _sendOps({ ops: [{ op: "upsert", id: "gemini-auth-result", type: "alert",
                  data: { title: "❌ Error", message: "Failed to save code: " + e.message, severity: "error" },
                  layout: { zone: "auto" } }] });
              }
            } else {
              _sendOps({ ops: [{ op: "upsert", id: "gemini-unknown", type: "alert",
                data: { title: "⚠️ Unknown Action", message: "Unrecognized gemini action: " + action, severity: "warning" },
                layout: { zone: "auto" } }] });
            }
            return;
          }

          if (action.startsWith('sn-')) {
            // Standard Notes widget — clear require cache to pick up changes
            const modPath = require.resolve('./genui-engine/templates/notes.js');
            delete require.cache[modPath];
            const StandardNotesWidget = require('./genui-engine/templates/notes.js');
            if (!session._notesWidget) session._notesWidget = new StandardNotesWidget(_widgetUserId);
            // Hot-reload creds: if instance has no creds but disk file exists, re-read it.
            // Handles migration, manual credential placement, etc. without restart.
            if (!session._notesWidget.creds) session._notesWidget._loadSession();
            console.log('[Scratchy] 🔧 Calling widget.handleAction:', action, 'context keys:', Object.keys(context));
            session._notesWidget.handleAction(action, context)
              .then((result) => {
                console.log('[Scratchy] 📦 Widget result:', result ? (result.ops ? result.ops.length + ' ops' : 'no ops') : 'null');
                _sendOps(result);
              })
              .catch(e => {
                console.error('[Scratchy] ❌ Widget handleAction error:', e.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, e.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('⚠️ ' + e.message);
              });
          } else if (action.startsWith('mail-')) {
            // Email widget — always reload module for dev
            const mailModPath = require.resolve('./genui-engine/templates/email.js');
            delete require.cache[mailModPath];
            const EmailWidget = require('./genui-engine/templates/email.js');
            if (!session._emailWidget || !(session._emailWidget instanceof EmailWidget)) {
              session._emailWidget = new EmailWidget(_widgetUserId);
            }
            // Server-side invite handoff: inject stored invite data, never from client
            if (action === 'mail-compose-invite') {
              if (session._pendingInvite) {
                context = { ...context, ...session._pendingInvite };
                session._composePrefilledData = { ...session._pendingInvite };
                // Store return userId so we navigate back to user detail after send
                if (session._pendingInvite._returnUserId) {
                  session._composeReturnUserId = session._pendingInvite._returnUserId;
                }
                delete session._pendingInvite;
                console.log('[Scratchy] 🔐 Injected pending invite data server-side');
              }
              action = 'mail-compose'; // Default to Gmail (Resend not fully set up)
            }
            // Preserve prefilled data when switching between Gmail / Resend
            if ((action === 'mail-compose' || action === 'mail-compose-resend') && session._composePrefilledData) {
              if (!context.to && !context.subject && !context.body) {
                context = { ...context, ...session._composePrefilledData };
              }
            }
            // After sending invite email: clear prefill + return to user detail
            if (action === 'mail-gmail-send' || action === 'mail-resend-send') {
              const returnToUser = session._composeReturnUserId;
              delete session._composePrefilledData;
              delete session._composeReturnUserId;
              if (returnToUser) {
                // After send completes, trigger return to admin user detail
                const origSendOps = _sendOps;
                _sendOps = (result) => {
                  origSendOps(result);
                  // Show success briefly then navigate back to user detail
                  setTimeout(() => {
                    try {
                      const ws = session.clientWs;
                      if (ws && ws.readyState === 1) {
                        session.seq++;
                        ws.send(JSON.stringify({
                          seq: session.seq,
                          frame: { type: "event", event: "canvas-update", payload: { ops: [
                            { op: 'upsert', id: 'mail-sent-ok', type: 'alert', data: { title: '✅ Email Sent', message: 'Returning to user detail...', severity: 'success' }},
                            { op: 'trigger', action: 'admin-user-detail', context: { userId: returnToUser } }
                          ]}}
                        }));
                      }
                    } catch (e) { console.error('[Scratchy] Return-to-detail error:', e.message); }
                  }, 1500);
                };
              }
            }
            console.log('[Scratchy] 🔧 Calling email widget:', action);
            session._emailWidget.handleAction(action, context)
              .then((result) => {
                console.log('[Scratchy] 📦 Email result:', result ? (result.ops ? result.ops.length + ' ops' : 'no ops') : 'null');
                _sendOps(result);
              })
              .catch(e => {
                console.error('[Scratchy] ❌ Email error:', e.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, e.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('⚠️ ' + e.message);
              });
          } else if (action.startsWith('cal-')) {
            // Google Calendar widget
            const calModPath = require.resolve('./genui-engine/templates/calendar.js');
            delete require.cache[calModPath];
            const GoogleCalendarWidget = require('./genui-engine/templates/calendar.js');
            if (!session._calendarWidget) session._calendarWidget = new GoogleCalendarWidget(_widgetUserId);
            console.log('[Scratchy] 🔧 Calling calendar widget:', action);
            session._calendarWidget.handleAction(action, context)
              .then((result) => {
                console.log('[Scratchy] 📦 Calendar result:', result ? (result.ops ? result.ops.length + ' ops' : 'no ops') : 'null');
                _sendOps(result);
              })
              .catch(e => {
                console.error('[Scratchy] ❌ Calendar error:', e.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, e.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('⚠️ ' + e.message);
              });
          } else if (action.startsWith('admin-')) {
            // ── SECURITY: Admin actions require admin role ──
            const userRole = session._userInfo?.user?.role;
            if (userRole && userRole !== 'admin' && !session._userInfo?.isLegacy) {
              console.log(`[Scratchy] ⛔ Admin action blocked for ${session._userInfo?.user?.email} (role: ${userRole})`);
              _sendOps({ ops: [{ op: 'upsert', id: 'access-denied', type: 'alert', data: {
                title: '⛔ Access Denied', message: 'Admin actions require administrator privileges.', severity: 'error'
              }}]});
              return;
            }
            // Phase 30: Analytics dashboard — route admin-analytics* to dedicated widget
            if (action.startsWith('admin-analytics') && analytics) {
              const AnalyticsDashboard = require('./genui-engine/templates/analytics-dashboard.js');
              if (!session._analyticsDashboard) {
                session._analyticsDashboard = new AnalyticsDashboard({ analyticsSystem: analytics, usageQuery });
              }
              // Refresh user name map on every action (picks up new users)
              try {
                const _nameMap = {};
                const _allUsers = userStore.listUsers();
                for (const u of _allUsers) _nameMap[u.id] = u.displayName || u.email || u.id;
                session._analyticsDashboard._userNameMap = _nameMap;
              } catch(_) {}
              // Clear live interval BEFORE async call to prevent race condition:
              // Old interval pushes admin ops while analytics response is pending,
              // which steals _pendingActionRegion on the client → analytics creates
              // a new widget region instead of reusing the admin one → unwanted scroll.
              if (session._adminLiveInterval) {
                clearInterval(session._adminLiveInterval);
                session._adminLiveInterval = null;
              }
              session._analyticsDashboard.handleAction(action, context)
                .then((result) => {
                  console.log('[Scratchy] 📦 Analytics dashboard result:', result ? (result.ops ? result.ops.length + ' ops' : 'no ops') : 'null');
                  _sendOps(result);

                  // Start live push for any analytics view (multi-tier cadence handled by dashboard)
                  if (action.startsWith('admin-analytics') && session._analyticsDashboard.getLiveUpdate) {
                    session._adminLiveView = action;
                    session._activeWidget = 'admin-analytics';
                    session._adminLiveInterval = setInterval(() => {
                      try {
                        const ws = session.clientWs;
                        if (!ws || ws.readyState !== 1) {
                          clearInterval(session._adminLiveInterval);
                          session._adminLiveInterval = null;
                          return;
                        }
                        // Stop if another widget took over (e.g. sub-agent monitor)
                        if (session._activeWidget && session._activeWidget !== 'admin-analytics') {
                          clearInterval(session._adminLiveInterval);
                          session._adminLiveInterval = null;
                          console.log('[Scratchy] ⏸️ Admin analytics live tick stopped (widget switch)');
                          return;
                        }
                        const update = session._analyticsDashboard.getLiveUpdate();
                        if (update && update.ops && update.ops.length > 0) {
                          for (const op of update.ops) { if (op && op.op) _applySessionCanvasOp(session, op); }
                          session.seq++;
                          ws.send(JSON.stringify({
                            seq: session.seq,
                            frame: { type: "event", event: "canvas-update", payload: { ops: update.ops } }
                          }));
                        }
                      } catch (e) {
                        console.error('[Scratchy] Analytics live push error:', e.message);
                      }
                    }, 3000);
                    console.log('[Scratchy] 📡 Analytics live push started');
                  }
                })
                .catch(e => {
                  console.error('[Scratchy] ❌ Analytics dashboard error:', e.message);
                  if (analytics) try { analytics.collectors.error.onWidgetError(action, e.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                  _sendToClient('⚠️ ' + e.message);
                });
              return; // Don't fall through to admin widget
            }

            // Admin dashboard widget
            const AdminWidget = require('./genui-engine/templates/admin.js');
            if (!session._adminWidget) {
              session._adminWidget = new AdminWidget({
                userStore: authSystem?.userStore,
                sessionStore: authSystem?.sessionStore,
                quotaStore: authSystem?.quotaStore,
                usageQuery: usageQuery,
                previewSessions,
                versionStore,
              });
              // Inject WS connections map for live monitoring
              if (wsSessions) session._adminWidget.setConnections(wsSessions);
            }

            // ── Real-time admin: manage live push subscription ──
            const LIVE_VIEWS = ['admin-dashboard', 'admin-monitor', 'admin-quotas', 'admin-providers', 'admin-analytics'];
            const isLiveView = LIVE_VIEWS.includes(action);

            // Clear existing live interval if navigating away or to a different view
            if (session._adminLiveInterval) {
              clearInterval(session._adminLiveInterval);
              session._adminLiveInterval = null;
              session._adminLiveView = null;
            }

            // Inject userId for preview toggle
            if (action === 'admin-toggle-preview') {
              context.userId = session._userInfo?.user?.id;
            }

            session._adminWidget.handleAction(action, context)
              .then((result) => {
                console.log('[Scratchy] 📦 Admin result:', result ? (result.ops ? result.ops.length + ' ops' : 'no ops') : 'null');
                if (result && result.ops) {
                  for (const op of result.ops) {
                    // Admin op logging removed (was diagnostic)
                  }
                }
                // Store pending invite data server-side (password never touches WS)
                if (result && result.pendingInvite) {
                  session._pendingInvite = result.pendingInvite;
                  console.log('[Scratchy] 🔐 Pending invite stored server-side for', result.pendingInvite.to);
                }
                // Handle sub-agent monitor trigger from admin widget
                if (result && result._triggerSubagentMonitor) {
                  // Activate sub-agent monitor the same way sessions_spawn does
                  try {
                    const subMonPath = require.resolve('./genui-engine/templates/subagent-monitor.js');
                    delete require.cache[subMonPath];
                    const SubagentMonitor = require('./genui-engine/templates/subagent-monitor.js');
                    if (!session._subagentMonitor) {
                      session._subagentMonitor = new SubagentMonitor();
                      session._subagentMonitor.setPushFn((ops) => {
                        const ws2 = session.clientWs;
                        if (!ws2 || ws2.readyState !== 1) return;
                        if (session._activeWidget !== 'subagent-monitor') return;
                        for (const op of ops) { if (op && op.op) _applySessionCanvasOp(session, op); }
                        session.seq++;
                        ws2.send(JSON.stringify({ seq: session.seq, frame: { type: "event", event: "canvas-update", payload: { ops } } }));
                      });
                    }
                    session._activeWidget = 'subagent-monitor';
                    if (session._adminLiveInterval) { clearInterval(session._adminLiveInterval); session._adminLiveInterval = null; }
                    session._subagentMonitor.handleAction('subagent-monitor', {}).then((smResult) => {
                      _sendOps(smResult);
                      if (smResult && smResult._noPoll) return; // Nothing to track
                      if (session._subagentInterval) { clearInterval(session._subagentInterval); session._subagentInterval = null; }
                      session._subagentInterval = setInterval(() => {
                        try {
                          const ws3 = session.clientWs;
                          if (!ws3 || ws3.readyState !== 1) { clearInterval(session._subagentInterval); session._subagentInterval = null; return; }
                          if (session._activeWidget !== 'subagent-monitor') { clearInterval(session._subagentInterval); session._subagentInterval = null; return; }
                          const update = session._subagentMonitor.getLiveUpdate();
                          if (update && update.ops && update.ops.length > 0) {
                            for (const op of update.ops) { if (op && op.op) _applySessionCanvasOp(session, op); }
                            session.seq++;
                            ws3.send(JSON.stringify({ seq: session.seq, frame: { type: "event", event: "canvas-update", payload: { ops: update.ops } } }));
                          }
                          if (update && update.done) {
                            clearInterval(session._subagentInterval);
                            session._subagentInterval = null;
                            session._activeWidget = null;
                            // Clear stale sa-* from canvas state
                            if (session._canvasState) {
                              const saKeys = [];
                              for (const [id] of session._canvasState) { if (id.startsWith('sa-')) saKeys.push(id); }
                              for (const k of saKeys) session._canvasState.delete(k);
                              if (saKeys.length > 0) {
                                _persistUserCanvasState(session);
                                console.log('[Scratchy] Cleared ' + saKeys.length + ' stale sa-* after admin sub-agent monitor completion');
                              }
                            }
                          }
                        } catch (e) { clearInterval(session._subagentInterval); session._subagentInterval = null; }
                      }, 3000);
                    }).catch(e => console.error('[Scratchy] Sub-agent monitor trigger error:', e.message));
                  } catch (e) { console.error('[Scratchy] Sub-agent monitor init error:', e.message); }
                  return; // Don't continue to admin live push
                }

                _sendOps(result);

                // Start live push for subscribable views
                if (isLiveView && session._adminWidget.getLiveUpdate) {
                  session._adminLiveView = action;
                  session._activeWidget = 'admin-' + action;
                  session._adminLiveInterval = setInterval(() => {
                    try {
                      const ws = session.clientWs;
                      if (!ws || ws.readyState !== 1) {
                        clearInterval(session._adminLiveInterval);
                        session._adminLiveInterval = null;
                        return;
                      }
                      // Stop if another widget took over (e.g. sub-agent monitor)
                      if (session._activeWidget && !session._activeWidget.startsWith('admin-')) {
                        clearInterval(session._adminLiveInterval);
                        session._adminLiveInterval = null;
                        console.log('[Scratchy] ⏸️ Admin live tick stopped (widget switch to ' + session._activeWidget + ')');
                        return;
                      }
                      const update = session._adminWidget.getLiveUpdate(session._adminLiveView);
                      console.log('[Scratchy] 📡 Live tick:', session._adminLiveView, update ? (update.ops ? update.ops.length + ' ops' : 'no ops') : 'null');
                      if (update && update.ops && update.ops.length > 0) {
                        // Track per-session canvas state (multi-user isolation)
                        for (const op of update.ops) {
                          if (!op || !op.op) continue;
                          _applySessionCanvasOp(session, op);
                        }
                        session.seq++;
                        ws.send(JSON.stringify({
                          seq: session.seq,
                          frame: {
                            type: "event",
                            event: "canvas-update",
                            payload: { ops: update.ops }
                          }
                        }));
                      }
                    } catch (e) {
                      console.error('[Scratchy] Admin live push error:', e.message);
                    }
                  }, 3000);
                  console.log('[Scratchy] 📡 Admin live push started for:', action);
                }
              })
              .catch(e => {
                console.error('[Scratchy] ❌ Admin error:', e.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, e.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('⚠️ ' + e.message);
              });
          } else if (action.startsWith('account-')) {
            // ── Account widget (non-admin users) ──
            try {
              const accPath = require.resolve('./genui-engine/templates/account.js');
              delete require.cache[accPath];
              const AccountWidget = require('./genui-engine/templates/account.js');
              if (!session._accountWidget) {
                session._accountWidget = new AccountWidget({ userStore });
              }
              const userId = session._userInfo?.user?.id;
              session._accountWidget.handleAction(action, { ...context, userId })
                .then((result) => {
                  _sendOps(result);
                })
                .catch(e => {
                  console.error('[Scratchy] Account widget error:', e.message);
                  _sendToClient('⚠️ ' + e.message);
                });
            } catch (e) {
              console.error('[Scratchy] Account widget init error:', e.message);
              _sendToClient('⚠️ Account widget error: ' + e.message);
            }
          } else if (action.startsWith('subagent-')) {
            // ── Sub-agent monitor widget ──
            // Only hot-reload on initial action — detail/back/stop must reuse existing instance
            const subMonPath = require.resolve('./genui-engine/templates/subagent-monitor.js');
            if (action === 'subagent-monitor') {
              delete require.cache[subMonPath];
            }
            const SubagentMonitor = require('./genui-engine/templates/subagent-monitor.js');

            const _initSubagentMonitor = () => {
              session._subagentMonitor = new SubagentMonitor();
              session._subagentMonitor.setPushFn((ops) => {
                try {
                  const ws = session.clientWs;
                  if (!ws || ws.readyState !== 1) return;
                  for (const op of ops) {
                    if (op && op.op) _applySessionCanvasOp(session, op);
                  }
                  session.seq++;
                  ws.send(JSON.stringify({
                    seq: session.seq,
                    frame: { type: "event", event: "canvas-update", payload: { ops } }
                  }));
                } catch (e) {
                  console.error('[Scratchy] Sub-agent live push error:', e.message);
                }
              });
            };

            if (action === 'subagent-monitor' || !session._subagentMonitor) {
              _initSubagentMonitor();
              // For non-initial actions after reconnect: bootstrap with auto-discovery
              // so detail/back can find sessions even if the WS reconnected
              if (action !== 'subagent-monitor') {
                session._subagentMonitor.handleAction('subagent-monitor', { live: true });
                console.log('[Scratchy] 🔄 Sub-agent monitor auto-recovered after reconnect');
              }
            }

            // Stop admin live interval when sub-agent monitor activates
            if (action === 'subagent-monitor' && session._adminLiveInterval) {
              clearInterval(session._adminLiveInterval);
              session._adminLiveInterval = null;
              session._adminLiveView = null;
            }

            // Clear existing sub-agent interval if navigating
            if (session._subagentInterval) {
              clearInterval(session._subagentInterval);
              session._subagentInterval = null;
            }

            // Enable live mode for admin users
            const _saUserRole = session._userInfo?.user?.role;
            if (action === 'subagent-monitor' && (_saUserRole === 'admin' || session._userInfo?.isLegacy)) {
              context.live = true;
            }

            session._subagentMonitor.handleAction(action, context)
              .then((result) => {
                console.log('[Scratchy] 📦 Sub-agent result:', result ? (result.ops ? result.ops.length + ' ops' : 'no ops') : 'null');
                _sendOps(result);

                // Start live polling for subagent-monitor (skip if nothing to track)
                if (action === 'subagent-monitor' && !(result && result._noPoll)) {
                  session._subagentInterval = setInterval(() => {
                    try {
                      const ws = session.clientWs;
                      if (!ws || ws.readyState !== 1) {
                        clearInterval(session._subagentInterval);
                        session._subagentInterval = null;
                        return;
                      }
                      const update = session._subagentMonitor.getLiveUpdate();
                      if (update && update.ops && update.ops.length > 0) {
                        // Track per-session canvas state (multi-user isolation)
                        for (const op of update.ops) {
                          if (!op || !op.op) continue;
                          _applySessionCanvasOp(session, op);
                        }
                        session.seq++;
                        ws.send(JSON.stringify({
                          seq: session.seq,
                          frame: {
                            type: "event",
                            event: "canvas-update",
                            payload: { ops: update.ops }
                          }
                        }));
                      }
                      // Auto-stop when all agents done
                      if (update && update.done) {
                        clearInterval(session._subagentInterval);
                        session._subagentInterval = null;
                      }
                    } catch (e) {
                      console.error('[Scratchy] Sub-agent monitor live push error:', e.message);
                      clearInterval(session._subagentInterval);
                      session._subagentInterval = null;
                    }
                  }, 3000);
                  console.log('[Scratchy] 📡 Sub-agent monitor live push started');
                }

                // Stop monitoring
                if (action === 'subagent-stop') {
                  if (session._subagentInterval) {
                    clearInterval(session._subagentInterval);
                    session._subagentInterval = null;
                  }
                }
              })
              .catch(e => {
                console.error('[Scratchy] ❌ Sub-agent monitor error:', e.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, e.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('⚠️ ' + e.message);
              });
          } else if (action.startsWith('yt-') || action.startsWith('ytm-')) {
            // ── YouTube / YouTube Music widget (v3 — OAuth) ──
            const ytModPath = require.resolve('./genui-engine/templates/youtube-v3.js');
            delete require.cache[ytModPath];
            const YouTubeWidget = require('./genui-engine/templates/youtube-v3.js');
            if (!session._youtubeWidget || !(session._youtubeWidget instanceof YouTubeWidget)) {
              const _ytUserId = session._userInfo?.user?.id || '_legacy';
              session._youtubeWidget = new YouTubeWidget(_ytUserId);
            }
            session._youtubeWidget.handleAction(action, context)
              .then(_sendOps)
              .catch((err) => {
                console.error('[Scratchy] YouTube error:', err.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, err.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('⚠️ ' + err.message);
              });
          } else if (action.startsWith('spotify-')) {
            // ── Spotify widget ──
            const spModPath = require.resolve('./genui-engine/templates/spotify-v2.js');
            delete require.cache[spModPath];
            const SpotifyWidget = require('./genui-engine/templates/spotify-v2.js');
            if (!session._spotifyWidget || !(session._spotifyWidget instanceof SpotifyWidget)) {
              session._spotifyWidget = new SpotifyWidget({
                clientId: process.env.SPOTIFY_CLIENT_ID || null,
                clientSecret: process.env.SPOTIFY_CLIENT_SECRET || null,
                userId: _widgetUserId
              });
            }
            session._spotifyWidget.handleAction(action, context)
              .then(_sendOps)
              .catch((err) => {
                console.error('[Scratchy] Spotify error:', err.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, err.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('⚠️ ' + err.message);
              });
          } else if (action.startsWith('deploy-')) {
            // ── SECURITY: Deploy actions require admin role ──
            const deployUserRole = session._userInfo?.user?.role;
            if (deployUserRole && deployUserRole !== 'admin' && !session._userInfo?.isLegacy) {
              console.log(`[Scratchy] ⛔ Deploy action blocked for ${session._userInfo?.user?.email} (role: ${deployUserRole})`);
              _sendOps({ ops: [{ op: 'upsert', id: 'access-denied', type: 'alert', data: {
                title: '⛔ Access Denied', message: 'Deploy actions require administrator privileges.', severity: 'error'
              }}]});
              return;
            }
            // Deploy Manager widget (Phase 25)
            const DeployManagerWidget = require('./genui-engine/templates/deploy-manager.js');
            if (!session._deployWidget) {
              session._deployWidget = new DeployManagerWidget({
                versionStore,
                userStore: authSystem?.userStore,
              });
            }
            session._deployWidget.handleAction(action, context)
              .then((result) => {
                console.log('[Scratchy] 📦 Deploy result:', result ? (result.ops ? result.ops.length + ' ops' : 'no ops') : 'null');
                _sendOps(result);
              })
              .catch((err) => {
                console.error('[Scratchy] Deploy manager error:', err.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, err.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('⚠️ ' + err.message);
              });
          } else if (action.startsWith('onboard-')) {
            // ── Onboarding wizard widget ──
            const onbModPath = require.resolve('./genui-engine/templates/onboarding.js');
            delete require.cache[onbModPath];
            const OnboardingWidget = require('./genui-engine/templates/onboarding.js');
            if (!session._onboardingWidget) {
              session._onboardingWidget = new OnboardingWidget({
                userStore: authSystem?.userStore,
              });
            }

            // Inject userId so onboarding can persist onboardingComplete
            context.userId = session._userInfo?.user?.id;

            session._onboardingWidget.handleAction(action, context)
              .then((result) => {
                _sendOps(result);

                // After onboard-dismiss: switch client to chat view
                if (result && result.switchToChat && session.clientWs && session.clientWs.readyState === 1) {
                  try {
                    session.clientWs.send(JSON.stringify({ type: 'switch-view', view: 'chat' }));
                  } catch(e) {}
                }

                // After onboarding complete: send a welcome message through the gateway
                if (result && result.welcomeChat && session.gatewayWs && session.gatewayWs.readyState === 1) {
                  const welcomeName = result.welcomeName || 'there';
                  const welcomeMsg = `[Operator Session — ${welcomeName}]\nFollow the "Multi-User Sessions" instructions in TOOLS.md.\nThis user just completed onboarding — it is your first meeting. Introduce yourself warmly, explain what you can help with (chat, calendar, email, notes, web search, music, coding). Ask them what they would like to call you. Be welcoming but concise.`;
                  // Determine the user's session key for routing
                  const userId = session._userInfo?.user?.id;
                  const isAdmin = session._userInfo?.user?.role === 'admin' || session._userInfo?.isLegacy;
                  const userSessionKey = (userId && !isAdmin)
                    ? 'agent:main:webchat:' + userId
                    : 'agent:main:main';
                  setTimeout(() => {
                    try {
                      const reqId = 'welcome-' + Date.now();
                      session.gatewayWs.send(JSON.stringify({
                        type: 'req',
                        id: reqId,
                        method: 'chat.send',
                        params: {
                          sessionKey: userSessionKey,
                          message: welcomeMsg,
                          idempotencyKey: reqId,
                        },
                      }));
                      console.log(`[Scratchy] 🎉 Welcome chat triggered for ${welcomeName} (session: ${userSessionKey})`);
                    } catch (e) {
                      console.error('[Scratchy] Welcome chat error:', e.message);
                    }
                  }, 2000); // 2s delay to let canvas render first
                }
              })
              .catch((err) => {
                console.error('[Scratchy] Onboarding error:', err.message);
                if (analytics) try { analytics.collectors.error.onWidgetError(action, err.message, session._userInfo?.user?.id || '_legacy', session.clientId); } catch(_) {}
                _sendToClient('Onboarding error: ' + err.message);
              });
          } else if (!action || action === 'unknown') {
            // Empty/unknown action — dismiss canvas (e.g. "Start Chatting" button)
            _sendOps({ ops: [{ op: 'clear' }] });
          } else if (ScratchyCompleteIntegration) {
            // Generic widget routing via ecosystem
            const safeContent = '[UserAction] ' + JSON.stringify({ action });
            ScratchyCompleteIntegration.processMessage(safeContent, {
              sessionKey: frame.sessionKey || 'agent:main:main',
              timestamp: Date.now(), isUserAction: true,
              secureContext: context
            }).then(_sendOps).catch(e => _sendToClient('⚠️ ' + e.message));
          } else {
            _sendToClient('⚠️ No widget handler for: ' + action);
          }
          
          return; // NEVER forward to gateway
        }
      } catch(e) {
        console.error('[Scratchy] Error parsing widget-action:', e.message);
      }
    }

    // Phase 19: Quota check before forwarding to gateway
    if (wsIsolator && session._userInfo && raw.includes('"chat.send"')) {
      const quotaCheck = wsIsolator.checkMessageQuota(session._userInfo);
      if (!quotaCheck.allowed) {
        console.log(`[Scratchy] ⛔ Message blocked for ${session._userInfo.user?.email}: ${quotaCheck.reason}`);
        // Send error back to client as a synthetic agent message
        session.seq++;
        const errorFrame = {
          type: "event", event: "chat",
          payload: { state: "final", message: `⚠️ ${quotaCheck.reason}` }
        };
        session.buffer.push({ seq: session.seq, frame: errorFrame });
        if (session.clientWs && session.clientWs.readyState === 1) {
          try { session.clientWs.send(JSON.stringify({ seq: session.seq, frame: errorFrame })); } catch(e) {}
        }
        return; // Don't forward to gateway
      }
      // Record the message
      wsIsolator.recordMessage(session._userInfo);

      // Session routing is handled by session-isolation.js rewriteOutboundFrame (below)
      // which already rewrites sessionKey for non-admin users while bypassing admins.

      // ── SECURITY: Inject role constraints for non-admin users ──
      const userRole = session._userInfo?.user?.role;
      if (userRole && userRole !== 'admin' && !session._userInfo?.isLegacy) {
        try {
          const chatFrame = JSON.parse(raw);
          if (chatFrame.type === 'req' && chatFrame.method === 'chat.send' && chatFrame.params?.message) {
            const quota = authSystem?.quotaStore?.getEffectiveQuota(session._userInfo.user) || {};
            const blocked = (quota.toolsBlacklist || []).join(', ') || 'none';
            const models = (quota.allowedModels || []).join(', ') || 'any';
            const userName = session._userInfo.user.displayName || session._userInfo.user.email;

            // ── Per-user persistent memory ──
            let userMemory = '';
            try {
              const userId = session._userInfo.user.id;
              const memPath = require('path').join(__dirname, '.scratchy-data', 'user-memory', userId, 'context.md');
              if (fs.existsSync(memPath)) {
                userMemory = fs.readFileSync(memPath, 'utf-8').trim();
              }
            } catch (_e) { /* no user memory — that's fine */ }

            // ── Operator session context ──
            // References TOOLS.md "Multi-User Sessions" section (system-level).
            // Keep this block minimal — the agent already knows the rules from TOOLS.md.
            const memFilePath = require('path').join(__dirname, '.scratchy-data', 'user-memory', session._userInfo.user.id, 'context.md');
            const _ua = session._userAgent || '';
            const _isMobile = /Mobile|Android|iPhone|iPad/i.test(_ua);
            const _isTablet = /iPad|Android(?!.*Mobile)/i.test(_ua);
            const _deviceType = _isTablet ? 'tablet' : _isMobile ? 'mobile' : 'desktop';
            chatFrame.params.message = `[Operator Session — ${userName}]\n`
              + `Follow the "Multi-User Sessions" instructions in TOOLS.md.\n`
              + `User: "${userName}" (role: ${userRole})\n`
              + `Allowed models: ${models}\n`
              + `Blocked tools: ${blocked}, memory_search, memory_get\n`
              + `Device: ${_deviceType}${_isTablet ? ' (tablet)' : _isMobile ? ' (mobile)' : ''}\n`
              + `Canvas hint: ${_isMobile ? 'max 4-5 tiles, single column' : _isTablet ? 'max 6 tiles' : 'max 8 tiles'}\n`
              + (userMemory
                ? `\n[User Memory — loaded from persistent storage]\n`
                  + `Update this file to remember things across sessions: ${memFilePath}\n`
                  + userMemory + `\n`
                : `\nNo persistent memory for this user yet. Create one at: ${memFilePath}\n`)
              + `[End Operator Session]\n\n`
              + chatFrame.params.message;

            raw = JSON.stringify(chatFrame);
          }
        } catch(e) {
          console.error('[Scratchy] Security injection error:', e.message);
        }
      }
    }

    // Phase 26: Session isolation — rewrite outbound frames (sessionKey injection)
    if (sessionIsolation && session._userInfo) {
      try {
        raw = sessionIsolation.rewriteOutboundFrame(raw, session._userInfo).raw;
      } catch (e) {
        console.error('[Scratchy] Session isolation outbound rewrite error:', e.message);
      }
    }

    // Phase 29: Broadcast user message to other devices of the same user
    try {
      if (raw.includes('"chat.send"')) {
        const _csUserId = session._syncUserId || session._userInfo?.user?.id || (session._userInfo?.isLegacy ? '_admin' : null);
        if (_csUserId && deviceSync.getDeviceCount(_csUserId) > 1) {
          const _csFrame = JSON.parse(raw);
          if (_csFrame.type === 'req' && _csFrame.method === 'chat.send' && _csFrame.params?.message) {
            deviceSync.broadcastUserMessage(_csUserId, _csFrame.params.message, _csFrame.params.attachments, session);
          }
        }
      }
    } catch (e) { /* sync broadcast failure is non-fatal */ }

    // Phase 30: Track user messages in analytics
    if (analytics && raw.includes('"chat.send"')) {
      try {
        const _aFrame = JSON.parse(raw);
        if (_aFrame.type === 'req' && _aFrame.method === 'chat.send' && _aFrame.params?.message) {
          const _aUserId = session._userInfo?.user?.id || '_legacy';
          const _aSessionId = session.clientId;
          analytics.collectors.conversation.onUserMessage(_aUserId, _aFrame.params.message, 'webchat', _aSessionId);
        }
      } catch(e) { /* analytics is non-fatal */ }
    }

    // Forward all other messages to gateway
    if (session.gatewayWs && session.gatewayWs.readyState === WebSocketClient.OPEN) {
      try { session.gatewayWs.send(raw); } catch(e) {}
    }
  });

  clientWs.on("close", (code, reason) => {
    if (session._pingInterval) { clearInterval(session._pingInterval); session._pingInterval = null; }
    session.clientWs = null;

    // Don't start a grace timer if this session was already cleaned up
    // (e.g., gateway closed first → _cleanupSession already ran → this is a stale close event)
    const current = wsSessions.get(session.clientId);
    if (current !== session) {
      console.log(`[Scratchy] Client disconnected — clientId=${session.clientId.slice(0,8)}… code=${code} — session already cleaned up, skipping grace timer`);
      return;
    }

    console.log(`[Scratchy] Client disconnected — clientId=${session.clientId.slice(0,8)}… code=${code} — starting ${WS_GRACE_PERIOD/1000}s grace period`);

    // Start grace timer — keep gateway WS alive
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = setTimeout(() => {
      // Double-check we're still the active session for this clientId
      if (wsSessions.get(session.clientId) !== session) return;
      console.log(`[Scratchy] Grace period expired for clientId=${session.clientId.slice(0,8)}… — closing gateway WS`);
      _cleanupSession(session.clientId, "grace period expired");
    }, WS_GRACE_PERIOD);
  });

  clientWs.on("error", (err) => {
    console.error(`[Scratchy] Client WS error:`, err.message);
  });
}

function _trimBuffer(session) {
  while (session.buffer.length > WS_BUFFER_MAX) {
    session.buffer.shift();
  }
}

function _cleanupSession(clientId, reason) {
  const session = wsSessions.get(clientId);
  if (!session) return;

  // Phase 29: Unregister from cross-device sync
  deviceSync.unregisterSession(session);

  if (session.graceTimer) clearTimeout(session.graceTimer);
  if (session._adminLiveInterval) {
    clearInterval(session._adminLiveInterval);
    session._adminLiveInterval = null;
  }
  if (session._subagentInterval) {
    clearInterval(session._subagentInterval);
    session._subagentInterval = null;
  }
  if (session.gatewayWs) {
    try { session.gatewayWs.close(1000, reason); } catch(e) {}
  }
  if (session.clientWs) {
    try { session.clientWs.close(1000, reason); } catch(e) {}
  }
  // Phase 30: Track session end
  if (analytics) {
    try {
      const _sUserId = session._userInfo?.user?.id || '_legacy';
      analytics.collectors.session.onSessionEnd(_sUserId, reason, 0);
    } catch(e) { /* analytics non-fatal */ }
  }

  wsSessions.delete(clientId);
  console.log(`[Scratchy] Session cleaned up — clientId=${clientId.slice(0,8)}… reason=${reason}`);
}

// ── Legacy raw pipe proxy (no clientId) ──
function _legacyPipeProxy(req, socket, head) {
  console.log("[Scratchy] WS upgrade authorized — legacy pipe proxy");

  const proxyHeaders = {
    "Host": req.headers.host || "localhost",
    "Connection": "Upgrade",
    "Upgrade": "websocket",
    "Sec-WebSocket-Version": req.headers["sec-websocket-version"] || "13",
    "Sec-WebSocket-Key": req.headers["sec-websocket-key"],
  };
  if (req.headers["sec-websocket-extensions"]) {
    proxyHeaders["Sec-WebSocket-Extensions"] = req.headers["sec-websocket-extensions"];
  }
  if (req.headers["sec-websocket-protocol"]) {
    proxyHeaders["Sec-WebSocket-Protocol"] = req.headers["sec-websocket-protocol"];
  }

  const proxyReq = http.request({
    host: "127.0.0.1",
    port: GATEWAY_PORT,
    path: "/",
    method: "GET",
    headers: proxyHeaders,
  });

  proxyReq.on("upgrade", (proxyRes, gatewaySocket, proxyHead) => {
    console.log("[Scratchy] Gateway upgrade OK — piping sockets");

    let responseHeaders = "HTTP/1.1 101 Switching Protocols\r\n";
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value) responseHeaders += `${key}: ${value}\r\n`;
    }
    responseHeaders += "\r\n";

    socket.write(responseHeaders);
    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) gatewaySocket.write(head);

    socket.pipe(gatewaySocket);
    gatewaySocket.pipe(socket);

    socket.on("error", () => gatewaySocket.destroy());
    gatewaySocket.on("error", () => socket.destroy());
    socket.on("close", () => gatewaySocket.destroy());
    gatewaySocket.on("close", () => socket.destroy());
  });

  proxyReq.on("response", (res) => {
    console.error("[Scratchy] Gateway refused upgrade, status:", res.statusCode);
    socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`);
    socket.destroy();
  });

  proxyReq.on("error", (err) => {
    console.error("[Scratchy] Gateway proxy error:", err.message);
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
  });

  proxyReq.end();
}

// ── Phase 3: Complete Widget Ecosystem Processing ──
function processGenUIIfNeeded(frame, callback) {
  // Only process assistant messages with text content OR user messages (for UserActions)
  if (!frame || frame.type !== "event" || !frame.payload) {
    return callback(null);
  }

  // Handle user messages (UserActions from widget buttons)
  if (frame.event === "user.message") {
    const content = frame.payload.text || frame.payload.content;
    if (content && content.includes('[UserAction]')) {
      handleUserAction(content, frame, callback);
      return;
    }
    return callback(null);
  }

  // Handle assistant messages for enhancement
  if (frame.event !== "agent.message") {
    return callback(null);
  }

  const content = frame.payload.content;
  if (!content || typeof content !== "string") {
    return callback(null);
  }

  // Skip if widget ecosystem not available
  if (!ScratchyCompleteIntegration) {
    console.log("[Scratchy] 🌐 Widget ecosystem not available, skipping processing");
    return callback(null);
  }

  // Skip if message already has scratchy-ui, scratchy-canvas, or scratchy-toon blocks (avoid double processing)
  if (/```scratchy-(?:ui|canvas|toon|tpl)/.test(content)) {
    return callback(null);
  }

  // Skip very short messages (likely not worth processing)
  if (content.length < 15) {
    return callback(null);
  }

  const startTime = Date.now();
  console.log(`[Scratchy] 🧠 Processing through widget ecosystem (${content.length} chars)...`);

  // Process through complete widget ecosystem
  ScratchyCompleteIntegration.processMessage(content, {
    sessionKey: frame.payload.sessionKey || 'unknown',
    timestamp: Date.now()
  }, (status) => {
    // Log status updates
    if (status && status.message) {
      console.log(`[Scratchy] 🌐 ${status.message}`);
    }
  }).then((result) => {
    const processingTime = Date.now() - startTime;
    
    if (result && result.ops && result.ops.length > 0) {
      console.log(`[Scratchy] ✨ Enhanced message: Tier ${result.tier}, ${result.ops.length} components, ${processingTime}ms`);
      console.log(`[Scratchy] 📊 Layout: ${result.layoutType}, Source: ${result.source}`);
      
      // Create enhanced message with scratchy-canvas block
      const canvasBlock = '```scratchy-canvas\n' + 
        result.ops.map(op => JSON.stringify(op)).join('\n') + 
        '\n```';
      
      const enhancedContent = content + '\n\n' + canvasBlock;
      
      // Create enhanced frame
      const enhancedFrame = {
        ...frame,
        payload: {
          ...frame.payload,
          content: enhancedContent
        }
      };
      
      callback(enhancedFrame);
    } else {
      console.log(`[Scratchy] 🌐 No enhancement needed (${processingTime}ms)`);
      callback(null);
    }
  }).catch((error) => {
    const processingTime = Date.now() - startTime;
    console.error(`[Scratchy] ❌ Widget ecosystem error (${processingTime}ms):`, error);
    callback(null); // Fall back to original message
  });
}

// ── Handle UserAction Events from Widget Buttons ──
function handleUserAction(content, frame, callback) {
  if (!ScratchyCompleteIntegration) {
    return callback(null);
  }

  const startTime = Date.now();
  console.log(`[Scratchy] 🎯 Processing UserAction...`);

  ScratchyCompleteIntegration.processMessage(content, {
    sessionKey: frame.payload.sessionKey || 'unknown',
    timestamp: Date.now(),
    isUserAction: true
  }).then((result) => {
    const processingTime = Date.now() - startTime;
    
    if (result && result.ops && result.ops.length > 0) {
      console.log(`[Scratchy] ⚡ UserAction completed: ${result.ops.length} components, ${processingTime}ms`);
      
      // Create response message with canvas operations
      const canvasBlock = '```scratchy-canvas\n' + 
        result.ops.map(op => JSON.stringify(op)).join('\n') + 
        '\n```';
      
      // Create a synthetic agent message frame to display the widget response
      const responseFrame = {
        type: "event",
        event: "agent.message",
        payload: {
          content: canvasBlock,
          sessionKey: frame.payload.sessionKey,
          timestamp: Date.now()
        }
      };
      
      callback(responseFrame);
    } else {
      console.log(`[Scratchy] 🎯 UserAction: No response needed (${processingTime}ms)`);
      callback(null);
    }
  }).catch((error) => {
    const processingTime = Date.now() - startTime;
    console.error(`[Scratchy] ❌ UserAction error (${processingTime}ms):`, error);
    
    // Create error response
    const errorFrame = {
      type: "event", 
      event: "agent.message",
      payload: {
        content: `⚠️ Action failed: ${error.message}`,
        sessionKey: frame.payload.sessionKey,
        timestamp: Date.now()
      }
    };
    callback(errorFrame);
  });
}

// ── Port retry: wait for port to free after restart ─────
let _portRetries = 0;
const MAX_PORT_RETRIES = 5;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    _portRetries++;
    if (_portRetries <= MAX_PORT_RETRIES) {
      console.log(`[Scratchy] Port ${PORT} busy — retry ${_portRetries}/${MAX_PORT_RETRIES} in 2s...`);
      setTimeout(() => {
        server.close();
        server.listen({ port: PORT, host: "::" }, () => {});
      }, 2000);
    } else {
      console.error(`[Scratchy] Port ${PORT} still busy after ${MAX_PORT_RETRIES} retries — exiting.`);
      process.exit(1);
    }
    return;
  }
  console.error('[Scratchy] Server error:', err);
});

// Allow immediate port reuse after restart (prevents EADDRINUSE race)
server.on('listening', () => { });
server.listen({ port: PORT, host: "::", exclusive: false }, () => {
  console.log(`🐱 Scratchy server running at http://localhost:${PORT}`);
  console.log(`   Auth: required (gateway token)`);
  console.log(`   WS proxy: /ws → localhost:${GATEWAY_PORT}`);
  console.log(`   API: /api/history?session=agent:main:main`);
  console.log();
  console.log(`  Login URL (click to open):`);
  console.log(`  http://localhost:${PORT}/?token=${AUTH_TOKEN}`);
  console.log();
  console.log(`  Or scan the token from: openclaw status`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Ensures clean exit on SIGTERM/SIGINT (systemd restart, Ctrl+C).
// Closes HTTP server, WS connections, analytics, and intervals before exit.

let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return; // Prevent double-fire
  _shuttingDown = true;
  console.log(`\n🛑 Scratchy received ${signal} — shutting down...`);

  // Remove error handlers to let Node exit naturally
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');

  // Stop analytics system
  if (typeof analytics !== 'undefined' && analytics && analytics.stop) {
    try { analytics.stop(); } catch (e) { /* best effort */ }
  }

  // Close all WebSocket connections (fire-and-forget)
  if (typeof wsSessions !== 'undefined' && wsSessions) {
    for (const [id, session] of wsSessions) {
      try {
        if (session._adminLiveInterval) clearInterval(session._adminLiveInterval);
        if (session.clientWs) session.clientWs.terminate();
        if (session.gatewayWs) session.gatewayWs.terminate();
      } catch (e) { /* best effort */ }
    }
  }

  // Close HTTP server and exit
  server.close();
  console.log('[Scratchy] Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
