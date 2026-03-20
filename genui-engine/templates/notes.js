/**
 * Standard Notes Widget — Standalone App
 * Complete note management via sn-cli with env-based auth.
 * No agent hooks. No chat forwarding. Fully autonomous.
 *
 * KNOWN LIMITATION: sn-cli has no programmatic in-place edit command.
 *   - `sn edit note` only supports --editor (interactive), no --text flag.
 *   - `sn add note --replace` matches by title but creates duplicates on race conditions.
 *   - `sn edit note --editor` with a fake EDITOR script works mechanically but the
 *     second sync (save-back) consistently fails with "Network connectivity" errors,
 *     likely a rate-limit collision in sn-cli's double-sync flow.
 *
 * CURRENT STRATEGY: All edits use delete-by-UUID + add-new.
 *   - Atomic: UUID is unique, no duplicate risk.
 *   - Trade-off: UUID changes on edit, created_at timestamp is lost.
 *   - Both are invisible to the user (widget shows title/content/updated_at only).
 *
 * FUTURE: Build a direct SN REST API client with client-side encryption
 *   to enable true UUID-targeted PATCH operations. Requires implementing SN's
 *   encryption protocol (AES-256-CBC, per-item keys derived from user password).
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getWidgetStatePath, migrateLegacyFile } = require('../../lib/widget-state');

const LEGACY_CREDS_FILE = path.join(__dirname, '..', '..', '.sn-session.json');

class StandardNotesWidget {
  constructor(userId) {
    this._userId = userId || '_legacy';
    // Migrate legacy root-level session file on first access
    // SECURITY: migrateLegacyFile now enforces admin-only (lib/widget-state.js)
    migrateLegacyFile(LEGACY_CREDS_FILE, this._userId, 'sn-session.json');
    this._credsFile = getWidgetStatePath(this._userId, 'sn-session.json');
    this.creds = null;
    this.notes = [];          // Normalized: [{ uuid, title, text, created_at, updated_at }]
    this.selectedNote = null;
    this.searchQuery = '';
    this.stats = { total: 0, tags: 0, lastSync: null };
    this._loadSession();
  }

  // ─── Session persistence ───────────────────────────────────
  _saveSession() {
    if (!this.creds) return;
    try { fs.writeFileSync(this._credsFile, JSON.stringify(this.creds), { mode: 0o600 }); }
    catch (e) { console.error('[SN] Save session error:', e.message); }
  }
  _loadSession() {
    try {
      if (fs.existsSync(this._credsFile)) {
        const d = JSON.parse(fs.readFileSync(this._credsFile, 'utf8'));
        if (d.email && d.password) { this.creds = d; console.log('[SN] Session restored:', d.email); }
      }
    } catch {}
  }
  _clearSession() { try { fs.unlinkSync(this._credsFile); } catch {} }

  // ─── SN-CLI executor ──────────────────────────────────────
  _exec(args, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (this.creds) {
        env.SN_EMAIL = this.creds.email;
        env.SN_PASSWORD = this.creds.password;
        env.SN_SERVER = this.creds.server || 'https://api.standardnotes.com';
      }
      execFile('sn', args, { env, timeout }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      });
    });
  }

  // ─── Normalize sn-cli JSON output ─────────────────────────
  // sn returns: { items: [{ uuid, content: { title, text }, created_at, updated_at }] }
  // We normalize to flat: [{ uuid, title, text, created_at, updated_at }]
  _parseNotes(raw) {
    if (!raw || raw.includes('no match')) return [];
    try {
      const parsed = JSON.parse(raw);
      let items = [];
      if (parsed.items && Array.isArray(parsed.items)) {
        items = parsed.items;
      } else if (Array.isArray(parsed)) {
        items = parsed;
      } else if (parsed.uuid) {
        items = [parsed];
      }
      return items.map(n => ({
        uuid: n.uuid || '',
        title: (n.content && n.content.title) || n.title || '',
        text: (n.content && n.content.text) || n.text || '',
        created_at: n.created_at || '',
        updated_at: n.updated_at || ''
      }));
    } catch {
      return [];
    }
  }

  // ─── Unescape context strings ─────────────────────────────
  // Trigger ops pass context as JSON — literal \n in strings stay escaped.
  // This unescapes them so note content has real newlines.
  _unescapeContext(ctx) {
    const out = {};
    for (const [k, v] of Object.entries(ctx)) {
      if (typeof v === 'string') {
        out[k] = v.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // ─── Action router ─────────────────────────────────────────
  async handleAction(action, context = {}) {
    // Unescape literal \n in context strings from trigger ops
    context = this._unescapeContext(context);
    try {
      // ── Indexed note actions (view/edit/delete by index) ──
      // If notes array is empty (instance was recreated or lost state), sync first.
      const indexedMatch = action.match(/^sn-(view|edit|delete)-note-(\d+)$/);
      if (indexedMatch) {
        if (!this.creds) this._loadSession();
        if (!this.creds) return this.authScreen();
        if (this.notes.length === 0) await this.sync();

        const verb = indexedMatch[1];
        const idx = parseInt(indexedMatch[2]);
        if (idx < 0 || idx >= this.notes.length) {
          return this.errorScreen('Note not found at index ' + idx + ' (have ' + this.notes.length + ' notes)');
        }
        this.selectedNote = this.notes[idx];
        if (verb === 'view') return this.viewNote(this.notes[idx]);
        if (verb === 'edit') return this.showEditor(this.notes[idx]);
        if (verb === 'delete') return await this.deleteNote({});
      }

      switch (action) {
        case 'sn-authenticate':   return await this.authenticate(context);
        case 'sn-sync':           if (!this.creds) this._loadSession(); return await this.sync();
        case 'sn-new':
        case 'sn-create-note':    return this.showEditor();
        case 'sn-save-note':      return await this.saveNote(context);
        case 'sn-delete-note':    return await this.deleteNote(context);
        case 'sn-list':           this.selectedNote = null; if (!this.creds) this._loadSession(); return await this.sync();
        case 'sn-back':
        case 'sn-back-to-list':   this.selectedNote = null; return this.noteListScreen();
        case 'sn-search':         return await this.search(context.search || '');
        case 'sn-logout':         return this.logout();
        case 'sn-help':           return this.helpScreen();
        case 'sn-auto-connect':
          // Re-check disk for creds (handles migration, manual file edits, etc.)
          if (!this.creds) this._loadSession();
          return this.creds ? await this.sync() : this.authScreen();
        case 'sn-agent-read':     return await this.agentRead(context);
        case 'sn-agent-edit':     return await this.agentEdit(context);
        case 'sn-agent-append':   return await this.agentAppend(context);
        default:                  return this.errorScreen('Unknown action: ' + action);
      }
    } catch (e) {
      console.error('[SN] handleAction error:', e.message);
      return this.errorScreen(e.message);
    }
  }

  // ─── Auth ──────────────────────────────────────────────────
  async authenticate(ctx) {
    if (!ctx.email || !ctx.email.trim()) return this.authScreen('Email is required.');
    if (!ctx.password || !ctx.password.trim()) return this.authScreen('Password is required.');

    this.creds = {
      email: ctx.email.trim(),
      password: ctx.password.trim(),
      server: (ctx.server || '').trim() || 'https://api.standardnotes.com'
    };

    try {
      await this._exec(['get', 'note', '--count']);
    } catch (e) {
      this.creds = null;
      this._clearSession();
      const msg = e.message.toLowerCase();
      if (msg.includes('invalid') || msg.includes('unauthorized') || msg.includes('401'))
        return this.authScreen('Invalid email or password.');
      if (msg.includes('too many') || msg.includes('rate'))
        return this.authScreen('Too many attempts. Wait and retry.');
      return this.authScreen('Connection failed: ' + e.message);
    }

    this._saveSession();
    return await this.sync();
  }

  // ─── Sync ──────────────────────────────────────────────────
  async sync() {
    if (!this.creds) return this.authScreen();

    try {
      const raw = await this._exec(['get', 'note', '--output', 'json']);
      this.notes = this._parseNotes(raw);
      this.stats.total = this.notes.length;
      this.stats.lastSync = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      try {
        const countRaw = await this._exec(['get', 'note', '--count']);
        if (countRaw && !countRaw.includes('no match')) {
          const m = countRaw.match(/(\d+)/);
          if (m) this.stats.total = parseInt(m[1]);
        }
      } catch {}
    } catch (e) {
      if (e.message.toLowerCase().includes('invalid') || e.message.toLowerCase().includes('unauthorized')) {
        this.creds = null; this._clearSession();
        return this.authScreen('Session expired. Sign in again.');
      }
      return this.errorScreen('Sync failed: ' + e.message, true);
    }

    return this.noteListScreen();
  }

  // ─── Search ────────────────────────────────────────────────
  async search(query) {
    if (!this.creds) return this.authScreen();
    this.searchQuery = query;
    if (!query) return await this.sync();

    try {
      const raw = await this._exec(['search', '--text', query, '--output', 'json']);
      this.notes = this._parseNotes(raw);
    } catch (e) {
      if (e.message && e.message.includes('no match')) {
        this.notes = [];
      } else {
        return this.errorScreen('Search failed: ' + e.message, true);
      }
    }
    return this.noteListScreen();
  }

  // ─── Save Note ─────────────────────────────────────────────
  // Strategy: if editing existing note, delete by UUID first then add new.
  // Never use `--replace` — it creates duplicates on race conditions.
  async saveNote(ctx) {
    if (!this.creds) return this.authScreen();
    if (!ctx.title && !ctx.content) return this.errorScreen('Note must have a title or content.');

    const isEdit = this.selectedNote && this.selectedNote.uuid && !this.selectedNote.uuid.startsWith('pending-');

    // Optimistic: add/update in local list immediately
    const now = new Date().toISOString();
    if (this.selectedNote && this.selectedNote.uuid) {
      // Update existing
      const idx = this.notes.findIndex(n => n.uuid === this.selectedNote.uuid);
      if (idx >= 0) {
        this.notes[idx] = { ...this.notes[idx], title: ctx.title || this.notes[idx].title, text: ctx.content || this.notes[idx].text, updated_at: now };
      }
    } else {
      // New note — add to front
      this.notes.unshift({ uuid: 'pending-' + Date.now(), title: ctx.title || '', text: ctx.content || '', created_at: now, updated_at: now });
      this.stats.total = this.notes.length;
    }

    const oldUuid = isEdit ? this.selectedNote.uuid : null;
    this.selectedNote = null;

    // Save: delete-then-add for edits, plain add for new notes
    try {
      if (oldUuid) {
        await this._exec(['delete', 'note', '--uuid', oldUuid], 15000);
        console.log('[SN] Save: deleted old uuid:', oldUuid);
      }

      const args = ['add', 'note'];
      if (ctx.title) args.push('--title', ctx.title);
      if (ctx.content) args.push('--text', ctx.content);
      if (ctx.tags) args.push('--tag', ctx.tags);
      await this._exec(args, 20000);
      console.log('[SN] Saved:', ctx.title);
      await this.sync();
    } catch(e) {
      console.error('[SN] Save error:', e.message);
    }

    // Silent mode: save without rendering any UI (for agent saves that shouldn't disrupt canvas)
    if (ctx.silent) return { ops: [] };

    return this.noteListScreen();
  }

  // ─── Delete Note ───────────────────────────────────────────
  async deleteNote(ctx) {
    if (!this.creds) return this.authScreen();

    const note = this.selectedNote;
    if (!note || !note.uuid) return this.errorScreen('No note selected to delete.');

    // Optimistic: remove from local list immediately
    this.notes = this.notes.filter(n => n.uuid !== note.uuid);
    this.stats.total = this.notes.length;
    this.selectedNote = null;

    // Fire delete in background (don't wait)
    this._exec(['delete', 'note', '--uuid', note.uuid]).then(() => {
      console.log('[SN] Deleted:', note.title);
    }).catch(e => {
      console.error('[SN] Delete failed:', e.message);
    });

    // Return updated list instantly
    return this.noteListScreen();
  }

  // ─── Agent Read ────────────────────────────────────────────
  // Trigger: {"op":"trigger","action":"sn-agent-read","context":{"index":0}}
  // Shows read-only view of note content. Syncs first if note list is empty.
  async agentRead(ctx) {
    if (!this.creds) return this.authScreen();
    if (this.notes.length === 0) await this.sync();

    const idx = parseInt(ctx.index);
    if (isNaN(idx) || idx < 0 || idx >= this.notes.length) {
      return this.errorScreen('Note index ' + ctx.index + ' out of range (0–' + (this.notes.length - 1) + ')', true);
    }

    // Fetch fresh content from SN to ensure we have full text
    const note = this.notes[idx];
    if (note.uuid && !note.uuid.startsWith('pending-')) {
      try {
        const raw = await this._exec(['get', 'note', '--uuid', note.uuid, '--output', 'json']);
        const fresh = this._parseNotes(raw);
        if (fresh.length > 0) {
          Object.assign(note, fresh[0]);
          this.notes[idx] = note;
        }
      } catch (e) {
        console.error('[SN] agentRead fetch error:', e.message);
      }
    }

    this.selectedNote = note;
    return this.viewNote(note);
  }

  // ─── Agent Edit ────────────────────────────────────────────
  // Trigger: {"op":"trigger","action":"sn-agent-edit","context":{"index":0,"title":"New Title","content":"New content"}}
  // Replaces title and/or content of an existing note by index.
  // Strategy: delete old by UUID, then add new. Avoids `--replace` race condition that creates duplicates.
  async agentEdit(ctx) {
    if (!this.creds) return this.authScreen();
    if (this.notes.length === 0) await this.sync();

    const idx = parseInt(ctx.index);
    if (isNaN(idx) || idx < 0 || idx >= this.notes.length) {
      return this.errorScreen('Note index ' + ctx.index + ' out of range (0–' + (this.notes.length - 1) + ')', true);
    }

    const note = this.notes[idx];
    const newTitle = ctx.title || note.title;
    const newContent = (ctx.content !== undefined && ctx.content !== null) ? ctx.content : note.text;

    if (!newTitle) return this.errorScreen('Cannot save a note without a title.');

    // Optimistic local update
    const now = new Date().toISOString();
    this.notes[idx] = { ...note, title: newTitle, text: newContent, updated_at: now };

    try {
      // Step 1: Delete old note by UUID (atomic, no duplicate risk)
      if (note.uuid && !note.uuid.startsWith('pending-')) {
        await this._exec(['delete', 'note', '--uuid', note.uuid], 15000);
        console.log('[SN] Agent edit: deleted old uuid:', note.uuid);
      }

      // Step 2: Create new note with updated content
      const args = ['add', 'note', '--title', newTitle, '--text', newContent];
      if (ctx.tags) args.push('--tag', ctx.tags);
      await this._exec(args, 20000);
      console.log('[SN] Agent edit: created new:', newTitle);

      await this.sync();
    } catch (e) {
      console.error('[SN] Agent edit error:', e.message);
      return this.errorScreen('Edit failed: ' + e.message, true);
    }

    // Show the updated note in view mode
    const updated = this.notes.find(n => n.title === newTitle) || this.notes[idx] || { title: newTitle, text: newContent, updated_at: now };
    this.selectedNote = updated;
    return this.viewNote(updated);
  }

  // ─── Agent Append ──────────────────────────────────────────
  // Trigger: {"op":"trigger","action":"sn-agent-append","context":{"index":0,"text":"Text to append"}}
  // Appends text to the end of an existing note's content.
  async agentAppend(ctx) {
    if (!this.creds) return this.authScreen();
    if (this.notes.length === 0) await this.sync();

    const idx = parseInt(ctx.index);
    if (isNaN(idx) || idx < 0 || idx >= this.notes.length) {
      return this.errorScreen('Note index ' + ctx.index + ' out of range (0–' + (this.notes.length - 1) + ')', true);
    }

    if (!ctx.text) return this.errorScreen('Nothing to append (text is empty).');

    const note = this.notes[idx];

    // Fetch fresh content first to avoid overwriting concurrent changes
    let currentText = note.text || '';
    if (note.uuid && !note.uuid.startsWith('pending-')) {
      try {
        const raw = await this._exec(['get', 'note', '--uuid', note.uuid, '--output', 'json']);
        const fresh = this._parseNotes(raw);
        if (fresh.length > 0) currentText = fresh[0].text || '';
      } catch (e) {
        console.error('[SN] agentAppend fetch error:', e.message);
      }
    }

    const separator = ctx.separator || '\n\n';
    const newContent = currentText ? (currentText + separator + ctx.text) : ctx.text;
    const title = note.title || 'Untitled';

    // Optimistic local update
    const now = new Date().toISOString();
    this.notes[idx] = { ...note, text: newContent, updated_at: now };

    try {
      // Delete old by UUID, then add new (avoids --replace duplicate bug)
      if (note.uuid && !note.uuid.startsWith('pending-')) {
        await this._exec(['delete', 'note', '--uuid', note.uuid], 15000);
        console.log('[SN] Agent append: deleted old uuid:', note.uuid);
      }

      const args = ['add', 'note', '--title', title, '--text', newContent];
      await this._exec(args, 20000);
      console.log('[SN] Agent appended to:', title, '(+' + ctx.text.length + ' chars)');
      await this.sync();
    } catch (e) {
      console.error('[SN] Agent append error:', e.message);
      return this.errorScreen('Append failed: ' + e.message, true);
    }

    const updated = this.notes.find(n => n.title === title) || this.notes[idx] || { title, text: newContent, updated_at: now };
    this.selectedNote = updated;
    return this.viewNote(updated);
  }

  // ─── Logout ────────────────────────────────────────────────
  logout() {
    this.creds = null; this.notes = []; this.selectedNote = null;
    this.stats = { total: 0, tags: 0, lastSync: null };
    this._clearSession();
    return this.authScreen('Logged out.');
  }

  // ─── SCREENS ───────────────────────────────────────────────

  authScreen(message) {
    const ops = [
      { op: 'clear' },
      { op: 'layout', mode: 'rows' },
      { op: 'upsert', id: 'sn-hero', type: 'hero', data: {
        title: '🔐 Standard Notes', subtitle: 'Connect to your encrypted vault', icon: '🗒️', style: 'accent'
      }, layout: { zone: 'auto' } },
      { op: 'upsert', id: 'sn-auth', type: 'form', data: {
        title: 'Sign In', id: 'sn-auth',
        fields: [
          { name: 'email', type: 'email', label: 'Email', placeholder: 'your@email.com', required: true },
          { name: 'password', type: 'password', label: 'Password', placeholder: 'Enter password', required: true },
          { name: 'server', type: 'text', label: 'Server (optional)', value: 'https://api.standardnotes.com' }
        ],
        actions: [{ label: '🔗 Connect', action: 'sn-authenticate', style: 'primary' }]
      }, layout: { zone: 'auto' } }
    ];
    if (message) {
      const ok = message.toLowerCase().includes('logged out');
      ops.push({ op: 'upsert', id: 'sn-msg', type: 'alert', data: {
        title: ok ? '✅' : '⚠️', message, severity: ok ? 'success' : 'error'
      }, layout: { zone: 'auto' } });
    }
    return { ops };
  }

  noteListScreen() {
    const ops = [
      { op: 'clear' },
      { op: 'upsert', id: 'sn-header', type: 'hero', data: {
        title: '📝 Notes (' + this.stats.total + ')',
        subtitle: this.creds.email + ' • Synced ' + (this.stats.lastSync || '—'),
        icon: '🗒️'
      }, layout: { zone: 'auto' } },
      { op: 'upsert', id: 'sn-toolbar', type: 'form', data: {
        title: '', id: 'sn-toolbar',
        fields: [{ name: 'search', type: 'text', placeholder: '🔍 Search notes...', value: this.searchQuery || '' }],
        actions: [
          { label: '🔍 Search', action: 'sn-search', style: 'primary' },
          { label: '➕ New Note', action: 'sn-create-note', style: 'primary' },
          { label: '🔄 Sync', action: 'sn-sync', style: 'ghost' },
          { label: '🚪 Logout', action: 'sn-logout', style: 'ghost' }
        ]
      }, layout: { zone: 'auto' } }
    ];

    if (this.notes.length === 0) {
      ops.push({ op: 'upsert', id: 'sn-empty', type: 'card', data: {
        title: '🌟 No notes yet', text: 'Click "New Note" to create your first encrypted note.'
      }, layout: { zone: 'auto' } });
    } else {
      // Sort by most recently updated first
      this.notes.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

      // Clickable note cards — tap to edit, 3-dots for delete
      this.notes.slice(0, 20).forEach((n, i) => {
        let dateStr = '';
        if (n.updated_at) {
          const d = new Date(n.updated_at);
          dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) +
            ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        }
        const words = n.text ? n.text.trim().split(/\s+/).length : 0;

        ops.push({ op: 'upsert', id: 'sn-note-' + i, type: 'card', data: {
          title: (n.title || 'Untitled'),
          text: (dateStr ? '📅 ' + dateStr + '  •  ' : '') + words + ' words',
          action: 'sn-view-note-' + i,
          menu: [
            { icon: '✏️', label: 'Edit', action: 'sn-edit-note-' + i },
            { icon: '🗑️', label: 'Delete', action: 'sn-delete-note-' + i }
          ]
        }, layout: { zone: 'auto' } });
      });
    }

    return { ops };
  }

  showEditor(note) {
    note = note || this.selectedNote || {};
    const isNew = !note.uuid;
    const title = note.title || '';
    const text = note.text || '';

    const ops = [
      { op: 'clear' },
      { op: 'upsert', id: 'sn-ed-header', type: 'hero', data: {
        title: isNew ? '✏️ New Note' : '✏️ ' + (title || 'Untitled'),
        subtitle: isNew ? 'Create an encrypted note' : 'Modified: ' + (note.updated_at ? new Date(note.updated_at).toLocaleString() : '—'),
        icon: '📝'
      }, layout: { zone: 'auto' } },
      { op: 'upsert', id: 'sn-editor', type: 'form', data: {
        title: '', id: 'sn-editor-form',
        fields: [
          { name: 'title', type: 'text', label: 'Title', value: title, placeholder: 'Note title...', required: true },
          { name: 'content', type: 'textarea', label: 'Content', value: text, placeholder: 'Start writing...' },
          { name: 'tags', type: 'text', label: 'Tags (comma separated)', placeholder: 'work, ideas, personal' }
        ],
        actions: [
          { label: '💾 Save', action: 'sn-save-note', style: 'primary' },
          ...(!isNew ? [{ label: '🗑️ Delete', action: 'sn-delete-note', style: 'ghost' }] : []),
          { label: '← Back', action: 'sn-back-to-list', style: 'ghost' }
        ]
      }, layout: { zone: 'auto' } },
      { op: 'upsert', id: 'sn-ed-info', type: 'kv', data: {
        title: 'Info', items: [
          { key: 'Status', value: isNew ? '🆕 New' : '✅ Saved' },
          { key: 'Created', value: note.created_at ? new Date(note.created_at).toLocaleString() : '—' },
          { key: 'Words', value: String(text.trim() ? text.trim().split(/\s+/).length : 0) },
          { key: 'Total Notes', value: String(this.stats.total) }
        ]
      }, layout: { zone: 'auto' } }
    ];

    return { ops };
  }

  viewNote(note) {
    note = note || this.selectedNote || {};
    const title = note.title || 'Untitled';
    const text = note.text || '(empty)';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const chars = text.length;

    let dateStr = '';
    if (note.updated_at) {
      const d = new Date(note.updated_at);
      dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }

    // Find the index of this note for action buttons
    const noteIdx = this.notes.findIndex(n => n.uuid === note.uuid);

    const ops = [
      { op: 'clear' },
      { op: 'upsert', id: 'sn-view-header', type: 'hero', data: {
        title: '📄 ' + title,
        subtitle: (dateStr ? 'Updated ' + dateStr + ' • ' : '') + words + ' words, ' + chars + ' chars',
        icon: '📝'
      }, layout: { zone: 'auto' } },
      { op: 'upsert', id: 'sn-view-content', type: 'card', data: {
        title: '',
        text: text
      }, layout: { zone: 'auto' } },
      { op: 'upsert', id: 'sn-view-actions', type: 'buttons', data: {
        title: '', buttons: [
          ...(noteIdx >= 0 ? [{ label: '✏️ Edit', action: 'sn-edit-note-' + noteIdx, style: 'primary' }] : []),
          ...(noteIdx >= 0 ? [{ label: '🗑️ Delete', action: 'sn-delete-note-' + noteIdx, style: 'ghost' }] : []),
          { label: '← Notes', action: 'sn-back-to-list', style: 'ghost' }
        ]
      }, layout: { zone: 'auto' } }
    ];

    // Metadata
    if (note.created_at || note.uuid) {
      ops.push({ op: 'upsert', id: 'sn-view-meta', type: 'kv', data: {
        title: 'Details', items: [
          ...(note.uuid ? [{ key: 'UUID', value: note.uuid.substring(0, 8) + '…' }] : []),
          ...(note.created_at ? [{ key: 'Created', value: new Date(note.created_at).toLocaleString() }] : []),
          ...(note.updated_at ? [{ key: 'Updated', value: new Date(note.updated_at).toLocaleString() }] : []),
          { key: 'Words', value: String(words) },
          { key: 'Characters', value: String(chars) }
        ]
      }, layout: { zone: 'auto' } });
    }

    return { ops };
  }

  helpScreen() {
    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'sn-help', type: 'card', data: {
        title: '📖 Standard Notes',
        text: 'End-to-end encrypted notes. This widget connects locally via sn-cli. Your data never leaves this server.'
      }, layout: { zone: 'auto' } },
      { op: 'upsert', id: 'sn-help-btns', type: 'buttons', data: {
        title: '', buttons: [{ label: '← Back', action: 'sn-back-to-list', style: 'ghost' }]
      }, layout: { zone: 'auto' } }
    ] };
  }

  errorScreen(message, showRetry) {
    const btns = [];
    if (showRetry) btns.push({ label: '🔄 Retry', action: 'sn-sync', style: 'primary' });
    if (this.creds) btns.push({ label: '← Notes', action: 'sn-back-to-list', style: 'ghost' });
    btns.push({ label: '🔐 Sign In', action: 'sn-logout', style: 'ghost' });

    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'sn-err', type: 'alert', data: {
        title: '⚠️ Error', message, severity: 'error'
      }, layout: { zone: 'auto' } },
      { op: 'upsert', id: 'sn-err-btns', type: 'buttons', data: {
        title: '', buttons: btns
      }, layout: { zone: 'auto' } }
    ] };
  }
}

module.exports = StandardNotesWidget;
