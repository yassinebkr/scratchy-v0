# Phase K: Klipper 3D Printer Widget

## Overview

Add a real-time 3D printer monitoring and control widget to Scratchy, powered by Klipper's Moonraker API. The widget provides live temperature graphs, print job progress, file management, G-code console, and machine control — all rendered as interactive scratchy-canvas components inside the webchat.

**Target printer:** Creality CR-10 S5 (500×500×500mm build volume) with Klipper firmware running on BTT Manta E3 EZ + CB2 board.

**Core capabilities:**
- Real-time temperature monitoring (hotend, bed, chamber) with sparkline history
- Print job progress with ETA, layer info, and speed stats
- File browser for uploading and starting G-code files
- Interactive G-code console for manual commands
- Machine control: homing, bed leveling, motor disable, emergency stop
- Live position tracking (X/Y/Z/E) and speed/flow readouts

## Current State

```
Browser → Scratchy webchat → chat with agent → agent can't see printer
                                              → no Moonraker integration
                                              → no real-time sensor data
```

- No printer connectivity in Scratchy
- Agent has no awareness of printer state
- User must switch to Mainsail/Fluidd for printer control
- No widget-action protocol for hardware devices

## Target Architecture

```
                    ┌──────────────────────────────────────┐
                    │          Scratchy Server              │
                    │                                       │
Browser ──────────► │  Widget Router                        │
  scratchy-canvas   │  ├── /api/widget-action               │
  components        │  │   └── kp-* actions                 │
                    │  │                                     │
                    │  KlipperWidget (lib/widgets/klipper/)  │
                    │  ├── klipper-widget.js   ← widget class│
                    │  ├── moonraker-client.js ← API client  │
                    │  └── temp-history.js     ← ring buffer │
                    │                                       │
                    │  MoonrakerConnectionManager            │
                    │  ├── HTTP client (REST)                │─── GET/POST ──► Moonraker :7125
                    │  ├── WebSocket client (live)           │─── WS ────────► Moonraker :7125/websocket
                    │  └── reconnect + health check          │
                    └──────────────────────────────────────┘
```

## Moonraker API

### Connection

Moonraker exposes two interfaces on the CB2 board's local network:

| Interface | URL | Purpose |
|-----------|-----|---------|
| HTTP REST | `http://<printer-ip>:7125` | Request/response commands |
| WebSocket | `ws://<printer-ip>:7125/websocket` | Real-time subscriptions + JSON-RPC |

**Configuration:** Printer IP/port stored in `.scratchy-data/widgets/klipper.json`:
```json
{
  "moonrakerUrl": "http://192.168.1.xxx:7125",
  "pollIntervalMs": 2000,
  "tempHistorySize": 120,
  "apiKey": null
}
```

### Authentication

Moonraker supports multiple auth modes. For local network (CB2 → Scratchy on same LAN or VPN):

1. **Trusted clients** — Moonraker's `[authorization]` config allows trusted IP ranges (simplest for LAN)
2. **API key** — `X-Api-Key` header for remote/untrusted networks
3. **One-shot tokens** — for temporary access (not needed for widget)

The widget must support API key auth as an option, but defaults to trusted-client mode (no key needed on LAN).

### Key Endpoints

#### Printer State
| Endpoint | Method | Description |
|----------|--------|-------------|
| `printer.info` | GET `/printer/info` | Printer state (ready/error/shutdown), hostname, software version |
| `printer.objects.query` | GET `/printer/objects/query?heater_bed&extruder&...` | Query specific object values |
| `printer.objects.subscribe` | WS JSON-RPC | Subscribe to live object updates |
| `printer.objects.list` | GET `/printer/objects/list` | List all available printer objects |

**Key printer objects to subscribe:**
```json
{
  "extruder": ["temperature", "target", "power", "pressure_advance"],
  "heater_bed": ["temperature", "target", "power"],
  "toolhead": ["position", "homed_axes", "print_time", "estimated_print_time", "max_velocity", "max_accel"],
  "gcode_move": ["speed_factor", "extrude_factor", "gcode_position"],
  "fan": ["speed"],
  "print_stats": ["state", "filename", "total_duration", "print_duration", "filament_used", "info"],
  "virtual_sdcard": ["progress", "file_position", "file_path"],
  "display_status": ["progress", "message"],
  "idle_timeout": ["state"],
  "bed_mesh": ["profile_name", "mesh_matrix", "mesh_min", "mesh_max"]
}
```

#### File Management
| Endpoint | Method | Description |
|----------|--------|-------------|
| `server.files.list` | GET `/server/files/list?root=gcodes` | List G-code files |
| `server.files.metadata` | GET `/server/files/metadata?filename=...` | File metadata (size, slicer, est. time) |
| `server.files.upload` | POST `/server/files/upload` | Upload G-code file |
| `server.files.delete` | DELETE `/server/files/{root}/{path}` | Delete a file |

#### Job Control
| Endpoint | Method | Description |
|----------|--------|-------------|
| `printer.print.start` | POST | Start printing a file |
| `printer.print.pause` | POST | Pause current print |
| `printer.print.resume` | POST | Resume paused print |
| `printer.print.cancel` | POST | Cancel current print |
| `printer.gcode.script` | POST `{ "script": "G28" }` | Execute arbitrary G-code |
| `printer.emergency_stop` | POST | **EMERGENCY STOP** — halts everything immediately |

#### Server Info
| Endpoint | Method | Description |
|----------|--------|-------------|
| `server.info` | GET `/server/info` | Moonraker version, plugins, klippy state |
| `machine.system_info` | GET | Host system info (CPU, memory, network) |
| `server.history.list` | GET | Print job history |

### WebSocket JSON-RPC Protocol

Moonraker's WS uses JSON-RPC 2.0. After connecting:

```json
// 1. Identify the client
{"jsonrpc":"2.0","method":"server.connection.identify","params":{"client_name":"scratchy-klipper","version":"1.0.0","type":"web","url":"http://scratchy"},"id":1}

// 2. Subscribe to printer objects
{"jsonrpc":"2.0","method":"printer.objects.subscribe","params":{"objects":{"extruder":null,"heater_bed":null,"toolhead":null,"print_stats":null,"virtual_sdcard":null,"gcode_move":null,"fan":null}},"id":2}

// 3. Receive real-time updates (server pushes)
{"jsonrpc":"2.0","method":"notify_status_update","params":[{"extruder":{"temperature":205.3,"target":210.0}},1234567890.123]}
```

## Component Design

Each view is composed from scratchy-canvas primitives. Components are upserted by ID for efficient patching.

### Temperature Display — `gauge` + `sparkline`

```json
{"op":"upsert","id":"kp-temp-hotend","type":"gauge","data":{"label":"Hotend","value":205.3,"max":300,"unit":"°C","color":"#ef4444"}}
{"op":"upsert","id":"kp-temp-bed","type":"gauge","data":{"label":"Bed","value":58.2,"max":120,"unit":"°C","color":"#f59e0b"}}
{"op":"upsert","id":"kp-temp-history","type":"sparkline","data":{"label":"Temp History (5min)","values":[195,198,200,203,205,205],"color":"#ef4444","endColor":"#f59e0b"}}
```

Live updates via `patch`:
```json
{"op":"patch","id":"kp-temp-hotend","data":{"value":206.1}}
{"op":"patch","id":"kp-temp-bed","data":{"value":59.0}}
{"op":"patch","id":"kp-temp-history","data":{"values":[198,200,203,205,205,206]}}
```

### Print Job Progress — `progress` + `stats`

```json
{"op":"upsert","id":"kp-job-progress","type":"progress","data":{"label":"benchy.gcode","value":42,"max":100,"icon":"🖨️","color":"#10b981"}}
{"op":"upsert","id":"kp-job-stats","type":"stats","data":{"title":"Print Job","items":[{"label":"Layer","value":"84 / 200"},{"label":"ETA","value":"1h 23m"},{"label":"Elapsed","value":"0h 58m"},{"label":"Filament","value":"12.4m"}]}}
```

### Speed & Position — `stats`

```json
{"op":"upsert","id":"kp-motion","type":"stats","data":{"title":"Motion","items":[{"label":"X","value":"125.0"},{"label":"Y","value":"250.0"},{"label":"Z","value":"4.2"},{"label":"Speed","value":"100%"},{"label":"Flow","value":"100%"},{"label":"Fan","value":"75%"}]}}
```

### File Browser — `card` (list) + `buttons`

```json
{"op":"upsert","id":"kp-files","type":"table","data":{"title":"G-code Files","headers":["File","Size","Est. Time"],"rows":[["benchy.gcode","2.4MB","1h 30m"],["calibration_cube.gcode","800KB","25m"],["vase_mode_tall.gcode","5.1MB","4h 10m"]]}}
{"op":"upsert","id":"kp-file-actions","type":"buttons","data":{"title":"","buttons":[{"label":"🖨️ Print Selected","action":"kp-start-print","style":"primary"},{"label":"🔄 Refresh","action":"kp-files","style":"ghost"}]}}
```

### Job Control — `buttons`

```json
{"op":"upsert","id":"kp-controls","type":"buttons","data":{"title":"Print Control","buttons":[{"label":"⏸ Pause","action":"kp-pause","style":"warning"},{"label":"▶️ Resume","action":"kp-resume","style":"primary"},{"label":"❌ Cancel","action":"kp-cancel","style":"danger"},{"label":"🏠 Home All","action":"kp-home","style":"ghost"}]}}
```

### G-code Console — `code` + `input`

```json
{"op":"upsert","id":"kp-console","type":"code","data":{"title":"G-code Console","language":"gcode","code":">>> G28\nok\n>>> M190 S60\nok\n>>> G29\nProbe at 30,30: z=0.125\nProbe at 150,30: z=0.087\n..."}}
{"op":"upsert","id":"kp-gcode-input","type":"form-strip","data":{"title":"","icon":"⌨️","fields":[{"name":"gcode","type":"text","placeholder":"Enter G-code command..."}],"action":"kp-gcode","label":"Send"}}
```

### Status Banner — `alert`

```json
{"op":"upsert","id":"kp-status","type":"alert","data":{"title":"Printer Status","message":"Printing — benchy.gcode (42%)","severity":"info"}}
```

For error states:
```json
{"op":"patch","id":"kp-status","data":{"message":"THERMAL RUNAWAY DETECTED — Heaters disabled","severity":"error"}}
```

### Bed Mesh Visualization — `chart-line`

```json
{"op":"upsert","id":"kp-bed-mesh","type":"chart-line","data":{"title":"Bed Mesh Profile: default","labels":["0","50","100","150","200","250","300","350","400","450","500"],"datasets":[{"label":"Front","data":[0.12,0.08,0.05,0.02,-0.01,-0.03,-0.01,0.02,0.05,0.09,0.13],"color":"#3b82f6"},{"label":"Center","data":[0.06,0.03,0.01,-0.01,-0.02,-0.03,-0.02,0.00,0.02,0.04,0.07],"color":"#10b981"},{"label":"Back","data":[0.15,0.10,0.07,0.03,0.00,-0.02,0.01,0.04,0.08,0.12,0.16],"color":"#f59e0b"}]}}
```

## Actions — Widget-Action Protocol

Actions are triggered by button clicks in scratchy-canvas components. They route through Scratchy's existing `/api/widget-action` endpoint to the Klipper widget handler.

### Action Definitions

| Action | Payload | Description | Safety |
|--------|---------|-------------|--------|
| `kp-status` | `{}` | Render full dashboard (temps + job + motion) | — |
| `kp-temps` | `{}` | Refresh temperature display + sparkline | — |
| `kp-files` | `{ path?: string }` | List G-code files (optional subdirectory) | — |
| `kp-start-print` | `{ filename: string }` | Start printing a file | ⚠️ confirm |
| `kp-pause` | `{}` | Pause current print | — |
| `kp-resume` | `{}` | Resume paused print | — |
| `kp-cancel` | `{}` | Cancel current print | ⚠️ confirm |
| `kp-gcode` | `{ command: string }` | Execute G-code command | ⚠️ validate |
| `kp-home` | `{ axes?: "X"\|"Y"\|"Z"\|"XYZ" }` | Home axes (default: all) | — |
| `kp-level` | `{}` | Start bed leveling sequence (G29 / BED_MESH_CALIBRATE) | — |
| `kp-set-temp` | `{ heater: string, target: number }` | Set heater target temperature | ⚠️ limits |
| `kp-emergency-stop` | `{}` | **EMERGENCY STOP** | 🛑 double confirm |
| `kp-motors-off` | `{}` | Disable stepper motors (M84) | ⚠️ confirm if printing |
| `kp-view` | `{ view: string }` | Switch view (dashboard\|files\|console\|mesh) | — |

### Action Flow

```
User clicks button → scratchy-canvas sends widget-action
                   → POST /api/widget-action { action: "kp-pause", data: {} }
                   → serve.js routes to KlipperWidget.handleAction()
                   → KlipperWidget calls Moonraker API
                   → Response: scratchy-canvas ops (patch/upsert components)
                   → Broadcasted to client via WS
```

### Confirmation Flow (Dangerous Actions)

For `kp-cancel`, `kp-emergency-stop`, and other destructive actions:

```json
// Step 1: Widget responds with confirmation dialog
{"op":"upsert","id":"kp-confirm","type":"alert","data":{"title":"Cancel Print?","message":"This will stop benchy.gcode at 42% progress. 58 minutes of print time will be lost.","severity":"warning"}}
{"op":"upsert","id":"kp-confirm-btns","type":"buttons","data":{"buttons":[{"label":"Yes, Cancel Print","action":"kp-cancel-confirmed","style":"danger"},{"label":"No, Keep Printing","action":"kp-confirm-dismiss","style":"ghost"}]}}

// Step 2: User confirms → widget executes the action
// Step 3: Confirmation components removed
{"op":"remove","id":"kp-confirm"}
{"op":"remove","id":"kp-confirm-btns"}
```

## Real-time Updates

### Moonraker WebSocket Subscription

The `MoonrakerConnectionManager` maintains a persistent WebSocket connection to Moonraker and subscribes to printer object updates.

```
MoonrakerConnectionManager
├── connect()          → establish WS, identify, subscribe
├── reconnect()        → auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
├── subscribe()        → printer.objects.subscribe for all tracked objects
├── on('status', fn)   → emit parsed status updates
├── on('error', fn)    → emit connection/printer errors
├── on('disconnect')   → emit disconnection event
├── query(objects)      → one-shot query via HTTP
├── sendGcode(cmd)      → POST printer.gcode.script
├── healthCheck()       → periodic ping (every 10s) to detect dead connections
└── destroy()           → clean shutdown
```

### Update Pipeline

```
Moonraker WS ──► notify_status_update
               │
               ▼
  MoonrakerConnectionManager.on('status')
               │
               ▼
  KlipperWidget._processUpdate(data)
    ├── Update temp ring buffers (TempHistory)
    ├── Update internal state cache
    ├── Compute derived values (ETA, layer, progress %)
    └── Emit canvas patch ops
               │
               ▼
  serve.js broadcasts via client WS
    └── { type: "event", event: "canvas-update", payload: { ops: [...] } }
               │
               ▼
  Browser scratchy-canvas renders patches
```

### Temperature History Ring Buffer

```javascript
class TempHistory {
  constructor(size = 120) {  // 120 samples × 2s = 4 minutes of history
    this.size = size;
    this.buffers = {};  // keyed by sensor name
  }

  push(sensor, value) {
    if (!this.buffers[sensor]) this.buffers[sensor] = [];
    const buf = this.buffers[sensor];
    buf.push(Math.round(value * 10) / 10);  // 0.1°C precision
    if (buf.length > this.size) buf.shift();
  }

  get(sensor) { return this.buffers[sensor] || []; }
  getAll() { return { ...this.buffers }; }
}
```

### Update Throttling

Moonraker can push updates at 4+ Hz. The widget throttles canvas patches to avoid overwhelming the browser:

- **Temperature gauges:** patch at most every 2s
- **Position stats:** patch at most every 1s
- **Progress bar:** patch at most every 5s (or on % change)
- **Sparkline:** rebuild every 5s (append new avg, shift old)
- **Console output:** batch and flush every 500ms

## Views

The widget supports multiple views, switchable via `kp-view` action or tab navigation.

### Dashboard View (Default)

The primary view shown when the widget loads. Shows everything at a glance.

```
┌─────────────────────────────────────────────────┐
│  🖨️ CR-10 S5 — Printing                [alert] │
├───────────────┬─────────────────────────────────┤
│  Hotend       │  Bed          │  Fan            │
│  ◉ 205°/210° │  ◉ 60°/60°   │  ◉ 75%          │
│  [gauge]      │  [gauge]      │  [gauge]        │
├───────────────┴─────────────────────────────────┤
│  Temperature History (5min)         [sparkline] │
│  ▁▂▃▅▆█████████████████████████▇▆▅▃▂▁          │
├─────────────────────────────────────────────────┤
│  🖨️ benchy.gcode — 42%              [progress] │
│  ████████████████░░░░░░░░░░░░░░░░               │
├─────────────────────────────────────────────────┤
│  Layer: 84/200  │  ETA: 1h 23m  │ Speed: 100%  │
│  Elapsed: 58m   │  Filament: 12m│ Flow: 100%   │
│                                        [stats]  │
├─────────────────────────────────────────────────┤
│  X: 125.0  Y: 250.0  Z: 4.20          [stats]  │
├─────────────────────────────────────────────────┤
│  [⏸ Pause] [▶️ Resume] [❌ Cancel] [🏠 Home]   │
│                                      [buttons]  │
└─────────────────────────────────────────────────┘
```

**Components:**
- `kp-status` — `alert` (printer state banner)
- `kp-temp-hotend` — `gauge` (hotend temperature)
- `kp-temp-bed` — `gauge` (bed temperature)
- `kp-temp-fan` — `gauge` (fan speed %)
- `kp-temp-history` — `sparkline` (rolling temperature graph)
- `kp-job-progress` — `progress` (print progress bar)
- `kp-job-stats` — `stats` (layer, ETA, elapsed, filament)
- `kp-motion` — `stats` (X/Y/Z position, speed/flow factors)
- `kp-controls` — `buttons` (pause/resume/cancel/home)

### File Browser View

```
┌─────────────────────────────────────────────────┐
│  📁 G-code Files                      [table]   │
│  ┌──────────────────────┬───────┬──────────┐    │
│  │ File                 │ Size  │ Est.Time │    │
│  ├──────────────────────┼───────┼──────────┤    │
│  │ benchy.gcode         │ 2.4MB │ 1h 30m   │    │
│  │ calibration_cube.gc  │ 800KB │ 25m      │    │
│  │ vase_tall.gcode      │ 5.1MB │ 4h 10m   │    │
│  │ bracket_v3.gcode     │ 3.2MB │ 2h 45m   │    │
│  └──────────────────────┴───────┴──────────┘    │
├─────────────────────────────────────────────────┤
│  Selected: benchy.gcode                          │
│  Slicer: PrusaSlicer 2.8 │ Material: PLA        │
│  Layer height: 0.2mm │ Infill: 20%    [kv]      │
├─────────────────────────────────────────────────┤
│  [🖨️ Print] [🗑️ Delete] [🔄 Refresh] [◀ Back] │
│                                      [buttons]  │
└─────────────────────────────────────────────────┘
```

**Components:**
- `kp-files` — `table` (file listing)
- `kp-file-detail` — `kv` (selected file metadata from slicer)
- `kp-file-actions` — `buttons` (print/delete/refresh/back)

### G-code Console View

```
┌─────────────────────────────────────────────────┐
│  ⌨️ G-code Console                     [code]   │
│  >>> G28                                         │
│  ok                                              │
│  >>> M190 S60                                    │
│  // Waiting for bed temperature...               │
│  ok                                              │
│  >>> BED_MESH_CALIBRATE                          │
│  // Probe at 30.000,30.000 z=0.125              │
│  // Probe at 150.000,30.000 z=0.087             │
│  // ...                                          │
│  ok                                              │
├─────────────────────────────────────────────────┤
│  ⌨️ [Enter G-code command...       ] [Send]      │
│                                   [form-strip]  │
├─────────────────────────────────────────────────┤
│  Quick: [G28] [M84] [G29] [M140 S0] [M104 S0]  │
│                                      [buttons]  │
├─────────────────────────────────────────────────┤
│  [◀ Dashboard]                       [buttons]  │
└─────────────────────────────────────────────────┘
```

**Components:**
- `kp-console` — `code` (scrolling G-code log, last 100 lines)
- `kp-gcode-input` — `form-strip` (command input + send)
- `kp-quick-cmds` — `buttons` (common G-code shortcuts)
- `kp-console-nav` — `buttons` (back to dashboard)

### Bed Leveling View

```
┌─────────────────────────────────────────────────┐
│  🔧 Bed Mesh — Profile: "default"     [alert]  │
├─────────────────────────────────────────────────┤
│  Mesh Visualization                 [chart-line]│
│  ▲ 0.15mm                                       │
│  │     ╱──╲                                     │
│  │   ╱      ╲──╱──╲                             │
│  │──╱              ╲──╱                         │
│  ├──────────────────────────►                    │
│  Front ────────────────── Back                   │
├─────────────────────────────────────────────────┤
│  Min: -0.03mm │ Max: 0.16mm │ Range: 0.19mm    │
│  Points: 11×11 │ Profile: default     [stats]   │
├─────────────────────────────────────────────────┤
│  [🔧 Calibrate] [💾 Save] [📊 Profiles]        │
│  [◀ Dashboard]                       [buttons]  │
└─────────────────────────────────────────────────┘
```

**Components:**
- `kp-mesh-status` — `alert` (mesh profile info)
- `kp-bed-mesh` — `chart-line` (mesh visualization — front/center/back rows as line datasets)
- `kp-mesh-stats` — `stats` (min/max/range/point count)
- `kp-mesh-actions` — `buttons` (calibrate/save/profiles/back)

## Safety

### Dangerous Action Classification

| Risk Level | Actions | Protection |
|------------|---------|------------|
| 🟢 Safe | `kp-status`, `kp-temps`, `kp-files`, `kp-view` | None needed |
| 🟡 Caution | `kp-home`, `kp-level`, `kp-set-temp`, `kp-start-print`, `kp-motors-off` | Single confirm + validation |
| 🔴 Danger | `kp-cancel`, `kp-gcode` (raw) | Confirm dialog with consequences shown |
| 🛑 Critical | `kp-emergency-stop` | Double confirmation, separate from other controls |

### Temperature Limits

Hardcoded safety limits in the widget (independent of Klipper's own limits):

```json
{
  "maxHotendTemp": 285,
  "maxBedTemp": 110,
  "minTemp": 0,
  "highTempWarning": {
    "hotend": 260,
    "bed": 100
  }
}
```

- `kp-set-temp` rejects values outside safe range before calling Moonraker
- Temperatures above `highTempWarning` threshold trigger a yellow warning
- Setting temps to 0 (cooldown) always allowed without confirmation

### G-code Command Validation

The `kp-gcode` action applies a safety filter before forwarding to Moonraker:

```javascript
const BLOCKED_GCODES = [
  /^M112\b/i,        // Emergency stop — use kp-emergency-stop instead
  /^M997\b/i,        // Firmware update
  /^FIRMWARE_RESTART/i, // Klipper firmware restart
  /^RESTART\b/i,      // Klipper restart
];

const WARN_GCODES = [
  /^M104\s+S(\d+)/i,  // Set hotend temp — check limits
  /^M140\s+S(\d+)/i,  // Set bed temp — check limits
  /^M109\s+S(\d+)/i,  // Wait for hotend temp — check limits
  /^M190\s+S(\d+)/i,  // Wait for bed temp — check limits
  /^G0\s.*Z-/i,       // Negative Z move — crash risk
];
```

- **Blocked:** returns error, does not send to printer
- **Warn:** sends with confirmation, extracts temp values and checks limits

### Connection Loss Handling

If Moonraker WebSocket disconnects:

1. Widget status banner → `severity: "error"`, message: "Printer connection lost"
2. All control buttons disabled (grayed out via patch)
3. Reconnection attempts with exponential backoff
4. On reconnect: full state refresh + resume live updates
5. If disconnected > 5 minutes during active print: send alert notification via Scratchy chat

### Emergency Stop Isolation

The `kp-emergency-stop` action is special:
- Sends `printer.emergency_stop` via HTTP POST (not WS — more reliable under load)
- Does NOT require an active WS subscription
- Always available, even when other controls are disabled
- Double confirmation: first click shows warning, second click executes
- Renders in **red** with distinct visual separation from other controls

## serve.js Integration

### File Structure

```
scratchy/
  lib/
    widgets/
      klipper/
        klipper-widget.js          ← Main widget class
        moonraker-client.js        ← Moonraker HTTP + WS client
        temp-history.js            ← Ring buffer for temperature data
        safety.js                  ← Temp limits, G-code validation, confirm logic
        views.js                   ← Canvas op generators for each view
  .scratchy-data/
    widgets/
      klipper.json                 ← Configuration (IP, poll interval, etc.)
      klipper-state.json           ← Persisted state (last view, console history)
```

### Widget Class

```javascript
class KlipperWidget {
  constructor(config) {
    this.config = config;
    this.moonraker = new MoonrakerClient(config.moonrakerUrl, config.apiKey);
    this.tempHistory = new TempHistory(config.tempHistorySize || 120);
    this.state = {
      currentView: 'dashboard',
      printerState: 'unknown',
      consoleLog: [],        // last 100 lines
      selectedFile: null,
      lastUpdate: null,
    };
  }

  // Called by serve.js widget router
  async handleAction(action, data, broadcastFn) {
    switch (action) {
      case 'kp-status':     return this._renderDashboard(broadcastFn);
      case 'kp-temps':      return this._refreshTemps(broadcastFn);
      case 'kp-files':      return this._renderFiles(data, broadcastFn);
      case 'kp-start-print':return this._startPrint(data, broadcastFn);
      case 'kp-pause':      return this._pausePrint(broadcastFn);
      case 'kp-resume':     return this._resumePrint(broadcastFn);
      case 'kp-cancel':     return this._cancelPrint(data, broadcastFn);
      case 'kp-gcode':      return this._sendGcode(data, broadcastFn);
      case 'kp-home':       return this._homeAxes(data, broadcastFn);
      case 'kp-level':      return this._bedLevel(broadcastFn);
      case 'kp-set-temp':   return this._setTemp(data, broadcastFn);
      case 'kp-emergency-stop': return this._emergencyStop(data, broadcastFn);
      case 'kp-motors-off': return this._motorsOff(broadcastFn);
      case 'kp-view':       return this._switchView(data, broadcastFn);
      // Confirmation completions
      case 'kp-cancel-confirmed':     return this._cancelConfirmed(broadcastFn);
      case 'kp-confirm-dismiss':      return this._dismissConfirm(broadcastFn);
      case 'kp-estop-confirmed':      return this._estopConfirmed(broadcastFn);
      default: return { error: `Unknown action: ${action}` };
    }
  }

  // Called by MoonrakerClient on each status update
  _processUpdate(data, broadcastFn) { /* ... throttle + patch ops ... */ }

  // Lifecycle
  async start() { await this.moonraker.connect(); }
  async stop()  { this.moonraker.destroy(); }
}
```

### serve.js Routing

Integration points in `serve.js`:

```javascript
// 1. Load widget on startup
const KlipperWidget = require('./lib/widgets/klipper/klipper-widget.js');
let klipperWidget = null;

function initKlipperWidget() {
  const configPath = path.join(DATA_DIR, 'widgets', 'klipper.json');
  if (!fs.existsSync(configPath)) return;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  klipperWidget = new KlipperWidget(config);
  klipperWidget.start();

  // Wire up live updates → canvas broadcast
  klipperWidget.moonraker.on('status', (data) => {
    const ops = klipperWidget._processUpdate(data);
    if (ops && ops.length > 0) {
      broadcastCanvasOps(ops);
    }
  });

  console.log('[Scratchy] 🖨️ Klipper widget connected to', config.moonrakerUrl);
}

// 2. Route widget actions
// Inside handleWidgetAction():
if (action.startsWith('kp-')) {
  if (!klipperWidget) {
    return { error: 'Klipper widget not configured' };
  }
  return klipperWidget.handleAction(action, data, broadcastCanvasOps);
}

// 3. Cleanup on shutdown
process.on('SIGTERM', () => { klipperWidget?.stop(); });
```

### MoonrakerConnectionManager

```javascript
const WebSocket = require('ws');   // or native WebSocket (Node 22+)
const EventEmitter = require('events');

class MoonrakerClient extends EventEmitter {
  constructor(baseUrl, apiKey) {
    super();
    this.baseUrl = baseUrl;         // http://192.168.1.xxx:7125
    this.wsUrl = baseUrl.replace(/^http/, 'ws') + '/websocket';
    this.apiKey = apiKey;
    this.ws = null;
    this.rpcId = 0;
    this.pendingRpc = new Map();    // id → { resolve, reject, timeout }
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.connected = false;
    this._healthInterval = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', async () => {
        this.connected = true;
        this.reconnectDelay = 1000;
        await this._identify();
        await this._subscribe();
        this._startHealthCheck();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (raw) => this._onMessage(raw));

      this.ws.on('close', () => {
        this.connected = false;
        this.emit('disconnect');
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        if (!this.connected) reject(err);
      });
    });
  }

  // HTTP helper for one-shot commands
  async httpPost(endpoint, params) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    return resp.json();
  }

  async httpGet(endpoint) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {};
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    const resp = await fetch(url, { headers });
    return resp.json();
  }

  async sendGcode(command) {
    return this.httpPost('/printer/gcode/script', { script: command });
  }

  async emergencyStop() {
    return this.httpPost('/printer/emergency_stop', {});
  }

  // JSON-RPC over WS
  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.rpcId;
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 10000);
      this.pendingRpc.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  async _identify() {
    return this._rpc('server.connection.identify', {
      client_name: 'scratchy-klipper',
      version: '1.0.0',
      type: 'web',
      url: 'http://scratchy',
    });
  }

  async _subscribe() {
    return this._rpc('printer.objects.subscribe', {
      objects: {
        extruder: null, heater_bed: null, toolhead: null,
        print_stats: null, virtual_sdcard: null,
        gcode_move: null, fan: null, display_status: null,
        idle_timeout: null, bed_mesh: null,
      },
    });
  }

  _onMessage(raw) {
    const msg = JSON.parse(raw);

    // RPC response
    if (msg.id && this.pendingRpc.has(msg.id)) {
      const { resolve, reject, timeout } = this.pendingRpc.get(msg.id);
      clearTimeout(timeout);
      this.pendingRpc.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }

    // Server notification (live updates)
    if (msg.method === 'notify_status_update') {
      this.emit('status', msg.params[0]);  // { extruder: {...}, heater_bed: {...}, ... }
    } else if (msg.method === 'notify_gcode_response') {
      this.emit('gcode_response', msg.params[0]);  // G-code console output
    } else if (msg.method === 'notify_klippy_disconnected') {
      this.emit('klippy_disconnect');
    } else if (msg.method === 'notify_klippy_ready') {
      this.emit('klippy_ready');
    }
  }

  _startHealthCheck() {
    this._healthInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 10000);
  }

  _scheduleReconnect() {
    clearInterval(this._healthInterval);
    setTimeout(() => this.connect().catch(() => {}), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  destroy() {
    clearInterval(this._healthInterval);
    if (this.ws) this.ws.close();
    this.removeAllListeners();
  }
}
```

## Implementation Plan

### Phase K.1: Moonraker Client & Connection (1 session)

**New files:**
- `lib/widgets/klipper/moonraker-client.js` — HTTP + WS client with reconnect
- `lib/widgets/klipper/temp-history.js` — Ring buffer for temperature data

**Work:**
1. Implement `MoonrakerClient` class (HTTP GET/POST, WS connect, JSON-RPC)
2. Implement `TempHistory` ring buffer
3. Test connection to printer's Moonraker instance
4. Verify subscription receives live `notify_status_update` messages
5. Create `.scratchy-data/widgets/klipper.json` config template

### Phase K.2: Widget Core & Dashboard View (1-2 sessions)

**New files:**
- `lib/widgets/klipper/klipper-widget.js` — Main widget class
- `lib/widgets/klipper/views.js` — Canvas op generators for each view
- `lib/widgets/klipper/safety.js` — Temp limits, G-code validation

**Work:**
1. Implement `KlipperWidget` class with `handleAction()` router
2. Build dashboard view generator (gauges, sparkline, progress, stats, buttons)
3. Wire up `kp-status` and `kp-temps` actions
4. Implement update throttling for live patches
5. Add widget route in `serve.js` for `kp-*` actions

### Phase K.3: Job Control & File Browser (1 session)

**Work:**
1. Implement `kp-files` — query `server.files.list`, render as table with metadata
2. Implement `kp-start-print` — with confirmation dialog
3. Implement `kp-pause`, `kp-resume`, `kp-cancel` — with cancel confirmation
4. Add file detail view (slicer metadata from `server.files.metadata`)
5. Wire up print state changes to dashboard progress/stats updates

### Phase K.4: G-code Console & Machine Control (1 session)

**Work:**
1. Implement `kp-gcode` — command input, safety validation, console output
2. Subscribe to `notify_gcode_response` for console output
3. Implement `kp-home`, `kp-level`, `kp-motors-off`
4. Build console view with scrolling `code` component + quick command buttons
5. Implement G-code blocklist and warning validation

### Phase K.5: Safety & Emergency Stop (1 session)

**Work:**
1. Implement `kp-emergency-stop` with double confirmation flow
2. Implement `kp-set-temp` with hardcoded safety limits
3. Add connection loss detection → status banner + button disable
4. Add print-during-disconnect alert (sends Scratchy chat message)
5. Test all confirmation flows end-to-end

### Phase K.6: Bed Mesh & Polish (1 session)

**Work:**
1. Implement bed mesh visualization (chart-line from `bed_mesh` object)
2. Implement `kp-level` → `BED_MESH_CALIBRATE` with progress tracking
3. Add mesh profile switching
4. Polish: loading states, error handling, edge cases
5. Add `kp-view` navigation between all views
6. Persist last-used view and console history

## Estimated Effort

| Phase | Sessions | Description |
|-------|----------|-------------|
| K.1: Moonraker Client | 1 | HTTP/WS client, connection, subscription |
| K.2: Widget Core & Dashboard | 1-2 | Widget class, dashboard view, live updates |
| K.3: Job Control & Files | 1 | Print start/pause/cancel, file browser |
| K.4: G-code Console | 1 | Console view, machine control, safety filters |
| K.5: Safety & E-Stop | 1 | Emergency stop, temp limits, disconnect handling |
| K.6: Bed Mesh & Polish | 1 | Bed visualization, navigation, persistence |
| **Total** | **6-7** | |

## Decisions

1. **Server-side Moonraker connection** — Yes. The widget connects from serve.js (Node), not from the browser. This avoids CORS issues, keeps the Moonraker API off the public internet, and allows the widget to maintain persistent WS subscriptions even when no browser is connected.

2. **No webcam integration (Phase K)** — Moonraker supports webcam streaming, but video passthrough is complex (MJPEG/WebRTC). Deferred to a future phase. The `image` component exists in scratchy-canvas if we want to add snapshot support later.

3. **Single printer** — Phase K targets one printer. Multi-printer support (printer selection, per-printer configs) is architecturally possible (keyed by printer ID in config) but not implemented yet.

4. **WS vs polling** — Primary: WebSocket subscription for real-time updates. Fallback: HTTP polling every 2s if WS fails. The widget should work in degraded mode if WS is unavailable.

5. **No file upload from Scratchy (Phase K)** — Starting existing files on the printer is in scope. Uploading new G-code files from the webchat is deferred (would need multipart relay through serve.js → Moonraker).

6. **Temperature history in memory** — Ring buffer lives in server memory, not persisted. On restart, history starts empty. 4 minutes of history is sufficient for the sparkline. Longer history (for charts) can be pulled from Moonraker's `server.history` endpoint later.

## Open Questions

1. **Network topology** — Is the CB2 board on the same LAN as the Scratchy server, or do we need a tunnel/VPN? If behind NAT, consider Cloudflare Tunnel or WireGuard for secure remote access.

2. **Moonraker auth mode** — Is trusted-client auth configured on the CB2, or do we need to generate and store an API key? Check `moonraker.conf` → `[authorization]` section.

3. **Klipper macros** — Does the printer have custom Klipper macros (e.g., `START_PRINT`, `END_PRINT`, `PARK`)? The G-code console and job control should be aware of these.

4. **Multi-extruder** — The CR-10 S5 is single extruder, but should the widget architecture support multi-extruder setups for future printers? (Minimal extra effort: just subscribe to `extruder1`, `extruder2`, etc.)

5. **Mobile layout** — The dashboard has many components. On mobile (narrow viewport), how should they stack? Scratchy's layout engine handles this, but we may want a `layout` op to switch to `rows` mode for mobile.

6. **Notification channels** — When a print finishes or fails, should the widget send notifications via other channels (Discord, Telegram) in addition to the Scratchy chat? This would leverage OpenClaw's existing message tool.

7. **Power control** — Should the widget support Moonraker's `machine.shutdown` / `machine.reboot` for the CB2 host? Useful but dangerous — needs careful safety handling.

8. **Thumbnail previews** — Moonraker can serve G-code thumbnail images (from slicer metadata). Worth including in the file browser as `image` components? Would make file selection much more intuitive.

9. **Input Shaper data** — Klipper's input shaper produces resonance frequency graphs. Worth exposing as a `chart-line` in a diagnostics view? Useful for tuning but not day-to-day.

10. **Rate limiting Moonraker** — If the Scratchy server crashes and reconnects rapidly, it could overwhelm Moonraker with subscription requests. Should we add a cooldown on the client side, or is Moonraker's own rate limiting sufficient?
