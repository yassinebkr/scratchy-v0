# Phase: Push Notifications + Offline Mode

## Overview

Give Scratchy users two superpowers: **stay informed** when the tab is closed, and **keep working** when the network drops.

Today, if you close the Scratchy tab and your agent finishes a 10-minute task, you have no idea until you come back and check. And if you're on a train with spotty wifi, the whole app is dead.

**Push Notifications** solve the first problem — the agent can tap you on the shoulder (desktop notification, phone buzz) whenever something important happens. **Offline Mode** solves the second — cached assets load instantly, outbound messages queue up, and everything syncs when the connection returns.

Together these turn Scratchy from a "tab you keep open" into a proper app that lives on your device.

## Current State

```
Browser → index.html (network-only, no caching)
       → WebSocket to gateway (breaks on disconnect, no reconnect queue)
       → manifest.json exists (PWA installable) but no service worker logic
       → No push subscription, no offline support
```

- `manifest.json` is set up — PWA install works on Android/desktop
- No service worker registered (no `sw.js` file)
- No caching strategy — every page load hits the network
- WebSocket connection has no offline queue — messages typed while offline are lost
- No push notification infrastructure on server or client

## Target Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              Scratchy Server (serve.js)      │
                    │                                              │
                    │  Push Service                                │
  Gateway ────────►│  ├── POST /api/push/subscribe                │
  Events           │  ├── POST /api/push/unsubscribe              │
  (WS)             │  ├── subscriptions.json                      │──► Web Push API
                    │  └── event → push pipeline                  │    (FCM / Mozilla)
                    │       ├── agent.run.complete                │
                    │       ├── agent.message                     │
                    │       ├── calendar.reminder                 │
                    │       └── widget.alert                      │
                    │                                              │
                    │  Static Assets                               │
                    │  └── Cache-Control headers for SW            │
                    └──────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────┐
                    │              Service Worker (sw.js)          │
                    │                                              │
                    │  Cache Manager                               │
                    │  ├── ASSET_CACHE (cache-first)              │
                    │  │   └── HTML, CSS, JS, icons, fonts        │
                    │  ├── API_CACHE (network-first)              │
                    │  │   └── /api/history, /api/config          │
                    │  └── offline-fallback.html                  │
                    │                                              │
                    │  Push Handler                                │
                    │  ├── self.addEventListener('push', ...)     │
                    │  └── self.addEventListener('notificationclick') │
                    │                                              │
                    │  Background Sync                             │
                    │  └── sync tag: 'message-queue'              │
                    └──────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────┐
                    │              Client (browser)                │
                    │                                              │
                    │  Push Manager                                │
                    │  ├── Permission prompt flow                 │
                    │  ├── PushSubscription → server              │
                    │  └── Notification click → focus/navigate    │
                    │                                              │
                    │  Offline Queue (IndexedDB)                  │
                    │  ├── outbound-messages store                │
                    │  ├── pending-actions store                  │
                    │  └── auto-flush on reconnect                │
                    │                                              │
                    │  Connection Monitor                          │
                    │  ├── navigator.onLine + WS heartbeat        │
                    │  └── offline indicator UI                   │
                    └──────────────────────────────────────────────┘
```

## Service Worker Architecture

### Cache Strategies

**Cache-First (assets) — `ASSET_CACHE_V{n}`:**
- All files under `/css/`, `/js/`, `/icons/`, `/catalog/`
- `index.html`, `login.html`, `manifest.json`, `favicon.svg`
- Font files, images (`*.png`, `*.svg`, `*.woff2`)
- Versioned cache name (`ASSET_CACHE_V1`, `ASSET_CACHE_V2`, ...) — bump on deploy
- On SW activation: delete old cache versions, precache critical assets

**Network-First (API) — `API_CACHE`:**
- `/api/history` — cache last response, serve from cache when offline
- `/api/config` — same pattern
- TTL: stale responses served only when network unavailable
- Never cache auth endpoints (`/api/auth/*`)

**Network-Only (real-time):**
- WebSocket connections (handled outside SW fetch)
- `/api/push/*` endpoints
- `/api/tts/*` (voice synthesis)
- Form submissions

### Offline Fallback

When a navigation request fails and isn't in cache, serve `offline-fallback.html`:

```html
<!-- offline-fallback.html — minimal, cached during SW install -->
<div class="offline-screen">
  <h1>You're offline</h1>
  <p>Scratchy will reconnect automatically when your network returns.</p>
  <p>Messages you send will be queued and delivered when back online.</p>
  <button onclick="location.reload()">Try Again</button>
</div>
```

### Service Worker Lifecycle

```
Install  →  precache critical assets (app shell)
          →  cache offline-fallback.html
          →  self.skipWaiting()

Activate →  delete old ASSET_CACHE versions
          →  clients.claim()  (take control immediately)

Fetch    →  route to cache-first / network-first / network-only
          →  fallback to offline page on navigation failure

Push     →  parse payload → show notification
          →  badge update if supported

Sync     →  flush IndexedDB message queue via API
```

### Asset Precache List

```javascript
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/offline-fallback.html',
  '/manifest.json',
  '/favicon.svg',
  '/css/style.css',
  '/css/canvas.css',
  '/css/login.css',
  '/js/app.js',
  '/js/connection.js',
  '/js/messages.js',
  '/js/config.js',
  '/js/canvas-renderer.js',
  '/js/canvas-components.js',
  '/js/components.js',
  '/js/markdown.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];
```

## Web Push API

### VAPID Keys

VAPID (Voluntary Application Server Identification) keys authenticate push requests.

**Key generation (one-time setup):**
```bash
npx web-push generate-vapid-keys --json > .scratchy-data/vapid-keys.json
```

```json
{
  "publicKey": "BLz7...",
  "privateKey": "dGhp..."
}
```

- **Public key** — shared with the browser for `PushManager.subscribe()`
- **Private key** — used server-side to sign push requests, never exposed
- Store in `.scratchy-data/vapid-keys.json` (auto-generated on first run if missing)
- Environment override: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL`

### Subscription Management

**Client-side subscription flow:**
```javascript
// 1. Register service worker
const reg = await navigator.serviceWorker.register('/sw.js');

// 2. Request permission
const permission = await Notification.requestPermission();
if (permission !== 'granted') return;

// 3. Subscribe to push
const subscription = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
});

// 4. Send subscription to server
await fetch('/api/push/subscribe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ subscription })
});
```

**Server-side storage:**
```json
// .scratchy-data/push-subscriptions.json
{
  "subscriptions": [
    {
      "id": "sub_a1b2c3",
      "userId": "usr_abc123",
      "endpoint": "https://fcm.googleapis.com/fcm/send/...",
      "keys": {
        "p256dh": "BNc...",
        "auth": "tBH..."
      },
      "userAgent": "Chrome/120 (Linux)",
      "createdAt": "2026-02-22T08:00:00Z",
      "lastPushAt": null,
      "failCount": 0
    }
  ]
}
```

### Push Server Endpoint (serve.js)

```
POST /api/push/subscribe       — register new push subscription
POST /api/push/unsubscribe     — remove subscription (e.g., user disables)
GET  /api/push/vapid-key       — return public VAPID key (for client subscribe)
GET  /api/push/status          — subscription status for current user
POST /api/push/test            — send test notification (admin/debug)
```

### Notification Payloads

Standard JSON payload structure:

```json
{
  "type": "agent.message",
  "title": "Scratchy — New message",
  "body": "Your report is ready. 3 charts generated.",
  "icon": "/icons/icon-192.png",
  "badge": "/icons/badge-72.png",
  "tag": "agent-msg-1708588800",
  "data": {
    "url": "/",
    "sessionKey": "main:webchat:usr_abc123",
    "messageId": "msg_xyz",
    "timestamp": 1708588800
  },
  "actions": [
    { "action": "open", "title": "Open" },
    { "action": "dismiss", "title": "Dismiss" }
  ]
}
```

## Push Triggers

| Event | When | Title | Body (example) | Priority |
|-------|------|-------|-----------------|----------|
| `agent.run.complete` | Agent finishes a tool run / long task | "Task complete" | "File analysis done — 3 issues found" | High |
| `agent.message` | New chat message while tab is not focused | "New message" | First 120 chars of message text | Normal |
| `calendar.reminder` | Calendar event approaching (configured lead time) | "Upcoming: {event}" | "In 15 minutes — Team standup" | High |
| `widget.alert` | Widget raises an alert (e.g., monitoring threshold) | "Alert: {widget}" | Widget-defined message | Normal |
| `session.mention` | User mentioned in a shared session (future, Phase 19+) | "You were mentioned" | "{user} mentioned you in {session}" | Normal |

### Trigger Logic

**Do NOT send push when:**
- The user's tab is focused (check via `clients.matchAll()` on the server side, or track via WS heartbeat)
- The user has the notification for that `tag` already visible (browser handles dedup via `tag`)
- The subscription has failed 3+ times consecutively (mark as dead, stop retrying)
- The message was sent BY the user (don't notify yourself)

**Debouncing:**
- Multiple rapid `agent.message` events → batch into one notification: "3 new messages from your agent"
- Debounce window: 5 seconds
- After the window: send one consolidated notification

## Notification UI

### Format

```
┌──────────────────────────────────────────┐
│ 🐱 Scratchy — Task complete              │
│                                          │
│ Your weekly report has been generated.   │
│ 3 charts, 2 tables, 1 summary.          │
│                                          │
│              [Open]    [Dismiss]          │
└──────────────────────────────────────────┘
```

- **Icon:** Scratchy app icon (192×192)
- **Badge:** Monochrome badge icon (72×72, for Android status bar)
- **Title:** "Scratchy — {event type}" (keep short)
- **Body:** Max 120 chars, human-readable summary
- **Tag:** Dedup key per event type (e.g., `agent-msg-{timestamp}`)
- **Renotify:** `true` for same-tag updates (so user sees the update)

### Action Buttons

| Action | Behavior |
|--------|----------|
| `open` | Focus existing Scratchy tab or open new one, navigate to relevant context |
| `reply` | Open Scratchy with input focused (future: inline reply via notification) |
| `dismiss` | Close notification, no navigation |

### Notification Grouping (Android)

Use consistent `tag` prefixes for grouping:
- `agent-msg-*` → grouped under "Messages"
- `agent-task-*` → grouped under "Tasks"
- `calendar-*` → grouped under "Calendar"
- `widget-*` → grouped under "Alerts"

## Offline Mode

### Asset Caching

All files needed for the app shell are precached during SW installation:

```
Cache: ASSET_CACHE_V{version}
Strategy: Cache-first with network fallback

On install:
  → precache PRECACHE_ASSETS list (see above)
  → precache offline-fallback.html

On fetch (same-origin, non-API):
  → try cache match
  → if miss: fetch from network → put in cache → return
  → if network fails: serve offline-fallback.html (for navigations)

On activate:
  → delete all caches except current ASSET_CACHE_V{version} and API_CACHE
```

**Cache versioning:**
- `ASSET_CACHE_V1` bumped to `ASSET_CACHE_V2` on deploy
- Version number lives in `sw.js` as a const — changing it triggers a new SW install
- Old caches cleaned up during activation

### Message Queue (IndexedDB)

When the user is offline and types a message, queue it locally:

```javascript
// IndexedDB schema: 'scratchy-offline' database
//
// Store: 'outbound-messages'
// keyPath: 'id' (auto-generated UUID)
{
  "id": "queue_abc123",
  "type": "chat-message",
  "payload": {
    "text": "What's the status of the deployment?",
    "attachments": [],
    "sessionKey": "main:webchat:usr_abc123"
  },
  "createdAt": 1708588800000,
  "status": "pending",       // pending | sending | sent | failed
  "retryCount": 0
}

// Store: 'pending-actions'
// keyPath: 'id'
{
  "id": "action_def456",
  "type": "widget-action",
  "payload": {
    "widgetId": "email-compose",
    "action": "send",
    "fields": { "to": "...", "subject": "...", "body": "..." }
  },
  "createdAt": 1708588800000,
  "status": "pending"
}
```

### Auto-Sync on Reconnect

```
Connection restored (online event OR WS reconnect)
  │
  ├── 1. Re-establish WebSocket connection
  │
  ├── 2. Flush outbound-messages queue (oldest first)
  │   ├── For each: POST to gateway via WS
  │   ├── On success: mark 'sent', delete after 24h
  │   └── On failure: increment retryCount, retry with backoff
  │
  ├── 3. Flush pending-actions queue
  │   └── Same pattern as messages
  │
  ├── 4. Fetch missed messages from /api/history (since last known timestamp)
  │
  └── 5. Hide offline indicator
```

**Background Sync API (progressive enhancement):**
```javascript
// Register sync when queuing a message offline
await registration.sync.register('flush-message-queue');

// In SW: handle sync event
self.addEventListener('sync', event => {
  if (event.tag === 'flush-message-queue') {
    event.waitUntil(flushMessageQueue());
  }
});
```

Background Sync fires even if the tab is closed, as long as the SW is alive. Falls back to manual flush on reconnect for browsers that don't support it.

### Offline Indicator

```
┌─ Scratchy ──────────────────────────────────┐
│ ⚡ You're offline — messages will be queued  │  ← subtle top banner, amber
│                                              │
│  ...chat messages (cached + new queued)...   │
│                                              │
│  [Your message here]  [Send ⏳]              │  ← send button shows clock icon
└──────────────────────────────────────────────┘
```

- Banner appears when `navigator.onLine === false` OR WebSocket disconnects
- Banner disappears when connection is restored and queue is flushed
- Queued messages show a subtle "pending" indicator (clock icon, light opacity)
- Once delivered: pending indicator removed, message confirmed

## Backend Changes (serve.js)

### New Endpoints

```javascript
// ── Push Notification Endpoints ──

// Return VAPID public key for client subscription
// GET /api/push/vapid-key
// Response: { "publicKey": "BLz7..." }

// Register push subscription
// POST /api/push/subscribe
// Body: { "subscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } } }
// Response: { "ok": true, "id": "sub_a1b2c3" }

// Unsubscribe
// POST /api/push/unsubscribe
// Body: { "subscriptionId": "sub_a1b2c3" } OR { "endpoint": "https://..." }
// Response: { "ok": true }

// Get subscription status for current user
// GET /api/push/status
// Response: { "subscribed": true, "subscriptionCount": 2 }

// Send test notification (for debugging)
// POST /api/push/test
// Body: { "title": "Test", "body": "Hello from Scratchy" }
```

### Subscription Storage

```javascript
// lib/push/subscription-store.js
class SubscriptionStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'push-subscriptions.json');
  }

  async add(userId, subscription)     // → subscriptionId
  async remove(subscriptionId)        // → void
  async removeByEndpoint(endpoint)    // → void
  async getByUser(userId)             // → subscription[]
  async getAll()                      // → subscription[]
  async markFailed(subscriptionId)    // → void (increment failCount)
  async markSuccess(subscriptionId)   // → void (reset failCount, update lastPushAt)
  async pruneStale(maxFailCount = 3)  // → removed count
}
```

### Gateway Event → Push Pipeline

```
Gateway WebSocket
  │
  ├── message event received
  │   └── Is user's tab focused? (tracked via client heartbeat)
  │       ├── Yes → do nothing (user sees it live)
  │       └── No → queue push notification
  │
  ├── Push Dispatcher
  │   ├── Debounce window (5s) — batch rapid messages
  │   ├── Build notification payload (type, title, body, truncated)
  │   ├── Load user's push subscriptions
  │   └── For each subscription:
  │       ├── web-push.sendNotification(subscription, payload, vapidOptions)
  │       ├── On 201: markSuccess()
  │       ├── On 404/410 (expired): remove subscription
  │       └── On other error: markFailed(), retry once
  │
  └── Focus Tracker
      ├── Client sends 'focus' / 'blur' events over WS
      ├── Server maintains Map<userId, { focused: boolean, lastSeen: Date }>
      └── Consider "unfocused" after 30s of no heartbeat
```

### New Files

```
lib/push/
  subscription-store.js    — CRUD for push subscriptions
  push-dispatcher.js       — event → notification pipeline
  vapid.js                 — VAPID key management (generate/load)
  focus-tracker.js         — track which users have tab focused

web/
  sw.js                    — service worker (caching + push handler)
  offline-fallback.html    — offline page
```

### Dependencies

```json
{
  "web-push": "^3.6.x"
}
```

Single dependency. `web-push` handles VAPID signing, payload encryption (RFC 8291), and delivery to FCM/Mozilla push services.

## Client Changes

### Service Worker Registration

```javascript
// In app.js — register SW on load
if ('serviceWorker' in navigator) {
  const registration = await navigator.serviceWorker.register('/sw.js');
  console.log('[Scratchy] SW registered, scope:', registration.scope);

  // Check for updates periodically
  setInterval(() => registration.update(), 60 * 60 * 1000); // hourly
}
```

### Push Permission Flow

**When to ask:** Don't ask on first visit. Ask after the user has sent at least 3 messages (they're engaged), or when they explicitly click a "Enable notifications" toggle in settings.

```
User clicks "Enable notifications"
  │
  ├── Check: Notification.permission
  │   ├── 'granted' → subscribe silently
  │   ├── 'denied' → show "blocked" message with browser instructions
  │   └── 'default' → request permission
  │
  ├── Permission granted?
  │   ├── Yes → PushManager.subscribe() → POST /api/push/subscribe
  │   └── No → show subtle "you can enable later in settings" message
  │
  └── Store preference in localStorage: scratchy_push_enabled = true/false
```

**UI location:** Settings panel → "Notifications" toggle

### Notification Click Handling (in sw.js)

```javascript
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;     // 'open', 'reply', 'dismiss'
  const data = event.notification.data;

  if (action === 'dismiss') return;

  // Focus existing tab or open new one
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Try to focus an existing Scratchy tab
        for (const client of clientList) {
          if (client.url.includes(self.location.origin)) {
            client.focus();
            client.postMessage({
              type: 'notification-clicked',
              data: data
            });
            return;
          }
        }
        // No existing tab — open new one
        return clients.openWindow(data.url || '/');
      })
  );
});
```

### Offline Detection

```javascript
// lib/offline-manager.js (client-side)
class OfflineManager {
  constructor() {
    this.online = navigator.onLine;
    this.db = null;  // IndexedDB handle

    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
  }

  handleOffline() {
    this.online = false;
    this.showBanner('You\'re offline — messages will be queued');
    this.enableQueueMode();
  }

  handleOnline() {
    this.online = true;
    this.hideBanner();
    this.flushQueue();
  }

  async queueMessage(message) {
    // Store in IndexedDB 'outbound-messages' store
  }

  async flushQueue() {
    // Read all pending messages from IndexedDB
    // Send each via WebSocket (re-established)
    // Mark as sent / remove on success
  }
}
```

### Focus Tracking (for push suppression)

```javascript
// In app.js — report focus state to server
document.addEventListener('visibilitychange', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'focus',
      visible: !document.hidden
    }));
  }
});
```

## Security

| Threat | Mitigation |
|--------|-----------|
| Push payload interception | Payloads are encrypted end-to-end per Web Push spec (RFC 8291, ECDH + HKDF + AES-128-GCM). Only the browser can decrypt. |
| Sensitive data in push body | **Never include secrets, tokens, or full message content.** Body is a truncated summary. Full content requires opening the app (authenticated). |
| Unauthorized push subscription | Subscription endpoints require valid auth cookie (same as all Scratchy API routes). |
| Subscription replay / spoofing | VAPID signature authenticates the application server to the push service. Subscriptions are tied to the SW scope origin. |
| Stale/orphaned subscriptions | Prune subscriptions with 3+ consecutive failures (410 Gone = immediate removal). |
| DoS via push spam | Rate-limit push sends per user: max 30/hour. Debounce rapid events (5s window). |
| SW cache poisoning | Only cache same-origin responses. Validate response status (only cache 200 OK). Never cache opaque responses for critical assets. |
| Offline queue tampering | IndexedDB is same-origin sandboxed. Messages in queue are validated server-side on flush (same as live messages). |
| VAPID key compromise | Private key stored in `.scratchy-data/` (not in web-accessible directory). Rotate: generate new keys, re-subscribe all clients. |

### VAPID Authentication

```javascript
const vapidOptions = {
  subject: 'mailto:' + (process.env.VAPID_EMAIL || 'admin@scratchy.local'),
  publicKey: vapidKeys.publicKey,
  privateKey: vapidKeys.privateKey
};

// Every push request is signed with VAPID — push services verify
// the request came from the legitimate application server
webpush.sendNotification(subscription, payload, vapidOptions);
```

## Implementation Plan

### Step 1: Service Worker + Asset Caching (1 session)

**Goal:** Scratchy loads instantly from cache, works offline (read-only).

- Create `web/sw.js` with precache list and cache-first strategy
- Create `web/offline-fallback.html`
- Add SW registration to `app.js`
- Add cache version management and cleanup
- Test: load app → go offline → app still renders

### Step 2: Offline Message Queue (1 session)

**Goal:** Users can type messages while offline; they send when reconnected.

- Create `web/js/offline-manager.js` with IndexedDB queue
- Integrate with existing message send flow in `connection.js`
- Add offline banner UI to `index.html` / `style.css`
- Add pending indicator for queued messages
- Add Background Sync registration (progressive enhancement)
- Test: go offline → type message → go online → message delivers

### Step 3: VAPID Keys + Push Server (1 session)

**Goal:** Server can send push notifications.

- Add `web-push` dependency
- Create `lib/push/vapid.js` — auto-generate keys on first run
- Create `lib/push/subscription-store.js` — file-based subscription CRUD
- Add endpoints to `serve.js`: `/api/push/vapid-key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/status`, `/api/push/test`
- Test: subscribe from browser → send test push → notification appears

### Step 4: Push Permission Flow + Client UI (1 session)

**Goal:** Users can opt in/out of push notifications.

- Add push subscribe/unsubscribe logic to client
- Add "Notifications" toggle to settings panel
- Add permission prompt flow (ask after engagement threshold)
- Handle `notificationclick` in `sw.js`
- Add focus/blur tracking → send to server over WS
- Test: enable notifications → close tab → trigger push → click notification → app focuses

### Step 5: Gateway Event → Push Pipeline (1 session)

**Goal:** Real events from the agent trigger push notifications.

- Create `lib/push/push-dispatcher.js` — event → notification mapper
- Create `lib/push/focus-tracker.js` — track focused users
- Wire gateway WS events into push dispatcher
- Add debouncing (5s window for rapid messages)
- Add push suppression when tab is focused
- Handle subscription cleanup on 404/410 responses
- Test: send message to agent → close tab → agent replies → push notification arrives

### Step 6: Polish + Edge Cases (1 session)

**Goal:** Production-ready.

- Rate limiting on push sends (30/hour/user)
- Subscription pruning (stale endpoints)
- SW update flow (new version detection, user prompt to refresh)
- Multiple device support (one user, multiple subscriptions)
- Notification grouping/batching
- Metrics: push success/fail counts in `/api/push/status`
- Update `manifest.json` if needed (notification-related fields)

## Estimated Effort

| Step | Sessions | Description |
|------|----------|-------------|
| 1: SW + Asset Caching | 1 | Service worker, cache strategies, offline shell |
| 2: Offline Message Queue | 1 | IndexedDB queue, sync on reconnect, offline UI |
| 3: VAPID + Push Server | 1 | web-push, subscription endpoints, key management |
| 4: Push Permission UI | 1 | Client subscribe flow, notification click, settings toggle |
| 5: Event → Push Pipeline | 1 | Gateway events, dispatcher, debouncing, focus tracking |
| 6: Polish | 1 | Rate limits, pruning, SW updates, grouping |
| **Total** | **6** | |

## Open Questions

1. **Push notification content language** — Should notification body match the user's chat language, or always English? (Relevant if multi-language support comes before this phase.)

2. **Multi-device subscription limit** — Cap subscriptions per user? (5? 10? Unlimited?) Each device registers a separate subscription.

3. **Notification sound** — Use default system sound, or ship a custom Scratchy notification sound? Custom sounds require `silent: false` + `sound` field (limited browser support).

4. **SW update strategy** — Silent auto-update (skipWaiting + clients.claim) or prompt user? Auto is simpler but can cause jarring mid-session reloads. Prompt is safer but adds UI complexity.

5. **Offline message limit** — How many messages to queue in IndexedDB before warning the user? (50? 200?) Need to avoid unbounded storage.

6. **Push for unauthenticated users** — Phase 19 adds multi-user. Should push subscriptions be tied to user accounts, or can they work in legacy single-token mode too? (Recommendation: support both — subscription has optional `userId` field.)

7. **Calendar/widget push triggers** — These require server-side awareness of calendar events and widget states. Should this phase implement them, or defer to when those systems are more mature? (Recommendation: implement the pipeline now, wire calendar/widget triggers as they ship.)

8. **iOS Safari limitations** — Web Push on iOS requires the PWA to be added to home screen and is only available since iOS 16.4. Do we need special handling or user guidance for iOS? (Recommendation: detect iOS and show "Add to Home Screen" prompt before enabling push.)

9. **Background Sync browser support** — Currently Chrome/Edge only. Firefox and Safari don't support it. Is manual flush-on-reconnect sufficient as the primary path, with Background Sync as progressive enhancement?

10. **Payload size budget** — Web Push payloads are limited to ~4KB. Current payload design is well within this, but should we define a hard contract? (Recommendation: max 2KB payload, truncate body at 120 chars.)
