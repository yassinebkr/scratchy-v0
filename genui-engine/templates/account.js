/**
 * Account Widget — Scratchy GenUI
 * Shown to non-admin users (operators/viewers) for viewing
 * their account details and changing their password.
 * Prefix: account-
 *
 * Constructor: new AccountWidget({ userStore })
 */

const ROLE_EMOJI = { admin: '👑', operator: '⚙️', viewer: '👁️' };
const ROLE_COLORS = { admin: '#7c3aed', operator: '#3b82f6', viewer: '#6b7280' };

class AccountWidget {
  constructor({ userStore }) {
    this.userStore = userStore;
  }

  // ─── Entry Point ──────────────────────────────────────

  async handleAction(action, context) {
    try {
      switch (action) {
        case 'account-profile':         return this._profile(context);
        case 'account-change-password': return this._changePasswordForm(context);
        case 'account-save-password':   return this._savePassword(context);
        default:
          return { ops: [{ op: 'upsert', id: 'account-error', type: 'alert', data: {
            title: 'Unknown Action', message: `Action "${action}" is not recognised.`, severity: 'error',
          }}]};
      }
    } catch (err) {
      console.error(`[AccountWidget] Error in ${action}:`, err);
      return { ops: [{ op: 'upsert', id: 'account-error', type: 'alert', data: {
        title: 'Error', message: err.message || 'Something went wrong.', severity: 'error',
      }}]};
    }
  }

  // ─── Profile View ─────────────────────────────────────

  _profile(context) {
    const userId = context?.userId;
    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'account-error', type: 'alert', data: {
        title: 'Error', message: 'No user context available.', severity: 'error',
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'account-error', type: 'alert', data: {
        title: 'Not Found', message: 'User account not found.', severity: 'error',
      }}]};
    }

    const roleEmoji = ROLE_EMOJI[user.role] || '👤';
    const roleBadge = `${roleEmoji} ${user.role.charAt(0).toUpperCase() + user.role.slice(1)}`;

    const memberSince = user.createdAt
      ? new Date(user.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'Unknown';

    const lastActive = user.lastLoginAt
      ? new Date(user.lastLoginAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'Never';

    return { ops: [
      { op: 'clear' },

      // Hero header
      { op: 'upsert', id: 'account-hero', type: 'hero', data: {
        title: user.displayName || user.email.split('@')[0],
        subtitle: `${roleBadge}  ·  ${user.email}`,
      }},

      // Account details
      { op: 'upsert', id: 'account-kv', type: 'kv', data: {
        title: '📋 Account Details',
        items: [
          { key: 'Email', value: user.email },
          { key: 'Role', value: roleBadge },
          { key: 'Member Since', value: memberSince },
          { key: 'Last Active', value: lastActive },
        ],
      }},

      // Actions
      { op: 'upsert', id: 'account-actions', type: 'buttons', data: {
        items: [
          { label: '🔑 Change Password', action: 'account-change-password', style: 'primary', context: { userId } },
        ],
      }},
    ]};
  }

  // ─── Change Password Form ─────────────────────────────

  _changePasswordForm(context) {
    const userId = context?.userId;
    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'account-error', type: 'alert', data: {
        title: 'Error', message: 'No user context available.', severity: 'error',
      }}]};
    }

    return { ops: [
      { op: 'clear' },

      { op: 'upsert', id: 'account-pw-form', type: 'form', data: {
        id: 'account-pw-form',
        title: '🔑 Change Password',
        fields: [
          { name: 'currentPassword', type: 'password', label: 'Current Password', required: true },
          { name: 'newPassword', type: 'password', label: 'New Password', placeholder: 'Min 8 characters', required: true },
          { name: 'confirmPassword', type: 'password', label: 'Confirm Password', required: true },
          { name: 'userId', type: 'hidden', value: userId },
        ],
        actions: [
          { label: '← Back', action: 'account-profile', style: 'ghost', context: { userId } },
          { label: '🔒 Save Password', action: 'account-save-password', style: 'primary' },
        ],
      }},
    ]};
  }

  // ─── Save Password ────────────────────────────────────

  async _savePassword(context) {
    const { currentPassword, newPassword, confirmPassword, userId } = context || {};

    // Validate userId
    if (!userId) {
      return { ops: [{ op: 'upsert', id: 'account-error', type: 'alert', data: {
        title: 'Error', message: 'No user context available.', severity: 'error',
      }}]};
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ops: [{ op: 'upsert', id: 'account-error', type: 'alert', data: {
        title: 'Not Found', message: 'User account not found.', severity: 'error',
      }}]};
    }

    // Validate all fields present
    if (!currentPassword || !newPassword || !confirmPassword) {
      return { ops: [{ op: 'upsert', id: 'account-pw-error', type: 'alert', data: {
        title: 'Missing Fields', message: 'Please fill in all password fields.', severity: 'warning',
      }}]};
    }

    // Validate passwords match
    if (newPassword !== confirmPassword) {
      return { ops: [{ op: 'upsert', id: 'account-pw-error', type: 'alert', data: {
        title: 'Mismatch', message: 'New passwords do not match. Please re-type carefully.', severity: 'warning',
      }}]};
    }

    // Validate minimum length
    if (newPassword.length < 8) {
      return { ops: [{ op: 'upsert', id: 'account-pw-error', type: 'alert', data: {
        title: 'Too Short', message: 'New password must be at least 8 characters.', severity: 'warning',
      }}]};
    }

    // Verify current password
    try {
      const { verifyPassword, hashPassword } = require('./../../lib/auth/password');

      if (!user.passwordHash) {
        return { ops: [{ op: 'upsert', id: 'account-pw-error', type: 'alert', data: {
          title: 'Error', message: 'No password is set on this account. Contact an admin.', severity: 'error',
        }}]};
      }

      const valid = await verifyPassword(user.passwordHash, currentPassword);
      if (!valid) {
        return { ops: [{ op: 'upsert', id: 'account-pw-error', type: 'alert', data: {
          title: 'Incorrect', message: 'Current password is incorrect.', severity: 'error',
        }}]};
      }

      // Hash new password and save
      const passwordHash = await hashPassword(newPassword);
      this.userStore.updateUser(userId, { passwordHash });

      console.log(`[AccountWidget] Password changed for: ${user.email}`);

      // Return profile with success alert
      const result = this._profile({ userId });
      result.ops.splice(1, 0, { op: 'upsert', id: 'account-pw-success', type: 'alert', data: {
        title: 'Password Changed',
        message: 'Your password has been updated successfully.',
        severity: 'success',
      }});
      return result;
    } catch (err) {
      console.error('[AccountWidget] Password change error:', err);
      return { ops: [{ op: 'upsert', id: 'account-error', type: 'alert', data: {
        title: 'Error', message: err.message || 'Failed to change password.', severity: 'error',
      }}]};
    }
  }
}

module.exports = AccountWidget;
