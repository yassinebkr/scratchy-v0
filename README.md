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

## Recent Updates (March 2025)

### Admin Dashboard Improvements
- **Paginated chat history** — Efficient loading of large conversation histories
- **Cost tracking fixes** — Fixed admin dashboard cost total disappearing on live update
- **Session chain tracking** — Tracks all session IDs across gateway rotations for complete history
- **Usage aggregation** — New UsageAggregator with real-time watching and query API
- **Per-provider cost breakdown** — Detailed cost tracking by provider (Anthropic, Google, OpenAI)
- **BYOK (Bring Your Own Key) support** — Separate cost tracking for users with their own API keys

### Chat & UI Fixes
- **Instant load from cache** — Messages render from localStorage before WS connects (desktop only)
- **History retry logic** — Auto-retries history load if no messages appear within 5s
- **Canvas state restoration** — Server-side canvas state restored on reconnect
- **Session isolation** — Per-user session keys with proper isolation
- **Widget action routing** — Direct routing bypasses chat for form submissions

### Security & Auth
- **Trial period management** — Set/extend/remove trial periods for users
- **Capability controls** — Per-user tool and model permissions
- **Quota enforcement** — Message and token limits per hour/day
- **Password reset flow** — Secure invite email with temporary passwords

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
| `table` | Headers + rows with action buttons |
| `checklist` | Interactive task list |
| `timeline` | Chronological events |
| `form` | Input fields + actions |
| `buttons`, `chips`, `toggle` | Interactive controls |
| `kv` | Key-value pairs |
| `tags` | Colored labels |
| `alert` | Success/warning/error/info alerts |
| `accordion` | Collapsible sections |
| `tabs` | Tabbed content |
| `progress` | Progress bars |
| `sparkline` | Mini charts |
| `code` | Syntax-highlighted code blocks |
| `image`, `video` | Media display |
| ...and more | See `web/js/app.js` for full list |

## Admin Dashboard Features

The admin dashboard (accessible to admin users) provides:

- **User management** — Create, edit, disable users; manage roles
- **Usage monitoring** — Real-time token and cost tracking
- **Quota management** — Per-user message and token limits
- **Trial management** — Set custom trial periods (hours/days)
- **Capability controls** — Block/allow specific tools and models
- **Deploy manager** — Version-controlled deployments with rollback
- **Provider analytics** — Cost breakdown by AI provider
- **Session monitoring** — Active gateway sessions with model info

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
