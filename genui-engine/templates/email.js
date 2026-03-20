/**
 * Email Widget — Scratchy GenUI
 * Dual backend: Gmail (read + human-only send) + Resend (@example.com)
 * Prefix: mail-
 * 
 * Security model:
 * - Gmail send: ONLY via widget UI (human). Agent cannot trigger mail-gmail-send.
 * - Resend send: Both human and agent (via Resend API directly).
 * - Gmail read/search: Both human and agent.
 * - Delete/archive: Widget UI only.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');
const { getWidgetStatePath, migrateLegacyFile } = require('../../lib/widget-state');

// Resend config
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = 'onboarding@resend.dev'; // Test mode — can only send to verified emails
// After domain verification: use your own domain sender address

// Shared Google OAuth credentials (not per-user)
const GCAL_CREDS_PATH = process.env.GCAL_CREDS_PATH || path.join(process.env.HOME || '.', '.gcal-creds.json');
const LEGACY_GCAL_SESSION_PATH = process.env.GCAL_SESSION_PATH || path.join(process.env.HOME || '.', '.gcal-session.json');

class EmailWidget {
  constructor(userId) {
    this._userId = userId || '_legacy';
    // Migrate legacy root-level session file on first access
    migrateLegacyFile(LEGACY_GCAL_SESSION_PATH, this._userId, 'gcal-session.json');
    this._sessionPath = getWidgetStatePath(this._userId, 'gcal-session.json');
    this.creds = this._loadJson(GCAL_CREDS_PATH);
    this.session = this._loadJson(this._sessionPath);
    this.oauth2Client = null;
    if (this.creds) this._initOAuth();
  }

  _initOAuth() {
    this.oauth2Client = new google.auth.OAuth2(
      this.creds.clientId, this.creds.clientSecret,
      this.creds.redirectUri || 'https://scratchy.example.com/auth/google/callback'
    );
    if (this.session && this.session.tokens) {
      this.oauth2Client.setCredentials(this.session.tokens);
    }
  }

  isConnected() {
    return this.oauth2Client && this.session && this.session.tokens;
  }

  // ─── Entry Point ──────────────────────────────────────

  async handleAction(action, context) {
    try {
      if (action === 'mail-auto-connect') return this.autoConnect();

      if (!this.isConnected()) {
        return { ops: [
          { op: 'clear' },
          { op: 'upsert', id: 'mail-noauth', type: 'alert', data: {
            title: 'Not connected', message: 'Set up Google Calendar widget first — email shares the same OAuth.', severity: 'warning'
          }}
        ]};
      }

      // Refresh token
      try {
        const { credentials } = await this.oauth2Client.getAccessToken();
        if (credentials) this.oauth2Client.setCredentials(credentials);
      } catch {}

      switch (action) {
        case 'mail-inbox':          return this.getInbox();
        case 'mail-search':         return this.searchEmails(context);
        case 'mail-search-form':    return this.showSearchForm();
        case 'mail-compose':        return this.showComposeForm('gmail', context);
        case 'mail-compose-resend': return this.showComposeForm('resend', context);
        case 'mail-gmail-send':     return this.sendGmail(context);
        case 'mail-resend-send':    return this.sendResend(context);
        case 'mail-reply-form':     return this.showReplyForm(context);
        case 'mail-reply-send':     return this.sendReply(context);
        case 'mail-archive':        return this.archiveEmail(context);
        case 'mail-trash':          return this.trashEmail(context);
        case 'mail-refresh':        return this.getInbox();
        default:
          if (action.startsWith('mail-read-'))    return this.readEmail(action.slice(10));
          if (action.startsWith('mail-archive-')) return this.archiveEmail({ messageId: action.slice(13) });
          if (action.startsWith('mail-trash-'))   return this.trashEmail({ messageId: action.slice(11) });
          if (action.startsWith('mail-reply-'))   return this.showReplyForm({ messageId: action.slice(11) });
          return { ops: [{ op: 'upsert', id: 'mail-error', type: 'alert', data: { title: 'Error', message: `Unknown: ${action}`, severity: 'error' } }] };
      }
    } catch (err) {
      console.error('[MailWidget]', err.message);
      return { ops: [
        { op: 'upsert', id: 'mail-error', type: 'alert', data: { title: 'Error', message: err.message, severity: 'error' } }
      ]};
    }
  }

  async autoConnect() {
    if (this.isConnected()) return this.getInbox();
    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'mail-noauth', type: 'alert', data: {
        title: 'Not connected', message: 'Connect via the Calendar widget first — email shares the same Google OAuth.', severity: 'info'
      }}
    ]};
  }

  // ─── Navigation ───────────────────────────────────────

  nav(active, extra = []) {
    const tabs = [
      { label: '📥 Inbox', action: 'mail-inbox', style: active === 'inbox' ? 'primary' : 'ghost' },
      { label: '🔍 Search', action: 'mail-search-form', style: active === 'search' ? 'primary' : 'ghost' },
      { label: '✏️ Compose', action: 'mail-compose', style: active === 'compose' ? 'primary' : 'ghost' },
      { label: '🔄', action: 'mail-refresh', style: 'ghost' },
      ...extra
    ];
    return [{ op: 'upsert', id: 'mail-nav', type: 'buttons', data: { buttons: tabs } }];
  }

  // ─── Inbox ────────────────────────────────────────────

  async getInbox(query = 'in:inbox', label = 'Inbox') {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    const res = await gmail.users.messages.list({
      userId: 'me', q: query, maxResults: 10
    });

    const messageIds = (res.data.messages || []).map(m => m.id);
    const emails = await Promise.all(messageIds.map(id => this._getEmailSummary(gmail, id)));

    const ops = [
      { op: 'clear' },
      ...this.nav('inbox'),
      { op: 'upsert', id: 'mail-count', type: 'stats', data: {
        title: `📧 ${label}`, items: [{ label: 'Messages', value: String(emails.length) }]
      }}
    ];

    if (emails.length === 0) {
      ops.push({ op: 'upsert', id: 'mail-empty', type: 'card', data: {
        title: 'All clear', text: 'No messages found.'
      }});
    } else {
      for (const email of emails) {
        const isUnread = email.unread;
        const snippet = this._cleanSnippet(email.snippet);
        const attachIcon = email.hasAttachments ? ' 📎' : '';
        ops.push({
          op: 'upsert', id: `mail-msg-${email.id}`, type: 'card',
          data: {
            title: `${isUnread ? '● ' : ''}${email.from}  ·  ${email.date}${attachIcon}`,
            text: `${email.subject}\n${snippet}`,
            action: `mail-read-${email.id}`,
            menu: [
              { label: '↩️ Reply', action: `mail-reply-${email.id}` },
              { label: '📦 Archive', action: `mail-archive-${email.id}` },
              { label: '🗑️ Trash', action: `mail-trash-${email.id}` }
            ]
          }
        });
      }
    }

    return { ops };
  }

  async _getEmailSummary(gmail, messageId) {
    const msg = await gmail.users.messages.get({
      userId: 'me', id: messageId, format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date', 'Content-Type']
    });

    const headers = msg.data.payload.headers || [];
    const getHeader = (name) => (headers.find(h => h.name === name) || {}).value || '';

    // Detect attachments from Content-Type or payload structure
    const contentType = getHeader('Content-Type').toLowerCase();
    const hasAttachments = contentType.includes('mixed') || contentType.includes('attachment') ||
      this._hasAttachmentParts(msg.data.payload);

    return {
      id: messageId,
      from: this._parseFromName(getHeader('From')),
      subject: getHeader('Subject') || '(No subject)',
      date: this._formatEmailDate(getHeader('Date')),
      snippet: (msg.data.snippet || '').substring(0, 80),
      unread: (msg.data.labelIds || []).includes('UNREAD'),
      hasAttachments
    };
  }

  _hasAttachmentParts(payload) {
    if (!payload) return false;
    if (payload.filename && payload.filename.length > 0) return true;
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.filename && part.filename.length > 0) return true;
        if (this._hasAttachmentParts(part)) return true;
      }
    }
    return false;
  }

  _extractAttachments(payload, messageId) {
    const attachments = [];
    const _walk = (part) => {
      if (!part) return;
      if (part.filename && part.filename.length > 0 && part.body) {
        const size = part.body.size || 0;
        let sizeStr;
        if (size > 1048576) sizeStr = (size / 1048576).toFixed(1) + ' MB';
        else if (size > 1024) sizeStr = Math.round(size / 1024) + ' KB';
        else sizeStr = size + ' B';
        const attId = part.body.attachmentId || null;
        attachments.push({
          name: part.filename,
          size: sizeStr,
          mimeType: part.mimeType || 'application/octet-stream',
          attachmentId: attId,
          messageId: messageId,
          downloadUrl: attId ? `/api/attachment?messageId=${messageId}&attachmentId=${encodeURIComponent(attId)}&filename=${encodeURIComponent(part.filename)}&mimeType=${encodeURIComponent(part.mimeType || 'application/octet-stream')}&mode=download` : null,
          previewUrl: attId ? `/api/attachment?messageId=${messageId}&attachmentId=${encodeURIComponent(attId)}&filename=${encodeURIComponent(part.filename)}&mimeType=${encodeURIComponent(part.mimeType || 'application/octet-stream')}&mode=inline` : null
        });
      }
      if (part.parts) part.parts.forEach(p => _walk(p));
    };
    _walk(payload);
    return attachments;
  }

  // ─── Read Email ───────────────────────────────────────

  async readEmail(messageId) {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });

    const headers = msg.data.payload.headers || [];
    const getHeader = (name) => (headers.find(h => h.name === name) || {}).value || '';
    const body = this._extractBody(msg.data.payload);

    // Get original HTML for rich rendering
    const rawHtml = this._findPart(msg.data.payload, 'text/html');

    // Mark as read
    try {
      await gmail.users.messages.modify({
        userId: 'me', id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] }
      });
    } catch {}

    // Extract attachments
    const attachments = this._extractAttachments(msg.data.payload, messageId);

    // Single email-view component — everything in one tile
    const emailData = {
      subject: getHeader('Subject') || '(No subject)',
      from: this._parseFromName(getHeader('From')),
      to: getHeader('To'),
      date: this._formatEmailDate(getHeader('Date')),
      html: rawHtml || null,
      body: rawHtml ? null : this._cleanBody(body),
      actions: [
        { label: '← Inbox', action: 'mail-inbox', style: 'ghost' },
        { label: '↩️ Reply', action: `mail-reply-${messageId}`, style: 'primary' },
        { label: '📦 Archive', action: `mail-archive-${messageId}`, style: 'ghost' },
        { label: '🗑️ Trash', action: `mail-trash-${messageId}`, style: 'ghost' }
      ]
    };
    if (attachments.length > 0) emailData.attachments = attachments;

    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'mail-reader', type: 'email-view', data: emailData }
    ]};
  }

  // ─── Compose ──────────────────────────────────────────

  showComposeForm(backend = 'gmail', prefill = {}) {
    const isResend = backend === 'resend';
    return { ops: [
      { op: 'clear' },
      ...this.nav('compose'),
      { op: 'upsert', id: 'mail-compose-switch', type: 'buttons', data: { buttons: [
        { label: '📧 Send as Gmail', action: 'mail-compose', style: !isResend ? 'primary' : 'ghost' },
        { label: '🏢 Send as @example.com', action: 'mail-compose-resend', style: isResend ? 'primary' : 'ghost' }
      ]}},
      { op: 'upsert', id: 'mail-compose-form', type: 'form', data: {
        id: 'mail-compose-form',
        title: isResend ? 'Compose (from @example.com)' : 'Compose (from Gmail)',
        fields: [
          { name: 'to', type: 'email', label: 'To', required: true, placeholder: isResend ? 'your-email@example.com (test mode)' : '', value: prefill.to || '' },
          { name: 'subject', type: 'text', label: 'Subject', required: true, value: prefill.subject || '' },
          { name: 'body', type: 'textarea', label: 'Message', required: true, value: prefill.body || '' }
        ],
        actions: [
          { label: '← Inbox', action: 'mail-inbox', style: 'ghost' },
          { label: 'Send', action: isResend ? 'mail-resend-send' : 'mail-gmail-send', style: 'primary' }
        ]
      }},
      ...(isResend ? [{ op: 'upsert', id: 'mail-resend-note', type: 'alert', data: {
        title: 'Test mode', message: 'Resend can only send to verified emails until domain is verified.', severity: 'info'
      }}] : [])
    ]};
  }

  // ─── Gmail Send (WIDGET ONLY — human action, never agent) ────

  async sendGmail(context) {
    const { to, subject, body } = context;
    if (!to || !subject || !body) {
      return { ops: [{ op: 'upsert', id: 'mail-error', type: 'alert', data: { title: 'Error', message: 'All fields are required.', severity: 'warning' } }] };
    }

    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    const raw = this._makeRawEmail(to, subject, body);

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw }
    });

    const result = await this.getInbox();
    result.ops.splice(1, 0, { op: 'upsert', id: 'mail-msg-sent', type: 'alert', data: {
      title: 'Sent!', message: `Email sent to ${to} via Gmail.`, severity: 'success'
    }});
    return result;
  }

  // ─── Resend Send (both human and agent) ───────────────

  async sendResend(context) {
    const { to, subject, body } = context;
    if (!to || !subject || !body) {
      return { ops: [{ op: 'upsert', id: 'mail-error', type: 'alert', data: { title: 'Error', message: 'All fields are required.', severity: 'warning' } }] };
    }

    const htmlBody = this._wrapEmailHtml(subject, body);
    const result = await this._resendApiCall({
      from: RESEND_FROM,
      to: [to],
      subject,
      html: htmlBody,
      text: body
    });

    if (result.error) {
      return { ops: [{ op: 'upsert', id: 'mail-error', type: 'alert', data: { title: 'Send failed', message: result.error, severity: 'error' } }] };
    }

    const inbox = await this.getInbox();
    inbox.ops.splice(1, 0, { op: 'upsert', id: 'mail-msg-sent', type: 'alert', data: {
      title: 'Sent!', message: `Email sent to ${to} via Resend (@example.com).`, severity: 'success'
    }});
    return inbox;
  }

  // ─── Reply ────────────────────────────────────────────

  async showReplyForm(context) {
    const messageId = context.messageId || context.id;
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['From', 'Subject'] });

    const headers = msg.data.payload.headers || [];
    const getHeader = (name) => (headers.find(h => h.name === name) || {}).value || '';
    const replyTo = this._parseFromEmail(getHeader('From'));
    const subject = getHeader('Subject');
    const reSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'mail-reply-header', type: 'card', data: {
        title: `↩️ Reply to ${this._parseFromName(getHeader('From'))}`,
        text: reSubject
      }},
      { op: 'upsert', id: 'mail-reply-form', type: 'form', data: {
        id: 'mail-reply-form',
        title: 'Reply',
        fields: [
          { name: 'to', type: 'email', label: 'To', value: replyTo, required: true },
          { name: 'subject', type: 'text', label: 'Subject', value: reSubject },
          { name: 'messageId', type: 'text', label: '', value: messageId },
          { name: 'threadId', type: 'text', label: '', value: msg.data.threadId },
          { name: 'body', type: 'textarea', label: 'Message', required: true }
        ],
        actions: [
          { label: '← Back', action: `mail-read-${messageId}`, style: 'ghost' },
          { label: 'Send Reply', action: 'mail-reply-send', style: 'primary' }
        ]
      }}
    ]};
  }

  async sendReply(context) {
    const { to, subject, body, messageId, threadId } = context;
    if (!to || !body) {
      return { ops: [{ op: 'upsert', id: 'mail-error', type: 'alert', data: { title: 'Error', message: 'To and message are required.', severity: 'warning' } }] };
    }

    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    const raw = this._makeRawEmail(to, subject || 'Re:', body, messageId);

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: threadId || undefined }
    });

    const result = await this.getInbox();
    result.ops.splice(1, 0, { op: 'upsert', id: 'mail-msg-sent', type: 'alert', data: {
      title: 'Reply sent!', message: `Reply sent to ${to}.`, severity: 'success'
    }});
    return result;
  }

  // ─── Search ───────────────────────────────────────────

  showSearchForm() {
    return { ops: [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'mail-search-form', type: 'form', data: {
        id: 'mail-search-form',
        title: 'Search Emails',
        fields: [
          { name: 'query', type: 'text', label: 'Search', required: true, placeholder: 'from:john subject:meeting' }
        ],
        actions: [
          { label: '← Inbox', action: 'mail-inbox', style: 'ghost' },
          { label: 'Search', action: 'mail-search', style: 'primary' }
        ]
      }}
    ]};
  }

  async searchEmails(context) {
    const query = context.query;
    if (!query) return this.showSearchForm();
    return this.getInbox(query, `Search: ${query}`);
  }

  // ─── Archive / Trash ──────────────────────────────────

  async archiveEmail(context) {
    const messageId = context.messageId || context.id;
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    await gmail.users.messages.modify({
      userId: 'me', id: messageId,
      requestBody: { removeLabelIds: ['INBOX'] }
    });
    const result = await this.getInbox();
    result.ops.splice(1, 0, { op: 'upsert', id: 'mail-msg-archived', type: 'alert', data: {
      title: 'Archived', message: 'Email moved to archive.', severity: 'success'
    }});
    return result;
  }

  async trashEmail(context) {
    const messageId = context.messageId || context.id;
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    await gmail.users.messages.trash({ userId: 'me', id: messageId });
    const result = await this.getInbox();
    result.ops.splice(1, 0, { op: 'upsert', id: 'mail-msg-trashed', type: 'alert', data: {
      title: 'Trashed', message: 'Email moved to trash.', severity: 'success'
    }});
    return result;
  }

  // ─── Helpers ──────────────────────────────────────────

  _wrapEmailHtml(subject, body) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const isHtml = /<[a-z][\s\S]*>/i.test(body);

    // If body already contains HTML, use it directly; otherwise convert plain text
    const paragraphs = isHtml ? body : body.split(/\n{2,}/).map(block => {
      const lines = block.split('\n').map(l => esc(l)).join('<br>');
      return `<p style="margin:0 0 16px 0;line-height:1.6">${lines}</p>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f14;padding:40px 20px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
        <!-- Header -->
        <tr><td style="padding:24px 32px;background:#18181f;border-radius:12px 12px 0 0;border-bottom:1px solid #2a2a35">
          <table width="100%"><tr>
            <td style="font-size:20px;font-weight:700;color:#e2e2e8">🔧 Scratchy</td>
            <td align="right" style="font-size:12px;color:#71717a">Secured by Scratchy</td>
          </tr></table>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;background:#18181f;color:#d1d1d8;font-size:15px">
          ${paragraphs}
        </td></tr>
        <!-- Credential box (if contains "Password:") -->
        ${body.includes('Password:') ? `
        <tr><td style="padding:0 32px 24px;background:#18181f">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e1e2a;border:1px solid #6366f1;border-radius:8px;padding:16px 20px">
            <tr><td style="color:#a5b4fc;font-size:13px;font-weight:600;padding-bottom:8px">🔑 YOUR CREDENTIALS</td></tr>
            ${body.match(/Email:\s*(.+)/)?.[1] ? `<tr><td style="color:#d1d1d8;font-size:14px;padding:2px 0"><strong style="color:#a1a1aa">Email:</strong> <code style="background:#27272f;padding:2px 6px;border-radius:4px;color:#e2e2e8">${esc(body.match(/Email:\s*(.+)/)[1].trim())}</code></td></tr>` : ''}
            ${body.match(/Password:\s*(.+)/)?.[1] ? `<tr><td style="color:#d1d1d8;font-size:14px;padding:2px 0"><strong style="color:#a1a1aa">Password:</strong> <code style="background:#27272f;padding:2px 6px;border-radius:4px;color:#e2e2e8;letter-spacing:0.5px">${esc(body.match(/Password:\s*(.+)/)[1].trim())}</code></td></tr>` : ''}
          </table>
        </td></tr>` : ''}
        <!-- CTA Button -->
        ${body.includes('scratchy.example.com') ? `
        <tr><td align="center" style="padding:0 32px 28px;background:#18181f">
          <a href="https://scratchy.example.com" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:15px">Log In to Scratchy →</a>
        </td></tr>` : ''}
        <!-- Footer -->
        <tr><td style="padding:20px 32px;background:#18181f;border-radius:0 0 12px 12px;border-top:1px solid #2a2a35">
          <p style="margin:0;color:#52525b;font-size:12px;line-height:1.5">
            This is an automated message from Scratchy. Please change your password after first login.<br>
            If you didn't expect this email, you can safely ignore it.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  }

  _makeRawEmail(to, subject, body, inReplyTo) {
    // RFC 2047: encode subject as base64 for proper UTF-8 (accents, em dashes, etc.)
    const encSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';
    const isHtml = /<[a-z][\s\S]*>/i.test(body);

    if (isHtml) {
      // Multipart email: HTML + plain text fallback
      const boundary = 'scratchy_' + Date.now().toString(36);
      const plainText = body
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n').trim();

      const htmlWrapped = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <tr><td style="padding:32px;color:#1a1a1a;font-size:15px;line-height:1.7">
          ${body}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

      // Encode both parts as base64 to avoid line-wrapping issues
      const plainB64 = Buffer.from(plainText, 'utf8').toString('base64');
      const htmlB64 = Buffer.from(htmlWrapped, 'utf8').toString('base64');

      const lines = [
        `To: ${to}`,
        `Subject: ${encSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ];
      if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
      lines.push(
        '', `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64', '',
        plainB64,
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64', '',
        htmlB64,
        `--${boundary}--`
      );
      return Buffer.from(lines.join('\r\n')).toString('base64url');
    }

    // Plain text email — encode body as base64 to prevent 76-char line wrapping
    const bodyB64 = Buffer.from(body, 'utf8').toString('base64');
    const lines = [
      `To: ${to}`,
      `Subject: ${encSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ];
    if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push('', bodyB64);
    return Buffer.from(lines.join('\r\n')).toString('base64url');
  }

  _extractBody(payload) {
    // Prefer HTML — we convert it to structured readable text
    const html = this._findPart(payload, 'text/html');
    if (html) return this._htmlToReadable(html);
    // Plain text fallback
    const plain = this._findPart(payload, 'text/plain');
    if (plain) return plain;
    return '';
  }

  _findPart(payload, mime) {
    if (payload.mimeType === mime && payload.body && payload.body.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const r = this._findPart(part, mime);
        if (r) return r;
      }
    }
    return null;
  }

  _htmlToReadable(html) {
    let t = html;
    // Remove style/script/head blocks entirely
    t = t.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    t = t.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
    // Remove HTML comments
    t = t.replace(/<!--[\s\S]*?-->/g, '');
    // Remove tracking pixels (1x1 images, open trackers)
    t = t.replace(/<img[^>]*(?:width=["']1["']|height=["']1["']|track\/open)[^>]*>/gi, '');
    // Images → [🖼 alt] — skip if no meaningful alt
    t = t.replace(/<img[^>]*alt=["']([^"']{3,})["'][^>]*>/gi, '[🖼 $1]');
    t = t.replace(/<img[^>]*>/gi, '');
    // Links → meaningful text only
    t = t.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, inner) => {
      const text = inner.replace(/<[^>]*>/g, '').replace(/[\u034F\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, '').trim();
      if (!text) return '';
      if (text.match(/^https?:/)) {
        try { return '[' + new URL(text).hostname.replace('www.','') + ']'; } catch { return ''; }
      }
      return text;
    });
    // Headings
    t = t.replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, '\n\n▸ $1\n');
    t = t.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n$1\n');
    // Block elements → newlines
    t = t.replace(/<\/?(p|div|tr|section|article|header|footer|main|blockquote)[^>]*>/gi, '\n');
    // Table cells
    t = t.replace(/<\/?(td|th)[^>]*>/gi, '  ');
    // List items → bullet (only if has text content)
    t = t.replace(/<li[^>]*>/gi, '\n• ');
    t = t.replace(/<\/li>/gi, '');
    // Line breaks / hr
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<hr[^>]*>/gi, '\n───\n');
    // Strip all remaining tags
    t = t.replace(/<[^>]*>/g, '');
    // Decode entities
    t = this._decodeEntities(t);
    // Remove zero-width / invisible unicode characters
    t = t.replace(/[\u034F\u200B-\u200F\u2028-\u202F\u2060\uFEFF\u0300-\u036F]/g, '');
    // Clean up whitespace
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/\n /g, '\n');
    t = t.replace(/ \n/g, '\n');
    // Remove empty bullets
    t = t.replace(/• *\n/g, '');
    // Collapse blank lines (max 2)
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // Extract meaningful clickable links from email HTML (CTAs, not tracking/unsubscribe)
  _extractLinks(html, max = 4) {
    if (!html) return [];
    const links = [];
    const seen = new Set();
    const re = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null && links.length < max) {
      const url = m[1];
      const text = m[2].replace(/<[^>]*>/g, '').replace(/[\u034F\u200B-\u200F\u2060\uFEFF]/g, '').trim();
      // Skip: no text, tracking, unsubscribe, mailto, short text, duplicates
      if (!text || text.length < 3) continue;
      if (/unsubscribe|optout|opt-out|mailto:|javascript:|#$/i.test(url)) continue;
      if (/track\/open|view.*browser|privacy|terms|manage.*preferences/i.test(url)) continue;
      if (text.match(/^https?:/)) continue; // bare URL as text
      if (text.match(/^(here|click|view|link)$/i)) continue;
      let domain;
      try { domain = new URL(url).hostname.replace('www.', ''); } catch { continue; }
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ text, url, domain });
    }
    return links;
  }

  // Extract up to N meaningful image URLs from email HTML (skip tracking pixels)
  _extractImages(html, max = 3) {
    if (!html) return [];
    const imgs = [];
    const re = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null && imgs.length < max) {
      const src = m[0];
      const url = m[1];
      // Skip tracking pixels and tiny images
      if (/width=["']1/i.test(src) || /height=["']1/i.test(src)) continue;
      if (/track|open\.php|pixel|spacer|transparent/i.test(url)) continue;
      // Skip data URIs
      if (url.startsWith('data:')) continue;
      // Only keep reasonably-sized images (check for width hints)
      const wMatch = src.match(/width=["'](\d+)/i);
      if (wMatch && parseInt(wMatch[1]) < 20) continue;
      imgs.push(url);
    }
    return imgs;
  }

  _cleanBody(text) {
    if (!text) return '';
    let clean = this._decodeEntities(text);
    // Replace long URLs with just the domain
    clean = clean.replace(/https?:\/\/([^\/\s]+)\S{40,}/g, '[$1 link]');
    // Remove empty parens left from stripped links
    clean = clean.replace(/\(\s*\)/g, '');
    // Collapse 3+ newlines to 2
    clean = clean.replace(/\n{3,}/g, '\n\n');
    // Collapse 3+ spaces
    clean = clean.replace(/ {3,}/g, ' ');
    // Trim and cap at 1500 chars
    clean = clean.trim();
    return clean.length > 1500 ? clean.substring(0, 1500) + '\n\n… (truncated)' : clean;
  }

  _cleanSnippet(text) {
    if (!text) return '';
    // Decode HTML entities first
    let clean = this._decodeEntities(text);
    // Strip URLs (tracking links, etc.)
    clean = clean.replace(/https?:\/\/\S{40,}/g, '').replace(/\(\s*\)/g, '');
    // Collapse whitespace
    clean = clean.replace(/\s+/g, ' ').trim();
    // Truncate
    return clean.length > 120 ? clean.substring(0, 120) + '…' : clean;
  }

  _decodeEntities(text) {
    if (!text) return '';
    return text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
               .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
               .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
               .replace(/&rsquo;/g, '\u2019').replace(/&lsquo;/g, '\u2018')
               .replace(/&rdquo;/g, '\u201D').replace(/&ldquo;/g, '\u201C')
               .replace(/&hellip;/g, '\u2026').replace(/&mdash;/g, '\u2014')
               .replace(/&ndash;/g, '\u2013').replace(/&eacute;/g, 'é')
               .replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à');
  }

  _parseFromName(from) {
    const match = from.match(/^"?([^"<]+)"?\s*</);
    return match ? match[1].trim() : from.split('@')[0];
  }

  _parseFromEmail(from) {
    const match = from.match(/<([^>]+)>/);
    return match ? match[1] : from;
  }

  _formatEmailDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      if (isToday) return d.toTimeString().substring(0, 5);
      return `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
    } catch { return dateStr; }
  }

  async _resendApiCall(data) {
    return new Promise((resolve) => {
      const body = JSON.stringify(data);
      const req = https.request({
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let chunks = '';
        res.on('data', c => chunks += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(chunks);
            if (res.statusCode >= 400) resolve({ error: json.message || 'Send failed' });
            else resolve(json);
          } catch { resolve({ error: 'Invalid response' }); }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.write(body);
      req.end();
    });
  }

  _loadJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }
}

module.exports = EmailWidget;
