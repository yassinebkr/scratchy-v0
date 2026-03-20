/**
 * md-file-viewer-ui.js
 * 
 * A self-contained markdown file viewer overlay for Scratchy v1.
 * Provides a beautiful dark-themed modal to display rendered markdown files.
 * 
 * Usage:
 *   window.showMarkdownViewer('/path/to/file.md', '# Hello\nSome content...');
 * 
 * No external dependencies. All CSS is injected on first use.
 */

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────
  let styleInjected = false;
  let activeOverlay = null;

  // ─── CSS Injection ───────────────────────────────────────────────────
  function injectStyles() {
    if (styleInjected) return;
    styleInjected = true;

    const css = `
/* ── Backdrop ─────────────────────────────────────────────────────── */
.mdv-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity 150ms ease;
  padding: 24px;
}
.mdv-overlay.mdv-visible {
  opacity: 1;
}

/* ── Panel ─────────────────────────────────────────────────────────── */
.mdv-panel {
  width: 100%;
  max-width: 720px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-2, #141722);
  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.14));
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
  overflow: hidden;
  transform: translateY(8px) scale(0.98);
  transition: transform 150ms ease, opacity 150ms ease;
  opacity: 0;
}
.mdv-overlay.mdv-visible .mdv-panel {
  transform: translateY(0) scale(1);
  opacity: 1;
}

/* ── Header ────────────────────────────────────────────────────────── */
.mdv-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.07));
  background: var(--surface-3, #1a1e2c);
  flex-shrink: 0;
}
.mdv-file-icon {
  font-size: 20px;
  line-height: 1;
  flex-shrink: 0;
  margin-top: 2px;
}
.mdv-file-info {
  flex: 1;
  min-width: 0;
}
.mdv-filename {
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e8eaed);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}
.mdv-filepath {
  font-family: 'Geist Mono', 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: var(--text-tertiary, #555a72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
  line-height: 1.3;
}
.mdv-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.mdv-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #8b8fa7);
  cursor: pointer;
  font-size: 16px;
  transition: background 150ms ease, color 150ms ease;
  font-family: 'Geist', -apple-system, sans-serif;
  line-height: 1;
}
.mdv-btn:hover {
  background: var(--overlay-04, rgba(255, 255, 255, 0.04));
  color: var(--text-primary, #e8eaed);
}
.mdv-btn-close {
  font-size: 20px;
  font-weight: 300;
}
.mdv-btn svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Copy feedback */
.mdv-btn.mdv-copied {
  color: #34d399;
}

/* ── Content ───────────────────────────────────────────────────────── */
.mdv-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  overscroll-behavior: contain;
}

/* Custom scrollbar */
.mdv-content::-webkit-scrollbar {
  width: 6px;
}
.mdv-content::-webkit-scrollbar-track {
  background: transparent;
}
.mdv-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}
.mdv-content::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.18);
}

/* ── Markdown Typography ───────────────────────────────────────────── */
.mdv-body {
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary, #e8eaed);
  word-wrap: break-word;
  overflow-wrap: break-word;
}

/* Headings */
.mdv-body h1, .mdv-body h2, .mdv-body h3,
.mdv-body h4, .mdv-body h5, .mdv-body h6 {
  color: var(--accent-bright, #818cf8);
  font-weight: 600;
  line-height: 1.3;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}
.mdv-body h1:first-child, .mdv-body h2:first-child, .mdv-body h3:first-child {
  margin-top: 0;
}
.mdv-body h1 { font-size: 1.6em; }
.mdv-body h2 { font-size: 1.35em; }
.mdv-body h3 { font-size: 1.15em; }
.mdv-body h4 { font-size: 1.05em; }
.mdv-body h5 { font-size: 1em; }
.mdv-body h6 { font-size: 0.95em; color: var(--text-secondary, #8b8fa7); }

/* Horizontal rule */
.mdv-body hr {
  border: none;
  height: 1px;
  background: var(--border, rgba(255, 255, 255, 0.07));
  margin: 1.5em 0;
}

/* Paragraphs */
.mdv-body p {
  margin: 0 0 1em;
}
.mdv-body p:last-child {
  margin-bottom: 0;
}

/* Bold & italic */
.mdv-body strong { font-weight: 600; }
.mdv-body em { font-style: italic; }

/* Links */
.mdv-body a {
  color: var(--accent, #6366f1);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 150ms ease;
}
.mdv-body a:hover {
  border-bottom-color: var(--accent, #6366f1);
}

/* Lists */
.mdv-body ul, .mdv-body ol {
  margin: 0 0 1em;
  padding-left: 1.5em;
}
.mdv-body li {
  margin-bottom: 0.35em;
}
.mdv-body li > ul, .mdv-body li > ol {
  margin-top: 0.35em;
  margin-bottom: 0;
}

/* Inline code */
.mdv-body code {
  font-family: 'Geist Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.88em;
  background: var(--surface-0, #08090e);
  color: #c4b5fd;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
}

/* Code blocks */
.mdv-body .mdv-code-block {
  position: relative;
  margin: 1em 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
}
.mdv-body .mdv-code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.07));
}
.mdv-body .mdv-code-lang {
  font-family: 'Geist Mono', 'SF Mono', monospace;
  font-size: 11px;
  color: var(--text-tertiary, #555a72);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.mdv-body .mdv-code-copy {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--text-tertiary, #555a72);
  cursor: pointer;
  font-family: 'Geist', -apple-system, sans-serif;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background 150ms ease, color 150ms ease;
}
.mdv-body .mdv-code-copy:hover {
  background: var(--overlay-04, rgba(255, 255, 255, 0.04));
  color: var(--text-secondary, #8b8fa7);
}
.mdv-body .mdv-code-copy.mdv-copied {
  color: #34d399;
}
.mdv-body .mdv-code-copy svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.mdv-body pre {
  margin: 0;
  padding: 14px 16px;
  background: var(--surface-0, #08090e);
  overflow-x: auto;
}
.mdv-body pre code {
  background: none;
  border: none;
  padding: 0;
  border-radius: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-primary, #e8eaed);
}

/* Blockquotes */
.mdv-body blockquote {
  margin: 1em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--accent-border, rgba(99, 102, 241, 0.25));
  background: var(--accent-subtle, rgba(99, 102, 241, 0.1));
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary, #8b8fa7);
}
.mdv-body blockquote p {
  margin: 0.25em 0;
}

/* Tables */
.mdv-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 13px;
}
.mdv-body thead th {
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary, #8b8fa7);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-strong, rgba(255, 255, 255, 0.14));
  background: var(--surface-3, #1a1e2c);
}
.mdv-body tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.07));
  color: var(--text-primary, #e8eaed);
}
.mdv-body tbody tr:last-child td {
  border-bottom: none;
}
.mdv-body tbody tr:hover td {
  background: var(--overlay-04, rgba(255, 255, 255, 0.04));
}

/* Images */
.mdv-body img {
  max-width: 100%;
  border-radius: 8px;
  margin: 0.5em 0;
}

/* Checkbox lists (task lists) */
.mdv-body .mdv-task-item {
  list-style: none;
  margin-left: -1.5em;
}
.mdv-body .mdv-task-item input[type="checkbox"] {
  margin-right: 6px;
  accent-color: var(--accent, #6366f1);
}

/* ── .md-file-link pill (clickable links in chat) ─────────────────── */
.md-file-link {
  display: inline;
  background: var(--accent-subtle, rgba(99, 102, 241, 0.1));
  border: 1px solid var(--accent-border, rgba(99, 102, 241, 0.25));
  color: var(--accent-bright, #818cf8);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 0.9em;
  font-weight: 500;
  text-decoration: none;
  transition: background 150ms ease, border-color 150ms ease;
  white-space: nowrap;
}
.md-file-link:hover {
  background: rgba(99, 102, 241, 0.18);
  border-color: rgba(99, 102, 241, 0.4);
}

/* ── Mobile (< 640px) ─────────────────────────────────────────────── */
@media (max-width: 639px) {
  .mdv-overlay {
    padding: 0;
    align-items: flex-end;
  }
  .mdv-panel {
    max-width: 100%;
    max-height: 92vh;
    border-radius: 12px 12px 0 0;
    border-bottom: none;
  }
  .mdv-content {
    padding: 16px;
  }
  .mdv-header {
    padding: 14px 16px;
  }
}
`;

    const style = document.createElement('style');
    style.id = 'mdv-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ─── Simple Markdown → HTML renderer ─────────────────────────────────
  // Handles: headings, bold, italic, strikethrough, inline code, code blocks,
  // links, images, tables, blockquotes, lists (ordered + unordered), hr, task lists.

  function renderMarkdown(md) {
    // Normalize line endings
    md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // ── Phase 1: Extract fenced code blocks to protect them ──
    const codeBlocks = [];
    md = md.replace(/^```(\w*)\n([\s\S]*?)^```/gm, function (_, lang, code) {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
      return '\x00CODEBLOCK_' + idx + '\x00';
    });

    // ── Phase 2: Process block-level elements line by line ──
    const lines = md.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Code block placeholder
      const cbMatch = line.match(/^\x00CODEBLOCK_(\d+)\x00$/);
      if (cbMatch) {
        const cb = codeBlocks[parseInt(cbMatch[1])];
        const escaped = escapeHtml(cb.code);
        const langLabel = cb.lang ? cb.lang : 'code';
        html += '<div class="mdv-code-block">'
          + '<div class="mdv-code-header">'
          + '<span class="mdv-code-lang">' + escapeHtml(langLabel) + '</span>'
          + '<button class="mdv-code-copy" onclick="window._mdvCopyCode(this)" title="Copy code">'
          + '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>'
          + '<span>Copy</span></button>'
          + '</div>'
          + '<pre><code>' + escaped + '</code></pre>'
          + '</div>';
        i++;
        continue;
      }

      // Horizontal rule
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
        html += '<hr>';
        i++;
        continue;
      }

      // Headings (ATX)
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        html += '<h' + level + '>' + inlineMarkdown(headingMatch[2]) + '</h' + level + '>';
        i++;
        continue;
      }

      // Table: detect header row + separator row
      if (i + 1 < lines.length && line.includes('|') && /^\|?\s*[-:]+[-|:\s]+$/.test(lines[i + 1])) {
        html += parseTable(lines, i);
        // Skip past table rows
        i++; // header
        i++; // separator
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          i++;
        }
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        let bqLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          bqLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        html += '<blockquote>' + renderMarkdown(bqLines.join('\n')) + '</blockquote>';
        continue;
      }

      // Unordered list
      if (/^(\s*)([-*+])\s/.test(line)) {
        const result = parseList(lines, i, 'ul');
        html += result.html;
        i = result.nextIndex;
        continue;
      }

      // Ordered list
      if (/^(\s*)\d+\.\s/.test(line)) {
        const result = parseList(lines, i, 'ol');
        html += result.html;
        i = result.nextIndex;
        continue;
      }

      // Blank line
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph: collect contiguous non-blank, non-block lines
      let pLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*[-*+]\s/.test(lines[i]) &&
        !/^\s*\d+\.\s/.test(lines[i]) &&
        !/^\x00CODEBLOCK_\d+\x00$/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+[-|:\s]+$/.test(lines[i + 1]))
      ) {
        pLines.push(lines[i]);
        i++;
      }
      if (pLines.length > 0) {
        html += '<p>' + inlineMarkdown(pLines.join('\n')) + '</p>';
      }
    }

    return html;
  }

  /**
   * Parse a list (ul or ol) starting at index i.
   * Returns { html, nextIndex }.
   */
  function parseList(lines, i, tag) {
    const items = [];
    const pattern = tag === 'ul' ? /^(\s*)([-*+])\s(.*)/ : /^(\s*)\d+\.\s(.*)/;

    // Determine base indent
    const baseMatch = lines[i].match(/^(\s*)/);
    const baseIndent = baseMatch ? baseMatch[1].length : 0;

    while (i < lines.length) {
      const line = lines[i];
      const listMatch = tag === 'ul' ? line.match(/^(\s*)([-*+])\s(.*)/) : line.match(/^(\s*)\d+\.\s(.*)/);

      if (listMatch) {
        const indent = listMatch[1].length;
        if (indent < baseIndent) break; // Outdented — end of this list
        if (indent > baseIndent) {
          // Nested list — recurse
          const nestedTag = /^\s*[-*+]\s/.test(line) ? 'ul' : 'ol';
          const nested = parseList(lines, i, nestedTag);
          if (items.length > 0) {
            items[items.length - 1].nested = nested.html;
          }
          i = nested.nextIndex;
          continue;
        }
        // Same level
        const content = tag === 'ul' ? listMatch[3] : listMatch[2];
        items.push({ content: content, nested: '' });
        i++;
      } else if (line.trim() === '') {
        // Blank line might end the list or be between items
        if (i + 1 < lines.length && pattern.test(lines[i + 1])) {
          i++;
          continue;
        }
        break;
      } else {
        break;
      }
    }

    let html = '<' + tag + '>';
    for (const item of items) {
      // Task list detection
      const taskMatch = item.content.match(/^\[([ xX])\]\s(.*)/);
      if (taskMatch) {
        const checked = taskMatch[1] !== ' ' ? ' checked disabled' : ' disabled';
        html += '<li class="mdv-task-item"><input type="checkbox"' + checked + '>' + inlineMarkdown(taskMatch[2]) + item.nested + '</li>';
      } else {
        html += '<li>' + inlineMarkdown(item.content) + item.nested + '</li>';
      }
    }
    html += '</' + tag + '>';

    return { html: html, nextIndex: i };
  }

  /**
   * Parse a markdown table starting at line index i.
   */
  function parseTable(lines, i) {
    // Header row
    const headers = parseTableRow(lines[i]);
    // Skip separator (i+1)
    const bodyStart = i + 2;
    const rows = [];
    for (let j = bodyStart; j < lines.length; j++) {
      if (!lines[j].includes('|') || lines[j].trim() === '') break;
      rows.push(parseTableRow(lines[j]));
    }

    let html = '<table><thead><tr>';
    for (const h of headers) {
      html += '<th>' + inlineMarkdown(h) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (const row of rows) {
      html += '<tr>';
      for (let c = 0; c < headers.length; c++) {
        html += '<td>' + inlineMarkdown(row[c] || '') + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function parseTableRow(line) {
    // Strip leading/trailing pipes and split
    return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
  }

  /**
   * Render inline markdown: bold, italic, strikethrough, code, links, images.
   */
  function inlineMarkdown(text) {
    // Escape HTML first
    text = escapeHtml(text);

    // Inline code (must come early to protect contents)
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Images: ![alt](url)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

    // Links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Bold + italic: ***text*** or ___text___
    text = text.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>');
    text = text.replace(/_{3}(.+?)_{3}/g, '<strong><em>$1</em></strong>');

    // Bold: **text** or __text__
    text = text.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>');
    text = text.replace(/_{2}(.+?)_{2}/g, '<strong>$1</strong>');

    // Italic: *text* or _text_
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>');

    // Strikethrough: ~~text~~
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Line breaks
    text = text.replace(/\n/g, '<br>');

    return text;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Copy helpers ────────────────────────────────────────────────────

  /** Copy code block content (attached to code block copy buttons). */
  window._mdvCopyCode = function (btn) {
    const pre = btn.closest('.mdv-code-block').querySelector('pre code');
    if (!pre) return;
    const text = pre.textContent;
    navigator.clipboard.writeText(text).then(function () {
      btn.classList.add('mdv-copied');
      btn.querySelector('span').textContent = 'Copied!';
      setTimeout(function () {
        btn.classList.remove('mdv-copied');
        btn.querySelector('span').textContent = 'Copy';
      }, 1500);
    });
  };

  // ─── Close overlay ───────────────────────────────────────────────────

  function closeViewer() {
    if (!activeOverlay) return;
    activeOverlay.classList.remove('mdv-visible');
    const overlay = activeOverlay;
    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 160);
    activeOverlay = null;
  }

  // ─── Keyboard handler ───────────────────────────────────────────────

  function onKeyDown(e) {
    if (e.key === 'Escape' && activeOverlay) {
      closeViewer();
    }
  }

  // ─── Main entry point ───────────────────────────────────────────────

  /**
   * Show the markdown viewer overlay.
   * @param {string} filepath  Full path to the file (displayed in header)
   * @param {string} markdownContent  Raw markdown string to render
   */
  window.showMarkdownViewer = function (filepath, markdownContent) {
    injectStyles();

    // Close any existing viewer
    if (activeOverlay) closeViewer();

    // Extract basename from path
    const basename = filepath.split('/').pop() || filepath;

    // Build DOM
    const overlay = document.createElement('div');
    overlay.className = 'mdv-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Markdown file viewer: ' + basename);

    // SVG icons
    const copyIcon = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    const checkIcon = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

    overlay.innerHTML =
      '<div class="mdv-panel">'
      + '<div class="mdv-header">'
      +   '<span class="mdv-file-icon">📄</span>'
      +   '<div class="mdv-file-info">'
      +     '<div class="mdv-filename">' + escapeHtml(basename) + '</div>'
      +     '<div class="mdv-filepath">' + escapeHtml(filepath) + '</div>'
      +   '</div>'
      +   '<div class="mdv-header-actions">'
      +     '<button class="mdv-btn mdv-btn-copy" title="Copy raw markdown">' + copyIcon + '</button>'
      +     '<button class="mdv-btn mdv-btn-close" title="Close (Esc)">&times;</button>'
      +   '</div>'
      + '</div>'
      + '<div class="mdv-content">'
      +   '<div class="mdv-body">' + renderMarkdown(markdownContent) + '</div>'
      + '</div>'
      + '</div>';

    // ── Event bindings ──

    // Backdrop click to close
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeViewer();
    });

    // Close button
    overlay.querySelector('.mdv-btn-close').addEventListener('click', closeViewer);

    // Copy raw markdown button
    const copyBtn = overlay.querySelector('.mdv-btn-copy');
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(markdownContent).then(function () {
        copyBtn.classList.add('mdv-copied');
        copyBtn.innerHTML = checkIcon;
        setTimeout(function () {
          copyBtn.classList.remove('mdv-copied');
          copyBtn.innerHTML = copyIcon;
        }, 1500);
      });
    });

    // Keyboard
    document.addEventListener('keydown', onKeyDown);

    // Mount & animate in
    document.body.appendChild(overlay);
    activeOverlay = overlay;

    // Trigger reflow for animation
    void overlay.offsetHeight;
    overlay.classList.add('mdv-visible');

    // Focus the panel for accessibility
    overlay.querySelector('.mdv-btn-close').focus();
  };

  /**
   * Programmatically close the markdown viewer.
   */
  window.closeMarkdownViewer = closeViewer;

  // Inject styles immediately so .md-file-link pills render correctly
  // before anyone clicks to open the viewer
  injectStyles();

})();
