# ClawOS Security Architecture — Technical Reference

> **Version:** 1.0  
> **Last updated:** 2026-02-23  
> **Scope:** Defense-in-depth security plugin for OpenClaw AI agent operations

---

## Quick Reference

| Layer | ID | Name | Purpose |
|-------|----|------|---------|
| 0 | L0 | Session Repair | Auto-detects and repairs corrupted session JSONL (orphaned `tool_result` messages) |
| 1 | L1 | Content Trust Classification | Tags every incoming message with a trust level (`owner`, `operator`, `external`, `untrusted`) |
| 2 | L2 | Input Sanitization | Scans for and blocks prompt injection patterns before they reach the agent |
| 3 | L3 | Tool Gating | Per-user tool permission enforcement; 14 tools, each independently toggleable |
| 4 | L4 | Output Filtering | Scans agent responses for credential leaks, sensitive data, and security tokens |
| 5 | L5 | Rate Limiting & Quotas | Per-user message, token, TTS, and model-access quotas; sub-agent spawn limits |
| — | LC | Context Injection | Injects security context (permissions, restrictions) into non-admin sessions |
| — | LF | File Protection | Blocks writes to critical files (`SOUL.md`, `AGENTS.md`, `openclaw.json`) |
| — | — | Canary Detection | Embeds verification tokens to detect prompt injection and context exfiltration |

---

## 1. Overview

ClawOS is a 9-layer security plugin for [OpenClaw](https://openclaw.io) that provides defense-in-depth for AI agent operations. It is designed around a single core principle: **never trust the agent to police itself — enforce constraints externally.**

### Architecture at a Glance

- **Packaging:** Bundled as a single OpenClaw plugin, declared in `openclaw.json`.
- **Hook mechanism:** Uses `api.on()` event hooks (not `api.registerHook()`).
- **Activation:** Active on every agent turn. Runs in the `before_agent_start` lifecycle phase and wraps individual tool calls.
- **Coverage:** All 9 layers execute in sequence on every turn, forming a pipeline from session integrity through to output filtering.

### Design Philosophy

ClawOS follows a defense-in-depth model where each layer operates independently. A failure in one layer does not compromise the others. The layers are ordered from low-level infrastructure concerns (session integrity) to high-level policy enforcement (output filtering, file protection), ensuring that the agent operates within well-defined boundaries at every stage of a request-response cycle.

---

## 2. Security Layers — Detailed Reference

### 2.1 Layer 0 (L0) — Session Repair

**Purpose:** Maintain session JSONL integrity by detecting and repairing corrupted message sequences before they reach the LLM API.

**Problem Statement:**
Sessions with extremely high tool call counts (920+ observed) can produce orphaned `tool_result` messages — messages that reference a `tool_call` ID that no longer exists in the conversation history. When these malformed sequences are sent to the Anthropic API, the API returns a `400 Bad Request` error. Without L0, this triggers a repair loop: the agent retries, hits the same error, retries again, and so on.

**How It Works:**

1. Before each agent turn, L0 scans the session JSONL for orphaned `tool_result` messages (i.e., `tool_result` blocks with no matching preceding `tool_call`).
2. If corruption is detected, L0 creates a timestamped backup of the session file with the naming convention `.jsonl.clawos-backup-{timestamp}`.
3. The corrupted messages are removed from the JSONL.
4. The repaired session is passed to subsequent layers.

**Operational Notes:**

- **Backup files** (`.jsonl.clawos-backup-*`) **must be excluded from history parsing.** Any code that reads session history should filter these files out.
- **Recovery from severe corruption:** If L0 enters a repair loop itself (the repaired session is still invalid), the recommended fix is to delete the corrupted session JSONL entirely. L0 now includes cascade prevention logic to avoid this scenario.
- L0 runs before all other layers because no security policy can be enforced on a session that cannot be sent to the API.

---

### 2.2 Layer 1 (L1) — Content Trust Classification

**Purpose:** Assign a trust level to every incoming message, establishing the security context for all downstream layers.

**Trust Levels:**

| Level | Description | Example |
|-------|-------------|---------|
| `owner` | Admin. Full access, all tools, no restrictions. | Direct webchat session from admin |
| `operator` | Authenticated user. Default tool set, subject to quotas. | Authenticated API user or shared session participant |
| `external` | Channel message. Reduced trust, additional restrictions. | Discord message, Telegram message |
| `untrusted` | Unknown or suspicious source. Maximum restrictions. | Unverified input, flagged content |

**Output Format:**
L1 annotates the message context with:
```
[ClawOS L1] Content trust: {level}, source: {channel}
```

**Downstream Impact:**
The trust classification from L1 directly influences:
- Which tools are available (L3 — Tool Gating)
- What security context is injected (LC — Context Injection)
- What quotas apply (L5 — Rate Limiting)
- How aggressively input is sanitized (L2 — Input Sanitization)

---

### 2.3 Layer 2 (L2) — Input Sanitization

**Purpose:** Scan user messages for known prompt injection patterns and block them before they influence agent behavior.

**Behavior:**

- Incoming messages are scanned against a set of known injection signatures.
- Messages that match injection patterns are blocked and do not reach the agent.
- Clean messages pass through with their L1 trust tags intact.

**Design Rationale:**
Prompt injection is the most significant threat to AI agent systems. L2 acts as a first line of defense, catching known attack patterns at the input boundary. It works in concert with the Canary Detection system (which catches exfiltration attempts at the output boundary) to provide bidirectional injection protection.

---

### 2.4 Layer 3 (L3) — Tool Gating

**Purpose:** Enforce per-user tool permissions, ensuring users can only invoke tools they are authorized to use.

**Tool Inventory (14 tools):**

| Tool | Operator Default | Admin | Notes |
|------|:---:|:---:|-------|
| `exec` | ✅ | ✅ | Shell command execution |
| `read` | ✅ | ✅ | File reading |
| `write` | ✅ | ✅ | File writing (subject to LF) |
| `edit` | ✅ | ✅ | File editing (subject to LF) |
| `web_search` | ✅ | ✅ | Brave Search API |
| `web_fetch` | ✅ | ✅ | URL content extraction |
| `browser` | ✅ | ✅ | Browser automation |
| `image` | ✅ | ✅ | Vision model analysis |
| `tts` | ✅ | ✅ | Text-to-speech |
| `sessions_spawn` | ✅ | ✅ | Sub-agent spawning |
| `gateway` | ❌ | ✅ | Gateway daemon control |
| `nodes` | ❌ | ✅ | Paired node management |
| `cron` | ❌ | ✅ | Scheduled task management |
| `message` | ❌ | ✅ | Cross-channel messaging |

**BYOK (Bring Your Own Key) Users:**
Users who provide their own API keys bypass all quotas (L5), but tool blacklists are still enforced. A BYOK user who is an operator still cannot use `gateway`, `nodes`, `cron`, or `message`.

---

### 2.5 Layer 4 (L4) — Output Filtering

**Purpose:** Scan agent responses before delivery to prevent credential leaks, sensitive data exposure, and security token exfiltration.

**What L4 Blocks:**

- API keys, tokens, and credentials in agent output
- Security-sensitive internal data
- ClawOS canary tokens (see Canary Detection below)
- Any content matching sensitive data patterns

**Position in Pipeline:**
L4 is the last layer before the response reaches the user, acting as a final safety net. Even if an injection bypasses L2 and tricks the agent into generating sensitive output, L4 catches it at the exit.

---

### 2.6 Layer 5 (L5) — Rate Limiting & Quotas

**Purpose:** Enforce per-user resource consumption limits to prevent abuse and manage costs.

**Quota Dimensions:**

| Dimension | Description |
|-----------|-------------|
| Message quotas | Maximum messages per time window per user |
| Token quotas | Maximum input/output tokens per time window |
| TTS quotas | Maximum text-to-speech requests or characters |
| Model access | Which LLM models each user can access |
| Sub-agent spawns | Maximum concurrent or total sub-agent sessions |

**BYOK Bypass:**
Users who supply their own API keys bypass all L5 quotas. They are consuming their own resources, so rate limiting is unnecessary. Tool-level restrictions (L3) still apply.

---

### 2.7 Layer C (LC) — Context Injection

**Purpose:** Inject security context into the agent's system prompt for non-admin sessions, informing the AI about the current user's permissions and restrictions.

**Behavior:**

- For non-admin users, LC injects a context block that tells the agent:
  - Who the user is and their trust level
  - Which tools are available and which are restricted
  - What quotas apply
  - Any session-specific security policies
- Admin sessions do not receive injected context (the admin has full access).

**Known Bug:**
Layer C context has been observed persisting across user messages due to `web_fetch` injection signals. When a `web_fetch` tool result contains content that resembles LC injection markers, the context can bleed across message boundaries. This is under active investigation.

---

### 2.8 Layer LF — File Protection

**Purpose:** Prevent agents from modifying critical system files that define their own behavior and the platform's configuration.

**Protected Files:**

| File | Reason |
|------|--------|
| `SOUL.md` | Agent behavioral contract / personality definition |
| `AGENTS.md` | Workspace conventions and operational rules |
| `openclaw.json` | Platform configuration, plugin declarations, model settings |

**Bypass Mechanism:**
To modify protected configuration files, use the gateway `config.patch` mechanism, which requires admin-level access and operates outside the agent's tool pipeline.

**Design Rationale:**
An agent that can modify its own behavioral contracts can effectively remove its own safety constraints. LF ensures that the boundary between "what the agent does" and "what the agent is" remains externally controlled.

---

### 2.9 Canary Detection

**Purpose:** Detect prompt injection attempts that try to extract the agent's system context or security configuration.

**Mechanism:**

1. A randomly generated canary token is embedded in the agent's system context with the format: `CLAWOS_CANARY_{random}`.
2. The agent is instructed to **never output this token** in any response.
3. If the canary token appears in external content (e.g., a web page fetched by the agent, a user message, or a channel message), it indicates that a prompt injection attack is attempting to extract and replay the system context.

**Detection Flow:**

```
System context includes CLAWOS_CANARY_abc123
    ↓
External content contains "CLAWOS_CANARY_abc123"
    ↓
Alert: Prompt injection detected — external source has access to system context
```

**Known Issues:**

- **False positives:** The majority of canary alerts are false positives. They are triggered when the canary token appears in trusted tool results (e.g., when the agent reads its own system files or processes internal data). The detection logic does not currently distinguish between trusted tool results and genuinely external content.
- **Planned fix:** Skip canary detection for trusted tool results to reduce false positive rate.

---

## 3. Memory System Integration

ClawOS integrates with OpenClaw's memory system to provide context-aware security and agent continuity.

### Auto-Recall

Before answering questions about prior work, ClawOS triggers a `memory_search` operation to retrieve relevant context from the memory store.

### Memory Files

| File | Purpose | Scope |
|------|---------|-------|
| `MEMORY.md` | Long-term curated memory | Main sessions only (not loaded in group chats for security) |
| `memory/YYYY-MM-DD.md` | Daily logs / raw notes | All sessions |

### Context Injection Format

When memory sections are auto-recalled, they are injected into the agent's context with source attribution:

```
[ClawOS Memory] Auto-recalled N relevant memory section(s)
```

This ensures the agent knows the provenance of recalled information and can weigh its relevance accordingly.

---

## 4. Key Security Principles

ClawOS is built on a set of foundational security principles that inform every layer's design:

1. **External verification only.** Agent self-verification is unreliable. An agent that has been compromised by prompt injection cannot reliably detect its own compromise. All security enforcement must happen externally, in the plugin layer.

2. **Never exfiltrate private data.** No agent action should result in private data leaving the system without explicit user authorization.

3. **Recoverable over destructive.** Prefer `trash` over `rm`. Prefer backups over overwrites. Recoverable operations are always safer than irreversible ones.

4. **Ask before external actions.** Any action that leaves the system — emails, tweets, public posts — requires explicit user confirmation.

5. **Privacy in group contexts.** Private data stays private in group chats. The agent has access to the admin's data but does not share it in multi-user contexts.

6. **Sub-agent containment.** Sub-agents must not run destructive commands on shared resources. Sub-agents must not schedule more sub-agents on failure (recursion bomb prevention).

7. **Circuit breakers everywhere.** All retry logic must include circuit breakers: maximum 3 retries with exponential backoff. Unbounded retries lead to cascading failures (as demonstrated by the L0 session repair loop incident).

---

## 5. Incident Reference: Session Corruption Cascade

This section documents the most significant incident that shaped ClawOS's L0 design.

### Root Cause

A session accumulated 920+ tool calls, producing orphaned `tool_result` messages in the session JSONL. These orphaned messages — `tool_result` blocks referencing `tool_call` IDs that no longer existed in the conversation — violated the Anthropic API's message format requirements.

### Failure Mode

1. Agent turn sends malformed session to Anthropic API.
2. API returns `400 Bad Request`.
3. Agent retries (standard retry logic).
4. Same malformed session → same 400 error.
5. Retry loop continues indefinitely.

### Resolution

- **Immediate fix:** Delete the corrupted session JSONL file.
- **Permanent fix:** L0 now detects orphaned `tool_result` messages before the API call and removes them, creating timestamped backups (`.jsonl.clawos-backup-{timestamp}`) before any modification.
- **Cascade prevention:** L0 includes logic to detect when it is itself in a repair loop and breaks the cycle rather than retrying indefinitely.

### Lessons Learned

- Sessions with extremely high tool call counts are inherently fragile.
- Backup files created by repair processes must be excluded from history parsing to avoid reintroducing corruption.
- Every automated repair mechanism needs its own circuit breaker.

---

## 6. Configuration & Deployment

### Installation

ClawOS is declared as a plugin in `openclaw.json`. The plugin registers its hooks via `api.on()` during OpenClaw initialization.

### Hook Registration

```
api.on('before_agent_start', ...)  // L0, L1, L2, L3, L5, LC run here
api.on('tool_call', ...)           // L3 (gating), LF (file protection) run here
api.on('before_response', ...)     // L4, Canary Detection run here
```

> **Important:** ClawOS uses `api.on()`, not `api.registerHook()`. These are different mechanisms in OpenClaw's plugin API. Using the wrong one will result in hooks not firing.

### Protected File Modification

To modify files protected by Layer LF (`SOUL.md`, `AGENTS.md`, `openclaw.json`), use:

```bash
openclaw gateway config.patch <patch-file>
```

This operates outside the agent tool pipeline and requires admin access.

---

## 7. Known Issues & Limitations

| Issue | Layer | Status | Description |
|-------|-------|--------|-------------|
| Canary false positives | Canary | Open | Canary detection triggers on trusted tool results, not just external content |
| LC context persistence | LC | Investigating | `web_fetch` content can cause Layer C context to bleed across message boundaries |
| High tool-call sessions | L0 | Mitigated | Sessions with 900+ tool calls can still produce edge cases; L0 handles most but not all |

---

## 8. Glossary

| Term | Definition |
|------|------------|
| **BYOK** | Bring Your Own Key — users who supply their own LLM API keys |
| **Canary token** | A random string embedded in system context to detect exfiltration |
| **Defense-in-depth** | Security strategy using multiple independent layers |
| **JSONL** | JSON Lines format — one JSON object per line; used for session storage |
| **Orphaned tool_result** | A `tool_result` message whose corresponding `tool_call` no longer exists in the session |
| **Tool gating** | Restricting which tools a user can invoke based on their permission level |
| **Trust classification** | The process of assigning a trust level to incoming messages |

---

*This document is a living reference. Update it as ClawOS evolves.*
