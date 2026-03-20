# Phase: Plugin System for Custom Component Types

## Overview

Scratchy renders 34 component types via a factory pattern in `live-components.js`. Each factory is a function `_factories.<type> = function(data) → {el, update}` inside an IIFE, exposed through `LiveComponents.create(type, data)` and `LiveComponents.has(type)`. This works well for the built-in set but is completely closed — there's no way for third parties to add new component types, widgets, or behaviors without forking the codebase.

A plugin system opens Scratchy to extension by external developers while keeping the core stable and secure.

### Why Plugins

- **Extensibility** — domain-specific components (3D viewers, maps, code editors, music players) shouldn't all live in core
- **Community** — third-party developers can contribute without touching Scratchy internals
- **Modularity** — move optional built-in components (video, code, form) into plugins to slim the core
- **Widgets** — allow new widget types (action prefixes, OAuth integrations) beyond the built-in set
- **Upgradability** — plugins version independently from Scratchy core

### Developer Experience Goals

1. **Zero-to-component in < 5 minutes** — CLI scaffold, dev server, instant preview
2. **Familiar patterns** — vanilla JS + DOM (matching Scratchy's existing style), no mandatory framework
3. **Hot reload** — change code, see it instantly in the canvas
4. **Safe by default** — plugins can't break the host, steal tokens, or access other plugins' data
5. **Distribution via npm/git** — standard tooling, no proprietary registry

## Current State

```
LiveComponents (IIFE)
├── _factories = {}                    ← private object, not extensible
├── _factories.hero = function(d) → {el, update}
├── _factories.gauge = function(d) → {el, update}
├── ... (34 factories)
└── return { create(type, data), has(type) }    ← only public API

CanvasRenderer
├── SIZE_MAP = { type → "small"|"medium"|"wide"|"full" }
├── Reads LiveComponents.create() to render components
└── No plugin awareness

serve.js
├── Static file server for web/
├── Widget ecosystem integration (genui-engine/)
└── No plugin loading or routing
```

## Target Architecture

```
                    ┌─────────────────────────────────────┐
                    │          Scratchy Server             │
                    │                                     │
                    │  Plugin Loader                      │
                    │  ├── discovers plugins/ directory    │
                    │  ├── validates plugin.json manifests │
                    │  ├── serves plugin assets            │
                    │  └── hot reload (dev mode)           │
                    │                                     │
                    │  serve.js                            │
                    │  ├── GET /api/plugins → manifest list│
                    │  ├── GET /plugins/<name>/... → assets│
                    │  └── POST /api/plugins/action → RPC  │
                    └────────────────┬────────────────────┘
                                     │
                    ┌────────────────▼────────────────────┐
                    │          Scratchy Client             │
                    │                                     │
                    │  PluginManager (plugin-manager.js)   │
                    │  ├── fetches /api/plugins            │
                    │  ├── lazy-loads plugin entry points   │
                    │  ├── manages plugin lifecycle         │
                    │  └── exposes Plugin API               │
                    │                                     │
                    │  LiveComponents (extended)            │
                    │  ├── _factories (built-in)            │
                    │  ├── register(type, factory)  ← NEW  │
                    │  ├── unregister(type)          ← NEW  │
                    │  └── create(type, data) — checks      │
                    │       built-in then plugins           │
                    │                                     │
                    │  CanvasRenderer (extended)            │
                    │  ├── SIZE_MAP (built-in + plugin)     │
                    │  └── renders plugin components        │
                    │       inside Shadow DOM hosts         │
                    │                                     │
                    │  WidgetRegistry (extended)            │
                    │  ├── built-in widget handlers         │
                    │  └── plugin-registered handlers       │
                    └─────────────────────────────────────┘
```

## Plugin Format

### File Structure

```
plugins/
└── scratchy-plugin-map/
    ├── plugin.json              ← manifest (required)
    ├── index.js                 ← entry point (required)
    ├── style.css                ← plugin styles (optional)
    ├── README.md                ← documentation (optional)
    ├── assets/                  ← static assets (optional)
    │   └── marker.svg
    └── lib/                     ← internal modules (optional)
        └── geocoder.js
```

### Manifest (`plugin.json`)

```json
{
  "name": "scratchy-plugin-map",
  "version": "1.0.0",
  "displayName": "Interactive Map",
  "description": "Renders interactive maps with markers and routes",
  "author": "Jane Developer <jane@example.com>",
  "license": "MIT",

  "scratchy": {
    "minVersion": "0.9.0",
    "maxVersion": "2.x"
  },

  "entry": "index.js",
  "style": "style.css",

  "components": [
    {
      "type": "map",
      "displayName": "Map View",
      "size": "wide",
      "description": "Interactive map with markers"
    }
  ],

  "widgets": [
    {
      "actionPrefix": "map:",
      "handlerClass": "MapWidgetHandler",
      "description": "Map search and directions widget"
    }
  ],

  "permissions": [
    "network:api.mapbox.com",
    "storage:local"
  ],

  "dependencies": {
    "scratchy-plugin-geojson": "^1.0.0"
  },

  "config": {
    "mapboxToken": {
      "type": "string",
      "required": true,
      "description": "Mapbox API access token",
      "env": "MAPBOX_TOKEN"
    }
  }
}
```

### Entry Point (`index.js`)

Every plugin exports a `register` function that receives the Plugin API:

```js
// index.js — plugin entry point
export function register(api) {
  // Register a component type
  api.components.register("map", {
    size: "wide",
    create(data) {
      const root = document.createElement("div");
      root.className = "plugin-map";
      // ... build DOM ...
      return {
        el: root,
        update(newData) { /* ... patch DOM ... */ },
        destroy() { /* ... cleanup listeners, timers ... */ }
      };
    }
  });

  // Register a widget handler (optional)
  api.widgets.register("map:", MapWidgetHandler);

  // Return cleanup function (optional)
  return function unregister() {
    // Called when plugin is unloaded (hot reload, disable)
  };
}
```

### Versioning

- Plugins follow semver (`major.minor.patch`)
- `scratchy.minVersion` / `scratchy.maxVersion` in manifest declares compatibility
- Plugin Loader rejects plugins incompatible with the running Scratchy version
- Breaking changes to the Plugin API bump Scratchy's major version

## Component Plugin

### Registering a Component Type

Plugins register component types through `api.components.register(type, factory)`. The factory object must provide a `create(data)` method that returns the standard `{el, update, destroy?}` contract — identical to built-in factories.

```js
api.components.register("code-editor", {
  size: "wide",     // "small" | "medium" | "wide" | "full"

  create(data) {
    const root = document.createElement("div");

    // Build initial DOM from data
    const editor = buildEditor(root, data.language, data.code);

    return {
      el: root,

      update(newData) {
        // Called on `patch` or `upsert` ops
        // Merge newData into existing state, update DOM
        if (newData.code !== undefined) editor.setValue(newData.code);
        if (newData.language !== undefined) editor.setLanguage(newData.language);
      },

      destroy() {
        // Called on `remove` op or plugin unload
        // Clean up event listeners, intervals, WebSocket connections
        editor.dispose();
      }
    };
  }
});
```

### Lifecycle

| Phase | Trigger | Method | Notes |
|-------|---------|--------|-------|
| **Create** | `upsert` op with plugin type | `factory.create(data)` | Returns `{el, update, destroy?}` |
| **Update** | `patch` or `upsert` op | `instance.update(data)` | Partial data merge |
| **Destroy** | `remove` op, `clear` op, plugin unload | `instance.destroy()` | Cleanup resources |
| **Suspend** | Tab hidden / component scrolled off | `instance.suspend?.()` | Optional — pause expensive work |
| **Resume** | Tab visible / component scrolled in | `instance.resume?.()` | Optional — resume work |

### CSS Isolation (Shadow DOM)

Plugin components are rendered inside a Shadow DOM host to prevent style leakage in both directions:

```
┌── .component-wrapper (light DOM, Scratchy-controlled) ──┐
│  ┌── shadowRoot (open) ──────────────────────────────┐   │
│  │  <style> /* plugin's style.css injected here */ </style>   │
│  │  <style> /* Scratchy theme CSS variables */  </style>       │
│  │  <div> /* plugin's root element (factory.el) */ </div>     │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**How it works:**
1. CanvasRenderer creates a wrapper `<div>` for each plugin component
2. Attaches an **open** Shadow Root (open so plugins can access their own shadow if needed)
3. Injects the plugin's `style.css` as a `<style>` tag inside the shadow
4. Injects Scratchy's CSS custom properties (theme variables) as an inherited stylesheet
5. Appends the plugin's root element (`factory.el`) into the shadow root

**Theme variables available inside Shadow DOM:**
```css
:host {
  /* Inherited from Scratchy's theme */
  --scratchy-bg: #0a0a0a;
  --scratchy-surface: rgba(255,255,255,0.04);
  --scratchy-text: #e0e0e0;
  --scratchy-text-muted: #888;
  --scratchy-accent: #8b5cf6;
  --scratchy-border: rgba(255,255,255,0.08);
  --scratchy-radius: 10px;
  --scratchy-font: system-ui, -apple-system, sans-serif;
}
```

Plugins should use these variables for consistency with the host theme.

**Built-in components remain in light DOM** — no Shadow DOM overhead for the existing 34 types. Only plugin components get the Shadow DOM wrapper.

## Widget Plugin

### Registering a Widget Handler

Widgets use action prefixes (e.g., `map:search`, `email:send`) to route user interactions to the correct handler. Plugins register widget handlers similarly:

```js
api.widgets.register("map:", {
  // Called when a button/form with action "map:*" is triggered
  async handleAction(action, payload, context) {
    const subAction = action.replace("map:", "");

    switch (subAction) {
      case "search":
        const results = await geocode(payload.query);
        // Update the component via the Plugin API
        context.updateComponent("map-main", {
          center: results[0].coords,
          markers: results.map(r => ({ lat: r.lat, lng: r.lng, label: r.name }))
        });
        break;

      case "directions":
        const route = await getRoute(payload.from, payload.to);
        context.updateComponent("map-main", { route });
        break;
    }
  },

  // Optional: OAuth configuration for external APIs
  oauth: {
    provider: "mapbox",
    scopes: ["styles:read", "geocoding"],
    tokenStorage: "plugin"   // stored per-plugin, encrypted
  }
});
```

### Widget Action Flow

```
User clicks [Get Directions] button
    │
    ▼
CanvasRenderer intercepts action="map:directions"
    │
    ▼
WidgetRouter checks prefix "map:" → finds plugin handler
    │
    ▼
Plugin handler.handleAction("map:directions", formData, context)
    │
    ▼
Handler calls external API, then context.updateComponent(...)
    │
    ▼
CanvasRenderer patches the component with new data
```

### OAuth Support

For widgets that need to authenticate with external APIs:

1. Plugin declares OAuth config in `plugin.json` under `widgets[].oauth`
2. On first use, Scratchy shows an OAuth consent screen
3. Tokens are stored encrypted in `.scratchy-data/plugins/<name>/oauth.json.enc`
4. The Plugin API provides `api.oauth.getToken(provider)` — never exposes raw tokens to the DOM

## Plugin API

The `api` object passed to `register(api)` provides controlled access to Scratchy internals:

### `api.components`

| Method | Description |
|--------|-------------|
| `register(type, factory)` | Register a new component type |
| `unregister(type)` | Remove a previously registered component type |
| `list()` | List all registered types (built-in + plugin) |

### `api.widgets`

| Method | Description |
|--------|-------------|
| `register(prefix, handler)` | Register a widget action handler |
| `unregister(prefix)` | Remove a widget handler |

### `api.events`

Pub/sub event bus for inter-plugin and plugin-host communication:

| Method | Description |
|--------|-------------|
| `on(event, callback)` | Subscribe to an event |
| `off(event, callback)` | Unsubscribe |
| `emit(event, data)` | Emit an event (plugin-scoped by default) |

**Built-in events:**
- `component:created` — a component was rendered
- `component:updated` — a component received new data
- `component:removed` — a component was destroyed
- `theme:changed` — the theme was switched (light/dark)
- `canvas:layout` — layout mode changed
- `plugin:loaded` — another plugin finished loading
- `action:triggered` — a user interaction (button click, form submit)

### `api.context`

Read-only access to shared state:

| Property | Description |
|----------|-------------|
| `theme` | Current theme name ("dark", "light") |
| `layout` | Current canvas layout mode |
| `components` | Map of component IDs → {type, data} currently rendered |
| `user` | Current user info (id, displayName, role) — if multi-user auth is enabled |
| `config` | Plugin's own config values (from plugin.json `config` + env) |

### `api.storage`

Persistent key-value storage scoped to the plugin:

| Method | Description |
|--------|-------------|
| `get(key)` | Read a value |
| `set(key, value)` | Write a value |
| `delete(key)` | Remove a value |
| `clear()` | Remove all values |

Stored in `.scratchy-data/plugins/<name>/storage.json`. Size limit: 1 MB per plugin.

### `api.ui`

Utility functions for DOM construction (matching Scratchy's internal helpers):

| Method | Description |
|--------|-------------|
| `el(tag, opts)` | Create element with `{cls, style, text}` |
| `setText(node, text)` | Efficient text update (skips if unchanged) |
| `animateNum(node, from, to, dur, suffix)` | Smooth number animation |
| `animateValue(from, to, dur, eased, fn)` | Generic value animation |

These mirror the private helpers inside `LiveComponents`, exposed so plugins can use the same animation and DOM utilities.

### `api.theme`

| Property | Description |
|----------|-------------|
| `vars` | Object of all CSS custom property values |
| `onChange(callback)` | Listen for theme changes |

## Security Sandbox

### Principles

1. **Least privilege** — plugins only access what they explicitly request in `permissions`
2. **No eval** — `eval()`, `new Function()`, and inline event handlers are blocked
3. **Style isolation** — Shadow DOM prevents CSS injection attacks
4. **Network restriction** — plugins can only fetch domains declared in `permissions`
5. **No host DOM access** — plugins receive their shadow root, not `document`

### Permission Model

Permissions are declared in `plugin.json` and shown to the user on install:

| Permission | Description | Example |
|------------|-------------|---------|
| `network:<domain>` | HTTP requests to a specific domain | `network:api.mapbox.com` |
| `storage:local` | Plugin-scoped persistent storage | — |
| `events:global` | Emit events other plugins can see | — |
| `context:components` | Read other components' data | — |
| `clipboard:read` | Read from clipboard | — |
| `clipboard:write` | Write to clipboard | — |

Plugins without `network:*` permission cannot make any `fetch()` calls. The Plugin Loader wraps `fetch` in a proxy that checks the target domain against the allowed list.

### CSP Constraints

Scratchy's Content Security Policy is tightened for plugin contexts:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' blob:;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https:;
  connect-src 'self' <allowed-domains>;
  object-src 'none';
  base-uri 'none';
```

- No `'unsafe-eval'` — blocks `eval`, `new Function`, `setTimeout("string")`
- `connect-src` is dynamically extended per plugin based on declared `network:` permissions
- Plugins loaded as ES modules (not inline scripts)

### Fetch Proxy

```js
// Inside plugin sandbox setup
const originalFetch = window.fetch;
const allowedDomains = new Set(plugin.permissions
  .filter(p => p.startsWith("network:"))
  .map(p => p.replace("network:", "")));

const proxiedFetch = (url, opts) => {
  const hostname = new URL(url, location.origin).hostname;
  if (hostname !== location.hostname && !allowedDomains.has(hostname)) {
    return Promise.reject(new Error(
      `Plugin "${plugin.name}" is not permitted to access ${hostname}. ` +
      `Add "network:${hostname}" to permissions in plugin.json.`
    ));
  }
  return originalFetch(url, opts);
};
```

### Runtime Isolation

Plugin entry points are loaded as ES modules via dynamic `import()`. Each plugin's `register()` function runs in the same JS realm (no iframe isolation) but with:

- **Frozen Plugin API** — `Object.freeze(api)` prevents mutation
- **Scoped globals** — plugin entry module gets a scoped `fetch`, no direct `document` access
- **Error boundary** — all plugin method calls are wrapped in try/catch to prevent plugin errors from crashing the host

> **Open question:** Should plugins run in Web Workers or iframes for stronger isolation? See [Open Questions](#open-questions).

## Loading

### Plugin Discovery

On server start, `serve.js` scans the `plugins/` directory:

```
plugins/
├── scratchy-plugin-map/
│   ├── plugin.json
│   └── index.js
├── scratchy-plugin-code-editor/
│   ├── plugin.json
│   └── index.js
└── .disabled/                    ← disabled plugins moved here
    └── scratchy-plugin-old/
```

**Discovery flow:**
1. Read each subdirectory in `plugins/`
2. Parse `plugin.json` — reject if missing or invalid schema
3. Check `scratchy.minVersion` / `scratchy.maxVersion` compatibility
4. Check declared `permissions` against server-side policy (admin may restrict certain permissions)
5. Build manifest index: `GET /api/plugins` returns `[{name, version, components, widgets, entry, style, permissions}]`

### Lazy Loading (Client)

Plugins are not loaded until their component type is first used:

```
Agent sends: {"op":"upsert","id":"map-1","type":"map","data":{...}}
    │
    ▼
LiveComponents.create("map", data)
    │
    ├── built-in factory? → use it (fast path)
    │
    └── plugin type? → PluginManager.ensureLoaded("scratchy-plugin-map")
                            │
                            ├── Already loaded → use cached factory
                            │
                            └── Not loaded →
                                  1. import("/plugins/scratchy-plugin-map/index.js")
                                  2. Call register(api) → registers "map" factory
                                  3. Now create the component
                                  4. Show brief loading skeleton while importing
```

### Hot Reload (Dev Mode)

When `SCRATCHY_DEV=1` is set:

1. Server watches `plugins/` with `fs.watch` (recursive)
2. On file change, server sends WebSocket message: `{"type":"plugin:reload","name":"scratchy-plugin-map"}`
3. Client receives the message:
   a. Calls `unregister()` on the old plugin instance (the cleanup function returned from `register`)
   b. Destroys all active component instances of that plugin's types
   c. Cache-busts and re-imports the entry point: `import("/plugins/.../index.js?v=" + Date.now())`
   d. Calls `register(api)` again
   e. Re-creates any active components with their last known data

## Distribution

### Package Formats

| Format | Install Command | Use Case |
|--------|----------------|----------|
| npm | `scratchy plugin add <package>` | Published packages |
| git URL | `scratchy plugin add https://github.com/user/scratchy-plugin-map.git` | Development / private |
| local path | `scratchy plugin add ./my-plugin` | Symlink for local dev |
| zip | `scratchy plugin add ./plugin.zip` | Manual distribution |

All formats ultimately produce a directory in `plugins/<name>/` with a valid `plugin.json`.

### npm Convention

- Plugin packages are named `scratchy-plugin-<name>` on npm
- The `package.json` contains a `"scratchy"` key pointing to `plugin.json`
- `scratchy plugin add` runs `npm pack`, extracts, and copies to `plugins/`
- No `node_modules` — plugins are client-side ES modules (server-side deps handled separately)

### Versioning & Dependency Resolution

```json
{
  "dependencies": {
    "scratchy-plugin-geojson": "^1.0.0"
  }
}
```

- Dependencies are other Scratchy plugins (not npm packages)
- `scratchy plugin add` resolves and installs dependencies recursively
- Circular dependencies are detected and rejected
- Version conflicts use npm-style semver resolution (highest compatible version wins)
- The Plugin Loader sorts plugins in dependency order before loading

### Lock File

`plugins/plugin-lock.json` records exact installed versions:

```json
{
  "scratchy-plugin-map": {
    "version": "1.2.0",
    "source": "npm:scratchy-plugin-map@^1.0.0",
    "integrity": "sha256-abc123..."
  },
  "scratchy-plugin-geojson": {
    "version": "1.0.3",
    "source": "npm:scratchy-plugin-geojson@^1.0.0",
    "integrity": "sha256-def456..."
  }
}
```

## Developer Experience

### CLI

```bash
# Scaffold a new plugin
scratchy plugin create my-widget
# → creates plugins/scratchy-plugin-my-widget/ with boilerplate

# Add a plugin from npm / git / path
scratchy plugin add scratchy-plugin-map
scratchy plugin add https://github.com/user/plugin.git
scratchy plugin add ./local-path

# Remove a plugin
scratchy plugin remove scratchy-plugin-map

# List installed plugins
scratchy plugin list

# Disable/enable without removing
scratchy plugin disable scratchy-plugin-map
scratchy plugin enable scratchy-plugin-map

# Validate a plugin manifest
scratchy plugin validate ./plugins/scratchy-plugin-map

# Generate documentation from plugin.json + JSDoc
scratchy plugin docs ./plugins/scratchy-plugin-map
```

### Scaffold Template

`scratchy plugin create my-chart` generates:

```
plugins/scratchy-plugin-my-chart/
├── plugin.json          ← pre-filled manifest
├── index.js             ← minimal working component
├── style.css            ← starter styles with theme vars
├── README.md            ← auto-generated docs
└── examples/
    └── demo.json        ← example upsert op for testing
```

**Generated `index.js`:**

```js
export function register(api) {
  api.components.register("my-chart", {
    size: "medium",

    create(data) {
      const root = api.ui.el("div", { cls: "my-chart-root" });
      const title = api.ui.el("div", {
        cls: "my-chart-title",
        text: data.title || "My Chart"
      });
      root.appendChild(title);

      // TODO: Build your component here

      return {
        el: root,
        update(newData) {
          if (newData.title !== undefined) {
            api.ui.setText(title, newData.title);
          }
          // TODO: Handle updates
        },
        destroy() {
          // TODO: Cleanup
        }
      };
    }
  });
}
```

### Dev Mode

```bash
SCRATCHY_DEV=1 node serve.js
```

Dev mode features:
- **Hot reload** — file changes in `plugins/` trigger instant reload (no full page refresh)
- **Plugin inspector** — overlay showing active plugins, registered types, event log
- **Error overlay** — plugin errors display inline instead of silently failing
- **Verbose logging** — all Plugin API calls logged to console with `[Plugin:name]` prefix
- **Mock data** — `scratchy plugin dev <name>` serves a test page that renders example components from `examples/demo.json`

### Documentation Generator

`scratchy plugin docs <path>` generates a Markdown file from:
- `plugin.json` metadata (name, version, description, permissions)
- Component types with their data schema (inferred from JSDoc or TypeScript types)
- Widget action prefixes and payload shapes
- Configuration options
- Usage examples from `examples/`

## Integration — Changes to Existing Files

### `live-components.js`

**Before:**
```js
var LiveComponents = (function() {
  var _factories = {};
  // ... 34 factory definitions ...
  return {
    create: function(type, data) { var f = _factories[type]; return f ? f(data) : null; },
    has: function(type) { return !!_factories[type]; }
  };
})();
```

**After:**
```js
var LiveComponents = (function() {
  var _factories = {};
  var _pluginFactories = {};   // ← NEW: plugin-registered factories

  // ... 34 built-in factory definitions unchanged ...

  return {
    create: function(type, data) {
      var f = _factories[type] || _pluginFactories[type];
      return f ? (f.create ? f.create(data) : f(data)) : null;
    },
    has: function(type) {
      return !!_factories[type] || !!_pluginFactories[type];
    },
    // ── NEW Plugin API ──
    register: function(type, factory) {
      if (_factories[type]) {
        console.warn("[LiveComponents] Cannot override built-in type: " + type);
        return false;
      }
      _pluginFactories[type] = factory;
      return true;
    },
    unregister: function(type) {
      delete _pluginFactories[type];
    },
    listTypes: function() {
      return Object.keys(_factories).concat(Object.keys(_pluginFactories));
    },
    isPlugin: function(type) {
      return !!_pluginFactories[type];
    }
  };
})();
```

**Key principle:** Built-in types cannot be overridden by plugins. `_factories` takes priority.

### `canvas-renderer.js`

Changes:
1. Extend `SIZE_MAP` dynamically when plugins register components with a declared `size`
2. Wrap plugin component elements in Shadow DOM hosts
3. Handle `destroy()` calls on component removal

```js
// In CanvasRenderer constructor or prototype:

registerPluginSize(type, size) {
  this.SIZE_MAP[type] = size;
}

_wrapPluginComponent(type, instance, pluginMeta) {
  const wrapper = document.createElement("div");
  wrapper.className = "component-wrapper component-plugin";
  wrapper.dataset.pluginType = type;

  const shadow = wrapper.attachShadow({ mode: "open" });

  // Inject theme variables
  const themeStyle = document.createElement("style");
  themeStyle.textContent = this._getThemeVarsCSS();
  shadow.appendChild(themeStyle);

  // Inject plugin stylesheet (if declared)
  if (pluginMeta.styleCSS) {
    const pluginStyle = document.createElement("style");
    pluginStyle.textContent = pluginMeta.styleCSS;
    shadow.appendChild(pluginStyle);
  }

  // Append plugin's root element
  shadow.appendChild(instance.el);

  return wrapper;
}
```

### `serve.js`

New endpoints and middleware:

```js
// ── Plugin Loader (server-side) ──

const pluginsDir = path.join(__dirname, "plugins");

// Discover and validate plugins on startup
function discoverPlugins() {
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir)
    .filter(name => !name.startsWith("."))
    .map(name => {
      const manifestPath = path.join(pluginsDir, name, "plugin.json");
      if (!fs.existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        return { name, dir: path.join(pluginsDir, name), manifest };
      } catch (e) {
        console.error(`[Plugin] Invalid manifest: ${name}`, e.message);
        return null;
      }
    })
    .filter(Boolean);
}

// API: list plugins
// GET /api/plugins → [{name, version, components, widgets, entry, style}]

// Static: serve plugin assets
// GET /plugins/<name>/<file> → static file from plugins/<name>/

// Dev mode: file watcher + WebSocket notification
// fs.watch(pluginsDir, { recursive: true }, (event, filename) => { ... })
```

### New File: `web/js/plugin-manager.js`

The client-side plugin orchestrator:

```js
class PluginManager {
  constructor() {
    this.plugins = new Map();       // name → { manifest, module, unregister }
    this.typeToPlugin = new Map();   // componentType → pluginName
    this.loading = new Map();        // name → Promise (dedup concurrent loads)
  }

  // Fetch plugin manifest list from server
  async discover() { /* GET /api/plugins */ }

  // Lazy-load a plugin by name
  async ensureLoaded(name) { /* dynamic import + register */ }

  // Find which plugin provides a component type
  resolveType(type) { /* lookup typeToPlugin */ }

  // Unload a plugin (for hot reload or disable)
  async unload(name) { /* call unregister(), remove factories */ }

  // Reload a plugin (unload + load)
  async reload(name) { /* unload + ensureLoaded */ }
}
```

## Implementation Plan

### Step 1: Open the Component Registry (1 session)

- Add `register()`, `unregister()`, `listTypes()`, `isPlugin()` to `LiveComponents`
- Add `_pluginFactories` separate from `_factories`
- Update `create()` and `has()` to check both maps
- Update `CanvasRenderer.SIZE_MAP` to accept dynamic entries
- **Test:** manually call `LiveComponents.register("test", factory)` from console

### Step 2: Shadow DOM Wrapping (1 session)

- Add Shadow DOM host creation in `CanvasRenderer` for plugin component types
- Inject theme CSS variables into shadow roots
- Inject plugin stylesheets into shadow roots
- Handle `destroy()` lifecycle on component removal
- **Test:** register a test component, verify style isolation

### Step 3: Plugin Loader — Server Side (1 session)

- Create `plugins/` directory convention
- Implement `plugin.json` schema validation (JSON Schema or manual)
- Add `GET /api/plugins` endpoint to `serve.js`
- Add static file serving for `GET /plugins/<name>/<path>`
- **Test:** drop a test plugin in `plugins/`, hit `/api/plugins`

### Step 4: Plugin Manager — Client Side (1-2 sessions)

- Create `web/js/plugin-manager.js`
- Implement `discover()`, `ensureLoaded()`, `unload()`, `reload()`
- Build the Plugin API object (`api.components`, `api.events`, `api.context`, etc.)
- Wire into `LiveComponents.create()`: on unknown type, try lazy-loading the plugin
- Show loading skeleton while importing
- **Test:** create a real plugin, have the agent upsert it, see it render

### Step 5: Widget Handler Extension (1 session)

- Extend widget action routing to check plugin-registered handlers
- Implement `api.widgets.register()` / `unregister()`
- Wire form submissions and button clicks through the plugin widget router
- **Test:** plugin widget handles `map:search` action

### Step 6: Security Hardening (1 session)

- Implement fetch proxy (domain allowlist per plugin)
- Freeze the Plugin API object
- Add error boundaries around all plugin method calls
- Validate permissions from `plugin.json` — show warning for dangerous permissions
- **Test:** attempt unauthorized fetch from a plugin, verify it's blocked

### Step 7: Hot Reload (1 session)

- Add `fs.watch` on `plugins/` in dev mode
- Send WebSocket `plugin:reload` messages on file change
- Implement client-side reload: unload → cache-bust import → re-register → re-create components
- **Test:** edit a plugin file, see it update live

### Step 8: CLI & Distribution (1-2 sessions)

- Add `scratchy plugin` CLI subcommands (create, add, remove, list, enable, disable)
- Implement scaffold template generation
- Implement `add` from npm / git / local path / zip
- Add `plugin-lock.json` for reproducible installs
- **Test:** scaffold a plugin, install from git, verify lock file

### Step 9: Documentation & Examples (1 session)

- Write Plugin Developer Guide (with tutorials)
- Create 2-3 example plugins:
  - `scratchy-plugin-countdown` — simple timer component
  - `scratchy-plugin-markdown` — rich markdown renderer
  - `scratchy-plugin-color-picker` — interactive color picker widget
- Add `scratchy plugin docs` command
- **Test:** third party (or fresh clone) can follow guide and build a plugin

## Estimated Effort

| Step | Sessions | Description |
|------|----------|-------------|
| 1: Open Component Registry | 1 | `register`/`unregister` on LiveComponents |
| 2: Shadow DOM Wrapping | 1 | Style isolation for plugin components |
| 3: Server-Side Loader | 1 | Plugin discovery, manifest validation, asset serving |
| 4: Client-Side Manager | 1-2 | Lazy loading, Plugin API, lifecycle management |
| 5: Widget Handlers | 1 | Action routing for plugin widgets |
| 6: Security Hardening | 1 | Fetch proxy, permissions, error boundaries |
| 7: Hot Reload | 1 | Dev mode file watching + live reload |
| 8: CLI & Distribution | 1-2 | Scaffolding, install from npm/git/zip |
| 9: Docs & Examples | 1 | Developer guide, example plugins |
| **Total** | **9-12** | |

## Open Questions

1. **Iframe isolation vs same-realm?**
   Shadow DOM + fetch proxy provides decent isolation, but a malicious plugin could still access `window`, `localStorage`, `document.cookie`. Full iframe isolation (with `postMessage` bridge) would be stronger but adds complexity and latency. **Recommendation:** Start with same-realm + Shadow DOM + frozen API. Add optional iframe sandbox later for "untrusted" plugins.

2. **Server-side plugin code?**
   Some plugins may need server-side logic (e.g., proxying API calls to hide tokens, server-side rendering). Should we support a `server.js` entry point in plugins, loaded by `serve.js`? This significantly increases the attack surface.

3. **Plugin marketplace / registry?**
   Should Scratchy host a central plugin registry (like npm for plugins), or rely on npm/GitHub? A registry adds discoverability but requires infrastructure.

4. **Plugin settings UI?**
   Plugins declare `config` keys in their manifest. Should Scratchy auto-generate a settings UI for plugin configuration, or require plugins to build their own?

5. **Inter-plugin communication?**
   The event bus allows plugins to listen to each other. Should we allow direct method calls between plugins, or keep them decoupled via events only?

6. **TypeScript support?**
   Should the scaffold include TypeScript support out of the box? Plugins would need a build step, which conflicts with the "vanilla JS, no build" philosophy.

7. **Built-in component extraction?**
   Should we migrate some existing built-in components (e.g., `video`, `code`, `form`) into "core plugins" to dogfood the system? This would validate the plugin API but adds migration complexity.

8. **Canvas template integration?**
   `scratchy-tpl` templates render pre-defined layouts. Should plugins be able to register new template types?

9. **Mobile / responsive behavior?**
   How should plugin components declare their responsive breakpoints? Should the Shadow DOM wrapper handle responsive sizing, or leave it to the plugin?

10. **Versioned Plugin API?**
    When the Plugin API changes, how do we handle backward compatibility? Versioned API objects (`api.v1.components`, `api.v2.components`)? Or semver on Scratchy core and let `scratchy.minVersion` handle it?
