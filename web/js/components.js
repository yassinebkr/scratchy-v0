// Scratchy — Generative UI Components
//
// Renders structured JSON from the AI agent as interactive UI.
// 32 component types: charts, cards, forms, media, and more.
//
// Protocol: The agent embeds JSON in a code block with language
// "scratchy-ui". The markdown renderer intercepts it and calls
// renderComponent() instead of showing raw code.
//
// Example agent message:
//   Here's the weather:
//   ```scratchy-ui
//   {"component":"weather","city":"Berlin","temp":8,"condition":"Cloudy","icon":"☁️"}
//   ```
//
// The frontend sees "scratchy-ui" and renders a weather card
// instead of a code block.
// ============================================

function renderComponent(json) {
  try {
    var data = JSON.parse(json);
  } catch (e) {
    return '<pre><code>' + json + '</code></pre>';
  }

  // Universal fold: any component with "collapsed" wraps in <details>
  if (data.collapsed != null) {
    var isOpen = data.collapsed === false; // collapsed:false = open, collapsed:true = closed
    var foldTitle = data.foldTitle || data.title || data.label || data.component;
    var colCopy = JSON.parse(JSON.stringify(data));
    delete colCopy.collapsed;
    delete colCopy.foldTitle;
    var inner = renderComponent(JSON.stringify(colCopy));
    return '<details class="sui-fold"' + (isOpen ? ' open' : '') + '>' +
      '<summary class="sui-fold-summary">' + esc(foldTitle) + '</summary>' +
      '<div class="sui-fold-body">' + inner + '</div>' +
    '</details>';
  }

  switch (data.component) {

    // ------------------------------------------
    // Card: simple info card with icon
    // ------------------------------------------
    case "card":
      return '<div class="sui-card">' +
        (data.icon ? '<div class="sui-card-icon">' + data.icon + '</div>' : '') +
        '<div class="sui-card-body">' +
          '<div class="sui-card-title">' + esc(data.title || "") + '</div>' +
          '<div class="sui-card-text">' + rich(data.text || "") + '</div>' +
        '</div>' +
      '</div>';

    // ------------------------------------------
    // Weather: temperature + condition card
    // ------------------------------------------
    case "weather":
      return '<div class="sui-weather">' +
        '<div class="sui-weather-icon">' + (data.icon || "🌡️") + '</div>' +
        '<div class="sui-weather-info">' +
          '<div class="sui-weather-city">' + esc(data.city || "") + '</div>' +
          '<div class="sui-weather-temp">' + esc(String(data.temp || "")) + '°C</div>' +
          '<div class="sui-weather-cond">' + esc(data.condition || "") + '</div>' +
        '</div>' +
      '</div>';

    // ------------------------------------------
    // Progress: progress bar with label
    // ------------------------------------------
    case "progress":
      var pct = Math.min(100, Math.max(0, data.value || 0));
      return '<div class="sui-progress">' +
        '<div class="sui-progress-label">' + esc(data.label || "") + '</div>' +
        '<div class="sui-progress-bar">' +
          '<div class="sui-progress-fill" style="width:' + pct + '%"></div>' +
        '</div>' +
        '<div class="sui-progress-pct">' + pct + '%</div>' +
      '</div>';

    // ------------------------------------------
    // Buttons: clickable options that send a message
    // ------------------------------------------
    case "buttons":
      var btns = (data.options || []).map(function(opt, i) {
        // Use data attribute + index to avoid inline string escaping issues
        return '<button class="sui-btn" data-sui-send="' + esc(opt) + '">' + esc(opt) + '</button>';
      }).join("");
      return '<div class="sui-buttons">' +
        (data.text ? '<div class="sui-buttons-text">' + esc(data.text) + '</div>' : '') +
        '<div class="sui-buttons-row">' + btns + '</div>' +
      '</div>';

    // ------------------------------------------
    // Code: syntax-highlighted code with copy button
    // ------------------------------------------
    case "code":
      return '<div class="sui-code">' +
        '<div class="sui-code-header">' +
          '<span class="sui-code-lang">' + esc(data.language || "") + '</span>' +
          '<button class="sui-code-copy" onclick="var t=this.closest(\'.sui-code\').querySelector(\'pre code\').textContent;navigator.clipboard.writeText(t);this.textContent=\'Copied!\';var b=this;setTimeout(function(){b.textContent=\'Copy\'},1500)">Copy</button>' +
        '</div>' +
        '<pre><code>' + esc(data.code || "") + '</code></pre>' +
      '</div>';

    // ------------------------------------------
    // Status: colored status indicator
    // ------------------------------------------
    case "status":
      var color = data.color || "green";
      return '<div class="sui-status">' +
        '<span class="sui-status-dot" style="background:' + esc(color) + '"></span>' +
        '<span class="sui-status-text">' + esc(data.text || "") + '</span>' +
      '</div>';

    // ------------------------------------------
    // Table: data table
    // ------------------------------------------
    case "table":
      var headers = (data.headers || []).map(function(h) {
        return '<th>' + esc(h) + '</th>';
      }).join("");
      var rows = (data.rows || []).map(function(row) {
        var cells = row.map(function(c) { return '<td>' + esc(String(c)) + '</td>'; }).join("");
        return '<tr>' + cells + '</tr>';
      }).join("");
      return '<div class="sui-table-wrap">' +
        (data.title ? '<div class="sui-table-title">' + esc(data.title) + '</div>' : '') +
        '<table class="sui-table"><thead><tr>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '</div>';

    // ------------------------------------------
    // Stats: number card with label + trend
    // ------------------------------------------
    // { component: "stats", items: [{ label: "Users", value: "1,234", trend: "+12%", color: "#10b981" }] }
    case "stats":
      var statItems = (data.items || []).map(function(item) {
        var trendClass = (item.trend || "").startsWith("+") ? "sui-trend-up" :
                         (item.trend || "").startsWith("-") ? "sui-trend-down" : "";
        return '<div class="sui-stat">' +
          '<div class="sui-stat-value" style="color:' + esc(item.color || "#fff") + '">' + esc(String(item.value || "")) + '</div>' +
          '<div class="sui-stat-label">' + esc(item.label || "") + '</div>' +
          (item.trend ? '<div class="sui-stat-trend ' + trendClass + '">' + esc(item.trend) + '</div>' : '') +
        '</div>';
      }).join("");
      return '<div class="sui-stats">' +
        (data.title ? '<div class="sui-stats-title">' + esc(data.title) + '</div>' : '') +
        '<div class="sui-stats-grid">' + statItems + '</div>' +
      '</div>';

    // ------------------------------------------
    // Alert: warning / info / error / success banner
    // ------------------------------------------
    // { component: "alert", type: "warning", title: "Heads up", text: "..." }
    case "alert":
      var alertType = data.type || "info"; // info, warning, error, success
      var alertIcons = { info: "ℹ️", warning: "⚠️", error: "❌", success: "✅" };
      var alertIcon = data.icon || alertIcons[alertType] || "ℹ️";
      return '<div class="sui-alert sui-alert-' + esc(alertType) + '">' +
        '<div class="sui-alert-icon">' + alertIcon + '</div>' +
        '<div class="sui-alert-content">' +
          (data.title ? '<div class="sui-alert-title">' + esc(data.title) + '</div>' : '') +
          '<div class="sui-alert-text">' + rich(data.text || "") + '</div>' +
        '</div>' +
      '</div>';

    // ------------------------------------------
    // Timeline: vertical timeline with events
    // ------------------------------------------
    // { component: "timeline", items: [{ date: "Feb 9", title: "...", text: "...", icon: "🚀" }] }
    case "timeline":
      var timeItems = (data.items || []).map(function(item, i) {
        var isLast = i === (data.items || []).length - 1;
        return '<div class="sui-timeline-item' + (isLast ? ' sui-timeline-last' : '') + '">' +
          '<div class="sui-timeline-marker">' +
            '<div class="sui-timeline-dot">' + (item.icon || "●") + '</div>' +
            (!isLast ? '<div class="sui-timeline-line"></div>' : '') +
          '</div>' +
          '<div class="sui-timeline-content">' +
            (item.date ? '<div class="sui-timeline-date">' + esc(item.date) + '</div>' : '') +
            '<div class="sui-timeline-title">' + esc(item.title || "") + '</div>' +
            (item.text ? '<div class="sui-timeline-text">' + rich(item.text) + '</div>' : '') +
          '</div>' +
        '</div>';
      }).join("");
      return '<div class="sui-timeline">' +
        (data.title ? '<div class="sui-timeline-header">' + esc(data.title) + '</div>' : '') +
        timeItems +
      '</div>';

    // ------------------------------------------
    // Checklist: todo items with checkmarks
    // ------------------------------------------
    // { component: "checklist", title: "Tasks", items: [{ text: "...", checked: true }] }
    case "checklist":
      var checkItems = (data.items || []).map(function(item) {
        var checked = item.checked || item.done;
        return '<div class="sui-check-item' + (checked ? ' sui-checked' : '') + '">' +
          '<span class="sui-check-box">' + (checked ? '✓' : '') + '</span>' +
          '<span class="sui-check-text">' + esc(item.text || "") + '</span>' +
        '</div>';
      }).join("");
      return '<div class="sui-checklist">' +
        (data.title ? '<div class="sui-checklist-title">' + esc(data.title) + '</div>' : '') +
        checkItems +
      '</div>';

    // ------------------------------------------
    // KV: key-value pairs
    // ------------------------------------------
    // { component: "kv", title: "Info", items: [["Key", "Value"], ...] }
    case "kv":
      var kvItems = (data.items || []).map(function(pair) {
        var k = Array.isArray(pair) ? pair[0] : pair.key;
        var v = Array.isArray(pair) ? pair[1] : pair.value;
        return '<div class="sui-kv-row">' +
          '<span class="sui-kv-key">' + esc(String(k || "")) + '</span>' +
          '<span class="sui-kv-val">' + esc(String(v || "")) + '</span>' +
        '</div>';
      }).join("");
      return '<div class="sui-kv">' +
        (data.title ? '<div class="sui-kv-title">' + esc(data.title) + '</div>' : '') +
        kvItems +
      '</div>';

    // ------------------------------------------
    // Accordion: expandable/collapsible sections
    // ------------------------------------------
    // { component: "accordion", sections: [{ title: "...", text: "...", open: false }] }
    case "accordion":
      var accId = 'sui-acc-' + Math.random().toString(36).substr(2, 6);
      var accSections = (data.sections || []).map(function(sec, i) {
        var openAttr = sec.open ? ' open' : '';
        return '<details class="sui-acc-section"' + openAttr + '>' +
          '<summary class="sui-acc-header">' +
            '<span class="sui-acc-title">' + esc(sec.title || "") + '</span>' +
            '<span class="sui-acc-arrow">▸</span>' +
          '</summary>' +
          '<div class="sui-acc-body">' + rich(sec.text || sec.content || "") + '</div>' +
        '</details>';
      }).join("");
      return '<div class="sui-accordion">' +
        (data.title ? '<div class="sui-accordion-title">' + esc(data.title) + '</div>' : '') +
        accSections +
      '</div>';

    // ------------------------------------------
    // Tags: inline colored badges/pills
    // ------------------------------------------
    // { component: "tags", label: "Status", items: [{ text: "Active", color: "#10b981" }] }
    case "tags":
      var tagItems = (data.items || []).map(function(tag) {
        var tagText = typeof tag === "string" ? tag : (tag.text || "");
        var tagColor = typeof tag === "string" ? "#666" : (tag.color || "#666");
        return '<span class="sui-tag" style="background:' + esc(tagColor) + '">' + esc(tagText) + '</span>';
      }).join("");
      return '<div class="sui-tags">' +
        (data.label ? '<span class="sui-tags-label">' + esc(data.label) + '</span>' : '') +
        '<div class="sui-tags-row">' + tagItems + '</div>' +
      '</div>';

    // ------------------------------------------
    // Link Card: rich preview card with URL
    // ------------------------------------------
    // { component: "link-card", url: "https://...", title: "...", description: "...", icon: "🔗" }
    case "link-card":
      var domain = "";
      try { domain = new URL(data.url || "").hostname; } catch(e) {}
      return '<a class="sui-link-card" href="' + esc(data.url || "#") + '" target="' + esc(data.target || "_blank") + '" rel="noopener">' +
        '<div class="sui-link-icon">' + (data.icon || "🔗") + '</div>' +
        '<div class="sui-link-body">' +
          '<div class="sui-link-title">' + esc(data.title || data.url || "") + '</div>' +
          (data.description ? '<div class="sui-link-desc">' + rich(data.description) + '</div>' : '') +
          (domain ? '<div class="sui-link-domain">' + esc(domain) + '</div>' : '') +
        '</div>' +
        '<div class="sui-link-arrow">→</div>' +
      '</a>';

    // ------------------------------------------
    // Chart Bar: simple CSS horizontal bar chart
    // ------------------------------------------
    // { component: "chart-bar", title: "...", items: [{ label: "X", value: 80, color: "#3b82f6" }] }
    case "chart-bar":
      var maxVal = Math.max.apply(null, (data.items || []).map(function(d) { return Math.abs(d.value || 0); }));
      if (maxVal === 0) maxVal = 1;
      var barItems = (data.items || []).map(function(item) {
        var pctW = Math.max(0, Math.round((item.value || 0) / maxVal * 100));
        var barColor = item.color || "#3b82f6";
        return '<div class="sui-bar-row">' +
          '<span class="sui-bar-label">' + esc(item.label || "") + '</span>' +
          '<div class="sui-bar-track">' +
            '<div class="sui-bar-fill" style="width:' + pctW + '%;background:' + esc(barColor) + '"></div>' +
          '</div>' +
          '<span class="sui-bar-value">' + esc(String(item.value || 0)) + (data.unit ? ' ' + esc(data.unit) : '') + '</span>' +
        '</div>';
      }).join("");
      return '<div class="sui-chart-bar">' +
        (data.title ? '<div class="sui-chart-title">' + esc(data.title) + '</div>' : '') +
        barItems +
      '</div>';

    // ------------------------------------------
    // Hero: large banner with gradient
    // ------------------------------------------
    // { component: "hero", title: "...", subtitle: "...", gradient: "linear-gradient(...)" }
    case "hero":
      var gradient = data.gradient || "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
      return '<div class="sui-hero" style="background:' + gradient + '">' +
        (data.icon ? '<div class="sui-hero-icon">' + data.icon + '</div>' : '') +
        '<div class="sui-hero-title">' + esc(data.title || "") + '</div>' +
        (data.subtitle ? '<div class="sui-hero-subtitle">' + rich(data.subtitle) + '</div>' : '') +
      '</div>';

    // ------------------------------------------
    // Chart Pie: CSS conic-gradient donut/pie
    // ------------------------------------------
    // { component: "chart-pie", title: "...", items: [{ label: "X", value: 40, color: "#3b82f6" }], donut: true }
    case "chart-pie":
      var pieTotal = (data.items || []).reduce(function(s, d) { return s + (d.value || 0); }, 0);
      if (pieTotal === 0) pieTotal = 1;
      var pieStops = [];
      var pieCur = 0;
      var pieLegend = (data.items || []).map(function(item) {
        var pct = ((item.value || 0) / pieTotal * 100).toFixed(1);
        var color = item.color || "#3b82f6";
        pieStops.push(color + " " + pieCur + "% " + (pieCur + parseFloat(pct)) + "%");
        pieCur += parseFloat(pct);
        return '<div class="sui-pie-legend-item">' +
          '<span class="sui-pie-dot" style="background:' + esc(color) + '"></span>' +
          '<span class="sui-pie-label">' + esc(item.label || "") + '</span>' +
          '<span class="sui-pie-pct">' + pct + '%</span>' +
        '</div>';
      }).join("");
      var donutHole = data.donut !== false ? ', rgba(26,26,46,1) 0 60%' : '';
      var pieGrad = "conic-gradient(" + pieStops.join(", ") + ")";
      if (data.donut !== false) {
        pieGrad = "radial-gradient(circle at center, var(--bg-primary, #1a1a2e) 58%, transparent 59%), " + pieGrad;
      }
      return '<div class="sui-chart-pie">' +
        (data.title ? '<div class="sui-chart-title">' + esc(data.title) + '</div>' : '') +
        '<div class="sui-pie-row">' +
          '<div class="sui-pie-circle" style="background:' + pieGrad + '"></div>' +
          '<div class="sui-pie-legend">' + pieLegend + '</div>' +
        '</div>' +
      '</div>';

    // ------------------------------------------
    // Chart Line: SVG line chart
    // ------------------------------------------
    // { component: "chart-line", title: "...", points: [10, 25, 18, 40, 35], labels: ["Mon","Tue",...], color: "#3b82f6", fill: true }
    case "chart-line":
      var pts = data.points || [];
      if (pts.length === 0) return '<div class="sui-card"><div class="sui-card-body">No data</div></div>';
      var lineMax = Math.max.apply(null, pts);
      var lineMin = Math.min.apply(null, pts);
      var lineRange = lineMax - lineMin || 1;
      var svgW = 300, svgH = 100, padX = 5, padY = 10;
      var lineColor = data.color || "#3b82f6";
      var linePoints = pts.map(function(v, i) {
        var x = padX + (i / (pts.length - 1 || 1)) * (svgW - padX * 2);
        var y = padY + (1 - (v - lineMin) / lineRange) * (svgH - padY * 2);
        return x.toFixed(1) + "," + y.toFixed(1);
      });
      var polyline = linePoints.join(" ");
      var fillPath = "";
      if (data.fill !== false) {
        var firstX = padX.toFixed(1);
        var lastX = (padX + ((pts.length - 1) / (pts.length - 1 || 1)) * (svgW - padX * 2)).toFixed(1);
        fillPath = '<polygon points="' + firstX + ',' + (svgH - padY) + ' ' + polyline + ' ' + lastX + ',' + (svgH - padY) + '" fill="' + lineColor + '" opacity="0.15"/>';
      }
      var labels = data.labels || [];
      var labelsSvg = labels.map(function(l, i) {
        var x = padX + (i / (labels.length - 1 || 1)) * (svgW - padX * 2);
        return '<text x="' + x.toFixed(1) + '" y="' + (svgH - 1) + '" text-anchor="middle" fill="currentColor" opacity="0.5" font-size="8">' + esc(l) + '</text>';
      }).join("");
      // Dot on the last point
      var lastPt = linePoints[linePoints.length - 1].split(",");
      var dotSvg = '<circle cx="' + lastPt[0] + '" cy="' + lastPt[1] + '" r="3" fill="' + lineColor + '"/>';
      return '<div class="sui-chart-line">' +
        (data.title ? '<div class="sui-chart-title">' + esc(data.title) + '</div>' : '') +
        '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" class="sui-line-svg" style="width:100%;height:auto;display:block">' +
          fillPath +
          '<polyline points="' + polyline + '" fill="none" stroke="' + lineColor + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
          dotSvg + labelsSvg +
        '</svg>' +
      '</div>';

    // ------------------------------------------
    // Sparkline: tiny inline chart for stats
    // ------------------------------------------
    // { component: "sparkline", label: "Requests", value: "1,234", points: [5,8,3,9,6,12,8], color: "#10b981", trend: "+12%" }
    case "sparkline":
      var spPts = data.points || [];
      var spMax = Math.max.apply(null, spPts) || 1;
      var spMin = Math.min.apply(null, spPts);
      var spRange = spMax - spMin || 1;
      var spW = 80, spH = 24;
      var spColor = data.color || "#10b981";
      var spLine = spPts.map(function(v, i) {
        var x = (i / (spPts.length - 1 || 1)) * spW;
        var y = spH - ((v - spMin) / spRange) * (spH - 4) - 2;
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      var spTrendClass = (data.trend || "").startsWith("+") ? "sui-trend-up" : (data.trend || "").startsWith("-") ? "sui-trend-down" : "";
      return '<div class="sui-sparkline">' +
        '<div class="sui-sparkline-info">' +
          '<div class="sui-sparkline-value">' + esc(String(data.value || "")) + '</div>' +
          '<div class="sui-sparkline-label">' + esc(data.label || "") + '</div>' +
        '</div>' +
        '<svg viewBox="0 0 ' + spW + ' ' + spH + '" class="sui-sparkline-svg">' +
          '<polyline points="' + spLine + '" fill="none" stroke="' + spColor + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
        (data.trend ? '<div class="sui-sparkline-trend ' + spTrendClass + '">' + esc(data.trend) + '</div>' : '') +
      '</div>';

    // ------------------------------------------
    // Gauge: circular percentage gauge
    // ------------------------------------------
    // { component: "gauge", title: "...", value: 75, max: 100, label: "Score", color: "#3b82f6" }
    case "gauge":
      var gVal = Math.min(data.value || 0, data.max || 100);
      var gMax = data.max || 100;
      var gPct = gVal / gMax;
      var gColor = data.color || "#3b82f6";
      var gRadius = 40, gStroke = 8;
      var gCirc = 2 * Math.PI * gRadius;
      var gDash = gPct * gCirc;
      var gSize = (gRadius + gStroke) * 2;
      return '<div class="sui-gauge">' +
        (data.title ? '<div class="sui-chart-title">' + esc(data.title) + '</div>' : '') +
        '<div class="sui-gauge-wrap">' +
          '<svg viewBox="0 0 ' + gSize + ' ' + gSize + '" class="sui-gauge-svg">' +
            '<circle cx="' + (gSize/2) + '" cy="' + (gSize/2) + '" r="' + gRadius + '" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="' + gStroke + '"/>' +
            '<circle cx="' + (gSize/2) + '" cy="' + (gSize/2) + '" r="' + gRadius + '" fill="none" stroke="' + gColor + '" stroke-width="' + gStroke + '" stroke-dasharray="' + gDash.toFixed(1) + ' ' + gCirc.toFixed(1) + '" stroke-linecap="round" transform="rotate(-90 ' + (gSize/2) + ' ' + (gSize/2) + ')"/>' +
          '</svg>' +
          '<div class="sui-gauge-center">' +
            '<div class="sui-gauge-value">' + esc(String(gVal)) + '</div>' +
            (data.label ? '<div class="sui-gauge-label">' + esc(data.label) + '</div>' : '') +
          '</div>' +
        '</div>' +
      '</div>';

    // ------------------------------------------
    // Form Strip: colored blocks for match results
    // ------------------------------------------
    // { component: "form-strip", title: "...", results: ["W","W","D","L","W",...], labels: ["ARS","FUL",...] }
    case "form-strip":
      var formColors = { W: "#10b981", D: "#f59e0b", L: "#ef4444" };
      var formBlocks = (data.results || []).map(function(r, i) {
        var c = formColors[r.toUpperCase()] || "#666";
        var label = (data.labels && data.labels[i]) ? data.labels[i] : "";
        var letter = r.toUpperCase().charAt(0);
        return '<div class="sui-form-block" style="background:' + c + '" title="' + esc(label) + '">' +
          '<span class="sui-form-letter">' + letter + '</span>' +
          (label ? '<span class="sui-form-opp">' + esc(label) + '</span>' : '') +
        '</div>';
      }).join("");
      var fW = (data.results || []).filter(function(r) { return r.toUpperCase() === "W"; }).length;
      var fD = (data.results || []).filter(function(r) { return r.toUpperCase() === "D"; }).length;
      var fL = (data.results || []).filter(function(r) { return r.toUpperCase() === "L"; }).length;
      return '<div class="sui-form-strip">' +
        (data.title ? '<div class="sui-chart-title">' + esc(data.title) + '</div>' : '') +
        '<div class="sui-form-blocks">' + formBlocks + '</div>' +
        '<div class="sui-form-summary">' +
          '<span class="sui-form-stat" style="color:#10b981">' + fW + 'W</span>' +
          '<span class="sui-form-stat" style="color:#f59e0b">' + fD + 'D</span>' +
          '<span class="sui-form-stat" style="color:#ef4444">' + fL + 'L</span>' +
        '</div>' +
      '</div>';

    // ------------------------------------------
    // Stacked Bar: proportional horizontal segments
    // ------------------------------------------
    // { component: "stacked-bar", title: "...", items: [{ label: "Wins", value: 12, color: "#10b981" }] }
    case "stacked-bar":
      var sbTotal = (data.items || []).reduce(function(s, d) { return s + (d.value || 0); }, 0);
      if (sbTotal === 0) sbTotal = 1;
      var sbSegments = (data.items || []).map(function(item) {
        var pct = ((item.value || 0) / sbTotal * 100).toFixed(1);
        return '<div class="sui-sb-segment" style="width:' + pct + '%;background:' + esc(item.color || "#666") + '" title="' + esc(item.label || "") + ': ' + item.value + '"></div>';
      }).join("");
      var sbLegend = (data.items || []).map(function(item) {
        var pct = ((item.value || 0) / sbTotal * 100).toFixed(0);
        return '<div class="sui-sb-legend-item">' +
          '<span class="sui-pie-dot" style="background:' + esc(item.color || "#666") + '"></span>' +
          '<span>' + esc(item.label || "") + '</span>' +
          '<span class="sui-sb-legend-val">' + item.value + ' (' + pct + '%)</span>' +
        '</div>';
      }).join("");
      return '<div class="sui-stacked-bar">' +
        (data.title ? '<div class="sui-chart-title">' + esc(data.title) + '</div>' : '') +
        '<div class="sui-sb-track">' + sbSegments + '</div>' +
        '<div class="sui-sb-legend">' + sbLegend + '</div>' +
      '</div>';

    // ------------------------------------------
    // Streak: W/D/L plotted as +1/0/-1 wave
    // ------------------------------------------
    // { component: "streak", title: "...", results: ["W","L","D","W","W",...], labels: ["GW1","GW2",...] }
    case "streak":
      var skRes = (data.results || []).map(function(r) {
        var u = r.toUpperCase().charAt(0);
        return u === "W" ? 1 : u === "L" ? -1 : 0;
      });
      var skW2 = 300, skH2 = 80, skPadX = 10, skPadY = 10;
      var skMid = skH2 / 2;
      var skPoints = skRes.map(function(v, i) {
        var x = skPadX + (i / (skRes.length - 1 || 1)) * (skW2 - skPadX * 2);
        var y = skMid - v * (skMid - skPadY);
        return x.toFixed(1) + "," + y.toFixed(1);
      });
      var skColor = data.color || "#3b82f6";
      // Fill area
      var skFirstX = skPadX.toFixed(1);
      var skLastX = (skPadX + ((skRes.length - 1) / (skRes.length - 1 || 1)) * (skW2 - skPadX * 2)).toFixed(1);
      var skFill = '<polygon points="' + skFirstX + ',' + skMid + ' ' + skPoints.join(" ") + ' ' + skLastX + ',' + skMid + '" fill="' + skColor + '" opacity="0.1"/>';
      // Zero line
      var skZero = '<line x1="' + skPadX + '" y1="' + skMid + '" x2="' + (skW2 - skPadX) + '" y2="' + skMid + '" stroke="rgba(255,255,255,0.1)" stroke-width="1" stroke-dasharray="4,4"/>';
      // Labels
      var skLabels2 = '<text x="' + (skW2 - skPadX) + '" y="' + skPadY + '" text-anchor="end" fill="#10b981" font-size="8" opacity="0.6">WIN</text>';
      skLabels2 += '<text x="' + (skW2 - skPadX) + '" y="' + (skH2 - skPadY + 8) + '" text-anchor="end" fill="#ef4444" font-size="8" opacity="0.6">LOSS</text>';
      // Dots colored by result
      var skDots = skRes.map(function(v, i) {
        var x = skPadX + (i / (skRes.length - 1 || 1)) * (skW2 - skPadX * 2);
        var y = skMid - v * (skMid - skPadY);
        var dc = v === 1 ? "#10b981" : v === -1 ? "#ef4444" : "#f59e0b";
        return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="' + dc + '"/>';
      }).join("");
      return '<div class="sui-streak">' +
        (data.title ? '<div class="sui-chart-title">' + esc(data.title) + '</div>' : '') +
        '<svg viewBox="0 0 ' + skW2 + ' ' + skH2 + '" class="sui-streak-svg" style="width:100%;height:auto;display:block">' +
          skZero + skFill +
          '<polyline points="' + skPoints.join(" ") + '" fill="none" stroke="' + skColor + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
          skDots + skLabels2 +
        '</svg>' +
      '</div>';

    // ------------------------------------------
    // Toggle: on/off switch
    // ------------------------------------------
    // { component: "toggle", label: "Dark mode", value: true, id: "darkmode" }
    case "toggle":
      var togId = "sui-tog-" + (data.id || Math.random().toString(36).slice(2, 8));
      var togOn = data.value ? true : false;
      return '<div class="sui-toggle">' +
        '<label class="sui-toggle-row" for="' + togId + '">' +
          '<span class="sui-toggle-label">' + esc(data.label || "") + '</span>' +
          '<input type="checkbox" id="' + togId + '" class="sui-toggle-input" ' + (togOn ? 'checked' : '') +
            ' data-sui-action="toggle" data-sui-label="' + esc(data.label || "option") + '">' +
          '<span class="sui-toggle-track"><span class="sui-toggle-thumb"></span></span>' +
        '</label>' +
        (data.description ? '<div class="sui-toggle-desc">' + esc(data.description) + '</div>' : '') +
      '</div>';

    // ------------------------------------------
    // Rating: star rating
    // ------------------------------------------
    // { component: "rating", label: "Rate this movie", max: 5, value: 0 }
    case "rating":
      var rMax = data.max || 5;
      var rVal = data.value || 0;
      var rId = "sui-rat-" + Math.random().toString(36).slice(2, 8);
      var rStars = "";
      for (var ri = 1; ri <= rMax; ri++) {
        var rFill = ri <= rVal ? "sui-star-filled" : "";
        rStars += '<span class="sui-star ' + rFill + '" data-rating-id="' + rId + '" data-val="' + ri + '" data-sui-action="rate" tabindex="0" role="button" aria-label="Rate ' + ri + ' of ' + rMax + '">' +
          '★</span>';
      }
      return '<div class="sui-rating" id="' + rId + '">' +
        (data.label ? '<div class="sui-rating-label">' + esc(data.label) + '</div>' : '') +
        '<div class="sui-stars">' + rStars + '</div>' +
      '</div>';

    // ------------------------------------------
    // Chips: multi-select tag buttons
    // ------------------------------------------
    // { component: "chips", label: "Select topics", options: ["Rust","JS","Python"], multi: true }
    case "chips":
      var chMulti = data.multi !== false;
      var chId = "sui-ch-" + Math.random().toString(36).slice(2, 8);
      var chBtns = (data.options || []).map(function(opt) {
        return '<button class="sui-chip" data-chips-id="' + chId + '" onclick="suiChipToggle(this, ' + chMulti + ')">' + esc(opt) + '</button>';
      }).join("");
      var chSubmit = '<button class="sui-chip-submit" onclick="suiChipSubmit(\'' + chId + '\')">Confirm</button>';
      return '<div class="sui-chips" id="' + chId + '">' +
        (data.label ? '<div class="sui-chips-label">' + esc(data.label) + '</div>' : '') +
        '<div class="sui-chips-row">' + chBtns + '</div>' +
        '<div class="sui-chips-actions">' + chSubmit + '</div>' +
      '</div>';

    // ------------------------------------------
    // Input: text field with send
    // ------------------------------------------
    // { component: "input", label: "Your name", placeholder: "Type here...", prefix: "Name:" }
    case "input":
      var inpPrefix = data.prefix || "";
      var inpId = "sui-inp-" + Math.random().toString(36).slice(2, 8);
      return '<div class="sui-input">' +
        (data.label ? '<div class="sui-input-label">' + esc(data.label) + '</div>' : '') +
        '<div class="sui-input-row">' +
          '<input type="text" id="' + inpId + '" class="sui-input-field" placeholder="' + esc(data.placeholder || "") + '" data-sui-action="input" data-sui-prefix="' + esc(inpPrefix) + '" data-sui-input-id="' + inpId + '">' +
          '<button class="sui-input-send" data-sui-action="input-send" data-sui-input-id="' + inpId + '" data-sui-prefix="' + esc(inpPrefix) + '">→</button>' +
        '</div>' +
      '</div>';

    // ------------------------------------------
    // Slider: range input
    // ------------------------------------------
    // { component: "slider", label: "Volume", min: 0, max: 100, value: 50, step: 1, unit: "%" }
    case "slider":
      var slMin = data.min != null ? data.min : 0;
      var slMax = data.max != null ? data.max : 100;
      var slVal = data.value != null ? data.value : Math.round((slMin + slMax) / 2);
      var slStep = data.step || 1;
      var slUnit = data.unit || "";
      var slId = "sui-sl-" + Math.random().toString(36).slice(2, 8);
      return '<div class="sui-slider">' +
        (data.label ? '<div class="sui-slider-header"><span class="sui-slider-label">' + esc(data.label) + '</span><span class="sui-slider-val" id="' + slId + '-val">' + slVal + esc(slUnit) + '</span></div>' : '') +
        '<input type="range" class="sui-slider-input" id="' + slId + '" min="' + slMin + '" max="' + slMax + '" value="' + slVal + '" step="' + slStep + '" data-sui-action="slider-input" data-sui-val-target="' + slId + '-val" data-sui-unit="' + esc(slUnit) + '">' +
        '<div class="sui-slider-footer"><span>' + slMin + esc(slUnit) + '</span><button class="sui-chip-submit" data-sui-action="slider-send" data-sui-slider-id="' + slId + '" data-sui-label="' + esc(data.label || "value") + '" data-sui-unit="' + esc(slUnit) + '">Set</button><span>' + slMax + esc(slUnit) + '</span></div>' +
      '</div>';

    // ------------------------------------------
    // Tabs: switchable content panels
    // ------------------------------------------
    // { component: "tabs", tabs: [{ label: "Tab 1", content: "..." }, { label: "Tab 2", content: "..." }] }
    case "tabs":
      var tabId = "sui-tab-" + Math.random().toString(36).slice(2, 8);
      var tabBtns = (data.tabs || []).map(function(tab, i) {
        return '<button class="sui-tab-btn' + (i === 0 ? ' active' : '') + '" onclick="suiTabSwitch(this, \'' + tabId + '\',' + i + ')">' + esc(tab.label || "Tab " + (i + 1)) + '</button>';
      }).join("");
      var tabPanels = (data.tabs || []).map(function(tab, i) {
        return '<div class="sui-tab-panel' + (i === 0 ? ' active' : '') + '" data-tab-index="' + i + '">' + rich(tab.content || "") + '</div>';
      }).join("");
      return '<div class="sui-tabs" id="' + tabId + '">' +
        '<div class="sui-tabs-row">' + tabBtns + '</div>' +
        '<div class="sui-tabs-panels">' + tabPanels + '</div>' +
      '</div>';

    // ------------------------------------------
    // Video: HTML5 video player
    // ------------------------------------------
    // { component: "video", src: "/media/path/to/file.mp4", title: "...", poster: "...", autoplay: false, loop: false }
    case "video":
      var vidSrc = data.src || data.url || "";
      var vidPoster = data.poster ? ' poster="' + esc(data.poster) + '"' : '';
      var vidAutoplay = data.autoplay ? ' autoplay muted' : '';
      var vidLoop = data.loop ? ' loop' : '';
      var dlIcon = '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      return '<div class="sui-video">' +
        (data.title ? '<div class="sui-video-title">' + esc(data.title) + '</div>' : '') +
        '<div class="sui-video-wrap">' +
          '<video class="sui-video-player" controls playsinline preload="metadata"' + vidPoster + vidAutoplay + vidLoop + '>' +
            '<source src="' + esc(vidSrc) + '" type="' + esc(data.type || 'video/mp4') + '">' +
          '</video>' +
          '<a class="sui-video-dl" href="' + esc(vidSrc) + '" download title="Save / Share">' + dlIcon + '</a>' +
        '</div>' +
        '<div class="sui-video-error">' +
          '<span class="sui-video-error-icon">⚠️</span>' +
          '<span>Video failed to load</span>' +
          '<a href="' + esc(vidSrc) + '" target="_blank" class="sui-video-error-link">Open directly →</a>' +
        '</div>' +
        (data.caption ? '<div class="sui-video-caption">' + rich(data.caption) + '</div>' : '') +
      '</div>';

    // ------------------------------------------
    // Image: embedded image display
    // ------------------------------------------
    // { component: "image", src: "/media/path/to/image.png", title: "...", alt: "..." }
    case "image":
      var imgSrc = data.src || data.url || "";
      var imgAlt = data.alt || data.title || "";
      return '<div class="sui-image">' +
        (data.title ? '<div class="sui-image-title">' + esc(data.title) + '</div>' : '') +
        '<img class="sui-image-img" src="' + esc(imgSrc) + '" alt="' + esc(imgAlt) + '" loading="lazy">' +
        (data.caption ? '<div class="sui-image-caption">' + rich(data.caption) + '</div>' : '') +
      '</div>';

    default:
      return '<div class="sui-card"><div class="sui-card-body">Unknown component: ' + esc(data.component) + '</div></div>';
  }
}

// Interactive component helpers
function suiRate(star, val) {
  var id = star.getAttribute("data-rating-id");
  var stars = document.querySelectorAll('[data-rating-id="' + id + '"]');
  stars.forEach(function(s) {
    var sv = parseInt(s.getAttribute("data-val"));
    s.classList.toggle("sui-star-filled", sv <= val);
  });
  scratchySendFromUI("Rated " + val + " stars");
}

function suiChipToggle(chip, multi) {
  if (!multi) {
    var siblings = chip.parentElement.querySelectorAll(".sui-chip");
    siblings.forEach(function(s) { s.classList.remove("selected"); });
  }
  chip.classList.toggle("selected");
}

function suiChipSubmit(id) {
  var el = document.getElementById(id);
  if (!el) return;
  var selected = [];
  el.querySelectorAll(".sui-chip.selected").forEach(function(c) {
    selected.push(c.textContent);
  });
  if (selected.length > 0) {
    scratchySendFromUI("Selected: " + selected.join(", "));
  }
}

function suiInputSend(id, prefix) {
  var inp = document.getElementById(id);
  if (!inp || !inp.value.trim()) return;
  var msg = prefix ? prefix + " " + inp.value.trim() : inp.value.trim();
  scratchySendFromUI(msg);
  inp.value = "";
}

function suiSliderSend(id, label, unit) {
  var slider = document.getElementById(id);
  if (!slider) return;
  scratchySendFromUI("Set " + label + " to " + slider.value + unit);
}

function suiTabSwitch(btn, tabId, index) {
  var container = document.getElementById(tabId);
  if (!container) return;
  container.querySelectorAll(".sui-tab-btn").forEach(function(b) { b.classList.remove("active"); });
  container.querySelectorAll(".sui-tab-panel").forEach(function(p) { p.classList.remove("active"); });
  btn.classList.add("active");
  var panel = container.querySelector('[data-tab-index="' + index + '"]');
  if (panel) panel.classList.add("active");
}

function esc(text) {
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Rich text: escapes HTML but supports inline code (`code`) and line breaks (\n)
function rich(text) {
  var escaped = esc(text);
  // Inline code: `code` → <code>code</code>
  escaped = escaped.replace(/`([^`]+)`/g, '<code class="sui-inline-code">$1</code>');
  // Line breaks
  escaped = escaped.replace(/\n/g, '<br>');
  return escaped;
}

// Global function for button clicks to send messages
function scratchySendFromUI(text) {
  // Find the send button and input, simulate sending
  var input = document.getElementById("message-input");
  var sendBtn = document.getElementById("send-btn");
  if (input && sendBtn) {
    input.value = text;
    sendBtn.click();
  }
}

// Delegated event handlers — avoids fragile inline onclick string escaping
// and prevents XSS via backslash injection in quoted attribute values.
document.addEventListener("click", function(e) {
  var el = e.target;

  // Buttons with data-sui-send — DISABLED (handled by app.js widget-action system)
  var sendBtn = el.closest("[data-sui-send]");
  if (sendBtn) {
    // OLD: scratchySendFromUI(sendBtn.getAttribute("data-sui-send"));
    // NEW: Handled by app.js widget-action system - no longer creates chat messages!
    console.log('[Components] data-sui-send click intercepted - delegating to app.js widget-action handler');
    return;
  }

  // Input send button
  var inputSendBtn = el.closest('[data-sui-action="input-send"]');
  if (inputSendBtn) {
    var inputId = inputSendBtn.getAttribute("data-sui-input-id");
    var prefix = inputSendBtn.getAttribute("data-sui-prefix");
    suiInputSend(inputId, prefix);
    return;
  }

  // Slider send button
  var sliderSendBtn = el.closest('[data-sui-action="slider-send"]');
  if (sliderSendBtn) {
    var sliderId = sliderSendBtn.getAttribute("data-sui-slider-id");
    var slLabel = sliderSendBtn.getAttribute("data-sui-label");
    var slUnit = sliderSendBtn.getAttribute("data-sui-unit");
    suiSliderSend(sliderId, slLabel, slUnit);
    return;
  }

  // Rating stars
  var rateStar = el.closest('[data-sui-action="rate"]');
  if (rateStar) {
    var rVal = parseInt(rateStar.getAttribute("data-val"));
    suiRate(rateStar, rVal);
    return;
  }
});

// Delegated change handler for toggle switches
document.addEventListener("change", function(e) {
  var el = e.target;
  if (el.getAttribute("data-sui-action") === "toggle") {
    var label = el.getAttribute("data-sui-label");
    scratchySendFromUI("Toggled " + label + ": " + (el.checked ? "on" : "off"));
  }
});

// Delegated input handler for slider range inputs
document.addEventListener("input", function(e) {
  var el = e.target;
  if (el.getAttribute("data-sui-action") === "slider-input") {
    var targetId = el.getAttribute("data-sui-val-target");
    var unit = el.getAttribute("data-sui-unit");
    var valEl = document.getElementById(targetId);
    if (valEl) valEl.textContent = el.value + unit;
  }
});

// Delegated keydown handler for input fields and accessible rating stars
document.addEventListener("keydown", function(e) {
  var el = e.target;
  // Input field: Enter to send
  if (el.getAttribute("data-sui-action") === "input") {
    if (e.key === "Enter") {
      var inputId = el.getAttribute("data-sui-input-id");
      var prefix = el.getAttribute("data-sui-prefix");
      suiInputSend(inputId, prefix);
    }
  }
  // Rating stars: Enter or Space to activate
  if (el.getAttribute("data-sui-action") === "rate") {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      var rVal = parseInt(el.getAttribute("data-val"));
      suiRate(el, rVal);
    }
  }
});
