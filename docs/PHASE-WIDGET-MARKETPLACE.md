# Phase: Widget Marketplace

## Overview

The Widget Marketplace is the distribution layer for Scratchy's plugin/widget ecosystem. It provides a centralized catalog where users discover, install, and update community and first-party widgets — and where developers publish, monetize, and iterate on their creations.

**User value:**
- One-click install of new capabilities (charts, integrations, themes, AI tools)
- Curated discovery — browse categories, see ratings, read reviews
- Automatic updates with rollback safety
- Trust signals — verified publishers, permission declarations, security scans

**Developer value:**
- Reach every Scratchy instance with a single publish
- Built-in distribution, versioning, and update infrastructure
- Optional monetization — paid plugins, subscriptions, tips
- Analytics — install counts, active users, crash reports

**Monetization potential:**
- Revenue share on paid plugins (platform takes 15-20%)
- Featured placement (paid promotion by developers)
- "Pro" marketplace tier with advanced analytics, priority review, premium support
- Future: SaaS-hosted Scratchy instances with marketplace pre-integrated

### Prerequisites

| Phase | Why |
|-------|-----|
| Plugin System (`PHASE-PLUGIN-SYSTEM.md`) | Marketplace distributes plugins — need the runtime, manifest format, and lifecycle hooks first |
| Multi-User Auth (`PHASE19-MULTI-USER-AUTH.md`) | Publisher accounts, user-scoped installs, role-based publish permissions |

## Current State

```
No marketplace. No plugin system.
Widgets are hardcoded in Scratchy's component registry.
Adding a new widget = editing source code + redeploying.
```

## Target Architecture

```
                        ┌──────────────────────────────────────────┐
                        │         Scratchy Instance                │
                        │                                          │
   User browses ──────► │  Marketplace UI (widget/page)            │
   marketplace          │  ├── Browse / Search / Categories        │
                        │  ├── Plugin detail (readme, reviews)     │
                        │  ├── Install / Update / Remove buttons   │
                        │  └── My Plugins (installed list)         │
                        │                                          │
                        │  Plugin Manager                          │
                        │  ├── Dependency resolver                 │
                        │  ├── Version constraint checker          │
                        │  ├── Install / update / rollback engine  │
                        │  └── Permission sandbox enforcer         │
                        └───────────────┬──────────────────────────┘
                                        │ HTTPS
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │         Marketplace Registry API         │
                        │                                          │
                        │  /api/v1/plugins          (list/search)  │
                        │  /api/v1/plugins/:id      (detail)       │
                        │  /api/v1/plugins/:id/versions            │
                        │  /api/v1/plugins/:id/reviews             │
                        │  /api/v1/publish           (upload)      │
                        │  /api/v1/featured                        │
                        │  /api/v1/categories                      │
                        │                                          │
                        │  Storage: R2/S3 (tarballs + assets)      │
                        │  CDN: Cloudflare / CloudFront            │
                        │  DB: SQLite (Turso) or Postgres          │
                        └──────────────────────────────────────────┘
```

## Marketplace Architecture

### Centralized Registry (Primary)

A hosted registry API — think npm for Scratchy widgets. Every published plugin has a canonical entry with metadata, versions, download URLs, and trust signals.

**Why centralized:**
- Consistent security scanning and review pipeline
- Unified search, ratings, and discovery
- Monetization requires a central billing layer
- Trust chain — signed packages, verified publishers

**Registry record:**
```json
{
  "id": "widget-weather-forecast",
  "name": "Weather Forecast",
  "publisher": {
    "id": "pub_abc123",
    "name": "WeatherCo",
    "verified": true
  },
  "description": "Real-time weather with 7-day forecast, animated radar, and severe weather alerts.",
  "category": "utilities",
  "tags": ["weather", "forecast", "radar", "alerts"],
  "license": "MIT",
  "pricing": {
    "model": "free",
    "price": null
  },
  "stats": {
    "installs": 12840,
    "activeInstalls": 8320,
    "avgRating": 4.6,
    "reviewCount": 234
  },
  "latestVersion": "2.1.0",
  "scratchyVersionRange": ">=0.9.0",
  "permissions": ["network:api.openweathermap.org", "storage:local"],
  "createdAt": "2026-03-15T...",
  "updatedAt": "2026-06-01T..."
}
```

### Decentralized / Git-Based (Secondary, Future)

For self-hosters and enterprises who want to run private registries or install directly from git:

```
scratchy plugin install github:user/repo#v1.2.0
scratchy plugin install https://my-company.com/registry/internal-dashboard
```

- Git URL resolves to a tarball (GitHub/GitLab release asset or archive)
- Same manifest format as centralized registry
- No reviews/ratings, no security scanning — user assumes trust
- Useful for internal/proprietary plugins

### Plugin Manifest Format

Every plugin ships a `scratchy-plugin.json` at its root:

```json
{
  "id": "widget-weather-forecast",
  "version": "2.1.0",
  "name": "Weather Forecast",
  "description": "Real-time weather with animated radar.",
  "author": {
    "name": "WeatherCo",
    "email": "dev@weatherco.io",
    "url": "https://weatherco.io"
  },
  "license": "MIT",
  "main": "dist/index.js",
  "components": [
    {
      "type": "weather-forecast",
      "displayName": "Weather Forecast",
      "icon": "cloud-sun",
      "description": "Shows current weather and forecast"
    }
  ],
  "permissions": [
    "network:api.openweathermap.org",
    "storage:local:64kb"
  ],
  "dependencies": {
    "scratchy": ">=0.9.0",
    "widget-chart-base": "^1.0.0"
  },
  "config": {
    "apiKey": {
      "type": "string",
      "label": "OpenWeatherMap API Key",
      "required": true,
      "secret": true
    },
    "units": {
      "type": "select",
      "label": "Temperature Unit",
      "options": ["metric", "imperial"],
      "default": "metric"
    }
  },
  "screenshots": [
    "assets/screenshot-light.png",
    "assets/screenshot-dark.png"
  ],
  "repository": "https://github.com/weatherco/scratchy-weather",
  "keywords": ["weather", "forecast", "radar"]
}
```

## Discovery

### Browsable Catalog

The marketplace is browsable directly within Scratchy — no external website needed (though a web portal may exist for SEO and non-users).

**Categories:**
| Category | Examples |
|----------|---------|
| Data & Charts | Advanced charts, data tables, CSV importers |
| Productivity | Timers, kanban boards, note widgets, calendars |
| Integrations | GitHub, Jira, Slack, email, CRM connectors |
| AI & ML | Custom model connectors, prompt libraries, embeddings viewers |
| Media | Image galleries, video players, audio visualizers |
| Communication | Email composers, notification managers |
| Utilities | Weather, calculators, converters, clocks |
| Themes & Styles | Custom themes, icon packs, layout presets |
| Developer Tools | API testers, log viewers, debug panels |
| Fun & Social | Games, polls, quizzes, social feeds |

**Search:**
- Full-text search across name, description, tags, readme
- Filters: category, rating, price (free/paid), compatibility, recency
- Sort: relevance, popularity (installs), rating, newest, recently updated

**Discovery signals:**
- **Featured** — editorially curated (staff picks), rotated weekly
- **Trending** — most installs in last 7 days, weighted by recency
- **Top Rated** — highest avg rating with minimum review count (≥10)
- **New & Notable** — published in last 30 days, minimum quality bar
- **Collections** — themed bundles ("Best for Data Science", "Must-Have Utilities")
- **"Users also installed"** — collaborative filtering based on install patterns

### Ratings & Reviews

- 1-5 star rating + optional text review
- One review per user per plugin (editable)
- Reviews tied to a specific version
- Publisher can reply to reviews (one reply per review)
- Report abusive reviews → admin moderation queue
- Aggregate: weighted average (recent reviews weighted higher)

## Installation

### One-Click Install

From the marketplace UI inside Scratchy:

```
User clicks "Install" on Weather Forecast v2.1.0
  │
  ├─ 1. Fetch manifest from registry API
  ├─ 2. Check Scratchy version compatibility
  ├─ 3. Resolve dependencies (graph walk)
  │     └── widget-chart-base ^1.0.0 → resolved to 1.2.3
  ├─ 4. Check permissions — prompt user if sensitive
  │     └── "This plugin requests: network access to api.openweathermap.org"
  │     └── [Allow] [Deny] [Allow & Don't Ask Again]
  ├─ 5. Download tarball(s) from CDN
  ├─ 6. Verify signature (Ed25519)
  ├─ 7. Verify integrity (SHA-256 checksum)
  ├─ 8. Extract to .scratchy-data/plugins/widget-weather-forecast/
  ├─ 9. Run plugin's install hook (if defined)
  ├─ 10. Register components in Scratchy's runtime registry
  └─ 11. Show success + prompt for config (API key, etc.)
```

### Dependency Resolution

- Semver-based version constraints (npm-style: `^1.0.0`, `>=2.0.0 <3.0.0`)
- Flat dependency tree — no nested node_modules-style hell
- Conflict detection: if two plugins require incompatible versions of the same dep, block install with clear error
- `scratchy` version constraint is mandatory — prevents installing on incompatible hosts

### Storage Layout

```
.scratchy-data/
  plugins/
    registry.json                          ← installed plugins index
    widget-weather-forecast/
      scratchy-plugin.json                 ← manifest
      dist/                                ← built assets
      assets/                              ← screenshots, icons
      .metadata.json                       ← install timestamp, source, signature
    widget-chart-base/
      ...
  plugin-config/
    widget-weather-forecast.json           ← user config (API keys, preferences)
  plugin-data/
    widget-weather-forecast/               ← plugin's sandboxed data directory
```

## Updates

### Auto-Update Checking

- On Scratchy startup: check registry for updates (background, non-blocking)
- Periodic check every 6 hours (configurable)
- Badge/indicator on marketplace icon when updates available
- User controls: auto-update (install immediately), notify-only, or manual

### Update Flow

```
Update available: Weather Forecast 2.1.0 → 2.2.0
  │
  ├─ 1. Show changelog (rendered from CHANGELOG.md in package)
  ├─ 2. Show new/changed permissions (if any — requires re-consent)
  ├─ 3. User clicks "Update" (or auto-update triggers)
  ├─ 4. Backup current version to .scratchy-data/plugins/.backup/
  ├─ 5. Download + verify new version
  ├─ 6. Run plugin's migrate hook (schema changes, data migration)
  ├─ 7. Hot-swap: unload old → load new (if supported), else mark for reload
  └─ 8. On failure at any step → automatic rollback from backup
```

### Rollback

- Last N versions kept in backup (default: 2)
- Manual rollback from "My Plugins" UI
- Automatic rollback if:
  - Plugin crashes on load (3 consecutive failures)
  - Install/migrate hook throws
  - Integrity check fails post-install

### Changelog Display

- Parsed from `CHANGELOG.md` in plugin package (Keep a Changelog format)
- Rendered as a timeline widget in the update dialog
- Highlights: breaking changes (red), new features (green), fixes (blue)

## Publishing

### Developer Registration

1. Create publisher account (linked to Scratchy user account via OAuth or separate)
2. Verify email
3. Agree to Developer Terms of Service
4. Generate API key for CLI publishing

### Publish Flow

```bash
# CLI-based publishing
scratchy-publish login
scratchy-publish validate          # lint manifest, check structure
scratchy-publish build             # optional: bundle/compile
scratchy-publish pack              # create tarball
scratchy-publish submit            # upload to registry
```

```
Developer submits plugin
  │
  ├─ 1. Automated checks (< 30 seconds)
  │     ├── Manifest validation (required fields, semver, valid permissions)
  │     ├── Bundle size check (< 5MB default, configurable)
  │     ├── Static analysis (no eval(), no dynamic script injection)
  │     ├── Dependency audit (known vulnerabilities via advisory DB)
  │     ├── License compatibility check
  │     └── Screenshot/icon validation (required, minimum dimensions)
  │
  ├─ 2. Automated sandbox test
  │     ├── Install in clean Scratchy instance (ephemeral container)
  │     ├── Load plugin — no crashes, no console errors
  │     ├── Render each declared component — no exceptions
  │     └── Permission boundary test — verify no undeclared network/storage access
  │
  ├─ 3. Review queue (first publish or flagged)
  │     ├── First-time publishers: manual review required
  │     ├── Established publishers (≥3 approved plugins, good standing): auto-approve
  │     ├── Flagged by automated checks: manual review
  │     └── Manual reviewer checks: functionality, UX quality, ToS compliance
  │
  ├─ 4. Signing
  │     ├── Registry signs the tarball with its Ed25519 key
  │     ├── Signature stored alongside the package
  │     └── Clients verify signature before installation
  │
  └─ 5. Published
        ├── Available in registry search
        ├── CDN distribution within minutes
        └── Publisher notified via email + dashboard
```

### Versioning Rules

- Semver required (`MAJOR.MINOR.PATCH`)
- Cannot overwrite published versions (immutable once published)
- Can yank/deprecate a version (remains downloadable for existing users, hidden from new installs)
- Pre-release versions (`2.2.0-beta.1`) — opt-in visibility for users

## Monetization

### Pricing Models

| Model | Description |
|-------|------------|
| **Free** | No charge. Most plugins. Community-driven. |
| **Paid (one-time)** | Single purchase, all future updates for that major version |
| **Paid (subscription)** | Monthly/yearly, access revoked on cancellation (plugin disabled, data retained) |
| **Freemium** | Core features free, premium features behind in-plugin purchase |
| **Pay-what-you-want** | Suggested price with minimum (including $0) |
| **Sponsor/Tip** | Plugin is free, users can tip the developer |

### Revenue Split

| Tier | Platform Cut | Developer Cut |
|------|-------------|---------------|
| Standard | 20% | 80% |
| High Volume (>$10k/mo) | 15% | 85% |
| First Year Promotion | 10% | 90% |

### Payment Infrastructure

- Stripe Connect for developer payouts
- Stripe Checkout for user purchases
- Billing tied to Scratchy user account (from Phase 19)
- License keys — server-verified, tied to user account, transferable on request
- Refund policy: 7-day no-questions-asked for paid plugins

### Free Tier (Platform)

The marketplace itself is free to use. All core marketplace features (browse, install free plugins, publish) have no platform charge. Revenue comes only from paid plugin transactions and optional promoted listings.

## Security

### Code Review Pipeline

```
Submission → Static Analysis → Sandbox Test → Manual Review → Signing → Publication
     │              │                │               │
     │         No eval()        No crashes       Human check
     │         No innerHTML     No undeclared     Quality bar
     │         No fetch()       network calls     ToS compliance
     │         outside perms
     │
     └── Reject with actionable feedback at any stage
```

### Permission System

Plugins declare permissions in their manifest. Users consent at install time.

| Permission | Description | Risk Level |
|-----------|------------|-----------|
| `storage:local:<size>` | Local sandboxed storage | Low |
| `network:<domain>` | Fetch from specific domain | Medium |
| `network:*` | Fetch from any domain | High — requires manual review |
| `canvas:read` | Read other widgets' data on canvas | Medium |
| `canvas:write` | Modify other widgets | High |
| `agent:chat` | Send messages to the agent | Medium |
| `agent:tools` | Invoke agent tools | High — requires manual review |
| `clipboard:read` | Read clipboard | High |
| `clipboard:write` | Write to clipboard | Medium |
| `notification` | Show system notifications | Low |
| `theme` | Modify Scratchy's appearance | Low |

### Sandboxing

- Plugins run in isolated `<iframe>` sandboxes (same-origin policy enforced)
- Communication with host via structured `postMessage` API only
- No direct DOM access to Scratchy's main frame
- Resource limits: CPU (web worker timeout), memory (iframe memory cap), storage (quota per plugin)
- Network requests proxied through Scratchy's fetch interceptor — only declared domains allowed

### Malware Scanning

- Automated static analysis on every submission (AST-based, not regex)
- Known malware signature database (updated from community reports)
- Behavioral analysis in sandbox: monitor network calls, DOM mutations, storage writes
- Community reporting: "Report this plugin" → triggers re-review
- Emergency takedown: admin can instantly unpublish + force-uninstall from all instances (via update check)

### Supply Chain Protections

- Publisher account 2FA required for publishing
- Package signing with Ed25519 (registry key) — clients reject unsigned packages
- Tarball integrity: SHA-256 hash verified on download
- Dependency pinning: lock file records exact versions + hashes of dependencies
- Transparency log: all publishes logged to append-only audit log (can detect key compromise)

## UI — Marketplace in Scratchy

The marketplace is experienced **inside Scratchy itself** — it is a first-party "meta-widget" that uses the same component system as everything else.

### Entry Point

- **Sidebar icon** — marketplace icon (🏪 or grid icon) in Scratchy's left sidebar
- **Agent command** — "show me the marketplace", "find a weather widget"
- **Canvas action** — "Add Widget" button on canvas opens marketplace picker

### Marketplace Views

**Browse / Home:**
```
┌─────────────────────────────────────────────────┐
│  🏪 Widget Marketplace                    🔍    │
│                                                  │
│  ⭐ Featured                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Weather  │ │ Kanban   │ │ GitHub   │        │
│  │ Forecast │ │ Board    │ │ Issues   │        │
│  │ ★★★★★    │ │ ★★★★☆    │ │ ★★★★★    │        │
│  │ Free     │ │ $4.99    │ │ Free     │        │
│  └──────────┘ └──────────┘ └──────────┘        │
│                                                  │
│  📂 Categories                                   │
│  Data & Charts · Productivity · Integrations     │
│  AI & ML · Media · Utilities · Themes · Dev      │
│                                                  │
│  🔥 Trending This Week                           │
│  1. SQL Query Runner          ↑ 2,340 installs  │
│  2. Markdown Editor Pro       ↑ 1,890 installs  │
│  3. Spotify Now Playing       ↑ 1,230 installs  │
│                                                  │
│  🆕 New & Notable                                │
│  ...                                             │
└─────────────────────────────────────────────────┘
```

**Plugin Detail Page:**
```
┌─────────────────────────────────────────────────┐
│  ← Back                                         │
│                                                  │
│  ☁️ Weather Forecast                    [Install]│
│  by WeatherCo (✓ Verified)              v2.1.0  │
│                                                  │
│  ★★★★★ 4.6 (234 reviews) · 12.8k installs      │
│                                                  │
│  ┌─────────────────────────────────────┐        │
│  │    [Screenshot carousel]            │        │
│  └─────────────────────────────────────┘        │
│                                                  │
│  📖 Description                                  │
│  Real-time weather with 7-day forecast,         │
│  animated radar, and severe weather alerts...   │
│                                                  │
│  🔒 Permissions                                  │
│  · Network: api.openweathermap.org              │
│  · Local storage: 64KB                          │
│                                                  │
│  📋 Changelog · ⭐ Reviews · 📦 Versions         │
│                                                  │
│  Reviews:                                        │
│  ★★★★★ "Best weather widget, period" — user42  │
│  ★★★★☆ "Great, but wish it had hourly" — jm    │
└─────────────────────────────────────────────────┘
```

**My Plugins (Installed):**
```
┌─────────────────────────────────────────────────┐
│  📦 My Plugins                                   │
│                                                  │
│  Weather Forecast    v2.1.0  ✅ Active  [···]   │
│  Chart Base          v1.2.3  ✅ Active  [···]   │
│  Kanban Board        v1.0.0  ⬆️ Update  [···]   │
│  Old Widget          v0.3.1  ⚠️ Deprecated       │
│                                                  │
│  [···] → Configure · Disable · Uninstall        │
│         · Rollback · View in Marketplace        │
└─────────────────────────────────────────────────┘
```

### GenUI Integration

Since Scratchy is a GenUI client, the agent can interact with the marketplace:
- User: "Find me a good chart widget" → Agent searches marketplace, shows results as cards
- User: "Install the weather forecast plugin" → Agent triggers install flow
- Marketplace results rendered as standard Scratchy components (cards, tables, buttons)
- The marketplace UI itself is essentially a plugin — dogfooding the plugin system

## Backend — Registry API

### API Endpoints

| Method | Endpoint | Description |
|--------|---------|------------|
| `GET` | `/api/v1/plugins` | List/search plugins (query, category, sort, page) |
| `GET` | `/api/v1/plugins/:id` | Plugin detail (metadata, stats, latest version) |
| `GET` | `/api/v1/plugins/:id/versions` | All versions with changelogs |
| `GET` | `/api/v1/plugins/:id/versions/:ver` | Specific version metadata |
| `GET` | `/api/v1/plugins/:id/reviews` | Reviews (paginated, sortable) |
| `POST` | `/api/v1/plugins/:id/reviews` | Submit review (authenticated) |
| `GET` | `/api/v1/featured` | Featured/curated collections |
| `GET` | `/api/v1/categories` | Category list with counts |
| `GET` | `/api/v1/trending` | Trending plugins (time-windowed) |
| `POST` | `/api/v1/publish` | Publish new version (authenticated, multipart) |
| `GET` | `/api/v1/download/:id/:ver` | Download tarball (redirects to CDN) |
| `GET` | `/api/v1/updates` | Batch check for updates (POST array of installed plugins+versions) |
| `POST` | `/api/v1/report` | Report plugin for abuse/malware |

### Storage

- **Package tarballs:** Cloudflare R2 (S3-compatible, zero egress fees)
- **CDN:** Cloudflare CDN in front of R2 — global distribution, edge caching
- **Screenshots/assets:** Same R2 bucket, separate prefix
- **Database:** SQLite via Turso (edge-replicated) for metadata, or Postgres for higher scale
- **Search index:** Meilisearch or built-in SQLite FTS5 (start simple)

### Analytics

Collected (privacy-respecting, aggregate-only):
- Install/uninstall counts per version
- Active install count (heartbeat during update checks — no PII)
- Crash reports (opt-in, anonymized stack traces)
- Search queries (for improving discovery, no user attribution)

Exposed to developers:
- Install graph (daily/weekly/monthly)
- Version distribution (what versions are users on?)
- Rating trend over time
- Geographic distribution (country-level, from CDN logs)

### Infrastructure

```
                   ┌────────────┐
                   │ Cloudflare │
                   │ CDN / WAF  │
                   └──────┬─────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        ┌─────┴────┐ ┌───┴───┐ ┌────┴─────┐
        │ Registry  │ │  R2   │ │  Turso   │
        │ API       │ │ Store │ │  DB      │
        │ (Workers) │ │       │ │ (SQLite) │
        └──────────┘ └───────┘ └──────────┘
              │
        ┌─────┴──────┐
        │ Review      │
        │ Pipeline    │
        │ (Queue +    │
        │  Sandbox)   │
        └────────────┘
```

**Preference:** Cloudflare Workers + R2 + Turso — serverless, edge-distributed, minimal ops burden. Scales from zero to global without infrastructure management.

## Implementation Plan

All phases depend on the Plugin System being implemented first.

### Phase M1: Local Plugin Manager (2-3 sessions)

_Prerequisite: Plugin System complete_

- Plugin registry file (`registry.json`) — tracks installed plugins
- Install/uninstall engine — download tarball, extract, register
- Signature verification (Ed25519)
- Integrity checking (SHA-256)
- Basic dependency resolution (semver)
- CLI: `scratchy plugin install <tarball-path>`

### Phase M2: Registry API — MVP (3-4 sessions)

- Deploy registry API (Cloudflare Workers or simple Node server)
- R2 bucket for package storage
- Core endpoints: list, detail, download, publish
- Publisher authentication (API key)
- Automated validation on publish (manifest lint, size check)
- Database schema (Turso/SQLite)

### Phase M3: Marketplace UI in Scratchy (2-3 sessions)

- Marketplace sidebar panel / page
- Browse view with categories
- Search (basic — name + description matching)
- Plugin detail page (description, screenshots, permissions)
- Install button → triggers Plugin Manager
- "My Plugins" installed list with uninstall/disable

### Phase M4: Updates & Rollback (1-2 sessions)

- Update check on startup + periodic
- Changelog display (parsed from CHANGELOG.md)
- Backup before update, automatic rollback on failure
- Update notification badge
- Auto-update option (user configurable)

### Phase M5: Reviews & Ratings (1-2 sessions)

- Review submission (star rating + text)
- Review display on plugin detail page
- Publisher reply to reviews
- Aggregate rating calculation (weighted)
- Report review for abuse

### Phase M6: Publishing Pipeline (2-3 sessions)

- `scratchy-publish` CLI tool
- Automated checks: static analysis, license, dependencies
- Sandbox test: ephemeral container, load test
- Review queue for first-time publishers
- Package signing (registry Ed25519 key)
- Publisher dashboard (stats, reviews, versions)

### Phase M7: Discovery & Curation (1-2 sessions)

- Featured/editorial collections
- Trending algorithm (time-decayed install velocity)
- "Users also installed" collaborative filtering
- Full-text search with Meilisearch or FTS5
- Category management

### Phase M8: Monetization (2-3 sessions)

_Prerequisite: Multi-User Auth complete for billing identity_

- Stripe Connect integration (developer onboarding)
- Stripe Checkout for paid plugins
- License key generation + verification
- Revenue split accounting
- Refund flow
- Publisher payout dashboard

### Phase M9: Security Hardening (1-2 sessions)

- AST-based static analysis (detect unsafe patterns)
- Malware signature database
- Behavioral sandbox monitoring
- Emergency takedown + force-uninstall mechanism
- Transparency / audit log
- Abuse reporting pipeline

### Phase M10: Agent Integration (1 session)

- Agent can search marketplace via natural language
- Agent can trigger install/update flows
- Marketplace results rendered as GenUI components
- "Find me a widget for X" → smart recommendations

### Estimated Total

| Phase | Sessions | Description |
|-------|----------|-------------|
| M1: Local Plugin Manager | 2-3 | Install engine, deps, signatures |
| M2: Registry API | 3-4 | Backend, storage, publish |
| M3: Marketplace UI | 2-3 | Browse, search, install UI |
| M4: Updates & Rollback | 1-2 | Auto-update, changelog, rollback |
| M5: Reviews & Ratings | 1-2 | User reviews, ratings |
| M6: Publishing Pipeline | 2-3 | CLI, automated checks, signing |
| M7: Discovery & Curation | 1-2 | Featured, trending, search |
| M8: Monetization | 2-3 | Stripe, licensing, payouts |
| M9: Security Hardening | 1-2 | Static analysis, malware, takedowns |
| M10: Agent Integration | 1 | Natural language marketplace access |
| **Total** | **16-25** | |

## Decisions

1. **Centralized first** — Start with a hosted registry. Decentralized (git-based) install is a nice-to-have for power users, not MVP.
2. **R2 + Workers** — Cloudflare stack preferred for zero-egress storage and edge compute. Can migrate later if needed.
3. **SQLite (Turso)** — Start simple. Postgres only if we need complex queries or scale beyond Turso's limits.
4. **Ed25519 signing** — Fast, small signatures, well-supported. Registry holds the signing key; publisher identity tied to their account, not a separate key.
5. **iframe sandboxing** — Plugins run in iframes with postMessage API. Heavier than no sandbox, but essential for security. Web workers for CPU-bound plugins.
6. **Marketplace as a widget** — The marketplace UI is built using Scratchy's own component system. Dogfooding at its finest.
7. **Free to publish** — No fee to publish free plugins. Platform revenue comes from paid plugin transactions only.
8. **Manual review for first publish only** — Established publishers get auto-approve. Balances security with developer velocity.
9. **20/80 revenue split** — Competitive with App Store (30%) and better than most. Drop to 15% for high-volume publishers.

## Open Questions

1. **Private/enterprise registries** — Should we support self-hosted registry instances for companies? (Probably yes, but scope and timeline TBD.)
2. **Plugin bundles/suites** — Can a developer publish a bundle of related plugins at a discounted price? How does dependency management work for bundles?
3. **Versioned API contracts** — When Scratchy's plugin API changes (breaking), how do we handle the long tail of plugins on old API versions? Compatibility shims? Forced migration?
4. **Plugin analytics privacy** — How much telemetry is acceptable? GDPR implications for install tracking? Need clear privacy policy.
5. **Dispute resolution** — User buys a paid plugin that doesn't work as advertised. Beyond refund, what's the process? Mediation? Plugin delisting?
6. **Plugin forks** — Someone forks an open-source plugin and publishes a modified version. Name squatting, attribution, licensing conflicts — how to handle?
7. **Offline mode** — Should the marketplace work offline? (Browsing cached catalog, installing from local tarballs, etc.)
8. **Multi-instance sync** — If a user has multiple Scratchy instances, should installed plugins sync across them? Via marketplace account?
9. **Plugin permissions escalation** — A plugin update requests new permissions. If user has auto-update on, should it pause and prompt? (Probably yes.)
10. **Review authenticity** — How to prevent fake reviews (especially for paid plugins)? Require verified install? Minimum usage time before review?
11. **Widget theming contract** — Should marketplace plugins be required to support Scratchy's theming system (light/dark mode, custom colors)?
12. **AI-generated plugins** — Users may ask the agent to *build* them a widget on-the-fly. How does this interact with the marketplace? Can AI-generated widgets be published?

## ⚠️ Critical for Launch

**Trust is everything** — A marketplace is only as good as the trust users place in it. Before public launch:

- **Security scanning must be robust** — One malicious plugin reaching users destroys trust permanently
- **Review quality matters** — Bad plugins in "Featured" kills credibility. Curate aggressively at launch.
- **Publisher identity verification** — At minimum: verified email + 2FA. For paid plugins: identity/business verification.
- **Incident response plan** — When (not if) a malicious plugin is discovered: how fast can we take it down, notify affected users, and force-uninstall?
- **Legal framework** — Developer ToS, user purchase ToS, DMCA/copyright process, privacy policy for analytics
- **Seed the marketplace** — Launch with 20-30 high-quality first-party and partner plugins. An empty marketplace is a dead marketplace.
