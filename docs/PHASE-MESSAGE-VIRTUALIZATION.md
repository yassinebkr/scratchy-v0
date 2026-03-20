# Phase: Message Virtualization

## Overview

Scratchy currently renders **every message as a persistent DOM node**. For a typical session this is fine — 50–200 messages barely register. But power sessions accumulate 3,800+ messages, and the DOM becomes the bottleneck:

| Messages | DOM Nodes (est.) | Scroll FPS | Memory |
|----------|-----------------|------------|--------|
| 200      | ~1,200          | 60fps      | ~15MB  |
| 1,000    | ~6,000          | 45fps      | ~60MB  |
| 3,800    | ~23,000+        | 15-25fps   | ~200MB+|

**Root cause:** Each message creates a `.message` div with nested elements (`.message-body`, `.timestamp`, copy buttons, TTS buttons, code blocks with Prism highlighting, image thumbnails, lightbox handlers, collapsible wrappers). At 3,800 messages, the browser is maintaining ~23,000 DOM nodes, triggering expensive layout recalculations on every scroll frame and burning memory on event listeners, Blob URLs, and rendered markdown.

**Solution:** Virtual scrolling — only render the ~20–30 messages visible in the viewport (plus an overscan buffer), using a lightweight data model for everything else. DOM nodes are created on demand and recycled or destroyed as messages scroll out of view.

## Current Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  MessageStore (messagestore.js)                              │
│  ├── messages[]         ← sorted array, source of truth     │
│  ├── _hashIndex         ← contentHash → msg (dedup)         │
│  ├── _idIndex           ← id → msg (lookup)                 │
│  └── onChange(listener)  ← notifies on insert/update/reset  │
└──────────────────────┬───────────────────────────────────────┘
                       │ events: insert, update, finalize,
                       │         streaming-delta, reset
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  DOMSync (messagestore.js)                                   │
│  ├── _onInsert()   → renderer.createElement() + appendChild │
│  ├── _onUpdate()   → patch existing msg.el                  │
│  ├── _onFinalize() → replace streaming → final              │
│  ├── _onStreamingDelta() → throttled innerHTML update       │
│  └── _onReset()    → clear all, re-render from store        │
└──────────────────────┬───────────────────────────────────────┘
                       │ creates/mutates DOM
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  MessageRenderer (messages.js)                               │
│  ├── createElement(msg)  → builds full DOM node              │
│  ├── _scrollToBottom()   → scrollIntoView on last child     │
│  ├── _autoScroll         ← bool, toggled by scroll watcher  │
│  ├── _addCopyButtons()   → per code block                   │
│  ├── _addCollapsible()   → "See more" for long messages     │
│  ├── _highlightCode()    → Prism.js syntax highlighting     │
│  ├── _attachTtsHandler() → TTS button per agent message     │
│  └── _attachDeleteHandler() → tap-to-delete UI              │
└──────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  #messages container (DOM)                                   │
│  ├── .welcome-message (removed on first msg)                 │
│  ├── .compaction-marker                                      │
│  ├── .message.user        ← one per user message, ALWAYS    │
│  ├── .message.agent       ← one per agent message, ALWAYS   │
│  ├── .message.streaming   ← live typing bubble              │
│  ├── #activity-indicator  ← tool/thinking indicator          │
│  └── .compact-indicator   ← compaction progress              │
└──────────────────────────────────────────────────────────────┘
```

**Problem:** DOMSync's `_onReset()` calls `_onInsert()` for every message in the store. `_onInsert()` calls `renderer.createElement()` which builds the full DOM element — markdown rendering, Prism highlighting, copy buttons, event listeners. For 3,800 messages, that's 3,800 full DOM builds on history load.

## Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  MessageStore (unchanged — still the source of truth)        │
│  messages[] holds ALL messages, but msg.el is NO LONGER      │
│  guaranteed to exist. Only visible messages have DOM nodes.   │
└──────────────────────┬───────────────────────────────────────┘
                       │ events (unchanged API)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  VirtualScroller (NEW — web/js/virtual-scroller.js)          │
│  ├── _heightCache: Map<idx, number>                          │
│  ├── _estimatedHeight: number (default ~80px)                │
│  ├── _anchorIndex / _anchorOffset                            │
│  ├── _overscan: { above: 5, below: 5 }                      │
│  ├── _rendered: Set<idx> (currently mounted indices)         │
│  ├── _pool: Element[] (recycled DOM nodes)                   │
│  │                                                           │
│  │  Viewport Geometry:                                       │
│  │  ├── _sentinelTop: div (spacer above rendered range)      │
│  │  ├── _contentSlot: div (holds rendered messages)          │
│  │  └── _sentinelBot: div (spacer below rendered range)      │
│  │                                                           │
│  │  Public API:                                              │
│  │  ├── attach(container, store, renderer)                   │
│  │  ├── refresh()          → full recalc + re-render         │
│  │  ├── scrollToBottom()   → jump to end, enable auto-follow │
│  │  ├── scrollToIndex(idx) → jump to specific message        │
│  │  ├── onInsert(idx)      → handle new message              │
│  │  ├── onUpdate(idx)      → re-render single message        │
│  │  └── destroy()          → cleanup                         │
│  └───────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  DOMSync (MODIFIED — thin adapter)                           │
│  ├── _onInsert()   → virtualScroller.onInsert(idx)           │
│  ├── _onUpdate()   → virtualScroller.onUpdate(idx)           │
│  ├── _onFinalize() → virtualScroller.onUpdate(idx)           │
│  ├── _onStreamingDelta() → virtualScroller.onUpdate(idx)     │
│  └── _onReset()    → virtualScroller.refresh()               │
└──────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  #messages container (DOM) — VIRTUALIZED                     │
│  ├── .welcome-message | .compaction-marker                   │
│  ├── #vscroll-sentinel-top   ← height = sum of offscreen top │
│  ├── #vscroll-content        ← holds ONLY visible messages   │
│  │   ├── .message (idx=347)                                  │
│  │   ├── .message (idx=348)                                  │
│  │   ├── ...                  (~20-30 nodes)                 │
│  │   ├── .message (idx=372)                                  │
│  │   └── #activity-indicator  (always last)                  │
│  ├── #vscroll-sentinel-bot   ← height = sum of offscreen bot │
│  └── #scroll-bottom-btn                                      │
└──────────────────────────────────────────────────────────────┘
```

## Virtual Scrolling Algorithm

### Core Concept: Sentinel-Based Offsetting

The scroller maintains three container divs inside `#messages`:

1. **`_sentinelTop`** — an empty div whose `height` equals the total estimated height of all messages above the rendered range. Pushes rendered content to the correct scroll position.
2. **`_contentSlot`** — contains the actual rendered message DOM nodes (~20–30).
3. **`_sentinelBot`** — an empty div whose `height` equals the total estimated height of all messages below the rendered range. Ensures correct scrollbar size.

```
Total scroll height = sentinelTop.height + rendered content height + sentinelBot.height
```

### Viewport Calculation

On every scroll event (throttled via `requestAnimationFrame`):

```javascript
function _recalcViewport() {
  var scrollTop = container.scrollTop;
  var viewportHeight = container.clientHeight;
  var viewportBottom = scrollTop + viewportHeight;

  // Binary search: find first message whose cumulative offset
  // falls within scrollTop (visible range start)
  var firstVisible = _findIndexAtOffset(scrollTop);
  var lastVisible = _findIndexAtOffset(viewportBottom);

  // Apply overscan
  var renderStart = Math.max(0, firstVisible - OVERSCAN_ABOVE);
  var renderEnd = Math.min(store.messages.length - 1, lastVisible + OVERSCAN_BELOW);

  // Diff against current rendered range
  _updateRenderedRange(renderStart, renderEnd);
}
```

### Cumulative Offset Index

To make `_findIndexAtOffset()` fast, maintain a **prefix sum array** of message heights:

```javascript
// _offsets[i] = cumulative height of messages 0..i-1
// _offsets[0] = 0
// _offsets[n] = total height of all messages
//
// Height of message i = _offsets[i+1] - _offsets[i]
// Scroll position of message i = _offsets[i]
```

Binary search on `_offsets` gives O(log n) lookup — fine for 10,000+ messages.

**Rebuild strategy:** The full offset array only needs rebuilding when heights change (measurement, image load, expand/collapse). Day-to-day, appending a message is O(1) — just push one more entry.

### Overscan

Render extra messages above and below the viewport to prevent flicker during fast scrolling:

```javascript
var OVERSCAN_ABOVE = 5;  // 5 messages above viewport
var OVERSCAN_BELOW = 5;  // 5 messages below viewport
```

This means ~10 extra DOM nodes beyond what's visible. With a viewport showing ~20 messages, total rendered is ~30 — well within performance targets.

### Range Update (Diff-Based)

When the rendered range changes, compute the diff:

```javascript
function _updateRenderedRange(newStart, newEnd) {
  var oldStart = _renderStart;
  var oldEnd = _renderEnd;

  // Messages leaving the top
  for (var i = oldStart; i < newStart; i++) _unmountMessage(i);

  // Messages leaving the bottom
  for (var i = newEnd + 1; i <= oldEnd; i++) _unmountMessage(i);

  // Messages entering the top (prepend to _contentSlot)
  for (var i = Math.min(newStart, oldStart) - 1; i >= newStart; i--) {
    _mountMessage(i, "prepend");
  }

  // Messages entering the bottom (append to _contentSlot)
  for (var i = Math.max(newEnd, oldEnd) + 1; i <= newEnd; i++) {
    _mountMessage(i, "append");
  }

  _renderStart = newStart;
  _renderEnd = newEnd;

  // Update sentinel heights
  _sentinelTop.style.height = _offsets[newStart] + "px";
  _sentinelBot.style.height = (_offsets[totalCount] - _offsets[newEnd + 1]) + "px";
}
```

### Mount / Unmount

```javascript
function _mountMessage(idx, position) {
  var msg = store.messages[idx];
  var el = renderer.createElement(msg);
  msg.el = el;

  if (position === "prepend") {
    _contentSlot.insertBefore(el, _contentSlot.firstChild);
  } else {
    // Insert before activity indicator if present
    var activity = document.getElementById("activity-indicator");
    if (activity && activity.parentNode === _contentSlot) {
      _contentSlot.insertBefore(el, activity);
    } else {
      _contentSlot.appendChild(el);
    }
  }

  // Measure actual height and update cache
  _measureAndCache(idx, el);
}

function _unmountMessage(idx) {
  var msg = store.messages[idx];
  if (msg.el && msg.el.parentNode) {
    // Revoke TTS blob URL to prevent memory leak
    var ttsBtn = msg.el.querySelector(".tts-btn");
    if (ttsBtn && ttsBtn._blobUrl) {
      if (ttsBtn._audio) { ttsBtn._audio.pause(); ttsBtn._audio = null; }
      URL.revokeObjectURL(ttsBtn._blobUrl);
      ttsBtn._blobUrl = null;
    }
    msg.el.remove();
  }
  msg.el = null;
}
```

## Vanilla JS Approach

No frameworks, no virtual DOM libraries. Pure scroll math + DOM manipulation.

### Scroll Listener Strategy

Use a **passive scroll listener** with `requestAnimationFrame` coalescing:

```javascript
var _rafPending = false;

container.addEventListener("scroll", function() {
  if (!_rafPending) {
    _rafPending = true;
    requestAnimationFrame(function() {
      _rafPending = false;
      _recalcViewport();
    });
  }
}, { passive: true });
```

This ensures:
- **No jank:** Passive listener never blocks scroll.
- **No over-rendering:** rAF coalesces rapid scroll events into one recalc per frame.
- **Minimum overhead:** Binary search + range diff is ~0.1ms per frame.

### Why Not IntersectionObserver?

IntersectionObserver is appealing but has significant drawbacks for this use case:

1. **Requires existing DOM nodes** to observe — defeats the purpose of not creating them.
2. **Async callbacks** — introduces latency between scroll and render, causing flicker.
3. **No scroll direction awareness** — can't optimize for scroll direction.
4. **Threshold granularity** — hard to get precise "which messages are visible" with variable heights.

**Verdict:** Manual scroll math with rAF is simpler, faster, and more predictable for variable-height virtual scrolling.

### ResizeObserver for Height Changes

Use `ResizeObserver` on the `_contentSlot` to detect when rendered messages change height (image load, code expand, streaming delta):

```javascript
var _resizeObserver = new ResizeObserver(function(entries) {
  for (var i = 0; i < entries.length; i++) {
    var el = entries[i].target;
    var idx = _getIndexForElement(el);
    if (idx !== -1) {
      var newHeight = el.getBoundingClientRect().height;
      var oldHeight = _heightCache.get(idx) || _estimatedHeight;
      if (Math.abs(newHeight - oldHeight) > 1) {
        _heightCache.set(idx, newHeight);
        _rebuildOffsets();
        _recalcViewport();
      }
    }
  }
});
```

Observe each message element on mount, unobserve on unmount.

## Message Height Challenge

This is the hardest part of virtual scrolling. Messages have wildly variable heights:

| Content Type | Typical Height | Variability |
|-------------|---------------|-------------|
| Short user message | 48–60px | Low |
| Long user message | 80–300px | Medium |
| Agent text reply | 60–400px | High |
| Agent with code blocks | 200–800px | Very high |
| Agent with images | 300–600px | High (async load) |
| Canvas ops (no visible text) | 0–60px | Low |
| Streaming message | Changes every 80ms | Extreme |
| Collapsed (See more) | ~300px fixed | Fixed |
| Expanded (See more) | Unbounded | Very high |
| Compaction marker | ~40px | Fixed |
| System message | ~32px | Fixed |

### Height Estimation Strategy

**Three-tier approach:**

1. **Measured height** (best): Once a message has been rendered and measured, cache its height in `_heightCache`. This is the ground truth.

2. **Role-based estimate** (good): Before first render, estimate based on role and text length:
   ```javascript
   function _estimateHeight(msg) {
     if (msg.role === "compaction") return 40;
     if (msg.role === "system") return 32;
     var textLen = (msg.text || "").length;
     var hasCode = /```/.test(msg.text || "");
     var hasImages = msg.images && msg.images.length > 0;
     var base = msg.role === "user" ? 56 : 72;
     // ~1 line per 80 chars, ~24px per line
     var textHeight = Math.ceil(textLen / 80) * 24;
     if (hasCode) textHeight *= 1.5; // code blocks are taller
     if (hasImages) textHeight += 200 * msg.images.length;
     return Math.max(base, Math.min(base + textHeight, 600)); // cap at 600px
   }
   ```

3. **Global average** (fallback): Default `_estimatedHeight = 80px`, updated as a running average of measured heights.

### Handling Height Inaccuracy

Estimated heights will be wrong. The key insight: **it doesn't matter for scrollbar position as long as we correct on render.** When the user scrolls to a region, we render messages, measure them, update the offset array, and adjust sentinel heights. The scrollbar "snaps" subtly — imperceptible for small corrections.

For large corrections (jumping to a distant message via search), use **scroll anchoring** (see below).

## Scroll Behavior

### Auto-Follow (Scroll to Bottom)

The most common use case: user sends a message, agent replies, chat stays pinned to bottom.

```javascript
// _autoScroll is already tracked by MessageRenderer._initScrollWatcher()
// VirtualScroller hooks into it:

function scrollToBottom() {
  _autoScroll = true;
  // Render the last N messages
  var end = store.messages.length - 1;
  var start = Math.max(0, end - VIEWPORT_SIZE - OVERSCAN_BELOW);
  _updateRenderedRange(start, end);
  // Scroll container to max
  container.scrollTop = container.scrollHeight;
}
```

**On new message (auto-follow mode):**
1. `onInsert()` is called by DOMSync.
2. If `_autoScroll` is true AND the new message is at the end:
   - Mount the new message at the bottom of `_contentSlot`.
   - If rendered range exceeds max, unmount the oldest message.
   - Update `_sentinelTop` height.
   - Call `scrollToBottom()`.
3. If `_autoScroll` is false (user scrolled up):
   - Only update `_sentinelBot` height (to reflect new total).
   - Don't render or scroll — the new message is below the viewport.

### Jump to Message (Search)

When the user clicks a search result, we need to scroll to a specific message:

```javascript
function scrollToIndex(targetIdx) {
  // 1. Calculate estimated scroll position
  var targetOffset = _offsets[targetIdx];

  // 2. Set scrollTop (this triggers _recalcViewport which renders the range)
  container.scrollTop = targetOffset;

  // 3. After render, measure the actual target and adjust
  requestAnimationFrame(function() {
    var msg = store.messages[targetIdx];
    if (msg.el) {
      msg.el.scrollIntoView({ block: "center", behavior: "instant" });
      // Highlight the message briefly
      msg.el.classList.add("search-highlight");
      setTimeout(function() { msg.el.classList.remove("search-highlight"); }, 2000);
    }
  });

  _autoScroll = false;
}
```

### Scroll Anchoring During Prepend

When messages are inserted above the viewport (rare — e.g., out-of-order history correction via `_findInsertIndex`):

```javascript
function _onInsertAboveViewport(idx) {
  // Record current anchor
  var anchorMsg = store.messages[_renderStart];
  var anchorOffset = anchorMsg.el ? anchorMsg.el.offsetTop : 0;

  // Update offsets (new message shifts everything down)
  _rebuildOffsets();

  // Adjust scroll position to keep anchor in place
  var newAnchorOffset = _offsets[_renderStart + 1]; // shifted by 1
  var delta = newAnchorOffset - anchorOffset;
  container.scrollTop += delta;

  // Update sentinels
  _sentinelTop.style.height = _offsets[_renderStart] + "px";
}
```

### Smooth Scrolling

Use `behavior: "instant"` for virtual scroller operations (position corrections, range updates). Reserve `behavior: "smooth"` only for user-initiated actions like clicking the scroll-to-bottom button.

## Integration with MessageStore

### MessageStore Changes

**Minimal.** The store remains the source of truth. Key change:

- `msg.el` is no longer always populated. It's `null` for offscreen messages and set/cleared by the VirtualScroller during mount/unmount.

### DOMSync Changes

DOMSync becomes a **thin event router** between MessageStore and VirtualScroller:

```javascript
class DOMSync {
  constructor(store, container, renderer, virtualScroller) {
    this.store = store;
    this.vs = virtualScroller;

    store.onChange(function(type, msg, idx) {
      switch (type) {
        case "insert":
          vs.onInsert(msg, idx);
          break;
        case "update":
        case "finalize":
          vs.onUpdate(msg);
          break;
        case "streaming-delta":
          vs.onStreamingDelta(msg);
          break;
        case "reset":
          vs.refresh();
          break;
      }
    });
  }
}
```

The heavy rendering logic (`_onInsert`, `_onFinalize`, `_onStreamingDelta`, `_onReset`) moves from DOMSync into VirtualScroller, which decides **whether** to render based on visibility.

### MessageRenderer Changes

**None.** `createElement(msg)` continues to build full DOM elements. The VirtualScroller calls it only for visible messages. All post-processing (`_addCopyButtons`, `_highlightCode`, `_attachTtsHandler`, etc.) runs as before — just for fewer messages.

One enhancement: `_scrollToBottom()` delegates to `VirtualScroller.scrollToBottom()` instead of directly manipulating `container.scrollTop`.

## Edge Cases

### Images Loading (Async Height Change)

Images use `loading="lazy"`, so their height is 0 until loaded. This causes the message to "grow" after render.

**Solution:** `ResizeObserver` on mounted messages detects the height change → updates `_heightCache` → rebuilds offsets → adjusts sentinel heights. If the image is above the viewport, adjust `scrollTop` to prevent content jumping.

Optionally, set a minimum `aspect-ratio` or `min-height` on `.msg-attachments img` in CSS to reserve space:

```css
.msg-attachments img {
  min-height: 100px;
  aspect-ratio: 16/9; /* fallback until loaded */
}
```

### Code Blocks Expanding (Collapsible)

The "See more / See less" toggle changes message height dramatically. The `ResizeObserver` handles this automatically — it fires on any size change. The offset array rebuilds, sentinels adjust, scroll position stays anchored.

### Activity Indicator

The activity indicator (`#activity-indicator`) is **not a message** — it's a transient UI element. It should live inside `_contentSlot` but **after** all rendered messages, regardless of virtual scroll state.

```javascript
// Always append activity indicator after the last rendered message
function _ensureActivityPosition() {
  var indicator = document.getElementById("activity-indicator");
  if (indicator && _contentSlot) {
    _contentSlot.appendChild(indicator); // moves to end
  }
}
```

### Streaming Messages (Rapid Height Changes)

Streaming messages update every ~80ms (DOMSync already throttles this). During streaming:

1. The streaming message is always the **last message** in the store.
2. If `_autoScroll` is true, it's always in the rendered range.
3. Height changes on every delta — but since it's at the bottom and we're auto-following, we just need `scrollToBottom()` after each update.
4. **Don't re-measure on every delta** — only measure on finalize. During streaming, use the rendered height directly (it's already in the DOM).

### Compaction Indicator

Like the activity indicator, the compaction indicator (`.compact-indicator`) is transient. It lives inside `_contentSlot` at the bottom, after all messages. Managed the same way as the activity indicator.

### History Load (Bulk Insert)

When `loadHistory()` fires a "reset" event with potentially thousands of messages:

1. `VirtualScroller.refresh()` clears all rendered messages.
2. Estimates heights for all messages (using role-based estimation).
3. Builds the offset array.
4. If `_autoScroll` (default on fresh load): renders only the last ~30 messages and scrolls to bottom.
5. If jumping to a specific point (e.g., restoring scroll position): renders the range around that point.

**Critical:** No full-DOM build for 3,800 messages. Only ~30 elements are created.

### Deleting Messages

Current delete handler: fade-out animation → `el.remove()`. With virtualization:

1. Remove message from `store.messages`.
2. VirtualScroller detects the removal, recalculates offsets.
3. If the deleted message was in the rendered range, unmount it and mount the next message from outside the range.

### Session Switch

`store.switchSession()` triggers a "reset" → `VirtualScroller.refresh()`. All rendered messages are unmounted, state is cleared, and the new session's messages are loaded fresh.

## Performance Targets

| Metric | Current (3,800 msgs) | Target |
|--------|---------------------|--------|
| Max DOM message nodes | ~3,800 | **≤40** (30 visible + 10 overscan) |
| Total DOM nodes | ~23,000 | **≤500** |
| Scroll FPS | 15–25fps | **≥55fps** |
| Initial render (history load) | ~2–4s | **<200ms** |
| Memory (messages) | ~200MB | **<30MB** |
| `scrollToIndex()` latency | N/A (no virtual) | **<50ms** |
| `onInsert()` (new message) | ~5ms | **<3ms** |
| Streaming delta render | ~10ms (innerHTML) | **<5ms** |

### How to Measure

```javascript
// FPS monitor during scroll
var _fpsFrames = 0;
var _fpsLast = performance.now();
function _fpsTick() {
  _fpsFrames++;
  var now = performance.now();
  if (now - _fpsLast >= 1000) {
    console.log("[VScroll] Scroll FPS:", _fpsFrames);
    _fpsFrames = 0;
    _fpsLast = now;
  }
  if (_scrolling) requestAnimationFrame(_fpsTick);
}

// DOM node count
console.log("DOM nodes:", document.querySelectorAll("*").length);
console.log("Message nodes:", document.querySelectorAll(".message").length);
```

## Implementation Plan

### Step 1: VirtualScroller Class (new file)

**File:** `web/js/virtual-scroller.js`

Create the core VirtualScroller class with:
- Sentinel-based layout (`_sentinelTop`, `_contentSlot`, `_sentinelBot`)
- Height estimation and caching (`_heightCache`, `_offsets[]`)
- Scroll listener with rAF coalescing
- `_recalcViewport()` — binary search + range diff
- `_mountMessage()` / `_unmountMessage()`
- `scrollToBottom()`, `scrollToIndex()`
- `ResizeObserver` integration for height changes
- Scroll anchoring for above-viewport inserts

**No integration yet** — standalone class, unit-testable.

### Step 2: DOMSync Adapter

**File:** `web/js/messagestore.js` (modify DOMSync)

- Add `virtualScroller` parameter to DOMSync constructor.
- When a VirtualScroller is provided, route all events through it instead of direct DOM manipulation.
- When no VirtualScroller is provided, keep the current behavior (backward compat for simple cases or testing).

```javascript
class DOMSync {
  constructor(store, container, renderer, virtualScroller) {
    this.vs = virtualScroller || null;
    // ... existing setup, but branch on this.vs in handlers
  }
}
```

### Step 3: Wire into app.js

**File:** `web/js/app.js` (modify)

- Load `virtual-scroller.js` in `index.html`.
- Create VirtualScroller instance after MessageRenderer.
- Pass it to DOMSync constructor.
- Replace `renderer._scrollToBottom()` calls with `virtualScroller.scrollToBottom()`.
- Update search/jump-to-message to use `virtualScroller.scrollToIndex()`.

### Step 4: Activity/Streaming/Compaction Integration

**Files:** `web/js/messages.js`, `web/js/app.js`

- Ensure activity indicator, streaming message, and compaction indicator always live at the end of `_contentSlot`.
- The streaming message is special: it's always the last message, always mounted when `_autoScroll` is true, and its height changes are handled without full recalc.
- `showActivity()` / `hideActivity()` work within the virtual scroller's content slot.

### Step 5: Cleanup & TTS Memory Management

**File:** `web/js/messages.js`

- On `_unmountMessage()`: pause and revoke TTS blob URLs to prevent memory leaks.
- On `_unmountMessage()`: clear any click event listeners (delete handler, lightbox handlers).
- Consider: should we cache TTS blob URLs in the store (not the DOM element)? If a user plays TTS, scrolls away, scrolls back — should it be cached?

**Decision needed:** Store TTS cache on `msg` object (survives unmount) vs. on DOM element (current, lost on unmount).

### Step 6: CSS Adjustments

**File:** `web/css/` (minor)

- `.vscroll-sentinel` — invisible spacer div, `overflow: hidden`, `pointer-events: none`.
- `.search-highlight` — brief highlight animation for jump-to-message.
- Image `min-height` / `aspect-ratio` hints for pre-render sizing.

### Step 7: Testing & Performance Validation

- Load a session with 3,800+ messages.
- Verify scroll FPS ≥55 at all positions.
- Verify DOM node count ≤40 messages at all times.
- Verify search jump-to-message works.
- Verify auto-follow during streaming.
- Verify image load height correction.
- Verify TTS playback survives scroll-away + scroll-back.
- Verify delete animation works.
- Verify compaction marker renders correctly.

### File Change Summary

| File | Change | Scope |
|------|--------|-------|
| `web/js/virtual-scroller.js` | **NEW** | Core virtual scrolling engine |
| `web/js/messagestore.js` | **MODIFY** | DOMSync routes through VirtualScroller |
| `web/js/app.js` | **MODIFY** | Wire VirtualScroller, update scroll calls |
| `web/js/messages.js` | **MINOR** | `_scrollToBottom()` delegation, cleanup |
| `web/index.html` | **MINOR** | Add `<script>` for virtual-scroller.js |
| `web/css/chat.css` | **MINOR** | Sentinel styles, search highlight |

## Estimated Effort

| Step | Sessions | Description |
|------|----------|-------------|
| 1: VirtualScroller class | 2–3 | Core algorithm, height estimation, scroll math |
| 2: DOMSync adapter | 1 | Event routing, backward compat |
| 3: app.js wiring | 1 | Integration, initialization |
| 4: Activity/streaming | 1 | Edge case handling for transient elements |
| 5: Cleanup & TTS | 0.5 | Memory management on unmount |
| 6: CSS | 0.5 | Sentinel styles, highlights |
| 7: Testing | 1 | Performance validation, edge cases |
| **Total** | **7–8** | |

## Open Questions

1. **DOM Recycling vs. Destroy:** Should we maintain a pool of recycled DOM elements (clear innerHTML, re-populate) or destroy/create fresh? Recycling saves GC pressure but adds complexity. Given Scratchy's message complexity (event listeners, Prism highlighting, TTS state), **destroy + create** may be simpler and safer. Benchmark needed.

2. **TTS Cache Location:** When a user plays TTS on a message, the blob URL is cached on the DOM button element. If the message scrolls off and the element is destroyed, the cache is lost. Should we move TTS blob URLs to `msg.ttsCache` on the store object so they survive unmount/remount cycles?

3. **Collapsible State Persistence:** If a user expands a "See more" message, scrolls away, and scrolls back — should it still be expanded? Currently, `_addCollapsible()` defaults to collapsed. Options: (a) store expansion state on `msg.expanded`, (b) always re-collapse (simpler), (c) expand only the last message (current behavior).

4. **Height Cache Invalidation:** When does a cached height become stale? Obvious cases: window resize, font size change, theme switch. Should we listen for `window.resize` and invalidate all heights? Or only rebuild offsets?

5. **Canvas Ops Messages:** Some agent messages contain only `scratchy-canvas` blocks with no visible text. After canvas parsing, the chat text is empty. These messages have ~0px visible height. Should they be excluded from the virtual scroller entirely, or rendered as zero-height elements?

6. **Scroll Position Persistence:** Should we save/restore scroll position across page reloads? Currently, history load always scrolls to bottom. With virtualization, we could store `{ topIndex, offset }` in localStorage and restore the exact scroll position.

7. **Maximum Message Count:** Should we cap the store at N messages (e.g., 10,000) and discard the oldest? Virtual scrolling removes the DOM pressure, but the store array and offset array still grow. At 10,000 messages, the offset array is ~80KB — negligible. The store's text data is the real concern. Probably defer this to a separate phase.

8. **Graceful Degradation:** If `ResizeObserver` is not available (very old browsers), should we fall back to polling heights or disable virtualization entirely? `ResizeObserver` has 96%+ browser support as of 2025, so this may not matter.
