# Scratchy v0 (Archive)

> ⚠️ **This is an archived codebase.** Active development continues at [yassinebkr/scratchy](https://github.com/yassinebkr/scratchy).

A Generative UI webchat client for OpenClaw AI agents.

> **Note:** This project runs on a [custom OpenClaw fork](https://github.com/yassinebkr/openclaw) with GenUI support. It is not compatible with upstream OpenClaw at this time.

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

## Security

Scratchy integrates with [ProteClaw](https://github.com/yassinebkr/proteclaw) — a defense-in-depth security plugin for OpenClaw agents. ProteClaw provides 9 layers of protection including session integrity, injection detection, canary tokens, and dynamic tool blocking.

The client-side and server-side code includes filters that strip ProteClaw security metadata from messages, keeping the UI clean while the plugin operates transparently in the background.

## Quick Start

```bash
# Clone
git clone https://github.com/yassinebkr/scratchy-v0.git
cd scratchy-v0

# Install
npm install --legacy-peer-deps

# Configure
cp .env.example .env
# Edit .env with your OpenClaw fork gateway URL and optional API keys

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

## Related Projects

- **[Scratchy](https://github.com/yassinebkr/scratchy)** — The current version, actively developed
- **[ProteClaw](https://github.com/yassinebkr/proteclaw)** — Defense-in-depth security for OpenClaw agents
- **[OpenClaw fork](https://github.com/yassinebkr/openclaw)** — The GenUI-enabled fork this project depends on

## License

MIT — see [LICENSE](LICENSE)

## Credits

Built by [@yassinebkr](https://github.com/yassinebkr).
