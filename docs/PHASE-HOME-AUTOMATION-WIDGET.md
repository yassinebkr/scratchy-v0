# Phase: Home Automation Widget (Home Assistant Integration)

## Overview

Add a Home Automation widget to Scratchy that lets users control their smart home directly from the chat interface. Built around **Home Assistant** — the most popular self-hosted home automation platform — the widget provides real-time device status, interactive controls (lights, thermostats, covers, media players), automation triggers, energy dashboards, and sensor history. All rendered through Scratchy's existing `scratchy-canvas` component protocol.

**Goals:**
- Control any Home Assistant device from Scratchy without opening a separate HA dashboard
- Real-time state updates — when a light turns on physically, the widget reflects it instantly
- Room-based navigation that mirrors the user's home layout
- Sensor history and energy monitoring via sparklines and charts
- Trigger scenes and automations with one tap
- Secure connection — encrypted token storage, HTTPS only, scoped permissions

## Current State

```
Scratchy widgets (weather, email, etc.)
  → serve.js routes widget-actions by prefix
  → each widget is an autonomous module in lib/widgets/
  → components rendered via scratchy-canvas JSON ops

Home Assistant (separate)
  → REST API for state reads + service calls
  → WebSocket API for real-time subscriptions
  → Long-lived access tokens for auth
```

No bridge exists between Scratchy and Home Assistant today.

## Target Architecture

```
                    ┌───────────────────────────────────────────┐
                    │            Scratchy Server                │
                    │                                           │
 Browser ─────────►│  serve.js                                 │
   scratchy-canvas  │  ├── widget-action router                │
   JSON ops         │  │   └── ha-* prefix → HA widget handler │
                    │  │                                        │
                    │  ├── lib/widgets/home-assistant/           │
                    │  │   ├── index.js        (action router)  │
                    │  │   ├── connection.js    (HA client)     │
                    │  │   ├── devices.js       (device logic)  │
                    │  │   ├── rooms.js         (area grouping) │
                    │  │   ├── history.js       (sensor history)│
                    │  │   └── renderer.js      (canvas ops)    │
                    │  │                                        │
                    │  └── HA Connection Manager                │
                    │      ├── REST client  ──────────────────────►  Home Assistant
                    │      ├── WebSocket client (persistent) ─────►  :8123/api/websocket
                    │      └── reconnect + heartbeat logic      │
                    │                                           │
                    │  .scratchy-data/                           │
                    │    ha-config.json.enc  ← encrypted HA URL + token
                    └───────────────────────────────────────────┘
```

## Home Assistant Integration

### Authentication

Home Assistant uses **long-lived access tokens** (created in HA UI under Profile → Security → Long-Lived Access Tokens). The token grants full API access to the HA instance.

```
Authorization: Bearer <LONG_LIVED_ACCESS_TOKEN>
```

The token is stored encrypted at rest in `.scratchy-data/ha-config.json.enc` alongside the HA instance URL.

### REST API

Used for on-demand reads and service calls:

| Endpoint | Use |
|----------|-----|
| `GET /api/states` | Fetch all entity states |
| `GET /api/states/<entity_id>` | Single entity state |
| `POST /api/services/<domain>/<service>` | Call a service (e.g. `light/turn_on`) |
| `GET /api/history/period/<timestamp>` | Sensor history for charts |
| `GET /api/config` | Instance info + unit system |
| `GET /api/` | Health check / connectivity test |

### WebSocket API

Used for persistent real-time subscriptions:

```json
// 1. Auth
{"type": "auth", "access_token": "..."}

// 2. Subscribe to state changes
{"id": 1, "type": "subscribe_events", "event_type": "state_changed"}

// 3. Receive updates
{"id": 1, "type": "event", "event": {
  "event_type": "state_changed",
  "data": {
    "entity_id": "light.living_room",
    "new_state": {"state": "on", "attributes": {"brightness": 200}},
    "old_state": {"state": "off"}
  }
}}
```

### Service Discovery

On first connection, the widget fetches:
1. `GET /api/config` — HA version, unit system, location
2. `GET /api/states` — all entities (builds device registry)
3. HA areas/rooms via WebSocket command `config/area_registry/list`
4. HA device registry via WebSocket command `config/device_registry/list`
5. HA entity registry via WebSocket command `config/entity_registry/list`

This builds a local device map that associates entities → devices → areas (rooms).

## Component Design

Each device type maps to one or more Scratchy canvas components:

### Toggle — Lights & Switches
```json
{"op":"upsert","id":"ha-light-living","type":"toggle","data":{
  "label": "Living Room Light",
  "checked": true
}}
```
User taps → fires `ha-toggle` action → calls `light/turn_off` or `light/turn_on`.

### Slider — Dimmers & Thermostats
```json
{"op":"upsert","id":"ha-dimmer-living","type":"slider","data":{
  "label": "Living Room Brightness",
  "value": 78,
  "min": 0,
  "max": 100
}}
```
User drags → fires `ha-set-value` action → calls `light/turn_on` with `brightness_pct`.

For thermostats:
```json
{"op":"upsert","id":"ha-climate-bedroom","type":"slider","data":{
  "label": "Bedroom Thermostat",
  "value": 21.5,
  "min": 16,
  "max": 30
}}
```
Fires `ha-set-value` → calls `climate/set_temperature`.

### Gauge — Temperature & Humidity
```json
{"op":"upsert","id":"ha-temp-outdoor","type":"gauge","data":{
  "label": "Outdoor Temperature",
  "value": 18.3,
  "max": 50,
  "unit": "°C",
  "color": "#ff9800"
}}
```
Read-only. Updated via WebSocket state changes.

### Stats — Energy Monitoring
```json
{"op":"upsert","id":"ha-energy-today","type":"stats","data":{
  "title": "Energy Today",
  "items": [
    {"label": "Consumption", "value": "12.4 kWh"},
    {"label": "Solar", "value": "8.1 kWh"},
    {"label": "Grid", "value": "4.3 kWh"},
    {"label": "Cost", "value": "€1.07"}
  ]
}}
```

### Card — Rooms & Devices
```json
{"op":"upsert","id":"ha-room-living","type":"card","data":{
  "title": "Living Room",
  "text": "3 lights on · 22.1°C · 2 devices active",
  "icon": "🛋️"
}}
```
Tapping a room card navigates to the room detail view via `ha-rooms` action.

### Buttons — Scenes & Automations
```json
{"op":"upsert","id":"ha-scenes","type":"buttons","data":{
  "title": "Quick Scenes",
  "buttons": [
    {"label": "🌅 Good Morning", "action": "ha-scenes", "style": "primary"},
    {"label": "🎬 Movie Time", "action": "ha-scenes", "style": "default"},
    {"label": "🌙 Good Night", "action": "ha-scenes", "style": "default"},
    {"label": "🏠 Away Mode", "action": "ha-scenes", "style": "ghost"}
  ]
}}
```

### Sparkline — Sensor History
```json
{"op":"upsert","id":"ha-temp-history","type":"sparkline","data":{
  "label": "Temperature (24h)",
  "values": [18.2, 18.5, 19.1, 20.3, 21.0, 21.5, 22.1, 21.8, 21.2, 20.5],
  "color": "#ff5722",
  "trend": "+1.3°C"
}}
```

### Chart — Detailed History
```json
{"op":"upsert","id":"ha-energy-chart","type":"chart-bar","data":{
  "title": "Energy Usage (7 days)",
  "labels": ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],
  "datasets": [
    {"label": "Consumption", "data": [14.2, 12.8, 15.1, 11.3, 13.7, 16.2, 10.5], "color": "#f44336"},
    {"label": "Solar", "data": [8.1, 9.3, 6.5, 10.2, 7.8, 11.1, 4.3], "color": "#4caf50"}
  ]
}}
```

## Actions (Widget-Action Protocol)

All HA widget actions use the `ha-` prefix and are routed by `serve.js` to the HA widget handler.

| Action | Payload | Description |
|--------|---------|-------------|
| `ha-devices` | `{room?: string, type?: string}` | List devices, optionally filtered by room or type |
| `ha-toggle` | `{entity_id: string}` | Toggle a binary entity (light, switch, cover, etc.) |
| `ha-set-value` | `{entity_id: string, value: number, attribute?: string}` | Set a numeric value (brightness, temperature, position) |
| `ha-scenes` | `{scene_id?: string}` | List scenes or activate a specific scene |
| `ha-automations` | `{automation_id?: string, action?: "trigger"\|"toggle"}` | List automations or trigger/enable/disable one |
| `ha-history` | `{entity_id: string, period?: "1h"\|"24h"\|"7d"\|"30d"}` | Fetch sensor history for charts |
| `ha-rooms` | `{room_id?: string}` | List rooms or show a specific room's devices |
| `ha-settings` | `{url?: string, token?: string, action?: "test"\|"save"\|"disconnect"}` | Configure HA connection |

### Action Flow

```
User taps toggle → Scratchy client sends widget-action
  → serve.js matches ha-* prefix
  → lib/widgets/home-assistant/index.js routes to handler
  → handler calls HA REST API (e.g. POST /api/services/light/turn_on)
  → HA confirms state change
  → WebSocket receives state_changed event
  → renderer.js emits patch op to Scratchy client
  → UI updates in real-time
```

### Initial Setup Flow

```
1. User says "set up home assistant" or triggers ha-settings
2. Widget renders setup form:
   - HA URL input (e.g. http://homeassistant.local:8123)
   - Long-lived access token input
   - [Test Connection] button
   - [Save] button
3. On save → encrypted to .scratchy-data/ha-config.json.enc
4. Widget auto-discovers devices → renders room overview
```

## Views

### 1. Room Overview (Default View)

The landing view when opening the HA widget. Grouped by HA areas/rooms.

```
┌─────────────────────────────────────────┐
│  🏠 Home          [⚙️ Settings]         │  ← hero
├─────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐            │
│  │ 🛋️ Living │  │ 🛏️ Bedroom│            │  ← room cards
│  │ 3 on     │  │ 1 on     │            │
│  │ 22.1°C   │  │ 20.5°C   │            │
│  └──────────┘  └──────────┘            │
│  ┌──────────┐  ┌──────────┐            │
│  │ 🍳 Kitchen│  │ 🚿 Bath   │            │
│  │ 2 on     │  │ off      │            │
│  │ 23.0°C   │  │ 21.2°C   │            │
│  └──────────┘  └──────────┘            │
├─────────────────────────────────────────┤
│  Quick Scenes                           │
│  [🌅 Morning] [🎬 Movie] [🌙 Night]    │  ← scene buttons
├─────────────────────────────────────────┤
│  🌡️ Outdoor 18.3°C    ⚡ 12.4 kWh today │  ← summary stats
└─────────────────────────────────────────┘
```

Components used: `hero`, `card` (per room), `buttons` (scenes), `stats` (summary).

### 2. Room Detail View

Shown when user taps a room card. Lists all devices in that room with interactive controls.

```
┌─────────────────────────────────────────┐
│  🛋️ Living Room     [← Back]            │  ← hero
├─────────────────────────────────────────┤
│  Ceiling Light         [====ON====]     │  ← toggle
│  Brightness            [----78%---]     │  ← slider
│  Floor Lamp            [===OFF====]     │  ← toggle
│  Temperature           ◉ 22.1°C        │  ← gauge
│  Humidity              ◉ 45%           │  ← gauge
│  TV                    [===ON====]      │  ← toggle
│  Curtains              [---60%---]      │  ← slider (cover position)
├─────────────────────────────────────────┤
│  Temp (24h) ▁▂▃▄▅▆▅▄▃  +1.3°C         │  ← sparkline
└─────────────────────────────────────────┘
```

Components used: `hero`, `toggle` (per switchable device), `slider` (dimmable/positional), `gauge` (sensors), `sparkline` (history).

### 3. Device Detail View

Deep-dive into a single device. Shown on long-press or explicit navigation.

```
┌─────────────────────────────────────────┐
│  💡 Ceiling Light      [← Back]         │  ← hero
├─────────────────────────────────────────┤
│  Power                 [====ON====]     │  ← toggle
│  Brightness            [----78%---]     │  ← slider
│  Color Temperature     [---4000K--]     │  ← slider
├─────────────────────────────────────────┤
│  Details                                │
│  Entity: light.living_ceiling           │  ← kv
│  Model: Philips Hue White Ambiance      │
│  Area: Living Room                      │
│  Last Changed: 2 min ago                │
├─────────────────────────────────────────┤
│  Brightness (24h)  ▁▂▃▆█▆▃▂▁           │  ← sparkline
└─────────────────────────────────────────┘
```

Components used: `hero`, `toggle`, `slider`, `kv`, `sparkline`.

### 4. Automation List View

```
┌─────────────────────────────────────────┐
│  ⚙️ Automations                          │  ← hero
├─────────────────────────────────────────┤
│  Motion → Hall Light    [ON]  [▶ Run]   │  ← toggle + button per automation
│  Sunset → Close Blinds  [ON]  [▶ Run]   │
│  Morning Routine        [OFF] [▶ Run]   │
│  Away Mode Lights       [ON]  [▶ Run]   │
├─────────────────────────────────────────┤
│  Last triggered: Motion → Hall (3m ago) │  ← status
└─────────────────────────────────────────┘
```

Components used: `hero`, `checklist` (automation list with toggles), `buttons` (trigger), `status`.

### 5. Energy Dashboard

```
┌─────────────────────────────────────────┐
│  ⚡ Energy Dashboard                     │  ← hero
├─────────────────────────────────────────┤
│  Today          │  This Month           │
│  12.4 kWh used  │  287 kWh used         │  ← stats
│  8.1 kWh solar  │  €72.40 cost          │
├─────────────────────────────────────────┤
│  ██ ██ ▓▓ ██ ▓▓ ██ ██                  │  ← chart-bar (7 day)
│  Mo Tu We Th Fr Sa Su                   │
├─────────────────────────────────────────┤
│  Top Consumers                          │
│  1. HVAC           4.2 kWh              │  ← table or kv
│  2. Water Heater   2.8 kWh              │
│  3. Oven           1.9 kWh              │
└─────────────────────────────────────────┘
```

Components used: `hero`, `stats`, `chart-bar`, `kv`.

### 6. Sensor History View

```
┌─────────────────────────────────────────┐
│  📈 Sensor History                       │  ← hero
├─────────────────────────────────────────┤
│  [1h] [24h] [7d] [30d]                 │  ← chips (period selector)
├─────────────────────────────────────────┤
│  Temperature (Living Room)              │
│  ╱╲  ╱╲╱╲                              │  ← chart-line
│     ╲╱                                  │
├─────────────────────────────────────────┤
│  Humidity (Living Room)                 │
│  ▁▂▃▄▅▆▅▄▃▂▁                           │  ← sparkline
├─────────────────────────────────────────┤
│  Min: 18.2°C  Max: 24.1°C  Avg: 21.3°C │  ← stats
└─────────────────────────────────────────┘
```

Components used: `hero`, `chips` (period), `chart-line`, `sparkline`, `stats`.

## Real-time Updates

### WebSocket Subscription Architecture

```
┌────────────┐         ┌────────────────┐         ┌──────────────────┐
│  Scratchy  │◄──WS──►│  serve.js       │◄──WS──►│  Home Assistant   │
│  Client    │  canvas │  HA Connection  │  HA WS  │  :8123           │
│            │  ops    │  Manager        │  API    │                  │
└────────────┘         └────────────────┘         └──────────────────┘
```

1. **HA → serve.js**: Persistent WebSocket subscribes to `state_changed` events
2. **serve.js → Client**: State changes translated to `patch` ops and pushed via existing Scratchy WS

### Update Flow

```
Physical light switch flipped
  → HA detects state change
  → HA WS pushes state_changed event to Scratchy
  → Connection manager parses event
  → renderer.js generates patch op:
      {"op":"patch","id":"ha-light-living","data":{"checked":false}}
  → Scratchy client receives patch → UI updates instantly
```

### Subscription Management

- Subscribe once on connection: `subscribe_events` for `state_changed`
- Filter events client-side — only emit patches for entities currently rendered
- Track which entities are "visible" to avoid unnecessary patch ops
- On view change (e.g. switching rooms), update the visible entity set

### Heartbeat & Reconnection

- HA WebSocket supports `ping`/`pong` — send ping every 30s
- On disconnect: exponential backoff reconnect (1s, 2s, 4s, 8s, max 60s)
- On reconnect: re-fetch full state via REST, then re-subscribe to WS
- Stale state indicator: if disconnected > 10s, show alert component

```json
{"op":"upsert","id":"ha-connection-status","type":"alert","data":{
  "title": "Home Assistant",
  "message": "Reconnecting to Home Assistant...",
  "severity": "warning"
}}
```

## Device Types

### Lights (`light.*`)
- **Controls**: toggle (on/off), slider (brightness 0-100%), slider (color temp)
- **Attributes**: `brightness` (0-255), `color_temp` (mireds), `rgb_color`, `effect`
- **Services**: `light/turn_on`, `light/turn_off`, `light/toggle`
- **Components**: `toggle` + `slider`

### Switches (`switch.*`)
- **Controls**: toggle (on/off)
- **Services**: `switch/turn_on`, `switch/turn_off`, `switch/toggle`
- **Components**: `toggle`

### Sensors (`sensor.*`)
- **Controls**: read-only
- **Attributes**: `state` (value), `unit_of_measurement`, `device_class`
- **Components**: `gauge` (numeric), `status` (text), `sparkline` (history)
- **Device classes**: `temperature`, `humidity`, `pressure`, `energy`, `power`, `battery`, `illuminance`

### Climate (`climate.*`)
- **Controls**: mode selector, target temperature slider
- **Attributes**: `temperature`, `current_temperature`, `hvac_modes`, `hvac_action`
- **Services**: `climate/set_temperature`, `climate/set_hvac_mode`
- **Components**: `slider` (target temp) + `gauge` (current temp) + `chips` (mode)

### Covers (`cover.*`)
- **Controls**: open/close/stop buttons, position slider
- **Attributes**: `current_position` (0-100)
- **Services**: `cover/open_cover`, `cover/close_cover`, `cover/stop_cover`, `cover/set_cover_position`
- **Components**: `slider` (position) + `buttons` (open/stop/close)

### Media Players (`media_player.*`)
- **Controls**: play/pause/stop, volume slider, source selector
- **Attributes**: `state`, `volume_level`, `media_title`, `media_artist`, `source`
- **Services**: `media_player/media_play_pause`, `media_player/volume_set`
- **Components**: `card` (now playing) + `slider` (volume) + `buttons` (controls)

### Cameras (`camera.*`)
- **Controls**: snapshot view
- **Attributes**: entity picture URL via `/api/camera_proxy/<entity_id>`
- **Components**: `image` (snapshot, refreshed periodically)

```json
{"op":"upsert","id":"ha-cam-front","type":"image","data":{
  "title": "Front Door Camera",
  "src": "/api/ha-proxy/camera_proxy/camera.front_door?t=1708588800",
  "alt": "Front door camera snapshot"
}}
```

### Binary Sensors (`binary_sensor.*`)
- **Controls**: read-only
- **Attributes**: `state` (on/off), `device_class` (door, motion, smoke, etc.)
- **Components**: `status` (icon + state text)

## Security

### Token Storage

- HA long-lived access token encrypted with AES-256-GCM at rest
- Encryption key derived from Scratchy's master key (same mechanism as multi-user auth)
- Token never sent to the client — all HA API calls are server-side proxied
- Token displayed masked in settings UI (`eyJ•••••••••kQ`)

### Transport Security

- **HTTPS enforced** for remote HA instances (non-localhost)
- Local instances (`.local`, `192.168.*`, `10.*`, `172.16-31.*`) allowed over HTTP
- TLS certificate validation enabled by default (configurable for self-signed certs)
- WebSocket connections use `wss://` for remote, `ws://` for local

### Permission Scoping

- HA long-lived tokens grant full access — no built-in scoping
- Scratchy applies its own permission layer:
  - `ha.view` — read device states (default for all users)
  - `ha.control` — toggle devices, set values (operator+)
  - `ha.automate` — trigger automations, activate scenes (operator+)
  - `ha.admin` — configure HA connection, change settings (admin only)
- Integrates with Phase 19 multi-user roles when available

### API Proxy

- All HA API requests proxied through serve.js — client never talks to HA directly
- Proxy route: `/api/ha-proxy/*` → forwards to configured HA URL with token injected
- Camera snapshots proxied to avoid exposing HA URL/token to browser
- Rate limiting on proxy endpoints to prevent abuse

### Audit Logging

- All service calls (toggle, set-value, scene activation) logged with user ID + timestamp
- Failed connection attempts logged
- Token changes logged (without the token value)

## serve.js Integration

### Routing

Widget actions with the `ha-` prefix are routed to the Home Assistant widget handler:

```javascript
// serve.js — widget-action router
if (action.startsWith('ha-')) {
  const ha = require('./lib/widgets/home-assistant');
  return ha.handleAction(action, payload, context);
}
```

### File Structure

```
lib/widgets/home-assistant/
  index.js              ← action router (ha-devices, ha-toggle, etc.)
  connection.js         ← HA REST + WS client, connection lifecycle
  devices.js            ← entity → device mapping, type inference
  rooms.js              ← area registry, room grouping logic
  history.js            ← sensor history fetcher + aggregation
  renderer.js           ← generates scratchy-canvas ops for each view
  config.js             ← encrypted config read/write
```

### HA Connection Manager

Singleton per Scratchy instance. Manages:

```javascript
class HAConnectionManager {
  constructor(url, token) { /* ... */ }

  // Lifecycle
  async connect()          // establish REST + WS connections
  async disconnect()       // clean shutdown
  async reconnect()        // reconnect with backoff

  // REST
  async getStates()        // GET /api/states
  async callService(domain, service, data)  // POST /api/services/...
  async getHistory(entityId, start, end)    // GET /api/history/period/...

  // WebSocket
  async subscribe(callback)   // subscribe_events → state_changed
  async sendCommand(type, data)  // send WS command (area_registry, etc.)

  // State
  get connected()          // boolean
  get entities()           // Map<entityId, state> — cached from last fetch
  get areas()              // Map<areaId, area> — cached from registry
}
```

### WebSocket Bridge

Real-time HA state changes are bridged to Scratchy's existing client WebSocket:

```javascript
// On HA state_changed event:
haConnection.subscribe((event) => {
  const { entity_id, new_state } = event.data;

  // Only push updates for entities in the user's current view
  if (activeView.hasEntity(entity_id)) {
    const ops = renderer.patchForEntity(entity_id, new_state);
    scratchyWs.send(JSON.stringify({ type: 'canvas-ops', ops }));
  }
});
```

### Proxy Routes

```javascript
// Camera snapshot proxy
app.get('/api/ha-proxy/camera_proxy/:entityId', authMiddleware, async (req, res) => {
  const stream = await haConnection.getCameraSnapshot(req.params.entityId);
  stream.pipe(res);
});
```

## Implementation Plan

### Step 1: HA Connection Manager (1 session)
- `lib/widgets/home-assistant/connection.js`
- REST client: `getStates()`, `callService()`, `getHistory()`
- WebSocket client: connect, auth, subscribe, ping/pong, reconnect
- Config storage: encrypted URL + token in `.scratchy-data/ha-config.json.enc`
- Connection test endpoint

### Step 2: Device Registry & Room Mapping (1 session)
- `devices.js` — parse entity states into typed device objects
- `rooms.js` — fetch area registry, map entities → devices → areas
- Build device type classifiers (light, switch, sensor, climate, etc.)
- Entity attribute normalization (brightness %, temperature units, etc.)

### Step 3: Settings View & Setup Flow (1 session)
- `ha-settings` action handler
- Setup form: URL input, token input, test connection button
- Settings view: connection status, re-configure, disconnect
- Encrypt and persist config

### Step 4: Room Overview & Navigation (1 session)
- `renderer.js` — generate canvas ops for room overview
- Room cards with device counts and summary sensors
- `ha-rooms` action handler — list rooms, navigate to room detail
- Scene buttons on overview

### Step 5: Device Controls — Toggle, Slider, Gauge (1 session)
- `ha-toggle` action handler → `callService()` for lights, switches, covers
- `ha-set-value` action handler → brightness, temperature, cover position
- Room detail view with all device controls
- Gauge components for temperature, humidity sensors

### Step 6: Real-time Updates (1 session)
- WebSocket subscription bridge to Scratchy client
- Patch ops for state changes (toggle flips, value changes)
- Active view tracking — only push relevant entities
- Connection status alert (connected/reconnecting/disconnected)

### Step 7: Scenes & Automations (1 session)
- `ha-scenes` action handler — list and activate scenes
- `ha-automations` action handler — list, trigger, enable/disable
- Scene buttons component
- Automation list view with toggles and trigger buttons

### Step 8: Sensor History & Energy Dashboard (1 session)
- `history.js` — fetch and aggregate sensor history from HA
- `ha-history` action handler — period selection (1h, 24h, 7d, 30d)
- Sparkline components for inline history
- Chart-line / chart-bar for detailed history view
- Energy dashboard view (if energy entities available)

### Step 9: Camera Support & Media Players (1 session)
- Camera snapshot proxy route
- Image component with periodic refresh
- Media player card (now playing, volume, controls)
- Cover control buttons (open/stop/close)

### Step 10: Polish & Edge Cases (1 session)
- Unavailable/unknown entity states — graceful degradation
- Large home support — pagination or lazy loading for 100+ entities
- Unit system handling (metric/imperial from HA config)
- Error handling — HA offline, invalid token, network errors
- Widget removal/cleanup on disconnect

## Estimated Effort

| Step | Sessions | Description |
|------|----------|-------------|
| 1: Connection Manager | 1 | REST + WS client, config, reconnect |
| 2: Device Registry | 1 | Entity parsing, room mapping |
| 3: Settings & Setup | 1 | Configuration UI, encrypted storage |
| 4: Room Overview | 1 | Landing view, navigation |
| 5: Device Controls | 1 | Toggle, slider, gauge |
| 6: Real-time Updates | 1 | WS bridge, patch ops |
| 7: Scenes & Automations | 1 | Scene/automation views |
| 8: History & Energy | 1 | Charts, sparklines, dashboards |
| 9: Cameras & Media | 1 | Snapshot proxy, media controls |
| 10: Polish | 1 | Edge cases, error handling |
| **Total** | **10** | |

## Open Questions

1. **Multi-instance support** — Should the widget support connecting to multiple HA instances? (e.g. home + office). Deferred for v1; architecture should not preclude it.

2. **HA Cloud (Nabu Casa)** — Should we support HA Cloud remote access, or only direct URL connections? Direct URL is simpler; Cloud requires OAuth2 flow.

3. **Entity filtering** — Should admins be able to hide specific entities from Scratchy? Some entities are internal/noisy (e.g. `update.*`, `automation.*` helpers).

4. **Custom dashboards** — Should users be able to create custom HA dashboard layouts in Scratchy, or should we always auto-generate from HA's area/device structure?

5. **Agent integration** — Should the OpenClaw agent be able to proactively control HA? (e.g. "turn off all lights" via chat, or agent-initiated automations based on context). This would require tool definitions, not just widget actions.

6. **Notifications** — Should HA notifications/alerts (smoke detector, door left open) be forwarded to Scratchy as chat messages or alerts?

7. **HA Add-on** — Should we eventually publish a HA add-on that runs Scratchy directly inside Home Assistant's add-on ecosystem?

8. **Mobile considerations** — Scratchy's canvas on mobile has limited space. Should the HA widget have a mobile-specific layout with fewer components per view?

9. **Offline state cache** — How long should we cache entity states when HA is unreachable? Show stale data with a warning, or clear everything?

10. **Rate limiting for HA calls** — Should we debounce rapid slider changes (e.g. dragging brightness) to avoid flooding HA with service calls? Likely yes — debounce 200-300ms.
