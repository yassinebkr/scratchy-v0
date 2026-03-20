/**
 * sn-account-helper.js — Standard Notes account management utilities
 *
 * Provides connection checking, authentication, and signup guidance
 * for the Scratchy onboarding flow. Uses StandardNotesWidget internally.
 */

const fs = require('fs');
const path = require('path');

const SCRATCHY_ROOT = path.join(__dirname, '..', '..');
const CREDS_FILE = path.join(SCRATCHY_ROOT, '.sn-session.json');
const WIDGET_PATH = path.join(SCRATCHY_ROOT, 'genui-engine', 'templates', 'notes.js');

/**
 * Check if Standard Notes credentials exist and are valid.
 * @returns {{ connected: boolean, email?: string }}
 */
function checkConnection() {
  try {
    if (!fs.existsSync(CREDS_FILE)) {
      return { connected: false };
    }

    const raw = fs.readFileSync(CREDS_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (!data || !data.email || !data.password) {
      return { connected: false };
    }

    // Verify the widget can load these credentials
    const StandardNotesWidget = require(WIDGET_PATH);
    const widget = new StandardNotesWidget();

    if (widget.creds && widget.creds.email) {
      return { connected: true, email: widget.creds.email };
    }

    return { connected: false };
  } catch (e) {
    console.error('[sn-account-helper] checkConnection error:', e.message);
    return { connected: false };
  }
}

/**
 * Authenticate with Standard Notes.
 * On success, stores credentials so the widget can use them going forward.
 * NEVER logs the password.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function authenticate(email, password) {
  if (!email || !email.trim()) {
    return { success: false, error: 'Email is required.' };
  }
  if (!password || !password.trim()) {
    return { success: false, error: 'Password is required.' };
  }

  try {
    const StandardNotesWidget = require(WIDGET_PATH);
    const widget = new StandardNotesWidget();

    // widget.authenticate expects an object with email, password, server
    const result = await widget.authenticate({
      email: email.trim(),
      password: password.trim()
    });

    // After authenticate, check if creds were set (success path)
    // The widget returns screen ops — if creds are set, auth succeeded
    if (widget.creds && widget.creds.email) {
      // Verify connection with a sync
      try {
        await widget.sync();
      } catch (_syncErr) {
        // Sync failure after auth is non-fatal — creds are still stored
        console.error('[sn-account-helper] Post-auth sync warning:', _syncErr.message);
      }
      return { success: true };
    }

    // If creds are null, authenticate failed — extract error from ops
    if (result && result.ops) {
      const alert = result.ops.find(op => op.type === 'alert' || (op.data && op.data.severity));
      if (alert && alert.data && alert.data.message) {
        return { success: false, error: alert.data.message };
      }
    }

    return { success: false, error: 'Authentication failed.' };
  } catch (e) {
    console.error('[sn-account-helper] authenticate error:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Returns the Standard Notes signup URL.
 * @returns {string}
 */
function getSignupUrl() {
  return 'https://app.standardnotes.com';
}

/**
 * Returns step-by-step instructions for creating a Standard Notes account.
 * @returns {string[]}
 */
function getSignupInstructions() {
  return [
    'Go to app.standardnotes.com',
    'Click "Create free account"',
    'Enter email and password (remember these for connecting to Scratchy)',
    'Verify email if prompted',
    'Come back to Scratchy and use "I have an account"'
  ];
}

module.exports = {
  checkConnection,
  authenticate,
  getSignupUrl,
  getSignupInstructions
};
