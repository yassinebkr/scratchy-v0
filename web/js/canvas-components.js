// ============================================
// Scratchy Canvas — Native Component Renderer
// ============================================
// Renders components optimized for spatial grid tiles.
// Falls back to renderComponent() for unported types.

function renderCanvasComponent(jsonStr) {
  var d;
  try { d = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr; } catch(e) { return ""; }
  var type = d.component;
  var fn = _canvasRenderers[type];
  if (fn) return fn(d);
  // Fallback to chat renderer
  if (typeof renderComponent === "function") return renderComponent(typeof jsonStr === "string" ? jsonStr : JSON.stringify(jsonStr));
  return '<div style="padding:12px;color:#888;">Unknown: ' + esc(type) + '</div>';
}

function esc(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function richText(s) {
  if (!s) return "";
  var h = esc(s);
  // underline: __text__
  h = h.replace(/__(.+?)__/g, "<u>$1</u>");
  // bold: **text**
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#ddd;">$1</strong>');
  // italic: *text* — only if not preceded by another * (avoid matching inside bold remnants)
  h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  // newlines to <br>
  h = h.replace(/\n/g, "<br>");
  // list items: lines starting with • or -  (after <br> or at start)
  h = h.replace(/(^|<br>)(?:•|-)[ ]+(.+?)(?=<br>|$)/g, function(m, pre, txt) {
    return (pre ? pre : '') + '<div style="display:flex;gap:6px;padding:2px 0;"><span style="color:#666;">\u2022</span><span>' + txt + '</span></div>';
  });
  return h;
}
window._scratchyRichText = richText;

var _canvasRenderers = {};

// ── Hero ──
_canvasRenderers.hero = function(d) {
  var grad = d.gradient;
  if (Array.isArray(grad)) grad = "linear-gradient(135deg, " + grad.join(", ") + ")";
  if (!grad) grad = "linear-gradient(135deg, #7c3aed, #3b82f6)";
  var icon = d.icon || "";
  return '<div style="background:' + grad + ';padding:28px 24px;border-radius:10px;text-align:center;">' +
    (icon ? '<div style="font-size:2.2rem;margin-bottom:8px;">' + esc(icon) + '</div>' : '') +
    '<div style="font-size:1.4rem;font-weight:600;color:#fff;margin-bottom:4px;">' + esc(d.title) + '</div>' +
    (d.subtitle ? '<div style="font-size:0.85rem;color:rgba(255,255,255,0.75);">' + esc(d.subtitle) + '</div>' : '') +
    (d.badge ? '<div style="display:inline-block;margin-top:8px;padding:3px 10px;border-radius:12px;background:rgba(255,255,255,0.15);font-size:0.7rem;color:rgba(255,255,255,0.9);font-weight:600;letter-spacing:0.05em;">' + esc(d.badge) + '</div>' : '') +
  '</div>';
};

// ── Stats ──
_canvasRenderers.stats = function(d) {
  var items = d.items || [];
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  var grid = '<div style="display:grid;grid-template-columns:repeat(' + items.length + ',1fr);gap:12px;">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var c = it.color || "#3b82f6";
    grid += '<div>' +
      '<div style="font-size:1.3rem;font-weight:600;color:' + c + ';">' + esc(it.value) + '</div>' +
      '<div style="font-size:0.75rem;color:#888;margin-top:2px;">' + esc(it.label) + '</div>' +
      (it.trend ? '<div style="font-size:0.7rem;color:' + (String(it.trend).startsWith("-") ? "#ef4444" : "#10b981") + ';margin-top:2px;">' + esc(it.trend) + '</div>' : '') +
    '</div>';
  }
  grid += '</div>';
  return '<div style="padding:14px 16px;">' + h + grid + '</div>';
};

// ── Card ──
_canvasRenderers.card = function(d) {
  var icon = d.icon ? '<span style="font-size:1.2rem;margin-right:8px;">' + esc(d.icon) + '</span>' : '';
  return '<div style="padding:14px 16px;">' +
    '<div style="display:flex;align-items:center;margin-bottom:8px;">' + icon +
      '<span style="font-size:0.9rem;font-weight:600;">' + esc(d.title) + '</span>' +
    '</div>' +
    '<div style="font-size:0.82rem;color:#aaa;line-height:1.5;">' + richText(d.text) + '</div>' +
  '</div>';
};

// ── Alert ──
_canvasRenderers.alert = function(d) {
  var colors = { info: "#3b82f6", warning: "#f59e0b", error: "#ef4444", success: "#10b981" };
  var icons = { info: "ℹ", warning: "⚠", error: "✕", success: "✓" };
  var sev = d.severity || d.type || "info";
  var c = colors[sev] || colors.info;
  var ic = icons[sev] || icons.info;
  return '<div style="padding:12px 14px;border-left:3px solid ' + c + ';display:flex;gap:10px;align-items:flex-start;">' +
    '<div style="width:20px;height:20px;border-radius:50%;background:' + c + '22;color:' + c + ';display:flex;align-items:center;justify-content:center;font-size:0.7rem;flex-shrink:0;">' + ic + '</div>' +
    '<div>' +
      '<div style="font-size:0.82rem;font-weight:600;margin-bottom:2px;">' + esc(d.title) + '</div>' +
      '<div style="font-size:0.78rem;color:#999;line-height:1.4;">' + richText(d.message || d.text || '') + '</div>' +
    '</div>' +
  '</div>';
};

// ── Chart Bar ──
_canvasRenderers["chart-bar"] = function(d) {
  var items = d.items || [];
  var max = 0;
  for (var i = 0; i < items.length; i++) { if (items[i].value > max) max = items[i].value; }
  if (max === 0) max = 1;
  var unit = d.unit || "";

  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:12px;">' + esc(d.title) + '</div>' : '';
  var bars = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var pct = Math.round((it.value / max) * 100);
    var c = it.color || "#3b82f6";
    bars += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
      '<div style="width:50px;font-size:0.72rem;color:#888;text-align:right;flex-shrink:0;">' + esc(it.label) + '</div>' +
      '<div style="flex:1;height:18px;background:rgba(255,255,255,0.04);border-radius:4px;overflow:hidden;">' +
        '<div style="height:100%;width:' + pct + '%;background:' + c + ';border-radius:4px;transition:width 0.5s ease;"></div>' +
      '</div>' +
      '<div style="width:36px;font-size:0.72rem;color:#aaa;text-align:right;">' + it.value + (unit ? ' ' + esc(unit) : '') + '</div>' +
    '</div>';
  }
  return '<div style="padding:14px 16px;">' + h + bars + '</div>';
};

// ── Chart Pie (donut) ──
_canvasRenderers["chart-pie"] = function(d) {
  var items = d.items || [];
  var total = 0;
  for (var i = 0; i < items.length; i++) total += items[i].value;
  if (total === 0) total = 1;
  var size = 100, cx = 50, cy = 50, r = 38, strokeW = d.donut ? 12 : 38;
  var circumference = 2 * Math.PI * r;
  var offset = 0;
  var paths = '';
  for (var i = 0; i < items.length; i++) {
    var seg = (items[i].value / total) * circumference;
    var c = items[i].color || "#3b82f6";
    paths += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + c + '" stroke-width="' + strokeW + '" ' +
      'stroke-dasharray="' + seg + ' ' + (circumference - seg) + '" stroke-dashoffset="-' + offset + '" />';
    offset += seg;
  }
  var svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" style="width:90px;height:90px;transform:rotate(-90deg);">' + paths + '</svg>';
  var legend = '<div style="display:flex;flex-direction:column;gap:4px;">';
  for (var i = 0; i < items.length; i++) {
    legend += '<div style="display:flex;align-items:center;gap:6px;font-size:0.72rem;">' +
      '<div style="width:8px;height:8px;border-radius:2px;background:' + (items[i].color || "#3b82f6") + ';"></div>' +
      '<span style="color:#aaa;">' + esc(items[i].label) + '</span>' +
      '<span style="color:#ddd;margin-left:auto;">' + items[i].value + '</span>' +
    '</div>';
  }
  legend += '</div>';
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  return '<div style="padding:14px 16px;">' + h + '<div style="display:flex;align-items:center;gap:16px;">' + svg + legend + '</div></div>';
};

// ── Chart Line ──
_canvasRenderers["chart-line"] = function(d) {
  var pts = d.points || [];
  var labels = d.labels || [];
  if (pts.length < 2) return '';
  var c = d.color || "#3b82f6";
  var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
  if (max === min) { max = min + 1; }
  var w = 300, h = 80, pad = 4;
  var coords = [];
  for (var i = 0; i < pts.length; i++) {
    var x = pad + (i / (pts.length - 1)) * (w - pad * 2);
    var y = pad + (1 - (pts[i] - min) / (max - min)) * (h - pad * 2);
    coords.push(x + "," + y);
  }
  var polyline = '<polyline points="' + coords.join(" ") + '" fill="none" stroke="' + c + '" stroke-width="2" stroke-linejoin="round" />';
  var fill = d.fill ? '<polygon points="' + pad + ',' + (h - pad) + ' ' + coords.join(" ") + ' ' + (w - pad) + ',' + (h - pad) + '" fill="' + c + '" fill-opacity="0.1" />' : '';
  var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:80px;">' + fill + polyline + '</svg>';
  var title = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:8px;">' + esc(d.title) + '</div>' : '';
  return '<div style="padding:14px 16px;">' + title + svg + '</div>';
};

// ── KV ──
_canvasRenderers.kv = function(d) {
  var items = d.items || [];
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  var rows = '';
  for (var i = 0; i < items.length; i++) {
    var pair = items[i];
    var k = Array.isArray(pair) ? pair[0] : (pair.key || pair.label || "");
    var v = Array.isArray(pair) ? pair[1] : (pair.value || pair.val || "");
    rows += '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' +
      '<span style="font-size:0.78rem;color:#888;">' + esc(k) + '</span>' +
      '<span style="font-size:0.78rem;color:#ddd;font-weight:500;">' + esc(v) + '</span>' +
    '</div>';
  }
  return '<div style="padding:14px 16px;">' + h + rows + '</div>';
};

// ── Checklist ──
_canvasRenderers.checklist = function(d) {
  var items = d.items || [];
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  var list = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var check = it.checked;
    var icon = check
      ? '<div style="width:16px;height:16px;border-radius:4px;background:#10b981;display:flex;align-items:center;justify-content:center;font-size:0.6rem;color:#fff;flex-shrink:0;">✓</div>'
      : '<div style="width:16px;height:16px;border-radius:4px;border:1.5px solid #555;flex-shrink:0;"></div>';
    list += '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">' +
      icon +
      '<span style="font-size:0.8rem;color:' + (check ? '#888' : '#ddd') + ';' + (check ? 'text-decoration:line-through;' : '') + '">' + esc(it.text) + '</span>' +
    '</div>';
  }
  return '<div style="padding:14px 16px;">' + h + list + '</div>';
};

// ── Code ──
_canvasRenderers.code = function(d) {
  var lang = d.language || "";
  var code = d.code || "";
  var lines = code.split("\n");
  var numbered = '';
  for (var i = 0; i < lines.length; i++) {
    numbered += '<div style="display:flex;gap:12px;">' +
      '<span style="color:#555;user-select:none;min-width:20px;text-align:right;">' + (i + 1) + '</span>' +
      '<span>' + esc(lines[i]) + '</span>' +
    '</div>';
  }
  return '<div style="padding:0;">' +
    (lang ? '<div style="padding:6px 14px;font-size:0.68rem;color:#666;border-bottom:1px solid rgba(255,255,255,0.04);letter-spacing:0.02em;">' + esc(lang) + '</div>' : '') +
    '<pre style="margin:0;padding:12px 14px;font-family:JetBrains Mono,Fira Code,monospace;font-size:0.78rem;line-height:1.6;overflow-x:auto;color:#c9d1d9;">' + numbered + '</pre>' +
  '</div>';
};

// ── Progress ──
_canvasRenderers.progress = function(d) {
  var val = d.value || 0;
  var label = d.label || "";
  return '<div style="padding:12px 16px;">' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">' +
      '<span style="font-size:0.78rem;color:#aaa;">' + esc(label) + '</span>' +
      '<span style="font-size:0.78rem;color:#ddd;font-weight:500;">' + val + '%</span>' +
    '</div>' +
    '<div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">' +
      '<div style="height:100%;width:' + val + '%;background:linear-gradient(90deg,#7c3aed,#3b82f6);border-radius:3px;animation:progress-fill 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;transition:width 0.5s ease;"></div>' +
    '</div>' +
  '</div>';
};

// ── Tags ──
_canvasRenderers.tags = function(d) {
  var items = d.items || [];
  var label = d.label || "";
  var h = label ? '<div style="font-size:0.72rem;color:#888;margin-bottom:8px;">' + esc(label) + '</div>' : '';
  var pills = '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
  for (var i = 0; i < items.length; i++) {
    var c = items[i].color || "#3b82f6";
    pills += '<span style="font-size:0.72rem;padding:3px 10px;border-radius:12px;background:' + c + '22;color:' + c + ';border:1px solid ' + c + '33;">' + esc(items[i].text) + '</span>';
  }
  pills += '</div>';
  return '<div style="padding:12px 16px;">' + h + pills + '</div>';
};

// ── Table ──
_canvasRenderers.table = function(d) {
  var headers = d.headers || [];
  var rows = d.rows || [];
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  var tbl = '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;">';
  if (headers.length) {
    tbl += '<tr>';
    for (var i = 0; i < headers.length; i++) {
      tbl += '<th style="text-align:left;padding:6px 8px;color:#888;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.08);">' + esc(headers[i]) + '</th>';
    }
    tbl += '</tr>';
  }
  for (var r = 0; r < rows.length; r++) {
    tbl += '<tr>';
    for (var c = 0; c < rows[r].length; c++) {
      tbl += '<td style="padding:6px 8px;color:#ccc;border-bottom:1px solid rgba(255,255,255,0.03);">' + esc(rows[r][c]) + '</td>';
    }
    tbl += '</tr>';
  }
  tbl += '</table>';
  return '<div style="padding:14px 16px;">' + h + tbl + '</div>';
};

// ── Sparkline ──
_canvasRenderers.sparkline = function(d) {
  var pts = d.points || [];
  var c = d.color || "#10b981";
  if (pts.length < 2) return '';
  var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
  if (max === min) max = min + 1;
  var w = 80, h = 28;
  var coords = [];
  for (var i = 0; i < pts.length; i++) {
    var x = (i / (pts.length - 1)) * w;
    var y = 2 + (1 - (pts[i] - min) / (max - min)) * (h - 4);
    coords.push(x + "," + y);
  }
  var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" style="width:80px;height:28px;">' +
    '<polyline points="' + coords.join(" ") + '" fill="none" stroke="' + c + '" stroke-width="1.5" stroke-linejoin="round" />' +
  '</svg>';
  return '<div style="padding:12px 16px;display:flex;align-items:center;gap:12px;">' +
    '<div>' +
      '<div style="font-size:1.1rem;font-weight:600;color:#ddd;">' + esc(d.value) + '</div>' +
      '<div style="font-size:0.7rem;color:#888;">' + esc(d.label) + '</div>' +
    '</div>' +
    svg +
    (d.trend ? '<div style="font-size:0.75rem;color:' + (String(d.trend).startsWith("-") ? "#ef4444" : "#10b981") + ';margin-left:auto;">' + esc(d.trend) + '</div>' : '') +
  '</div>';
};

// ── Gauge ──
_canvasRenderers.gauge = function(d) {
  var val = d.value || 0;
  var max = d.max || 100;
  var pct = Math.min(val / max, 1);
  var c = d.color || "#3b82f6";
  var r = 36, stroke = 8;
  var circumference = Math.PI * r;
  var filled = pct * circumference;
  var svg = '<svg viewBox="0 0 90 55" style="width:90px;height:55px;">' +
    '<path d="M 9 50 A 36 36 0 0 1 81 50" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="' + stroke + '" stroke-linecap="round" />' +
    '<path d="M 9 50 A 36 36 0 0 1 81 50" fill="none" stroke="' + c + '" stroke-width="' + stroke + '" stroke-linecap="round" ' +
      'stroke-dasharray="' + filled.toFixed(1) + ' ' + circumference.toFixed(1) + '" ' +
      'style="animation: gauge-sweep 0.8s cubic-bezier(0.16, 1, 0.3, 1) both; transition: stroke-dasharray 0.6s cubic-bezier(0.16, 1, 0.3, 1), stroke 0.4s ease;" />' +
  '</svg>';
  return '<div style="padding:14px 16px;text-align:center;">' +
    (d.title ? '<div style="font-size:0.72rem;color:#888;margin-bottom:8px;">' + esc(d.title) + '</div>' : '') +
    svg +
    '<div style="font-size:1rem;font-weight:600;color:#ddd;margin-top:-4px;">' + esc(d.label || val) + '</div>' +
  '</div>';
};

// ── Buttons ──
_canvasRenderers.buttons = function(d) {
  var opts = d.options || [];
  // Support {buttons: [{label, action}]} format
  if (opts.length === 0 && d.buttons && d.buttons.length) {
    opts = d.buttons.map(function(b) { return typeof b === "string" ? b : b.label || b.action || ""; });
  }
  // Build action map from original buttons array
  var actions = {};
  if (d.buttons && d.buttons.length) {
    for (var j = 0; j < d.buttons.length; j++) {
      var b = d.buttons[j];
      if (typeof b === "object") actions[b.label || b.action || ""] = b.action || b.label || "";
    }
  }
  var html = d.text ? '<div style="font-size:0.82rem;color:#aaa;margin-bottom:10px;">' + esc(d.text) + '</div>' : '';
  html += d.title ? '<div style="font-size:0.85rem;font-weight:600;color:#ddd;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
  for (var i = 0; i < opts.length; i++) {
    var sendVal = actions[opts[i]] || opts[i];
    html += '<button data-sui-send="' + esc(sendVal) + '" style="padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#ddd;font-size:0.78rem;cursor:pointer;transition:background 0.15s,border-color 0.15s;"' +
      ' onmouseover="this.style.background=\'rgba(124,58,237,0.15)\';this.style.borderColor=\'rgba(124,58,237,0.3)\'"' +
      ' onmouseout="this.style.background=\'rgba(255,255,255,0.04)\';this.style.borderColor=\'rgba(255,255,255,0.1)\'"' +
      '>' + esc(opts[i]) + '</button>';
  }
  html += '</div>';
  return '<div style="padding:14px 16px;">' + html + '</div>';
};

// ── Timeline ──
_canvasRenderers.timeline = function(d) {
  var items = d.items || [];
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:12px;">' + esc(d.title) + '</div>' : '';
  var list = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var isLast = i === items.length - 1;
    list += '<div style="display:flex;gap:12px;position:relative;">' +
      '<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;">' +
        '<div style="width:24px;height:24px;border-radius:50%;background:rgba(124,58,237,0.15);display:flex;align-items:center;justify-content:center;font-size:0.7rem;">' + (it.icon || '•') + '</div>' +
        (!isLast ? '<div style="width:1px;flex:1;background:rgba(255,255,255,0.06);margin:4px 0;"></div>' : '') +
      '</div>' +
      '<div style="padding-bottom:' + (isLast ? '0' : '14') + 'px;">' +
        '<div style="font-size:0.68rem;color:#888;">' + esc(it.date) + '</div>' +
        '<div style="font-size:0.82rem;font-weight:500;color:#ddd;margin:2px 0;">' + esc(it.title) + '</div>' +
        (it.text ? '<div style="font-size:0.75rem;color:#999;">' + esc(it.text) + '</div>' : '') +
      '</div>' +
    '</div>';
  }
  return '<div style="padding:14px 16px;">' + h + list + '</div>';
};

// ── Accordion ──
_canvasRenderers.accordion = function(d) {
  var sections = d.sections || [];
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  var html = '';
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    var open = s.open !== false;
    html += '<details' + (open ? ' open' : '') + ' style="border-bottom:1px solid rgba(255,255,255,0.04);padding:8px 0;">' +
      '<summary style="font-size:0.82rem;color:#ddd;cursor:pointer;padding:4px 0;">' + esc(s.title) + '</summary>' +
      '<div style="font-size:0.78rem;color:#999;padding:6px 0;line-height:1.5;">' + richText(s.text || s.content || '') + '</div>' +
    '</details>';
  }
  return '<div style="padding:14px 16px;">' + h + html + '</div>';
};

// ── Stacked Bar ──
_canvasRenderers["stacked-bar"] = function(d) {
  var items = d.items || [];
  var total = 0;
  for (var i = 0; i < items.length; i++) total += items[i].value;
  if (total === 0) total = 1;
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  var bar = '<div style="height:20px;border-radius:4px;overflow:hidden;display:flex;">';
  for (var i = 0; i < items.length; i++) {
    var pct = (items[i].value / total) * 100;
    bar += '<div style="width:' + pct + '%;background:' + (items[i].color || "#3b82f6") + ';transition:width 0.5s ease;"></div>';
  }
  bar += '</div>';
  var legend = '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;">';
  for (var i = 0; i < items.length; i++) {
    legend += '<div style="display:flex;align-items:center;gap:4px;font-size:0.7rem;">' +
      '<div style="width:8px;height:8px;border-radius:2px;background:' + (items[i].color || "#3b82f6") + ';"></div>' +
      '<span style="color:#888;">' + esc(items[i].label) + '</span>' +
      '<span style="color:#aaa;">' + items[i].value + '</span>' +
    '</div>';
  }
  legend += '</div>';
  return '<div style="padding:14px 16px;">' + h + bar + legend + '</div>';
};

// ── Form Strip ──
_canvasRenderers["form-strip"] = function(d) {
  var results = d.results || [];
  var labels = d.labels || [];
  var colors = { W: "#10b981", L: "#ef4444", D: "#888" };
  var h = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  var strip = '<div style="display:flex;gap:4px;">';
  for (var i = 0; i < results.length; i++) {
    var c = colors[results[i]] || "#888";
    strip += '<div style="text-align:center;">' +
      '<div style="width:28px;height:28px;border-radius:4px;background:' + c + ';display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:600;color:#fff;">' + esc(results[i]) + '</div>' +
      (labels[i] ? '<div style="font-size:0.6rem;color:#666;margin-top:2px;">' + esc(labels[i]) + '</div>' : '') +
    '</div>';
  }
  strip += '</div>';
  return '<div style="padding:14px 16px;">' + h + strip + '</div>';
};

// ── Link Card ──
_canvasRenderers["link-card"] = function(d) {
  var icon = d.icon ? '<span style="font-size:1.1rem;margin-right:8px;">' + esc(d.icon) + '</span>' : '';
  return '<a href="' + esc(d.url) + '" target="_blank" style="display:block;padding:14px 16px;text-decoration:none;color:inherit;">' +
    '<div style="display:flex;align-items:center;margin-bottom:4px;">' + icon +
      '<span style="font-size:0.82rem;font-weight:500;color:#7c9aed;">' + esc(d.title) + '</span>' +
    '</div>' +
    (d.description ? '<div style="font-size:0.75rem;color:#888;">' + esc(d.description) + '</div>' : '') +
  '</a>';
};

// ── Status ──
_canvasRenderers.status = function(d) {
  var c = d.color || "#10b981";
  return '<div style="padding:10px 16px;display:flex;align-items:center;gap:8px;">' +
    '<div style="width:8px;height:8px;border-radius:50%;background:' + c + ';"></div>' +
    '<span style="font-size:0.82rem;color:#ddd;">' + esc(d.text) + '</span>' +
  '</div>';
};

// ── Form ──
_canvasRenderers.form = function(d) {
  var fields = d.fields || [];
  var actions = d.actions || [];
  var formId = d.id || ('form-' + Math.random().toString(36).substr(2, 9));
  
  // Title
  var html = d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">' + esc(d.title) + '</div>' : '';
  
  html += '<form id="' + esc(formId) + '" onsubmit="return false;">';

  // Helper to render a single field
  function renderField(f) {
    var fieldId = 'form-' + formId + '-' + f.name;
    var labelStyle = 'font-size: 0.75rem; color: #888; margin-bottom: 4px; display:block;';
    var inputStyle = 'background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #e4e4e7; border-radius: 6px; padding: 8px 12px; font-size: 0.82rem; width: 100%; box-sizing: border-box; outline: none; transition: border-color 0.2s;';
    
    var h = '<div style="margin-bottom: 10px;">';
    
    if (f.type === 'checkbox') {
       h += '<div style="display:flex; align-items:center; gap:8px;">';
       h += '<input type="checkbox" id="' + esc(fieldId) + '" name="' + esc(f.name) + '"' + (f.value ? ' checked' : '') + ' style="accent-color:#7c3aed; width:16px; height:16px; cursor:pointer;">';
       h += '<label for="' + esc(fieldId) + '" style="font-size: 0.82rem; color: #ddd; cursor:pointer; user-select:none;">' + esc(f.label) + '</label>';
       h += '</div>';
    } else if (f.type === 'file') {
       if (f.label) h += '<label for="' + esc(fieldId) + '" style="' + labelStyle + '">' + esc(f.label) + '</label>';
       h += '<input type="file" id="' + esc(fieldId) + '" name="' + esc(f.name) + '" multiple accept="*/*" style="border: 2px dashed rgba(255,255,255,0.15); border-radius: 8px; padding: 16px; text-align: center; cursor: pointer; width: 100%; box-sizing: border-box; color: #888; background: rgba(0,0,0,0.2);">';
    } else {
       // Standard label
       if (f.label) {
         h += '<label for="' + esc(fieldId) + '" style="' + labelStyle + '">' + esc(f.label) + '</label>';
       }
       
       if (f.type === 'textarea') {
         h += '<textarea id="' + esc(fieldId) + '" name="' + esc(f.name) + '" rows="' + (f.rows || 3) + '" style="' + inputStyle + ' font-family:inherit;" onfocus="this.style.borderColor=\'rgba(124,58,237,0.5)\'" onblur="this.style.borderColor=\'rgba(255,255,255,0.1)\'">' + esc(f.value || '') + '</textarea>';
       } else if (f.type === 'select') {
         h += '<select id="' + esc(fieldId) + '" name="' + esc(f.name) + '" style="' + inputStyle + ' appearance:none; -webkit-appearance:none; cursor:pointer;" onfocus="this.style.borderColor=\'rgba(124,58,237,0.5)\'" onblur="this.style.borderColor=\'rgba(255,255,255,0.1)\'">';
         var opts = f.options || [];
         for (var j = 0; j < opts.length; j++) {
           var opt = opts[j];
           var val = typeof opt === 'object' ? opt.value : opt;
           var txt = typeof opt === 'object' ? opt.label : opt;
           var selected = (val == f.value) ? ' selected' : '';
           h += '<option value="' + esc(val) + '"' + selected + ' style="background:#222;color:#ddd;">' + esc(txt) + '</option>';
         }
         h += '</select>';
       } else {
         // text, email, emails, number
         var type = (f.type === 'number' || f.type === 'email') ? f.type : 'text';
         var ph = f.placeholder || (f.type === 'emails' ? 'user1@example.com, user2@example.com' : '');
         h += '<input type="' + type + '" id="' + esc(fieldId) + '" name="' + esc(f.name) + '" value="' + esc(f.value || '') + '" placeholder="' + esc(ph) + '" style="' + inputStyle + '" onfocus="this.style.borderColor=\'rgba(124,58,237,0.5)\'" onblur="this.style.borderColor=\'rgba(255,255,255,0.1)\'">';
       }
    }
    
    h += '</div>';
    return h;
  }

  // Split fields
  var normalFields = [];
  var ccFields = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var n = (f.name || "").toLowerCase();
    if (n === 'cc' || n === 'bcc') {
      ccFields.push(f);
    } else {
      normalFields.push(f);
    }
  }

  // Render normal fields
  for (var i = 0; i < normalFields.length; i++) {
    html += renderField(normalFields[i]);
  }

  // Render CC/BCC if any
  if (ccFields.length > 0) {
    html += '<div style="margin-bottom:8px;">' +
      '<a href="#" onclick="var el=this.parentNode.nextElementSibling;el.style.display=el.style.display===\'none\'?\'block\':\'none\';this.textContent=el.style.display===\'none\'?\'CC / BCC ▸\':\'CC / BCC ▾\';return false;" style="color:#888;font-size:0.72rem;text-decoration:none;cursor:pointer;">CC / BCC ▸</a>' +
      '</div>';
    html += '<div style="display:none;">';
    for (var i = 0; i < ccFields.length; i++) {
      html += renderField(ccFields[i]);
    }
    html += '</div>';
  }

  // Actions
  if (actions.length > 0) {
    html += '<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:14px;">';
    for (var i = 0; i < actions.length; i++) {
      var act = actions[i];
      var btnLabel = typeof act === "object" ? (act.label || act.action || "") : String(act);
      var btnAction = typeof act === "object" ? (act.action || act.label || "") : String(act);
      var isPrimary = typeof act === "object" && act.style === "primary";
      var btnStyle = isPrimary
        ? "padding:6px 14px; border-radius:6px; border:none; background:#7c3aed; color:#fff; font-size:0.78rem; cursor:pointer; transition:background 0.15s;"
        : "padding:6px 14px; border-radius:6px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.04); color:#ddd; font-size:0.78rem; cursor:pointer; transition:background 0.15s, border-color 0.15s;";
      html += '<button type="button" data-sui-form="' + esc(formId) + '" data-sui-send="' + esc(btnAction) + '" style="' + btnStyle + '"' +
        (isPrimary
          ? ' onmouseover="this.style.background=\'#6d28d9\'" onmouseout="this.style.background=\'#7c3aed\'"'
          : ' onmouseover="this.style.background=\'rgba(124,58,237,0.15)\';this.style.borderColor=\'rgba(124,58,237,0.3)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.04)\';this.style.borderColor=\'rgba(255,255,255,0.1)\'"') +
        '>' + esc(btnLabel) + '</button>';
    }
    html += '</div>';
  }

  html += '</form>';
  return '<div style="padding:14px 16px;">' + html + '</div>';
};

// ── Chart Bar (SVG) ──
_canvasRenderers["chart-bar"] = function(d) {
  var labels = d.labels || [];
  var datasets = d.datasets || [];
  if (!labels.length || !datasets.length) return '<div style="padding:14px;color:#666;">No data</div>';
  var allVals = [];
  datasets.forEach(function(ds) { allVals = allVals.concat(ds.data || []); });
  var maxVal = Math.max.apply(null, allVals) || 1;
  var padL = 50, padR = 10, padT = 10, padB = 28;
  var barW = Math.max(12, Math.floor(220 / labels.length / datasets.length));
  var groupW = barW * datasets.length + 4;
  var svgW = padL + labels.length * (groupW + 8) + padR;
  var svgH = 170;
  var chartH = svgH - padT - padB;

  // Y-axis labels + grid lines
  var yAxis = '';
  var ySteps = 5;
  for (var s = 0; s <= ySteps; s++) {
    var val = Math.round((maxVal / ySteps) * s);
    var y = padT + chartH - (s / ySteps) * chartH;
    var label = val >= 1000 ? Math.round(val/1000) + 'k' : val;
    yAxis += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" fill="#555" font-size="9" text-anchor="end">' + label + '</text>';
    yAxis += '<line x1="' + padL + '" y1="' + y + '" x2="' + (svgW - padR) + '" y2="' + y + '" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>';
  }

  var bars = '';
  var labelSkip = labels.length > 16 ? 3 : labels.length > 10 ? 2 : 1;
  for (var i = 0; i < labels.length; i++) {
    var gx = padL + 4 + i * (groupW + 8);
    for (var j = 0; j < datasets.length; j++) {
      var val = (datasets[j].data || [])[i] || 0;
      var h = (val / maxVal) * chartH;
      var c = datasets[j].color || '#7c3aed';
      bars += '<rect x="' + (gx + j * (barW + 1)) + '" y="' + (padT + chartH - h) + '" width="' + barW + '" height="' + h + '" rx="3" fill="' + c + '" opacity="0.85" style="animation: bar-grow 0.5s cubic-bezier(0.16, 1, 0.3, 1) ' + (i * 0.08).toFixed(2) + 's both; transform-origin: ' + (gx + j * (barW + 1)) + 'px ' + (padT + chartH) + 'px;"><title>' + esc(labels[i]) + ': ' + val + '</title></rect>';
    }
    if (i % labelSkip === 0) {
      bars += '<text x="' + (gx + groupW/2) + '" y="' + (svgH - 4) + '" fill="#666" font-size="9" text-anchor="middle">' + esc(labels[i]) + '</text>';
    }
  }

  var legend = datasets.map(function(ds) {
    return '<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;"><span style="width:8px;height:8px;border-radius:2px;background:' + (ds.color||'#7c3aed') + ';display:inline-block;"></span><span style="font-size:0.7rem;color:#888;">' + esc(ds.label) + '</span></span>';
  }).join('');

  return '<div style="padding:14px 12px;">' +
    (d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:8px;">' + esc(d.title) + '</div>' : '') +
    '<svg width="100%" viewBox="0 0 ' + svgW + ' ' + svgH + '" preserveAspectRatio="xMidYMid meet">' + yAxis + bars + '</svg>' +
    '<div style="margin-top:6px;">' + legend + '</div></div>';
};

// ── Chart Line (SVG with Y-axis) ──
_canvasRenderers["chart-line"] = function(d) {
  var labels = d.labels || [];
  var datasets = d.datasets || [];
  if (!labels.length || !datasets.length) return '<div style="padding:14px;color:#666;">No data</div>';
  var allVals = [];
  datasets.forEach(function(ds) { allVals = allVals.concat(ds.data || []); });
  var maxVal = Math.max.apply(null, allVals) || 1;
  var svgW = Math.max(300, labels.length * 50 + 60);
  var svgH = 160;
  var padL = 50, padR = 10, padT = 10, padB = 28;
  var chartW = svgW - padL - padR;
  var chartH = svgH - padT - padB;

  // Y-axis labels + grid lines
  var yAxis = '';
  var ySteps = 5;
  for (var s = 0; s <= ySteps; s++) {
    var val = Math.round((maxVal / ySteps) * s);
    var y = padT + chartH - (s / ySteps) * chartH;
    var label = val >= 1000 ? Math.round(val/1000) + 'k' : val;
    yAxis += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" fill="#555" font-size="9" text-anchor="end">' + label + '</text>';
    yAxis += '<line x1="' + padL + '" y1="' + y + '" x2="' + (svgW - padR) + '" y2="' + y + '" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>';
  }

  var paths = '';
  datasets.forEach(function(ds) {
    var pts = [];
    var data = ds.data || [];
    for (var i = 0; i < data.length; i++) {
      var x = padL + (i / (data.length - 1 || 1)) * chartW;
      var y = padT + chartH - (data[i] / maxVal) * chartH;
      pts.push(x + ',' + y);
    }
    var c = ds.color || '#7c3aed';
    paths += '<polygon points="' + padL + ',' + (padT + chartH) + ' ' + pts.join(' ') + ' ' + (padL + chartW) + ',' + (padT + chartH) + '" fill="' + c + '" opacity="0.08"/>';
    paths += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
    for (var i = 0; i < pts.length; i++) {
      var xy = pts[i].split(',');
      paths += '<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="3" fill="' + c + '"><title>' + (data[i]||0) + '</title></circle>';
    }
  });

  var xlabels = '';
  for (var i = 0; i < labels.length; i++) {
    var x = padL + (i / (labels.length - 1 || 1)) * chartW;
    xlabels += '<text x="' + x + '" y="' + (svgH - 4) + '" fill="#666" font-size="9" text-anchor="middle">' + esc(labels[i]) + '</text>';
  }

  var legend = datasets.map(function(ds) {
    return '<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;"><span style="width:8px;height:3px;border-radius:2px;background:' + (ds.color||'#7c3aed') + ';display:inline-block;"></span><span style="font-size:0.7rem;color:#888;">' + esc(ds.label) + '</span></span>';
  }).join('');

  return '<div style="padding:14px 12px;">' +
    (d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:8px;">' + esc(d.title) + '</div>' : '') +
    '<svg width="100%" viewBox="0 0 ' + svgW + ' ' + svgH + '" preserveAspectRatio="xMidYMid meet">' + yAxis + paths + xlabels + '</svg>' +
    '<div style="margin-top:6px;">' + legend + '</div></div>';
};

// ── Chart Pie (SVG) ──
_canvasRenderers["chart-pie"] = function(d) {
  var items = d.items || d.slices || [];
  if (!items.length) return '<div style="padding:14px;color:#666;">No data</div>';
  var total = items.reduce(function(s, it) { return s + (it.value || 0); }, 0) || 1;
  var colors = ["#7c3aed","#e94560","#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4"];
  var cx = 60, cy = 60, r = 44, strokeW = 14;
  var circumference = 2 * Math.PI * r;
  var offset = 0;

  var rings = '';
  for (var i = 0; i < items.length; i++) {
    var frac = (items[i].value || 0) / total;
    var segLen = frac * circumference;
    var c = items[i].color || colors[i % colors.length];
    var delay = (i * 0.15).toFixed(2);
    rings += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + c + '" stroke-width="' + strokeW + '" ' +
      'stroke-dasharray="' + segLen.toFixed(1) + ' ' + (circumference - segLen).toFixed(1) + '" ' +
      'stroke-dashoffset="-' + offset.toFixed(1) + '" ' +
      'style="animation: pie-draw 0.8s cubic-bezier(0.16, 1, 0.3, 1) ' + delay + 's both; transition: stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease; opacity: 0.9;"' +
      '><title>' + esc(items[i].label) + ': ' + items[i].value + '</title></circle>';
    offset += segLen;
  }

  var svg = '<svg width="120" height="120" viewBox="0 0 120 120" style="transform: rotate(-90deg);">' + rings + '</svg>';

  var legend = items.map(function(it, i) {
    var c = it.color || colors[i % colors.length];
    return '<div style="display:flex;align-items:center;gap:6px;margin:2px 0;animation:fade-number 0.4s ease ' + (i*0.1).toFixed(1) + 's both;"><span style="width:8px;height:8px;border-radius:2px;background:'+c+';flex-shrink:0;"></span><span style="font-size:0.78rem;color:#bbb;">'+esc(it.label)+'</span><span style="font-size:0.72rem;color:#666;margin-left:auto;">'+it.value+'</span></div>';
  }).join('');

  return '<div style="padding:14px 12px;">' +
    (d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:8px;">'+esc(d.title)+'</div>' : '') +
    '<div style="display:flex;align-items:center;gap:16px;">' + svg +
    '<div style="flex:1;">'+legend+'</div></div></div>';
};

// ── Streak ──
_canvasRenderers.streak = function(d) {
  var days = d.days || [];
  var active = d.active || [];
  var cells = days.map(function(day, i) {
    var on = active[i];
    var bg = on ? '#10b981' : 'rgba(255,255,255,0.06)';
    var tc = on ? '#fff' : '#555';
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">' +
      '<div style="width:28px;height:28px;border-radius:6px;background:'+bg+';display:flex;align-items:center;justify-content:center;">' +
      (on ? '<span style="color:#fff;font-size:0.7rem;">✓</span>' : '') + '</div>' +
      '<span style="font-size:0.65rem;color:'+tc+';">'+esc(day)+'</span></div>';
  }).join('');
  return '<div style="padding:14px 12px;">' +
    (d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:10px;">'+esc(d.title)+'</div>' : '') +
    '<div style="display:flex;gap:6px;justify-content:center;">'+cells+'</div></div>';
};

// ── Rating ──
_canvasRenderers.rating = function(d) {
  var val = d.value || 0;
  var max = d.max || 5;
  var stars = '';
  for (var i = 1; i <= max; i++) {
    stars += '<span style="font-size:1.3rem;color:' + (i <= val ? '#f59e0b' : '#333') + ';">★</span>';
  }
  return '<div style="padding:14px 12px;text-align:center;">' +
    (d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:6px;">'+esc(d.title)+'</div>' : '') +
    '<div>'+stars+'</div></div>';
};

// ── Chips ──
_canvasRenderers.chips = function(d) {
  var chips = d.chips || [];
  var html = chips.map(function(c) {
    var label = typeof c === 'string' ? c : (c.text || c.label || '');
    var color = (typeof c === 'object' && c.color) ? c.color : '#7c3aed';
    var checked = typeof c === 'object' && c.checked;
    var bg = checked ? color+'44' : color+'22';
    var border = checked ? color+'88' : color+'33';
    var fw = checked ? '600' : '400';
    var ds = (typeof c === 'object' && c.value) ? ' data-sui-send="'+esc(c.value)+'"' : '';
    return '<span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:'+fw+';background:'+bg+';color:'+color+';border:1px solid '+border+';margin:3px;cursor:pointer;"'+ds+'>'+esc(label)+'</span>';
  }).join('');
  return '<div style="padding:14px 12px;">' +
    (d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:8px;">'+esc(d.title)+'</div>' : '') +
    '<div style="display:flex;flex-wrap:wrap;gap:2px;">'+html+'</div></div>';
};

// ── Weather ──
_canvasRenderers.weather = function(d) {
  var icon = d.icon || '🌤';
  return '<div style="padding:16px;text-align:center;">' +
    '<div style="font-size:2.4rem;margin-bottom:4px;">'+icon+'</div>' +
    '<div style="font-size:1.6rem;font-weight:600;color:#fff;">'+esc(d.temp || '--')+'°</div>' +
    '<div style="font-size:0.82rem;color:#bbb;">'+esc(d.city || d.location || '')+'</div>' +
    (d.condition ? '<div style="font-size:0.75rem;color:#888;margin-top:4px;">'+esc(d.condition)+'</div>' : '') +
    (d.humidity ? '<div style="font-size:0.7rem;color:#666;margin-top:2px;">💧 '+esc(d.humidity)+'%</div>' : '') +
  '</div>';
};

// ── Toggle ──
_canvasRenderers.toggle = function(d) {
  var on = d.value || d.checked || false;
  var bg = on ? '#10b981' : 'rgba(255,255,255,0.15)';
  var tx = on ? '2px' : '-22px';
  return '<div style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;">' +
    '<span style="font-size:0.82rem;color:#ddd;">'+esc(d.label || d.title || '')+'</span>' +
    '<div style="width:44px;height:24px;border-radius:12px;background:'+bg+';position:relative;transition:background 0.2s;cursor:pointer;" data-sui-send="toggle '+(d.id||d.label)+'">' +
    '<div style="width:20px;height:20px;border-radius:50%;background:#fff;position:absolute;top:2px;right:'+tx+';transition:right 0.2s;"></div></div></div>';
};

// ── Link Card ──
_canvasRenderers["link-card"] = function(d) {
  return '<div style="padding:14px 16px;">' +
    (d.icon ? '<div style="font-size:1.2rem;margin-bottom:6px;">'+esc(d.icon)+'</div>' : '') +
    '<div style="font-size:0.85rem;font-weight:500;color:#ddd;">'+esc(d.title || '')+'</div>' +
    (d.desc ? '<div style="font-size:0.78rem;color:#888;margin-top:4px;">'+esc(d.desc)+'</div>' : '') +
    (d.url ? '<a href="'+esc(d.url)+'" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;font-size:0.72rem;color:#7c3aed;text-decoration:none;">Open →</a>' : '') +
  '</div>';
};

// ── Input ──
_canvasRenderers.input = function(d) {
  return '<div style="padding:12px 14px;">' +
    (d.label ? '<div style="font-size:0.72rem;color:#888;margin-bottom:4px;">'+esc(d.label)+'</div>' : '') +
    '<input type="'+(d.type||'text')+'" placeholder="'+esc(d.placeholder||'')+'" value="'+esc(d.value||'')+'" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#e4e4e7;border-radius:6px;padding:8px 12px;font-size:0.82rem;outline:none;box-sizing:border-box;">' +
  '</div>';
};

// ── Slider ──
_canvasRenderers.slider = function(d) {
  var val = d.value || 50;
  var min = d.min || 0;
  var max = d.max || 100;
  return '<div style="padding:12px 14px;">' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">' +
    '<span style="font-size:0.75rem;color:#888;">'+esc(d.label || d.title || '')+'</span>' +
    '<span style="font-size:0.75rem;color:#ddd;">'+val+'</span></div>' +
    '<input type="range" min="'+min+'" max="'+max+'" value="'+val+'" style="width:100%;accent-color:#7c3aed;">' +
  '</div>';
};

// ── Tabs ──
_canvasRenderers.tabs = function(d) {
  var tabs = d.tabs || [];
  var active = d.active || 0;
  var tabHtml = tabs.map(function(t, i) {
    var label = typeof t === 'string' ? t : t.label;
    var sel = i === active;
    return '<div style="padding:8px 16px;font-size:0.8rem;cursor:pointer;border-bottom:2px solid '+(sel?'#7c3aed':'transparent')+';color:'+(sel?'#fff':'#888')+';transition:all 0.2s;">'+esc(label)+'</div>';
  }).join('');
  var content = '';
  if (tabs[active] && typeof tabs[active] === 'object' && tabs[active].content) {
    content = '<div style="padding:12px;font-size:0.82rem;color:#bbb;">'+esc(tabs[active].content)+'</div>';
  }
  return '<div>' +
    (d.title ? '<div style="padding:12px 14px 0;font-size:0.75rem;color:#888;letter-spacing:0.02em;">'+esc(d.title)+'</div>' : '') +
    '<div style="display:flex;border-bottom:1px solid rgba(255,255,255,0.06);padding:0 8px;">'+tabHtml+'</div>' +
    content + '</div>';
};

// ── Stacked Bar ──
_canvasRenderers["stacked-bar"] = function(d) {
  var items = d.items || [];
  var total = items.reduce(function(s, it) { return s + (it.value||0); }, 0) || 1;
  var colors = ["#7c3aed","#e94560","#3b82f6","#10b981","#f59e0b"];
  var bar = items.map(function(it, i) {
    var pct = ((it.value||0) / total * 100).toFixed(1);
    var c = it.color || colors[i % colors.length];
    return '<div style="width:'+pct+'%;height:100%;background:'+c+';transition:width 0.3s;" title="'+esc(it.label)+': '+it.value+'"></div>';
  }).join('');
  var legend = items.map(function(it, i) {
    var c = it.color || colors[i % colors.length];
    return '<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:0.7rem;color:#888;"><span style="width:8px;height:8px;border-radius:2px;background:'+c+';"></span>'+esc(it.label)+'</span>';
  }).join('');
  return '<div style="padding:14px 12px;">' +
    (d.title ? '<div style="font-size:0.75rem;color:#888;letter-spacing:0.02em;margin-bottom:8px;">'+esc(d.title)+'</div>' : '') +
    '<div style="height:20px;border-radius:10px;overflow:hidden;display:flex;background:rgba(255,255,255,0.04);">'+bar+'</div>' +
    '<div style="margin-top:6px;">'+legend+'</div></div>';
};

// ── Video ──
_canvasRenderers.video = function(d) {
  return '<div style="padding:8px;">' +
    (d.title ? '<div style="font-size:0.75rem;color:#888;padding:4px 6px;">'+esc(d.title)+'</div>' : '') +
    '<video controls preload="metadata" style="width:100%;border-radius:6px;" src="'+esc(d.url || d.src || '')+'"></video></div>';
};

// ── Image ──
_canvasRenderers.image = function(d) {
  return '<div style="padding:8px;">' +
    (d.title || d.caption ? '<div style="font-size:0.75rem;color:#888;padding:4px 6px;">'+esc(d.title || d.caption)+'</div>' : '') +
    '<img src="'+esc(d.url || d.src || '')+'" alt="'+esc(d.alt || d.title || '')+'" style="width:100%;border-radius:6px;display:block;" loading="lazy"></div>';
};

// ── Form Strip ──
_canvasRenderers["form-strip"] = function(d) {
  var fields = d.fields || [];
  var html = fields.map(function(f) {
    return '<input type="'+(f.type||'text')+'" placeholder="'+esc(f.placeholder || f.label || '')+'" style="flex:1;min-width:100px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#e4e4e7;border-radius:6px;padding:6px 10px;font-size:0.8rem;outline:none;">';
  }).join('');
  var action = d.action || d.label || 'Submit';
  return '<div style="padding:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' + html +
    '<button data-sui-send="'+esc(action)+'" style="padding:6px 14px;border-radius:6px;border:none;background:#7c3aed;color:#fff;font-size:0.78rem;cursor:pointer;white-space:nowrap;">'+esc(action)+'</button></div>';
};
