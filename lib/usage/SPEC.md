# Usage System — Shared Interface Specification
# All modules in lib/usage/ MUST conform to these interfaces.
# Written in JSDoc-typed CommonJS (require/module.exports). NO TypeScript.

## JSONL Entry Structure (from OpenClaw gateway)
```
// Each line in a .jsonl session file:
{
  "type": "message",
  "id": "abc123",
  "parentId": "def456",
  "timestamp": "2026-02-23T07:18:45.183Z",  // ISO string
  "message": {
    "role": "assistant",
    "content": [...],
    "api": "anthropic-messages",
    "provider": "anthropic",        // "anthropic" | "google" | "openai" | "google-ai" | "google-gemini-cli"
    "model": "claude-opus-4-6",     // full model ID
    "usage": {
      "input": 3,                   // input tokens (non-cache)
      "output": 141,                // output tokens
      "cacheRead": 17645,           // cache read tokens (billed at reduced rate)
      "cacheWrite": 0,              // cache write tokens (billed at higher rate)
      "totalTokens": 17789,         // gateway's total (input+output+cacheRead+cacheWrite)
      "cost": {
        "input": 0.000015,
        "output": 0.00352,
        "cacheRead": 0.008822,
        "cacheWrite": 0,
        "total": 0.01235            // total cost in USD
      }
    },
    "stopReason": "toolUse",
    "timestamp": 1771573144940      // unix ms (may differ from outer timestamp)
  }
}
```

## Shared Data Types (types.js exports)

```javascript
/** @typedef {Object} UsageBucket
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} totalTokens        - input + output + cacheRead + cacheWrite
 * @property {number} cost               - total USD
 * @property {number} messages           - message count
 * @property {Object<string, ModelBucket>} byModel
 * @property {Object<string, ProviderBucket>} byProvider
 * @property {Object<string, number>} toolUsage     - toolName → call count
 * @property {Object<string, number>} hourlyActivity - "HH" → message count
 * @property {number} errorCount
 */

/** @typedef {Object} ModelBucket
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cost
 * @property {number} messages
 */

/** @typedef {Object} ProviderBucket
 * @property {number} cost
 * @property {number} messages
 * @property {string[]} models
 */

/** @typedef {Object} Bookmark
 * @property {string} file       - JSONL filename
 * @property {number} byteOffset - last read byte position
 * @property {number} lineNumber - last processed line number
 */

/** @typedef {Object} UserAggregate
 * @property {UsageBucket} cumulative                    - all-time totals
 * @property {Object<string, UsageBucket>} daily         - "YYYY-MM-DD" → bucket (LOCAL dates)
 * @property {Array<{hour: string, count: number}>} recentHours  - last 2h for rate limiting
 * @property {Object<string, Bookmark>} bookmarks        - sessionId → bookmark
 */

/** @typedef {Object} UsageAggregate
 * @property {number} version                            - schema version (1)
 * @property {string} lastUpdated                        - ISO timestamp
 * @property {string} timezone                           - e.g. "Europe/Berlin"
 * @property {Object<string, UserAggregate>} users       - userId → aggregate
 */
```

## Module Interfaces

### timezone-helper.js
```javascript
class TimezoneHelper {
  constructor(timezone = 'Europe/Berlin') {}
  toLocalDateString(timestamp) {}     // number|string → "YYYY-MM-DD" in local TZ
  today() {}                          // → "YYYY-MM-DD" local
  isToday(timestamp) {}               // → boolean
  currentHourKey() {}                 // → "HH" string (00-23 local)
  toLocalHourString(timestamp) {}     // → "HH" for given timestamp
}
module.exports = { TimezoneHelper };
```

### jsonl-tailer.js
```javascript
class JsonlTailer {
  /**
   * Read only NEW lines from a JSONL file since bookmark.
   * Uses createReadStream with start=byteOffset for efficiency.
   * Pre-filters: only parse lines containing '"usage"'.
   * @param {string} filePath
   * @param {Bookmark|null} bookmark
   * @returns {Promise<{entries: ParsedEntry[], newBookmark: Bookmark}>}
   */
  async tail(filePath, bookmark) {}
}

/** @typedef {Object} ParsedEntry
 * @property {string} timestamp     - ISO string from entry
 * @property {number} input         - input tokens
 * @property {number} output        - output tokens
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} cost          - usage.cost.total
 * @property {string} model
 * @property {string} provider
 * @property {string} stopReason
 * @property {string[]} toolNames   - extracted from content[].toolCall.name
 * @property {boolean} isError      - stopReason === 'error' or has errorMessage
 */
module.exports = { JsonlTailer };
```

### usage-store.js
```javascript
class UsageStore {
  constructor(dataDir) {}             // dataDir = .scratchy-data/usage/
  async load() {}                     // → UsageAggregate (from file or empty default)
  async save(aggregate) {}            // atomic tmp+rename write
  getCached() {}                      // synchronous, returns in-memory copy
  invalidateCache() {}                // force next load() to read from disk
}
module.exports = { UsageStore };
```

### usage-query.js
```javascript
class UsageQuery {
  constructor(store, timezoneHelper) {}
  getTodayUsage(userId) {}            // → UsageBucket
  getCumulativeUsage(userId) {}       // → UsageBucket
  getDailyUsage(userId, dateStr) {}   // → UsageBucket for specific date
  getDateRange(userId, fromDate, toDate) {} // → UsageBucket[] for date range
  getMessagesToday(userId) {}         // → number (for quota enforcement)
  getTokensToday(userId) {}           // → number (for quota enforcement)
  getMessagesThisHour(userId) {}      // → number (for hourly rate limiting)
  getCostToday(userId) {}             // → number
  getAllUsers() {}                    // → [{userId, today: UsageBucket, cumulative: UsageBucket}]
  getProviderBreakdown() {}           // → aggregated across all users
}
module.exports = { UsageQuery };
```

### usage-aggregator.js
```javascript
const { EventEmitter } = require('events');

class UsageAggregator extends EventEmitter {
  constructor({ timezone, sessionsDir, dataDir }) {}
  async initialize() {}              // First run: full scan if no aggregate exists
  async update() {}                  // Incremental: tail new entries only
  startWatching() {}                 // fs.watch on sessionsDir, debounced 2s → update()
  stopWatching() {}
  getQuery() {}                      // → UsageQuery instance
  // Emits: 'updated' after each successful update
}
module.exports = { UsageAggregator };
```

### analytics-snapshots.js
```javascript
class AnalyticsSnapshots {
  constructor({ dataDir, timezoneHelper }) {}
  async saveDailySnapshot(date, usageQuery) {}   // Save daily analytics for given date
  async generateWeeklyRollup(weekStr) {}          // "2026-W08" — aggregate 7 daily files
  async generateMonthlyRollup(monthStr) {}        // "2026-02" — aggregate daily files
  async pruneOldSnapshots(retainDays) {}           // Delete daily files older than N days
  async getDailySnapshot(date) {}                  // Load specific daily snapshot
  async getWeeklySnapshot(weekStr) {}
  async getMonthlySnapshot(monthStr) {}
  async getCostTrend(days) {}                      // Last N days cost per day
  async getAnomalies(userId) {}                    // Check if today > 3x 7-day avg
}
module.exports = { AnalyticsSnapshots };
```

## Sessions Directory
Path: `~/.openclaw/agents/main/sessions/`
- `sessions.json` — maps session keys to session objects
- `{sessionId}.jsonl` — session transcript files
- Exclude: `*.deleted.*`, `*.security-backup-*`, `*.tmp*`

## Session Key Patterns (match ALL, not just webchat)
```
agent:main:main                          → admin user
agent:main:webchat:{userId}              → webchat user
main:webchat:{userId}                    → webchat user (alt format)
agent:main:discord:{userId}              → discord user
agent:main:telegram:{userId}             → telegram user
agent:main:subagent:{id}                 → sub-agent (attribute to spawning user if possible)
agent:main:cron:{id}                     → cron job (attribute to _system)
```

## Constraints
- **CommonJS** (require/module.exports) — NOT ESM
- **Node.js 22** — can use modern APIs (fs.promises, for-await, etc.)
- **No external dependencies** — only Node.js built-ins (fs, path, crypto, events, readline, stream)
- **All async I/O** — never use readFileSync except in getCached() cold start
- **Atomic writes** — always tmp+rename pattern
- **Error resilient** — malformed JSONL lines, missing files, corrupt JSON → log and skip, never crash
- Validate with `node -c` before considering done
