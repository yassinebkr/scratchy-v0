# Scratchy v0 (Archive)

> ⚠️ **This is the archived v1 codebase.** Active development has moved to [Scratchy v2](https://github.com/yassinebkr/scratchy-v2) (coming soon).

A Generative UI webchat client for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.

## What it does

Scratchy turns your OpenClaw agent into a visual, interactive workspace:

- **34 canvas components** — gauges, charts, timelines, forms, tables, and more
- **TOON format** — token-efficient notation that saves 30-40% on structured data
- **Widget engine** — Notes, Calendar, Email, YouTube, Spotify, Admin dashboard
- **Multi-user auth** — Argon2id passwords, WebAuthn/passkeys, per-user sessions
- **WebSocket proxy** — sequence-buffered relay to OpenClaw gateway
- **GenUI templates** — instant-render layouts (dashboard, form, timeline, etc.)
- **Canvas persistence** — server-side state survives restarts
- **Smart components** — components handle their own logic (streaming, polling, animation)

## Current Status

This codebase works with a [fork of OpenClaw](https://github.com/yassinebkr/openclaw) that includes GenUI support. Some features depend on fork-specific APIs (`api.on()` hooks) that are not yet in upstream OpenClaw.

**What works out of the box:** Canvas rendering, TOON decoder, component library, auth system, WebSocket proxy.

**What needs the fork:** Widget engine (server-side triggers), admin dashboard, some template features.

## Quick Start

```bash
# Clone
git clone https://github.com/yassinebkr/scratchy-v0.git
cd scratchy-v0

# Install
npm install --legacy-peer-deps

# Configure
cp .env.example .env
# Edit .env with your OpenClaw gateway URL and optional API keys

# Run
node serve.js
```

Open `http://localhost:3001` in your browser.

## Architecture

```
serve.js          → Main server (Express + WS proxy)
web/              → Frontend (vanilla HTML/CSS/JS)
  js/app.js       → Core app + canvas renderer
  js/toon-encoder.js → TOON format decoder
  css/            → Styles (Geist font, indigo accent)
lib/              → Server modules (auth, analytics, usage)
genui-engine/     → Widget templates + GenUI processing
canvas/           → Canvas component definitions
docs/             → Design docs and phase specs
```

## Canvas Components

| Component | Description |
|-----------|-------------|
| `hero` | Title + subtitle + badge header |
| `card` | Simple text card |
| `stats` | Grid of label/value pairs |
| `gauge` | Circular progress indicator |
| `chart-bar`, `chart-line`, `chart-pie` | Data visualizations |
| `table` | Headers + rows |
| `checklist` | Interactive task list |
| `timeline` | Chronological events |
| `form` | Input fields + actions |
| `buttons`, `chips`, `toggle` | Interactive controls |
| ...and 20+ more | See `web/js/app.js` for full list |

## TOON Format

Token-Oriented Object Notation — a compact alternative to JSON for canvas ops:

```
op: upsert
id: cpu-gauge
type: gauge
data:
  label: CPU
  value: 73
  max: 100
  unit: %
  color: orange
```

Saves ~30-40% tokens compared to equivalent JSON. See `web/js/toon-encoder.js`.

## License

MIT — see [LICENSE](LICENSE)

## Credits

Built by [@yassinebkr](https://github.com/yassinebkr) as part of the [ClawOS](https://clawos.fr) project.
