'use strict';
const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '..', '.scratchy-data', 'widget-state');

/**
 * Get the directory for a user's widget state files.
 * Creates the directory if it doesn't exist.
 *
 * @param {string} userId - User ID (or '_legacy' for admin/legacy users)
 * @returns {string} Path to the user's widget state directory
 */
function getUserWidgetDir(userId) {
  const safeId = (userId || '_legacy').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(BASE_DIR, safeId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Get a widget state file path for a user.
 *
 * @param {string} userId - User ID
 * @param {string} filename - State file name (e.g., 'gcal-session.json')
 * @returns {string} Full path to the state file
 */
function getWidgetStatePath(userId, filename) {
  const dir = getUserWidgetDir(userId);
  return path.join(dir, filename);
}

/**
 * Read a widget state file for a user.
 * Returns null if file doesn't exist.
 */
function readWidgetState(userId, filename) {
  const filePath = getWidgetStatePath(userId, filename);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write a widget state file for a user.
 */
function writeWidgetState(userId, filename, data) {
  const filePath = getWidgetStatePath(userId, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * ADMIN-ONLY IDs that may receive legacy credential migration.
 * All other users must authenticate through each widget independently.
 * SECURITY FIX (2026-02-26): Previously migrated admin credentials to ALL users.
 */
const ADMIN_MIGRATION_IDS = new Set(['_legacy', '_admin', 'legacy_admin']);

/**
 * Migrate a legacy root-level session file to a user's widget state directory.
 * SECURITY: Only migrates for admin/legacy users. Non-admin users get a clean slate
 * and must authenticate with their own accounts. This prevents credential leakage.
 *
 * @param {string} legacyPath - Absolute path to the old root-level file
 * @param {string} userId - User ID to migrate to
 * @param {string} filename - State file name (e.g., 'gcal-session.json')
 */
function migrateLegacyFile(legacyPath, userId, filename) {
  // SECURITY: Never copy admin credentials to non-admin users
  if (!ADMIN_MIGRATION_IDS.has(userId)) {
    return; // Non-admin users must authenticate independently
  }
  const targetPath = getWidgetStatePath(userId, filename);
  try {
    if (fs.existsSync(legacyPath) && !fs.existsSync(targetPath)) {
      const data = fs.readFileSync(legacyPath, 'utf-8');
      fs.writeFileSync(targetPath, data, { mode: 0o600 });
      console.log(`[WidgetState] Migrated ${filename} to admin user ${userId}`);
    }
  } catch (e) {
    console.error(`[WidgetState] Migration failed for ${filename}:`, e.message);
  }
}

module.exports = { getUserWidgetDir, getWidgetStatePath, readWidgetState, writeWidgetState, migrateLegacyFile };
