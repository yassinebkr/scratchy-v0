'use strict';

// timezone-helper.js — Locale-aware date/time helpers for usage bucketing.
// Uses Intl.DateTimeFormat (no external deps). All outputs are in the
// configured IANA timezone (default: Europe/Berlin).

/**
 * Helper for timezone-aware date and hour formatting.
 *
 * All methods accept flexible timestamp inputs:
 *   - number  (unix milliseconds, e.g. 1740297600000)
 *   - string  (ISO 8601, e.g. "2026-02-23T07:18:45.183Z")
 *   - Date    (native Date object)
 */
class TimezoneHelper {
  /**
   * @param {string} [timezone='Europe/Berlin'] - IANA timezone identifier
   */
  constructor(timezone = 'Europe/Berlin') {
    /** @type {string} */
    this.timezone = timezone;

    // sv-SE locale produces "YYYY-MM-DD" date strings natively.
    /** @private */
    this._dateFmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    // Hour formatter — returns "HH" (24h, zero-padded).
    /** @private */
    this._hourFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: normalise any accepted timestamp to a Date
  // ---------------------------------------------------------------------------

  /**
   * Coerce a flexible timestamp to a Date instance.
   * @private
   * @param {number|string|Date} ts
   * @returns {Date}
   */
  _toDate(ts) {
    if (ts instanceof Date) return ts;
    if (typeof ts === 'number') return new Date(ts);
    if (typeof ts === 'string') return new Date(ts);
    throw new TypeError(`TimezoneHelper: unsupported timestamp type "${typeof ts}"`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Format a timestamp as a local date string "YYYY-MM-DD".
   * @param {number|string|Date} timestamp
   * @returns {string} e.g. "2026-02-23"
   */
  toLocalDateString(timestamp) {
    return this._dateFmt.format(this._toDate(timestamp));
  }

  /**
   * Today's local date string.
   * @returns {string} e.g. "2026-02-23"
   */
  today() {
    return this._dateFmt.format(new Date());
  }

  /**
   * Check whether a timestamp falls on today (local timezone).
   * @param {number|string|Date} timestamp
   * @returns {boolean}
   */
  isToday(timestamp) {
    return this.toLocalDateString(timestamp) === this.today();
  }

  /**
   * Current local hour as a zero-padded "HH" string (00–23).
   * @returns {string} e.g. "14"
   */
  currentHourKey() {
    return this._formatHour(new Date());
  }

  /**
   * Local hour for a given timestamp as a zero-padded "HH" string.
   * @param {number|string|Date} timestamp
   * @returns {string} e.g. "07"
   */
  toLocalHourString(timestamp) {
    return this._formatHour(this._toDate(timestamp));
  }

  /**
   * Format a timestamp as "YYYY-MM-DD HH" in the local timezone.
   * Useful for hourly bucketing across days.
   * @param {number|string|Date} timestamp
   * @returns {string} e.g. "2026-02-23 14"
   */
  toLocalISOHour(timestamp) {
    const d = this._toDate(timestamp);
    return `${this._dateFmt.format(d)} ${this._formatHour(d)}`;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract the zero-padded hour from a Date via Intl formatter.
   * @private
   * @param {Date} date
   * @returns {string} "HH"
   */
  _formatHour(date) {
    // en-GB hour2digit returns "HH" but may include surrounding whitespace
    // or invisible characters on some engines; trim to be safe.
    const raw = this._hourFmt.format(date);
    // Extract exactly two digits
    const match = raw.match(/\d{2}/);
    return match ? match[0] : '00';
  }
}

module.exports = { TimezoneHelper };

// =============================================================================
// Unit-test examples (Berlin = Europe/Berlin, UTC+1 in winter / UTC+2 in summer)
// =============================================================================
//
// const tz = new TimezoneHelper('Europe/Berlin');
//
// --- toLocalDateString ---
// tz.toLocalDateString(1740297600000)
//   → "2025-02-23"  (2025-02-23T08:00:00Z → 09:00 Berlin, winter = UTC+1)
//
// tz.toLocalDateString("2026-02-23T23:30:00Z")
//   → "2026-02-24"  (23:30 UTC → 00:30 next day in Berlin, winter UTC+1)
//
// tz.toLocalDateString(new Date("2026-07-15T22:00:00Z"))
//   → "2026-07-16"  (22:00 UTC → 00:00 next day in Berlin, summer UTC+2)
//
// --- toLocalHourString ---
// tz.toLocalHourString("2026-02-23T07:18:45.183Z")
//   → "08"  (07:18 UTC → 08:18 Berlin winter)
//
// tz.toLocalHourString(1740297600000)
//   → "09"  (2025-02-23T08:00:00Z → 09:00 Berlin winter)
//
// --- toLocalISOHour ---
// tz.toLocalISOHour("2026-02-23T07:18:45.183Z")
//   → "2026-02-23 08"
//
// tz.toLocalISOHour(new Date("2026-07-15T22:00:00Z"))
//   → "2026-07-16 00"
//
// --- currentHourKey ---
// (At 14:37 Berlin time) tz.currentHourKey() → "14"
//
// --- isToday ---
// (On 2026-02-23 Berlin) tz.isToday("2026-02-23T10:00:00Z") → true
// (On 2026-02-23 Berlin) tz.isToday("2026-02-22T10:00:00Z") → false
