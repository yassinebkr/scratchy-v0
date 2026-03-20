/**
 * WidgetEventBus - Inter-Widget Communication System
 * Enables autonomous widgets to communicate and coordinate
 */

class WidgetEventBus {
  constructor() {
    this.registeredWidgets = new Map();
    this.eventHistory = [];
    this.maxHistorySize = 1000;
    this.debugMode = false;
  }

  /**
   * Register a widget to receive events
   */
  registerWidget(widgetId, widget) {
    this.registeredWidgets.set(widgetId, {
      widget,
      interestedEvents: widget.interestedEvents || [],
      metadata: {
        type: widget.constructor.name,
        registeredAt: Date.now()
      }
    });
    
    if (this.debugMode) {
      console.log(`🔌 Widget registered: ${widgetId} (${widget.constructor.name})`);
    }
  }

  /**
   * Unregister a widget
   */
  unregisterWidget(widgetId) {
    const removed = this.registeredWidgets.delete(widgetId);
    if (this.debugMode && removed) {
      console.log(`🔌 Widget unregistered: ${widgetId}`);
    }
    return removed;
  }

  /**
   * Emit event to interested widgets
   */
  emit(eventType, data = {}, sourceWidgetId = null) {
    const eventId = `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const event = {
      id: eventId,
      type: eventType,
      data,
      sourceWidgetId,
      timestamp: Date.now(),
      propagated: []
    };

    // Add to history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    if (this.debugMode) {
      console.log(`📡 Event emitted: ${eventType} from ${sourceWidgetId || 'system'}`);
    }

    // Find interested widgets
    const interestedWidgets = [];
    for (const [widgetId, registration] of this.registeredWidgets) {
      // Don't send event back to source
      if (widgetId === sourceWidgetId) continue;
      
      // Check if widget is interested in this event type
      if (registration.interestedEvents.includes(eventType) || 
          registration.interestedEvents.includes('*')) {
        interestedWidgets.push({ widgetId, registration });
      }
    }

    if (this.debugMode) {
      console.log(`📡 Event ${eventType} → ${interestedWidgets.length} interested widgets`);
    }

    // Propagate to interested widgets
    const results = [];
    for (const { widgetId, registration } of interestedWidgets) {
      try {
        const result = registration.widget.handleEvent(event, this);
        event.propagated.push(widgetId);
        results.push({ widgetId, result });
        
        if (this.debugMode) {
          console.log(`✅ Event handled by ${widgetId}`);
        }
      } catch (error) {
        console.error(`❌ Event handling error in ${widgetId}:`, error);
        results.push({ widgetId, error: error.message });
      }
    }

    return {
      eventId,
      propagatedTo: event.propagated,
      results
    };
  }

  /**
   * Get event history for debugging
   */
  getEventHistory(limit = 50) {
    return this.eventHistory.slice(-limit);
  }

  /**
   * Get registered widgets info
   */
  getRegisteredWidgets() {
    const widgets = {};
    for (const [widgetId, registration] of this.registeredWidgets) {
      widgets[widgetId] = {
        type: registration.metadata.type,
        interestedEvents: registration.interestedEvents,
        registeredAt: new Date(registration.metadata.registeredAt).toISOString()
      };
    }
    return widgets;
  }

  /**
   * Enable/disable debug logging
   */
  setDebugMode(enabled) {
    this.debugMode = enabled;
    console.log(`🐛 WidgetEventBus debug mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Clear event history
   */
  clearHistory() {
    this.eventHistory = [];
  }

  /**
   * Get system statistics
   */
  getStats() {
    const eventTypes = {};
    this.eventHistory.forEach(event => {
      eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
    });

    return {
      registeredWidgets: this.registeredWidgets.size,
      totalEvents: this.eventHistory.length,
      eventTypes,
      uptime: Date.now() - (this.startTime || Date.now())
    };
  }
}

// Singleton instance
const widgetEventBus = new WidgetEventBus();
widgetEventBus.startTime = Date.now();

module.exports = { WidgetEventBus, widgetEventBus };