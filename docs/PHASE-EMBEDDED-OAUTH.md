# Embedded OAuth Client ID — Zero-Config Google Auth for Scratchy

## Overview

### Current Friction

Scratchy's Google Calendar and Gmail widgets require OAuth2 to access user data. Today, every Scratchy operator must:

1. Create a Google Cloud project
2. Enable the Gmail API and Google Calendar API
3. Configure the OAuth consent screen
4. Create OAuth 2.0 credentials (client ID + secret)
5. Copy-paste credentials into Scratchy's configuration

This process takes 15-30 minutes, requires a Google Cloud account, and is the **#1 drop-off point** for new users. Most self-hosted users never enable Google integrations because the setup is too painful.

### Target UX

```
User clicks "Sign in with Google" → Google consent screen → Done.
```

No Google Cloud project. No API keys. No configuration. Scratchy ships with a pre-configured, Google-verified OAuth client ID that works out of the box for every instance.

### Why This Matters

- **Conversion:** Google widgets are Scratchy's killer feature — but only if people can actually use them
- **Self-hosted ethos:** Users shouldn't need cloud provider accounts to use a self-hosted app
- **Competitive parity:** Every SaaS product ships embedded OAuth; self-hosted shouldn't be worse

## Google OAuth Requirements

To ship an embedded OAuth client ID that third-party users can authenticate against, the app must pass Google's verification process.

### Mandatory Requirements

| Requirement | Description | Status |
|-------------|-------------|--------|
| **Verified app** | App must be verified by Google to show to >100 users | ❌ Not started |
| **Privacy policy** | Public URL (e.g., `scratchy.app/privacy`) | ❌ Needs creation |
| **Terms of service** | Public URL (e.g., `scratchy.app/terms`) | ❌ Needs creation |
| **Homepage** | Public URL for the app | ✅ Exists |
| **Domain verification** | Prove ownership of domain via Google Search Console | ❌ Not started |
| **Authorized domains** | All redirect URIs must be on verified domains | ❌ Not started |
| **Scope justification** | Explain why each requested scope is needed | ❌ Needs preparation |

### Required Scopes

| Scope | Purpose | Sensitivity |
|-------|---------|-------------|
| `https://www.googleapis.com/auth/gmail.readonly` | Read emails for Gmail widget | **Sensitive** (restricted) |
| `https://www.googleapis.com/auth/gmail.send` | Send emails from Gmail widget | **Sensitive** (restricted) |
| `https://www.googleapis.com/auth/calendar.readonly` | Read calendar events | **Sensitive** |
| `https://www.googleapis.com/auth/calendar.events` | Create/edit calendar events | **Sensitive** |
| `openid` | User identification | Basic |
| `email` | User email address | Basic |
| `profile` | User name and avatar | Basic |

**⚠️ Gmail scopes are "restricted"** — these require the most rigorous verification, including a third-party security assessment (CASA Tier 2) unless the app qualifies for an exemption.

## Verification Process

### Timeline

```
Week 0     Submit app for verification
Week 1-2   Google reviews consent screen, privacy policy, scope justification
Week 2-3   Google may request changes or additional documentation
Week 3-4   If restricted scopes: CASA security assessment scheduling
Week 4-8   CASA assessment (if required) — third-party audit
Week 6-10  Final approval
```

**Realistic estimate: 4-10 weeks**, depending on scope sensitivity and review backlog.

### Required Documents

1. **Privacy policy** — must explicitly list all data accessed, how it's used, stored, shared
2. **Terms of service** — standard terms for the application
3. **Scope justification letter** — written explanation of why each scope is needed, with screenshots showing the feature
4. **Demo video** — screen recording of the OAuth flow and how data is used in the app
5. **Domain verification** — DNS TXT record or HTML file on `scratchy.app`

### CASA Security Assessment (for Restricted Scopes)

Since Gmail `send` and `readonly` are restricted scopes:

- Google requires a **CASA (Cloud Application Security Assessment)** — a third-party security audit
- **CASA Tier 2** applies for most apps — involves automated scanning + manual review
- **Cost:** $0-$5,000 depending on assessor and app complexity
- **Assessors:** Listed at [appdefensealliance.dev](https://appdefensealliance.dev)
- **Alternative:** If Scratchy only requests `gmail.readonly` (not `send`), it *may* qualify for a lighter review

### Exemption Possibilities

- **Internal use only** apps skip verification (but embedded client ID is for external users)
- **<100 users** can use unverified apps (shows scary warning, not acceptable for shipping)
- **Device flow** may have lighter verification requirements for some scope combinations

## Architecture

### Embedded Client ID

```
┌─────────────────────────────────────────────────┐
│              Scratchy Distribution               │
│                                                  │
│  config/defaults.json                            │
│  ├── google.clientId: "xxxx.apps.googleusercontent.com"  │
│  ├── google.scopes: [...]                        │
│  └── google.authProxy: "https://auth.scratchy.app"       │
│                                                  │
│  (Client secret NOT embedded — see auth proxy)   │
└─────────────────────────────────────────────────┘
```

**Key principle:** The client ID is public (per Google's design for web apps). The client secret is only needed for server-side token exchange — handled by the auth proxy or, for localhost, by a local PKCE flow.

### Token Flow

```
┌──────────┐    ┌──────────────┐    ┌─────────┐    ┌──────────────┐
│  Browser  │───►│ Google OAuth  │───►│ Redirect │───►│ Scratchy     │
│           │    │ Consent      │    │ Handler  │    │ Server       │
│           │    │ Screen       │    │          │    │              │
│           │◄───│              │◄───│          │◄───│ Stores token │
│           │    │              │    │          │    │ locally      │
└──────────┘    └──────────────┘    └─────────┘    └──────────────┘
```

### Token Storage

Tokens are stored **on the user's Scratchy server only**:

```
.scratchy-data/
  oauth/
    {userId}/
      google-tokens.json.enc    ← AES-256-GCM encrypted
        {
          "access_token": "ya29.xxx",
          "refresh_token": "1//xxx",
          "expiry": "2026-02-22T09:00:00Z",
          "scope": "...",
          "email": "user@gmail.com"
        }
```

- Encrypted at rest with the instance's master key (same as user store)
- Access tokens short-lived (1 hour), auto-refreshed via refresh token
- Users can revoke at any time (both in Scratchy UI and Google account settings)

### PKCE Flow (for Localhost / Known Domains)

For instances running on `localhost` or a domain registered as a redirect URI:

```
Browser → Google OAuth (with PKCE code_verifier)
       → Redirect to localhost:PORT/api/oauth/callback
       → Scratchy server exchanges code for tokens (using PKCE, no client secret needed)
       → Tokens stored locally
```

**PKCE (Proof Key for Code Exchange)** eliminates the need for a client secret in the browser-to-server flow, which is critical for embedded client IDs where the secret can't be safely distributed.

## Self-Hosted Challenge

### The Core Problem

Google OAuth requires **redirect URIs to be pre-registered** in the Cloud Console. Each Scratchy instance runs on a different domain:

- `scratchy.alice.dev`
- `192.168.1.50:3000`
- `home.bob.net:8080`
- `localhost:3000`

We **cannot** register every possible domain in advance.

### Solution Comparison

| Approach | Feasibility | UX | Privacy | Complexity |
|----------|-------------|-----|---------|------------|
| **(a) Central auth proxy** | ✅ Works | ✅ Seamless | ⚠️ Proxy sees auth code | Medium |
| **(b) Localhost redirect** | ✅ Works | ✅ Seamless (local only) | ✅ Perfect | Low |
| **(c) Wildcard redirect** | ❌ Not supported by Google | — | — | — |
| **(d) Device flow** | ✅ Works | ⚠️ Extra step | ✅ Perfect | Low |
| **(e) User registers own domain** | ✅ Works | ❌ Manual setup | ✅ Perfect | High (for user) |

### Recommended Approach: Hybrid

1. **Localhost** — PKCE flow directly, no proxy needed
2. **Known domains** — Pre-register common patterns (`*.scratchy.app` subdomains if we offer hosting)
3. **Any other domain** — Central auth proxy OR device flow (user's choice)
4. **Fallback** — User can always bring their own client ID (current behavior, preserved)

## Central Auth Proxy

### Architecture

```
┌───────────┐     ┌────────────────────┐     ┌──────────────────┐
│  Browser   │────►│  auth.scratchy.app  │────►│  Google OAuth     │
│  (on any   │     │  (Auth Proxy)       │     │  (consent screen) │
│   domain)  │     │                     │◄────│                    │
│            │◄────│  Receives auth code  │     └──────────────────┘
│            │     │  Forwards to origin  │
└───────────┘     └────────────────────┘
                          │
                          │ POST auth code to user's Scratchy instance
                          ▼
                  ┌──────────────────┐
                  │  User's Scratchy  │
                  │  (any domain)     │
                  │                   │
                  │  Exchanges code   │
                  │  for tokens       │
                  │  locally          │
                  └──────────────────┘
```

### Flow

1. User clicks "Sign in with Google" on their Scratchy instance (`scratchy.alice.dev`)
2. Scratchy constructs OAuth URL with:
   - `client_id`: embedded Scratchy client ID
   - `redirect_uri`: `https://auth.scratchy.app/callback`
   - `state`: encrypted payload containing `{ origin: "https://scratchy.alice.dev", nonce: "xxx" }`
3. User completes Google consent
4. Google redirects to `https://auth.scratchy.app/callback?code=xxx&state=xxx`
5. Auth proxy:
   - Decrypts `state` to extract origin URL
   - Validates origin is a legitimate Scratchy instance (handshake verification)
   - **Does NOT exchange the code** — forwards it to the origin
   - Redirects browser to `https://scratchy.alice.dev/api/oauth/google/complete?code=xxx`
6. User's Scratchy server exchanges the auth code for tokens using PKCE or client secret (stored locally)
7. Tokens stored on user's server — **auth proxy retains nothing**

### Auth Proxy Implementation

```javascript
// auth.scratchy.app — minimal Node.js / Cloudflare Worker
app.get('/callback', (req, res) => {
  const { code, state } = req.query;
  const { origin, nonce } = decrypt(state, PROXY_SECRET);

  // Validate origin
  if (!isValidScratchyInstance(origin)) {
    return res.status(400).send('Invalid origin');
  }

  // Forward code to origin — proxy never exchanges it
  const returnUrl = new URL('/api/oauth/google/complete', origin);
  returnUrl.searchParams.set('code', code);
  returnUrl.searchParams.set('nonce', nonce);

  res.redirect(302, returnUrl.toString());
});
```

### Auth Proxy Verification

To prevent abuse (malicious sites using Scratchy's client ID), the proxy validates that the origin is a real Scratchy instance:

1. **Pre-flight handshake:** Before starting OAuth, Scratchy instance registers with the proxy: `POST auth.scratchy.app/register { origin, instanceId, publicKey }`
2. **State signing:** The `state` parameter is signed with the instance's key — proxy verifies signature
3. **Instance fingerprint:** Proxy can optionally call `origin/.well-known/scratchy.json` to confirm it's a real instance
4. **Rate limiting:** Per-origin rate limits prevent abuse

## Privacy & Security

### Data Flow Guarantees

| Data | Where It Goes | Stored? |
|------|--------------|---------|
| **Auth code** | Google → auth proxy → user's server | ❌ Not stored anywhere (used once, exchanged immediately) |
| **Access token** | Google → user's server only | ✅ User's server only (encrypted) |
| **Refresh token** | Google → user's server only | ✅ User's server only (encrypted) |
| **Gmail/Calendar data** | Google → user's server only | ✅ User's server only (widget cache) |
| **User's email** | Google → user's server only | ✅ User's server only |
| **User's domain/IP** | User → auth proxy (in state) | ❌ Logged transiently, purged after redirect |

### Security Properties

- **Auth proxy is stateless** — no database, no user accounts, no persistent storage
- **Auth code is single-use** — even if intercepted, can only be exchanged once (by the correct code_verifier if PKCE)
- **PKCE protects against interception** — the auth code alone is useless without the code_verifier (which only the user's server knows)
- **State parameter is encrypted + signed** — prevents CSRF and origin spoofing
- **Client secret never distributed** — either PKCE is used (no secret needed) or the secret lives only on the auth proxy for the exchange step
- **Tokens are encrypted at rest** — AES-256-GCM on the user's server

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Auth proxy compromised | Proxy never holds tokens; worst case = auth codes (single-use, short-lived) |
| Man-in-the-middle | All flows are HTTPS; PKCE prevents code interception attacks |
| Malicious origin registration | Instance verification (`.well-known/scratchy.json`) + rate limiting |
| Token theft from user's server | Encrypted at rest; follows same security model as user's other Scratchy data |
| Abuse of embedded client ID | Proxy validates origins; Google rate limits per client ID; monitoring + alerting |
| Replay attacks | Nonce in state parameter; auth code single-use; PKCE code_verifier |

### Privacy Policy Requirements

The privacy policy at `scratchy.app/privacy` must state:

1. What data is accessed (Gmail, Calendar)
2. That data is processed **only on the user's own server**
3. That the auth proxy processes no personal data (only transient redirect)
4. How users can revoke access
5. That no data is sold or shared with third parties
6. Contact information for privacy inquiries

## Alternative Approach: Device Flow

### How It Works

Google's [device authorization grant](https://developers.google.com/identity/protocols/oauth2/limited-input-device) ("TV & Limited Input" flow) eliminates the redirect URI problem entirely:

```
┌──────────────┐     ┌─────────────────┐
│   Scratchy    │────►│  Google Device   │
│   Server      │     │  Auth Endpoint   │
│               │◄────│                  │
│  Gets:        │     │  Returns:        │
│  - device_code│     │  - user_code     │
│  - user_code  │     │  - verify URL    │
│  - verify URL │     └─────────────────┘
└──────┬───────┘
       │
       │ Shows to user:
       ▼
┌──────────────────────────────────┐
│  Go to: google.com/device        │
│  Enter code: WXYZ-ABCD           │
│                                   │
│  [Or click this direct link]      │
└──────────────────────────────────┘
       │
       │ User visits URL, enters code, consents
       │ Meanwhile, Scratchy polls Google...
       ▼
┌──────────────┐
│   Scratchy    │  ← receives tokens directly from Google
│   Server      │  ← no redirect URI needed
│               │  ← no auth proxy needed
└──────────────┘
```

### Advantages

- **No redirect URI needed** — works on any domain, any port, any network
- **No auth proxy needed** — direct server-to-Google communication
- **Perfect privacy** — no intermediary sees any data
- **Simple implementation** — no callback endpoints, just polling

### Disadvantages

- **Extra user step** — user must visit a separate URL and enter a code (or click a link)
- **Slightly worse UX** — not the seamless "click and done" of redirect flow
- **Polling delay** — Scratchy polls Google every 5 seconds until user completes auth (~10-30 seconds typical)
- **Not all scopes supported** — some restricted scopes may not be available via device flow (needs testing)
- **Google may restrict** — device flow is intended for limited-input devices; Google could tighten eligibility

### Recommendation

Offer **both flows**:

- **Default (remote/self-hosted):** Device flow — works everywhere, no proxy dependency
- **Enhanced (with proxy):** Redirect flow via `auth.scratchy.app` — seamless UX for users who prefer it
- **Local:** Localhost PKCE redirect — best UX for local development

Let the user choose in settings, with device flow as the zero-config default.

## Costs

| Item | Cost | Notes |
|------|------|-------|
| Google Cloud project | **Free** | OAuth client ID creation is free |
| Google API usage | **Free** | Gmail & Calendar APIs have generous free quotas |
| OAuth app verification | **Free** | Google doesn't charge for verification itself |
| CASA security assessment | **$0-$5,000** | Required for restricted Gmail scopes; some assessors offer free tier for open-source |
| Privacy policy / ToS | **Free** | Self-authored, hosted on `scratchy.app` |
| Domain verification | **Free** | DNS TXT record |
| Auth proxy hosting | **~$5/month** | Cloudflare Worker (free tier likely sufficient) or small VPS |
| Auth proxy domain | **Included** | Subdomain of `scratchy.app` |
| **Total upfront** | **$0-$5,000** | Dominated by CASA assessment cost |
| **Total ongoing** | **~$0-$5/month** | Auth proxy hosting |

### Cost Optimization

- Start with **device flow only** (no auth proxy needed) — $0 total
- If CASA assessment is prohibitive, request only non-restricted scopes initially (`calendar` only, defer `gmail.send`)
- Use Cloudflare Workers for auth proxy ($0 on free tier for <100K requests/day)

## Implementation Plan

### Phase 1: Foundation (1 session)

- [ ] Create Google Cloud project for Scratchy
- [ ] Configure OAuth consent screen (internal/testing mode)
- [ ] Register `scratchy.app` domain in Google Search Console
- [ ] Draft privacy policy and terms of service
- [ ] Create OAuth client ID with `localhost` redirect URIs

### Phase 2: Device Flow (1-2 sessions)

- [ ] Implement device flow auth in `lib/oauth/device-flow.js`
- [ ] Add "Sign in with Google" button to widget settings
- [ ] Implement token storage (`oauth/{userId}/google-tokens.json.enc`)
- [ ] Implement token refresh logic
- [ ] Update Gmail and Calendar widgets to use stored tokens
- [ ] Add "Disconnect Google" option in settings

### Phase 3: Auth Proxy (1-2 sessions)

- [ ] Build auth proxy service (Cloudflare Worker or Node.js)
- [ ] Deploy to `auth.scratchy.app`
- [ ] Implement instance registration + verification handshake
- [ ] Implement redirect flow with PKCE in Scratchy client
- [ ] Add proxy redirect URI to Google OAuth config
- [ ] User-facing toggle: "Use redirect flow (smoother) vs device flow (more private)"

### Phase 4: Google Verification (2-10 weeks, external)

- [ ] Submit app for OAuth verification
- [ ] Prepare scope justification document with screenshots
- [ ] Record demo video of OAuth flow and widget usage
- [ ] Respond to Google reviewer feedback
- [ ] Complete CASA assessment if required for Gmail scopes
- [ ] Ship verified client ID in Scratchy release

### Phase 5: Polish (1 session)

- [ ] Graceful fallback if embedded client ID is revoked or rate-limited
- [ ] "Bring your own client ID" option preserved as advanced setting
- [ ] Monitoring + alerting on auth proxy
- [ ] Usage analytics (anonymous, opt-in) to track adoption
- [ ] Documentation for self-hosters who want their own client ID

## Estimated Effort

| Phase | Sessions | Calendar Time | Notes |
|-------|----------|---------------|-------|
| 1: Foundation | 1 | 1 day | Google Cloud setup, legal docs |
| 2: Device Flow | 1-2 | 1-2 days | Core auth, widget integration |
| 3: Auth Proxy | 1-2 | 1-2 days | Optional enhanced flow |
| 4: Google Verification | — | 2-10 weeks | External dependency, mostly waiting |
| 5: Polish | 1 | 1 day | Fallbacks, monitoring, docs |
| **Total** | **4-6** | **~1 week dev + 2-10 weeks verification** | |

## Open Questions

1. **CASA assessment scope:** Do we need full CASA Tier 2 for `gmail.readonly` + `gmail.send`, or can we start with `gmail.readonly` only and get a lighter review? Could we defer `gmail.send` to a later phase?

2. **Open-source exemption:** Does Google offer any verification fast-track or CASA exemption for open-source projects? Some precedent exists but it's unclear.

3. **Device flow scope support:** Do all our required scopes work with Google's device flow? Need to test specifically with `gmail.send` and `calendar.events`.

4. **Client ID quotas:** What are Google's per-client-ID rate limits for OAuth? If Scratchy grows to thousands of instances, will we hit limits? Can we request quota increases?

5. **Revocation risk:** Google can revoke a verified app's status. What's our contingency? (Answer: "bring your own client ID" fallback must always work.)

6. **Auth proxy trust model:** Some privacy-conscious users may refuse to use the auth proxy. Device flow must remain a first-class option, not a degraded fallback.

7. **Multi-Google-account support:** Should users be able to link multiple Google accounts? (e.g., personal Gmail + work Google Workspace). Architecture supports it, but UI needs design.

8. **Token sharing across widgets:** Should a single Google OAuth token be shared between Gmail and Calendar widgets, or should each widget have its own token with minimal scopes? (Single token is simpler; per-widget is more granular.)

9. **Google Workspace (enterprise) compatibility:** Will our embedded client ID work for Google Workspace users, or will their admin need to whitelist the app? How do we handle domain-wide delegation?

10. **Auth proxy alternatives:** Could we use a serverless function on the user's own cloud (e.g., a Vercel/Netlify function they deploy) instead of a central proxy? Trades centralization for setup complexity.

## Decisions

1. **Device flow as default** — works everywhere with zero infrastructure; auth proxy is an enhancement, not a requirement.
2. **PKCE everywhere** — even when using the auth proxy, PKCE ensures the proxy can't exchange the code itself.
3. **Encrypted token storage** — same encryption scheme as Phase 19's user store (AES-256-GCM, instance master key).
4. **Preserve "bring your own"** — embedded client ID is the default, but users can always override with their own credentials.
5. **Start without Gmail send** — launch with `gmail.readonly` + `calendar` scopes to potentially avoid CASA, add `gmail.send` after verification.
