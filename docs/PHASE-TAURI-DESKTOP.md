# Phase: Tauri Desktop Build

## Overview

Ship Scratchy as a native desktop application using Tauri 2. The web app stays the same — vanilla HTML/CSS/JS rendered in a sandboxed WebView — but the surrounding shell becomes a real desktop citizen: system tray, native OS notifications, offline capability, auto-start, global shortcuts, deep links (`scratchy://`), and no browser tab required.

**Why native:**
- **System tray** — persistent presence, connection status at a glance, quick actions
- **Native notifications** — OS-level alerts that work even when the window is hidden
- **Offline resilience** — embedded frontend, local caching, reconnect logic in Rust
- **No browser dependency** — dedicated window, no tab clutter, no accidental close
- **Deep links** — `scratchy://` protocol for opening conversations, connecting to gateways
- **Auto-update** — seamless background updates without manual downloads

**Target platforms:**
| Platform | Minimum Version | WebView Engine |
|----------|----------------|----------------|
| macOS | 10.15 (Catalina) | WebKit (WKWebView) |
| Windows | 10 (1803+) | WebView2 (Chromium-based) |
| Linux | Ubuntu 20.04+ / Fedora 36+ | WebKitGTK |

## Current State

The `src-tauri/` directory already has a working Tauri 2 scaffold:

```
src-tauri/
├── Cargo.toml          ✅ Dependencies: tauri 2, tokio, tokio-tungstenite, futures-util, serde
├── tauri.conf.json     ✅ Basic config: window 900×700, frontendDist → ../web
├── build.rs            ✅ Standard tauri_build::build()
├── icons/
│   └── icon.ico        ✅ Windows icon (other formats needed)
└── src/
    ├── main.rs          ✅ Entry point, calls scratchy_lib::run()
    ├── lib.rs           ✅ Tauri builder with AppState, commands registered
    └── gateway.rs       ✅ WebSocket client — connect, handshake, send_message, event emitter
```

**What works:**
- Tauri app compiles and launches with the web frontend in a WebView
- Rust gateway client (`gateway.rs`) connects to OpenClaw via WebSocket
- Protocol v3 handshake implemented (connect frame with client metadata)
- `connect_gateway` command: JS calls Rust to establish WS connection
- `send_message` command: JS sends chat messages through Rust WS writer
- Background reader loop emits `gateway-message` events to the frontend
- Shared state via `Arc<Mutex<Option<WsWriter>>>` for thread-safe access

**What's missing:**
- Frontend doesn't use the Rust gateway yet (still uses JS WebSocket via serve.js proxy)
- No system tray
- No native notifications
- No auto-start, global shortcuts, or deep links
- No auto-update mechanism
- No offline support or local caching
- CSP is `null` (wide open — needs hardening)
- No CI/CD pipeline or code signing
- Icons incomplete (only .ico, missing .icns, .png variants)
- No reconnection logic in gateway.rs (connection drops = dead)

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Scratchy Desktop App                    │
│                                                           │
│  ┌─────────────────────┐     ┌─────────────────────────┐ │
│  │   Rust Backend       │     │   WebView Frontend      │ │
│  │                      │     │                         │ │
│  │  ┌────────────────┐  │ IPC │  ┌───────────────────┐  │ │
│  │  │ gateway.rs     │◄─┼─────┼──│ scratchy.js       │  │ │
│  │  │ • WS client    │  │     │  │ • Chat UI         │  │ │
│  │  │ • Reconnect    │──┼─────┼─►│ • Canvas          │  │ │
│  │  │ • Handshake    │events  │  │ • Widgets         │  │ │
│  │  └────────────────┘  │     │  └───────────────────┘  │ │
│  │                      │     │                         │ │
│  │  ┌────────────────┐  │     │  web/                   │ │
│  │  │ tray.rs        │  │     │  ├── index.html         │ │
│  │  │ • Status icon  │  │     │  ├── css/               │ │
│  │  │ • Menu         │  │     │  ├── js/                │ │
│  │  └────────────────┘  │     │  └── icons/             │ │
│  │                      │     │                         │ │
│  │  ┌────────────────┐  │     └─────────────────────────┘ │
│  │  │ notifications  │  │                                 │
│  │  │ autostart      │  │                                 │
│  │  │ updater        │  │                                 │
│  │  │ deep-link      │  │                                 │
│  │  │ global-shortcut│  │                                 │
│  │  └────────────────┘  │                                 │
│  └─────────────────────┘                                  │
│                                                           │
└──────────────────────────────────────────────────────────┘
            │
            │ WebSocket (native TLS)
            ▼
   ┌──────────────────┐
   │  OpenClaw Gateway │
   │  (localhost:28945 │
   │   or remote)      │
   └──────────────────┘
```

### Tauri 2 IPC Model

Communication between the Rust backend and JS frontend uses Tauri's command/event system:

**Commands (JS → Rust):**
```javascript
// Frontend calls a Rust function and awaits the result
const result = await invoke('connect_gateway', { token: 'abc123' });
const sent   = await invoke('send_message', { message: 'Hello' });
```

**Events (Rust → JS):**
```rust
// Backend emits events that JS listens to
app_handle.emit("gateway-message", &text).ok();
app_handle.emit("gateway-status", "connected").ok();
```

```javascript
// Frontend listens for Rust events
import { listen } from '@tauri-apps/api/event';
await listen('gateway-message', (event) => { handleMessage(event.payload); });
await listen('gateway-status',  (event) => { updateStatusUI(event.payload); });
```

**State management:**
- `AppState` struct in Rust holds shared state (`WsWriter`, connection status, config)
- Accessed in commands via `tauri::State<'_, AppState>`
- Thread-safe via `Arc<Mutex<T>>` wrappers

## Native Gateway Client

### Current: JS WebSocket via serve.js Proxy

```
Browser  ──WS──►  serve.js (:3001)  ──WS──►  OpenClaw Gateway (:28945)
                  (Node.js proxy)
```

The web app connects to serve.js, which proxies WebSocket frames to the gateway. This adds a Node.js dependency, latency, and a failure point.

### Target: Direct Rust WebSocket Client

```
WebView  ──IPC──►  gateway.rs  ──WS──►  OpenClaw Gateway (:28945)
                  (Rust, native TLS)
```

The Rust backend connects directly to the gateway. No serve.js, no proxy, no Node.js runtime. The frontend communicates with the Rust gateway client via Tauri IPC.

### gateway.rs Enhancements Needed

```rust
// Current state — basic connect + send
pub async fn connect(url: &str, app_handle: AppHandle) -> Result<WsWriter, String>
pub async fn send_message(writer: &WsWriter, message: &str) -> Result<(), String>

// Needed additions:
pub async fn disconnect(writer: &WsWriter) -> Result<(), String>
pub async fn reconnect(state: &AppState, app_handle: AppHandle) -> Result<(), String>

// Connection status tracking
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting { attempt: u32, next_retry_ms: u64 },
    Failed { reason: String },
}

// Auto-reconnect with exponential backoff
// Base: 1s, max: 30s, jitter: ±500ms
// Emits gateway-status events on each state change
```

### Frontend Integration Layer

A thin JS adapter makes the Rust gateway transparent to the existing frontend:

```javascript
// web/js/tauri-gateway.js
// Drop-in replacement for the WebSocket connection in the web app

class TauriGateway {
    async connect(token) {
        await invoke('connect_gateway', { token });
        await listen('gateway-message', (e) => this.onMessage(e.payload));
        await listen('gateway-status',  (e) => this.onStatus(e.payload));
    }
    async send(message) {
        await invoke('send_message', { message });
    }
}

// Feature detection: use Tauri IPC if available, fall back to WebSocket
const gateway = window.__TAURI__ ? new TauriGateway() : new WebSocketGateway();
```

This means the web frontend works both in the desktop app (Tauri IPC) and in a browser (classic WebSocket via serve.js). Zero code duplication.

## Native Features

### System Tray

**Plugin:** `tauri-plugin-shell` (built-in tray support in Tauri 2)

```
┌─── System Tray ──────────────┐
│  🐱 Scratchy                  │
│  ─────────────────────        │
│  ● Connected to gateway       │  ← status indicator
│  ─────────────────────        │
│  Show Window                  │
│  ─────────────────────        │
│  Preferences...               │
│  Check for Updates            │
│  ─────────────────────        │
│  Quit Scratchy                │
└───────────────────────────────┘
```

**Tray icon states:**
| State | Icon | Description |
|-------|------|-------------|
| Connected | 🟢 🐱 | Active gateway connection |
| Reconnecting | 🟡 🐱 | Attempting to reconnect |
| Disconnected | 🔴 🐱 | No gateway connection |
| Unread messages | 🔵 🐱 | New messages while window hidden |

**Implementation:** New `src/tray.rs` module.

### Native Notifications

**Plugin:** `tauri-plugin-notification`

Trigger OS-level notifications for:
- New agent messages when window is hidden/unfocused
- Gateway connection lost / restored
- Auto-update available / installed
- Reminder/calendar events from the agent

```rust
use tauri_plugin_notification::NotificationExt;

app_handle.notification()
    .builder()
    .title("Scratchy")
    .body("New message from your agent")
    .icon("notification-icon")
    .show()
    .unwrap();
```

**Behavior:**
- Click notification → focus Scratchy window, scroll to message
- Respect OS Do Not Disturb / Focus modes
- Configurable: user can mute notification categories

### Auto-Start on Boot

**Plugin:** `tauri-plugin-autostart`

```rust
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

tauri::Builder::default()
    .plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        Some(vec!["--minimized"]),
    ))
```

- Default: disabled (opt-in via preferences)
- `--minimized` flag: start hidden in tray, no window
- macOS: LaunchAgent (user-level, survives updates)
- Windows: Registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- Linux: XDG autostart `.desktop` file

### Global Shortcuts

**Plugin:** `tauri-plugin-global-shortcut`

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Shift + S` | Toggle Scratchy window (show/hide) |
| `Cmd/Ctrl + Shift + N` | New conversation |
| `Cmd/Ctrl + Shift + C` | Copy last agent response |

- Configurable in preferences
- Conflict detection with existing OS shortcuts

### Deep Links

**Plugin:** `tauri-plugin-deep-link`

Register `scratchy://` protocol handler:

| URI | Action |
|-----|--------|
| `scratchy://connect?gateway=ws://host:port&token=abc` | Connect to a specific gateway |
| `scratchy://chat?message=hello` | Open Scratchy and send a message |
| `scratchy://settings` | Open preferences |

```json
// tauri.conf.json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["scratchy"]
      }
    }
  }
}
```

## Offline Support

### Embedded Frontend

The web frontend (`web/` directory) is bundled into the Tauri binary at build time via `frontendDist`. No serve.js needed, no HTTP server, no Node.js runtime. The WebView loads files directly from the embedded bundle.

### Local Caching Strategy

```
~/.scratchy/
├── config.json          ← gateway URL, token (encrypted), preferences
├── cache/
│   ├── messages.db      ← SQLite: recent messages for offline viewing
│   └── canvas-state.json ← last canvas state for instant render
└── logs/
    └── scratchy.log     ← application logs (rotated)
```

**SQLite for message cache:**
- Store last N messages (configurable, default 1000)
- Full-text search over cached messages
- Sync on reconnect — fetch delta from gateway
- Plugin: `tauri-plugin-sql` or raw `rusqlite`

**Offline behavior:**
1. App launches → loads cached messages + canvas state → renders instantly
2. Attempts gateway connection in background
3. If offline: UI shows "offline" badge, chat input disabled, cached content visible
4. On reconnect: sync messages, resume normal operation

### Direct Gateway Connection

In desktop mode, the Rust backend connects directly to the OpenClaw gateway WebSocket. No intermediary:

```
App launch
  → Load config (gateway URL + encrypted token)
  → gateway.rs::connect()
  → Handshake (protocol v3)
  → Background reader loop (emit events to WebView)
  → Ready
```

If the gateway is on `localhost`, no network dependency at all (the OpenClaw daemon runs locally).

## Auto-Update

**Plugin:** `tauri-plugin-updater`

### Update Flow

```
App start (or periodic check)
  → GET https://update.scratchy.dev/{target}/{arch}/{current_version}
  → Server responds: 204 (no update) or 200 (update available)
  → User prompted (or auto-install if configured)
  → Download + verify signature
  → Replace binary, restart
```

### Update Channels

```json
// config.json
{
  "updateChannel": "stable"  // stable | beta | nightly
}
```

| Channel | Audience | Frequency |
|---------|----------|-----------|
| `stable` | Everyone | On release (semver tags) |
| `beta` | Opt-in testers | Pre-release tags |
| `nightly` | Developers | Every commit to main |

### Update Server

Options (in order of preference):
1. **GitHub Releases** — free, built-in Tauri support, works out of the box
2. **Self-hosted** — simple static file server with the Tauri update JSON format
3. **CrabNebula Cloud** — managed Tauri update service (if scale warrants it)

### Tauri Updater Config

```json
// tauri.conf.json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/user/scratchy/releases/latest/download/latest.json"
      ],
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6...",
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

### Delta Updates

Tauri 2 doesn't support delta updates natively. Options:
- Full binary replacement (simple, reliable, Tauri default)
- Consider `tauri-plugin-updater` with custom delta logic in a future phase
- For now: full updates are fine — Scratchy binary is ~10-15 MB

## Build Pipeline

### GitHub Actions CI/CD

```yaml
# .github/workflows/release.yml
name: Release Desktop

on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin
            label: macOS-arm64
          - os: macos-latest
            target: x86_64-apple-darwin
            label: macOS-x64
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            label: Windows-x64
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            label: Linux-x64

    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: tauri-apps/tauri-action@v0
        with:
          tagName: v__VERSION__
          releaseName: 'Scratchy v__VERSION__'
          releaseBody: 'See CHANGELOG.md for details.'
          releaseDraft: true
          prerelease: false
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS signing
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          # Windows signing
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
```

### Code Signing

| Platform | Method | Requirement |
|----------|--------|-------------|
| macOS | Apple Developer certificate + Notarization | Apple Developer account ($99/yr) |
| Windows | Authenticode (EV or OV certificate) | Code signing cert from CA |
| Linux | GPG signature on packages | GPG key pair |

**macOS Notarization:**
- Required for apps distributed outside the Mac App Store
- Tauri handles this automatically with the right env vars
- Without notarization: "unidentified developer" Gatekeeper warning

**Windows Authenticode:**
- Without signing: SmartScreen warning ("Windows protected your PC")
- EV cert removes SmartScreen warning immediately
- OV cert builds reputation over time

### Cross-Compilation

- macOS: build on macOS runner (cross-compile arm64 ↔ x64 with universal binary possible)
- Windows: build on Windows runner
- Linux: build on Ubuntu 22.04 runner (glibc compat)
- No true cross-compilation (macOS → Windows etc.) — each OS builds on its own runner

## Security

### Content Security Policy (CSP)

Currently `null` (disabled). Must be hardened:

```json
// tauri.conf.json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src ipc: http://ipc.localhost; font-src 'self' data:"
    }
  }
}
```

**Key restrictions:**
- `default-src 'self'` — only load resources from the app bundle
- `script-src 'self'` — no inline scripts, no eval, no remote scripts
- `connect-src ipc:` — only allow IPC connections (no external HTTP from WebView)
- No `unsafe-eval` — prevents code injection

### IPC Allowlist

Tauri 2 uses capability-based permissions. Only expose the commands the frontend needs:

```json
// src-tauri/capabilities/default.json
{
  "identifier": "default",
  "description": "Default capabilities for Scratchy",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "notification:default",
    "notification:allow-notify",
    "notification:allow-request-permission",
    "global-shortcut:allow-register",
    "autostart:allow-enable",
    "autostart:allow-disable",
    "updater:default",
    "deep-link:default",
    {
      "identifier": "core:event:default",
      "allow": [
        { "event": "gateway-message" },
        { "event": "gateway-status" }
      ]
    }
  ]
}
```

### Security Principles

| Principle | Implementation |
|-----------|---------------|
| No remote code execution | CSP blocks external scripts; no `eval()` |
| Sandboxed WebView | Tauri's default isolation; WebView cannot access filesystem |
| Minimal IPC surface | Only gateway commands + native feature commands exposed |
| Encrypted credentials | Gateway token stored encrypted in OS keychain (via `tauri-plugin-store` or OS keyring) |
| No Node.js runtime | Eliminates entire class of supply-chain attacks from npm |
| Signed binaries | All releases code-signed; update payloads signature-verified |
| Isolation pattern | Optional Tauri isolation pattern for IPC encryption between WebView and Rust |

### Credential Storage

Gateway tokens and sensitive config stored securely:
- **macOS:** Keychain (via `security` framework)
- **Windows:** Windows Credential Manager (via `wincred`)
- **Linux:** Secret Service API / libsecret (GNOME Keyring, KWallet)

Plugin: `tauri-plugin-store` with encryption, or direct OS keyring integration.

## Distribution

### Package Formats

| Platform | Format | Tool | Notes |
|----------|--------|------|-------|
| macOS | `.dmg` | Tauri bundler | Drag-to-Applications installer |
| macOS | `.app` (in .tar.gz) | Tauri bundler | For Homebrew cask |
| Windows | `.msi` | WiX (Tauri default) | Enterprise-friendly, clean uninstall |
| Windows | `.exe` (NSIS) | Tauri NSIS bundler | User-friendly installer wizard |
| Linux | `.AppImage` | Tauri bundler | Universal, no install needed |
| Linux | `.deb` | Tauri bundler | Debian/Ubuntu |
| Linux | `.rpm` | Tauri bundler | Fedora/RHEL (future) |

### Distribution Channels

1. **GitHub Releases** — primary, all platforms, auto-update source
2. **Homebrew Cask** — `brew install --cask scratchy` (macOS)
3. **Winget** — `winget install scratchy` (Windows, future)
4. **AUR** — Arch Linux (community-maintained, future)
5. **Direct download** — scratchy.dev website

### Auto-Update Server

For GitHub Releases, the update manifest is generated automatically by `tauri-action`:

```json
// latest.json (generated per-platform)
{
  "version": "0.2.0",
  "notes": "Bug fixes and performance improvements",
  "pub_date": "2026-02-22T08:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://github.com/.../Scratchy_0.2.0_aarch64.app.tar.gz"
    },
    "darwin-x86_64": { "..." : "..." },
    "windows-x86_64": { "..." : "..." },
    "linux-x86_64": { "..." : "..." }
  }
}
```

## Implementation Plan

### Sub-Phase A: Frontend Bridge (1-2 sessions)

**Goal:** Make the existing web frontend use the Rust gateway instead of serve.js WebSocket.

**New files:**
- `web/js/tauri-gateway.js` — IPC bridge (TauriGateway class)

**Changes:**
- `web/js/scratchy.js` (or equivalent): detect `window.__TAURI__`, swap gateway implementation
- `gateway.rs`: add `disconnect` command, connection status events
- `lib.rs`: register new commands

**Outcome:** Scratchy desktop app works end-to-end without serve.js.

### Sub-Phase B: Reconnection Logic (1 session)

**Goal:** Robust connection lifecycle in gateway.rs.

**Changes to `gateway.rs`:**
- `ConnectionStatus` enum with state machine
- Exponential backoff reconnect (1s base, 30s max, jitter)
- Emit `gateway-status` events on every state transition
- Heartbeat/ping to detect stale connections
- Graceful disconnect on app quit

**Changes to frontend:**
- Status indicator in UI (connected/reconnecting/offline)
- Queue messages during reconnect, flush on restore

### Sub-Phase C: System Tray (1 session)

**Goal:** Persistent tray presence with connection status and quick actions.

**New files:**
- `src/tray.rs` — tray setup, menu, icon management

**Dependencies to add:**
```toml
tauri-plugin-notification = "2"
```

**Deliverables:**
- Tray icon with connection status colors
- Context menu: Show/Hide, Preferences, Check for Updates, Quit
- Click tray icon → toggle window visibility
- Close window → minimize to tray (don't quit)
- Unread message badge on tray icon

### Sub-Phase D: Native Notifications (1 session)

**Goal:** OS-level notifications for messages and connection events.

**Dependencies:**
```toml
[dependencies]
tauri-plugin-notification = "2"
```

**Deliverables:**
- Notify on new agent messages when window is unfocused/hidden
- Notify on connection lost/restored
- Click notification → focus window, scroll to message
- Respect OS notification settings
- User preferences: enable/disable per category

### Sub-Phase E: Auto-Start, Global Shortcuts, Deep Links (1-2 sessions)

**Dependencies:**
```toml
[dependencies]
tauri-plugin-autostart = "2"
tauri-plugin-global-shortcut = "2"
tauri-plugin-deep-link = "2"
```

**Deliverables:**
- Auto-start on boot (opt-in, `--minimized` flag)
- Global shortcut to toggle window
- `scratchy://` protocol handler registered on install
- Deep link parsing and routing

### Sub-Phase F: Security Hardening (1 session)

**Goal:** Lock down the WebView and IPC surface.

**Changes:**
- `tauri.conf.json`: set proper CSP
- Create `src-tauri/capabilities/default.json` with minimal permissions
- Encrypted credential storage (OS keychain integration)
- Remove demo commands (`greet`, `calculate`, `reverse_text`)
- Audit all IPC commands for input validation

### Sub-Phase G: Offline & Caching (1-2 sessions)

**Dependencies:**
```toml
[dependencies]
tauri-plugin-sql = "2"  # or rusqlite directly
```

**New files:**
- `src/cache.rs` — SQLite message cache, canvas state persistence

**Deliverables:**
- Cache recent messages in SQLite
- Persist canvas state to disk
- Instant render on launch from cache
- Sync delta on reconnect
- Offline mode UI (read-only, cached content)

### Sub-Phase H: Auto-Update (1 session)

**Dependencies:**
```toml
[dependencies]
tauri-plugin-updater = "2"
```

**Deliverables:**
- Tauri updater plugin configured
- Update check on launch + periodic (every 6 hours)
- UI prompt for available updates
- Signature verification of update payloads
- Update channel selection in preferences (stable/beta)

### Sub-Phase I: Build Pipeline & Distribution (1-2 sessions)

**New files:**
- `.github/workflows/release.yml` — multi-platform CI/CD
- `.github/workflows/ci.yml` — PR checks (build + lint + test)

**Deliverables:**
- GitHub Actions workflow: build on tag push
- macOS: .dmg + notarization
- Windows: .msi + .exe (NSIS)
- Linux: .AppImage + .deb
- Auto-update manifest generation
- Draft release with all artifacts

### Sub-Phase J: Icons & Polish (1 session)

**Deliverables:**
- Full icon set (all sizes/formats for all platforms)
- App metadata (description, category, copyright)
- About dialog
- Preferences window (gateway URL, notifications, auto-start, shortcuts, update channel)
- First-run onboarding (enter gateway URL + token)

## Estimated Effort

| Sub-Phase | Sessions | Description |
|-----------|----------|-------------|
| A: Frontend Bridge | 1-2 | Wire frontend to Rust gateway via IPC |
| B: Reconnection Logic | 1 | Robust WS lifecycle, exponential backoff |
| C: System Tray | 1 | Tray icon, menu, window management |
| D: Native Notifications | 1 | OS notifications for messages + events |
| E: Auto-Start / Shortcuts / Deep Links | 1-2 | Three small plugins, preferences UI |
| F: Security Hardening | 1 | CSP, capabilities, credential encryption |
| G: Offline & Caching | 1-2 | SQLite cache, offline mode, sync |
| H: Auto-Update | 1 | Updater plugin, channels, UI prompt |
| I: Build Pipeline | 1-2 | CI/CD, signing, multi-platform artifacts |
| J: Icons & Polish | 1 | Icons, preferences, onboarding, about |
| **Total** | **10-14** | |

## Cargo.toml Target

```toml
[package]
name = "scratchy"
version = "0.2.0"
edition = "2021"
description = "Generative UI client for OpenClaw agents"

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-notification = "2"
tauri-plugin-autostart = "2"
tauri-plugin-global-shortcut = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-updater = "2"
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-store = "2"

serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = { version = "0.24", features = ["native-tls"] }
futures-util = "0.3"
log = "0.4"
env_logger = "0.11"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[lib]
name = "scratchy_lib"
crate-type = ["lib", "cdylib", "staticlib"]
```

## Open Questions

1. **Window close behavior** — Should closing the window quit the app or minimize to tray? (Recommendation: minimize to tray by default, with preference to change. Quit via tray menu or `Cmd+Q`.)

2. **Gateway discovery** — Should the desktop app auto-discover local OpenClaw gateways (mDNS/Bonjour), or always require manual URL entry? Auto-discovery would be a nice UX for local setups.

3. **Multiple gateway connections** — Support connecting to multiple gateways simultaneously? (Recommendation: single connection for v1, multi-gateway in a future phase.)

4. **Portable mode** — Should there be a "portable" build (config stored next to binary, no system install)? Useful for USB drives and restricted environments.

5. **Mac App Store** — Worth distributing via the Mac App Store? Adds discoverability but requires App Store review and sandbox restrictions that may conflict with gateway connectivity.

6. **Linux Wayland** — WebKitGTK on Wayland has quirks (tray icon support varies). Test on both X11 and Wayland. May need `WEBKIT_DISABLE_COMPOSITING_MODE=1` workaround.

7. **Telemetry / crash reporting** — Add opt-in crash reporting (e.g., Sentry)? Useful for debugging but needs careful privacy treatment.

8. **Plugin architecture** — Should the desktop app support user-installable plugins (custom widgets, themes)? Tauri's plugin system could enable this, but adds complexity and security surface.

9. **Token migration** — When transitioning from web to desktop, how to transfer the user's gateway token? QR code scan? Deep link from the web app? Manual copy-paste?

10. **Serve.js coexistence** — Keep serve.js working for users who prefer the browser? (Recommendation: yes, the web app remains fully functional. Desktop is an alternative, not a replacement.)
