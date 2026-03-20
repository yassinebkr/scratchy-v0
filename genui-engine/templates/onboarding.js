/**
 * Onboarding Widget — Scratchy GenUI (Phase 19F)
 * Guides new users through first-time setup:
 *   1. Welcome  2. Google (Calendar+Email)  3. Standard Notes
 *   4. Social Channels (optional)  5. Preferences
 *
 * Prefix: onboard-
 * Constructor: new OnboardingWidget({ userStore })
 * Method: async handleAction(action, context) → { ops: [...] }
 */

const path = require('path');

const ACCENT = '#7c3aed';

class OnboardingWidget {
  constructor({ userStore }) {
    this.userStore = userStore;
  }

  // ─── Entry Point ──────────────────────────────────────

  async handleAction(action, context) {
    try {
      switch (action) {
        case 'onboard-start':         return this._quickStart();
        case 'onboard-quick':          return this._quickStart();
        case 'onboard-integrations':   return this._integrations();
        case 'onboard-plan':          return this._plan();
        case 'onboard-plan-hosted':   return this._planHosted();
        case 'onboard-plan-oauth-google': return this._planOauthGoogle();
        case 'onboard-plan-oauth-google-check': return this._planOauthGoogleCheck(context);
        case 'onboard-plan-claude':   return this._planClaude();
        case 'onboard-plan-byok':     return this._planByok();
        case 'onboard-plan-byok-save': return await this._planByokSave(context);
        case 'onboard-google':        return this._google();
        case 'onboard-google-start':  return this._googleStart();
        case 'onboard-google-check':  return this._googleCheck();
        case 'onboard-notes':         return this._notes();
        case 'onboard-notes-form':    return this._notesForm();
        case 'onboard-notes-login':   return await this._notesLogin(context);
        case 'onboard-notes-check':   return this._notesCheck();
        case 'onboard-channels':      return this._channels();
        case 'onboard-preferences':   return this._preferences(context);
        case 'onboard-complete':      return this._complete(context);
        case 'onboard-dismiss':       return { ops: [{ op: 'clear' }], switchToChat: true };
        default:
          return { ops: [
            { op: 'upsert', id: 'onboard-error', type: 'alert', data: {
              title: 'Unknown Action',
              message: `No handler for: ${action}`,
              severity: 'error',
            }},
          ]};
      }
    } catch (err) {
      console.error('[OnboardingWidget]', err.message);
      return { ops: [
        { op: 'clear' },
        { op: 'upsert', id: 'onboard-error', type: 'alert', data: {
          title: 'Something went wrong',
          message: err.message,
          severity: 'error',
        }},
        { op: 'upsert', id: 'onboard-error-nav', type: 'buttons', data: {
          buttons: [
            { label: '← Start Over', action: 'onboard-start', style: 'ghost' },
          ],
        }},
      ]};
    }
  }

  // ─── Helpers ──────────────────────────────────────────

  _progress(step) {
    const labels = ['Welcome', 'Plan', 'Google', 'Notes', 'Channels', 'Preferences'];
    return {
      op: 'upsert',
      id: 'onboard-progress',
      type: 'progress',
      data: {
        label: `Step ${step} of 6 — ${labels[step - 1]}`,
        value: step,
        max: 6,
        icon: '🚀',
        color: ACCENT,
      },
    };
  }

  // ─── Step 1: Welcome ──────────────────────────────────

  _welcome() {
    return { ops: [
      { op: 'clear' },
      this._progress(1),
      { op: 'upsert', id: 'onboard-hero', type: 'hero', data: {
        title: 'Welcome to Scratchy 🐱',
        subtitle: 'Let\'s get you set up — it only takes a minute.',
        icon: '👋',
        gradient: ACCENT,
      }},
      { op: 'upsert', id: 'onboard-checklist', type: 'checklist', data: {
        title: 'Setup Steps',
        items: [
          { text: 'Choose your AI plan', checked: false },
          { text: 'Connect Google (Calendar + Email)', checked: false },
          { text: 'Connect Standard Notes', checked: false },
          { text: 'Social Channels (optional)', checked: false },
          { text: 'Set your preferences', checked: false },
        ],
      }},
      { op: 'upsert', id: 'onboard-actions', type: 'buttons', data: {
        buttons: [
          { label: 'Get Started →', action: 'onboard-plan', style: 'primary' },
        ],
      }},
    ]};
  }

  // ─── Quick Start (Conversational Progressive Onboarding) ──

  _quickStart() {
    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'onboard-welcome', type: 'hero', data: {
        title: 'Welcome to Scratchy 🐱',
        subtitle: 'Your AI workspace is ready. Start chatting or set up integrations.',
        icon: '👋'
      }},
      { op: 'upsert', id: 'onboard-actions', type: 'buttons', data: {
        buttons: [
          { label: '💬 Start Chatting', action: 'onboard-dismiss', style: 'primary' },
          { label: '⚙️ Set Up Integrations', action: 'onboard-integrations', style: 'ghost' }
        ]
      }}
    ]};
  }

  _integrations() {
    return { ops: [
      { op: 'clear' },
      { op: 'upsert', id: 'onboard-int-header', type: 'hero', data: {
        title: 'Integrations',
        subtitle: 'Connect your services. You can always do this later from Settings.',
        icon: '🔗'
      }},
      { op: 'upsert', id: 'onboard-int-google', type: 'link-card', data: {
        title: '📅 Google (Calendar + Email)',
        description: 'Access your calendar events, tasks, and Gmail inbox.',
        icon: '🔗',
        url: '#',
        color: '#4285f4'
      }},
      { op: 'upsert', id: 'onboard-int-google-btn', type: 'buttons', data: {
        buttons: [{ label: 'Connect Google', action: 'onboard-google-start', style: 'primary' }]
      }},
      { op: 'upsert', id: 'onboard-int-notes', type: 'link-card', data: {
        title: '📝 Standard Notes',
        description: 'Sync your encrypted notes for quick access.',
        icon: '📝',
        color: '#086dd6'
      }},
      { op: 'upsert', id: 'onboard-int-notes-btn', type: 'buttons', data: {
        buttons: [{ label: 'Connect Notes', action: 'onboard-notes-form', style: 'primary' }]
      }},
      { op: 'upsert', id: 'onboard-int-done', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-start', style: 'ghost' },
          { label: '✅ Done', action: 'onboard-dismiss', style: 'primary' }
        ]
      }}
    ]};
  }

  // ─── Step 2: Plan Selection ────────────────────────────

  _plan() {
    return { ops: [
      { op: 'clear' },
      this._progress(2),
      { op: 'upsert', id: 'onboard-plan-card', type: 'card', data: {
        title: '🤖 Choose Your AI Plan',
        text: 'Scratchy is powered by AI. Choose how you\'d like to connect — sign in with your own account (recommended), or use the shared hosted plan.',
        icon: '⚡',
      }},
      { op: 'upsert', id: 'onboard-plan-oauth-section', type: 'card', data: {
        title: '🔐 Sign in with your own account (recommended)',
        text: 'Use your existing Google (Gemini) or Anthropic (Claude) subscription. No quotas, you pay through your own plan.',
        icon: '✨',
      }},
      { op: 'upsert', id: 'onboard-plan-oauth-actions', type: 'buttons', data: {
        buttons: [
          { label: '🟢 Sign in with Google (Gemini)', action: 'onboard-plan-oauth-google', style: 'primary' },
          { label: '🟠 Sign in with Claude (API Key)', action: 'onboard-plan-claude', style: 'primary' },
        ],
      }},
      { op: 'upsert', id: 'onboard-plan-hosted-section', type: 'card', data: {
        title: '🌐 Or use the shared hosted plan',
        text: 'Everything works out of the box — no account needed. Usage quotas may apply.',
        icon: '📦',
      }},
      { op: 'upsert', id: 'onboard-plan-bottom-actions', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-start', style: 'ghost' },
          { label: 'Use Hosted Plan →', action: 'onboard-plan-hosted', style: 'ghost' },
        ],
      }},
    ]};
  }

  _planOauthGoogle() {
    // Reuse the Google OAuth flow — add Gemini API scope
    let url = null;
    try {
      const GoogleCalendarWidget = require('./calendar.js');
      const widget = new GoogleCalendarWidget();
      url = widget.getAuthUrl('onboarding-gemini');
    } catch (err) {
      console.error('[OnboardingWidget] Google OAuth URL error:', err.message);
    }

    if (!url) {
      return { ops: [
        { op: 'clear' },
        this._progress(2),
        { op: 'upsert', id: 'onboard-oauth-err', type: 'alert', data: {
          title: 'Google OAuth Not Available',
          message: 'Google OAuth is not configured yet. You can use an API key instead or choose the hosted plan.',
          severity: 'warning',
        }},
        { op: 'upsert', id: 'onboard-oauth-err-nav', type: 'buttons', data: {
          buttons: [
            { label: '← Back', action: 'onboard-plan', style: 'ghost' },
            { label: 'Use API Key', action: 'onboard-plan-byok', style: 'ghost' },
            { label: 'Use Hosted Plan', action: 'onboard-plan-hosted', style: 'ghost' },
          ],
        }},
      ]};
    }

    return { ops: [
      { op: 'clear' },
      this._progress(2),
      { op: 'upsert', id: 'onboard-oauth-google-link', type: 'link-card', data: {
        title: 'Sign in with Google',
        desc: 'Authorize Scratchy to use Gemini AI through your Google account. This also enables Calendar and Gmail.',
        url,
        icon: '🟢',
        color: '#4285F4',
        target: '_self',
      }},
      { op: 'upsert', id: 'onboard-oauth-google-note', type: 'alert', data: {
        title: 'ℹ️ What this does',
        message: 'Signs you in with Google — gives Scratchy access to Gemini AI, Calendar, and Gmail through your own Google account. You won\'t need to connect Google again in the next step.',
        severity: 'info',
      }},
      { op: 'upsert', id: 'onboard-oauth-google-nav', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-plan', style: 'ghost' },
          { label: 'I\'ve signed in — verify', action: 'onboard-plan-oauth-google-check', style: 'primary' },
        ],
      }},
    ]};
  }

  _planOauthGoogleCheck(context) {
    let connected = false;
    try {
      const GoogleCalendarWidget = require('./calendar.js');
      const widget = new GoogleCalendarWidget();
      connected = widget.isConnected();
    } catch (err) {
      console.error('[OnboardingWidget] Google check error:', err.message);
    }

    if (connected) {
      // Mark user as BYOK (Google OAuth = own Gemini subscription)
      const userId = context && context.userId;
      if (userId && this.userStore) {
        try {
          this.userStore.updateUser(userId, {
            preferences: { plan: 'own-key', byokProvider: 'google-oauth' },
          });
        } catch (err) {
          console.error('[OnboardingWidget] Plan save error:', err.message);
        }
      }

      return { ops: [
        { op: 'clear' },
        this._progress(2),
        { op: 'upsert', id: 'onboard-oauth-ok', type: 'alert', data: {
          title: '✅ Google Connected — Gemini AI Active',
          message: 'Your Google account is linked. Gemini AI, Calendar, and Gmail are all ready. No usage quotas apply.',
          severity: 'success',
        }},
        { op: 'upsert', id: 'onboard-oauth-next', type: 'buttons', data: {
          buttons: [
            { label: '← Change Plan', action: 'onboard-plan', style: 'ghost' },
            { label: 'Continue →', action: 'onboard-notes', style: 'primary' },
          ],
        }},
      ]};
    }

    return { ops: [
      { op: 'clear' },
      this._progress(2),
      { op: 'upsert', id: 'onboard-oauth-notyet', type: 'alert', data: {
        title: 'Not Connected Yet',
        message: 'Google sign-in hasn\'t completed. Click the link above and authorize access, then come back and verify.',
        severity: 'warning',
      }},
      { op: 'upsert', id: 'onboard-oauth-retry', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-plan', style: 'ghost' },
          { label: 'Try Again', action: 'onboard-plan-oauth-google', style: 'primary' },
        ],
      }},
    ]};
  }

  _planClaude() {
    return { ops: [
      { op: 'clear' },
      this._progress(2),
      { op: 'upsert', id: 'onboard-claude-info', type: 'card', data: {
        title: '🟠 Anthropic Claude',
        text: 'Claude doesn\'t support OAuth sign-in yet — you\'ll need to paste your API key. Get one from console.anthropic.com → API Keys.',
        icon: '🔑',
      }},
      { op: 'upsert', id: 'onboard-claude-link', type: 'link-card', data: {
        title: 'Get your Claude API key',
        desc: 'Opens the Anthropic Console where you can create an API key',
        url: 'https://console.anthropic.com/settings/keys',
        icon: '🔗',
        color: '#d97706',
      }},
      { op: 'upsert', id: 'onboard-claude-form', type: 'form', data: {
        title: 'Enter API Key',
        id: 'onboard-claude-form',
        fields: [
          { name: 'apiKey', type: 'text', label: 'Claude API Key', placeholder: 'sk-ant-api03-...' },
        ],
        actions: [
          { label: '← Back', action: 'onboard-plan', style: 'ghost' },
          { label: 'Save & Continue →', action: 'onboard-plan-byok-save', style: 'primary' },
        ],
      }},
    ]};
  }

  _planHosted() {
    return { ops: [
      { op: 'clear' },
      this._progress(2),
      { op: 'upsert', id: 'onboard-plan-ok', type: 'alert', data: {
        title: '✅ Hosted Plan Selected',
        message: 'You\'re all set — the shared AI is active. Usage quotas may apply.',
        severity: 'success',
      }},
      { op: 'upsert', id: 'onboard-plan-next', type: 'buttons', data: {
        buttons: [
          { label: '← Change Plan', action: 'onboard-plan', style: 'ghost' },
          { label: 'Continue →', action: 'onboard-google', style: 'primary' },
        ],
      }},
    ]};
  }

  _planByok() {
    return { ops: [
      { op: 'clear' },
      this._progress(2),
      { op: 'upsert', id: 'onboard-byok-info', type: 'card', data: {
        title: '🔑 Enter API Key',
        text: 'Paste your API key below. Your key is encrypted and stored securely on the server.',
        icon: '🔐',
      }},
      { op: 'upsert', id: 'onboard-byok-form', type: 'form', data: {
        title: 'API Key',
        id: 'onboard-byok-form',
        fields: [
          { name: 'provider', type: 'select', label: 'Provider', value: 'anthropic', options: [
            { label: 'Anthropic (Claude)', value: 'anthropic' },
            { label: 'Google (Gemini)', value: 'google' },
          ]},
          { name: 'apiKey', type: 'text', label: 'API Key', placeholder: 'sk-ant-... or AIza...' },
        ],
        actions: [
          { label: '← Back', action: 'onboard-plan', style: 'ghost' },
          { label: 'Save & Continue →', action: 'onboard-plan-byok-save', style: 'primary' },
        ],
      }},
    ]};
  }

  async _planByokSave(context) {
    const { provider, apiKey, userId } = context || {};
    if (!apiKey || !apiKey.trim()) {
      return { ops: [
        { op: 'upsert', id: 'onboard-byok-err', type: 'alert', data: {
          title: 'Missing API Key',
          message: 'Please enter your API key to continue, or go back to choose another plan.',
          severity: 'warning',
        }},
      ]};
    }

    // Detect provider from key format if not specified
    let detectedProvider = provider || 'anthropic';
    const trimmedKey = apiKey.trim();
    if (trimmedKey.startsWith('sk-ant-')) detectedProvider = 'anthropic';
    else if (trimmedKey.startsWith('AIza')) detectedProvider = 'google';

    // Store BYOK preference + key
    if (userId && this.userStore) {
      try {
        this.userStore.updateUser(userId, {
          preferences: {
            plan: 'own-key',
            byokProvider: detectedProvider,
            byokKey: trimmedKey,
          },
        });
        console.log(`[OnboardingWidget] BYOK saved for user ${userId} (${detectedProvider})`);
      } catch (err) {
        console.error('[OnboardingWidget] BYOK save error:', err.message);
        return { ops: [
          { op: 'upsert', id: 'onboard-byok-err', type: 'alert', data: {
            title: 'Save Failed',
            message: err.message,
            severity: 'error',
          }},
        ]};
      }
    }

    const providerName = detectedProvider === 'google' ? 'Google (Gemini)' : 'Anthropic (Claude)';
    return { ops: [
      { op: 'clear' },
      this._progress(2),
      { op: 'upsert', id: 'onboard-byok-ok', type: 'alert', data: {
        title: '✅ API Key Saved',
        message: `Your ${providerName} key is stored securely. No usage quotas will apply.`,
        severity: 'success',
      }},
      { op: 'upsert', id: 'onboard-byok-next', type: 'buttons', data: {
        buttons: [
          { label: '← Change Plan', action: 'onboard-plan', style: 'ghost' },
          { label: 'Continue →', action: 'onboard-google', style: 'primary' },
        ],
      }},
    ]};
  }

  // ─── Step 3: Google Connect ───────────────────────────

  _google() {
    return { ops: [
      { op: 'clear' },
      this._progress(3),
      { op: 'upsert', id: 'onboard-google-card', type: 'card', data: {
        title: '📅 Connect Google',
        text: 'Link your Google account to enable Calendar events and Gmail access. '
            + 'Scratchy will be able to read your schedule and help manage your inbox.',
        icon: '🔗',
      }},
      { op: 'upsert', id: 'onboard-google-actions', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-plan', style: 'ghost' },
          { label: 'Skip →', action: 'onboard-notes', style: 'ghost' },
          { label: 'Connect Google', action: 'onboard-google-start', style: 'primary' },
        ],
      }},
    ]};
  }

  _googleStart() {
    let url = null;
    try {
      const GoogleCalendarWidget = require('./calendar.js');
      const widget = new GoogleCalendarWidget();
      url = widget.getAuthUrl('onboarding');
    } catch (err) {
      console.error('[OnboardingWidget] Google OAuth URL error:', err.message);
    }

    if (!url) {
      return { ops: [
        { op: 'clear' },
        this._progress(3),
        { op: 'upsert', id: 'onboard-google-err', type: 'alert', data: {
          title: 'Google Not Configured',
          message: 'Google OAuth credentials are not set up yet. Ask your admin to configure them.',
          severity: 'warning',
        }},
        { op: 'upsert', id: 'onboard-google-err-nav', type: 'buttons', data: {
          buttons: [
            { label: '← Back', action: 'onboard-google', style: 'ghost' },
            { label: 'Skip →', action: 'onboard-notes', style: 'ghost' },
          ],
        }},
      ]};
    }

    return { ops: [
      { op: 'clear' },
      this._progress(3),
      { op: 'upsert', id: 'onboard-google-link', type: 'link-card', data: {
        title: 'Sign in with Google',
        desc: 'Click below to open the Google consent page. Grant access and you\'ll be brought back automatically.',
        url,
        icon: '🔑',
        color: ACCENT,
        target: '_self',
      }},
      { op: 'upsert', id: 'onboard-google-actions2', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-google', style: 'ghost' },
          { label: 'I\'ve connected — verify', action: 'onboard-google-check', style: 'primary' },
        ],
      }},
    ]};
  }

  _googleCheck() {
    let connected = false;
    try {
      const GoogleCalendarWidget = require('./calendar.js');
      const widget = new GoogleCalendarWidget();
      connected = widget.isConnected();
    } catch (err) {
      console.error('[OnboardingWidget] Google check error:', err.message);
    }

    if (connected) {
      return { ops: [
        { op: 'clear' },
        this._progress(3),
        { op: 'upsert', id: 'onboard-google-ok', type: 'alert', data: {
          title: 'Google Connected ✅',
          message: 'Calendar and Email access are ready.',
          severity: 'success',
        }},
        { op: 'upsert', id: 'onboard-google-next', type: 'buttons', data: {
          buttons: [
            { label: 'Continue →', action: 'onboard-notes', style: 'primary' },
          ],
        }},
      ]};
    }

    return { ops: [
      { op: 'clear' },
      this._progress(3),
      { op: 'upsert', id: 'onboard-google-notyet', type: 'alert', data: {
        title: 'Not Connected Yet',
        message: 'Google doesn\'t seem to be connected. Make sure you completed the consent flow.',
        severity: 'warning',
      }},
      { op: 'upsert', id: 'onboard-google-retry', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-google', style: 'ghost' },
          { label: 'Try Again', action: 'onboard-google-start', style: 'primary' },
          { label: 'Skip →', action: 'onboard-notes', style: 'ghost' },
        ],
      }},
    ]};
  }

  // ─── Step 4: Standard Notes ───────────────────────────

  _notes() {
    return { ops: [
      { op: 'clear' },
      this._progress(4),
      { op: 'upsert', id: 'onboard-notes-card', type: 'card', data: {
        title: '📝 Standard Notes',
        text: 'Connect your Standard Notes account for encrypted, synced notes. '
            + 'Scratchy can read and create notes on your behalf.',
        icon: '🔒',
      }},
      { op: 'upsert', id: 'onboard-notes-actions', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-google', style: 'ghost' },
          { label: 'Skip →', action: 'onboard-channels', style: 'ghost' },
          { label: 'I have an account', action: 'onboard-notes-form', style: 'primary' },
        ],
      }},
      { op: 'upsert', id: 'onboard-notes-register', type: 'link-card', data: {
        title: 'Need an account?',
        desc: 'Create a free Standard Notes account, then come back to connect.',
        url: 'https://standardnotes.com',
        icon: '✨',
        color: '#6b7280',
      }},
    ]};
  }

  // Show login form (triggered by "I have an account" button — route in handleAction)
  _notesForm() {
    return { ops: [
      { op: 'clear' },
      this._progress(4),
      { op: 'upsert', id: 'onboard-notes-login-form', type: 'form', data: {
        title: '🔐 Standard Notes Login',
        id: 'onboard-notes-login-form',
        fields: [
          { name: 'email', type: 'email', label: 'Email', placeholder: 'you@example.com' },
          { name: 'password', type: 'text', label: 'Password', placeholder: '••••••••' },
        ],
        actions: [
          { label: '← Back', action: 'onboard-notes', style: 'ghost' },
          { label: 'Connect', action: 'onboard-notes-login', style: 'primary' },
        ],
      }},
    ]};
  }

  async _notesLogin(context) {
    const { email, password } = context || {};

    if (!email || !email.trim()) {
      return { ops: [
        { op: 'clear' },
        this._progress(4),
        { op: 'upsert', id: 'onboard-notes-err', type: 'alert', data: {
          title: 'Email Required',
          message: 'Please enter your Standard Notes email.',
          severity: 'warning',
        }},
        { op: 'upsert', id: 'onboard-notes-retry', type: 'buttons', data: {
          buttons: [
            { label: '← Back', action: 'onboard-notes', style: 'ghost' },
            { label: 'Try Again', action: 'onboard-notes-form', style: 'primary' },
          ],
        }},
      ]};
    }

    if (!password || !password.trim()) {
      return { ops: [
        { op: 'clear' },
        this._progress(4),
        { op: 'upsert', id: 'onboard-notes-err', type: 'alert', data: {
          title: 'Password Required',
          message: 'Please enter your Standard Notes password.',
          severity: 'warning',
        }},
        { op: 'upsert', id: 'onboard-notes-retry', type: 'buttons', data: {
          buttons: [
            { label: '← Back', action: 'onboard-notes', style: 'ghost' },
            { label: 'Try Again', action: 'onboard-notes-form', style: 'primary' },
          ],
        }},
      ]};
    }

    // Authenticate via StandardNotesWidget
    try {
      const StandardNotesWidget = require('./notes.js');
      const widget = new StandardNotesWidget();
      await widget.authenticate({ email: email.trim(), password: password.trim() });

      // Check if creds were saved (authenticate sets this.creds on success)
      if (widget.creds) {
        return { ops: [
          { op: 'clear' },
          this._progress(4),
          { op: 'upsert', id: 'onboard-notes-ok', type: 'alert', data: {
            title: 'Standard Notes Connected ✅',
            message: `Logged in as ${email.trim()}. Your notes are ready.`,
            severity: 'success',
          }},
          { op: 'upsert', id: 'onboard-notes-next', type: 'buttons', data: {
            buttons: [
              { label: 'Continue →', action: 'onboard-channels', style: 'primary' },
            ],
          }},
        ]};
      }

      // authenticate didn't throw but creds not set — unusual
      throw new Error('Authentication did not complete successfully.');
    } catch (err) {
      console.error('[OnboardingWidget] Notes auth error:', err.message);
      return { ops: [
        { op: 'clear' },
        this._progress(4),
        { op: 'upsert', id: 'onboard-notes-fail', type: 'alert', data: {
          title: 'Connection Failed',
          message: err.message || 'Could not connect to Standard Notes. Check your credentials.',
          severity: 'error',
        }},
        { op: 'upsert', id: 'onboard-notes-retry', type: 'buttons', data: {
          buttons: [
            { label: '← Back', action: 'onboard-notes', style: 'ghost' },
            { label: 'Try Again', action: 'onboard-notes-form', style: 'primary' },
            { label: 'Skip →', action: 'onboard-channels', style: 'ghost' },
          ],
        }},
      ]};
    }
  }

  _notesCheck() {
    let connected = false;
    try {
      const StandardNotesWidget = require('./notes.js');
      const widget = new StandardNotesWidget();
      connected = !!widget.creds;
    } catch (err) {
      console.error('[OnboardingWidget] Notes check error:', err.message);
    }

    if (connected) {
      return { ops: [
        { op: 'clear' },
        this._progress(4),
        { op: 'upsert', id: 'onboard-notes-ok', type: 'alert', data: {
          title: 'Standard Notes Connected ✅',
          message: 'Your notes are synced and ready.',
          severity: 'success',
        }},
        { op: 'upsert', id: 'onboard-notes-next', type: 'buttons', data: {
          buttons: [
            { label: 'Continue →', action: 'onboard-channels', style: 'primary' },
          ],
        }},
      ]};
    }

    return { ops: [
      { op: 'clear' },
      this._progress(4),
      { op: 'upsert', id: 'onboard-notes-notyet', type: 'alert', data: {
        title: 'Not Connected',
        message: 'Standard Notes is not connected yet.',
        severity: 'warning',
      }},
      { op: 'upsert', id: 'onboard-notes-retry', type: 'buttons', data: {
        buttons: [
          { label: 'Connect Now', action: 'onboard-notes-form', style: 'primary' },
          { label: 'Skip →', action: 'onboard-channels', style: 'ghost' },
        ],
      }},
    ]};
  }

  // ─── Step 5: Social Channels (Optional) ───────────────

  _channels() {
    return { ops: [
      { op: 'clear' },
      this._progress(5),
      { op: 'upsert', id: 'onboard-channels-card', type: 'card', data: {
        title: '💬 Social Channels',
        text: 'Social channels let Scratchy reach you on WhatsApp, Discord, or Telegram. '
            + 'These are optional and will be set up by your admin in a future update.',
        icon: '📱',
      }},
      { op: 'upsert', id: 'onboard-ch-whatsapp', type: 'link-card', data: {
        title: 'WhatsApp',
        desc: 'Coming soon — admin will set up',
        url: '#',
        icon: '💚',
        color: '#25d366',
      }},
      { op: 'upsert', id: 'onboard-ch-discord', type: 'link-card', data: {
        title: 'Discord',
        desc: 'Coming soon — admin will set up',
        url: '#',
        icon: '🟣',
        color: '#5865f2',
      }},
      { op: 'upsert', id: 'onboard-ch-telegram', type: 'link-card', data: {
        title: 'Telegram',
        desc: 'Coming soon — admin will set up',
        url: '#',
        icon: '🔵',
        color: '#0088cc',
      }},
      { op: 'upsert', id: 'onboard-channels-nav', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'onboard-notes', style: 'ghost' },
          { label: 'Continue →', action: 'onboard-preferences', style: 'primary' },
        ],
      }},
    ]};
  }

  // ─── Step 6: Preferences ──────────────────────────────

  _preferences(context) {
    // Try to pre-fill display name from user context
    const displayName = (context && context.displayName) || '';

    return { ops: [
      { op: 'clear' },
      this._progress(6),
      { op: 'upsert', id: 'onboard-prefs-form', type: 'form', data: {
        title: '⚙️ Your Preferences',
        id: 'onboard-prefs-form',
        fields: [
          { name: 'displayName', type: 'text', label: 'Display Name', value: displayName, placeholder: 'How should Scratchy call you?' },
          { name: 'theme', type: 'select', label: 'Theme', value: 'dark', options: [
            { label: '🌙 Dark', value: 'dark' },
            { label: '☀️ Light', value: 'light' },
          ]},
        ],
        actions: [
          { label: '← Back', action: 'onboard-channels', style: 'ghost' },
          { label: 'Complete Setup ✓', action: 'onboard-complete', style: 'primary' },
        ],
      }},
    ]};
  }

  // ─── Complete ─────────────────────────────────────────

  _complete(context) {
    const { displayName, theme, userId } = context || {};

    // Update user via userStore if we have context
    if (userId && this.userStore) {
      try {
        const updates = { onboardingComplete: true };
        if (displayName && displayName.trim()) {
          updates.displayName = displayName.trim();
        }
        if (theme) {
          updates.preferences = { theme };
        }
        this.userStore.updateUser(userId, updates);
        console.log(`[OnboardingWidget] Onboarding complete for user ${userId}`);
      } catch (err) {
        console.error('[OnboardingWidget] Failed to update user:', err.message);
      }
    }

    const userName = (displayName && displayName.trim()) || 'there';

    return {
      // Signal serve.js to inject a welcome message into the chat
      welcomeChat: true,
      welcomeName: userName,
      ops: [
        { op: 'clear' },
        { op: 'upsert', id: 'onboard-done-hero', type: 'hero', data: {
          title: 'You\'re All Set! 🎉',
          subtitle: 'Scratchy is ready to help. Start chatting to explore what\'s possible.',
          icon: '✅',
          badge: 'Complete',
          gradient: ACCENT,
        }},
        { op: 'upsert', id: 'onboard-done-checklist', type: 'checklist', data: {
          title: 'Setup Complete',
          items: [
            { text: 'Google (Calendar + Email)', checked: this._isGoogleConnected() },
            { text: 'Standard Notes', checked: this._isNotesConnected() },
            { text: 'Social Channels', checked: false },
            { text: 'Preferences saved', checked: true },
          ],
        }},
        { op: 'upsert', id: 'onboard-done-action', type: 'buttons', data: {
          buttons: [
            { label: '🐱 Start Chatting', action: 'onboard-dismiss', style: 'primary' },
          ],
        }},
      ],
    };
  }

  // ─── Connection Status Helpers ────────────────────────

  _isGoogleConnected() {
    try {
      const GoogleCalendarWidget = require('./calendar.js');
      const widget = new GoogleCalendarWidget();
      return widget.isConnected();
    } catch {
      return false;
    }
  }

  _isNotesConnected() {
    try {
      const StandardNotesWidget = require('./notes.js');
      const widget = new StandardNotesWidget();
      return !!widget.creds;
    } catch {
      return false;
    }
  }
}

module.exports = OnboardingWidget;
