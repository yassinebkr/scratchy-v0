// ============================================
// Scratchy — Simple Markdown Renderer
// ============================================
// Converts markdown text to HTML. Lightweight, no dependencies.
// Supports: code blocks, inline code, bold, italic, headers,
// lists, links, and line breaks.

// Global toggle — checked by the markdown renderer
var SCRATCHY_GENUI_ENABLED = true;

function renderMarkdown(text, opts) {
  // opts.streaming: true when rendering a streaming delta (incomplete text)
  var isStreaming = opts && opts.streaming;

  // Escape HTML first (prevent XSS)
  let html = escapeHtmlForMd(text);

  // Step 1: Extract code blocks and inline code FIRST, replace with placeholders
  // This prevents markdown rules from mangling underscores/asterisks inside code
  var codeParts = [];

  // Code blocks: ```lang\ncode\n``` → placeholder
  // COMPLETED blocks render immediately (even during streaming)
  // Special: ```scratchy-ui and ```scratchy-canvas blocks get rendered as interactive components
  // Closing ``` must be on its own line (after \n) to avoid matching ``` inside code content
  html = html.replace(/```(\w[\w-]*)\s*\n([\s\S]*?)\n```/g, function(match, lang, code) {
    var idx = codeParts.length;
    if (lang === "scratchy-ui" && SCRATCHY_GENUI_ENABLED && typeof renderComponent === "function") {
      codeParts.push(renderComponent(unescapeHtmlEntities(code.trim())));
    } else if ((lang === "scratchy-canvas" || lang === "scratchy-toon" || lang === "scratchy-tpl") && SCRATCHY_GENUI_ENABLED) {
      // Canvas/TOON/template ops go to canvas only — never render in chat
      codeParts.push("");
    } else {
      // Security (C1): do NOT call unescapeHtmlEntities — content is already HTML-escaped
      // by escapeHtmlForMd(). Unescaping would re-enable XSS in code blocks.
      // Browsers render &lt; as < inside <code> when using innerHTML, so display is correct.
      codeParts.push(
        '<div class="sui-code">' +
          '<div class="sui-code-header">' +
            '<span class="sui-code-lang">' + lang + '</span>' +
            '<button class="sui-code-copy" onclick="var t=this.closest(\'.sui-code\').querySelector(\'pre code\').textContent;navigator.clipboard.writeText(t);this.textContent=\'Copied!\';var b=this;setTimeout(function(){b.textContent=\'Copy\'},1500)">Copy</button>' +
          '</div>' +
          '<pre><code class="language-' + lang + '">' + code.trim() + '</code></pre>' +
        '</div>'
      );
    }
    return '%%CODE_BLOCK_' + idx + '%%';
  });

  // When streaming, hide any trailing INCOMPLETE code block
  // (no closing ``` yet — would leak raw content)
  if (isStreaming) {
    html = html.replace(/```([\w-]*)[\s\S]*$/g, function(match, lang) {
      var idx = codeParts.length;
      if (lang === "scratchy-canvas" || lang === "scratchy-a2ui" || lang === "scratchy-toon" || lang === "scratchy-tpl") {
        codeParts.push('<div class="sui-loading">🎨 Updating canvas...</div>');
      } else {
        codeParts.push('<div class="sui-loading">✨ rendering...</div>');
      }
      return '%%CODE_BLOCK_' + idx + '%%';
    });
  }

  // Also handle code blocks without language (closing ``` must be on its own line)
  html = html.replace(/```\s*\n([\s\S]*?)\n```/g, function(match, code) {
    var idx = codeParts.length;
    // Security (C1): do NOT unescape — keep HTML-escaped content safe
    codeParts.push(
      '<div class="sui-code">' +
        '<div class="sui-code-header">' +
          '<span class="sui-code-lang"></span>' +
          '<button class="sui-code-copy" onclick="var t=this.closest(\'.sui-code\').querySelector(\'pre code\').textContent;navigator.clipboard.writeText(t);this.textContent=\'Copied!\';var b=this;setTimeout(function(){b.textContent=\'Copy\'},1500)">Copy</button>' +
        '</div>' +
        '<pre><code>' + code.trim() + '</code></pre>' +
      '</div>'
    );
    return '%%CODE_BLOCK_' + idx + '%%';
  });

  // Inline code: `code` → placeholder
  // Security (C1): do NOT unescape — keep HTML-escaped content safe
  // If the code content is a workspace .md file path, make it clickable instead
  var _mdFilePattern = /^(?:memory\/[\w\/.\-]+\.md|(?:MEMORY|AGENTS|SOUL|USER|TOOLS|HEARTBEAT)\.md)$/;
  html = html.replace(/`([^`]+)`/g, function(match, code) {
    var idx = codeParts.length;
    if (_mdFilePattern.test(code)) {
      codeParts.push('<span class="md-file-link" data-filepath="' + code + '" onclick="window.openWorkspaceFile(this.dataset.filepath)">\ud83d\udcc4 ' + code + '</span>');
    } else {
      codeParts.push('<code>' + code + '</code>');
    }
    return '%%CODE_BLOCK_' + idx + '%%';
  });

  // Step 2: Apply markdown formatting (safe — no code to corrupt)

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* (only asterisks — underscores are too risky in technical text)
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // Tables: | col | col | with | --- | --- | separator
  html = html.replace(/((?:^\|.+\|[ \t]*$\n?)+)/gm, function(block) {
    var rows = block.trim().split('\n');
    if (rows.length < 2) return block;
    // Check row 2 is a separator (| --- | --- |)
    if (!/^\|[\s\-:|]+\|$/.test(rows[1])) return block;
    
    // Parse alignment from separator row
    var aligns = rows[1].replace(/^\||\|$/g, '').split('|').map(function(c) {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    
    // Build header
    var headerCells = rows[0].replace(/^\||\|$/g, '').split('|');
    var thead = '<thead><tr>' + headerCells.map(function(c, i) {
      return '<th style="text-align:' + (aligns[i] || 'left') + '">' + c.trim() + '</th>';
    }).join('') + '</tr></thead>';
    
    // Build body
    var tbody = '<tbody>';
    for (var r = 2; r < rows.length; r++) {
      if (!rows[r].trim()) continue;
      var cells = rows[r].replace(/^\||\|$/g, '').split('|');
      tbody += '<tr>' + cells.map(function(c, i) {
        return '<td style="text-align:' + (aligns[i] || 'left') + '">' + c.trim() + '</td>';
      }).join('') + '</tr>';
    }
    tbody += '</tbody>';
    
    return '<div class="md-table-wrap"><table class="md-table">' + thead + tbody + '</table></div>';
  });

  // Headers: ### text
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // Unordered lists: - item
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Images: ![alt](url) — must come BEFORE links to avoid partial match
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:4px 0" loading="lazy">');

  // Links: [text](url) — block dangerous URI schemes
  // Allow optional whitespace/newlines between ] and ( for tolerance
  html = html.replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, function(match, text, url) {
    if (/^\s*(javascript|vbscript|data\s*:)/i.test(url)) return text;
    return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
  });

  // Workspace file paths: detect and make clickable
  // Must run after links to avoid double-matching, but before code block restoration
  // Note: text is already HTML-escaped at this point, so filepath chars are safe
  html = html.replace(/(^|\s)((?:memory\/[\w\/.\-]+\.md|(?:MEMORY|AGENTS|SOUL|USER|TOOLS|HEARTBEAT)\.md))/g, function(match, leading, filepath) {
    return leading + '<span class="md-file-link" data-filepath="' + filepath + '" onclick="window.openWorkspaceFile(this.dataset.filepath)">\ud83d\udcc4 ' + filepath + '</span>';
  });

  // Step 3: Restore code blocks from placeholders
  for (var i = 0; i < codeParts.length; i++) {
    html = html.replace('%%CODE_BLOCK_' + i + '%%', codeParts[i]);
  }

  // Step 4: Clean up newlines around block-level elements.
  // CSS white-space: pre-wrap on .message-body renders literal \n as line breaks.
  // Block elements (pre, ul, h2-h4, div, table, li) already create visual breaks
  // via display:block / margins, so \n adjacent to them causes double-spacing.
  // Strip those \n characters — but only around block tags, not inside <pre> content.

  // Split on <pre>...</pre> to avoid touching code block internals
  var segments = html.split(/(<pre[\s\S]*?<\/pre>)/g);
  for (var j = 0; j < segments.length; j++) {
    // Only process non-<pre> segments (odd indices are the <pre> blocks)
    if (j % 2 === 0) {
      segments[j] = segments[j]
        .replace(/\n+(<\/?(ul|li|h[2-4]|div|table)[^>]*>)/g, '$1')
        .replace(/(<\/?(ul|li|h[2-4]|div|table)[^>]*>)\n+/g, '$1');
    }
  }
  html = segments.join('');

  // Strip \n immediately before/after <pre> and </pre> tags (these are outside the pre content)
  html = html.replace(/\n+(<pre[\s>])/g, '$1');
  html = html.replace(/(<\/pre>)\n+/g, '$1');

  html = html.replace(/^\n+|\n+$/g, ''); // trim leading/trailing newlines

  return html;
}

// Detect and render media (audio/video URLs)
function renderMedia(text) {
  // Security (C2): escape double quotes in URLs to prevent attribute breakout XSS
  function sanitizeMediaUrl(url) {
    return url.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Audio files
  const audioPattern = /(https?:\/\/[^\s]+\.(mp3|ogg|wav|m4a)(\?[^\s]*)?)/gi;
  text = text.replace(audioPattern, function(url) {
    return '<div class="media-player"><audio controls preload="metadata" src="' + sanitizeMediaUrl(url) + '"></audio></div>';
  });

  // Video files
  const videoPattern = /(https?:\/\/[^\s]+\.(mp4|webm|mov)(\?[^\s]*)?)/gi;
  text = text.replace(videoPattern, function(url) {
    return '<div class="media-player"><video controls preload="metadata" src="' + sanitizeMediaUrl(url) + '"></video></div>';
  });

  return text;
}

function escapeHtmlForMd(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Reverse escapeHtmlForMd for content inside code blocks
// so that >, <, &, " render as actual characters in <code>/<pre>
function unescapeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'");
}

// Hydrate live component placeholders after DOM insertion
// Call this on any container that may have lc-inline-mount divs
function hydrateLiveComponents(container) {
  if (typeof LiveComponents === "undefined") return;
  var mounts = container.querySelectorAll(".lc-inline-mount");
  for (var i = 0; i < mounts.length; i++) {
    var m = mounts[i];
    if (m.dataset.lcHydrated) continue; // already done
    var type = m.dataset.lcType;
    var data = {};
    try { data = JSON.parse(m.dataset.lcOp); } catch(e) {}
    var lc = LiveComponents.create(type, data);
    if (lc) {
      m.innerHTML = "";
      m.appendChild(lc.el);
      m.dataset.lcHydrated = "1";
      // Store instance for future patches
      m._liveComp = lc;
    } else if (typeof renderComponent === "function") {
      // Fallback to HTML renderer
      var d = Object.assign({}, data, { component: type });
      m.innerHTML = renderComponent(JSON.stringify(d));
      m.dataset.lcHydrated = "1";
    }
  }
}
