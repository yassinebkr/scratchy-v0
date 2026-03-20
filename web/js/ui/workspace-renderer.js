/**
 * WorkspaceRenderer — Phase 32
 *
 * Rendering engine for the Workspace view.  Creates / removes workspace cards,
 * updates component content via LiveComponents, handles card actions (collapse,
 * expand, unpin) and manages drag-to-reorder on both desktop and mobile.
 *
 * Exposed as  window.WorkspaceRenderer  (vanilla JS IIFE, no ES6 modules).
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                           */
  /* ------------------------------------------------------------------ */

  /** Relative-time formatter: "Just now", "12s ago", "5m ago", "3h ago", "2d ago" */
  function relativeTime(ts) {
    if (!ts) return "Just now";
    var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 10)   return "Just now";
    if (diff < 60)   return diff + "s ago";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  /** Resolve widget metadata (icon + title) from _widgetMeta or a sensible default. */
  function widgetMeta(widgetId) {
    var meta = window._widgetMeta || {};
    // Try exact match first, then prefix before first dash
    var prefix = widgetId.split("-")[0];
    var m = meta[widgetId] || meta[prefix];
    return m || { icon: "📌", title: widgetId };
  }

  /**
   * Default card sizes per widget type.
   * { w: grid-column span (1-4), h: pixel height or 0 for auto }
   * Optimized for each widget's content density — never too large.
   */
  var DEFAULT_WIDGET_SIZES = {
    admin:     { w: 2, h: 320 },
    analytics: { w: 2, h: 280 },
    cal:       { w: 1, h: 260 },
    mail:      { w: 2, h: 300 },
    sn:        { w: 1, h: 240 },
    yt:        { w: 2, h: 280 },
    sp:        { w: 1, h: 220 },
    spotify:   { w: 1, h: 220 },
    youtube:   { w: 2, h: 280 },
    onboard:   { w: 1, h: 200 }
  };

  /** Get default size for a widget based on its prefix. */
  function defaultWidgetSize(widgetId) {
    var prefix = widgetId.split("-")[0];
    return DEFAULT_WIDGET_SIZES[prefix] || { w: 1, h: 0 };
  }

  /** Create a DOM element with optional className and textContent. */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Closest ancestor matching a class name (IE-safe). */
  function closestClass(target, cls) {
    var node = target;
    while (node && node !== document) {
      if (node.classList && node.classList.contains(cls)) return node;
      node = node.parentNode;
    }
    return null;
  }

  /** Create a fallback component element when LiveComponents is unavailable. */
  function fallbackComponent(type, data) {
    var wrapper = el("div", "workspace-fallback-component");
    wrapper.setAttribute("data-type", type || "unknown");
    var label = el("div", "workspace-fallback-label", type || "component");
    wrapper.appendChild(label);
    if (data) {
      var pre = el("pre", "workspace-fallback-data");
      try { pre.textContent = JSON.stringify(data, null, 2); } catch (e) { pre.textContent = String(data); }
      wrapper.appendChild(pre);
    }
    return {
      el: wrapper,
      update: function (newData) {
        var target = wrapper.querySelector(".workspace-fallback-data");
        if (!target) {
          target = el("pre", "workspace-fallback-data");
          wrapper.appendChild(target);
        }
        try { target.textContent = JSON.stringify(newData, null, 2); } catch (e) { target.textContent = String(newData); }
      }
    };
  }

  /** Create (or fallback) a LiveComponent for a canvas component record. */
  function createLiveComponent(comp) {
    if (window.LiveComponents && typeof window.LiveComponents.create === "function") {
      try {
        return window.LiveComponents.create(comp.type, comp.data);
      } catch (e) {
        // Fallback on error
      }
    }
    return fallbackComponent(comp.type, comp.data);
  }

  /* ------------------------------------------------------------------ */
  /*  WorkspaceRenderer                                                 */
  /* ------------------------------------------------------------------ */

  function WorkspaceRenderer(options) {
    this.container      = options.container;
    this.store          = options.workspaceStore;
    this.canvasState    = options.canvasState;
    this.emptyEl        = options.emptyEl;

    this._cards          = {};   // widgetId → DOM element
    this._liveComponents = {};   // componentId → {el, update}
    this._dragState      = null;
    this._timestampTimer = null;

    // Bound handlers we'll need to unsubscribe later
    this._boundOnStoreChange  = this._onStoreChange.bind(this);
    this._boundOnCanvasChange = this._onCanvasChange.bind(this);
    this._boundOnClick        = this._onContainerClick.bind(this);
    // Drag is now per-card (attached in _initCardDrag) — no container-level handlers needed

    this._init();
  }

  var proto = WorkspaceRenderer.prototype;

  /* ---- Initialisation --------------------------------------------- */

  proto._init = function () {
    // Subscribe to store changes
    if (this.store && typeof this.store.onChange === "function") {
      this._storeUnsub = this.store.onChange(this._boundOnStoreChange);
    }
    if (this.canvasState && typeof this.canvasState.onChange === "function") {
      this._canvasUnsub = this.canvasState.onChange(this._boundOnCanvasChange);
    }

    // Delegated click handler for card actions
    this.container.addEventListener("click", this._boundOnClick);

    // Drag is per-card — no container-level drag listeners needed

    // Initial render from current store state
    this._renderAll();

    // Periodic timestamp refresh (every 30s)
    var self = this;
    this._timestampTimer = setInterval(function () {
      self._refreshAllTimestamps();
    }, 30000);
  };

  /* ---- Store change handler --------------------------------------- */

  proto._onStoreChange = function (type, data) {
    switch (type) {
      case "pin":
        this._createCard(data.widgetId || data.id, data);
        this._updateEmpty();
        break;

      case "unpin":
        this._removeCard(data.widgetId || data.id || data);
        this._updateEmpty();
        break;

      case "collapse":
        var card = this._cards[data.widgetId || data.id];
        if (card) card.classList.toggle("collapsed", !!data.collapsed);
        break;

      case "update":
        // A pin's metadata changed — refresh title / icon
        if (data && (data.widgetId || data.id)) {
          this._refreshCardHeader(data.widgetId || data.id, data);
        }
        break;

      case "resize":
        // Optional: could adjust card sizing classes here
        break;

      case "reset":
        this._clearAll();
        this._renderAll();
        break;

      default:
        // Unknown type — full rebuild to be safe
        this._clearAll();
        this._renderAll();
        break;
    }
  };

  /* ---- Canvas change handler -------------------------------------- */

  proto._onCanvasChange = function (type, component) {
    if (!component || !component.id) return;

    var compId = component.id;
    var lc = this._liveComponents[compId];

    if (type === "remove" || type === "delete") {
      // Component removed — clean up tile wrapper and maybe show placeholder
      if (lc) {
        // Remove the wrapping .dash-tile (or the el itself if no wrapper)
        var tileWrapper = lc.el && lc.el.closest ? lc.el.closest('.dash-tile') : null;
        if (tileWrapper && tileWrapper.parentNode) {
          tileWrapper.parentNode.removeChild(tileWrapper);
        } else if (lc.el && lc.el.parentNode) {
          lc.el.parentNode.removeChild(lc.el);
        }
        delete this._liveComponents[compId];
      }
      this._checkCardEmpty(compId);
      return;
    }

    // Update or upsert
    if (lc) {
      // Already tracked — patch the live component
      if (typeof lc.update === "function" && component.data) {
        lc.update(component.data);
      }
      // Update timestamp on the owning card
      this._touchCardTimestamp(compId);
    } else {
      // Not yet tracked — might belong to a newly-pinned widget;
      // find the card that owns this component and add it
      this._tryInsertComponent(component);
    }

    // Keep saved component data fresh in the store (for offline restore after refresh)
    if (component.type && component.data && this.store) {
      var pins = this.store.getPins();
      for (var pi = 0; pi < pins.length; pi++) {
        var pin = pins[pi];
        if (pin.componentIds && pin.componentIds.indexOf(compId) !== -1) {
          this.store.updateComponentData(pin.widgetId, compId, { type: component.type, data: component.data });
          break;
        }
      }
    }
  };

  /* ---- Card creation ---------------------------------------------- */

  proto._createCard = function (widgetId, pin, staggerIndex) {
    if (this._cards[widgetId]) return; // already exists

    var meta = widgetMeta(widgetId);
    // Prefer pin record's title/icon over generic metadata
    var cardTitle = pin.title || meta.title;
    var cardIcon = pin.icon || meta.icon;

    var card = el("div", "workspace-card");
    card.setAttribute("data-widget-id", widgetId);
    card.setAttribute("data-pinned-at", pin.pinnedAt || Date.now());

    // -- Header
    var header = el("div", "workspace-card-header");
    var icon   = el("span", "workspace-card-icon", cardIcon);
    var title  = el("span", "workspace-card-title", cardTitle);
    var actions = el("div", "workspace-card-actions");

    var btnCollapse = el("button", "wc-action", "\u2212"); // −
    btnCollapse.setAttribute("data-action", "collapse");
    btnCollapse.title = "Collapse";

    var btnExpand = el("button", "wc-action", "\u2922"); // ⤢
    btnExpand.setAttribute("data-action", "expand");
    btnExpand.title = "Expand";

    var btnUnpin = el("button", "wc-action", "\u2715"); // ✕
    btnUnpin.setAttribute("data-action", "unpin");
    btnUnpin.title = "Unpin";

    actions.appendChild(btnCollapse);
    actions.appendChild(btnExpand);
    actions.appendChild(btnUnpin);
    header.appendChild(icon);
    header.appendChild(title);
    header.appendChild(actions);

    // -- Body
    var body = el("div", "workspace-card-body");
    var grid = el("div", "canvas-grid");
    grid.setAttribute("data-layout", "auto");

    var componentIds = pin.componentIds || [];
    var savedData = pin.componentData || {};
    var components = this.canvasState ? this.canvasState.components : null;

    for (var i = 0; i < componentIds.length; i++) {
      var cid = componentIds[i];
      // Try canvasState first, then fall back to saved snapshot data
      var comp = components && (typeof components.get === "function" ? components.get(cid) : components[cid]);
      if (!comp && savedData[cid]) {
        comp = { id: cid, type: savedData[cid].type, data: savedData[cid].data };
      }
      if (comp) {
        var lc = createLiveComponent(comp);
        if (lc && lc.el) {
          var tile = document.createElement("div");
          tile.className = "dash-tile";
          tile.dataset.componentId = cid;
          tile.dataset.type = comp.type || "";
          tile.appendChild(lc.el);
          grid.appendChild(tile);
          this._liveComponents[cid] = lc;
        }
      }
    }

    body.appendChild(grid);

    // -- Footer
    var footer = el("div", "workspace-card-footer");
    var updated = el("span", "workspace-card-updated", "Just now");
    var liveDot = el("span", "workspace-card-live-dot");
    footer.appendChild(updated);
    footer.appendChild(liveDot);

    // -- Resize handle (bottom-right corner arc)
    var resizeHandle = el("div", "workspace-card-resize");
    resizeHandle.title = "Resize";
    resizeHandle.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M11 1C11 5.5 5.5 11 1 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>';

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(footer);
    card.appendChild(resizeHandle);

    // Wire resize handle
    this._initResize(card, resizeHandle, widgetId);

    // Wire drag directly to this card's header
    this._initCardDrag(card, header, widgetId);

    // Collapsed state
    if (pin.collapsed) card.classList.add("collapsed");

    // Restore saved size OR apply default size for this widget type
    var hasCustomSize = pin.size && (pin.size.w > 1 || pin.size.h > 120);
    if (hasCustomSize) {
      if (pin.size.w && pin.size.w > 1) card.setAttribute("data-size-w", String(pin.size.w));
      if (pin.size.h && pin.size.h > 120) card.style.height = pin.size.h + "px";
    } else {
      var defSize = defaultWidgetSize(widgetId);
      if (defSize.w > 1) card.setAttribute("data-size-w", String(defSize.w));
      if (defSize.h > 120) card.style.height = defSize.h + "px";
    }

    // Entrance animation (staggered)
    var delay = typeof staggerIndex === "number" ? staggerIndex * 60 : 0;
    card.style.opacity = "0";
    card.style.transform = "translateY(12px) scale(0.97)";
    card.style.transition = "opacity 250ms ease, transform 250ms ease";

    this.container.appendChild(card);
    this._cards[widgetId] = card;

    // Trigger entrance after stagger, then clear inline styles
    requestAnimationFrame(function () {
      setTimeout(function () {
        card.style.opacity = "1";
        card.style.transform = "translateY(0) scale(1)";
        // Clear inline styles after animation completes so they don't
        // override CSS class styles during drag/resize
        setTimeout(function () {
          card.style.opacity = "";
          card.style.transform = "";
          card.style.transition = "";
          // Detect truncation on workspace tiles after render
          if (typeof _detectAllTruncations === "function") {
            _detectAllTruncations(card);
          } else if (typeof window._detectAllTruncations === "function") {
            window._detectAllTruncations(card);
          }
        }, 300);
      }, delay);
    });
  };

  /* ---- Card removal ----------------------------------------------- */

  proto._removeCard = function (widgetId) {
    var card = this._cards[widgetId];
    if (!card) return;

    // Clean up LiveComponents owned by this card
    var grid = card.querySelector(".canvas-grid");
    if (grid) {
      var self = this;
      var keys = Object.keys(this._liveComponents);
      for (var i = 0; i < keys.length; i++) {
        var cid = keys[i];
        var lc = this._liveComponents[cid];
        if (lc && lc.el && grid.contains(lc.el)) {
          delete self._liveComponents[cid];
        }
      }
    }

    // Animate out
    card.style.transition = "opacity 200ms ease, transform 200ms ease";
    card.style.opacity = "0";
    card.style.transform = "scale(0.95)";

    var container = this.container;
    var cards = this._cards;
    setTimeout(function () {
      if (card.parentNode) card.parentNode.removeChild(card);
      delete cards[widgetId];
    }, 210);
  };

  /* ---- Empty state ------------------------------------------------ */

  proto._updateEmpty = function () {
    if (!this.emptyEl) return;
    var hasCards = Object.keys(this._cards).length > 0;
    this.emptyEl.style.display = hasCards ? "none" : "";
  };

  /* ---- Timestamp helpers ------------------------------------------ */

  proto._updateTimestamp = function (widgetId) {
    var card = this._cards[widgetId];
    if (!card) return;
    var span = card.querySelector(".workspace-card-updated");
    if (!span) return;
    var pinnedAt = parseInt(card.getAttribute("data-pinned-at"), 10) || Date.now();
    // Use lastUpdated stashed on card, or pinnedAt
    var ts = card._lastUpdated || pinnedAt;
    span.textContent = relativeTime(ts);
  };

  proto._touchCardTimestamp = function (componentId) {
    // Find the card containing this component and mark it updated
    var keys = Object.keys(this._cards);
    for (var i = 0; i < keys.length; i++) {
      var wid = keys[i];
      var card = this._cards[wid];
      var lc = this._liveComponents[componentId];
      if (lc && lc.el && card.contains(lc.el)) {
        card._lastUpdated = Date.now();
        this._updateTimestamp(wid);
        break;
      }
    }
  };

  proto._refreshAllTimestamps = function () {
    var keys = Object.keys(this._cards);
    for (var i = 0; i < keys.length; i++) {
      this._updateTimestamp(keys[i]);
    }
  };

  /* ---- Header refresh --------------------------------------------- */

  proto._refreshCardHeader = function (widgetId, pin) {
    var card = this._cards[widgetId];
    if (!card) return;
    var meta = widgetMeta(widgetId);
    var iconEl = card.querySelector(".workspace-card-icon");
    var titleEl = card.querySelector(".workspace-card-title");
    if (iconEl) iconEl.textContent = meta.icon;
    if (titleEl) titleEl.textContent = meta.title;
  };

  /* ---- Component helpers ------------------------------------------ */

  /**
   * After a canvas change adds a new component, check if any existing card
   * should contain it and insert it.
   */
  proto._tryInsertComponent = function (component) {
    if (!this.store || typeof this.store.getPins !== "function") return;
    var pins = this.store.getPins(); // returns array
    for (var i = 0; i < pins.length; i++) {
      var pin = pins[i];
      var wid = pin.widgetId || pin.id;
      var ids = pin.componentIds || [];
      if (ids.indexOf(component.id) !== -1) {
        var card = this._cards[wid];
        if (!card) continue;
        var grid = card.querySelector(".canvas-grid");
        if (!grid) continue;
        var lc = createLiveComponent(component);
        if (lc && lc.el) {
          var tile = document.createElement("div");
          tile.className = "dash-tile";
          tile.dataset.componentId = component.id;
          tile.dataset.type = component.type || "";
          tile.appendChild(lc.el);
          grid.appendChild(tile);
          this._liveComponents[component.id] = lc;
          card._lastUpdated = Date.now();
          this._updateTimestamp(wid);
          // Detect truncation on new tile
          if (typeof window._detectAllTruncations === "function") {
            requestAnimationFrame(function() { window._detectAllTruncations(card); });
          }
        }
        break;
      }
    }
  };

  /**
   * After a component is removed, check if its owning card is now empty
   * and show a placeholder if so.
   */
  proto._checkCardEmpty = function (componentId) {
    var keys = Object.keys(this._cards);
    for (var i = 0; i < keys.length; i++) {
      var wid = keys[i];
      var card = this._cards[wid];
      var grid = card.querySelector(".canvas-grid");
      if (!grid) continue;
      if (grid.children.length === 0) {
        var placeholder = el("div", "workspace-card-empty", "No components");
        grid.appendChild(placeholder);
      }
    }
  };

  /* ---- Full render / clear ---------------------------------------- */

  proto._renderAll = function () {
    if (!this.store || typeof this.store.getPins !== "function") {
      this._updateEmpty();
      return;
    }
    var pins = this.store.getPins(); // returns array of pin records

    for (var i = 0; i < pins.length; i++) {
      var pin = pins[i];
      var wid = pin.widgetId || pin.id || ("pin-" + i);
      this._createCard(wid, pin, i);
    }
    this._updateEmpty();
  };

  proto._clearAll = function () {
    // Remove all cards without animation
    var keys = Object.keys(this._cards);
    for (var i = 0; i < keys.length; i++) {
      var card = this._cards[keys[i]];
      if (card && card.parentNode) card.parentNode.removeChild(card);
    }
    this._cards = {};
    this._liveComponents = {};
  };

  /* ---- Card action handler (delegated) ---------------------------- */

  proto._onContainerClick = function (e) {
    var btn = closestClass(e.target, "wc-action");
    if (!btn) return;

    var action = btn.getAttribute("data-action");
    var card = closestClass(btn, "workspace-card");
    if (!card) return;

    var widgetId = card.getAttribute("data-widget-id");
    if (!widgetId) return;

    switch (action) {
      case "collapse":
        if (this.store && typeof this.store.toggleCollapse === "function") {
          this.store.toggleCollapse(widgetId);
        } else {
          // Fallback: toggle class directly
          card.classList.toggle("collapsed");
        }
        break;

      case "expand":
        this._expandCard(widgetId, card);
        break;

      case "unpin":
        if (this.store && typeof this.store.unpin === "function") {
          this.store.unpin(widgetId);
        }
        break;
    }
  };

  /* ---- Expand / Focus overlay ------------------------------------- */

  proto._expandCard = function (widgetId, card) {
    // Dispatch custom event for app.js to handle (focus overlay pattern)
    var evt;
    try {
      evt = new CustomEvent("workspace-expand", {
        bubbles: true,
        detail: { widgetId: widgetId, cardEl: card }
      });
    } catch (e) {
      // IE fallback
      evt = document.createEvent("CustomEvent");
      evt.initCustomEvent("workspace-expand", true, true, { widgetId: widgetId, cardEl: card });
    }
    card.dispatchEvent(evt);
  };

  /* ---- Per-card drag to reorder ----------------------------------- */

  proto._initCardDrag = function (card, header, widgetId) {
    var self = this;

    function onMouseDown(e) {
      if (closestClass(e.target, "wc-action")) return;
      var startX = e.clientX;
      var startY = e.clientY;
      var dragTimer = null;
      var cancelled = false;

      function onEarlyMove(ev) {
        if (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5) {
          clearTimeout(dragTimer);
          cancelled = true;
          cleanup();
        }
      }
      function onEarlyUp() {
        clearTimeout(dragTimer);
        cancelled = true;
        cleanup();
      }
      function cleanup() {
        document.removeEventListener("mousemove", onEarlyMove);
        document.removeEventListener("mouseup", onEarlyUp);
      }

      document.addEventListener("mousemove", onEarlyMove);
      document.addEventListener("mouseup", onEarlyUp);

      dragTimer = setTimeout(function () {
        if (cancelled) return;
        cleanup();
        self._startDrag(card, startX, startY, false);
      }, 150);
    }

    function onTouchStart(e) {
      if (closestClass(e.target, "wc-action")) return;
      var touch = e.touches[0];
      var startX = touch.clientX;
      var startY = touch.clientY;
      var dragTimer = null;
      var cancelled = false;

      function onTouchMove(ev) {
        var t = ev.touches[0];
        if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
          clearTimeout(dragTimer);
          cancelled = true;
          cleanup();
        }
      }
      function onTouchEnd() {
        clearTimeout(dragTimer);
        cancelled = true;
        cleanup();
      }
      function cleanup() {
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
        document.removeEventListener("touchcancel", onTouchEnd);
      }

      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
      document.addEventListener("touchcancel", onTouchEnd);

      dragTimer = setTimeout(function () {
        if (cancelled) return;
        cleanup();
        self._startDrag(card, startX, startY, true);
      }, 500);
    }

    header.addEventListener("mousedown", onMouseDown);
    header.addEventListener("touchstart", onTouchStart, { passive: false });
  };

  /* ---- Shared drag logic ------------------------------------------ */

  proto._startDrag = function (card, startX, startY, isTouch) {
    var self = this;
    var rect = card.getBoundingClientRect();
    var offsetX = startX - rect.left;
    var offsetY = startY - rect.top;
    var savedHeight = card.style.height;
    var savedSizeW = card.getAttribute("data-size-w");

    // Create placeholder
    var placeholder = el("div", "workspace-card-placeholder");
    placeholder.style.width = rect.width + "px";
    placeholder.style.height = rect.height + "px";
    if (savedSizeW) placeholder.setAttribute("data-size-w", savedSizeW);
    card.parentNode.insertBefore(placeholder, card);

    // Move card to body so it's not inside the grid during drag
    // (prevents grid layout from interfering with position: fixed)
    document.body.appendChild(card);

    // Mark grid as active drag target (enables smooth CSS transitions on siblings)
    self.container.classList.add("dragging-active");

    // Lift card
    card.classList.add("dragging");
    card.style.position = "fixed";
    card.style.zIndex = "9999";
    card.style.width = rect.width + "px";
    card.style.height = rect.height + "px";
    card.style.left = (startX - offsetX) + "px";
    card.style.top = (startY - offsetY) + "px";
    card.style.pointerEvents = "none";

    this._dragState = {
      card: card,
      placeholder: placeholder,
      offsetX: offsetX,
      offsetY: offsetY,
      widgetId: card.getAttribute("data-widget-id")
    };

    function onMove(ev) {
      var cx, cy;
      if (isTouch) {
        if (ev.touches && ev.touches.length) {
          cx = ev.touches[0].clientX;
          cy = ev.touches[0].clientY;
          ev.preventDefault();
        } else { return; }
      } else {
        cx = ev.clientX;
        cy = ev.clientY;
      }

      requestAnimationFrame(function () {
        if (!self._dragState) return;
        card.style.left = (cx - offsetX) + "px";
        card.style.top = (cy - offsetY) + "px";

        // Detect drop target — card is on body now, so elementFromPoint sees grid children
        var target = document.elementFromPoint(cx, cy);
        if (!target) return;

        // Check if hovering over the placeholder itself — skip
        if (closestClass(target, "workspace-card-placeholder")) return;

        var targetCard = closestClass(target, "workspace-card");
        if (targetCard && targetCard !== card) {
          var targetRect = targetCard.getBoundingClientRect();
          var midY = targetRect.top + targetRect.height / 2;
          if (cy < midY) {
            self.container.insertBefore(placeholder, targetCard);
          } else {
            self.container.insertBefore(placeholder, targetCard.nextSibling);
          }
        } else if (closestClass(target, "workspace-grid") && !targetCard) {
          // Hovering over empty grid area — move placeholder to end
          self.container.appendChild(placeholder);
        }
      });
    }

    function onEnd() {
      if (!self._dragState) return;

      // Snap card back to placeholder position with smooth animation
      var phRect = placeholder.getBoundingClientRect();
      card.style.transition = "left 220ms cubic-bezier(0.2, 0, 0, 1), top 220ms cubic-bezier(0.2, 0, 0, 1), transform 220ms cubic-bezier(0.2, 0, 0, 1)";
      card.style.left = phRect.left + "px";
      card.style.top = phRect.top + "px";
      card.style.transform = "scale(1) rotate(0deg)";

      setTimeout(function () {
        card.classList.remove("dragging");
        card.style.position = "";
        card.style.zIndex = "";
        card.style.width = "";
        card.style.height = savedHeight || "";
        card.style.left = "";
        card.style.top = "";
        card.style.pointerEvents = "";
        card.style.transition = "";
        card.style.transform = "";

        self.container.classList.remove("dragging-active");

        // Move card back into grid at placeholder's position
        if (placeholder.parentNode) {
          placeholder.parentNode.insertBefore(card, placeholder);
          placeholder.parentNode.removeChild(placeholder);
        } else {
          // Fallback: just append back to container
          self.container.appendChild(card);
        }

        self._persistOrder();
        self._dragState = null;
      }, 230);

      if (isTouch) {
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
        document.removeEventListener("touchcancel", onEnd);
      } else {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onEnd);
      }
    }

    if (isTouch) {
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
      document.addEventListener("touchcancel", onEnd);
    } else {
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onEnd);
    }
  };

  /** Read DOM order and persist to store. */
  proto._persistOrder = function () {
    var children = this.container.children;
    var order = [];
    for (var i = 0; i < children.length; i++) {
      var wid = children[i].getAttribute("data-widget-id");
      if (wid) order.push(wid);
    }
    if (this.store && typeof this.store.reorder === "function") {
      this.store.reorder(order);
    }
  };

  /* ---- Destroy ----------------------------------------------------- */

  /* ---- Resize (width: grid-span, height: pixel) ------------------- */

  proto._initResize = function (card, handle, widgetId) {
    var self = this;

    function onPointerDown(e) {
      e.preventDefault();
      e.stopPropagation();

      var touch = e.touches && e.touches[0];
      var cx0 = touch ? touch.clientX : e.clientX;
      var cy0 = touch ? touch.clientY : e.clientY;
      var cardRect = card.getBoundingClientRect();
      var startW = cardRect.width;
      var startH = cardRect.height;

      // Grid info for horizontal snap
      var grid = self.container;
      var gridStyle = getComputedStyle(grid);
      var colWidths = gridStyle.gridTemplateColumns.split(" ");
      var cols = colWidths.length || 1;
      var gridRect = grid.getBoundingClientRect();
      var gap = parseFloat(gridStyle.gap) || 12;
      var pad = parseFloat(gridStyle.paddingLeft) || 16;
      var colWidth = (gridRect.width - pad * 2 - gap * (cols - 1)) / cols;
      var prevSpan = parseInt(card.getAttribute("data-size-w")) || 1;

      card.classList.add("resizing");

      function onPointerMove(ev) {
        var t = ev.touches && ev.touches[0];
        var cx = t ? t.clientX : ev.clientX;
        var cy = t ? t.clientY : ev.clientY;
        if (t) ev.preventDefault();

        // Horizontal: snap to grid column span (only on multi-column layouts)
        if (cols > 1) {
          var deltaX = cx - cx0;
          var targetSpan = Math.max(1, Math.min(cols, Math.round((startW + deltaX) / (colWidth + gap))));
          if (targetSpan !== prevSpan) {
            if (targetSpan === 1) {
              card.removeAttribute("data-size-w");
            } else {
              card.setAttribute("data-size-w", String(targetSpan));
            }
            prevSpan = targetSpan;
          }
        }

        // Vertical: free pixel height (min 120px)
        var deltaY = cy - cy0;
        var newH = Math.max(120, startH + deltaY);
        card.style.height = newH + "px";

        // Auto-scroll grid when card bottom goes below viewport
        var cardBottom = card.getBoundingClientRect().bottom;
        var gridBottom = grid.getBoundingClientRect().bottom;
        if (cardBottom > gridBottom - 20) {
          grid.scrollTop += 16;
        }
      }

      function onPointerUp() {
        card.classList.remove("resizing");

        // Persist to store
        var finalW = parseInt(card.getAttribute("data-size-w")) || 1;
        var finalH = card.style.height ? parseInt(card.style.height) : null;
        if (self.store && typeof self.store.resize === "function") {
          self.store.resize(widgetId, { w: finalW, h: finalH || 0 });
        }

        document.removeEventListener("mousemove", onPointerMove);
        document.removeEventListener("mouseup", onPointerUp);
        document.removeEventListener("touchmove", onPointerMove);
        document.removeEventListener("touchend", onPointerUp);
      }

      document.addEventListener("mousemove", onPointerMove);
      document.addEventListener("mouseup", onPointerUp);
      document.addEventListener("touchmove", onPointerMove, { passive: false });
      document.addEventListener("touchend", onPointerUp);
    }

    handle.addEventListener("mousedown", onPointerDown);
    handle.addEventListener("touchstart", onPointerDown, { passive: false });
  };

  proto.destroy = function () {
    // Unsubscribe from stores
    if (typeof this._storeUnsub === "function") this._storeUnsub();
    if (typeof this._canvasUnsub === "function") this._canvasUnsub();

    // Clear timestamp timer
    if (this._timestampTimer) {
      clearInterval(this._timestampTimer);
      this._timestampTimer = null;
    }

    // Remove event listeners
    this.container.removeEventListener("click", this._boundOnClick);

    // Remove all cards
    this._clearAll();

    // Cancel any in-progress drag
    this._dragState = null;
  };

  /* ---- Expose ------------------------------------------------------ */

  window.WorkspaceRenderer = WorkspaceRenderer;

})();
