# Phase: Canvas Drag-and-Drop + Component Resize

## Overview

Transform the Scratchy canvas from a static auto-layout grid into a fully interactive spatial workspace. Users can drag components to reorder them, resize tiles to emphasize what matters, and persist custom layouts across sessions. This unlocks personalized dashboards — the user arranges their canvas once, and it stays that way.

**User value:**
- **Personalized dashboards** — arrange monitoring gauges, charts, and controls exactly where you want them
- **Priority by size** — make important components larger, shrink secondary ones
- **Spatial memory** — "my weather is always top-right" becomes muscle memory
- **Professional feel** — drag-and-drop is the expected interaction for dashboard UIs

## Current State

```
┌──────────────────────────────────────────────────────┐
│  .canvas-grid (CSS Grid)                             │
│  grid-template-columns: responsive breakpoints       │
│    mobile: 1fr                                       │
│    640px+: repeat(2, 1fr)                            │
│    1024px+: repeat(3, 1fr)                           │
│    1600px+: repeat(4, 1fr)                           │
│                                                      │
│  Tiles auto-placed by DOM order + span classes:      │
│    .dash-small  → span 1                             │
│    .dash-medium → span 1                             │
│    .dash-wide   → span 2                             │
│    .dash-full   → span 1/-1                          │
│                                                      │
│  Type-based overrides at 640px+:                     │
│    hero, alert, stats, buttons → full width           │
│    form, table, chart-bar → full width                │
│                                                      │
│  CanvasState: { components: {id→obj}, layout, version }
│  DashRenderer: createTile → fillTile → FLIP animation │
│  LiveComponents: 34 types, DOM create/update lifecycle │
│  Persistence: localStorage + server .canvas-state.json │
└──────────────────────────────────────────────────────┘
```

**Limitations:**
- No user control over component position — order is determined by `layout.order` (agent-set)
- No resize — span class is determined by component type (`spanOf()`)
- Layout is identical for all sessions; no per-user customization
- Rearranging requires the agent to issue `move` ops

## Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Canvas Grid (Enhanced)                                      │
│                                                              │
│  ┌────────┐  ┌──────────────────┐  ┌────────┐               │
│  │ ⠿ drag │  │  ⠿ drag          │  │ ⠿ drag │               │
│  │ handle │  │  handle           │  │ handle │               │
│  │        │  │                   │  │        │               │
│  │ gauge  │  │  chart-bar        │  │ stats  │               │
│  │        │  │  (user resized    │  │        │               │
│  │        │  │   to span 2)      │  └───═════┘ ← resize     │
│  └───═════┘  │                   │     handle                │
│    ↑         └──────════════════─┘                           │
│  resize                  ↑                                   │
│  handle            resize handle                             │
│                                                              │
│  Drop zones: visual indicators between/around tiles          │
│  Ghost: semi-transparent clone follows pointer during drag   │
│                                                              │
│  Layout persistence:                                         │
│    CanvasState.customLayout = {                              │
│      "gauge-cpu": { order: 0, colSpan: 1, rowSpan: 1 },     │
│      "chart-bar-1": { order: 1, colSpan: 2, rowSpan: 1 },   │
│    }                                                         │
│    → localStorage (immediate) + server sync (debounced)      │
│    → "Reset to auto" button clears customLayout              │
└──────────────────────────────────────────────────────────────┘
```

## Drag-and-Drop

### Design: Vanilla JS, No Library

Using native pointer events — no external dependency. The HTML5 Drag and Drop API is intentionally avoided (poor mobile support, limited styling control, ghost image issues).

### Drag Handle

Each tile gets a drag handle in the top-left corner. Dragging only initiates from the handle — this prevents accidental drags when interacting with inputs, sliders, buttons, etc.

```html
<div class="dash-tile" data-component-id="gauge-cpu">
  <div class="tile-drag-handle" aria-label="Drag to reorder" role="button" tabindex="0">
    <svg><!-- 6-dot grip icon (⠿) --></svg>
  </div>
  <div class="tile-content">
    <!-- LiveComponent renders here -->
  </div>
  <div class="tile-resize-handle" aria-label="Resize" role="slider">
    <svg><!-- diagonal resize icon --></svg>
  </div>
</div>
```

The handle is hidden by default and appears on tile hover (desktop) or is always visible on touch devices.

### Ghost Element

```
pointerdown on handle
  → record start position, snapshot tile dimensions
  → after 3px movement threshold: create ghost

Ghost:
  - cloneNode(true) of the tile
  - position: fixed, pointer-events: none
  - opacity: 0.7, scale(1.03), box-shadow elevation
  - follows pointer with transform (no layout thrash)
  - z-index: 10000

Original tile:
  - opacity: 0.3 (placeholder showing "where it was")
  - dashed border
```

### Drop Zones

Drop zone indicators appear between tiles during drag. The nearest valid drop position is calculated based on pointer position relative to tile centers.

```
Algorithm:
1. On pointermove: find the tile under the pointer (ignoring the ghost)
2. Calculate whether pointer is in the first or second half (horizontal/vertical)
3. Show a drop indicator line (2px accent-colored bar) at the insertion point
4. On pointerup: reorder the components array, remove ghost, FLIP animate
```

### Reorder Logic

```javascript
// DragController.prototype.commitDrop
commitDrop(draggedId, targetId, position /* "before" | "after" */) {
  const all = this.canvasState.getAll(); // sorted by order
  const ids = all.map(c => c.id);

  // Remove dragged from current position
  const fromIdx = ids.indexOf(draggedId);
  ids.splice(fromIdx, 1);

  // Insert at new position
  let toIdx = ids.indexOf(targetId);
  if (position === "after") toIdx++;
  ids.splice(toIdx, 0, draggedId);

  // Update order values
  ids.forEach((id, i) => {
    this.canvasState.apply({ op: "move", id, layout: { order: i } });
  });

  // Persist custom layout
  this.canvasState.saveCustomLayout();
}
```

### Edge Cases

| Case | Behavior |
|------|----------|
| Drag outside grid | Cancel drag, animate tile back to original position |
| Drag to same position | No-op, clean up ghost |
| New component added during drag | Cancel active drag, let FLIP handle the new layout |
| Rapid sequential drags | Debounce — ignore drag start within 100ms of last drop |
| Scroll during drag | Auto-scroll the viewport when pointer is within 60px of edge |

## Resize Handles

### Handle Placement

Each tile has a resize handle at the bottom-right corner. On hover, additional edge handles appear for horizontal-only or vertical-only resize.

```
┌──────────────────┐
│  ⠿               │  ← drag handle (top-left)
│                   │
│  [component]      │
│                   │
│                 ◢ │  ← resize handle (bottom-right, always visible on hover)
└──────────────────┘
```

### Size Constraints

Components resize in grid units (column spans and row spans), not pixel-level freeform. This keeps the grid clean and prevents layout chaos.

```javascript
const SIZE_CONSTRAINTS = {
  // type: { minCol, maxCol, minRow, maxRow }
  small:   { minCol: 1, maxCol: 2, minRow: 1, maxRow: 2 },
  medium:  { minCol: 1, maxCol: 3, minRow: 1, maxRow: 2 },
  wide:    { minCol: 2, maxCol: 4, minRow: 1, maxRow: 3 },
  full:    { minCol: 2, maxCol: 4, minRow: 1, maxRow: 3 },
};

// Per-component overrides (charts benefit from being larger)
const TYPE_CONSTRAINTS = {
  "sparkline": { minCol: 1, maxCol: 2, minRow: 1, maxRow: 1 },
  "gauge":     { minCol: 1, maxCol: 1, minRow: 1, maxRow: 2 },
  "chart-bar": { minCol: 1, maxCol: 4, minRow: 1, maxRow: 3 },
  "chart-line":{ minCol: 1, maxCol: 4, minRow: 1, maxRow: 3 },
  "table":     { minCol: 1, maxCol: 4, minRow: 1, maxRow: 4 },
  "hero":      { minCol: 2, maxCol: 4, minRow: 1, maxRow: 1 },
  // ... remaining types
};
```

### Resize Interaction

```
pointerdown on resize handle
  → record start position, current tile rect, current span values
  → add .resizing class to tile

pointermove
  → calculate delta from start
  → snap to nearest grid column/row boundary
  → clamp to min/max constraints
  → update tile's grid-column and grid-row in real-time (live preview)
  → show size indicator tooltip ("2×1" near the handle)

pointerup
  → commit new span values to CanvasState
  → persist custom layout
  → FLIP animate surrounding tiles into new positions
```

### Aspect Ratio Lock (Optional)

Hold `Shift` during resize to maintain the current aspect ratio. The resize snaps to the nearest grid size that preserves the ratio. This is a power-user feature — no UI indicator required beyond cursor change.

## Grid System

### Explicit Placement vs Auto

The current grid uses `auto-placement` — tiles flow into the grid based on DOM order and span classes. Custom layouts switch to **explicit placement** using `grid-column` and `grid-row` properties.

```css
/* Auto mode (default — current behavior) */
.canvas-grid[data-layout-mode="auto"] .dash-tile {
  /* Browser auto-places based on span class and DOM order */
}

/* Custom mode (user has rearranged) */
.canvas-grid[data-layout-mode="custom"] {
  grid-auto-flow: dense;    /* Fill gaps left by large tiles */
  grid-auto-rows: minmax(120px, auto);
}

.canvas-grid[data-layout-mode="custom"] .dash-tile {
  /* Explicit spans from customLayout */
  grid-column: var(--col-span, span 1);
  grid-row: var(--row-span, span 1);
  order: var(--tile-order, 0);
}
```

### Column/Row Span

Tiles declare their span via CSS custom properties, set by the DragController/ResizeController:

```javascript
// Applied to tile DOM element
tile.style.setProperty("--col-span", `span ${layout.colSpan || 1}`);
tile.style.setProperty("--row-span", `span ${layout.rowSpan || 1}`);
tile.style.setProperty("--tile-order", layout.order);
```

### Breakpoint Awareness

Custom layouts must adapt to different screen sizes. The number of available columns changes at each breakpoint, so span values are clamped:

```
Breakpoint    Columns    Max colSpan
─────────────────────────────────────
< 640px       1          1
640-1023px    2          2
1024-1599px   3          3
1600px+       4          4
```

```javascript
// On resize or breakpoint change
ResizeController.prototype.clampSpans = function() {
  const cols = this.getCurrentColumnCount();
  for (const [id, layout] of Object.entries(this.customLayouts)) {
    if (layout.colSpan > cols) {
      // Temporarily clamp — don't modify saved value
      const tile = this.renderer._els[id];
      if (tile) {
        tile.style.setProperty("--col-span", `span ${cols}`);
      }
    }
  }
};
```

The **saved** layout always stores the "widest" span value. Narrower breakpoints clamp it temporarily. This way, switching from mobile to desktop restores the full layout without data loss.

## Layout Persistence

### Data Structure

```javascript
// Extends CanvasState
class CanvasState {
  constructor() {
    // ... existing fields ...
    this.customLayouts = {};  // id → { order, colSpan, rowSpan }
    this.layoutMode = "auto"; // "auto" | "custom"
  }
}
```

```json
// Persisted format (localStorage key: "scratchy-custom-layout-{sessionKey}")
{
  "layoutMode": "custom",
  "version": 3,
  "layouts": {
    "gauge-cpu":    { "order": 0, "colSpan": 1, "rowSpan": 1 },
    "chart-bar-1":  { "order": 1, "colSpan": 2, "rowSpan": 1 },
    "stats-memory": { "order": 2, "colSpan": 1, "rowSpan": 1 },
    "checklist-todo":{ "order": 3, "colSpan": 1, "rowSpan": 2 }
  },
  "savedAt": "2026-02-22T08:00:00Z"
}
```

### Save Flow

```
User drags/resizes
  → CanvasState.customLayouts updated
  → localStorage.setItem (immediate, <5ms)
  → debounced server sync (500ms)
      → POST /api/canvas/layout { sessionKey, layouts }
      → server writes to .scratchy-data/canvas/{sessionKey}-layout.json
```

### Server Sync

```javascript
// In canvas-state.js
CanvasState.prototype.saveCustomLayout = function() {
  // Immediate local save
  const key = "scratchy-custom-layout-" + (this.sessionKey || "default");
  const payload = {
    layoutMode: this.layoutMode,
    version: this.version,
    layouts: this.customLayouts,
    savedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch(e) { /* quota exceeded — non-fatal */ }

  // Debounced server sync
  clearTimeout(this._layoutSyncTimer);
  this._layoutSyncTimer = setTimeout(() => {
    fetch("/api/canvas/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => { /* offline — local copy is primary */ });
  }, 500);
};
```

### Load Priority

```
1. localStorage (fastest, offline-capable)
2. Server .canvas-state.json (sync across devices)
3. Auto layout (fallback if no custom layout exists)
```

### Reset to Auto

A "Reset Layout" button (in canvas toolbar or command palette) clears all custom positions/sizes:

```javascript
CanvasState.prototype.resetLayout = function() {
  this.customLayouts = {};
  this.layoutMode = "auto";
  localStorage.removeItem("scratchy-custom-layout-" + (this.sessionKey || "default"));
  this._notify("layout-reset", {});
  // Server sync to delete custom layout
  fetch("/api/canvas/layout", { method: "DELETE" }).catch(() => {});
};
```

## Animation

### Drag Preview

```
Start drag:
  - Ghost element fades in: opacity 0 → 0.7, scale 1 → 1.03 (150ms ease-out)
  - Original tile fades: opacity 1 → 0.3, border becomes dashed (100ms)
  - Drop zone indicators animate in: height 0 → 2px, accent color pulse

During drag:
  - Ghost follows pointer with transform (GPU-composited, no layout)
  - Drop indicator slides to nearest valid position (120ms ease)

Cancel:
  - Ghost animates back to original position (250ms cubic-bezier)
  - Fade out ghost, restore original tile opacity
```

### FLIP on Drop

Leverages the existing FLIP system in `DashRenderer.flushOps()`:

```javascript
// After reorder:
// 1. FIRST: record all tile positions
// 2. DOM reorder (appendChild in new order)
// 3. LAST: record new positions
// 4. INVERT: apply transform to show old position
// 5. PLAY: transition transform to 0 (250ms cubic-bezier(0.22, 1, 0.36, 1))

// The existing flushOps already does this — we just need to trigger it
// after the drag commit by queuing "move" ops for affected tiles.
```

### Resize Animation

```css
/* During resize: live preview with no transition (instant feedback) */
.dash-tile.resizing {
  transition: none !important;
  z-index: 100;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2);
}

/* After resize commit: surrounding tiles FLIP to new positions */
/* Uses existing DashRenderer FLIP system */
```

## Touch Support

### Mobile Drag (Long-Press to Initiate)

Touch drag uses a **long-press** (300ms hold) to differentiate from scroll. Without this, every swipe would start a drag.

```javascript
DragController.prototype._onTouchStart = function(e) {
  if (!e.target.closest(".tile-drag-handle")) return;

  const touch = e.touches[0];
  this._touchStartPos = { x: touch.clientX, y: touch.clientY };
  this._longPressTimer = setTimeout(() => {
    // Haptic feedback (if available)
    if (navigator.vibrate) navigator.vibrate(30);
    this._initDrag(this._touchStartPos, e.target.closest(".dash-tile"));
  }, 300);
};

DragController.prototype._onTouchMove = function(e) {
  // Cancel long-press if finger moved >10px (user is scrolling)
  if (this._longPressTimer) {
    const touch = e.touches[0];
    const dx = touch.clientX - this._touchStartPos.x;
    const dy = touch.clientY - this._touchStartPos.y;
    if (Math.sqrt(dx*dx + dy*dy) > 10) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
      return; // Allow native scroll
    }
  }

  if (this._dragging) {
    e.preventDefault(); // Prevent scroll during drag
    this._updateDrag(e.touches[0].clientX, e.touches[0].clientY);
  }
};
```

### Touch Resize

Resize on touch also uses the bottom-right handle. The handle has a larger touch target (44×44px, per Apple HIG) than the visual indicator.

```css
/* Larger touch target for resize handle on touch devices */
@media (pointer: coarse) {
  .tile-resize-handle {
    width: 44px;
    height: 44px;
    /* Visual indicator remains small (12px icon) */
  }

  .tile-drag-handle {
    /* Always visible on touch (no hover state) */
    opacity: 0.6;
  }
}
```

### Touch Edge Cases

| Case | Behavior |
|------|----------|
| Scroll vs drag | Long-press (300ms) differentiates; movement >10px before timer = scroll |
| Multi-touch | Ignore additional touches during drag/resize |
| Touch cancel (call, notification) | Clean up: remove ghost, restore tile, cancel operation |
| Pinch-to-zoom | Disabled on canvas grid (`touch-action: pan-y` on grid, `none` during drag) |

## Accessibility

### Keyboard Reorder

When a tile is focused:

| Key | Action |
|-----|--------|
| `Space` or `Enter` on drag handle | Enter reorder mode (tile "picked up") |
| `↑` / `↓` | Move tile up/down in order (with FLIP animation) |
| `←` / `→` | On desktop (≥2 columns): swap with adjacent tile in row |
| `Space` or `Enter` | Drop tile at current position (commit) |
| `Escape` | Cancel reorder, return to original position |

### Keyboard Resize

When a tile is focused:

| Key | Action |
|-----|--------|
| `Ctrl+→` | Increase column span (+1) |
| `Ctrl+←` | Decrease column span (-1) |
| `Ctrl+↓` | Increase row span (+1) |
| `Ctrl+↑` | Decrease row span (-1) |
| Immediate commit, no enter/exit mode needed | |

### Screen Reader Announcements

```javascript
// Live region for drag/resize announcements
const liveRegion = document.createElement("div");
liveRegion.setAttribute("role", "status");
liveRegion.setAttribute("aria-live", "polite");
liveRegion.setAttribute("aria-atomic", "true");
liveRegion.className = "sr-only"; // visually hidden

// During drag:
announce("Picked up CPU Gauge. Current position: 1 of 6.");
announce("CPU Gauge moved to position 3 of 6.");
announce("CPU Gauge dropped at position 3 of 6.");

// During resize:
announce("CPU Gauge resized to 2 columns wide, 1 row tall.");
```

### ARIA Attributes

```html
<div class="dash-tile"
     role="article"
     aria-label="CPU Gauge component"
     aria-roledescription="draggable component"
     aria-grabbed="false"         <!-- true when picked up -->
     aria-describedby="dnd-instructions">

  <div class="tile-drag-handle"
       role="button"
       tabindex="0"
       aria-label="Drag handle: press Space to pick up, arrow keys to move">
  </div>

  <div class="tile-resize-handle"
       role="slider"
       tabindex="0"
       aria-label="Resize handle: Ctrl+arrow keys to resize"
       aria-valuemin="1"
       aria-valuemax="4"
       aria-valuenow="1"
       aria-valuetext="1 column wide">
  </div>
</div>

<div id="dnd-instructions" class="sr-only">
  Press Space on the drag handle to pick up this component.
  Use arrow keys to reorder. Press Space again to drop.
  Press Escape to cancel. Use Ctrl+arrow keys to resize.
</div>
```

## Integration

### New Files

| File | Purpose |
|------|---------|
| `web/js/ui/drag-controller.js` | Pointer-event-based drag engine, ghost element, drop zone calculation |
| `web/js/ui/resize-controller.js` | Resize handle interaction, grid-snap logic, size constraints |
| `web/js/ui/layout-manager.js` | Orchestrates custom layout mode, breakpoint clamping, reset |

### Changes to Existing Files

#### `canvas-renderer.js` (DashRenderer)

```diff
  DashRenderer.prototype.createTile = function(comp) {
    // ... existing tile creation ...
+
+   // Drag handle
+   var handle = document.createElement("div");
+   handle.className = "tile-drag-handle";
+   handle.setAttribute("role", "button");
+   handle.setAttribute("tabindex", "0");
+   handle.setAttribute("aria-label", "Drag to reorder");
+   handle.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12">...</svg>';
+   tile.insertBefore(handle, tile.firstChild);
+
+   // Resize handle
+   var resizer = document.createElement("div");
+   resizer.className = "tile-resize-handle";
+   resizer.setAttribute("role", "slider");
+   resizer.setAttribute("tabindex", "0");
+   resizer.setAttribute("aria-label", "Resize");
+   tile.appendChild(resizer);
+
+   // Apply custom layout if exists
+   if (this._layoutManager) {
+     this._layoutManager.applyTileLayout(tile, comp.id);
+   }

    return tile;
  };

+ DashRenderer.prototype.setLayoutManager = function(lm) {
+   this._layoutManager = lm;
+ };
```

#### `canvas-state.js` (CanvasState)

```diff
  class CanvasState {
    constructor() {
      this.components = {};
      this.layout = "auto";
      this.version = 0;
      this.sessionKey = null;
      this._listeners = [];
+     this.customLayouts = {};   // id → { order, colSpan, rowSpan }
+     this.layoutMode = "auto";  // "auto" | "custom"
+     this._layoutSyncTimer = null;
    }

+   setCustomLayout(id, layoutProps) {
+     this.customLayouts[id] = { ...this.customLayouts[id], ...layoutProps };
+     this.layoutMode = "custom";
+     this.saveCustomLayout();
+     this._notify("custom-layout", { id, layout: this.customLayouts[id] });
+   }

+   saveCustomLayout() { /* see Layout Persistence section */ }
+   loadCustomLayout() { /* localStorage → server fallback */ }
+   resetLayout() { /* see Reset to Auto section */ }
  }
```

#### `live-components.js` (LiveComponents)

```diff
  // No structural changes to LiveComponents.
  // Components render inside .tile-content (new wrapper div).
  // The drag handle and resize handle are siblings, outside tile-content.
  //
  // Change: createTile wraps LiveComponent.el in .tile-content div
  // instead of appending directly to tile root.
```

#### `app.js` (Initialization)

```diff
+ // After DashRenderer is created:
+ var layoutManager = new LayoutManager(canvasState, dashRenderer);
+ var dragController = new DragController(dashRenderer, canvasState, layoutManager);
+ var resizeController = new ResizeController(dashRenderer, canvasState, layoutManager);
+ dashRenderer.setLayoutManager(layoutManager);
+
+ // Load saved custom layout
+ layoutManager.load();
```

#### `style.css` (New CSS)

```css
/* ── Drag Handle ── */
.tile-drag-handle {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  opacity: 0;
  transition: opacity 150ms ease;
  z-index: 2;
  border-radius: 4px;
  color: var(--text-secondary);
}

.dash-tile:hover .tile-drag-handle,
.dash-tile:focus-within .tile-drag-handle {
  opacity: 0.5;
}
.tile-drag-handle:hover { opacity: 1 !important; background: var(--bg-tertiary); }

/* ── Resize Handle ── */
.tile-resize-handle {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  opacity: 0;
  transition: opacity 150ms ease;
  z-index: 2;
}
.tile-resize-handle::after {
  content: "";
  position: absolute;
  bottom: 3px;
  right: 3px;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--text-secondary);
  border-bottom: 2px solid var(--text-secondary);
  opacity: 0.5;
}
.dash-tile:hover .tile-resize-handle { opacity: 1; }

/* ── Drag States ── */
.dash-tile.dragging-source {
  opacity: 0.3;
  border: 2px dashed var(--accent);
}
.drag-ghost {
  position: fixed;
  pointer-events: none;
  z-index: 10000;
  opacity: 0.8;
  transform: scale(1.03);
  box-shadow: 0 12px 40px rgba(0,0,0,0.3);
  border-radius: var(--radius);
  transition: opacity 150ms ease;
}
.drop-indicator {
  position: absolute;
  background: var(--accent);
  border-radius: 2px;
  z-index: 100;
  pointer-events: none;
  transition: all 120ms ease;
}

/* ── Resize States ── */
.dash-tile.resizing {
  z-index: 100;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15);
}
.resize-size-tooltip {
  position: absolute;
  bottom: -24px;
  right: 0;
  font-size: 11px;
  color: var(--accent);
  font-weight: 600;
  pointer-events: none;
}

/* ── Custom Layout Mode ── */
.canvas-grid[data-layout-mode="custom"] {
  grid-auto-flow: dense;
}
```

## Implementation Plan

### Step 1: Tile Structure Refactor (Small)

- Wrap LiveComponent output in `.tile-content` div
- Add `.tile-drag-handle` and `.tile-resize-handle` elements in `createTile()`
- Make `.dash-tile` `position: relative` (already is via existing styles)
- CSS for handles (hidden by default, visible on hover)
- **No behavioral changes** — purely structural prep

### Step 2: Drag Controller (Core)

- `drag-controller.js`: pointer event listeners on grid
- Ghost element creation/movement/cleanup
- Drop zone calculation and indicator rendering
- Reorder logic: update DOM order + CanvasState
- Edge cases: cancel, scroll, same-position drop
- Integrate with DashRenderer's FLIP system for animated reorder

### Step 3: Resize Controller (Core)

- `resize-controller.js`: pointer events on resize handles
- Grid-snap calculation (map pixel delta to column/row span changes)
- Size constraints per component type
- Live preview during resize (update CSS custom properties)
- Commit: update CanvasState, trigger FLIP for surrounding tiles

### Step 4: Layout Manager + Persistence

- `layout-manager.js`: custom layout state, breakpoint awareness
- Extend CanvasState with `customLayouts`, `layoutMode`, save/load
- localStorage save (immediate) + server sync (debounced POST)
- Load priority: localStorage → server → auto
- "Reset to Auto" in command palette and canvas toolbar

### Step 5: Touch Support

- Long-press detection (300ms) for drag initiation
- Larger touch targets for handles (44px)
- Touch-move handling with scroll prevention during drag
- Haptic feedback via `navigator.vibrate()`
- Test on iOS Safari + Android Chrome

### Step 6: Keyboard + Accessibility

- Keyboard reorder: Space to pick up, arrows to move, Space/Enter to drop, Escape to cancel
- Keyboard resize: Ctrl+arrows to change span
- ARIA attributes: `aria-grabbed`, `aria-roledescription`, live region announcements
- Screen reader testing (VoiceOver, NVDA)

### Step 7: Polish + Edge Cases

- Auto-scroll during drag (near viewport edges)
- Breakpoint change during drag → cancel
- New component arrives during drag → cancel
- View Transitions integration for smooth layout switches
- "Layout customized" subtle indicator in canvas toolbar
- Performance: ensure 60fps during drag (will-change, compositor layers)

## Open Questions

1. **Free-form vs grid-locked?** Current design snaps to grid units (column/row spans). Should we support pixel-level freeform positioning (like Figma)? Grid-locked is simpler, more predictable, and responsive-friendly. Freeform is more powerful but breaks on different screen sizes.

2. **Per-breakpoint layouts?** Should users be able to set different arrangements for mobile vs desktop? This multiplies complexity significantly. Initial proposal: one layout, clamped at narrow breakpoints.

3. **Conflict with agent `move` ops?** If the agent issues a `move` op while the user has a custom layout, which wins? Proposal: user layout takes precedence — agent `move` ops update the `order` in `customLayouts` rather than overriding them.

4. **Multi-user layout isolation?** Phase 19 introduces per-user sessions. Custom layouts should be per-user. The `sessionKey` scoping already handles this — but need to verify the key is user-specific, not session-specific.

5. **Undo/redo?** Should drag/resize support Ctrl+Z? This would require a layout history stack. Nice-to-have for a later iteration.

6. **Maximum grid density?** On ultrawide (4 columns), a user could have 4×4 = 16 visible tiles without scrolling. Should we warn if the layout becomes too dense? Or let users decide?

7. **Component minimum size?** Some components (like `chart-bar`) look bad at `span 1`. The constraint system prevents this, but should we show a visual warning when a resize would make the content illegible?

8. **Lock layout?** Should there be a "lock layout" toggle that prevents accidental drag/resize? Useful once a user has their perfect arrangement. Simple implementation: hide handles, ignore pointer events on handles.
