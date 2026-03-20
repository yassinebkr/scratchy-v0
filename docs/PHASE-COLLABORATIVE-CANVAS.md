# Phase: Collaborative Multi-User Canvas Sessions

## Overview

Enable real-time collaboration on Scratchy canvases — multiple authenticated users sharing the same spatial grid, seeing each other's presence, and interacting with components simultaneously. Built on Phase 19's multi-user auth and Scratchy's existing canvas infrastructure.

### Use Cases

- **Team dashboards** — ops team monitors shared gauges, charts, and alerts; anyone can rearrange or drill into components
- **Shared monitoring** — NOC-style wall where the agent streams live data and multiple viewers watch (some with edit rights)
- **Pair debugging with agent** — two users + the agent collaborate on a canvas: one drives, the other observes and annotates
- **Workshop / whiteboarding** — build a canvas together (forms, checklists, kv panels) during a planning session
- **Handoff** — user A sets up a canvas, invites user B to take over; both see the same state during transition

### Current State

```
Browser A ──WS──► Scratchy Server ──► .canvas-state.json (single file)
                       │
                       ├── SurfaceState (in-memory, max 20 surfaces)
                       ├── ProtocolRouter (a2ui / v1 / chat / ag-ui)
                       └── broadcast to all WS connections (no user context)
```

- Canvas state stored server-side in `.canvas-state.json` and managed in-memory by `SurfaceState`
- Widget actions broadcast to **all** connected clients indiscriminately
- Components are 34 LiveComponent types with DOM-based lifecycle
- No concept of "who" sent an operation — all ops are anonymous
- No rooms — one implicit canvas per server instance

### Target State

```
                    ┌──────────────────────────────────┐
                    │        Scratchy Server            │
                    │                                   │
Browser A ──WS──►  │  Room Manager                     │
Browser B ──WS──►  │  ├── room:dashboard-prod          │
Agent    ──WS──►   │  │   ├── state (SurfaceState)     │
                    │  │   ├── participants [{user,role}]│
                    │  │   ├── presence (cursors, focus) │
                    │  │   └── op log (last N ops)       │
                    │  ├── room:debug-session-42         │
                    │  │   └── ...                       │
                    │  └── room:personal-{userId}        │
                    │                                   │
                    │  Permission Gate                   │
                    │  └── check(userId, roomId, action) │
                    │                                   │
                    │  Sync Engine                       │
                    │  └── LWW per-component + op log    │
                    └──────────────────────────────────┘
```

## Real-time Sync Strategy

### Approaches Considered

| Approach | Pros | Cons | Fit for Scratchy |
|----------|------|------|------------------|
| **OT (Operational Transform)** | Proven for text (Google Docs); precise intent preservation | Complex to implement; designed for sequential character streams, poor fit for spatial grid ops | ❌ Overkill — canvas ops are discrete component-level mutations, not character streams |
| **CRDT (Conflict-free Replicated Data Types)** | Mathematically convergent; works offline; no central authority needed | Memory overhead (tombstones, vector clocks); complex for nested/ordered structures; Scratchy is server-authoritative anyway | ⚠️ Possible but heavy — we don't need offline-first or peer-to-peer |
| **Last-Write-Wins per component (LWW)** | Dead simple; server-authoritative; fits existing SurfaceState model; trivial conflict resolution | Last write silently wins — no merge; possible user frustration on simultaneous edits | ✅ Best fit — canvas components are independent atomic units |

### Decision: LWW Per-Component with Op Log

**Rationale:**
1. Canvas components are **independent tiles** — editing a gauge doesn't affect a chart. Conflicts are rare and localized.
2. Scratchy is **server-authoritative** — the server already owns the canonical state. No need for peer-to-peer convergence.
3. The existing `SurfaceState` class already does deep-merge upserts — this is fundamentally LWW.
4. An **operation log** (last N ops per room) provides auditability and enables undo.

**How it works:**
```
User A: upsert gauge-cpu {value: 73}  →  server applies, broadcasts, logs
User B: upsert gauge-cpu {value: 81}  →  server applies (overwrites 73), broadcasts, logs
                                          (B's write wins — it arrived later)
```

For the rare case of true conflict (two users editing the same component within ~100ms), the server resolves by timestamp ordering. See [Conflict Resolution](#conflict-resolution) below.

**Future upgrade path:** If real conflicts become frequent (unlikely for canvas UIs), upgrade specific component types to field-level CRDT (e.g., Automerge for rich-text inside a `code` component) without changing the overall architecture.

## Presence

### What Users See

- **Online roster** — who's in this canvas room (avatar, display name, role badge)
- **Focus indicator** — which component a user is currently interacting with (colored border ring)
- **Cursor positions** (optional, off by default) — live cursor overlay for pair-programming/whiteboard mode
- **Idle detection** — greyed-out avatar after 60s of inactivity

### Data Model

```json
{
  "userId": "usr_abc123",
  "displayName": "Admin",
  "avatarUrl": "https://...",
  "role": "owner",
  "status": "active",
  "focusedComponent": "gauge-cpu",
  "cursor": { "x": 420, "y": 310 },
  "lastActive": 1740214980000
}
```

### Protocol

- **Heartbeat:** Client sends `presence:heartbeat` every 10s with `{ cursor?, focusedComponent? }`
- **Join/Leave:** Server broadcasts `presence:join` and `presence:leave` to all room participants
- **Timeout:** If no heartbeat for 30s, server marks user idle; after 120s, auto-removes from room
- **Bandwidth:** Cursor position updates throttled to 5Hz (every 200ms) client-side; server further deduplicates

## Conflict Resolution

### Scenario Matrix

| Scenario | Resolution | User Experience |
|----------|-----------|-----------------|
| Two users edit different components | No conflict — both applied | Both see each other's changes in real-time |
| Two users edit same component, different fields | Deep merge (existing `_deepMerge`) | Both changes preserved |
| Two users edit same component, same field | LWW by server receipt timestamp | Loser's change overwritten; brief flash as UI reconciles |
| Two users drag same tile simultaneously | LWW on `layout` field; last `move` op wins | Tile snaps to winner's position |
| Concurrent widget actions (button click) | Both actions execute in receipt order | Both effects happen sequentially |
| User edits component while agent replaces it | Agent's `upsert` wins (full replace) | User sees component reset; toast notification "Agent updated this component" |

### Conflict Indicators (Client-Side)

When a user's pending operation is overwritten by another user's operation before acknowledgment:

1. **Brief highlight** — component border flashes orange for 500ms
2. **Toast** — "Admin updated gauge-cpu" (shows who caused the overwrite)
3. **Op log** — user can inspect recent changes via canvas history panel

### Conflict Reduction

- **Component locking (soft):** When a user focuses a component (clicks to edit), server broadcasts `component:focus { userId, componentId }`. Other users see a colored ring and a "Admin is editing" tooltip. This is **advisory**, not enforced — users can still edit, but the social signal reduces conflicts.
- **Debounce:** Client debounces rapid edits (300ms) before sending — reduces the window for conflicts.

## Permissions

### Role Model

Built on Phase 19's RBAC, extended with per-room granularity:

| Role | Canvas Permissions |
|------|-------------------|
| **Owner** | Full control: edit, configure room, manage participants, delete room |
| **Collaborator** | Edit components, drag tiles, trigger widget actions |
| **Viewer** | Read-only: see canvas state and presence, no modifications |

### Per-Room Access Control

```json
{
  "roomId": "room_dashboard-prod",
  "ownerId": "usr_abc123",
  "access": {
    "usr_def456": "collaborator",
    "usr_ghi789": "viewer"
  },
  "defaultAccess": "none",
  "isPublic": false,
  "inviteCode": "inv_Xk9mQ2..."
}
```

- **`defaultAccess`** — what happens when an authenticated user tries to join without explicit access:
  - `"none"` — denied (private room, invite required)
  - `"viewer"` — anyone can watch
  - `"collaborator"` — open editing (team rooms)
- **`isPublic`** — if true, unauthenticated users can view (for public dashboards)
- **Invite codes** — shareable link that grants a specific role on join

### Permission Checks

Every incoming operation goes through the permission gate **before** being applied:

```
WS op received
  → extract userId from session
  → extract roomId from op
  → check(userId, roomId, action)
  → if denied: send error frame, drop op
  → if allowed: apply to SurfaceState, broadcast
```

**Action types checked:**
- `canvas.view` — join room, receive state snapshot
- `canvas.edit` — upsert, patch, remove, move, clear
- `canvas.admin` — rename room, change permissions, delete room
- `canvas.invite` — generate invite codes

## Canvas Rooms

### Concept

A **room** is a named, persistent canvas workspace with its own state, participants, and permissions. Rooms replace the current single-canvas model.

### Room Lifecycle

```
Create Room
  → owner specifies: name, description, defaultAccess
  → server generates roomId (room_{slug})
  → empty SurfaceState initialized
  → persisted to .scratchy-data/rooms/{roomId}/

Join Room
  → user sends room:join {roomId}
  → permission check (access list or defaultAccess)
  → server sends STATE_SNAPSHOT (current canvas state)
  → server broadcasts presence:join to existing participants
  → client renders canvas

Leave Room
  → user sends room:leave or disconnects
  → server broadcasts presence:leave
  → if no participants for 5 min, room state stays persisted but unloaded from memory

Delete Room
  → owner sends room:delete {roomId}
  → confirmation required (double-action: delete + confirm within 10s)
  → all participants kicked with room:deleted notification
  → state archived (moved to .scratchy-data/rooms/_archive/{roomId}/)
```

### Personal Rooms

Each user automatically gets a personal room (`room_personal-{userId}`) that:
- Only they can access (owner-only, not listed publicly)
- Migrates existing single-user canvas state
- Can be shared by explicitly inviting collaborators

### Room Storage

```
.scratchy-data/
  rooms/
    room_dashboard-prod/
      state.json            ← SurfaceState serialized
      meta.json             ← name, owner, access, created, updated
      ops.log               ← append-only operation log (last 1000 ops)
    room_personal-usr_abc123/
      state.json
      meta.json
      ops.log
    _archive/               ← soft-deleted rooms
```

### Room Discovery

- **Room list endpoint:** `GET /api/rooms` — returns rooms the authenticated user can access
- **Room info:** `GET /api/rooms/:id` — metadata + participant count (if user has access)
- **WS message:** `room:list` → server responds with `room:list:result`

## Network Protocol

### WebSocket Frame Extensions

All existing frames continue to work. New frames are prefixed with the room context:

#### Client → Server

```jsonc
// Join a room
{ "type": "room:join", "payload": { "roomId": "room_dashboard-prod" } }

// Leave a room
{ "type": "room:leave", "payload": { "roomId": "room_dashboard-prod" } }

// Canvas operation (upsert/patch/remove/move/clear) — now scoped to a room
{
  "type": "a2ui",
  "payload": {
    "roomId": "room_dashboard-prod",
    "surfaceId": "main",
    "ops": [
      { "op": "upsert", "id": "gauge-cpu", "type": "gauge", "data": { "value": 73 } }
    ]
  },
  "ts": 1740214980000,
  "opId": "op_a1b2c3"  // client-generated, for ack + undo
}

// Presence heartbeat
{
  "type": "presence:heartbeat",
  "payload": {
    "roomId": "room_dashboard-prod",
    "cursor": { "x": 420, "y": 310 },
    "focusedComponent": "gauge-cpu"
  }
}

// Room management
{ "type": "room:create", "payload": { "name": "Dashboard Prod", "defaultAccess": "viewer" } }
{ "type": "room:delete", "payload": { "roomId": "room_dashboard-prod" } }
{ "type": "room:invite", "payload": { "roomId": "...", "userId": "...", "role": "collaborator" } }
{ "type": "room:list", "payload": {} }
```

#### Server → Client

```jsonc
// Operation acknowledgment
{ "type": "op:ack", "payload": { "opId": "op_a1b2c3", "applied": true } }

// Operation broadcast (to other users in the room)
{
  "type": "canvas:op",
  "payload": {
    "roomId": "room_dashboard-prod",
    "userId": "usr_def456",
    "displayName": "Sara",
    "ops": [ { "op": "patch", "id": "gauge-cpu", "data": { "value": 81 } } ],
    "opId": "op_d4e5f6",
    "ts": 1740214981000
  }
}

// State snapshot (on join)
{
  "type": "canvas:snapshot",
  "payload": {
    "roomId": "room_dashboard-prod",
    "surfaceId": "main",
    "components": [ /* ... full component list ... */ ],
    "data": { /* ... surface data ... */ }
  }
}

// Presence events
{
  "type": "presence:join",
  "payload": { "roomId": "...", "user": { "userId": "...", "displayName": "...", "role": "collaborator" } }
}
{ "type": "presence:leave", "payload": { "roomId": "...", "userId": "..." } }
{
  "type": "presence:update",
  "payload": {
    "roomId": "...",
    "users": [
      { "userId": "...", "cursor": { "x": 420, "y": 310 }, "focusedComponent": "gauge-cpu", "status": "active" }
    ]
  }
}

// Room events
{ "type": "room:created", "payload": { "roomId": "...", "name": "...", "ownerId": "..." } }
{ "type": "room:deleted", "payload": { "roomId": "...", "reason": "owner_deleted" } }
{ "type": "room:list:result", "payload": { "rooms": [ { "roomId": "...", "name": "...", "participants": 3 } ] } }

// Errors
{ "type": "error", "payload": { "code": "PERMISSION_DENIED", "message": "...", "opId": "op_a1b2c3" } }
```

### Backward Compatibility

- Ops without `roomId` are routed to the user's personal room (migration path from single-canvas)
- The v1 raw array format still works — `ProtocolRouter.normalize()` wraps it and routes to the personal room
- Clients that don't understand presence frames silently ignore them (unknown type = drop)

## Performance

### Batching

- **Client-side:** Collect ops for 50ms before sending a batch. Multiple rapid edits → single WS frame.
- **Server-side:** When broadcasting, batch multiple ops from different users into a single frame per recipient (up to 16 ops per batch, or 50ms window).

### Throttling Broadcast

```
Incoming op rate (per room): tracked with a sliding window

< 50 ops/sec  →  broadcast immediately (real-time feel)
50-200 ops/sec →  batch into 100ms windows (high activity, e.g., multiple users dragging)
> 200 ops/sec  →  batch into 250ms windows + drop intermediate move/cursor ops (keep only latest per component)
```

### Handling Slow Clients

- **Send buffer per WS connection:** if buffer exceeds 64KB, switch client to "snapshot mode" — skip queued ops and send a full `canvas:snapshot` when they catch up.
- **Backpressure signal:** server sends `{ type: "flow:slow" }` warning; client can reduce presence heartbeat frequency.
- **Graceful degradation:** if a client can't keep up for 30s, disconnect with code 4008 ("too slow") and let them reconnect fresh.

### Memory Management

- **Room unloading:** Rooms with no participants for 5 minutes are serialized to disk and unloaded from memory.
- **Op log rotation:** Only last 1000 ops kept per room. Older ops archived to `ops.log.gz`.
- **Presence cleanup:** Stale presence entries (no heartbeat for 120s) automatically purged.

## Undo/Redo

### Per-User Undo Stack

Each user maintains their own undo stack (server-side, per room):

```json
{
  "userId": "usr_abc123",
  "roomId": "room_dashboard-prod",
  "undoStack": [
    {
      "opId": "op_a1b2c3",
      "ts": 1740214980000,
      "inverse": { "op": "patch", "id": "gauge-cpu", "data": { "value": 65 } }
    }
  ],
  "redoStack": []
}
```

### How It Works

1. **On apply:** Server computes the **inverse operation** (snapshot of the affected component's previous state) and pushes it onto the user's undo stack.
2. **On undo (Ctrl+Z):** Client sends `{ type: "canvas:undo", payload: { roomId } }`. Server pops the top inverse op, applies it, broadcasts the result, and pushes the forward op onto the redo stack.
3. **On redo (Ctrl+Shift+Z):** Reverse of undo — pop from redo, apply, push to undo.
4. **Stack invalidation:** If another user modifies a component that's in your undo stack, the affected undo entry is **marked stale** (not removed). Attempting to undo a stale entry shows a toast: "This component was modified by Sara — undo may produce unexpected results. Apply anyway?" with confirm/cancel.

### Shared History

The op log serves as a **shared, read-only history** for the room:
- Viewable via a "Canvas History" panel (sidebar)
- Shows: who did what, when, with diff previews
- Filterable by user and component
- Not editable — undo is the mechanism for reverting

### Limits

- Undo stack: max 50 entries per user per room
- Op log: max 1000 entries per room (then rotate)
- Undo entries expire after 1 hour (to prevent stale undos on long-running canvases)

## Server Changes

### New Modules

| Module | Responsibility |
|--------|---------------|
| `canvas/lib/room-manager.js` | Room CRUD, lifecycle, persistence, room listing |
| `canvas/lib/room-state.js` | Per-room wrapper: SurfaceState + participants + op log + undo stacks |
| `canvas/lib/presence-tracker.js` | Track connected users per room, heartbeats, timeouts, cursor aggregation |
| `canvas/lib/permission-gate.js` | Check user permissions for room actions; integrates with Phase 19 auth |
| `canvas/lib/op-log.js` | Append-only operation log with rotation, inverse computation |
| `canvas/lib/broadcast.js` | Smart broadcast: batching, throttling, slow-client detection |

### Changes to Existing Modules

**`canvas/lib/surface-state.js`:**
- No changes to the class itself — it remains a pure state container
- Instantiated per-room instead of globally

**`canvas/lib/protocol-router.js`:**
- Add `room:*` message type handlers
- Add `presence:*` message type handlers
- Inject `userId` and `roomId` into routing context
- Add `canvas:undo` / `canvas:redo` handlers

**`serve.js` (main server):**
- WS connection handler: after auth, user is not in any room until they send `room:join`
- Replace global canvas state with `RoomManager` instance
- Auth middleware injects `userId` into WS context (from Phase 19 session)
- Graceful shutdown: serialize all active room states to disk

### Storage Layout

```
.scratchy-data/
  rooms/
    room_{slug}/
      state.json            ← serialized SurfaceState
      meta.json             ← { roomId, name, ownerId, access, defaultAccess, isPublic, created, updated }
      ops.log               ← newline-delimited JSON (append-only)
      ops.log.1.gz          ← rotated log
    _archive/
      room_{slug}/          ← soft-deleted rooms (recoverable)
  room-index.json           ← fast lookup: roomId → name, owner, participant count
```

## Client Changes

### New UI Components

**Presence Bar (top of canvas):**
```
┌──────────────────────────────────────────────────────────┐
│  📊 Dashboard Prod    👤 Admin(you)  👤 Sara  👤 Agent │  ← room name + avatars
│                                            🟢     🟢     │  ← online indicators
└──────────────────────────────────────────────────────────┘
```

- Avatars with colored rings (each user gets a consistent color)
- Click avatar → show role, focus location ("viewing gauge-cpu")
- Overflow: "+3 more" chip when >5 participants

**Room Switcher (sidebar or dropdown):**
```
┌─────────────────────────┐
│  Your Rooms              │
│  ├── 📊 Dashboard Prod  │  ← 3 online
│  ├── 🔧 Debug Session   │  ← 1 online
│  └── 📝 Personal        │
│                          │
│  [+ Create Room]         │
│  [🔗 Join by Invite]    │
└─────────────────────────┘
```

**Component Focus Indicators:**
- When another user focuses a component: colored border ring (matches their avatar color)
- Tooltip on hover: "Sara is editing"
- When another user is dragging a component: ghost outline shows their intended position

**Conflict Toast:**
- Bottom-right transient notification
- "Sara updated gauge-cpu" with a small diff preview
- Auto-dismisses after 3s

**Canvas History Panel (optional sidebar):**
- Chronological list of operations
- User avatar + action + component + timestamp
- Click entry → highlight the affected component

### Changes to Existing Client Code

**`web/js/canvas.js` (or equivalent):**
- All outgoing ops include `roomId` and `opId`
- Incoming `canvas:op` frames: apply + show attribution (who changed what)
- Handle `op:ack` for optimistic updates (apply locally, confirm from server)
- Handle `canvas:snapshot` for full state replacement (on join or slow-client recovery)

**`web/js/ws.js` (WebSocket handler):**
- Send `room:join` after auth
- Send `presence:heartbeat` on interval (10s) with cursor position
- Handle `presence:*` frames → update presence bar
- Handle `flow:slow` → reduce heartbeat frequency

**LiveComponent base class:**
- `onFocusedByOther(userId, displayName, color)` — show focus ring
- `onBlurredByOther(userId)` — remove focus ring
- `onConflict(theirOp, myPendingOp)` — flash orange, show toast

## Implementation Plan

### Phase A: Room Infrastructure (2-3 sessions)

**Goal:** Rooms exist, users can create/join/leave, state is per-room.

1. Implement `room-manager.js` — CRUD for rooms, persistence to `.scratchy-data/rooms/`
2. Implement `room-state.js` — wraps SurfaceState with room metadata
3. Add `room:*` handlers to `protocol-router.js`
4. Migrate `serve.js` from global canvas state to `RoomManager`
5. Auto-create personal room for each user (migration: copy existing `.canvas-state.json`)
6. Client: add `room:join` on connect, room switcher UI (minimal)

**Milestone:** Multiple rooms work, but only one user per room. Existing functionality preserved.

### Phase B: Multi-User Broadcast (1-2 sessions)

**Goal:** Multiple users in the same room see each other's changes.

1. Implement `broadcast.js` — room-scoped broadcast with user context
2. Add `userId` + `displayName` to all outgoing `canvas:op` frames
3. Add `opId` generation (client) and `op:ack` responses (server)
4. Implement `permission-gate.js` — check access on every operation
5. Client: handle `canvas:op` from other users, apply to local state

**Milestone:** Two browser tabs in the same room see each other's edits in real-time.

### Phase C: Presence (1 session)

**Goal:** Users see who's online and what they're doing.

1. Implement `presence-tracker.js` — heartbeat handling, timeout, cursor aggregation
2. Add `presence:*` frame handlers
3. Client: presence bar UI, avatar colors, online indicators
4. Client: send `presence:heartbeat` with cursor/focus data
5. Client: component focus ring when another user is editing

**Milestone:** Presence bar shows online users. Focus indicators work.

### Phase D: Conflict Handling & Op Log (1-2 sessions)

**Goal:** Conflicts are visible and manageable. Operations are logged.

1. Implement `op-log.js` — append-only log with rotation
2. Compute inverse operations on apply (for undo)
3. Add conflict detection: if incoming op affects a component with a pending local op, show conflict toast
4. Client: conflict flash animation, toast notifications
5. Client: canvas history panel (read-only op log viewer)

**Milestone:** Users see when their changes are overwritten. Op log is inspectable.

### Phase E: Undo/Redo (1 session)

**Goal:** Per-user undo with awareness of other users' changes.

1. Server: maintain per-user undo/redo stacks per room
2. Add `canvas:undo` and `canvas:redo` handlers
3. Stale entry detection (another user modified the same component)
4. Client: Ctrl+Z / Ctrl+Shift+Z sends undo/redo messages
5. Client: stale undo confirmation dialog

**Milestone:** Undo works per-user without breaking other users' state.

### Phase F: Room Management UI (1 session)

**Goal:** Full room management experience.

1. Room creation dialog (name, default access, description)
2. Room settings panel (rename, change permissions, delete)
3. Invite flow: generate invite link, copy to clipboard
4. Participant management: view members, change roles, kick
5. Public room toggle (for shared dashboards)

**Milestone:** Non-technical users can create and manage collaborative rooms.

### Phase G: Polish & Performance (1 session)

**Goal:** Production-ready performance and UX.

1. Implement broadcast throttling (adaptive based on op rate)
2. Slow-client detection + snapshot recovery
3. Room unloading (idle rooms serialized to disk)
4. Stress test: 10 concurrent users, 100 ops/sec
5. UX polish: smooth animations, cursor interpolation, accessible tooltips

**Milestone:** System handles real-world load gracefully.

### Estimated Effort

| Phase | Sessions | Description |
|-------|----------|-------------|
| A: Room Infrastructure | 2-3 | Rooms, persistence, migration |
| B: Multi-User Broadcast | 1-2 | Real-time sync, permissions |
| C: Presence | 1 | Online indicators, cursors, focus |
| D: Conflict & Op Log | 1-2 | Conflict UX, operation history |
| E: Undo/Redo | 1 | Per-user undo with conflict awareness |
| F: Room Management UI | 1 | Create, invite, configure rooms |
| G: Polish & Performance | 1 | Throttling, slow clients, stress test |
| **Total** | **8-11** | |

## Open Questions

1. **Agent presence** — Does the agent appear as a "user" in the presence bar? It's technically a participant that pushes canvas ops. Leaning yes, with a bot avatar/badge.

2. **Maximum participants per room** — What's the upper bound? 5? 20? 100? Affects broadcast architecture. Recommendation: start with 20 (matches `MAX_SURFACES`), revisit after stress testing.

3. **Room persistence vs ephemeral** — Should there be "temporary" rooms that auto-delete after everyone leaves? Useful for ad-hoc sessions. Proposal: `ttl` field in room config (null = permanent, number = seconds after last participant leaves).

4. **Canvas snapshots for reconnection** — When a user reconnects after brief disconnect, should they get a full snapshot or a delta since their last `op:ack`? Delta is more efficient but adds complexity. Recommendation: start with full snapshot, optimize later with delta if needed.

5. **Cross-room component sharing** — Can a component (e.g., a gauge) appear in multiple rooms, synced? This is powerful for dashboards but architecturally complex. Recommendation: defer to a future phase. For now, components belong to exactly one room.

6. **Agent multi-room** — Can the agent push to multiple rooms simultaneously? Currently the agent streams to one canvas. Need to define how `scratchy-canvas` blocks target a specific room. Proposal: `{"op":"upsert","room":"room_dashboard-prod","id":"..."}` — if no room specified, defaults to the active room of the requesting user.

7. **Audit logging** — Should permission changes and room deletions be logged to a separate audit trail (beyond the op log)? Important for compliance in team settings.

8. **End-to-end encryption** — For sensitive collaborative sessions, should canvas state be E2E encrypted (server can't read it)? Major complexity increase. Recommendation: defer, rely on transport encryption (WSS) and server-side access control for now.

9. **Mobile UX** — Presence bar and multi-user cursors on small screens. Need responsive design for the collaboration UI. How do we show 5 avatars + room name in a 375px-wide header?

10. **Rate limiting per user** — Phase 19 sets up per-user rate limits. How do collaborative canvas ops count? Each op from each user counts individually? Or room-level aggregate limits? Recommendation: per-user limits (prevents one user from flooding a room), with a higher ceiling for canvas ops vs chat messages.
