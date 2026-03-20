/**
 * Google Calendar Widget — Scratchy GenUI
 * Standalone widget: OAuth2 flow, events CRUD, tasks CRUD
 * Prefix: cal-
 * 
 * Design principles:
 * - Clear before render: every view starts with { op: 'clear' } to prevent stale tiles
 * - Minimal components: max 4-5 visible tiles per view
 * - Tasks as cards (not checklist): enables per-task edit/delete/complete actions
 * - Compact nav: 3 main tabs + contextual actions only
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getWidgetStatePath, migrateLegacyFile } = require('../../lib/widget-state');

const CREDS_PATH = process.env.GCAL_CREDS_PATH || path.join(process.env.HOME || '.', '.gcal-creds.json');
const LEGACY_SESSION_PATH = process.env.GCAL_SESSION_PATH || path.join(process.env.HOME || '.', '.gcal-session.json');

class GoogleCalendarWidget {
  constructor(userId) {
    this._userId = userId || '_legacy';
    // Migrate legacy root-level session file on first access
    migrateLegacyFile(LEGACY_SESSION_PATH, this._userId, 'gcal-session.json');
    this._sessionPath = getWidgetStatePath(this._userId, 'gcal-session.json');
    this.creds = this.loadCreds();
    this.session = this.loadSession();
    this.oauth2Client = null;
    this._taskListId = null;
    if (this.creds) this.initOAuth();
  }

  // ─── OAuth ────────────────────────────────────────────

  initOAuth() {
    this.oauth2Client = new google.auth.OAuth2(
      this.creds.clientId,
      this.creds.clientSecret,
      this.creds.redirectUri || 'https://scratchy.example.com/auth/google/callback'
    );
    if (this.session && this.session.tokens) {
      this.oauth2Client.setCredentials(this.session.tokens);
    }
  }

  getAuthUrl(state) {
    if (!this.oauth2Client) return null;
    const opts = {
      access_type: 'offline', prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/youtube.readonly'
      ]
    };
    if (state) opts.state = state;
    return this.oauth2Client.generateAuthUrl(opts);
  }

  async exchangeCode(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    this.session = { tokens, connectedAt: new Date().toISOString() };
    this.saveSession(this.session);
    return tokens;
  }

  isConnected() {
    return this.oauth2Client && this.session && this.session.tokens;
  }

  // ─── Entry Point ──────────────────────────────────────

  async handleAction(action, context) {
    try {
      // No-auth actions
      if (action === 'cal-setup') return this.setup(context);
      if (action === 'cal-auth-callback') return this.authCallback(context);
      if (action === 'cal-auto-connect') return this.autoConnect();
      if (action === 'cal-logout') return this.logout();

      // Auth required
      if (!this.isConnected()) return { ops: this.needsSetupOps() };

      // Refresh token silently
      try {
        const { credentials } = await this.oauth2Client.getAccessToken();
        if (credentials) this.oauth2Client.setCredentials(credentials);
      } catch {}

      switch (action) {
        case 'cal-today':            return this.getEvents('today');
        case 'cal-week':             return this.getEvents('week');
        case 'cal-month':            return this.getMonth();
        case 'cal-sync':             return this.getMonth();
        case 'cal-create-form':      return this.showEventForm();
        case 'cal-create':           return this.createEvent(context);
        case 'cal-update':           return this.updateEvent(context);
        case 'cal-tasks':            return this.getTasks();
        case 'cal-task-create-form': return this.showTaskForm();
        case 'cal-task-create':      return this.createTask(context);
        default:
          return this.handleDynamicAction(action, context);
      }
    } catch (err) {
      console.error('[CalWidget]', err.message);
      return { ops: [
        { op: 'clear' },
        ...this.nav('error'),
        { op: 'upsert', id: 'cal-error', type: 'alert', data: { title: 'Error', message: err.message, severity: 'error' } }
      ]};
    }
  }

  async handleDynamicAction(action, context) {
    if (action.startsWith('cal-day-select-')) return this.getDayEvents(action.slice(15));
    if (action.startsWith('cal-view-'))     return this.viewEvent(action.slice(9));
    if (action.startsWith('cal-edit-'))     return this.showEventForm(action.slice(9));
    if (action.startsWith('cal-delete-'))   return this.deleteEvent(action.slice(11));
    if (action.startsWith('cal-task-edit-'))     return this.showTaskForm(action.slice(14));
    if (action.startsWith('cal-task-update-'))   return this.updateTask(action.slice(16), context);
    if (action.startsWith('cal-task-delete-'))   return this.deleteTask(action.slice(16));
    if (action.startsWith('cal-task-complete-')) return this.completeTask(action.slice(18));
    return { ops: [{ op: 'upsert', id: 'cal-error', type: 'alert', data: { title: 'Error', message: `Unknown: ${action}`, severity: 'error' } }] };
  }

  // ─── Auth Views ───────────────────────────────────────

  needsSetupOps() {
    return [
      { op: 'clear' },
      { op: 'upsert', id: 'cal-header', type: 'card', data: { title: '📅 Google Calendar', text: 'Connect your Google account to get started.' } },
      { op: 'upsert', id: 'cal-setup-form', type: 'form', data: {
        id: 'cal-setup-form', title: 'Google OAuth Setup',
        fields: [
          { name: 'clientId', type: 'text', label: 'Client ID', required: true, placeholder: 'xxxxx.apps.googleusercontent.com' },
          { name: 'clientSecret', type: 'password', label: 'Client Secret', required: true }
        ],
        actions: [{ label: 'Connect', action: 'cal-setup', style: 'primary' }]
      }}
    ];
  }

  async setup(context) {
    const { clientId, clientSecret } = context;
    if (!clientId || !clientSecret) {
      return { ops: [{ op: 'upsert', id: 'cal-error', type: 'alert', data: { title: 'Missing fields', message: 'Both Client ID and Secret are required.', severity: 'warning' } }] };
    }
    this.creds = { clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri: 'https://scratchy.example.com/auth/google/callback' };
    this.saveCreds(this.creds);
    this.initOAuth();
    return this.showAuthLink();
  }

  showAuthLink() {
    const url = this.getAuthUrl();
    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'cal-header', type: 'card', data: { title: '📅 Google Calendar', text: 'Authorize access to continue.' } },
      { op: 'upsert', id: 'cal-auth-link', type: 'link-card', data: { title: 'Sign in with Google', description: 'Opens Google consent screen', url, icon: '🔐', color: '#4285F4' } },
      { op: 'upsert', id: 'cal-code-form', type: 'form', data: {
        id: 'cal-code-form', title: 'Or paste authorization code',
        fields: [{ name: 'code', type: 'text', label: 'Code', placeholder: '4/0Axx...' }],
        actions: [{ label: 'Submit', action: 'cal-auth-callback', style: 'primary' }]
      }}
    ]};
  }

  async authCallback(context) {
    if (!context.code) return { ops: [{ op: 'upsert', id: 'cal-error', type: 'alert', data: { title: 'Error', message: 'No code provided.', severity: 'error' } }] };
    await this.exchangeCode(context.code.trim());
    return this.getMonth();
  }

  async autoConnect() {
    if (this.isConnected()) return this.getMonth();
    if (this.creds) return this.showAuthLink();
    return { ops: this.needsSetupOps() };
  }

  async logout() {
    this.session = null;
    try { fs.unlinkSync(this._sessionPath); } catch {}
    return { ops: [
      ...this.needsSetupOps(),
      { op: 'upsert', id: 'cal-msg', type: 'alert', data: { title: 'Disconnected', message: 'Google Calendar disconnected.', severity: 'info' } }
    ]};
  }

  // ─── Navigation ───────────────────────────────────────

  nav(active, extra = []) {
    const tabs = [
      { label: '📅 Month', action: 'cal-month', style: active === 'month' ? 'primary' : 'ghost' },
      { label: '📋 Today', action: 'cal-today', style: active === 'today' ? 'primary' : 'ghost' },
      { label: '📆 Week', action: 'cal-week', style: active === 'week' ? 'primary' : 'ghost' },
      { label: '✅ Tasks', action: 'cal-tasks', style: active === 'tasks' ? 'primary' : 'ghost' },
      ...extra
    ];
    return [{ op: 'upsert', id: 'cal-nav', type: 'buttons', data: { buttons: tabs } }];
  }

  // ─── Calendar Events ─────────────────────────────────

  async getEvents(range) {
    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endDate = range === 'week'
      ? new Date(startOfDay.getTime() + 7 * 86400000)
      : new Date(startOfDay.getTime() + 86400000);

    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 30
    });

    const events = res.data.items || [];
    const label = range === 'week' ? 'This Week' : 'Today';

    const ops = [
      { op: 'clear' },
      ...this.nav(range, [
        { label: '➕ New', action: 'cal-create-form', style: 'ghost' },
        { label: '🔄', action: 'cal-sync', style: 'ghost' }
      ]),
    ];

    if (events.length === 0) {
      ops.push({ op: 'upsert', id: 'cal-empty', type: 'card', data: {
        title: `📅 ${label}`,
        text: `No events${range === 'today' ? ' today' : ' this week'}. Tap ➕ to create one.`
      }});
    } else {
      // Group by date
      const grouped = {};
      for (const ev of events) {
        const start = ev.start.dateTime || ev.start.date;
        const dateKey = start.substring(0, 10);
        if (!grouped[dateKey]) grouped[dateKey] = [];
        grouped[dateKey].push(ev);
      }

      for (const [date, dayEvents] of Object.entries(grouped)) {
        // Timeline component — compact, one tile per day
        ops.push({ op: 'upsert', id: `cal-day-${date}`, type: 'timeline', data: {
          title: this.formatDate(date),
          items: dayEvents.map(ev => ({
            title: ev.summary || '(No title)',
            text: this.formatEventTime(ev) + (ev.location ? ` · ${ev.location}` : ''),
            icon: ev.start.date ? '📌' : '🕐',
            status: this.isEventNow(ev) ? 'active' : undefined
          }))
        }});

        // Cards for each event (clickable with menu) 
        for (const ev of dayEvents) {
          ops.push({
            op: 'upsert', id: `cal-ev-${ev.id}`, type: 'card',
            data: {
              title: `${this.formatEventTime(ev)}  ${ev.summary || '(No title)'}`,
              text: [ev.location, ev.description].filter(Boolean).join(' · ') || 'No details',
              action: `cal-view-${ev.id}`,
              menu: [
                { label: 'Edit', action: `cal-edit-${ev.id}` },
                { label: 'Delete', action: `cal-delete-${ev.id}` }
              ]
            }
          });
        }
      }
    }

    return { ops };
  }

  async getMonth(year, month) {
    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const now = new Date();
    const y = year != null ? year : now.getFullYear();
    const m = month != null ? month : now.getMonth();
    const startOfMonth = new Date(y, m, 1);
    const endOfMonth = new Date(y, m + 1, 1);

    // Fetch events AND tasks in parallel
    const [evRes, taskItems] = await Promise.all([
      cal.events.list({
        calendarId: 'primary',
        timeMin: startOfMonth.toISOString(),
        timeMax: endOfMonth.toISOString(),
        singleEvents: true, orderBy: 'startTime', maxResults: 100
      }),
      this.fetchTasksForMonth()
    ]);

    const events = evRes.data.items || [];
    
    // Build events map: { "2026-02-20": [{title, color, type}], ... }
    const eventsMap = {};

    // Calendar events → blue/purple dots
    events.forEach(ev => {
      const start = ev.start.dateTime || ev.start.date;
      const dateKey = start.substring(0, 10);
      if (!eventsMap[dateKey]) eventsMap[dateKey] = [];
      eventsMap[dateKey].push({
        title: (this.formatEventTime(ev) !== 'All day' ? this.formatEventTime(ev) + ' ' : '') + (ev.summary || '(No title)'),
        color: '#818cf8',
        id: ev.id, type: 'event'
      });
    });

    // Tasks with due dates → orange/amber dots
    taskItems.forEach(t => {
      if (!t.due) return;
      const dateKey = t.due.substring(0, 10);
      if (!eventsMap[dateKey]) eventsMap[dateKey] = [];
      eventsMap[dateKey].push({
        title: '✅ ' + t.title,
        color: '#fbbf24',
        id: t.id, type: 'task'
      });
    });

    const todayStr = this.isoDate(now);
    const todayItems = eventsMap[todayStr] || [];

    const ops = [
      { op: 'clear' },
      ...this.nav('month', [
        { label: '➕ New', action: 'cal-create-form', style: 'ghost' },
        { label: '🔄', action: 'cal-sync', style: 'ghost' }
      ]),
      { op: 'upsert', id: 'cal-calendar', type: 'month-calendar', data: {
        month: m, year: y,
        events: eventsMap,
        selected: todayStr,
        actionPrefix: 'cal-day-select-'
      }},
    ];

    // Legend
    ops.push({ op: 'upsert', id: 'cal-legend', type: 'tags', data: {
      label: '',
      items: [
        { text: 'Events', color: '#818cf8' },
        { text: 'Tasks', color: '#fbbf24' }
      ]
    }});

    // Show today's summary
    if (todayItems.length > 0) {
      ops.push({ op: 'upsert', id: 'cal-day-summary', type: 'card', data: {
        title: `Today · ${todayItems.length} item${todayItems.length > 1 ? 's' : ''}`,
        text: todayItems.map(e => e.title).join('\n'),
        action: 'cal-day-select-' + todayStr
      }});
    }

    return { ops };
  }

  async fetchTasksForMonth() {
    try {
      const tasks = google.tasks({ version: 'v1', auth: this.oauth2Client });
      const listRes = await tasks.tasklists.list({ maxResults: 1 });
      const taskList = (listRes.data.items || [])[0];
      if (!taskList) return [];
      this._taskListId = taskList.id;
      const res = await tasks.tasks.list({ tasklist: taskList.id, maxResults: 100, showCompleted: false });
      return res.data.items || [];
    } catch { return []; }
  }

  async getDayEvents(dateStr) {
    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const startOfDay = new Date(dateStr + 'T00:00:00');
    const endOfDay = new Date(startOfDay.getTime() + 86400000);

    // Fetch events + tasks for this day in parallel
    const [evRes, allTasks] = await Promise.all([
      cal.events.list({
        calendarId: 'primary',
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true, orderBy: 'startTime', maxResults: 30
      }),
      this.fetchTasksForMonth()
    ]);

    const events = evRes.data.items || [];
    const dayTasks = allTasks.filter(t => t.due && t.due.substring(0, 10) === dateStr);
    const dayLabel = this.formatDate(dateStr);
    const totalItems = events.length + dayTasks.length;

    // Full day view — clear and show timeline
    const ops = [
      { op: 'clear' },
      ...this.nav('month'),
      { op: 'upsert', id: 'cal-day-header', type: 'stats', data: {
        title: `📅 ${dayLabel}`,
        items: [
          { label: 'Events', value: String(events.length) },
          { label: 'Tasks', value: String(dayTasks.length) }
        ]
      }},
      { op: 'upsert', id: 'cal-day-actions', type: 'buttons', data: {
        buttons: [
          { label: '← Calendar', action: 'cal-month', style: 'ghost' },
          { label: '➕ Event', action: 'cal-create-form', style: 'ghost' },
          { label: '➕ Task', action: 'cal-task-create-form', style: 'ghost' }
        ]
      }}
    ];

    if (totalItems === 0) {
      ops.push({ op: 'upsert', id: 'cal-day-empty', type: 'card', data: {
        title: 'Free day', text: 'Nothing scheduled. Enjoy! 🌴'
      }});
      return { ops };
    }

    // Build timeline: group events by hour
    const allDayEvents = events.filter(ev => !ev.start.dateTime);
    const timedEvents = events.filter(ev => ev.start.dateTime);

    // All-day events section
    if (allDayEvents.length > 0) {
      for (const ev of allDayEvents) {
        ops.push({
          op: 'upsert', id: `cal-ev-${ev.id}`, type: 'card',
          data: {
            title: `📌 ${ev.summary || '(No title)'}`,
            text: 'All day' + (ev.location ? ` · 📍 ${ev.location}` : ''),
            action: `cal-view-${ev.id}`,
            menu: [
              { label: 'Edit', action: `cal-edit-${ev.id}` },
              { label: 'Delete', action: `cal-delete-${ev.id}` }
            ]
          }
        });
      }
    }

    // Timed events as timeline
    if (timedEvents.length > 0) {
      ops.push({ op: 'upsert', id: 'cal-day-timeline', type: 'timeline', data: {
        title: 'Schedule',
        items: timedEvents.map(ev => ({
          title: ev.summary || '(No title)',
          text: this.formatEventTime(ev) + (ev.location ? ` · ${ev.location}` : ''),
          icon: this.isEventNow(ev) ? '🔴' : '🕐',
          time: (ev.start.dateTime || '').substring(11, 16),
          status: this.isEventNow(ev) ? 'active' : undefined
        }))
      }});

      // Also show event cards for interaction (edit/delete)
      for (const ev of timedEvents) {
        ops.push({
          op: 'upsert', id: `cal-ev-${ev.id}`, type: 'card',
          data: {
            title: `${this.formatEventTime(ev)}  ${ev.summary || '(No title)'}`,
            text: [ev.location, ev.description].filter(Boolean).join(' · ') || 'Tap for details',
            action: `cal-view-${ev.id}`,
            menu: [
              { label: 'Edit', action: `cal-edit-${ev.id}` },
              { label: 'Delete', action: `cal-delete-${ev.id}` }
            ]
          }
        });
      }
    }

    // Tasks due this day
    if (dayTasks.length > 0) {
      ops.push({ op: 'upsert', id: 'cal-day-tasks-header', type: 'card', data: {
        title: `✅ Tasks due`, text: `${dayTasks.length} task${dayTasks.length > 1 ? 's' : ''}`
      }});
      for (const t of dayTasks) {
                const dueStr = t.due ? ` · due ${this.formatDate(t.due.substring(0, 10))}` : '';
        ops.push({
          op: 'upsert', id: `cal-task-${t.id}`, type: 'card',
          data: {
            title: t.title,
            text: (t.notes || 'No notes') + dueStr,
            action: `cal-task-complete-${t.id}`,
            menu: [
              { label: '✅ Done', action: `cal-task-complete-${t.id}` },
              { label: '✏️ Edit', action: `cal-task-edit-${t.id}` },
              { label: '🗑️ Delete', action: `cal-task-delete-${t.id}` }
            ]
          }
        });
      }
    }

    return { ops };
  }

  async viewEvent(eventId) {
    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const ev = (await cal.events.get({ calendarId: 'primary', eventId })).data;

    const kvItems = [{ key: 'When', value: this.formatEventTime(ev) }];
    if (ev.location) kvItems.push({ key: 'Where', value: ev.location });
    if (ev.description) kvItems.push({ key: 'Notes', value: ev.description });
    if (ev.attendees) kvItems.push({ key: 'With', value: ev.attendees.map(a => a.displayName || a.email).join(', ') });
    if (ev.hangoutLink) kvItems.push({ key: 'Meet', value: ev.hangoutLink });

    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'cal-detail', type: 'kv', data: { title: ev.summary || '(No title)', items: kvItems } },
      { op: 'upsert', id: 'cal-detail-actions', type: 'buttons', data: { buttons: [
        { label: '← Back', action: 'cal-today', style: 'ghost' },
        { label: 'Edit', action: `cal-edit-${ev.id}`, style: 'primary' },
        { label: 'Delete', action: `cal-delete-${ev.id}`, style: 'ghost' }
      ]}}
    ]};
  }

  // ─── Event CRUD ───────────────────────────────────────

  async showEventForm(eventId) {
    let title = '➕ New Event', ev = null;

    if (eventId) {
      const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
      ev = (await cal.events.get({ calendarId: 'primary', eventId })).data;
      title = '✏️ Edit Event';
    }

    const now = new Date();
    const later = new Date(now.getTime() + 3600000);
    const startDt = ev ? (ev.start.dateTime || ev.start.date) : null;
    const endDt = ev ? (ev.end.dateTime || ev.end.date) : null;

    const fields = [
      { name: 'summary', type: 'text', label: 'Title', required: true, value: ev ? ev.summary || '' : '' },
      { name: 'date', type: 'date', label: 'Date', value: ev ? startDt.substring(0, 10) : this.isoDate(now) },
      { name: 'startTime', type: 'text', label: 'Start (HH:MM)', placeholder: '09:00', value: ev && startDt.length > 10 ? startDt.substring(11, 16) : this.isoTime(now) },
      { name: 'endTime', type: 'text', label: 'End (HH:MM)', placeholder: '10:00', value: ev && endDt.length > 10 ? endDt.substring(11, 16) : this.isoTime(later) },
      { name: 'location', type: 'text', label: 'Location', value: ev ? ev.location || '' : '' },
      { name: 'description', type: 'textarea', label: 'Notes', value: ev ? ev.description || '' : '' },
    ];

    // Hidden event ID for updates
    if (eventId) fields.push({ name: 'eventId', type: 'text', label: '', value: eventId });

    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'cal-event-form', type: 'form', data: {
        id: 'cal-event-form', title,
        fields,
        actions: [
          { label: '← Back', action: 'cal-today', style: 'ghost' },
          { label: eventId ? 'Save' : 'Create', action: eventId ? 'cal-update' : 'cal-create', style: 'primary' }
        ]
      }}
    ]};
  }

  async createEvent(context) {
    const { summary, date, startTime, endTime, location, description } = context;
    if (!summary) return { ops: [{ op: 'upsert', id: 'cal-error', type: 'alert', data: { title: 'Error', message: 'Title is required.', severity: 'warning' } }] };

    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const eventDate = date || this.isoDate(new Date());
    const event = { summary, location: location || undefined, description: description || undefined };

    if (startTime) {
      event.start = { dateTime: `${eventDate}T${startTime}:00`, timeZone: 'Europe/Berlin' };
      event.end = { dateTime: `${eventDate}T${endTime || startTime}:00`, timeZone: 'Europe/Berlin' };
    } else {
      event.start = { date: eventDate };
      event.end = { date: eventDate };
    }

    await cal.events.insert({ calendarId: 'primary', requestBody: event });
    // Show month view after creating (so user sees the dot on the event day)
    const result = await this.getMonth();
    result.ops.splice(1, 0, { op: 'upsert', id: 'cal-msg', type: 'alert', data: { title: '✅ Created', message: `"${summary}" added for ${eventDate}${startTime ? ' at ' + startTime : ''}.`, severity: 'success' } });
    return result;
  }

  async updateEvent(context) {
    const { eventId, summary, date, startTime, endTime, location, description } = context;
    if (!eventId || !summary) return { ops: [{ op: 'upsert', id: 'cal-error', type: 'alert', data: { title: 'Error', message: 'Missing event data.', severity: 'warning' } }] };

    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const eventDate = date || this.isoDate(new Date());
    const patch = { summary, location: location || undefined, description: description || undefined };

    if (startTime) {
      patch.start = { dateTime: `${eventDate}T${startTime}:00`, timeZone: 'Europe/Berlin' };
      patch.end = { dateTime: `${eventDate}T${endTime || startTime}:00`, timeZone: 'Europe/Berlin' };
    } else {
      patch.start = { date: eventDate };
      patch.end = { date: eventDate };
    }

    await cal.events.patch({ calendarId: 'primary', eventId, requestBody: patch });
    const result = await this.getMonth();
    result.ops.splice(1, 0, { op: 'upsert', id: 'cal-msg', type: 'alert', data: { title: '✅ Updated', message: `"${summary}" saved.`, severity: 'success' } });
    return result;
  }

  async deleteEvent(eventId) {
    const cal = google.calendar({ version: 'v3', auth: this.oauth2Client });
    await cal.events.delete({ calendarId: 'primary', eventId });
    const result = await this.getEvents('today');
    result.ops.splice(1, 0, { op: 'upsert', id: 'cal-msg', type: 'alert', data: { title: 'Deleted', message: 'Event removed.', severity: 'success' } });
    return result;
  }

  // ─── Tasks ────────────────────────────────────────────

  async getDefaultTaskList() {
    const tasks = google.tasks({ version: 'v1', auth: this.oauth2Client });
    const res = await tasks.tasklists.list({ maxResults: 1 });
    const list = (res.data.items || [])[0];
    if (!list) throw new Error('No task list found. Create one in Google Tasks first.');
    this._taskListId = list.id;
    return list;
  }

  async getTasks() {
    const taskList = await this.getDefaultTaskList();
    const tasks = google.tasks({ version: 'v1', auth: this.oauth2Client });
    const res = await tasks.tasks.list({ tasklist: taskList.id, maxResults: 50, showCompleted: false });
    const items = res.data.items || [];

    const ops = [
      { op: 'clear' },
      ...this.nav('tasks', [{ label: '➕ New', action: 'cal-task-create-form', style: 'ghost' }]),
    ];

    if (items.length === 0) {
      ops.push({ op: 'upsert', id: 'cal-tasks-empty', type: 'card', data: {
        title: '✅ All done!', text: 'No pending tasks. Tap ➕ to add one.'
      }});
    } else {
      ops.push({ op: 'upsert', id: 'cal-tasks-count', type: 'stats', data: {
        title: '✅ Tasks', items: [{ label: 'Pending', value: String(items.length) }]
      }});

      // Each task as a card with actions
      for (const t of items) {
        const dueStr = t.due ? ` · due ${this.formatDate(t.due.substring(0, 10))}` : '';
        ops.push({
          op: 'upsert', id: `cal-task-${t.id}`, type: 'card',
          data: {
            title: t.title,
            text: (t.notes || 'No notes') + dueStr,
            action: `cal-task-complete-${t.id}`,
            menu: [
              { label: '✅ Done', action: `cal-task-complete-${t.id}` },
              { label: '✏️ Edit', action: `cal-task-edit-${t.id}` },
              { label: '🗑️ Delete', action: `cal-task-delete-${t.id}` }
            ]
          }
        });
      }
    }

    return { ops };
  }

  async showTaskForm(taskId) {
    let title = '➕ New Task', task = null;

    if (taskId) {
      const taskList = await this.getDefaultTaskList();
      const tasks = google.tasks({ version: 'v1', auth: this.oauth2Client });
      task = (await tasks.tasks.get({ tasklist: taskList.id, task: taskId })).data;
      title = '✏️ Edit Task';
    }

    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'cal-task-form', type: 'form', data: {
        id: 'cal-task-form', title,
        fields: [
          { name: 'title', type: 'text', label: 'Task', required: true, value: task ? task.title : '' },
          { name: 'notes', type: 'textarea', label: 'Notes', value: task ? task.notes || '' : '' },
          { name: 'due', type: 'date', label: 'Due Date', value: task && task.due ? task.due.substring(0, 10) : '' },
          ...(taskId ? [{ name: 'taskId', type: 'text', label: '', value: taskId }] : [])
        ],
        actions: [
          { label: '← Back', action: 'cal-tasks', style: 'ghost' },
          { label: taskId ? 'Save' : 'Create', action: taskId ? `cal-task-update-${taskId}` : 'cal-task-create', style: 'primary' }
        ]
      }}
    ]};
  }

  async createTask(context) {
    const { title, notes, due } = context;
    if (!title) return { ops: [{ op: 'upsert', id: 'cal-error', type: 'alert', data: { title: 'Error', message: 'Task title is required.', severity: 'warning' } }] };

    const taskList = await this.getDefaultTaskList();
    const tasks = google.tasks({ version: 'v1', auth: this.oauth2Client });
    const task = { title };
    if (notes) task.notes = notes;
    if (due) task.due = new Date(due).toISOString();

    await tasks.tasks.insert({ tasklist: taskList.id, requestBody: task });
    const result = await this.getTasks();
    result.ops.splice(1, 0, { op: 'upsert', id: 'cal-msg', type: 'alert', data: { title: 'Created', message: `"${title}" added.`, severity: 'success' } });
    return result;
  }

  async updateTask(taskId, context) {
    const { title, notes, due } = context;
    if (!title) return { ops: [{ op: 'upsert', id: 'cal-error', type: 'alert', data: { title: 'Error', message: 'Task title is required.', severity: 'warning' } }] };

    const taskList = await this.getDefaultTaskList();
    const tasks = google.tasks({ version: 'v1', auth: this.oauth2Client });
    const patch = { title };
    if (notes !== undefined) patch.notes = notes;
    if (due) patch.due = new Date(due).toISOString();

    await tasks.tasks.patch({ tasklist: taskList.id, task: taskId, requestBody: patch });
    const result = await this.getTasks();
    result.ops.splice(1, 0, { op: 'upsert', id: 'cal-msg', type: 'alert', data: { title: 'Updated', message: `"${title}" saved.`, severity: 'success' } });
    return result;
  }

  async completeTask(taskId) {
    const taskList = await this.getDefaultTaskList();
    const tasks = google.tasks({ version: 'v1', auth: this.oauth2Client });
    await tasks.tasks.patch({ tasklist: taskList.id, task: taskId, requestBody: { status: 'completed' } });
    const result = await this.getTasks();
    result.ops.splice(1, 0, { op: 'upsert', id: 'cal-msg', type: 'alert', data: { title: 'Done!', message: 'Task completed.', severity: 'success' } });
    return result;
  }

  async deleteTask(taskId) {
    const taskList = await this.getDefaultTaskList();
    const tasks = google.tasks({ version: 'v1', auth: this.oauth2Client });
    await tasks.tasks.delete({ tasklist: taskList.id, task: taskId });
    const result = await this.getTasks();
    result.ops.splice(1, 0, { op: 'upsert', id: 'cal-msg', type: 'alert', data: { title: 'Deleted', message: 'Task removed.', severity: 'success' } });
    return result;
  }

  // ─── Helpers ──────────────────────────────────────────

  formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const dNorm = new Date(d); dNorm.setHours(0,0,0,0);
    if (dNorm.getTime() === today.getTime()) return 'Today';
    if (dNorm.getTime() === tomorrow.getTime()) return 'Tomorrow';
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
  }

  formatEventTime(ev) {
    const start = ev.start.dateTime || ev.start.date;
    const end = ev.end.dateTime || ev.end.date;
    if (start.length <= 10) return 'All day';
    return `${start.substring(11, 16)} – ${end.substring(11, 16)}`;
  }

  isEventNow(ev) {
    if (!ev.start.dateTime) return false;
    const now = Date.now();
    return now >= new Date(ev.start.dateTime).getTime() && now <= new Date(ev.end.dateTime).getTime();
  }

  isoDate(d) { return d.toISOString().substring(0, 10); }
  isoTime(d) { return d.toTimeString().substring(0, 5); }

  // ─── Persistence ──────────────────────────────────────

  saveCreds(data) { fs.writeFileSync(CREDS_PATH, JSON.stringify(data), { mode: 0o600 }); }
  loadCreds() { try { return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); } catch { return null; } }
  saveSession(data) { fs.writeFileSync(this._sessionPath, JSON.stringify(data), { mode: 0o600 }); }
  loadSession() { try { return JSON.parse(fs.readFileSync(this._sessionPath, 'utf8')); } catch { return null; } }
}

module.exports = GoogleCalendarWidget;
