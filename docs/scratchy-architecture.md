# Scratchy Architecture Reference

> **Audience:** Sub-agents and AI assistants operating within the OpenClaw ecosystem.
> **Last updated:** 2026-02-23

Scratchy is a **GenUI (Generative UI) webchat client** for [OpenClaw](https://openclaw.com), an AI agent platform. It renders AI-generated UI components on a spatial canvas alongside a conversational chat interface. Think of it as a chat app where the AI can also build live dashboards, forms, charts, and interactive widgets — all streamed in real time.

This document is the authoritative reference for understanding Scratchy's internals. Read it before touching any Scratchy code or interacting with its systems.

---

## Quick Reference

The most critical information at a glance.

### Ports

| Service            | Port  | Notes                                      |
| ------------------ | ----- | ------------------------------------------ |
| Scratchy (main)    | 3001  | Express + WebSocket server (`serve.js`)    |
| Scratchy Canvas    | 3002  | Separate canvas service                    |
| OpenClaw Gateway   | 28945 | Scratchy connects here for AI routing      |

### Key Paths

| Path                                         | Purpose                              |
| -------------------------------------------- | ------------------------------------ |
| `serve.js`                                   | ALL backend logic (~2500 lines)      |
| `web/index.html`                             | SPA entry point                      |
| `web/js/app.js`                              | Client app (routing, state, views)   |
| `web/js/connection.js`                       | WebSocket client (reconnect, keepalive) |
| `web/js/messages.js`                         | Chat message rendering + canvas op parsing |
| `web/js/canvas.js`                           | Canvas grid renderer (34 types)      |
| `web/js/live-components.js`                  | LiveComponent registry               |
| `web/js/music-components.js`                 | Music/media components               |
| `web/css/style.css`                          | All styles (dark theme, Geist, indigo) |
| `.scratchy-data/`                            | All persistent data                  |
| `.scratchy-data/widget-state/{userId}/`      | Per-user widget state (isolated)     |
| `.scratchy-data/analytics/`                  | Usage analytics (JSONL + JSON)       |
| `.canvas-state.json`                         | Server-side canvas state backup      |

### Essential Commands

```bash
# Restart Scratchy (ALWAYS use systemctl — never start manually)
systemctl --user restart scratchy

# Restart Cloudflare tunnel (NEVER kill -HUP cloudflared)
systemctl --user restart cloudflared-scratchy

# Syntax-check JS before deploying (mandatory)
node -c serve.js
node -c web/js/app.js
# etc.
```

### Critical Rules

1. **Never start Scratchy manually** — always use `systemctl --user restart scratchy`.
2. **Never `kill -HUP` cloudflared** — always use `systemctl --user restart cloudflared-scratchy`.
3. **Always run `node -c` on JS files** before deploying changes.
4. **Never call Google/widget APIs directly** from the agent — always trigger widget actions through the message interface.
5. **Smart components, dumb agent** — components have their own logic. The agent configures parameters, not behavior.

---

## System Overview

Scratchy is a monolithic Node.js application with a clear client-server split:

```
┌─────────────────────────────────────────────────────────┐
│                    Client (Browser)                      │
│                                                         │
│  ┌─────────┐  ┌────────────┐  ┌───────────────────┐    │
│  │  app.js  │  │ messages.js│  │    canvas.js      │    │
│  │ (router) │  │ (chat UI)  │  │ (34 component     │    │
│  │          │  │            │  │  types, grid)      │    │
│  └────┬─────┘  └─────┬──────┘  └────────┬──────────┘    │
│       │               │                  │               │
│       └───────┬───────┘──────────────────┘               │
│               │                                          │
│        ┌──────┴──────┐                                   │
│        │connection.js│  ← WS + keepalive + reconnect     │
│        └──────┬──────┘                                   │
└───────────────┼──────────────────────────────────────────┘
                │ WebSocket (port 3001)
┌───────────────┼──────────────────────────────────────────┐
│               │           Server (serve.js)               │
│        ┌──────┴──────┐                                   │
│        │  Express +   │                                   │
│        │  WS Server   │                                   │
│        └──────┬──────┘                                   │
│               │                                          │
│  ┌────────────┼────────────────────────────┐             │
│  │            │            │               │             │
│  ▼            ▼            ▼               ▼             │
│ Auth     Widget       Canvas State    Gateway WS         │
│ Middleware Handlers   (_serverCanvas   (port 28945)       │
│            (sn-,cal-,  State)         → OpenClaw          │
│             mail-,etc)                                    │
└─────────────────────────────────────────────────────────┘
```

**Key architectural trait:** Everything lives in `serve.js`. There is no microservice architecture, no ORM, no external database. It's one big Express + WebSocket server file (~2500 lines) that handles auth, routing, widget logic, canvas state, and gateway communication. The client is a vanilla JS SPA (no framework — no React, no Vue, no Svelte).

---

## Server Architecture

### serve.js — The Monolith

All backend logic lives in a single file: `serve.js`. It runs on **port 3001** and hosts both the Express HTTP server and the WebSocket server (using the HTTP upgrade handler on the same port).

### HTTP Routes

| Route Pattern        | Purpose                                           |
| -------------------- | ------------------------------------------------- |
| `/api/chat`          | HTTP fallback for chat (when WS unavailable)      |
| `/api/history`       | Chat history retrieval                            |
| `/api/attachment`    | File attachment handling                          |
| `/api/analytics/*`   | Usage analytics endpoints                         |
| `/api/auth/*`        | Authentication (login, register, passkey, etc.)   |
| `/api/admin/*`       | Admin-only endpoints (user management, etc.)      |

### WebSocket Protocol

The WS server handles real-time bidirectional communication between the client and serve.js. Messages are JSON objects with a `type` field:

**Server → Client messages:**

| Type       | Shape                              | Purpose                          |
| ---------- | ---------------------------------- | -------------------------------- |
| `chat`     | `{ type: "chat", data: ... }`      | Chat message (AI response, etc.) |
| `canvas`   | `{ type: "canvas", ops: [...] }`   | Canvas operations (upsert, patch, etc.) |
| `status`   | `{ type: "status", ... }`          | Status updates (typing, connected, etc.) |

### Gateway Connection

Scratchy maintains a persistent WebSocket connection to the **OpenClaw gateway** on port **28945**. This is the bridge between the user's chat and the AI:

1. User sends a message via the Scratchy client.
2. `serve.js` receives it over WS.
3. If it matches a **widget action prefix** (e.g., `cal-month`), it routes to the widget handler locally.
4. Otherwise, it forwards the message to the OpenClaw gateway.
5. The gateway routes it to the appropriate AI model.
6. AI responses stream back through the gateway → `serve.js` → client.

### Canvas State Management

The server maintains a `_serverCanvasState` object that tracks all canvas components across sessions. This enables:

- **Cross-device sync**: When a user reconnects (different device, page reload), the full canvas state is pushed to the client.
- **State backup**: Periodically written to `.canvas-state.json` for persistence across restarts.
- **Consistency**: The server is the source of truth for what's on the canvas.

---

## Client Architecture

The client is a **vanilla JavaScript SPA** — no build step, no framework, no bundler. Files are served directly from `web/`.

### Core Client Files

| File                       | Responsibility                                              |
| -------------------------- | ----------------------------------------------------------- |
| `web/index.html`           | SPA shell, script/style loading                             |
| `web/js/app.js`            | Main application: routing, global state, view switching     |
| `web/js/connection.js`     | WebSocket lifecycle: connect, reconnect, keepalive, buffering |
| `web/js/messages.js`       | Chat message rendering: markdown parsing, streaming text, canvas op extraction |
| `web/js/canvas.js`         | Canvas grid: renders 34 component types in a responsive layout |
| `web/js/live-components.js`| LiveComponent registry: create, update, remove component instances |
| `web/js/music-components.js`| Media components: player, media-list, carousel (monkey-patches LiveComponents) |
| `web/css/style.css`        | All styles: dark theme, Geist font family, indigo accent color |

### View Modes

Scratchy has two primary views:

1. **Chat View** — Traditional message list with an inline canvas area. Messages appear sequentially with markdown rendering, code blocks, and embedded canvas previews.
2. **Canvas View** — Full spatial grid showing all active canvas components. Think of it as a dashboard mode.

**Auto canvas switch:** When canvas operations arrive during an AI response, the client automatically flips to Canvas View so the user sees the components being built in real time.

### WebSocket Connection Strategy

The connection layer (`connection.js`) is battle-hardened for real-world conditions, particularly Cloudflare's aggressive WebSocket timeouts:

| Mechanism              | Interval/Threshold | Purpose                                           |
| ---------------------- | ------------------ | ------------------------------------------------- |
| **JSON keepalive**     | Every 30s          | Prevents Cloudflare from killing idle WS (~2min timeout) |
| **Zombie detection**   | 15s ping + 5s pong | Detects dead connections that OS hasn't noticed    |
| **Staleness watchdog** | 10s gap threshold  | Forces reconnect if no data received for 10s      |
| **Message cache**      | localStorage       | Buffers messages during disconnects for seamless UX |

### Streaming & Canvas Op Parsing

The `StreamCanvasParser` in `messages.js` is a key innovation: it parses canvas operations **live** during the AI's streaming response. This means:

- Users see components appear and update in real time as the AI generates them.
- There's no waiting for a complete code block or response end.
- Operations fire as soon as they're syntactically complete in the stream.

### History Render Cap

The client caps history rendering at **200 messages**. This is a hard-learned limit — rendering 2800+ messages froze the browser entirely. Older messages are available via the history API but aren't rendered in the DOM.

---

## Canvas System

The canvas is Scratchy's defining feature — a spatial grid where AI-generated UI components live, persist, and update in real time.

### Component Types (34 Total)

Scratchy supports 34 distinct component types, each with its own rendering logic, default sizing, and interaction patterns:

| Category      | Types                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| **Layout**    | hero, card, accordion, tabs                                            |
| **Data**      | stats, gauge, progress, sparkline, table, kv, tags, timeline, streak   |
| **Charts**    | chart-bar, chart-line, chart-pie, stacked-bar                          |
| **Input**     | buttons, chips, toggle, input, slider, rating, form, form-strip        |
| **Content**   | alert, status, weather, code, video, image, link-card, checklist       |
| **Special**   | month-calendar                                                         |

### Canvas Operations

Operations are the instructions that manipulate the canvas. They arrive via the `{ type: "canvas", ops: [...] }` WebSocket message.

| Operation  | Purpose                                                        |
| ---------- | -------------------------------------------------------------- |
| `upsert`   | Create a new component, or fully replace an existing one by ID |
| `patch`    | Partially update an existing component's properties            |
| `remove`   | Delete a specific component by ID                              |
| `clear`    | Remove all components from the canvas                          |
| `layout`   | Change the grid layout configuration                           |
| `move`     | Reposition a component within the grid                         |
| `trigger`  | Fire an event/action on a component                            |

**Key behavior:** Components **persist** until explicitly removed. Use `patch` to update existing components (e.g., changing a stat value). Use `upsert` to create new components or fully replace existing ones. This persistence model means the canvas accumulates state across multiple AI turns.

### Canvas Formats

Canvas operations can be encoded in three formats, optimized for different use cases:

| Format            | Code Block Identifier | Description                                    |
| ----------------- | --------------------- | ---------------------------------------------- |
| **JSON**          | `scratchy-canvas`     | Standard JSON format. Verbose but readable.    |
| **TOON**          | `scratchy-toon`       | Compact format with 30-40% token savings over JSON. Used for high-volume ops. |
| **Templates**     | `scratchy-tpl`        | Template-based format for reusable component patterns. |

### Responsive Grid

The canvas uses a responsive column grid that adapts to viewport width:

| Viewport         | Columns | Notes                          |
| ---------------- | ------- | ------------------------------ |
| Small (mobile)   | 1       | Full-width components          |
| Medium (tablet)  | 2       | Side-by-side layout            |
| Large (laptop)   | 3       | Dashboard-style                |
| XL (desktop)     | 4       | Full dashboard                 |

Components have **type-based spanning** — some types (like `hero`, `table`) automatically span multiple columns for better readability.

---

## Authentication System

Scratchy implements its own auth system with no external auth provider. Everything is file-based.

### User Store

- **Storage**: A single JSON file, encrypted with **AES-256-GCM**.
- **Passwords**: Hashed with **Argon2id** (memory-hard, GPU-resistant). Minimum 12 characters.
- **Sessions**: Cookie-based with per-user session keys. No JWTs.

### Passkeys (WebAuthn/FIDO2)

Scratchy supports passwordless authentication via WebAuthn passkeys. Users can register hardware keys (YubiKey, etc.) or platform authenticators (Touch ID, Windows Hello) as login credentials.

### Per-User Capabilities

Each user has a granular capability profile controlling what they can do:

- **14 tools** available (toggleable per user): `exec`, `read`, `write`, `edit`, `web_search`, `web_fetch`, `browser`, `image`, `tts`, `sessions_spawn`, and more.
- **5 AI models** available (toggleable per user).
- **Feature flags**: Sub-agents, TTS, and other features can be enabled/disabled per user.
- **Operator defaults**: `exec`, `read`, `write`, `edit`, `web_search`, `web_fetch`, `browser`, `image`, `tts`, `sessions_spawn`.

### Access Control

- Admin actions are blocked for non-admin users at the route level.
- **BYOK (Bring Your Own Key)** users who supply their own API keys bypass usage quotas, but tool blacklists still apply.

---

## Widget System

Widgets are **standalone mini-applications** embedded within the Scratchy chat experience. They have their own server-side logic, handle OAuth flows, and push real-time updates to the client.

### How Widgets Work

1. User sends a message like `cal-month` or `mail-inbox`.
2. `serve.js` checks for an **action prefix** match.
3. Instead of forwarding to the AI, it routes to the appropriate widget handler.
4. The widget handler processes the action (fetches data, renders components, etc.).
5. Canvas ops are pushed to the client over WS.

### Action Prefix Routing

| Prefix       | Widget           | Example Actions                        |
| ------------ | ---------------- | -------------------------------------- |
| `sn-*`       | Standard Notes   | `sn-list`, `sn-view`, `sn-create`     |
| `cal-*`      | Calendar         | `cal-month`, `cal-week`, `cal-create`  |
| `mail-*`     | Email            | `mail-inbox`, `mail-read`, `mail-send` |
| `spotify-*`  | Spotify          | `spotify-play`, `spotify-search`       |
| `youtube-*`  | YouTube          | `youtube-search`, `youtube-play`       |
| `admin-*`    | Admin            | `admin-dashboard`, `admin-monitor`, `admin-quotas` |

### Widget Capabilities

- **OAuth handling**: Widgets manage their own OAuth flows and token refresh cycles.
- **Navigation**: Interactive buttons within widget components trigger further widget actions (e.g., clicking a calendar event opens its details).
- **Live views**: Server-side polling at **3-second intervals** pushes `patch` operations over WS. This keeps widget views (like the admin monitor or email inbox) updated in near real-time without client-side polling.
- **Shared OAuth tokens**: Calendar and Email widgets share the same Google OAuth session, so authenticating once covers both.

### Critical Widget Rule

**Never call Google/widget APIs directly from the agent.** Always trigger widget actions through the Scratchy message interface. The widget handlers manage auth, rate limiting, error handling, and response formatting. Going around them breaks all of that.

---

## Data Storage

Scratchy uses **no external database**. All data is file-based, stored under the `.scratchy-data/` directory.

### Storage Layout

```
.scratchy-data/
├── widget-state/
│   └── {userId}/           # Per-user widget state (isolated)
│       ├── calendar.json
│       ├── email.json
│       └── ...
├── analytics/
│   ├── events.jsonl        # Raw event stream (append-only)
│   └── rollups.json        # Aggregated analytics
└── ...

.canvas-state.json          # Server-side canvas state backup (root level)
```

### Storage Patterns

- **User data isolation**: Widget state is stored per-user under `.scratchy-data/widget-state/{userId}/`. One user's state never leaks to another.
- **Analytics**: Raw events are stored as JSONL (one JSON object per line, append-only). Rollups are periodically computed and stored as standard JSON.
- **Canvas state**: The `_serverCanvasState` object is periodically serialized to `.canvas-state.json` for crash recovery.

---

## Real-Time Update System

Scratchy's real-time capabilities go beyond simple chat messaging. Multiple subsystems push live data to connected clients.

### Update Sources

| Source                | Frequency    | What It Pushes                              |
| --------------------- | ------------ | ------------------------------------------- |
| AI chat responses     | On demand    | `chat` messages, `canvas` ops (streamed)    |
| Widget live views     | On change    | `canvas` patch ops for widget components    |
| Admin monitor         | Every 3s     | CPU, RAM, disk usage, active connections    |
| Widget polling        | Every 3s     | State changes from external APIs            |

### Flow for AI-Generated Canvas Updates

1. User sends a chat message.
2. Message is forwarded to OpenClaw gateway.
3. AI generates a response containing canvas ops (in `scratchy-canvas`, `scratchy-toon`, or `scratchy-tpl` format).
4. `serve.js` receives the streaming response from the gateway.
5. The stream is forwarded to the client via WS.
6. `StreamCanvasParser` on the client extracts canvas ops **as they stream**.
7. `canvas.js` renders/updates components immediately.
8. `_serverCanvasState` on the server is updated for sync purposes.

---

## Key Design Patterns

### Smart Components, Dumb Agent

This is the most important pattern in Scratchy. Canvas components are **not** dumb HTML templates — they have their own internal logic:

- **Streaming**: Components can stream data and update progressively.
- **Polling**: Widget components can trigger server-side polling for live data.
- **Animation**: Components handle their own transitions and animations.
- **Interaction**: Buttons, toggles, sliders, etc. handle user input and trigger actions.

The AI agent's job is to **configure** components by setting their parameters. It does not control component behavior at runtime. This separation keeps the agent's token usage low and the UI responsive.

### File-Based Everything

There is no PostgreSQL, no Redis, no MongoDB. Everything is JSON or JSONL files on disk. This keeps the deployment simple (single process, no dependencies) but means:

- No query language — you read/write/grep files.
- No transactions — file writes should be atomic where possible.
- No horizontal scaling — single server only.

### Monolith by Design

`serve.js` being one ~2500-line file is intentional, not technical debt. It keeps the entire request lifecycle visible in one place and avoids the complexity of module boundaries for a system this size.

---

## Operational Notes

### Service Management

Scratchy runs as a systemd user service. Always manage it through systemctl:

```bash
# Check status
systemctl --user status scratchy

# Restart (most common operation)
systemctl --user restart scratchy

# View logs
journalctl --user -u scratchy -f

# Cloudflare tunnel (separate service)
systemctl --user restart cloudflared-scratchy
```

**Never run `node serve.js` directly** — the systemd unit handles environment variables, working directory, restart policies, and log management.

**Never `kill -HUP` cloudflared** — it doesn't handle SIGHUP gracefully. Always restart the systemd unit.

### Pre-Deployment Checklist

Before deploying any JavaScript changes:

1. **Syntax check** all modified files:
   ```bash
   node -c serve.js
   node -c web/js/app.js
   node -c web/js/canvas.js
   # ... any modified file
   ```
2. Review changes for obvious issues (typos in WS message types, missing commas in component configs, etc.).
3. Restart via systemctl.
4. Monitor logs for errors in the first 30 seconds.

### Common Pitfalls

| Pitfall                                     | Consequence                           | Prevention                                      |
| ------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| Starting Scratchy manually (`node serve.js`)| Missing env vars, no auto-restart     | Always use `systemctl --user restart scratchy`   |
| Sending `kill -HUP` to cloudflared          | Tunnel goes down, no recovery         | Use `systemctl --user restart cloudflared-scratchy` |
| Skipping `node -c` before deploy            | Syntax error crashes server           | Always syntax-check modified JS files            |
| Calling Google APIs directly from agent     | Auth failures, rate limit issues      | Trigger widget actions through Scratchy          |
| Rendering 200+ messages in chat history     | Browser freeze/crash                  | History render cap enforced at 200               |
| Forgetting canvas components persist        | Stale data on screen                  | Use `remove` or `clear` ops to clean up          |

---

## Appendix: Component Type Reference

For quick lookup, here are all 34 component types grouped by category:

**Layout & Structure:** `hero` · `card` · `accordion` · `tabs`

**Data Display:** `stats` · `gauge` · `progress` · `sparkline` · `table` · `kv` · `tags` · `timeline` · `streak`

**Charts & Visualization:** `chart-bar` · `chart-line` · `chart-pie` · `stacked-bar`

**User Input:** `buttons` · `chips` · `toggle` · `input` · `slider` · `rating` · `form` · `form-strip`

**Content & Media:** `alert` · `status` · `weather` · `code` · `video` · `image` · `link-card` · `checklist`

**Specialized:** `month-calendar`

---

## Appendix: WebSocket Message Quick Reference

**Client → Server:**
- Chat message: `{ type: "chat", message: "..." }`
- Keepalive: JSON ping every 30 seconds

**Server → Client:**
- Chat: `{ type: "chat", data: ... }`
- Canvas ops: `{ type: "canvas", ops: [...] }`
- Status: `{ type: "status", ... }`

---

*This document covers Scratchy's architecture as of February 2026. For implementation details, refer to the source files listed in the Core Files section.*
