# OpenClaw Fork — Technical Reference

> **Fork**: [github.com/yassinebkr/openclaw](https://github.com/yassinebkr/openclaw)
> **Version**: v2026.2.4
> **Last updated**: 2026-02-23

---

## Quick Reference

| Item | Value |
|---|---|
| **Version** | v2026.2.4 |
| **Port** | 28945 |
| **WebSocket** | `ws://localhost:28945` |
| **Install directory** | `/home/youruser/.openclaw/` |
| **Config file** | `/home/youruser/.openclaw/openclaw.json` |
| **Sessions directory** | `/home/youruser/.openclaw/sessions/` |
| **Agent workspaces** | `/home/youruser/.openclaw/agents/` |
| **Systemd service** | `openclaw-gateway.service` (user service) |
| **Default model** | `claude-opus-4-6` (Anthropic) |
| **Main session ID** | `agent:main:main` |
| **Plugin API** | `api.on()` (NOT `api.registerHook()`) |
| **npm install flag** | `--legacy-peer-deps` (required) |
| **Hot-reload signal** | `SIGUSR1` (partial — does not re-wrap tool hooks) |
| **Config updates** | `config.patch` (partial merge) / `config.apply` (full replace) |

### Critical Rules

1. **Never stop the gateway** — only restart, and only at the end of a work phase.
2. **Always use `--legacy-peer-deps`** when running `npm install` in the fork.
3. **Use `api.on()` for hooks** — `api.registerHook()` does not exist in our fork.
4. **SIGUSR1 does NOT re-wrap tool hooks** — plugin changes require a full restart.
5. **Gateway token = Scratchy admin password** — treat it as a secret.
6. **Direct writes to critical files are blocked** — `SOUL.md`, `AGENTS.md`, and `openclaw.json` — use `config.patch` via the gateway instead.

---

## 1. What Is OpenClaw?

OpenClaw is an AI agent gateway platform. It sits between AI model providers (Anthropic, Google, OpenAI) and communication channels (webchat, WhatsApp, Discord, Signal, Telegram), acting as the central hub for routing messages, dispatching tools, managing sessions, and streaming events.

We run a fork at `github.com/yassinebkr/openclaw` with custom modifications for our infrastructure, including multi-agent orchestration and a plugin-based security system.

### Core Capabilities

- **Model connections** — Manages API keys and routing for Anthropic (Claude), Google (Gemini), and OpenAI (GPT) model families.
- **Channel routing** — Bridges messages between the AI and multiple front-ends: webchat, WhatsApp, Discord, Signal, and Telegram.
- **Session management** — Tracks conversation state across main sessions, sub-agent sessions, and isolated sessions using JSONL files.
- **Tool dispatch** — Provides the AI with a structured tool system: `exec`, `read`, `write`, `edit`, `web_search`, `web_fetch`, `browser`, and more.
- **AG-UI event streaming** — Agent-User Interface protocol for real-time event delivery to connected clients.
- **Cron scheduler** — Background task scheduling with isolated session support.
- **Plugin system** — Extensible hook-based architecture for intercepting and modifying agent behavior.

---

## 2. Directory Structure

```
/home/youruser/.openclaw/
├── openclaw.json                          # Gateway configuration
├── sessions/                              # Session JSONL files
│   ├── agent_main_main.jsonl              # Main session
│   └── agent_{id}_subagent_{uuid}.jsonl   # Sub-agent sessions
├── agents/                                # Sub-agent workspaces
├── workspace-{agentId}/                   # Per-agent working directories
│   ├── SOUL.md
│   ├── AGENTS.md
│   ├── TOOLS.md
│   ├── MEMORY.md
│   └── memory/
├── sessions.json                          # Session metadata index
└── server files (server-chat.ts, etc.)    # Gateway source
```

---

## 3. Gateway Configuration

The gateway is configured via `/home/youruser/.openclaw/openclaw.json`. Key sections:

### `model`

The default model for all sessions. Currently set to `claude-opus-4-6`.

### `providers`

API key configuration for each provider:

- **Anthropic** — Claude model family (Opus, Sonnet, Haiku)
- **Google** — Gemini model family (3 Pro, 3.1 Pro)
- **OpenAI** — GPT model family (GPT-4o)

### `channels`

Channel-specific configuration. The primary channel is `webchat`. Each channel defines its connection parameters and routing rules.

### `tools`

Tool permissions and settings, including `agentToAgent` configuration for cross-agent communication.

### `sessions`

Session management configuration — defaults, limits, and behavior.

### `plugins`

Array of plugin paths loaded at gateway startup.

### Updating Configuration

- **`config.patch`** — Safe partial update. Merges your changes with the existing config. Use this for routine changes.
- **`config.apply`** — Full replacement. Overwrites the entire config. Use with caution.
- **Direct file edits** — Blocked by the security layer. Always use `config.patch` through the gateway.

---

## 4. Session System

Sessions are the core state mechanism. Each session is a JSONL file in the `sessions/` directory, with metadata tracked in `sessions.json`.

### Session Types

#### Main Session — `agent:main:main`

The primary chat session. All webchat users share this single session. There are no per-user webchat sessions — user isolation is handled by Scratchy at its own layer, not by the gateway.

#### Sub-Agent Sessions — `agent:{agentId}:subagent:{uuid}`

Spawned for background tasks via the `sessions_spawn` tool. Each sub-agent session runs independently with its own workspace and context. Results are delivered back to the parent session.

#### Isolated Sessions

Used by cron jobs configured with `sessionTarget: "isolated"`. These sessions have no shared history with other sessions, making them suitable for standalone scheduled tasks.

### Session File Format

Sessions are stored as JSONL (JSON Lines) files — one JSON object per line, representing each message or event in the conversation. The `sessions.json` index file tracks metadata: `sessionId`, `model`, `contextTokens`, etc.

### Session Corruption

If a session file becomes corrupted:

1. Delete the corrupted `.jsonl` file from `sessions/`.
2. The security plugin will auto-repair orphaned `tool_result` entries.
3. The session will restart fresh on next use.

---

## 5. WebSocket / ConnectParams

Clients connect to the gateway via WebSocket at `ws://localhost:28945`. The connection handshake uses ConnectParams with strict schema requirements.

### Schema Rules

- **`additionalProperties: false`** — Enforced everywhere in the schema. Do not add unexpected fields.
- **`client.id`** — Must be from a fixed enum: `webchat`, `cli`, etc. Never use custom values.
- **`caps`** — Place `["tool-events"]` at the **root level** of ConnectParams, NOT inside the `client` object. This is required to receive tool event streams.
- **`verboseDefault`** — Set to `"on"` for tool events to flow through the connection.

### Example ConnectParams Structure

```json
{
  "client": {
    "id": "webchat"
  },
  "caps": ["tool-events"],
  "verboseDefault": "on"
}
```

### Common Mistakes

| Mistake | Fix |
|---|---|
| Putting `caps` inside `client` | Move `caps` to root level |
| Using a custom `client.id` | Use only enum values: `webchat`, `cli`, etc. |
| Omitting `verboseDefault` | Set to `"on"` if you need tool events |
| Adding extra fields | Schema uses `additionalProperties: false` — strip unknown fields |

---

## 6. Sub-Agent System

The sub-agent system enables multi-model orchestration. A parent agent can spawn child agents that run independently and report back.

### Spawning

Use the `sessions_spawn` tool to create a sub-agent. Each agent receives:

- Its own session: `agent:{agentId}:subagent:{uuid}`
- Its own workspace: `/home/youruser/.openclaw/workspace-{agentId}/`
- Access to all tools permitted by the parent

### Agent IDs

Agent IDs follow the pattern `{provider}-{model}`:

- `anthropic-claude-opus-4-6`
- `google-gemini-cli-gemini-3-pro-preview`
- `google-gemini-cli-gemini-3-1-pro-preview`

### Cross-Agent Communication

For sub-agents to access history from other agents, `agentToAgent.enabled` must be `true` in the gateway config. When a sub-agent completes its task, results are announced back to the parent session automatically.

### Workspace Isolation

Each agent workspace is fully isolated:

```
/home/youruser/.openclaw/workspace-anthropic-claude-opus-4-6/
/home/youruser/.openclaw/workspace-google-gemini-cli-gemini-3-pro-preview/
/home/youruser/.openclaw/workspace-google-gemini-cli-gemini-3-1-pro-preview/
```

Agents have their own `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `MEMORY.md`, and `memory/` directories within their workspace.

---

## 7. Plugin System & API Hooks

The fork uses a hook-based plugin system for intercepting agent lifecycle events.

### Hook Registration

**Use `api.on()` — NOT `api.registerHook()`.**

The `api.registerHook()` method from upstream OpenClaw does not exist in our fork. All hook registration must use the `api.on()` event emitter pattern.

### Available Hooks

| Hook | Fires When |
|---|---|
| `before_agent_start` | Before the AI model is invoked |
| `after_agent_response` | After the AI returns a response |
| `tool_call` | When a tool is about to be executed |
| `tool_result` | After a tool returns its result |

Additional hooks may exist — check plugin documentation for the full list.

### Hot-Reload Limitations

Sending `SIGUSR1` to the gateway process triggers a hot-reload of configuration, but **it does NOT re-wrap tools with plugin hooks**. This means:

- Config changes: Apply with `SIGUSR1` ✓
- Plugin logic changes: Require a **full gateway restart** ✗

---

## 8. Model Configuration

### Default Model

The default model is `claude-opus-4-6` (Anthropic Claude Opus), set in the `model` field of `openclaw.json`.

### Available Models

| Provider | Models |
|---|---|
| **Anthropic** | Claude Opus, Claude Sonnet, Claude Haiku |
| **Google** | Gemini 3 Pro, Gemini 3.1 Pro |
| **OpenAI** | GPT-4o |

### Model Overrides

Models can be overridden at multiple levels:

- **Per-user** — The gateway reads `modelOverride` from user context and routes accordingly.
- **Per-session** — Use the `session_status` tool to change the model for a specific session at runtime.

---

## 9. Key Source Files

| File | Purpose |
|---|---|
| `server-chat.ts` | Core event routing and message handling |
| `pi-embedded-subscribe.handlers.tools.ts` | Tool event emission for AG-UI streaming |
| `sessions.json` | Session metadata index (IDs, models, token counts) |
| `openclaw.json` | Gateway configuration |

---

## 10. Systemd Service

The gateway runs as a user-level systemd service: `openclaw-gateway.service`.

### Common Commands

```bash
# Check status
systemctl --user status openclaw-gateway

# Restart (preferred over stop+start)
systemctl --user restart openclaw-gateway

# View logs
journalctl --user -u openclaw-gateway -f

# Hot-reload config (does NOT reload plugin hooks)
systemctl --user kill -s SIGUSR1 openclaw-gateway
```

### Restart Policy

**Never stop the gateway mid-work.** Only restart at the end of a work phase. Stopping the gateway drops all active WebSocket connections and interrupts running sessions.

---

## 11. Operational Notes

### npm Install

The fork requires the `--legacy-peer-deps` flag for all `npm install` operations:

```bash
npm install --legacy-peer-deps
```

Without this flag, dependency resolution will fail due to peer dependency conflicts in the fork's modified dependency tree.

### Gateway Token

The gateway token serves double duty as the admin password for Scratchy authentication. Treat it as a secret — do not log it, expose it in responses, or commit it to version control.

### Session Corruption Recovery

1. Identify the corrupted session file in `/home/youruser/.openclaw/sessions/`.
2. Delete the corrupted `.jsonl` file.
3. The security plugin auto-repair mechanism will handle orphaned `tool_result` entries.
4. The session will reinitialize on next connection.

---

## 12. Troubleshooting

### Tool events not appearing in client

- Verify `caps: ["tool-events"]` is at the **root level** of ConnectParams (not inside `client`).
- Verify `verboseDefault: "on"` is set.
- Check that the client ID is from the allowed enum.

### Plugin changes not taking effect

- `SIGUSR1` hot-reload does NOT re-wrap tool hooks.
- Perform a full gateway restart: `systemctl --user restart openclaw-gateway`.

### WebSocket connection rejected

- Ensure `client.id` uses a value from the fixed enum (`webchat`, `cli`, etc.).
- Ensure no extra properties exist — schema enforces `additionalProperties: false`.

### npm install fails

- Always use `--legacy-peer-deps`:
  ```bash
  npm install --legacy-peer-deps
  ```

### Cannot write to openclaw.json / SOUL.md / AGENTS.md

- The security layer blocks direct writes to these files.
- Use `config.patch` through the gateway for config changes.

### Per-user sessions not working in webchat

- Per-user webchat sessions are **not supported**. All webchat users share `agent:main:main`.
- User isolation is handled by Scratchy at its own application layer.

---

*This document covers OpenClaw fork v2026.2.4. For upstream OpenClaw documentation, see the main OpenClaw repository. Our fork diverges in plugin API (`api.on()` vs `api.registerHook()`), security plugin integration, and multi-agent orchestration.*
