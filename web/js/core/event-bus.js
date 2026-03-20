// Scratchy Event Bus — lightweight pub/sub
// No dependencies. IIFE pattern. Exposes window.ScratchyBus singleton.
(function() {
  "use strict";

  function EventBus() {
    this._handlers = new Map();
    this._onceHandlers = new Map();
    this._debugging = false;
  }

  EventBus.prototype.on = function(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return this;
  };

  EventBus.prototype.once = function(event, fn) {
    if (!this._onceHandlers.has(event)) this._onceHandlers.set(event, []);
    this._onceHandlers.get(event).push(fn);
    return this;
  };

  EventBus.prototype.off = function(event, fn) {
    if (fn) {
      var list = this._handlers.get(event);
      if (list) {
        this._handlers.set(event, list.filter(function(h) { return h !== fn; }));
      }
      var once = this._onceHandlers.get(event);
      if (once) {
        this._onceHandlers.set(event, once.filter(function(h) { return h !== fn; }));
      }
    } else {
      this._handlers.delete(event);
      this._onceHandlers.delete(event);
    }
    return this;
  };

  EventBus.prototype.emit = function(event, data) {
    if (this._debugging) {
      console.log("[ScratchyBus]", event, data);
    }
    var handlers = this._handlers.get(event);
    if (handlers) {
      for (var i = 0; i < handlers.length; i++) {
        try { handlers[i](data); } catch(e) { console.error("[ScratchyBus] Handler error on " + event + ":", e); }
      }
    }
    var once = this._onceHandlers.get(event);
    if (once && once.length) {
      this._onceHandlers.delete(event);
      for (var j = 0; j < once.length; j++) {
        try { once[j](data); } catch(e) { console.error("[ScratchyBus] Once handler error on " + event + ":", e); }
      }
    }
  };

  EventBus.prototype.debug = function(enabled) {
    this._debugging = !!enabled;
    console.log("[ScratchyBus] Debug " + (this._debugging ? "ON" : "OFF"));
    return this;
  };

  window.ScratchyBus = new EventBus();
})();
