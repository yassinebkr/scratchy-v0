# Scratchy Widget Development Reference

> **Last updated:** 2026-02-23
>
> This document is the canonical reference for building widgets in Scratchy. If you're an AI sub-agent tasked with creating a new widget, this is everything you need.

---

## Quick Reference

| Concept | Summary |
|---|---|
| **What is a widget?** | A standalone mini-app with its own server-side logic, state, and UI. The AI agent only triggers it. |
| **Architecture** | Smart components, dumb agent. Widget handles everything; agent just configures and triggers. |
| **Routing** | Action prefix in `serve.js` → handler function. e.g., `todo-*` → `handleTodo()` |
| **Handler signature** | `function handleMyWidget(action, context, ws, userId)` |
| **Output mechanism** | Push canvas ops via `ws.send(JSON.stringify({ type: 'canvas', ops: [...] }))` |
| **State storage** | `.scratchy-data/widget-state/{userId}/mywidget.json` |
| **OAuth (Google)** | Shared tokens at `.scratchy-data/widget-state/{userId}/google-tokens.json` |
| **Live updates** | `setInterval` + `patch` ops + `ws.on('close', cleanup)` |
| **Deployment** | `node -c serve.js` to syntax-check, then `systemctl --user restart scratchy` |
| **Variable declarations** | Use `let` for `action` and `context` — handlers often reassign them |

### New Widget Checklist

```
1. [ ] Choose action prefix (e.g., `todo-`)
2. [ ] Add route in serve.js:  if (action.startsWith('todo-')) return handleTodo(...)
3. [ ] Implement handler function with switch/case per action
4. [ ] Define state file path: .scratchy-data/widget-state/{userId}/todo.json
5. [ ] Push canvas ops via ws.send() for each action
6. [ ] (Optional) Add LiveComponents in web/js/
7. [ ] (Optional) Wire up OAuth if using Google/Spotify APIs
8. [ ] (Optional) Add setInterval polling for live data
9. [ ] Test: node -c serve.js
10. [ ] Deploy: systemctl --user restart scratchy
```

---

## Table of Contents

1. [Architecture Principle](#architecture-principle)
2. [How Widget Routing Works](#how-widget-routing-works)
3. [The Widget Handler Pattern](#the-widget-handler-pattern)
4. [Canvas Ops — Pushing UI from the Server](#canvas-ops--pushing-ui-from-the-server)
5. [Per-User State Isolation](#per-user-state-isolation)
6. [The Button Context System](#the-button-context-system)
7. [Live Updates via Server-Side Polling](#live-updates-via-server-side-polling)
8. [OAuth Integration](#oauth-integration)
9. [Existing Widgets Reference](#existing-widgets-reference)
10. [Step-by-Step: Creating a New Widget](#step-by-step-creating-a-new-widget)
11. [Complete Example: Todo Widget](#complete-example-todo-widget)
12. [Key Rules and Pitfalls](#key-rules-and-pitfalls)
13. [Deployment](#deployment)

---

## Architecture Principle

**Smart components, dumb agent.**

This is the single most important concept in Scratchy widget development. Widgets are self-contained applications that own their own:

- **Server-side logic** — API calls, data processing, business rules
- **State management** — reading/writing per-user JSON files
- **UI rendering** — pushing canvas ops that the client renders
- **Real-time behavior** — polling, streaming, animations
- **Authentication** — OAuth flows, token refresh

The AI agent's role is minimal: it configures parameters and triggers widget actions. It does **not** act as a backend, proxy, or middleware for widget interactions. Once a widget is triggered, it runs independently.

**Why this matters:** If you find yourself writing logic where the agent intercepts every button click, fetches data, formats it, and sends it back — you're doing it wrong. That logic belongs in the widget handler.

---

## How Widget Routing Works

All widget actions flow through the WebSocket message handler in `serve.js`. When a message arrives with `type: 'chat'` and an `action` field, the server routes it by action prefix:

```js
// Simplified routing flow in serve.js
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'chat' && msg.action) {
    let action = msg.action;
    let context = msg.context || {};

    // Route by prefix
    if (action.startsWith('sn-'))        return handleStandardNotes(action, context, ws, userId);
    if (action.startsWith('cal-'))       return handleCalendar(action, context, ws, userId);
    if (action.startsWith('mail-'))      return handleEmail(action, context, ws, userId);
    if (action.startsWith('spotify-'))   return handleSpotify(action, context, ws, userId);
    if (action.startsWith('youtube-'))   return handleYouTube(action, context, ws, userId);
    if (action.startsWith('admin-'))     return handleAdmin(action, context, ws, userId);
    if (action.startsWith('analytics-')) return handleAnalytics(action, context, ws, userId);

    // No prefix match → forward to AI gateway
    forwardToGateway(msg, ws, userId);
  }
});
```

### Key points about routing:

- **Prefix-based dispatch.** Each widget owns an action prefix (e.g., `cal-`, `mail-`, `admin-`). All actions starting with that prefix route to the same handler function.
- **Fall-through to AI gateway.** If no prefix matches, the message is forwarded to the AI gateway for natural language processing. This is the *only* fallback — widget actions must never fall through here.
- **Use `let`, not `const`.** The `action` and `context` variables are declared with `let` because handlers frequently reassign them. Using `const` will cause runtime errors. This has been a real bug source.
- **Context is optional.** `msg.context` may be `undefined`, so always default to `{}`.

### Choosing an action prefix

When creating a new widget, pick a short, unique prefix that won't collide with existing ones:

| Prefix | Widget |
|---|---|
| `sn-` | Standard Notes |
| `cal-` | Google Calendar |
| `mail-` | Email / Gmail |
| `spotify-` | Spotify |
| `youtube-` | YouTube |
| `admin-` | Admin Dashboard |
| `analytics-` | Analytics |

Convention: lowercase, short, hyphen-terminated. Examples for new widgets: `todo-`, `weather-`, `chat-`, `files-`.

---

## The Widget Handler Pattern

Every widget handler follows the same structure:

```js
function handleMyWidget(action, context, ws, userId) {
  switch (action) {
    case 'mywidget-list':
      // 1. Read state or call APIs
      // 2. Build canvas ops
      // 3. Push to client via ws.send()
      break;

    case 'mywidget-create':
      // ...
      break;

    case 'mywidget-delete':
      // ...
      break;
  }
}
```

### The four parameters

| Parameter | Type | Description |
|---|---|---|
| `action` | `string` | The full action string, e.g., `'cal-month'`, `'admin-users'` |
| `context` | `object` | Arbitrary JSON payload from the client (button context, form data, etc.) |
| `ws` | `WebSocket` | The active WebSocket connection to push responses back to the client |
| `userId` | `string` | The authenticated user's ID, e.g., `'usr_admin'`, `'usr_iyad'` |

### What happens inside a handler

1. **Read state** — Load the user's data from their state file (e.g., `notes.json`, `todo.json`)
2. **Call external APIs** — If the widget integrates with Google, Spotify, etc., make API calls here
3. **Build canvas ops** — Construct the array of operations that describe the UI to render
4. **Push via WebSocket** — Send the ops to the client with `ws.send(JSON.stringify({ type: 'canvas', ops }))`

### Async handlers

Most handlers need to be `async` because they read files or call APIs:

```js
async function handleTodo(action, context, ws, userId) {
  switch (action) {
    case 'todo-list': {
      const todos = await readUserState(userId, 'todo.json');
      const ops = buildTodoListOps(todos);
      ws.send(JSON.stringify({ type: 'canvas', ops }));
      break;
    }
  }
}
```

---

## Canvas Ops — Pushing UI from the Server

Widgets communicate UI changes by pushing **canvas ops** — an array of operations that tell the client what to render, update, or remove.

### Op types

#### `upsert` — Create or replace a component

Creates a new component or fully replaces an existing one with the same `id`.

```js
{
  op: 'upsert',
  id: 'todo-list',           // Unique component ID
  type: 'list',              // Component type (LiveComponent name)
  data: {                    // Component-specific data
    items: [
      { id: '1', text: 'Buy groceries', done: false },
      { id: '2', text: 'Write docs', done: true }
    ]
  }
}
```

#### `patch` — Update an existing component

Updates specific fields of an existing component without replacing it entirely. Ideal for live updates.

```js
{
  op: 'patch',
  id: 'todo-list',
  data: {
    items: [/* updated list */]
  }
}
```

### Sending ops

Always wrap ops in the standard envelope:

```js
ws.send(JSON.stringify({
  type: 'canvas',
  ops: [
    { op: 'upsert', id: 'my-component', type: 'some-type', data: { ... } },
    { op: 'patch', id: 'other-component', data: { ... } }
  ]
}));
```

You can send multiple ops in a single message. The client processes them in order.

### Component IDs

Component IDs should be:
- **Prefixed with the widget name** to avoid collisions: `cal-grid`, `admin-cpu`, `todo-list`
- **Stable** across re-renders so `patch` ops target the right component
- **Unique** within the canvas at any given time

### Available component types

Widgets use the same component types as AI-generated canvas blocks. Notable ones used by existing widgets:

- `month-calendar` — Calendar month grid with event dots (used by Calendar widget)
- `media-list` — List of media items with thumbnails (used by YouTube, Spotify)
- `player` — Audio/video player (used by YouTube, Spotify)
- `carousel` — Horizontal scrolling card list (used by Spotify)
- `link-card` — Clickable card with URL (used for OAuth prompts)
- `buttons` — Interactive button group (used by Admin, Notes)
- Standard types: `list`, `table`, `text`, `code`, `image`, `form`, etc.

---

## Per-User State Isolation

Every user's widget data is stored in an isolated directory:

```
.scratchy-data/widget-state/
├── usr_admin/
│   ├── google-tokens.json
│   ├── notes.json
│   └── preferences.json
├── usr_iyad/
│   └── google-tokens.json
└── usr_newuser/
    └── (created on first widget use)
```

### State file conventions

- **Path pattern:** `.scratchy-data/widget-state/{userId}/{filename}.json`
- **One file per widget** is typical: `notes.json`, `todo.json`, `preferences.json`
- **Shared auth tokens** have standard names: `google-tokens.json` for Google OAuth
- **Create on first use** — don't assume the file exists; handle `ENOENT` gracefully
- **Always read-then-write** — read current state, modify, write back (no blind overwrites)

### Reading and writing state

```js
const fs = require('fs').promises;
const path = require('path');

const STATE_DIR = '.scratchy-data/widget-state';

async function readUserState(userId, filename) {
  const filePath = path.join(STATE_DIR, userId, filename);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null; // File doesn't exist yet
    throw e;
  }
}

async function writeUserState(userId, filename, data) {
  const dirPath = path.join(STATE_DIR, userId);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(
    path.join(dirPath, filename),
    JSON.stringify(data, null, 2)
  );
}
```

### Security

- **Never cross user boundaries.** A widget handler receives `userId` — only read/write that user's state directory.
- **Admin enforcement.** The `admin-*` widget explicitly checks for admin role and blocks non-admin users. Any widget with privileged actions must do the same.

---

## The Button Context System

When a widget renders interactive buttons, those buttons carry both an **action** and a **context** payload. This is how widgets pass parameters through user clicks.

### HTML structure

```html
<button
  data-sui-action="admin-user-detail"
  data-sui-context='{"userId":"usr_abc"}'>
  View User
</button>
```

### Client-side behavior

When the user clicks the button, the client:
1. Reads `data-sui-action` → the action to trigger
2. Reads `data-sui-context` → parses JSON into the context object
3. Sends to server:

```js
{
  type: 'chat',
  action: 'admin-user-detail',
  context: { userId: 'usr_abc' }
}
```

### Server-side handling

The handler receives the context as its second parameter:

```js
function handleAdmin(action, context, ws, userId) {
  switch (action) {
    case 'admin-user-detail':
      const targetUser = context.userId; // 'usr_abc'
      const details = await getUserDetails(targetUser);
      // ... push canvas ops
      break;
  }
}
```

### Important: Always include context in button ops

When building canvas ops that contain buttons, always include the `data-sui-context` attribute. Without it, the server receives an empty context object and actions that depend on parameters (like user IDs, item IDs, page numbers) will fail silently.

**Historical bug:** The buttons component originally never stored context data. This caused all admin actions requiring a `userId` parameter to fail. The fix was adding the `data-sui-context` JSON attribute. Don't repeat this mistake — always wire up context.

---

## Live Updates via Server-Side Polling

Widgets that display real-time data (system monitors, live feeds, etc.) use server-side polling with `setInterval`. The pattern:

```js
function startLiveWidget(ws, userId) {
  // Push initial state
  const initialOps = buildInitialOps();
  ws.send(JSON.stringify({ type: 'canvas', ops: initialOps }));

  // Start polling loop
  const interval = setInterval(async () => {
    const freshData = await fetchLatestData();
    ws.send(JSON.stringify({
      type: 'canvas',
      ops: [
        { op: 'patch', id: 'live-widget-data', data: freshData }
      ]
    }));
  }, 3000); // 3-second interval

  // CRITICAL: Clean up on disconnect
  ws.on('close', () => clearInterval(interval));
}
```

### Rules for live updates

1. **Always clean up.** Register a `ws.on('close')` handler that clears the interval. Without this, you leak intervals and the server will eventually crash.
2. **Use `patch`, not `upsert`.** For incremental updates, `patch` is more efficient — it only updates changed fields.
3. **Choose appropriate intervals.** 3 seconds is good for system monitors. For less urgent data, use 10-30 seconds to reduce load.
4. **Push initial state immediately.** Don't make the user wait for the first interval tick. Send the first render right away, then start polling.

### Real-world example: Admin Monitor

The admin dashboard's real-time monitor pushes CPU, RAM, and disk usage every 3 seconds:

```js
function startAdminMonitor(ws) {
  const interval = setInterval(async () => {
    const stats = {
      cpu: getCpuUsage(),
      ram: getRamUsage(),
      disk: getDiskUsage()
    };
    ws.send(JSON.stringify({
      type: 'canvas',
      ops: [
        { op: 'patch', id: 'admin-cpu', data: { value: stats.cpu } },
        { op: 'patch', id: 'admin-ram', data: { value: stats.ram } }
      ]
    }));
  }, 3000);

  ws.on('close', () => clearInterval(interval));
}
```

---

## OAuth Integration

### Google OAuth (Shared)

Calendar, Gmail, and YouTube widgets share a single Google OAuth flow. If your widget needs Google APIs, reuse this flow.

#### Token storage

Tokens are stored per-user at:
```
.scratchy-data/widget-state/{userId}/google-tokens.json
```

#### The flow

1. **Check for token.** Before making a Google API call, read `google-tokens.json` for the user.
2. **No token → prompt.** Push a `link-card` component with the OAuth URL. Use `target: "_self"` for same-window navigation.
3. **User authenticates.** Google consent screen → redirect to `/api/auth/google/callback`.
4. **Callback saves tokens.** The callback handler saves the tokens to the user's state directory and redirects back to Scratchy with `?oauth=success`.
5. **Auto-retry.** The client detects the `oauth=success` query parameter and automatically re-triggers the original widget action.
6. **Page routing.** The OAuth state parameter encodes whether the user came from the onboarding flow or the main app, so the redirect lands on the correct page.
7. **Automatic refresh.** If a token is expired, the widget refreshes it transparently before making the API call.

#### Handling missing scopes

YouTube requires additional scopes beyond what Calendar/Gmail need. If a user authorized Calendar but not YouTube, the YouTube widget:
- Detects the missing scope
- Shows a re-consent screen with a direct OAuth URL that includes the YouTube scope
- User re-authorizes → new token includes all scopes

#### Public API fallback (YouTube-specific)

YouTube's `_publicApiCall()` implements graceful degradation:
1. Try with OAuth token (full access)
2. Fall back to API key (public data only)
3. Fall back to connect screen (prompt user to authorize)

### Spotify OAuth (Separate)

Spotify uses its own OAuth flow, separate from Google. Tokens are stored in a separate file. If you need Spotify integration, follow the same pattern but with Spotify's OAuth endpoints.

### Adding OAuth for a new provider

If your widget needs a new OAuth provider:
1. Add OAuth endpoints in `serve.js` (`/api/auth/{provider}` and `/api/auth/{provider}/callback`)
2. Store tokens at `.scratchy-data/widget-state/{userId}/{provider}-tokens.json`
3. Implement token refresh logic
4. Use the `link-card` → callback → auto-retry pattern described above

---

## Existing Widgets Reference

### Standard Notes (`sn-*`)

| Action | Description |
|---|---|
| `sn-list` | List all notes for the user |
| `sn-view` | View a single note (context: `{ noteId }`) |
| `sn-create` | Show create note form |
| `sn-edit` | Show edit form for existing note (context: `{ noteId }`) |
| `sn-delete` | Delete a note (context: `{ noteId }`) |
| `sn-save` | Save note content (context: `{ noteId, title, content }`) |

- **State:** `.scratchy-data/widget-state/{userId}/notes.json`
- **Features:** Richtext editor with Edit/Preview tabs, markdown rendering

### Google Calendar (`cal-*`)

| Action | Description |
|---|---|
| `cal-month` | Month grid view (context: `{ month }`) |
| `cal-today` | Day timeline view |
| `cal-create` | Create event form |
| `cal-edit` | Edit event (context: `{ eventId }`) |
| `cal-delete` | Delete event (context: `{ eventId }`) |
| `cal-navigate` | Navigate to different month (context: `{ direction }`) |

- **LiveComponent:** `month-calendar` (33rd component type)
- **OAuth:** Shared Google tokens
- **Features:** Month grid with event dots, day timeline, Events + Tasks CRUD

### Email / Gmail (`mail-*`)

| Action | Description |
|---|---|
| `mail-inbox` | Show inbox |
| `mail-read` | Read single email (context: `{ messageId }`) |
| `mail-compose` | Open compose form |
| `mail-send` | Send email (context: `{ to, subject, body }`) |
| `mail-compose-invite` | Compose calendar invite email |

- **OAuth:** Shared Google tokens
- **Security:** Dual send system — Gmail for user-composed messages (widget UI only), Resend for agent-composed messages. **The agent is blocked from sending as the user via Gmail.**
- **Attachments:** Served via `/api/attachment` endpoint using XHR+blob

### YouTube (`youtube-*`)

| Action | Auth Required | Description |
|---|---|---|
| `youtube-search` | No | Search videos |
| `youtube-trending` | No | Trending videos |
| `youtube-music` | No | Music trending |
| `youtube-playlists` | Yes | User's playlists |
| `youtube-liked` | Yes | Liked videos |
| `youtube-subs` | Yes | Subscriptions |
| `youtube-library` | Yes | Full library |

- **LiveComponents:** `media-list`, `player`
- **Fallback:** `_publicApiCall()` — OAuth → API key → connect screen
- **OAuth:** Shared Google tokens (with YouTube scope)

### Spotify (`spotify-*`)

- **Features:** Now Playing, search, playlists
- **LiveComponents:** `player`, `media-list`, `carousel`
- **OAuth:** Separate Spotify OAuth flow

### Admin (`admin-*`)

| Action | Description |
|---|---|
| `admin-dashboard` | Overview dashboard |
| `admin-monitor` | Real-time system monitor (CPU/RAM/disk, 3s polling) |
| `admin-quotas` | Usage quotas |
| `admin-providers` | AI provider status |
| `admin-users` | User list |
| `admin-user-detail` | User detail view (context: `{ userId }`) |

- **Security:** Blocked for non-admin users — handler checks role before processing
- **Features:** User management (list, detail, capability toggles, invite pipeline), real-time monitor with WebSocket polling

---

## Step-by-Step: Creating a New Widget

### Step 1: Choose an action prefix

Pick a short, descriptive, unique prefix. Check the routing table in `serve.js` to avoid collisions.

```
todo-     ✓ Available
task-     ✓ Available
sn-       ✗ Taken (Standard Notes)
```

### Step 2: Add the route in `serve.js`

Add a new `if` block in the routing section, **before** the `forwardToGateway` fallback:

```js
if (action.startsWith('todo-')) return handleTodo(action, context, ws, userId);
```

### Step 3: Implement the handler function

Write the handler function in `serve.js` (or in a separate module that you `require()`):

```js
async function handleTodo(action, context, ws, userId) {
  switch (action) {
    case 'todo-list': {
      const todos = await readUserState(userId, 'todo.json') || { items: [] };
      ws.send(JSON.stringify({
        type: 'canvas',
        ops: [{
          op: 'upsert',
          id: 'todo-list',
          type: 'list',
          data: { items: todos.items }
        }]
      }));
      break;
    }

    case 'todo-add': {
      const todos = await readUserState(userId, 'todo.json') || { items: [] };
      todos.items.push({
        id: Date.now().toString(),
        text: context.text,
        done: false,
        createdAt: new Date().toISOString()
      });
      await writeUserState(userId, 'todo.json', todos);
      // Re-render the list
      return handleTodo('todo-list', {}, ws, userId);
    }

    case 'todo-toggle': {
      const todos = await readUserState(userId, 'todo.json') || { items: [] };
      const item = todos.items.find(t => t.id === context.itemId);
      if (item) item.done = !item.done;
      await writeUserState(userId, 'todo.json', todos);
      return handleTodo('todo-list', {}, ws, userId);
    }

    case 'todo-delete': {
      const todos = await readUserState(userId, 'todo.json') || { items: [] };
      todos.items = todos.items.filter(t => t.id !== context.itemId);
      await writeUserState(userId, 'todo.json', todos);
      return handleTodo('todo-list', {}, ws, userId);
    }
  }
}
```

### Step 4: Define state storage

Use the standard state path:

```
.scratchy-data/widget-state/{userId}/todo.json
```

Structure the JSON however your widget needs. Example:

```json
{
  "items": [
    { "id": "1708700000000", "text": "Buy groceries", "done": false, "createdAt": "2026-02-23T10:00:00Z" },
    { "id": "1708700100000", "text": "Write docs", "done": true, "createdAt": "2026-02-23T10:05:00Z" }
  ]
}
```

### Step 5: Add interactive buttons with context

When rendering items that need actions (toggle, delete, edit), include button context:

```js
// In your ops builder, items would reference actions like:
// data-sui-action="todo-toggle" data-sui-context='{"itemId":"123"}'
// data-sui-action="todo-delete" data-sui-context='{"itemId":"123"}'
```

### Step 6 (Optional): Add LiveComponents

If the built-in component types don't cover your needs:

1. Create a new component file in `web/js/`
2. Register it by monkey-patching the LiveComponents registry
3. Reference the new type in your canvas ops

### Step 7 (Optional): Add live updates

If your widget shows real-time data, add polling:

```js
case 'todo-live': {
  startTodoPolling(ws, userId);
  break;
}

function startTodoPolling(ws, userId) {
  const interval = setInterval(async () => {
    const todos = await readUserState(userId, 'todo.json') || { items: [] };
    ws.send(JSON.stringify({
      type: 'canvas',
      ops: [{ op: 'patch', id: 'todo-list', data: { items: todos.items } }]
    }));
  }, 5000);

  ws.on('close', () => clearInterval(interval));
}
```

---

## Complete Example: Todo Widget

Here's a full, minimal widget implementation you can use as a starting template:

```js
// ─── Todo Widget Handler ───────────────────────────────────────────
// Prefix: todo-
// State:  .scratchy-data/widget-state/{userId}/todo.json
// Actions: todo-list, todo-add, todo-toggle, todo-delete

async function handleTodo(action, context, ws, userId) {
  const STATE_FILE = 'todo.json';

  async function getTodos() {
    return (await readUserState(userId, STATE_FILE)) || { items: [] };
  }

  async function saveTodos(todos) {
    await writeUserState(userId, STATE_FILE, todos);
  }

  function pushList(todos) {
    ws.send(JSON.stringify({
      type: 'canvas',
      ops: [{
        op: 'upsert',
        id: 'todo-list',
        type: 'list',
        data: {
          title: 'My Todos',
          items: todos.items.map(t => ({
            id: t.id,
            text: t.text,
            done: t.done,
            actions: [
              { label: t.done ? 'Undo' : 'Done', action: 'todo-toggle', context: { itemId: t.id } },
              { label: 'Delete', action: 'todo-delete', context: { itemId: t.id } }
            ]
          }))
        }
      }]
    }));
  }

  switch (action) {
    case 'todo-list': {
      const todos = await getTodos();
      pushList(todos);
      break;
    }

    case 'todo-add': {
      if (!context.text) return; // Guard against empty adds
      const todos = await getTodos();
      todos.items.push({
        id: Date.now().toString(),
        text: context.text,
        done: false,
        createdAt: new Date().toISOString()
      });
      await saveTodos(todos);
      pushList(todos);
      break;
    }

    case 'todo-toggle': {
      if (!context.itemId) return;
      const todos = await getTodos();
      const item = todos.items.find(t => t.id === context.itemId);
      if (item) {
        item.done = !item.done;
        await saveTodos(todos);
      }
      pushList(todos);
      break;
    }

    case 'todo-delete': {
      if (!context.itemId) return;
      const todos = await getTodos();
      todos.items = todos.items.filter(t => t.id !== context.itemId);
      await saveTodos(todos);
      pushList(todos);
      break;
    }

    default:
      console.warn(`[todo] Unknown action: ${action}`);
  }
}
```

And the route in the WebSocket handler:

```js
if (action.startsWith('todo-')) return handleTodo(action, context, ws, userId);
```

---

## Key Rules and Pitfalls

### The Cardinal Rules

1. **Widgets are standalone apps.** They never forward to the agent/gateway as a fallback. If an action hits your handler, your handler resolves it — period.

2. **Widget logic runs server-side in `serve.js`.** Not in the client. Not in the agent. All API calls, state mutations, and business logic live in the handler.

3. **Never call APIs directly from the agent.** If the agent needs to show calendar events, it triggers `cal-month` — it does not call the Google Calendar API itself.

4. **Always use `let` for `action` and `context`.** Widget handlers frequently reassign these variables (e.g., after normalizing an action or merging default context). Using `const` causes `TypeError: Assignment to constant variable` at runtime.

### Common Pitfalls

| Pitfall | Fix |
|---|---|
| Using `const` for action/context | Use `let` — handlers reassign them |
| Forgetting `ws.on('close')` cleanup | Always clear intervals on disconnect |
| Missing `data-sui-context` on buttons | Include context JSON on every interactive button |
| Cross-user state access | Only read/write the `userId` directory you received |
| Forgetting to handle missing state files | Return default value (e.g., `null`, `{ items: [] }`) on `ENOENT` |
| Syntax errors crashing the server | Always run `node -c serve.js` before deploying |
| Not restarting after changes | Changes require `systemctl --user restart scratchy` |
| Making the agent a backend | Widget owns its logic — the agent just triggers actions |

### Security Considerations

- **Admin-only actions:** Always check the user's role before processing privileged actions. The admin widget blocks non-admin users explicitly.
- **Gmail send security:** The agent is blocked from sending emails as the user via Gmail. Only the user can compose and send via the widget UI. Agent-composed emails use Resend (a separate sending service).
- **OAuth tokens are sensitive.** Never expose them in canvas ops or log them.

---

## Deployment

### Syntax check

Always validate before deploying:

```bash
node -c serve.js
```

This catches syntax errors without running the server. If it exits silently, the syntax is valid.

### Restart the service

Scratchy runs as a systemd user service. After making changes:

```bash
systemctl --user restart scratchy
```

### Verify

After restarting, test your widget by triggering its actions through the Scratchy UI. Check the journal for errors:

```bash
journalctl --user -u scratchy -f
```

---

*This document covers everything needed to build a Scratchy widget. When in doubt, follow the patterns of existing widgets — especially Standard Notes (`sn-*`) for CRUD operations and Admin (`admin-*`) for live updates and security enforcement.*
