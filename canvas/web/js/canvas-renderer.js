// ============================================
// Scratchy Canvas — Conversation Renderer
// ============================================
// Renders blocks into the conversation stream:
//   user messages, agent text, component rows, dividers.

class CanvasRenderer {
  constructor(stream) {
    this.stream = stream; // #canvas-stream DOM element
    this._autoScroll = true;
    this._componentElements = {}; // id → DOM element (for upsert)

    // Size mapping for flex layout
    this.SIZE_MAP = {
      sparkline: "small", gauge: "small", progress: "small",
      status: "small", tags: "small",
      card: "medium", stats: "medium", alert: "medium",
      checklist: "medium", kv: "medium", buttons: "medium",
      "link-card": "medium", toggle: "medium", rating: "medium",
      chips: "medium", input: "medium", slider: "medium",
      "form-strip": "medium", streak: "medium", "stacked-bar": "medium",
      "chart-pie": "medium",
      "chart-bar": "wide", "chart-line": "wide", table: "wide",
      code: "wide", tabs: "wide",
      hero: "full", timeline: "full", accordion: "full", form: "full",
    };

    // Track scroll position for auto-scroll
    var self = this;
    this.stream.addEventListener("scroll", function() {
      var el = self.stream;
      self._autoScroll = (el.scrollTop + el.clientHeight >= el.scrollHeight - 40);
    });
  }

  _getSize(type) {
    return this.SIZE_MAP[type] || "medium";
  }

  _scrollToBottom() {
    if (this._autoScroll) {
      var self = this;
      requestAnimationFrame(function() {
        self.stream.scrollTop = self.stream.scrollHeight;
      });
    }
  }

  _clearEmpty() {
    var empty = this.stream.querySelector(".stream-empty");
    if (empty) empty.remove();
  }

  // ── Public API ──

  startTurn() {
    var children = Array.from(this.stream.children);
    
    // Find all blocks that are NOT collapsed turns and NOT the empty state
    var activeBlocks = children.filter(function(el) {
      return !el.classList.contains("turn-collapsed") &&
             !el.classList.contains("stream-empty") &&
             !el.classList.contains("block-skeleton") &&
             !el.classList.contains("block-live");
    });
    
    if (activeBlocks.length === 0) return;
    
    // Find the last user message in active blocks
    var lastUserIdx = -1;
    for (var i = activeBlocks.length - 1; i >= 0; i--) {
      if (activeBlocks[i].classList.contains("block-user")) {
        lastUserIdx = i;
        break;
      }
    }
    
    // Remove all agent content (text + components) from BEFORE the last user message
    // These are from the previous turn — collapse them
    var blocksToCollapse = [];
    for (var i = 0; i < lastUserIdx; i++) {
      blocksToCollapse.push(activeBlocks[i]);
    }
    
    if (blocksToCollapse.length > 0) {
      this._collapseBlocks(blocksToCollapse, activeBlocks[lastUserIdx]);
    }
    
    // Remove agent content AFTER the last user message (previous response being replaced)
    for (var i = lastUserIdx + 1; i < activeBlocks.length; i++) {
      var el = activeBlocks[i];
      if (el.classList.contains("block-agent-text") || 
          el.classList.contains("block-components")) {
        el.remove();
      }
    }
  }

  // Collapse all current content (for history load)
  collapseAll() {
    var blocks = Array.from(this.stream.children).filter(function(el) {
      return !el.classList.contains("turn-collapsed") &&
             !el.classList.contains("stream-empty") &&
             !el.classList.contains("block-skeleton") &&
             !el.classList.contains("block-live");
    });
    if (blocks.length === 0) return;
    this._collapseBlocks(blocks, null);
  }

  _collapseBlocks(blocks, insertBeforeEl) {
    if (!blocks || blocks.length === 0) return;

    var container = document.createElement("div");
    container.className = "turn-collapsed";
    
    // Find summary text (first user message in this batch)
    var summaryText = "Conversation";
    var compCount = 0;
    
    var content = document.createElement("div");
    content.className = "turn-content";

    blocks.forEach(function(el) {
      if (el.classList.contains("block-user") && summaryText === "Conversation") {
        var bubble = el.querySelector(".block-user-bubble");
        if (bubble) {
            var txt = bubble.textContent;
            summaryText = txt.slice(0, 40) + (txt.length > 40 ? "..." : "");
        }
      }
      if (el.classList.contains("block-components")) {
        compCount += el.children.length;
      }
      content.appendChild(el);
    });

    container.appendChild(content);

    // Summary
    var summary = document.createElement("div");
    summary.className = "turn-summary";
    summary.textContent = "You: " + summaryText + " → " + compCount + " components";
    
    summary.addEventListener("click", function() {
      container.classList.toggle("expanded");
    });

    container.insertBefore(summary, content);

    if (insertBeforeEl && insertBeforeEl.parentNode === this.stream) {
      this.stream.insertBefore(container, insertBeforeEl);
    } else {
      // Append to end or before skeleton if exists
      var ref = this.stream.querySelector(".block-skeleton") || this.stream.querySelector(".block-live");
      if (ref) this.stream.insertBefore(container, ref);
      else this.stream.appendChild(container);
    }
  }

  // Add a user message
  addUserMessage(text) {
    this._clearEmpty();
    var block = document.createElement("div");
    block.className = "stream-block block-user";
    var bubble = document.createElement("div");
    bubble.className = "block-user-bubble";
    bubble.textContent = text;
    block.appendChild(bubble);
    this.stream.appendChild(block);
    this._scrollToBottom();
  }

  // Add agent text
  addAgentText(text) {
    if (!text || !text.trim()) return;
    this._clearEmpty();
    var block = document.createElement("div");
    block.className = "stream-block block-agent-text";
    // Use markdown renderer if available
    if (typeof renderMarkdown === "function") {
      safeHTML(block, renderMarkdown(text.trim()));
    } else {
      block.textContent = text.trim();
    }
    this.stream.appendChild(block);
    this._scrollToBottom();
  }

  // Add a row of components
  addComponents(components) {
    if (!components || components.length === 0) return;
    this._clearEmpty();

    // Group: wide/full components get their own row, small/medium group together
    var rows = [];
    var currentRow = [];

    for (var i = 0; i < components.length; i++) {
      var comp = components[i];
      var size = this._getSize(comp.type);

      if (size === "wide" || size === "full") {
        // Flush current row first
        if (currentRow.length > 0) {
          rows.push(currentRow);
          currentRow = [];
        }
        // Wide/full gets its own row
        rows.push([comp]);
      } else {
        currentRow.push(comp);
      }
    }
    if (currentRow.length > 0) {
      rows.push(currentRow);
    }

    // Render each row
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var rowEl = document.createElement("div");
      rowEl.className = "stream-block block-components";

      for (var c = 0; c < row.length; c++) {
        var comp = row[c];
        var el = this._createComponentEl(comp);
        rowEl.appendChild(el);
      }

      this.stream.appendChild(rowEl);
    }

    this._scrollToBottom();
  }

  // Add a single component (for streaming — one at a time)
  addComponent(comp) {
    this.addComponents([comp]);
  }

  // Upsert a component by ID (updates in-place if exists)
  upsertComponent(comp) {
    var existing = this._componentElements[comp.id];
    if (existing) {
      // Update in-place
      var renderData = { component: comp.type };
      for (var k in comp.data) renderData[k] = comp.data[k];
      var html = this._renderComponentHtml(renderData);
      safeHTML(existing, html);
      existing.classList.add("updating");
      setTimeout(function() { existing.classList.remove("updating"); }, 200);
    } else {
      // New — append
      this.addComponent(comp);
    }
  }

  // Add a turn divider
  addDivider() {
    var hr = document.createElement("hr");
    hr.className = "block-divider";
    this.stream.appendChild(hr);
  }

  // Show skeleton (agent thinking)
  showSkeleton() {
    this._clearEmpty();
    if (this.stream.querySelector(".block-skeleton")) return;
    var skel = document.createElement("div");
    skel.className = "block-skeleton";
    skel.innerHTML = '<div class="sk-pill"></div><div class="sk-pill"></div><div class="sk-pill"></div>';
    this.stream.appendChild(skel);
    this._scrollToBottom();
  }

  hideSkeleton() {
    var skel = this.stream.querySelector(".block-skeleton");
    if (skel) skel.remove();
  }

  // Show live streaming text
  showLiveText(text) {
    this._clearEmpty();
    var live = this.stream.querySelector(".block-live");
    if (!live) {
      live = document.createElement("div");
      live.className = "stream-block block-live";
      this.stream.appendChild(live);
    }
    if (typeof renderMarkdown === "function") {
      safeHTML(live, renderMarkdown(text) + '<span class="cursor"></span>');
    } else {
      live.textContent = text;
    }
    this._scrollToBottom();
  }

  // Finalize live text (remove cursor, convert to agent text block)
  finalizeLive() {
    var live = this.stream.querySelector(".block-live");
    if (live) {
      live.classList.remove("block-live");
      live.classList.add("block-agent-text");
      var cursor = live.querySelector(".cursor");
      if (cursor) cursor.remove();
    }
  }

  // Set status indicator
  setStatus(status) {
    var el = document.getElementById("session-indicator");
    if (!el) return;
    var labels = {
      connected: "● Connected",
      disconnected: "○ Disconnected",
      connecting: "◌ Connecting...",
    };
    el.textContent = labels[status] || status;
    el.className = "session-info status-" + status;
  }

  // Clear everything
  clear() {
    this.stream.innerHTML = "";
    this._componentElements = {};
  }

  // ── Private ──

  _createComponentEl(comp) {
    var size = this._getSize(comp.type);
    var el = document.createElement("div");
    el.className = "block-component";
    if (size === "wide" || size === "full") el.className += " break-row";
    el.dataset.componentId = comp.id;
    el.dataset.type = comp.type;
    el.dataset.size = size;

    // Alert type for border color
    if (comp.data && comp.data.type) {
      el.dataset.alertType = comp.data.type;
    }

    var renderData = { component: comp.type };
    for (var k in comp.data) renderData[k] = comp.data[k];
    safeHTML(el, this._renderComponentHtml(renderData));

    // Track for upsert
    if (comp.id) {
      this._componentElements[comp.id] = el;
    }

    return el;
  }

  _renderComponentHtml(data) {
    if (typeof renderCanvasComponent === "function") {
      return renderCanvasComponent(data);
    }
    if (typeof renderComponent === "function") {
      return renderComponent(JSON.stringify(data));
    }
    return '<div style="padding:12px;color:#888;">Unknown component</div>';
  }
}
