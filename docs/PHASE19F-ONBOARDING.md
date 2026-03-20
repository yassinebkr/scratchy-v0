# Phase 19F: First-Connection Onboarding & Provider Setup

## Overview

After Phase 19A-E gives Scratchy multi-user auth (accounts, passkeys, sessions, quotas, admin dashboard), there's a missing link: a new user logs in for the first time and lands on… an empty chat with no AI provider configured. Phase 19F adds a guided onboarding wizard that walks new users through provider selection, credential entry (API key or OAuth), optional messaging channel setup, and personal preferences — all before they ever see the main chat interface.

### Problem Statement

Today the flow is:

1. Admin invites user (email + temp password)
2. User logs in at `login-v2.html`
3. User lands on main chat — **but no provider is configured for them**

The agent can't respond because there are no LLM credentials for that user. The user has no idea what to do. We need a zero-confusion onboarding flow that:

- Gets the user connected to at least one LLM provider
- Optionally connects messaging channels (WhatsApp, Discord, Signal, Telegram, Slack)
- Captures basic preferences (display name, avatar, theme)
- Never exposes API keys or OAuth tokens to the agent, logs, or other users
- Enforces the group-chat restriction server-side (DM-only for this test phase)

## Current State

```
Admin creates invite
        │
        ▼
┌──────────────────┐     POST /api/auth/login     ┌──────────────────────┐
│  login-v2.html   │ ────────────────────────────► │    serve.js          │
│  (email + pass   │                               │    Auth Layer        │
│   or passkey)    │ ◄──── session cookie ──────── │                      │
└──────────────────┘                               └──────────────────────┘
        │
        ▼
┌──────────────────┐
│  Main Chat UI    │  ← user arrives here with NO provider configured
│  (empty, broken) │     agent cannot respond — no LLM credentials
└──────────────────┘
```

**Problems:**
- No per-user provider credentials
- Single shared `auth-profiles.json` for the gateway
- User has no way to configure their own AI provider
- No onboarding guidance whatsoever
- Messaging channels not user-configurable

## Target Architecture

```
Admin creates invite
        │
        ▼
┌──────────────────┐     POST /api/auth/login     ┌──────────────────────────────────┐
│  login-v2.html   │ ────────────────────────────► │        serve.js                  │
│  (email + pass   │                               │                                  │
│   or passkey)    │ ◄──── session cookie ──────── │  Auth Layer (Phase 19A-E)        │
└──────────────────┘                               │  ├── accounts.json.enc           │
        │                                          │  ├── sessions/                    │
        │  isFirstLogin?                           │  └── user-store.js               │
        │  ┌─── yes ──┐                            │                                  │
        ▼             ▼                            │  Onboarding Layer (Phase 19F)    │
┌────────────┐  ┌─────────────────┐                │  ├── onboarding-store.js         │
│  Main Chat │  │ Onboarding      │                │  ├── provider-store.js           │
│  (already  │  │ Wizard          │                │  ├── oauth-handlers.js           │
│  set up)   │  │                 │                │  └── channel-config.js           │
└────────────┘  │ Step 1: Choose  │                │                                  │
                │   Your AI       │                │  Provider Credentials             │
                │ Step 2: Connect │ ◄── OAuth ───► │  ├── /auth/{provider}/callback   │
                │   Provider      │   redirect     │  └── providers/{userId}.json.enc │
                │ Step 3: Msg     │                │                                  │
                │   Channels      │                │  Gateway Integration              │
                │ Step 4: Prefs   │                │  ├── per-user session keys        │
                └────────┬────────┘                │  └── WS proxy injects user creds │
                         │                         │                                  │
                         ▼                         │  Channel Config                   │
                ┌────────────────┐                 │  ├── allowedChatTypes: ["dm"]     │
                │  Main Chat     │                 │  └── per-user channel pairings    │
                │  (provider     │                 └──────────────────────────────────┘
                │   configured!) │                           │
                └────────────────┘                           ▼
                                                  ┌──────────────────────────┐
                                                  │  OpenClaw Gateway        │
                                                  │  ├── per-user auth       │
                                                  │  │   profiles (injected) │
                                                  │  ├── session isolation   │
                                                  │  └── DM-only enforcement │
                                                  └──────────────────────────┘
```

## Onboarding Wizard Flow

### Step-by-Step User Journey

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Step 1: Choose Your AI            ● ○ ○ ○   progress indicator     │
│  ─────────────────────                                               │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                           │
│  │ Anthropic │  │  OpenAI  │  │  Google  │                           │
│  │  (Claude) │  │  (GPT)   │  │ (Gemini) │                           │
│  │           │  │          │  │          │                           │
│  │  API key  │  │ API key  │  │  OAuth   │                           │
│  │           │  │ or OAuth │  │          │                           │
│  └──────────┘  └──────────┘  └──────────┘                           │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                           │
│  │   Groq   │  │ Mistral  │  │  Local/  │                           │
│  │          │  │          │  │  Ollama  │                           │
│  │  API key  │  │  API key  │  │  URL     │                           │
│  │           │  │          │  │          │                           │
│  └──────────┘  └──────────┘  └──────────┘                           │
│                                                                      │
│  Select a provider to get started. You can add more later.          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                              │
                    user clicks "Anthropic"
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Step 2: Connect Anthropic         ○ ● ○ ○                          │
│  ─────────────────────────                                           │
│                                                                      │
│  Enter your Anthropic API key:                                       │
│  ┌──────────────────────────────────────────┐                        │
│  │ sk-ant-api03-••••••••••••••••••••••••••  │   🔒 encrypted         │
│  └──────────────────────────────────────────┘                        │
│                                                                      │
│  Model:  [ claude-sonnet-4-20250514 ▾ ]                              │
│                                                                      │
│  ℹ️  Your API key is encrypted and stored on the server.             │
│     It is never visible to the admin, the agent, or other users.    │
│                                                                      │
│  [ Test Connection ]   [ ← Back ]   [ Next → ]                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                              │
                     "Test Connection" clicked
                     → sends "Hello" to provider
                     → shows ✅ success or ❌ error
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Step 3: Messaging Channels        ○ ○ ● ○                          │
│  ──────────────────────────                                          │
│                                                                      │
│  Connect platforms so the AI can chat with you anywhere.             │
│  (All channels are DM-only for now.)                                │
│                                                                      │
│  ┌─────────────────────────────────────────┐                         │
│  │ 💬 WhatsApp     [ Scan QR Code ]        │                         │
│  │ 🎮 Discord      [ Connect Bot  ]        │                         │
│  │ 🔐 Signal       [ Scan QR Code ]        │                         │
│  │ ✈️ Telegram      [ Start Bot    ]        │                         │
│  │ 💼 Slack         [ Install App  ]        │                         │
│  └─────────────────────────────────────────┘                         │
│                                                                      │
│  [ Skip for now ]              [ Next → ]                            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Step 4: Preferences               ○ ○ ○ ●                          │
│  ───────────────────                                                 │
│                                                                      │
│  Display name:  [ Admin          ]                                 │
│  Avatar:        [ 🎭 Choose ]  or  [ 📷 Upload ]                     │
│  Theme:         ( ◉ Dark  ○ Light  ○ System )                        │
│  Notifications: [ ✓ Browser ] [ ✓ Sound ]                            │
│                                                                      │
│                       [ 🚀 Start Chatting ]                           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Wizard State Machine

```
                  ┌───────────┐
                  │  LOGIN    │
                  └─────┬─────┘
                        │ isFirstLogin || !hasProvider
                        ▼
                  ┌───────────┐   onboard-start
                  │  STEP 1   │ ──────────────────────────►  Show provider cards
                  │ Choose AI │
                  └─────┬─────┘
                        │ onboard-select-provider
                        ▼
                  ┌───────────┐   onboard-connect-apikey    ┌───────────────┐
                  │  STEP 2   │ ──────────────────────────► │ Validate key  │
                  │ Connect   │   onboard-connect-oauth     │ Encrypt+store │
                  │ Provider  │ ──────────────────────────► │ OAuth redirect│
                  └─────┬─────┘                             └───────┬───────┘
                        │ onboard-test-provider                     │
                        │ ◄─────────────────────────────────────────┘
                        │ (test succeeds)
                        ▼
                  ┌───────────┐   onboard-channel-setup
                  │  STEP 3   │ ──────────────────────────►  QR code / link
                  │ Channels  │
                  └─────┬─────┘
                        │ skip or channels connected
                        ▼
                  ┌───────────┐   onboard-complete
                  │  STEP 4   │ ──────────────────────────►  Save prefs
                  │ Prefs     │                              Set onboarded=true
                  └─────┬─────┘                              Redirect to chat
                        │
                        ▼
                  ┌───────────┐
                  │ MAIN CHAT │
                  └───────────┘
```

## LLM Providers

### Provider Configuration Matrix

| Provider | Auth Method | OAuth Available | Model Default | Notes |
|----------|------------|----------------|---------------|-------|
| Anthropic (Claude) | API key only | ❌ | `claude-sonnet-4-20250514` | No OAuth — user must enter key manually |
| OpenAI (GPT) | API key or OAuth | ✅ | `gpt-4o` | OAuth via `platform.openai.com` |
| Google (Gemini) | OAuth | ✅ | `gemini-2.0-flash` | Reuse existing Calendar OAuth flow |
| Groq | API key only | ❌ | `llama-3.3-70b-versatile` | Fast inference provider |
| Mistral | API key only | ❌ | `mistral-large-latest` | European AI provider |
| Local/Ollama | URL only | ❌ | `llama3.2` | Self-hosted — needs base URL only |

### API Key Entry Flow

```
User enters API key
        │
        ▼
┌───────────────────────────────────────┐
│  serve.js — onboard-connect-apikey    │
│                                       │
│  1. Receive key via HTTPS POST        │
│  2. Validate format (regex per        │
│     provider, e.g. sk-ant-api03-*)    │
│  3. Test connection (send minimal     │   ← "Hello" prompt, max 10 tokens
│     prompt to provider API)           │
│  4. If valid:                         │
│     a. Encrypt with AES-256-GCM      │
│     b. Store in {userId}.json.enc    │
│     c. Clear plaintext from memory    │   ← explicit zeroing
│  5. Return success to wizard          │
│  6. NEVER log the key anywhere        │
└───────────────────────────────────────┘
```

### OAuth Flow

```
User clicks "Connect with OAuth"
        │
        ▼
┌───────────────────────────────────────┐
│  serve.js — onboard-connect-oauth     │
│                                       │
│  1. Generate OAuth state parameter:   │
│     state = encrypt({                 │
│       userId: "usr_abc123",           │
│       provider: "openai",             │
│       nonce: crypto.randomUUID(),     │
│       timestamp: Date.now()           │
│     })                                │
│  2. Store state → pending OAuth       │
│     (TTL: 10 minutes)                 │
│  3. Build authorization URL           │
│  4. Redirect user to provider         │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│  Provider consent page (external)     │
│  User approves access                 │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│  /auth/{provider}/callback            │
│                                       │
│  1. Validate state parameter          │
│     - Decrypt, verify nonce exists    │
│     - Check timestamp < 10 min        │
│     - Consume nonce (one-time use)    │
│  2. Exchange authorization code for   │
│     access + refresh tokens           │
│  3. Encrypt tokens with AES-256-GCM  │
│  4. Store in {userId}.json.enc       │
│  5. Redirect user back to wizard      │
│     with ?step=2&status=connected     │
│  6. Wizard auto-advances to step 3    │
└───────────────────────────────────────┘
```

### OAuth Endpoints per Provider

| Provider | Authorization URL | Token URL | Scopes |
|----------|------------------|-----------|--------|
| OpenAI | `https://platform.openai.com/oauth/authorize` | `https://platform.openai.com/oauth/token` | `model.request` |
| Google (Gemini) | `https://accounts.google.com/o/oauth2/v2/auth` | `https://oauth2.googleapis.com/token` | `https://www.googleapis.com/auth/generative-language` |
| Slack (channel) | `https://slack.com/oauth/v2/authorize` | `https://slack.com/api/oauth.v2.access` | `chat:write`, `im:read`, `im:write` |

## Data Model

### Per-User Provider Credentials

Stored at: `.scratchy-data/auth/providers/{userId}.json.enc`

Encrypted with AES-256-GCM using the same master key as the user database.

```json
{
  "userId": "usr_abc123",
  "activeProvider": "anthropic",
  "providers": {
    "anthropic": {
      "apiKey": "ENC:aes-256-gcm:iv:ciphertext:tag",
      "model": "claude-sonnet-4-20250514",
      "maxTokens": 4096,
      "connectedAt": "2026-02-22T10:00:00Z"
    },
    "openai": {
      "apiKey": "ENC:aes-256-gcm:iv:ciphertext:tag",
      "oauthTokens": {
        "accessToken": "ENC:aes-256-gcm:iv:ciphertext:tag",
        "refreshToken": "ENC:aes-256-gcm:iv:ciphertext:tag",
        "expiresAt": "2026-02-22T11:00:00Z"
      },
      "model": "gpt-4o",
      "connectedAt": "2026-02-22T10:05:00Z"
    },
    "google": {
      "oauthTokens": {
        "accessToken": "ENC:aes-256-gcm:iv:ciphertext:tag",
        "refreshToken": "ENC:aes-256-gcm:iv:ciphertext:tag",
        "expiresAt": "2026-02-22T11:00:00Z"
      },
      "model": "gemini-2.0-flash",
      "connectedAt": "2026-02-22T10:10:00Z"
    },
    "groq": {
      "apiKey": "ENC:aes-256-gcm:iv:ciphertext:tag",
      "model": "llama-3.3-70b-versatile",
      "connectedAt": "2026-02-22T10:15:00Z"
    },
    "mistral": {
      "apiKey": "ENC:aes-256-gcm:iv:ciphertext:tag",
      "model": "mistral-large-latest",
      "connectedAt": "2026-02-22T10:20:00Z"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "model": "llama3.2",
      "connectedAt": "2026-02-22T10:25:00Z"
    }
  },
  "onboardingCompleted": true,
  "onboardingCompletedAt": "2026-02-22T10:30:00Z"
}
```

### Onboarding State (tracks wizard progress)

Stored at: `.scratchy-data/auth/onboarding/{userId}.json`

```json
{
  "userId": "usr_abc123",
  "currentStep": 2,
  "completed": false,
  "selectedProvider": "anthropic",
  "providerConnected": false,
  "channelsConfigured": [],
  "startedAt": "2026-02-22T10:00:00Z",
  "lastUpdatedAt": "2026-02-22T10:02:00Z"
}
```

### Per-User Channel Configuration

Stored at: `.scratchy-data/auth/channels/{userId}.json.enc`

```json
{
  "userId": "usr_abc123",
  "channels": {
    "whatsapp": {
      "paired": true,
      "pairedAt": "2026-02-22T10:15:00Z",
      "phoneNumber": "+49***",
      "allowedChatTypes": ["dm"]
    },
    "discord": {
      "paired": true,
      "pairedAt": "2026-02-22T10:16:00Z",
      "guildIds": ["123456789"],
      "allowedChatTypes": ["dm"]
    },
    "telegram": {
      "paired": true,
      "pairedAt": "2026-02-22T10:17:00Z",
      "chatId": "987654321",
      "allowedChatTypes": ["dm"]
    }
  }
}
```

### Admin View of Provider Status (no secrets)

What the admin dashboard shows — connected status only, **never** actual keys:

```json
{
  "userId": "usr_abc123",
  "displayName": "Admin",
  "activeProvider": "anthropic",
  "connectedProviders": [
    { "provider": "anthropic", "authMethod": "apikey", "connectedAt": "2026-02-22T10:00:00Z" },
    { "provider": "openai", "authMethod": "oauth", "connectedAt": "2026-02-22T10:05:00Z" }
  ],
  "connectedChannels": ["whatsapp", "discord"],
  "onboardingCompleted": true
}
```

## Gateway Integration

### Current: Single Auth Profile

```
┌──────────────┐       ┌───────────────────┐       ┌──────────────┐
│  All Users   │──WS──►│   serve.js proxy   │──WS──►│   OpenClaw   │
│  (shared)    │       │                   │       │   Gateway    │
└──────────────┘       │  auth-profiles.json│       │              │
                       │  (single profile)  │       │  one agent   │
                       └───────────────────┘       │  session     │
                                                   └──────────────┘
```

### Target: Per-User Provider Injection

```
┌──────────────┐       ┌───────────────────────────────┐       ┌──────────────┐
│  User A      │──WS──►│   serve.js WS proxy            │──WS──►│   OpenClaw   │
│  (Anthropic) │       │                               │       │   Gateway    │
├──────────────┤       │  1. Identify user from session │       │              │
│  User B      │──WS──►│  2. Load {userId}.json.enc    │       │  Per-user    │
│  (OpenAI)    │       │  3. Decrypt provider creds     │       │  agent       │
├──────────────┤       │  4. Inject into gateway frame: │       │  sessions    │
│  User C      │──WS──►│     - provider type            │       │              │
│  (Gemini)    │       │     - model name               │       │              │
└──────────────┘       │     - auth headers             │       └──────────────┘
                       │  5. Forward to user's session  │
                       │     key: main:webchat:{userId} │
                       └───────────────────────────────┘
```

### Credential Injection Approach

The WS proxy in `serve.js` intercepts outgoing messages to the gateway and injects provider credentials at the transport layer. The agent never sees API keys.

```javascript
// Pseudocode — serve.js WS proxy enhancement
async function proxyToGateway(userId, message) {
  // 1. Load & decrypt user's provider config
  const providerConfig = await providerStore.getDecrypted(userId);
  const active = providerConfig.providers[providerConfig.activeProvider];

  // 2. Build gateway auth profile for this request
  const authProfile = {
    provider: providerConfig.activeProvider,
    model: active.model,
    // API key or OAuth token — decrypted in memory only
    credentials: decryptCredentials(active),
    maxTokens: active.maxTokens || 4096
  };

  // 3. Inject into gateway session
  gateway.setSessionAuth(userId, authProfile);

  // 4. Forward message under user's session key
  gateway.send(`main:webchat:${userId}`, message);

  // 5. Wipe credentials from memory
  authProfile.credentials = null;
}
```

## Group Chat Restriction (Server-Side Enforcement)

### ⚠️ CRITICAL: DM-Only for Multi-User Test Phase

The agent **MUST NEVER** respond in group chats on any messaging platform during this test phase. This is enforced **server-side** in OpenClaw configuration — not just in the UI.

### Enforcement Points

```
┌─────────────────────────────────────────────────────────────┐
│                 Message Flow (with DM enforcement)          │
│                                                             │
│  Incoming message from WhatsApp/Discord/Signal/Telegram     │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────────────────────────────┐                    │
│  │  OpenClaw Channel Plugin            │                    │
│  │                                     │                    │
│  │  Check: is this a DM/private chat?  │                    │
│  │  ├── YES → forward to agent         │                    │
│  │  └── NO  → DROP silently            │  ← server-side     │
│  │           (log: "group msg blocked") │    enforcement     │
│  └─────────────────────────────────────┘                    │
│       │                                                     │
│       ▼ (only DMs reach here)                               │
│  ┌─────────────────────────────────────┐                    │
│  │  Agent Session                       │                    │
│  │  (per-user, isolated)               │                    │
│  └─────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### OpenClaw Configuration

In `openclaw.json` (or equivalent per-channel config):

```json
{
  "channels": {
    "whatsapp": {
      "allowedChatTypes": ["dm"],
      "groupChatBehavior": "ignore",
      "logBlockedMessages": true
    },
    "discord": {
      "allowedChatTypes": ["dm"],
      "groupChatBehavior": "ignore",
      "logBlockedMessages": true
    },
    "signal": {
      "allowedChatTypes": ["dm"],
      "groupChatBehavior": "ignore",
      "logBlockedMessages": true
    },
    "telegram": {
      "allowedChatTypes": ["dm"],
      "groupChatBehavior": "ignore",
      "logBlockedMessages": true
    },
    "slack": {
      "allowedChatTypes": ["dm"],
      "groupChatBehavior": "ignore",
      "logBlockedMessages": true
    }
  }
}
```

### Why Server-Side Only

| Approach | Reliability | Notes |
|----------|------------|-------|
| Client-side UI filter | ❌ Weak | Can be bypassed, doesn't cover non-Scratchy clients |
| Agent system prompt | ❌ Weak | LLMs can ignore instructions, not deterministic |
| **Server-side channel config** | **✅ Strong** | Messages never reach the agent — deterministic enforcement |
| Server-side + agent prompt | ✅✅ Belt + suspenders | Defense in depth (but server-side is the real gate) |

## Widget Actions

All onboarding interactions are handled through Scratchy's widget action system with the `onboard-` prefix.

| Action | Triggered By | Handler Behavior |
|--------|-------------|-----------------|
| `onboard-start` | First login detection | Show step 1 provider selection cards |
| `onboard-select-provider` | User clicks provider card | Store selection, show connect form for that provider |
| `onboard-connect-apikey` | User submits API key | Validate format, test connection, encrypt+store |
| `onboard-connect-oauth` | User clicks "Connect with OAuth" | Generate state, redirect to provider |
| `onboard-test-provider` | User clicks "Test Connection" | Send minimal prompt, return success/failure |
| `onboard-channels` | Step 2 complete → advance | Show messaging channel setup (step 3) |
| `onboard-channel-setup` | User clicks channel connect | Start pairing flow (QR code, invite link, etc.) |
| `onboard-complete` | User clicks "Start Chatting" | Save preferences, set `onboardingCompleted=true`, redirect |

### GenUI Rendering

The onboarding wizard is rendered using Scratchy's GenUI `scratchy-canvas` protocol. Each step produces canvas operations:

**Step 1 example (provider cards):**
```json
{"op":"clear"}
{"op":"layout","mode":"focus"}
{"op":"upsert","id":"onboard-header","type":"hero","data":{"title":"Choose Your AI","subtitle":"Select a provider to get started","icon":"🤖","gradient":true}}
{"op":"upsert","id":"onboard-provider-anthropic","type":"card","data":{"title":"Anthropic (Claude)","text":"API key • Best for reasoning & coding","icon":"🧠"}}
{"op":"upsert","id":"onboard-provider-openai","type":"card","data":{"title":"OpenAI (GPT)","text":"API key or OAuth • General purpose","icon":"💚"}}
{"op":"upsert","id":"onboard-provider-google","type":"card","data":{"title":"Google (Gemini)","text":"OAuth • Fast & multimodal","icon":"🔷"}}
{"op":"upsert","id":"onboard-provider-groq","type":"card","data":{"title":"Groq","text":"API key • Ultra-fast inference","icon":"⚡"}}
{"op":"upsert","id":"onboard-provider-mistral","type":"card","data":{"title":"Mistral","text":"API key • European provider","icon":"🇪🇺"}}
{"op":"upsert","id":"onboard-provider-ollama","type":"card","data":{"title":"Local / Ollama","text":"URL only • Self-hosted","icon":"🏠"}}
{"op":"upsert","id":"onboard-progress","type":"progress","data":{"label":"Setup Progress","value":1,"max":4,"color":"#7c3aed"}}
```

**Step 2 example (API key form for Anthropic):**
```json
{"op":"clear"}
{"op":"layout","mode":"focus"}
{"op":"upsert","id":"onboard-header","type":"hero","data":{"title":"Connect Anthropic","subtitle":"Enter your API key to get started","icon":"🧠"}}
{"op":"upsert","id":"onboard-apikey-form","type":"form","data":{"title":"Provider Credentials","id":"apikey-form","fields":[{"name":"apiKey","type":"text","label":"API Key","placeholder":"sk-ant-api03-..."},{"name":"model","type":"select","label":"Model","value":"claude-sonnet-4-20250514","options":["claude-sonnet-4-20250514","claude-haiku-4-20250414","claude-opus-4-0520"]}],"actions":[{"label":"Test Connection","action":"onboard-test-provider","style":"ghost"},{"label":"Connect","action":"onboard-connect-apikey","style":"primary"}]}}
{"op":"upsert","id":"onboard-security-note","type":"alert","data":{"title":"🔒 Your key is safe","message":"Encrypted with AES-256-GCM. Never visible to the admin, agent, or other users.","severity":"info"}}
{"op":"upsert","id":"onboard-progress","type":"progress","data":{"label":"Setup Progress","value":2,"max":4,"color":"#7c3aed"}}
```

## Messaging Channel Setup

### Channel Pairing Flows

#### WhatsApp & Signal (QR Code)

```
User clicks "Scan QR Code"
        │
        ▼
┌───────────────────────────────────┐
│  serve.js → OpenClaw pairing API  │
│                                   │
│  1. Request new pairing session   │
│  2. Receive QR code data          │
│  3. Render QR code in wizard      │
│     (inline, auto-refresh)        │
│  4. User scans with phone         │
│  5. Pairing confirmed via WS      │
│  6. Store channel config           │
│     (encrypted, DM-only)          │
│  7. Auto-advance wizard            │
└───────────────────────────────────┘
```

#### Discord (Bot Invite)

```
User clicks "Connect Bot"
        │
        ▼
┌───────────────────────────────────┐
│  1. Show bot invite URL           │
│  2. User adds bot to server       │
│  3. User selects which server     │
│     to use (if multiple)          │
│  4. Bot confirms DM access        │
│  5. Store channel config           │
│     (encrypted, DM-only)          │
└───────────────────────────────────┘
```

#### Telegram (Bot Start)

```
User clicks "Start Bot"
        │
        ▼
┌───────────────────────────────────┐
│  1. Show link: t.me/{botname}     │
│  2. User clicks → opens Telegram  │
│  3. User sends /start             │
│  4. Bot confirms pairing via API  │
│  5. Store channel config           │
│     (encrypted, DM-only)          │
└───────────────────────────────────┘
```

#### Slack (OAuth App Install)

```
User clicks "Install App"
        │
        ▼
┌───────────────────────────────────┐
│  1. OAuth redirect to Slack       │
│     (same pattern as provider     │
│      OAuth — state param, nonce)  │
│  2. User approves workspace       │
│  3. Callback stores bot token     │
│     (encrypted, DM-only)          │
│  4. Return to wizard               │
└───────────────────────────────────┘
```

## File Structure

### New Files

```
scratchy/
├── lib/
│   ├── auth/
│   │   ├── provider-store.js        ← CRUD for per-user provider credentials
│   │   ├── onboarding-store.js      ← Wizard state tracking
│   │   ├── oauth-handlers.js        ← OAuth flow management (state, callbacks)
│   │   └── channel-config.js        ← Per-user messaging channel configuration
│   └── onboarding/
│       ├── provider-test.js          ← Test connections to each provider
│       ├── provider-registry.js      ← Provider metadata (names, auth methods, models)
│       └── channel-pairing.js        ← Channel pairing flow orchestration
├── web/
│   └── js/
│       └── onboarding.js            ← Client-side wizard logic
└── docs/
    └── PHASE19F-ONBOARDING.md       ← This document
```

### Modified Files

```
scratchy/
├── serve.js                          ← Add OAuth callback routes, widget action handlers,
│                                       WS proxy provider injection, first-login detection
├── web/
│   └── index.html                    ← Add onboarding wizard container/overlay
└── .scratchy-data/
    └── auth/
        ├── providers/
        │   ├── usr_abc123.json.enc  ← Per-user provider credentials (encrypted)
        │   └── usr_def456.json.enc
        ├── onboarding/
        │   ├── usr_abc123.json      ← Wizard state (non-sensitive)
        │   └── usr_def456.json
        └── channels/
            ├── usr_abc123.json.enc  ← Per-user channel config (encrypted)
            └── usr_def456.json.enc
```

## Implementation Plan

### Sub-Phase F1: Provider Store & Encryption (1–2 sessions)

**Goal:** Per-user encrypted provider credential storage.

**New files:**
- `lib/auth/provider-store.js` — CRUD for provider credentials
  - `getProviders(userId)` → returns metadata only (no secrets)
  - `getDecrypted(userId)` → returns full decrypted config (internal use only)
  - `setProvider(userId, provider, config)` → encrypt + store
  - `removeProvider(userId, provider)` → delete provider entry
  - `setActiveProvider(userId, provider)` → switch active provider
- `lib/onboarding/provider-registry.js` — static provider metadata

**Changes to serve.js:**
- New endpoints: `POST /api/providers/:provider/connect`, `DELETE /api/providers/:provider`
- Load encryption module from Phase 19A (reuse `AES-256-GCM` helpers)

**Tests:**
- Encrypt/decrypt round-trip
- Multi-provider per user
- Active provider switching
- File-level isolation between users

### Sub-Phase F2: Onboarding Wizard UI (1–2 sessions)

**Goal:** Four-step wizard rendered via GenUI canvas.

**New files:**
- `web/js/onboarding.js` — client-side wizard state + rendering
- `lib/auth/onboarding-store.js` — server-side wizard progress tracking

**Widget action handlers in serve.js:**
- `onboard-start` → render step 1
- `onboard-select-provider` → render step 2 (connect form)
- `onboard-connect-apikey` → validate + store + render result
- `onboard-channels` → render step 3
- `onboard-complete` → save prefs, mark complete, redirect

**Changes to serve.js:**
- First-login detection: if `onboardingCompleted !== true`, redirect to wizard
- Widget action routing for all `onboard-*` actions

### Sub-Phase F3: Provider Connection & Testing (1–2 sessions)

**Goal:** Actually connect to providers, test connections, handle errors.

**New files:**
- `lib/onboarding/provider-test.js` — test connections
  - `testAnthropic(apiKey, model)` → send "Hello" prompt
  - `testOpenAI(apiKey, model)` → send "Hello" prompt
  - `testGoogle(oauthToken, model)` → send "Hello" prompt
  - `testGroq(apiKey, model)` → send "Hello" prompt
  - `testMistral(apiKey, model)` → send "Hello" prompt
  - `testOllama(baseUrl, model)` → list models or send "Hello"

**Widget action handlers:**
- `onboard-test-provider` → decrypt key, test connection, return result
- Show ✅ / ❌ feedback in wizard with specific error messages

**Error handling:**
- Invalid API key format → immediate rejection (no network call)
- Authentication failure → "Key is invalid or expired"
- Network error → "Could not reach provider — check your connection"
- Rate limit → "Provider rate limit hit — wait and try again"
- Ollama not running → "Could not connect to Ollama at {url}"

### Sub-Phase F4: OAuth Flows (1–2 sessions)

**Goal:** OAuth for OpenAI, Google (Gemini), and Slack.

**New files:**
- `lib/auth/oauth-handlers.js`
  - `generateAuthUrl(userId, provider)` → build URL + store state
  - `handleCallback(provider, code, state)` → exchange code, encrypt tokens
  - `refreshTokens(userId, provider)` → refresh expired access tokens

**New routes in serve.js:**
- `GET /auth/openai/authorize` → redirect to OpenAI consent
- `GET /auth/openai/callback` → handle OAuth callback
- `GET /auth/google/authorize` → redirect to Google consent
- `GET /auth/google/callback` → handle OAuth callback (reuse existing Calendar flow)
- `GET /auth/slack/authorize` → redirect to Slack consent
- `GET /auth/slack/callback` → handle OAuth callback

**Security:**
- State parameter: encrypted JSON with userId, provider, nonce, timestamp
- Nonce consumed on use (one-time)
- State expires after 10 minutes
- Rate limit callbacks: max 10/min per IP

### Sub-Phase F5: Gateway Integration (1–2 sessions)

**Goal:** WS proxy injects user's provider credentials into gateway session.

**Changes to serve.js:**
- Modify WS proxy to intercept messages before forwarding to gateway
- Load user's active provider config (decrypted) per request
- Inject provider credentials into gateway session context
- Wipe credentials from memory after injection
- Handle provider switching mid-session (user changes active provider in settings)

**Changes to gateway config:**
- Remove single `auth-profiles.json` dependency
- Accept per-session dynamic auth profiles
- Map user session keys to provider configs

### Sub-Phase F6: Messaging Channel Setup (1–2 sessions)

**Goal:** Channel pairing flows in the wizard.

**New files:**
- `lib/auth/channel-config.js` — per-user channel storage
- `lib/onboarding/channel-pairing.js` — pairing flow orchestration

**Widget action handlers:**
- `onboard-channel-setup` → start pairing for selected channel
- Inline QR code rendering for WhatsApp/Signal
- Bot invite URL display for Discord
- Bot link display for Telegram
- OAuth redirect for Slack

**DM enforcement:**
- Every channel config includes `allowedChatTypes: ["dm"]`
- OpenClaw config updated to enforce server-side
- Pairing flow validates DM capability before confirming

### Sub-Phase F7: Admin Provider Dashboard (1 session)

**Goal:** Admin can see which providers each user has connected (without seeing keys).

**Changes to admin dashboard:**
- New "Providers" column in user list
- Provider status badges: connected/not connected
- Default provider setting for new users
- Ability to reset a user's provider config (force re-onboarding)
- **Never expose actual API keys or tokens**

## Security Considerations

| Threat | Mitigation |
|--------|-----------|
| API key exposure in logs | Keys are **never** logged. `provider-store.js` uses structured logging that explicitly excludes credential fields. Console.log override strips any string matching key patterns. |
| API key exposure to agent | Keys are injected at the WS proxy layer in `serve.js`. The agent session never receives raw credentials — only sees responses from the provider. |
| API key exposure to admin | Admin dashboard shows connection status only (`connected: true`, `connectedAt: date`). The `getProviders()` API returns metadata, never secrets. |
| Cross-user credential leak | Credentials stored in separate per-user encrypted files. `getDecrypted(userId)` validates the requesting session owns that userId. |
| OAuth state parameter forgery | State is AES-encrypted with server secret, contains nonce (one-time use) and timestamp (10-minute TTL). |
| OAuth callback CSRF/replay | Nonce consumed on first use. Rate limit: 10 callbacks/min per IP. State bound to specific userId + provider. |
| OAuth token theft at rest | Tokens encrypted with AES-256-GCM, same key derivation as user database. |
| OAuth token refresh failure | Graceful degradation: notify user to re-authenticate. Clear stale tokens. Don't let expired tokens block the system. |
| Group chat data leak | `allowedChatTypes: ["dm"]` enforced **server-side** in OpenClaw channel config. Messages from group chats are dropped before reaching the agent. |
| Provider impersonation | Test connection validates the provider actually responds correctly. Provider URLs are hardcoded (no user-supplied endpoints except Ollama). |
| Ollama SSRF | Ollama base URL validated: must be `localhost`, `127.0.0.1`, or a user-configured private IP range. No arbitrary URL access. |
| Credential memory residue | After decryption and use, credential strings are explicitly overwritten in memory (best-effort in Node.js — use `Buffer.alloc` + `buf.fill(0)`). |
| Wizard bypass (skip onboarding) | Server-side check: if `onboardingCompleted !== true` and no active provider, all WS messages return "complete onboarding first" error. |
| Admin default provider abuse | Admin-set default provider uses a shared/org-level key, clearly separated from per-user keys. Users can override with their own. |

## Migration & Backward Compatibility

### Existing Single-User Installations

1. On upgrade, existing gateway token auth continues to work (legacy mode)
2. Existing users already authenticated via Phase 19A-E are **not** forced into onboarding
3. Onboarding triggers only for users with `onboardingCompleted !== true` **and** no configured provider
4. Admin can manually trigger re-onboarding for any user

### Existing Auth Profiles

1. Current `auth-profiles.json` becomes the **fallback** provider config
2. If a user has no per-user provider configured, the system falls back to the shared profile
3. Once a user configures their own provider, it takes precedence
4. Admin can phase out the shared profile once all users have their own

## Estimated Effort

| Sub-Phase | Sessions | Description |
|-----------|----------|-------------|
| F1: Provider Store & Encryption | 1–2 | Per-user encrypted credential storage |
| F2: Onboarding Wizard UI | 1–2 | Four-step GenUI wizard |
| F3: Provider Connection & Testing | 1–2 | Test connections, error handling |
| F4: OAuth Flows | 1–2 | OpenAI, Google, Slack OAuth |
| F5: Gateway Integration | 1–2 | WS proxy credential injection |
| F6: Messaging Channel Setup | 1–2 | Channel pairing flows in wizard |
| F7: Admin Provider Dashboard | 1 | Admin view of provider status |
| **Total** | **7–13** | |

## Dependencies

### New NPM Packages

```json
{
  "qrcode": "^1.5.x"
}
```

QR code generation for WhatsApp/Signal pairing. Minimal dependency.

### Existing Dependencies (reused)

- `crypto` (Node.js built-in) — AES-256-GCM encryption (already used in Phase 19A)
- OAuth client logic — reuse Google Calendar OAuth flow (already implemented)
- `@simplewebauthn/*` — already added in Phase 19B

## Open Questions

1. **Shared/org-level provider key** — Should the admin be able to set a "house" API key that all users default to (so users don't need their own key)? This simplifies onboarding but concentrates billing on one account. If yes, does the user still see the onboarding wizard, or skip straight to step 3 (channels)?

2. **Provider key rotation** — When a user rotates their API key, how do we handle in-flight requests? Do we need a brief "draining" period, or is it safe to swap immediately since each WS message decrypts fresh?

3. **OAuth token refresh scheduling** — Should we proactively refresh OAuth tokens before they expire (background job), or refresh lazily on the next request that needs them? Proactive is better UX but adds complexity.

4. **Multiple active providers** — Should users be able to set different providers for different use cases (e.g., Claude for coding, GPT for general chat)? Phase 19F assumes one active provider — should we design the schema to support multi-active from the start?

5. **Provider cost visibility** — Should the wizard show estimated costs per provider/model? (e.g., "Claude Sonnet: ~$3/million input tokens"). This helps users make informed choices but requires maintaining a price database.

6. **Onboarding skip for admin-provisioned keys** — If an admin pre-configures a provider for a new user (e.g., company API key), should the wizard skip steps 1-2 and go straight to channels/preferences?

7. **Channel pairing ownership** — If two Scratchy users try to pair the same WhatsApp number, what happens? Should we enforce one-to-one mapping (phone number → user)? What about shared family devices?

8. **Ollama discovery** — Should we auto-detect Ollama running on localhost and pre-populate the URL? This improves UX for self-hosters but means we're probing `localhost:11434` on every onboarding load.

9. **Re-onboarding flow** — When a user's API key expires or gets revoked, how do they re-enter credentials? Full wizard again, or a streamlined "reconnect" flow accessible from settings?

10. **Offline/degraded mode** — If the active provider is down (API outage), should we auto-failover to the user's secondary provider? Or show an error and let the user manually switch? Auto-failover is better UX but could surprise users with different model behavior.

11. **GDPR / data deletion** — When a user is deleted, are their encrypted provider credentials and channel configs immediately purged? Do we need a "data export" feature before deletion? This matters for EU compliance.

12. **Rate limiting per provider** — Should Scratchy enforce its own rate limits per provider (on top of the provider's native limits)? This prevents a single user from accidentally burning through their entire API budget in one session.
