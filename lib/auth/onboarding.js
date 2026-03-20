/**
 * Onboarding Detection & Routing — Phase 19F
 *
 * Manages onboarding state for new users. Determines whether a user
 * needs to go through the onboarding wizard and tracks their progress.
 *
 * WORKAROUND: user-store.js updateUser() only allows a fixed set of fields.
 * Until "onboardingComplete" and "preferences" are added to that allowlist,
 * we write directly to userStore._users and call userStore._save().
 * TODO: Add onboardingComplete + preferences to UserStore.updateUser allowed list,
 *       then replace the direct _users/_save calls here.
 */

const fs = require("fs");
const path = require("path");

const scratchyRoot = path.join(__dirname, "..", "..");

/**
 * Check if a user has completed onboarding.
 *
 * Admin users and legacy users are always considered onboarded.
 *
 * @param {object} userStore - UserStore instance
 * @param {string} userId - User ID
 * @returns {boolean}
 */
function isOnboardingComplete(userStore, userId) {
  const user = userStore.getById(userId);
  if (!user) return false;

  // Admin users skip onboarding automatically
  if (user.role === "admin") return true;

  // Legacy users (migrated from before onboarding existed) skip
  if (user.isLegacy === true) return true;

  return user.onboardingComplete === true;
}

/**
 * Mark a user's onboarding as complete and store their preferences.
 *
 * WORKAROUND: Writes directly to userStore._users and calls _save()
 * because updateUser() doesn't allow onboardingComplete/preferences fields.
 * See module header for cleanup notes.
 *
 * @param {object} userStore - UserStore instance
 * @param {string} userId - User ID
 * @param {object} preferences - User preferences (displayName, theme, etc.)
 */
function markOnboardingComplete(userStore, userId, preferences) {
  const user = userStore._users.get(userId);
  if (!user) throw new Error("User not found");

  user.onboardingComplete = true;
  user.preferences = preferences || {};
  userStore._save();
}

/**
 * Get the current onboarding state/progress for a user.
 *
 * Checks external session files to determine which integrations
 * are already connected.
 *
 * @param {object} userStore - UserStore instance
 * @param {string} userId - User ID
 * @returns {object} Onboarding state
 */
function getOnboardingState(userStore, userId) {
  const user = userStore.getById(userId);
  if (!user) {
    return {
      complete: false,
      googleConnected: false,
      notesConnected: false,
      channelsConfigured: false,
      preferences: null,
    };
  }

  const complete = isOnboardingComplete(userStore, userId);

  // Check Google Calendar connection
  let googleConnected = false;
  try {
    const gcalPath = path.join(scratchyRoot, ".gcal-session.json");
    const gcalData = JSON.parse(fs.readFileSync(gcalPath, "utf8"));
    if (gcalData && gcalData.tokens && gcalData.tokens.access_token) {
      googleConnected = true;
    }
  } catch (_) {
    // File doesn't exist or isn't valid JSON — not connected
  }

  // Check Standard Notes connection
  let notesConnected = false;
  try {
    const snPath = path.join(scratchyRoot, ".sn-session.json");
    const snData = JSON.parse(fs.readFileSync(snPath, "utf8"));
    if (snData && snData.email) {
      notesConnected = true;
    }
  } catch (_) {
    // File doesn't exist or isn't valid JSON — not connected
  }

  // Channels: always false in first phase
  const channelsConfigured = false;

  // Preferences
  const preferences = user.preferences
    ? { displayName: user.preferences.displayName || null, theme: user.preferences.theme || null }
    : null;

  return {
    complete,
    googleConnected,
    notesConnected,
    channelsConfigured,
    preferences,
  };
}

/**
 * Determine if a user should be redirected to onboarding, and which step.
 *
 * @param {object} userStore - UserStore instance
 * @param {string} userId - User ID
 * @returns {{ shouldRedirect: boolean, step?: string }}
 */
function getOnboardingRedirectInfo(userStore, userId) {
  if (isOnboardingComplete(userStore, userId)) {
    return { shouldRedirect: false };
  }

  return { shouldRedirect: true, step: "onboard-start" };
}

module.exports = {
  isOnboardingComplete,
  markOnboardingComplete,
  getOnboardingState,
  getOnboardingRedirectInfo,
};
