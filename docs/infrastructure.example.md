# Infrastructure Reference (Example)

> ⚠️ **This is an example file.** Paths, domains, and usernames have been genericized. Adapt to your own environment.

> **Last updated:** February 23, 2026
>
> Technical reference for the ClawOS / Scratchy infrastructure. This document covers the server, networking, services, directory layout, deployment workflow, and operational notes.

---

## Quick Reference Cheat Sheet

### Common Commands

```bash
# Restart services
systemctl --user restart scratchy            # Webchat + API (port 3001)
systemctl --user restart scratchy-canvas     # Canvas renderer (port 3002)
systemctl --user restart openclaw-gateway    # AI gateway (port 28945)
systemctl --user restart cloudflared-scratchy # Cloudflare tunnel

# Check service status
systemctl --user status scratchy
systemctl --user status cloudflared-scratchy

# View logs (follow)
journalctl --user -u scratchy -f
journalctl --user -u cloudflared-scratchy -f

# Syntax check before deploy
node -c serve.js

# Quick smoke test
curl -s localhost:3001 | head
curl -s localhost:3002 | head

# Firewall
sudo ufw status
```

### Port Map (At a Glance)

| Port  | Service           | External Access         |
|-------|-------------------|-------------------------|
| 22    | SSH               | Direct (UFW open)       |
| 3001  | Scratchy          | Via Cloudflare tunnel   |
| 3002  | Scratchy Canvas   | Via Cloudflare tunnel   |
| 5678  | n8n               | Local only              |
| 8899  | token-server      | Local only              |
| 28945 | OpenClaw gateway  | Local only              |

### Key URLs

| URL                        | Target              |
|----------------------------|---------------------|
| `scratchy.clawos.fr`      | Webchat (port 3001) |
| `scratchyui.clawos.fr`    | Canvas (port 3002)  |

### ⚠️ Critical Warnings

1. **Never `kill -HUP` cloudflared** — it terminates the process entirely. Always use `systemctl --user restart cloudflared-scratchy`.
2. **Space out tunnel restarts** — rapid restarts trigger Cloudflare rate limits.
3. **Port changes cascade** — changing a port requires updates in systemd unit files, Cloudflare tunnel config, and UI configuration simultaneously.
4. **WebSocket keepalive is mandatory** — Cloudflare edge terminates idle WS connections after ~2 minutes. Scratchy uses a 30-second JSON ping to stay alive.

---

## 1. Server

### Hardware & OS

| Property   | Value                                  |
|------------|----------------------------------------|
| Provider   | Contabo VPS                            |
| OS         | Debian 13 (trixie)                     |
| Kernel     | 6.12.63+deb13-cloud-amd64             |
| CPU        | 4 cores                                |
| RAM        | 8 GB                                   |
| Disk       | 74 GB                                  |
| Node.js    | v22.22.0                               |
| User       | `nonbios` (non-root, systemd user services) |

The server runs all services under the `nonbios` user account using **systemd user services** (`systemctl --user`). There is no containerization layer — all services run as native Node.js processes managed by systemd.

### Migration History

| Date            | Event                                                    |
|-----------------|----------------------------------------------------------|
| Feb 4, 2026     | Migrated from GCP VM to Contabo VPS                     |
| Feb 13, 2026    | UFW enabled; SSH-only direct exposure                    |
| Feb 2026        | Quick tunnels abandoned → switched to named Cloudflare tunnel |

The migration to Contabo was motivated by cost and reliability. The switch from Cloudflare quick tunnels to a named tunnel was driven by rate-limiting issues that caused intermittent downtime.

---

## 2. Domain & DNS

- **Domain**: `clawos.fr`
- **Registrar**: OVH
- **DNS Provider**: Cloudflare

The domain is registered at OVH, but the nameservers are pointed to Cloudflare. All DNS records are managed in the Cloudflare dashboard. This setup enables the use of Cloudflare Tunnel for zero-trust ingress without exposing any application ports to the public internet.

### Subdomains

| Subdomain                | Purpose                  | Backend Target     |
|--------------------------|--------------------------|--------------------|
| `scratchy.clawos.fr`    | Scratchy webchat + API   | `localhost:3001`   |
| `scratchyui.clawos.fr`  | Scratchy Canvas UI       | `localhost:3002`   |

Both subdomains are routed exclusively through the Cloudflare Tunnel. There are no direct DNS A/AAAA records pointing to the server's IP for these subdomains.

---

## 3. Cloudflare Tunnel

### Overview

The infrastructure uses a **named Cloudflare Tunnel** (not a quick tunnel) to expose web services. Named tunnels are persistent, configurable, and — critically — not subject to the aggressive rate limiting that affects quick tunnels.

### Configuration

- **Service**: `cloudflared-scratchy.service` (systemd user service)
- **Config file**: `~/.cloudflared/config.yml`
- **Tunnel type**: Named tunnel

### Routes

| Public Hostname          | Local Origin         |
|--------------------------|----------------------|
| `scratchy.clawos.fr`    | `localhost:3001`     |
| `scratchyui.clawos.fr`  | `localhost:3002`     |

### Operational Notes

#### Never Send SIGHUP to cloudflared

Unlike many daemons, `cloudflared` does **not** handle `SIGHUP` as a reload signal. Sending `kill -HUP` to the process will **terminate it**. Always manage the service through systemd:

```bash
systemctl --user restart cloudflared-scratchy
```

#### WebSocket Connection Lifetime

Cloudflare's edge network will terminate WebSocket connections that are idle for approximately **2 minutes**. This is a platform-level limitation that cannot be configured away. To work around this, Scratchy implements a **30-second JSON keepalive ping** at the application layer. Any changes to the WebSocket implementation must preserve this keepalive mechanism, or connections will silently drop.

#### Rate Limiting on Restarts

Cloudflare imposes rate limits on tunnel connection establishment. Restarting the `cloudflared-scratchy` service in rapid succession (e.g., multiple times within a few minutes) can trigger these limits, causing the tunnel to fail to reconnect. If you need to restart:

1. Wait at least 30–60 seconds between restarts.
2. Check logs after restart to confirm the tunnel is established: `journalctl --user -u cloudflared-scratchy -f`.
3. If rate-limited, wait 5–10 minutes before retrying.

---

## 4. Services

All application services run as **systemd user services** under the `nonbios` account. This means they survive SSH disconnects but require the user's lingering session (enabled via `loginctl enable-linger nonbios`).

### Core Services

#### Scratchy (`scratchy.service`)

| Property    | Value                                       |
|-------------|---------------------------------------------|
| Port        | 3001                                        |
| Description | Main webchat server + API                   |
| Entry point | `serve.js`                                  |
| Source       | `/home/youruser/scratchy/`                  |
| Restart     | `systemctl --user restart scratchy`         |

Scratchy is the primary web application — a real-time webchat interface with an API backend. It serves the frontend from `web/`, uses backend modules from `lib/`, and persists data (widget state, analytics) to `.scratchy-data/`.

#### Scratchy Canvas (`scratchy-canvas.service`)

| Property    | Value                                            |
|-------------|--------------------------------------------------|
| Port        | 3002                                             |
| Description | Canvas rendering service for rich UI components  |
| Restart     | `systemctl --user restart scratchy-canvas`       |

The Canvas service renders interactive UI components (widgets, visualizations) and is accessed via `scratchyui.clawos.fr`. Canvas state is persisted in `/home/youruser/scratchy/.canvas-state.json`.

#### OpenClaw Gateway (`openclaw-gateway.service`)

| Property    | Value                                              |
|-------------|----------------------------------------------------|
| Port        | 28945                                              |
| Description | AI gateway — OpenClaw fork                         |
| Config      | `/home/youruser/.openclaw/openclaw.json`            |
| Restart     | `systemctl --user restart openclaw-gateway`        |

The OpenClaw gateway is the AI orchestration layer. It manages agent sessions, skills, and model routing. It is accessed locally only — not exposed through the tunnel.

#### Cloudflare Tunnel (`cloudflared-scratchy.service`)

| Property    | Value                                                |
|-------------|------------------------------------------------------|
| Port        | N/A (outbound-only connections)                      |
| Description | Cloudflare Tunnel daemon                             |
| Config      | `~/.cloudflared/config.yml`                          |
| Restart     | `systemctl --user restart cloudflared-scratchy`      |

### Auxiliary Services

These services are present on the server but are not part of the core Scratchy/OpenClaw stack:

| Service       | Port | Description                              | Status  |
|---------------|------|------------------------------------------|---------|
| n8n           | 5678 | Workflow automation (YouTube pipeline)   | Paused  |
| token-server  | 8899 | OAuth token management                   | Running |

Both are accessible on `localhost` only — no tunnel routes or firewall rules expose them.

---

## 5. Firewall

The server uses **UFW (Uncomplicated Firewall)**, enabled on February 13, 2026.

### Rules

| Rule          | Direction | Port | Protocol | Action |
|---------------|-----------|------|----------|--------|
| SSH           | Inbound   | 22   | TCP      | Allow  |
| Everything else | Inbound | *    | *        | Deny   |

### Security Model

The firewall enforces a **zero direct exposure** policy for all application services. The only inbound port open is SSH (22/tcp). All web traffic reaches the application exclusively through the Cloudflare Tunnel, which establishes outbound connections from the server to Cloudflare's edge — no inbound ports required.

This means:
- Even if an application binds to `0.0.0.0`, it is not reachable from the internet.
- DDoS mitigation is handled by Cloudflare at the edge.
- The server's public IP can be hidden from end users (Cloudflare proxies all traffic).

### Checking Firewall Status

```bash
sudo ufw status verbose
```

---

## 6. Directory Structure

```
/home/youruser/
├── .openclaw/                        # OpenClaw gateway data
│   ├── openclaw.json                 # Gateway configuration
│   ├── workspace/                    # Main agent workspace
│   │   ├── SOUL.md                   # Agent identity
│   │   ├── MEMORY.md                 # Long-term agent memory
│   │   └── memory/                   # Daily memory files
│   ├── sessions/                     # Session JSONL files
│   ├── agents/                       # Sub-agent workspaces + sessions
│   └── workspace-{agentId}/          # Per-agent workspace directories
│
├── scratchy/                         # Scratchy source code
│   ├── serve.js                      # Main server entry point
│   ├── web/                          # Frontend (HTML, JS, CSS)
│   ├── lib/                          # Backend modules
│   │   ├── usage/                    # Usage tracking
│   │   └── analytics/                # Analytics engine
│   ├── .scratchy-data/               # Persistent runtime data
│   │   ├── widget-state/{userId}/    # Per-user widget state
│   │   └── analytics/                # Analytics data store
│   ├── .canvas-state.json            # Canvas persistence
│   └── docs/                         # Technical documentation (you are here)
│
├── openclaw/                         # OpenClaw fork source
│   ├── skills/                       # Agent skill definitions
│   └── docs/                         # OpenClaw documentation
│
├── bck/                              # Manual backups
│   └── (old workspace + .openclaw state)
│
└── n8n/                              # n8n workflow definitions
```

### Key Paths Reference

| Path                                                    | Purpose                        |
|---------------------------------------------------------|--------------------------------|
| `/home/youruser/.openclaw/openclaw.json`                | Gateway configuration          |
| `/home/youruser/.openclaw/workspace/`                   | Main agent workspace           |
| `/home/youruser/scratchy/`                              | Scratchy source root           |
| `/home/youruser/scratchy/serve.js`                      | Scratchy entry point           |
| `/home/youruser/scratchy/.scratchy-data/`               | Persistent runtime data        |
| `/home/youruser/scratchy/.scratchy-data/widget-state/`  | Per-user widget state          |
| `/home/youruser/scratchy/.scratchy-data/analytics/`     | Analytics data                 |
| `/home/youruser/scratchy/.canvas-state.json`            | Canvas UI state                |
| `~/.cloudflared/config.yml`                            | Cloudflare tunnel config       |
| `/home/youruser/bck/`                                   | Manual backups                 |

---

## 7. Deployment Workflow

Scratchy follows a simple, direct deployment model — no CI/CD pipeline, no staging environment. Changes are made on the server and deployed by restarting the service.

### Standard Deploy Process

```
1. Edit files         →  SSH or agent edits directly on server
2. Syntax check       →  node -c serve.js
3. Restart service    →  systemctl --user restart scratchy
4. Smoke test         →  curl localhost:3001  (or browser at scratchy.clawos.fr)
5. Commit & push      →  git add . && git commit -m "..." && git push
```

### Important: Port Change Cascade

If you change a service's listening port, you must update **all three** of the following in sync:

1. **Application code** — the port the Node.js process binds to.
2. **Systemd unit file** — if the port is referenced in the service definition or health checks.
3. **Cloudflare tunnel config** — `~/.cloudflared/config.yml` routes must point to the new port.

Failure to update all three will result in broken routing. After changing ports, restart both the application service and the tunnel service.

### Rollback

There is no automated rollback mechanism. To revert:

1. Use `git checkout` or `git revert` to restore the previous code.
2. Restart the affected service.
3. Manual backups in `/home/youruser/bck/` can be used for deeper recovery.

---

## 8. Git

### Repositories

| Repository    | Location                   | Branch (local) | Branch (remote) | Remote URL                              |
|---------------|----------------------------|----------------|------------------|-----------------------------------------|
| Scratchy      | `/home/youruser/scratchy/`  | `canvas`       | `canvas-ui`      | (HTTPS)                                 |
| OpenClaw fork | `/home/youruser/openclaw/`  | —              | —                | `github.com/yassinebkr/openclaw`        |

### Authentication

An SSH key exists on the server but has **not yet been added to GitHub**. Until it is, use HTTPS for push/pull operations. This may require a personal access token for authentication.

---

## 9. Backups

### Current State

Backups are **manual** and stored in `/home/youruser/bck/`. This directory contains snapshots of old workspace files and `.openclaw` state from before the migration and during major changes.

### What's Backed Up

- Old workspace files (pre-migration)
- `.openclaw` configuration and state snapshots

### What's NOT Backed Up

- `.scratchy-data/` (widget state, analytics) — no automated backup
- Live database or runtime state
- n8n workflows (stored in `/home/youruser/n8n/` but not backed up off-server)

### Recommendations

There is no automated backup system in place. Critical data (especially `.scratchy-data/` and `.openclaw/`) should be periodically archived. Consider:

- A cron job to tar and compress key directories nightly.
- Off-server backup (e.g., `rclone` to cloud storage).
- Git-based backup for configuration files.

---

## 10. Architecture Overview

```
                         Internet
                            │
                     ┌──────┴──────┐
                     │  Cloudflare  │
                     │    Edge      │
                     └──────┬──────┘
                            │ (outbound tunnel from server)
                     ┌──────┴──────┐
                     │ cloudflared  │
                     │  (tunnel)    │
                     └──┬───────┬──┘
                        │       │
          scratchy.clawos.fr  scratchyui.clawos.fr
                        │       │
                   ┌────┴──┐ ┌──┴─────┐
                   │:3001  │ │ :3002  │
                   │Scratchy│ │Canvas  │
                   └───┬───┘ └────────┘
                       │
                  ┌────┴─────┐
                  │  :28945  │
                  │ OpenClaw │
                  │ Gateway  │
                  └──────────┘
```

**Traffic flow:**
1. User connects to `scratchy.clawos.fr` via browser.
2. Cloudflare edge receives the request and routes it through the named tunnel.
3. `cloudflared` on the server forwards the request to `localhost:3001` (Scratchy) or `localhost:3002` (Canvas).
4. Scratchy communicates with the OpenClaw Gateway on `localhost:28945` for AI operations.
5. WebSocket connections are maintained with 30-second keepalive pings to survive Cloudflare's idle timeout.

**Security boundary:** The UFW firewall ensures only SSH (port 22) is directly reachable. All application traffic flows through Cloudflare, providing DDoS protection, TLS termination, and IP masking without any additional configuration on the server.

---

## 11. Troubleshooting

### Service Won't Start

```bash
# Check logs for the specific service
journalctl --user -u scratchy --since "5 min ago"

# Check if the port is already in use
ss -tlnp | grep 3001

# Syntax check the entry point
node -c /home/youruser/scratchy/serve.js
```

### Tunnel Not Connecting

```bash
# Check tunnel service logs
journalctl --user -u cloudflared-scratchy -f

# Verify config
cat ~/.cloudflared/config.yml

# If rate-limited, wait 5-10 minutes before restarting
# DO NOT rapidly restart the tunnel service
```

### WebSocket Connections Dropping

If users report disconnections every ~2 minutes:
- Verify the 30-second keepalive ping is active in the Scratchy WebSocket implementation.
- Check that no proxy or middleware is stripping WebSocket frames.
- Review Cloudflare tunnel logs for connection reset events.

### Cannot Push to GitHub

```bash
# SSH key not added — use HTTPS with token
git remote set-url origin https://github.com/yassinebkr/openclaw.git
git push origin canvas
```

---

*This document lives at `/home/youruser/scratchy/docs/infrastructure.md`. Keep it updated as the infrastructure evolves.*
