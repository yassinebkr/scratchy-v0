# Phase: Weather Dashboard Widget

## Overview

Add a Weather Dashboard widget to Scratchy — a real-time, interactive weather experience rendered entirely through the scratchy-canvas protocol. Users can check current conditions, browse a 7-day forecast, explore hourly temperature charts, and receive severe weather alerts, all without leaving the chat interface.

**User value:**
- Instant weather at a glance — no tab-switching, no app-opening
- Interactive city search — track multiple locations
- Visual hourly/daily forecasts with sparklines and charts
- Severe weather alerts surfaced proactively
- Zero API keys required — uses free, open data sources
- Fully autonomous widget — all actions handled locally in serve.js, never forwarded to the agent

**Widget prefix:** `weather-`

## Current State

```
Scratchy has 3 widgets:
  ├── Standard Notes (sn-)    — sn-cli backed, env-based auth
  ├── Google Calendar (cal-)  — OAuth2, Google Calendar + Tasks API
  └── Email / Gmail (mail-)   — OAuth2, Gmail API

No weather widget exists. The scratchy-canvas protocol already has a native
`weather` component type, plus gauge, sparkline, chart-line, stats, card,
alert — all perfect building blocks for weather display.
```

## Target Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │              Scratchy Server                  │
                    │                                              │
  Client WS ──────►│  serve.js widget-action router                │
   weather-*       │  ├── action.startsWith('weather-')            │
                    │  │   └── session._weatherWidget.handleAction()│
                    │  │                                            │
                    │  WeatherWidget (genui-engine/templates/)      │
                    │  ├── Open-Meteo API (primary)                 │──► api.open-meteo.com
                    │  ├── wttr.in (fallback / quick lookup)        │──► wttr.in
                    │  ├── In-memory cache (5-15 min TTL)           │
                    │  ├── Session state (selected city, units)     │
                    │  └── .weather-prefs.json (persistence)        │
                    │                                              │
                    │  Returns { ops: [...] } ← scratchy-canvas    │
                    └──────────────────────────────────────────────┘
```

## Data Sources

### Primary: Open-Meteo (api.open-meteo.com)

- **No API key required** — completely free, open-source
- **Endpoints used:**
  - `/v1/forecast` — hourly + daily forecast (temperature, precipitation, wind, humidity, UV, weather codes)
  - `/v1/forecast?current=...` — current conditions
  - `/v1/geocoding/search` — city name → lat/lon resolution
- **Rate limit:** 10,000 requests/day (generous for a single-user widget)
- **Coverage:** Global, WMO weather codes
- **Response:** JSON, well-structured, excellent docs

```
GET https://api.open-meteo.com/v1/forecast
  ?latitude=48.8566&longitude=2.3522
  &current=temperature_2m,relative_humidity_2m,apparent_temperature,
           precipitation,weather_code,wind_speed_10m,wind_direction_10m,
           surface_pressure,uv_index
  &hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m
  &daily=weather_code,temperature_2m_max,temperature_2m_min,
         precipitation_sum,sunrise,sunset,uv_index_max
  &timezone=auto
  &forecast_days=7
```

### Fallback: wttr.in

- **No API key required** — curl-friendly weather service
- **Usage:** Quick single-city lookup when Open-Meteo is down, or for the text summary
- **Endpoint:** `https://wttr.in/{city}?format=j1` (JSON output)
- **Limitations:** Less granular hourly data, fewer parameters, rate-limited more aggressively

### Geocoding: Open-Meteo Geocoding API

- **Endpoint:** `https://geocoding-api.open-meteo.com/v1/search?name={query}&count=5`
- **Returns:** City name, country, lat/lon, population, timezone
- **Used for:** City search/autocomplete in the widget

### Caching Strategy

| Data Type | TTL | Storage |
|-----------|-----|---------|
| Current conditions | 5 minutes | In-memory Map |
| Hourly forecast | 15 minutes | In-memory Map |
| Daily (7-day) forecast | 30 minutes | In-memory Map |
| Geocoding results | 24 hours | In-memory Map (LRU, max 100 entries) |
| Weather alerts | 5 minutes | In-memory Map |

**Cache key format:** `{lat},{lon}:{dataType}` (e.g., `48.86,2.35:current`)

**Implementation:**
```javascript
class WeatherCache {
  constructor() {
    this.store = new Map();   // key → { data, expiresAt }
    this.geoCache = new Map(); // query → { results, expiresAt }
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expiresAt) { this.store.delete(key); return null; }
    return entry.data;
  }
  set(key, data, ttlMs) {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }
}
```

## Component Design

The widget uses native scratchy-canvas components to render weather data. Each view is a carefully composed set of 3-6 components.

### Component Mapping

| Weather Concept | Component Type | Rationale |
|----------------|---------------|-----------|
| Current conditions summary | `weather` | Native weather component — icon, city, temp, condition |
| Temperature gauge | `gauge` | Visual temp indicator with color scale |
| Humidity / UV / Wind stats | `stats` | Key-value pairs, compact |
| Hourly temperature trend | `sparkline` | 24-point temperature curve, minimal space |
| Hourly detailed chart | `chart-line` | Full hourly chart with temp + precipitation overlay |
| 7-day forecast | `table` | Day, icon, high/low, precip %, condition |
| Daily temp range bars | `chart-bar` | Visual high/low comparison across days |
| Weather alerts | `alert` | severity: warning/error for severe weather |
| City search results | `card` | Cards with city name, country, quick-select action |
| Settings (units, default city) | `form` | Form with select fields for unit system, default city |
| Navigation | `buttons` | Tab-style nav: Current / Forecast / Hourly / Settings |
| Wind rose / direction | `gauge` | Compass-style wind direction indicator |
| Sunrise/sunset times | `kv` | Key-value pairs for sun times |
| Precipitation sparkline | `sparkline` | 24-hour rain probability mini-chart |

### WMO Weather Code → Icon Mapping

```javascript
const WMO_ICONS = {
  0: '☀️',    // Clear sky
  1: '🌤️',   // Mainly clear
  2: '⛅',    // Partly cloudy
  3: '☁️',    // Overcast
  45: '🌫️',  // Fog
  48: '🌫️',  // Depositing rime fog
  51: '🌦️',  // Light drizzle
  53: '🌦️',  // Moderate drizzle
  55: '🌧️',  // Dense drizzle
  61: '🌧️',  // Slight rain
  63: '🌧️',  // Moderate rain
  65: '🌧️',  // Heavy rain
  71: '🌨️',  // Slight snow
  73: '🌨️',  // Moderate snow
  75: '❄️',   // Heavy snow
  80: '🌦️',  // Slight rain showers
  81: '🌧️',  // Moderate rain showers
  82: '⛈️',   // Violent rain showers
  85: '🌨️',  // Slight snow showers
  86: '🌨️',  // Heavy snow showers
  95: '⛈️',   // Thunderstorm
  96: '⛈️',   // Thunderstorm with slight hail
  99: '⛈️',   // Thunderstorm with heavy hail
};
```

### Example: Current Conditions View (ops output)

```json
[
  {"op":"clear"},
  {"op":"upsert","id":"weather-nav","type":"buttons","data":{"buttons":[
    {"label":"☀️ Current","action":"weather-current","style":"primary"},
    {"label":"📅 7-Day","action":"weather-forecast"},
    {"label":"📊 Hourly","action":"weather-hourly"},
    {"label":"⚙️ Settings","action":"weather-settings"}
  ]}},
  {"op":"upsert","id":"weather-now","type":"weather","data":{
    "icon":"☀️","city":"Berlin","temp":"18°C","condition":"Clear sky"
  }},
  {"op":"upsert","id":"weather-details","type":"stats","data":{
    "title":"Details","items":[
      {"label":"Feels Like","value":"16°C"},
      {"label":"Humidity","value":"62%"},
      {"label":"Wind","value":"12 km/h NW"},
      {"label":"UV Index","value":"5 (Moderate)"},
      {"label":"Pressure","value":"1013 hPa"}
    ]
  }},
  {"op":"upsert","id":"weather-hourly-mini","type":"sparkline","data":{
    "label":"Next 24h Temperature","values":[16,15,14,13,13,14,16,18,20,22,23,24,24,23,22,21,20,19,18,17,16,16,15,15],"color":"#f59e0b","trend":"↗ warming"
  }},
  {"op":"upsert","id":"weather-sun","type":"kv","data":{
    "title":"Sun","items":[
      {"key":"Sunrise","value":"06:42"},
      {"key":"Sunset","value":"18:15"}
    ]
  }}
]
```

## Actions — Widget-Action Protocol

All actions use the standard Scratchy widget-action protocol. Messages with `"type":"widget-action"` and an action starting with `weather-` are routed to the WeatherWidget class in serve.js.

### Action Catalogue

| Action | Context Fields | Description |
|--------|---------------|-------------|
| `weather-current` | `{ city?, lat?, lon? }` | Show current conditions for city (or default) |
| `weather-forecast` | `{ city?, lat?, lon?, days? }` | Show 7-day (or N-day) forecast |
| `weather-hourly` | `{ city?, lat?, lon?, hours? }` | Show hourly chart (default 24h) |
| `weather-search-city` | `{ query }` | Search for a city, show results as cards |
| `weather-select-city` | `{ lat, lon, name, country }` | Set selected city from search results |
| `weather-settings` | `{}` | Show settings form (units, default city) |
| `weather-save-settings` | `{ units?, defaultCity?, defaultLat?, defaultLon? }` | Persist settings |
| `weather-refresh` | `{}` | Force-refresh (clear cache for current city) |
| `weather-alerts` | `{ lat?, lon? }` | Show active weather alerts/warnings |
| `weather-init` | `{}` | Initial load — show current weather for default city |

### Action Flow Examples

**City Search Flow:**
```
1. User clicks search → weather-search-city { query: "Par" }
2. Widget calls geocoding API → shows 5 city cards
3. User clicks "Paris, France" → weather-select-city { lat: 48.86, lon: 2.35, name: "Paris", country: "France" }
4. Widget saves selection → calls weather-current → renders current conditions
```

**Settings Flow:**
```
1. User clicks ⚙️ Settings → weather-settings {}
2. Widget renders form: unit system (metric/imperial/auto), default city input
3. User changes to imperial → weather-save-settings { units: "fahrenheit" }
4. Widget persists to .weather-prefs.json → re-renders current view with new units
```

## Views

### View 1: Current Conditions (default)

The landing view when the widget initializes.

**Components rendered:**
| ID | Type | Content |
|----|------|---------|
| `weather-nav` | `buttons` | Tab navigation (Current • 7-Day • Hourly • Settings) |
| `weather-now` | `weather` | Native weather card: icon, city, temp, condition |
| `weather-details` | `stats` | Feels like, humidity, wind speed/direction, UV index, pressure |
| `weather-hourly-mini` | `sparkline` | 24-hour temperature trend mini-chart |
| `weather-sun` | `kv` | Sunrise / sunset times |
| `weather-alert-*` | `alert` | (conditional) Active severe weather alerts |

### View 2: 7-Day Forecast

**Components rendered:**
| ID | Type | Content |
|----|------|---------|
| `weather-nav` | `buttons` | Tab navigation (Forecast highlighted) |
| `weather-forecast-header` | `card` | City name, date range |
| `weather-forecast-chart` | `chart-bar` | Daily high/low temperature bars |
| `weather-forecast-table` | `table` | Headers: Day, Icon, High, Low, Precip%, Condition |
| `weather-precip-spark` | `sparkline` | 7-day precipitation probability trend |

**Example table data:**
```json
{
  "title": "7-Day Forecast — Berlin",
  "headers": ["Day", "", "High", "Low", "Rain%", "Condition"],
  "rows": [
    ["Mon", "☀️", "22°C", "14°C", "5%", "Clear"],
    ["Tue", "⛅", "20°C", "13°C", "20%", "Partly cloudy"],
    ["Wed", "🌧️", "17°C", "11°C", "75%", "Rain"],
    ["Thu", "🌦️", "18°C", "12°C", "40%", "Showers"],
    ["Fri", "☀️", "21°C", "13°C", "10%", "Clear"],
    ["Sat", "🌤️", "23°C", "15°C", "5%", "Mainly clear"],
    ["Sun", "⛅", "21°C", "14°C", "15%", "Partly cloudy"]
  ]
}
```

### View 3: Hourly Chart

**Components rendered:**
| ID | Type | Content |
|----|------|---------|
| `weather-nav` | `buttons` | Tab navigation (Hourly highlighted) |
| `weather-hourly-chart` | `chart-line` | Dual-axis: temperature line + precipitation bars (24h) |
| `weather-hourly-wind` | `sparkline` | Wind speed sparkline for 24h |
| `weather-hourly-stats` | `stats` | Peak temp, low temp, total precipitation, avg wind |

**Chart-line example:**
```json
{
  "title": "Hourly Forecast — Berlin",
  "labels": ["00","01","02","03","04","05","06","07","08","09","10","11",
             "12","13","14","15","16","17","18","19","20","21","22","23"],
  "datasets": [
    {"label": "Temperature (°C)", "data": [14,13,13,12,12,13,15,17,19,21,22,23,24,24,23,22,21,20,19,18,17,16,15,15], "color": "#f59e0b"},
    {"label": "Rain Prob (%)", "data": [0,0,0,0,0,0,0,0,5,10,15,20,25,20,15,10,5,0,0,0,0,0,0,0], "color": "#3b82f6"}
  ]
}
```

### View 4: Weather Alerts (conditional)

Only rendered when severe weather alerts are active. Alerts are also appended to the Current Conditions view when present.

**Components rendered:**
| ID | Type | Content |
|----|------|---------|
| `weather-alert-{n}` | `alert` | severity: "warning" or "error", title, message with details |
| `weather-alert-timeline` | `timeline` | Alert timeline with start/end times and descriptions |

**Alert severity mapping:**
- WMO severe weather codes (95-99): `severity: "error"` (thunderstorms, hail)
- Heavy precipitation (65, 75, 82, 86): `severity: "warning"`
- Dense fog (48): `severity: "info"`

### View 5: Settings

**Components rendered:**
| ID | Type | Content |
|----|------|---------|
| `weather-nav` | `buttons` | Tab navigation (Settings highlighted) |
| `weather-settings-form` | `form` | Unit system (Metric/Imperial), default city |
| `weather-city-search` | `input` | City search input |
| `weather-current-prefs` | `kv` | Current settings display |

**Settings form:**
```json
{
  "title": "Weather Settings",
  "id": "weather-settings-form",
  "fields": [
    {"name": "units", "type": "select", "label": "Temperature Unit", "value": "celsius", "options": ["celsius", "fahrenheit"]},
    {"name": "windUnit", "type": "select", "label": "Wind Speed Unit", "value": "kmh", "options": ["kmh", "mph", "ms", "knots"]},
    {"name": "defaultCity", "type": "text", "label": "Default City", "placeholder": "Search city...", "value": "Berlin"}
  ],
  "actions": [
    {"label": "Save", "action": "weather-save-settings", "style": "primary"},
    {"label": "Search City", "action": "weather-search-city", "style": "ghost"}
  ]
}
```

## serve.js Integration

### Routing

Following the established pattern (notes → `sn-`, calendar → `cal-`, email → `mail-`), the weather widget uses the `weather-` prefix.

**Addition to the widget-action router in serve.js:**

```javascript
// In the widget-action routing block (after the cal- block):
} else if (action.startsWith('weather-')) {
  // Weather widget
  const weatherModPath = require.resolve('./genui-engine/templates/weather.js');
  delete require.cache[weatherModPath];  // Dev hot-reload
  const WeatherWidget = require('./genui-engine/templates/weather.js');
  if (!session._weatherWidget) session._weatherWidget = new WeatherWidget();
  console.log('[Scratchy] 🔧 Calling weather widget:', action);
  session._weatherWidget.handleAction(action, context)
    .then((result) => {
      console.log('[Scratchy] 📦 Weather result:', result ? (result.ops ? result.ops.length + ' ops' : 'no ops') : 'null');
      _sendOps(result);
    })
    .catch(e => {
      console.error('[Scratchy] ❌ Weather error:', e.message);
      _sendToClient('⚠️ ' + e.message);
    });
}
```

### Widget Class Structure

**File:** `genui-engine/templates/weather.js`

```javascript
/**
 * Weather Dashboard Widget — Scratchy GenUI
 * Standalone widget: Open-Meteo API, no auth required
 * Prefix: weather-
 *
 * Design principles:
 * - Clear before render: every view starts with { op: 'clear' }
 * - Minimal components: max 5-6 visible tiles per view
 * - No API keys: uses free Open-Meteo + wttr.in fallback
 * - Cache-first: all API calls go through WeatherCache
 */

const fs = require('fs');
const path = require('path');

const PREFS_FILE = path.join(__dirname, '..', '..', '.weather-prefs.json');
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1';
const GEO_BASE = 'https://geocoding-api.open-meteo.com/v1';
const WTTR_BASE = 'https://wttr.in';

class WeatherWidget {
  constructor() {
    this.prefs = this._loadPrefs();
    this.cache = new WeatherCache();
    this.selectedCity = this.prefs.defaultCity || { name: 'Berlin', lat: 52.52, lon: 13.41, country: 'Germany' };
    this.currentView = 'current';
  }

  // ─── Entry point ──────────────────────────────────────
  async handleAction(action, context) {
    switch (action) {
      case 'weather-init':
      case 'weather-current':    return this._viewCurrent(context);
      case 'weather-forecast':   return this._viewForecast(context);
      case 'weather-hourly':     return this._viewHourly(context);
      case 'weather-search-city': return this._searchCity(context);
      case 'weather-select-city': return this._selectCity(context);
      case 'weather-settings':   return this._viewSettings();
      case 'weather-save-settings': return this._saveSettings(context);
      case 'weather-refresh':    return this._refresh();
      case 'weather-alerts':     return this._viewAlerts(context);
      default:
        return { ops: [{ op: 'upsert', id: 'weather-error', type: 'alert', data: {
          title: 'Unknown Action', message: `No handler for: ${action}`, severity: 'warning'
        }}]};
    }
  }

  // ─── Preferences persistence ──────────────────────────
  _loadPrefs() { /* read .weather-prefs.json */ }
  _savePrefs() { /* write .weather-prefs.json */ }

  // ─── API calls (cache-first) ──────────────────────────
  async _fetchCurrent(lat, lon) { /* Open-Meteo current endpoint */ }
  async _fetchForecast(lat, lon, days = 7) { /* Open-Meteo daily forecast */ }
  async _fetchHourly(lat, lon, hours = 24) { /* Open-Meteo hourly forecast */ }
  async _geocode(query) { /* Open-Meteo geocoding search */ }
  async _fetchWttrFallback(city) { /* wttr.in JSON fallback */ }

  // ─── View renderers (return { ops: [...] }) ───────────
  async _viewCurrent(context) { /* ... */ }
  async _viewForecast(context) { /* ... */ }
  async _viewHourly(context) { /* ... */ }
  async _viewAlerts(context) { /* ... */ }
  async _viewSettings() { /* ... */ }

  // ─── City management ──────────────────────────────────
  async _searchCity(context) { /* geocoding → card list */ }
  async _selectCity(context) { /* set city → refresh current */ }

  // ─── Helpers ──────────────────────────────────────────
  _navOps(activeTab) { /* return nav buttons with active highlight */ }
  _wmoToIcon(code) { /* WMO weather code → emoji */ }
  _wmoToText(code) { /* WMO weather code → human description */ }
  _convertTemp(celsius) { /* apply unit preference */ }
  _convertWind(kmh) { /* apply wind unit preference */ }
}

class WeatherCache { /* as described in Caching Strategy section */ }

module.exports = WeatherWidget;
```

### Session Persistence

| What | Where | Format |
|------|-------|--------|
| Widget instance | `session._weatherWidget` | In-memory (per WS session) |
| User preferences | `.weather-prefs.json` | `{ units, windUnit, defaultCity: { name, lat, lon, country } }` |
| API cache | `WeatherCache` instance on widget | In-memory Map (lost on server restart — acceptable for weather data) |
| Current view state | `this.currentView` on widget instance | String: `'current' \| 'forecast' \| 'hourly' \| 'settings'` |

**Prefs file example:**
```json
{
  "units": "celsius",
  "windUnit": "kmh",
  "defaultCity": {
    "name": "Berlin",
    "lat": 52.52,
    "lon": 13.41,
    "country": "Germany"
  },
  "savedCities": [
    { "name": "Berlin", "lat": 52.52, "lon": 13.41, "country": "Germany" },
    { "name": "Paris", "lat": 48.86, "lon": 2.35, "country": "France" }
  ]
}
```

### Pre-warming (session init)

Add weather widget pre-warming alongside the existing widgets in serve.js session init:

```javascript
// Pre-warm Weather widget
try {
  const WeatherWidget = require('./genui-engine/templates/weather.js');
  if (!session._weatherWidget) session._weatherWidget = new WeatherWidget();
  if (session._weatherWidget.prefs && session._weatherWidget.prefs.defaultCity) {
    console.log('[Scratchy] 🔄 Weather widget: pre-warming for', session._weatherWidget.selectedCity.name);
    session._weatherWidget._fetchCurrent(
      session._weatherWidget.selectedCity.lat,
      session._weatherWidget.selectedCity.lon
    ).then(() => {
      console.log('[Scratchy] ✅ Weather widget ready');
    }).catch(() => {}); // Silent fail — weather is non-critical
  }
} catch(e) { console.error('[Scratchy] Weather init error:', e.message); }
```

## Implementation Plan

### Step 1: WeatherCache + API Layer (1 session)

**New file:** `genui-engine/templates/weather.js`

- Implement `WeatherCache` class with TTL-based Map
- Implement Open-Meteo API client:
  - `_fetchCurrent(lat, lon)` — current conditions
  - `_fetchForecast(lat, lon, days)` — daily forecast
  - `_fetchHourly(lat, lon, hours)` — hourly data
  - `_geocode(query)` — city search
- Implement `_fetchWttrFallback(city)` for resilience
- Implement WMO code → icon/text mapping
- Unit conversion helpers (°C↔°F, km/h↔mph↔m/s↔knots)
- **Test:** Direct `node -e` calls to verify API responses and caching

### Step 2: Current Conditions View (1 session)

- Implement `handleAction()` routing
- Implement `_viewCurrent()` — renders weather + stats + sparkline + kv
- Implement `_navOps()` — shared navigation buttons across all views
- Implement preferences load/save (`.weather-prefs.json`)
- **Hook into serve.js:** Add `weather-` prefix routing in the widget-action block
- **Test:** Send widget-action via WS, verify canvas ops rendered

### Step 3: 7-Day Forecast + Hourly Chart Views (1 session)

- Implement `_viewForecast()` — chart-bar + table + sparkline
- Implement `_viewHourly()` — chart-line (dual dataset) + stats + wind sparkline
- **Test:** Navigate between views via button actions

### Step 4: City Search + Settings (1 session)

- Implement `_searchCity()` — geocoding → card list with select actions
- Implement `_selectCity()` — set city, refresh view
- Implement `_viewSettings()` — form with units, default city, saved cities
- Implement `_saveSettings()` — persist prefs, re-render current view
- Implement saved cities list (quick-switch between favorites)
- **Test:** Full city search → select → view refresh flow

### Step 5: Alerts + Pre-warming + Polish (0.5 session)

- Implement `_viewAlerts()` — parse WMO severe codes, render alert components
- Add alert banners to current conditions view when active
- Add pre-warming in serve.js session init
- Handle edge cases: no internet, API errors, empty responses, unknown cities
- Error states as `alert` components (not console errors)
- **Test:** End-to-end full widget flow

### Step 6: Agent-Side Awareness (0.5 session)

- Update TOOLS.md so the agent knows about the `weather` component and widget
- The agent can render weather components via `scratchy-canvas` for one-off weather queries
- The widget handles persistent/interactive weather — the agent handles conversational weather
- They coexist: agent can suggest "open the weather widget" via a button action

## Estimated Effort

| Step | Sessions | Description |
|------|----------|-------------|
| 1: Cache + API Layer | 1 | Open-Meteo client, caching, unit conversion |
| 2: Current Conditions | 1 | Main view, serve.js routing, prefs |
| 3: Forecast + Hourly | 1 | 7-day table/chart, hourly chart |
| 4: City Search + Settings | 1 | Geocoding, city management, settings form |
| 5: Alerts + Polish | 0.5 | Weather alerts, pre-warming, error handling |
| 6: Agent Awareness | 0.5 | TOOLS.md update, coexistence with agent weather |
| **Total** | **5** | |

## Open Questions

1. **Multi-user prefs** — Currently `.weather-prefs.json` is global. When Phase 19 (multi-user auth) lands, prefs should be per-user (`.scratchy-data/widgets/{userId}/weather-prefs.json`). Build with this migration in mind?

2. **Geolocation** — Should we support browser geolocation (`navigator.geolocation`) for auto-detecting the user's city? Would need a client→server message for lat/lon. Privacy considerations?

3. **Weather alerts source** — Open-Meteo doesn't have a dedicated alerts endpoint. WMO codes can signal severe weather, but real alert feeds (e.g., DWD for Germany, NWS for US) would be more accurate. Worth adding a country-specific alert source?

4. **Background refresh** — Should the widget auto-refresh on a timer (e.g., every 15 min) even when not visible, so data is always fresh when the user switches to it? Or refresh on-demand only (simpler, fewer API calls)?

5. **Multiple cities dashboard** — Support a "dashboard mode" showing 2-3 cities side-by-side (e.g., home + work + travel destination)? Would use more canvas real estate but high user value.

6. **Dark/light theme** — The `weather` component renders with a gradient. Should we expose theme options, or inherit from Scratchy's global theme?

7. **Saved cities limit** — How many saved/favorite cities should we support? 5? 10? Unlimited with pagination?

8. **Historical data** — Open-Meteo has a historical weather API. Worth adding a "weather on this day" or "last week comparison" view in a future phase?
