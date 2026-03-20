# Phase 19: Multi-User Authentication & Account Management

## Overview

Transform Scratchy from single-operator (one gateway token) to multi-user with proper account management, session isolation, and role-based access. This is the foundation for marketplace, collaboration, and hosted SaaS.

## Current State

```
Browser → login.html → POST /api/auth { token } → cookie (HMAC of gateway token)
                                                  → all users share same agent session
```

- Single AUTH_TOKEN (gateway token)
- Session = HMAC-SHA256 of gateway token → HttpOnly cookie
- No user accounts, no roles, no isolation
- Anyone with the token has full admin access

## Target Architecture

```
                    ┌──────────────────────────┐
                    │     Scratchy Server       │
                    │                           │
Browser ──────────► │  Auth Layer               │
  Passkey/          │  ├── accounts.json        │  ← user database (encrypted at rest)
  Email+Pass        │  ├── sessions.json        │  ← active sessions per user
                    │  ├── roles.json           │  ← role definitions
                    │  └── WebAuthn store       │  ← passkey credentials
                    │                           │
                    │  User Router              │
                    │  ├── userId → sessionKey   │  ← maps users to isolated agent sessions
                    │  ├── userId → permissions  │  ← what each user can do
                    │  └── userId → widgetState  │  ← per-user widget data
                    │                           │
                    │  Gateway Proxy             │
                    │  └── per-user session keys │  ← each user gets own OpenClaw session
                    └──────────────────────────┘
```

## Auth Strategy (State of the Art)

### Primary: Passkeys (WebAuthn)
- **Phishing-resistant** — cryptographic challenge-response, no shared secrets
- **No passwords to steal** — private key never leaves the device
- **Biometric-backed** — FaceID, TouchID, Windows Hello, Android biometrics
- **Cross-device** — synced via iCloud Keychain, Google Password Manager, 1Password
- **Library:** `@simplewebauthn/server` + `@simplewebauthn/browser`

### Fallback: Email + Password
- For devices without passkey support (rare but possible)
- Argon2id hashing (memory-hard, GPU-resistant)
- Mandatory strong password policy (12+ chars, no common passwords)

### Session Management
- JWT-like stateful sessions (server-side session store, not stateless JWT)
- Refresh token rotation — short-lived access (15min), long-lived refresh (30 days)
- Device fingerprinting — flag suspicious logins from new devices
- Concurrent session limit (configurable, default 5)

## Data Model

### User Account
```json
{
  "id": "usr_abc123",
  "email": "user@example.com",
  "displayName": "Admin",
  "role": "admin",
  "passwordHash": "$argon2id$...",        // null if passkey-only
  "passkeys": [
    {
      "credentialId": "base64...",
      "publicKey": "base64...",
      "counter": 42,
      "deviceType": "platform",
      "backedUp": true,
      "transports": ["internal"],
      "createdAt": "2026-02-22T...",
      "lastUsedAt": "2026-02-22T...",
      "friendlyName": "MacBook Pro TouchID"
    }
  ],
  "mfaEnabled": false,
  "createdAt": "2026-02-22T...",
  "lastLoginAt": "2026-02-22T...",
  "status": "active"
}
```

### User Session
```json
{
  "sessionId": "ses_xyz789",
  "userId": "usr_abc123",
  "agentSessionKey": "main:webchat:usr_abc123",
  "deviceInfo": {
    "userAgent": "...",
    "ip": "...",
    "fingerprint": "..."
  },
  "createdAt": "2026-02-22T...",
  "expiresAt": "2026-03-22T...",
  "lastActiveAt": "2026-02-22T..."
}
```

### Roles & Permissions
```json
{
  "admin": {
    "description": "Full access — manage users, all agent tools, all widgets",
    "permissions": [
      "agent.full",
      "widgets.all",
      "users.manage",
      "settings.all",
      "canvas.edit",
      "sessions.view_all"
    ],
    "quotas": null
  },
  "operator": {
    "description": "Standard user — chat with agent, use widgets, own canvas",
    "permissions": [
      "agent.chat",
      "agent.tools.safe",
      "widgets.all",
      "canvas.edit",
      "sessions.own"
    ],
    "quotas": {
      "maxSubAgents": 2,
      "maxMessagesPerHour": 30,
      "maxMessagesPerDay": 200,
      "maxTokensPerDay": 500000,
      "allowedModels": ["sonnet", "haiku"],
      "toolsBlacklist": ["exec", "gateway"]
    }
  },
  "viewer": {
    "description": "Read-only — view conversations and canvas, no modifications",
    "permissions": [
      "agent.view",
      "canvas.view",
      "sessions.own"
    ],
    "quotas": {
      "maxSubAgents": 0,
      "maxMessagesPerHour": 0,
      "maxMessagesPerDay": 0,
      "maxTokensPerDay": 0,
      "allowedModels": [],
      "toolsBlacklist": ["*"]
    }
  }
}
```

### Per-User Quotas (Real-Time Admin Control)
Admin can override role defaults per user — changes take effect immediately:
```json
{
  "userId": "usr_abc123",
  "quotaOverrides": {
    "maxSubAgents": 3,
    "maxMessagesPerDay": 500,
    "maxTokensPerDay": 1000000,
    "allowedModels": ["sonnet", "haiku", "opus"]
  },
  "usage": {
    "messagesThisHour": 12,
    "messagesToday": 47,
    "tokensToday": 123456,
    "activeSubAgents": 1,
    "lastReset": "2026-02-22T00:00:00Z"
  },
  "suspended": false,
  "suspendReason": null
}
```

**Enforcement points:**
- `serve.js` WS proxy: check quota before forwarding message to gateway
- Sub-agent spawn: check `activeSubAgents < maxSubAgents` before allowing
- Per-message: increment counters, reject with friendly error if over limit
- Daily reset: cron job or lazy reset on first request after midnight
- Admin dashboard: live view of all users' usage + sliders to adjust limits
- **Auto-suspend**: if user hits 3x daily limit attempts, auto-suspend + notify admin
```

## Implementation Plan

### Sub-Phase A: User Store & Registration (2-3 sessions)

**New files:**
- `lib/auth/user-store.js` — CRUD for user accounts (file-based JSON, encrypted at rest)
- `lib/auth/password.js` — Argon2id hashing + verification
- `lib/auth/session-store.js` — Server-side session management
- `lib/auth/middleware.js` — Express-style auth middleware for HTTP + WS

**Changes to serve.js:**
- Replace `isAuthenticated()` with user-aware auth
- First user registration → auto-admin (bootstrap)
- `/api/auth/register` — create account (admin-only after first user)
- `/api/auth/login` — email+password login
- `/api/auth/logout` — invalidate session
- `/api/auth/me` — current user info

**Storage:**
```
.scratchy-data/
  users.json.enc          ← AES-256-GCM encrypted user database
  sessions/
    ses_xyz789.json       ← per-session state
  encryption.key          ← derived from master password (first-run setup)
```

### Sub-Phase B: Passkey (WebAuthn) Support (1-2 sessions)

**New files:**
- `lib/auth/webauthn.js` — registration + authentication ceremonies
- `web/js/webauthn.js` — browser-side passkey client

**New endpoints:**
- `/api/auth/passkey/register/options` — generate registration challenge
- `/api/auth/passkey/register/verify` — verify registration response
- `/api/auth/passkey/login/options` — generate authentication challenge
- `/api/auth/passkey/login/verify` — verify authentication response

**New UI:**
- `web/passkey-setup.html` — manage passkeys (add/remove/rename)
- Login page updated with "Sign in with Passkey" button

**Dependencies:**
- `@simplewebauthn/server` (server-side WebAuthn)
- `@simplewebauthn/browser` (client-side, or vanilla `navigator.credentials` API)

### Sub-Phase C: Session Isolation (1-2 sessions)

**Agent session mapping:**
- Each user gets their own OpenClaw session key: `main:webchat:{userId}`
- Gateway proxy routes each user's WS to their session
- Widget state isolated per user: `.scratchy-data/widgets/{userId}/`

**Changes:**
- `serve.js` WS proxy: inject user's session key into gateway frames
- Widget-action handler: load user-specific widget instances
- Canvas state: per-user canvas (`.scratchy-data/canvas/{userId}.json`)
- Chat history: filtered by user's session key

### Sub-Phase D: Admin Dashboard (1 session)

**Widget-based admin panel (built with Scratchy's own components!):**
- User list with status, role, last login
- Create/invite new users
- Change roles, disable/enable accounts
- Active sessions view — force logout
- Audit log — login attempts, permission changes

### Sub-Phase E: Login UI Overhaul (1 session)

**New login flow:**
```
┌─────────────────────────────────────┐
│           Welcome to Scratchy       │
│                                     │
│    ┌─────────────────────────┐      │
│    │  🔑 Sign in with Passkey │      │   ← primary (if passkeys registered)
│    └─────────────────────────┘      │
│                                     │
│    ─────── or ───────               │
│                                     │
│    Email: [____________]            │
│    Password: [____________]         │   ← fallback
│    [        Sign In        ]        │
│                                     │
│    First time? [Create Account]     │   ← only if admin enabled registration
└─────────────────────────────────────┘
```

## Security Considerations

| Threat | Mitigation |
|--------|-----------|
| Password brute force | Argon2id (slow hash) + rate limiting (existing) + account lockout |
| Credential stuffing | Passkeys preferred (no passwords to stuff) |
| Session hijacking | HttpOnly + SameSite cookies, IP binding optional |
| XSS token theft | No tokens in JS-accessible storage (passkeys are hardware-bound) |
| Privilege escalation | Server-side role checks on every request + tool call |
| User enumeration | Constant-time responses, generic error messages |
| Replay attacks | WebAuthn challenge nonces, session nonces |
| Data isolation breach | Session keys scoped per user, filesystem permissions |
| Admin account compromise | Passkey required for admin role (no password-only admin) |

## Migration Path

**Existing single-user installations:**
1. On first start after update, existing gateway token becomes the admin bootstrap token
2. Admin creates their account (email + passkey)
3. Gateway token auth remains as "legacy mode" (configurable, can be disabled)
4. Other users are invited by admin

**Backward compatibility:**
- `SCRATCHY_TOKEN` env var still works (legacy single-user mode)
- Can disable multi-user entirely in config (default: enabled)
- API endpoints versioned (`/api/v2/auth/...`) to not break existing clients

## Dependencies to Add

```json
{
  "@simplewebauthn/server": "^13.x",
  "argon2": "^0.41.x"
}
```

Both are well-maintained, audited, minimal dependency trees.

## Estimated Effort

| Sub-Phase | Sessions | Description |
|-----------|----------|-------------|
| A: User Store & Registration | 2-3 | Core account system, password auth, sessions |
| B: Passkey (WebAuthn) | 1-2 | Hardware-backed passwordless auth |
| C: Session Isolation | 1-2 | Per-user agent sessions, widget state, canvas |
| D: Admin Dashboard | 1 | User management widget (built with Scratchy!) |
| E: Login UI | 1 | New login page with passkey + password |
| **Total** | **6-9** | |

## Decisions

1. **Email verification** — No SMTP for Phase 19. Invite-only mitigates bot risk. Will be needed before open registration.
2. **OAuth social login** — Worth having. Prepare the architecture, implement after core auth.
3. **Invite-only** — Yes, designed to be easily upgradable to open registration (flip a config flag).
4. **Per-user sessions** — Yes. Each user gets their own agent session + memory + canvas + widgets.
5. **Per-user quotas** — Real-time admin control over sub-agents, messages/hour, messages/day, tokens/day, allowed models, tool blacklists. Admin can adjust live — no restart needed.
6. **Anti-bot is existential** — "if a bot can use our tool we're bankrupt." Must be solved before open registration.

## ⚠️ Critical for Production (Future Phases)

**Bot prevention is existential** — if bots can create accounts and consume agent API calls, the service goes bankrupt. Phase 19 is invite-only so this is deferred, but before ANY open registration:

- **Email verification (SMTP)** — mandatory for open registration. Confirms real humans.
- **CAPTCHA** — Cloudflare Turnstile (free, privacy-respecting) or hCaptcha on registration + login
- **Rate limiting per account** — hard caps on agent calls/day per user tier
- **Proof-of-work challenge** — lightweight client-side computation before registration (deters mass bot signups)
- **Invite codes** — even in "open" mode, require an invite code (existing user vouches for new one)
- **Usage monitoring + auto-suspend** — detect abuse patterns (rapid-fire requests, scripted behavior) and auto-suspend

This must be solved BEFORE transitioning from invite-only to open registration. The order:
1. Phase 19: Invite-only (safe, no bots)
2. Phase 19.5: SMTP + email verification + CAPTCHA
3. Phase 19.6: Open registration with full bot prevention stack
