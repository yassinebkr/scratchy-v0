'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  rawEventsDays: 90,
  hourlyRollupDays: 90,
  dailyRollupDays: 365
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

class RetentionManager {
  /**
   * @param {string} dataDir - Root analytics data directory
   * @param {{ rawEventsDays?: number, hourlyRollupDays?: number, dailyRollupDays?: number }} [config]
   */
  constructor(dataDir, config) {
    this.dataDir = dataDir;
    this.config = { ...DEFAULTS, ...config };
  }

  /**
   * Run all retention policies and delete expired data.
   * @returns {{ deleted: { events: number, hourlyRollups: number, dailyRollups: number }, freedBytes: number }}
   */
  cleanup() {
    const events = this._cleanDirectory(
      path.join('events'),
      this.config.rawEventsDays,
      true
    );
    const hourly = this._cleanDirectory(
      path.join('rollups', 'hourly'),
      this.config.hourlyRollupDays,
      false
    );
    const daily = this._cleanDirectory(
      path.join('rollups', 'daily'),
      this.config.dailyRollupDays,
      false
    );

    return {
      deleted: {
        events: events.deletedCount,
        hourlyRollups: hourly.deletedCount,
        dailyRollups: daily.deletedCount
      },
      freedBytes: events.freedBytes + hourly.freedBytes + daily.freedBytes
    };
  }

  /**
   * Calculate disk usage across all analytics subdirectories.
   * @returns {{ events: { count: number, bytes: number }, hourlyRollups: { count: number, bytes: number }, dailyRollups: { count: number, bytes: number }, profiles: { count: number, bytes: number }, total: number }}
   */
  getDiskUsage() {
    const events = this._countDir(path.join(this.dataDir, 'events'));
    const hourlyRollups = this._countDir(path.join(this.dataDir, 'rollups', 'hourly'));
    const dailyRollups = this._countDir(path.join(this.dataDir, 'rollups', 'daily'));
    const profiles = this._countDir(path.join(this.dataDir, 'profiles'));

    return {
      events,
      hourlyRollups,
      dailyRollups,
      profiles,
      total: events.bytes + hourlyRollups.bytes + dailyRollups.bytes + profiles.bytes
    };
  }

  /**
   * Get the oldest event date directory name.
   * @returns {string | null}
   */
  getOldestDate() {
    const eventsDir = path.join(this.dataDir, 'events');
    if (!fs.existsSync(eventsDir)) return null;

    const dates = fs.readdirSync(eventsDir)
      .filter(name => DATE_RE.test(name))
      .sort();

    return dates.length > 0 ? dates[0] : null;
  }

  /**
   * Get the current retention configuration.
   * @returns {{ rawEventsDays: number, hourlyRollupDays: number, dailyRollupDays: number }}
   */
  getRetentionConfig() {
    return { ...this.config };
  }

  /**
   * Update retention thresholds.
   * @param {{ rawEventsDays?: number, hourlyRollupDays?: number, dailyRollupDays?: number }} config
   */
  setRetentionConfig(config) {
    Object.assign(this.config, config);
  }

  /**
   * Generic cleaner for a subdirectory.
   * @param {string} subdir - Relative path from dataDir
   * @param {number} maxAgeDays - Maximum age in days
   * @param {boolean} isDateDir - true = match directory names; false = match file name prefixes
   * @returns {{ deletedCount: number, freedBytes: number }}
   */
  _cleanDirectory(subdir, maxAgeDays, isDateDir) {
    const fullDir = path.join(this.dataDir, subdir);
    if (!fs.existsSync(fullDir)) return { deletedCount: 0, freedBytes: 0 };

    let deletedCount = 0;
    let freedBytes = 0;
    const entries = fs.readdirSync(fullDir);

    for (const entry of entries) {
      const entryPath = path.join(fullDir, entry);

      if (isDateDir) {
        if (!DATE_RE.test(entry)) continue;
        if (!this._isOlderThan(entry, maxAgeDays)) continue;

        const size = this._dirSize(entryPath);
        fs.rmSync(entryPath, { recursive: true, force: true });
        deletedCount++;
        freedBytes += size;

        const label = this._formatBytes(size);
        console.log(`[RetentionManager] Deleted ${subdir}/${entry}/ (${label})`);
      } else {
        const match = entry.match(DATE_PREFIX_RE);
        if (!match) continue;
        if (!this._isOlderThan(match[1], maxAgeDays)) continue;

        const stat = fs.statSync(entryPath);
        const size = stat.size;
        fs.rmSync(entryPath, { force: true });
        deletedCount++;
        freedBytes += size;

        const label = this._formatBytes(size);
        console.log(`[RetentionManager] Deleted ${subdir}/${entry} (${label})`);
      }
    }

    return { deletedCount, freedBytes };
  }

  /**
   * Check if a date string is older than maxAgeDays from now.
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @param {number} maxAgeDays
   * @returns {boolean}
   */
  _isOlderThan(dateStr, maxAgeDays) {
    const date = new Date(dateStr + 'T00:00:00Z');
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - maxAgeDays);
    cutoff.setUTCHours(0, 0, 0, 0);
    return date < cutoff;
  }

  /**
   * Recursively calculate total size of a directory in bytes.
   * @param {string} dirPath
   * @returns {number}
   */
  _dirSize(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;

    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += this._dirSize(fullPath);
      } else {
        total += fs.statSync(fullPath).size;
      }
    }

    return total;
  }

  /**
   * Count files and total bytes in a directory (recursive).
   * @param {string} dirPath
   * @returns {{ count: number, bytes: number }}
   */
  _countDir(dirPath) {
    if (!fs.existsSync(dirPath)) return { count: 0, bytes: 0 };

    let count = 0;
    let bytes = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = this._countDir(fullPath);
        count += sub.count;
        bytes += sub.bytes;
      } else {
        count++;
        bytes += fs.statSync(fullPath).size;
      }
    }

    return { count, bytes };
  }

  /**
   * Format bytes into a human-readable string.
   * @param {number} bytes
   * @returns {string}
   */
  _formatBytes(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

module.exports = { RetentionManager };
