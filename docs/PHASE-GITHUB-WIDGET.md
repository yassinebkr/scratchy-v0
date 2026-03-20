# Phase: GitHub Widget — Repo Dashboard, Issues, PRs & Activity

## Overview

Add a **GitHub Widget** to Scratchy — a fully autonomous, server-side widget that surfaces repository dashboards, issues, pull requests, notifications, and commit activity directly in the canvas. Like the Standard Notes and Email widgets, it runs entirely within `serve.js`, handles all `gh-*` actions locally, and never forwards GitHub operations to the agent.

**What users get:**
- Repository dashboard with stats, language breakdown, and recent activity
- Issue & PR lists with filters (open/closed, labels, assignees, milestones)
- Issue/PR detail views with comments, reviews, and status checks
- Notification inbox with read/unread management
- Commit activity graph (contribution heatmap + per-repo timeline)
- Quick actions: create issues, review PRs, merge, comment

## Current State

```
Browser → Scratchy Canvas → Agent → (no GitHub integration)
```

- No GitHub integration exists
- Users must switch to github.com or use CLI for all Git operations
- Agent has no awareness of repo state, issues, or PRs

## Target Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           Scratchy Server (serve.js)     │
                    │                                          │
Browser ──────────► │  /api/github/*  ← REST endpoints        │
  gh-* actions      │  ├── GitHubWidget class                  │
  via canvas        │  │   ├── auth (OAuth / PAT)              │
                    │  │   ├── repos, issues, PRs, notifs      │
                    │  │   ├── commit log & activity           │
                    │  │   └── cache layer (in-memory + disk)  │
                    │  │                                        │
                    │  │  GitHub API (REST v3 + GraphQL v4)     │
                    │  │  ├── Octokit client                   │
                    │  │  ├── Rate-limit aware                 │
                    │  │  ├── Pagination (cursor + page)       │
                    │  │  └── Conditional requests (ETags)     │
                    │  │                                        │
                    │  └── Session persistence                 │
                    │      └── .scratchy-data/github/          │
                    └──────────────────────────────────────────┘
```

## Auth Strategy

### Option A: Personal Access Token (PAT) — Phase 1
- User provides a GitHub PAT (classic or fine-grained) via a login form
- Token stored server-side, encrypted at rest (AES-256-GCM)
- Simplest path — no OAuth app registration required
- Fine-grained PATs allow minimal scopes (e.g., `repo`, `notifications`, `read:org`)

### Option B: GitHub OAuth App — Phase 2
- Register a GitHub OAuth App (or GitHub App)
- Full OAuth 2.0 flow: `/api/github/auth/start` → GitHub → `/api/github/auth/callback`
- Refresh tokens for long-lived sessions
- Better UX (no manual token copy-paste) and revocable per-app

### Token Storage

```
.scratchy-data/
  github/
    tokens.json.enc       ← AES-256-GCM encrypted token store
    cache/
      repos.json          ← cached API responses (TTL-based)
      issues/
        {owner}_{repo}.json
      notifications.json
    sessions/
      {sessionId}.json    ← per-user GitHub session state
```

**Encryption:**
- Derive key from `SCRATCHY_GITHUB_ENCRYPTION_KEY` env var or reuse Scratchy's master encryption key
- Each token entry: `{ userId, token, scopes, createdAt, expiresAt, iv, tag }`
- Tokens never logged, never sent to client, never forwarded to agent

### Data Model

```json
{
  "sessionId": "gh_abc123",
  "userId": "usr_xyz",
  "tokenRef": "enc:aes256gcm:...",
  "scopes": ["repo", "notifications", "read:org"],
  "githubUser": {
    "login": "octocat",
    "id": 1,
    "avatarUrl": "https://...",
    "name": "The Octocat"
  },
  "preferences": {
    "defaultOrg": null,
    "pinnedRepos": ["owner/repo1", "owner/repo2"],
    "notificationFilter": "participating",
    "activityDays": 30
  },
  "createdAt": "2026-02-22T08:00:00Z",
  "lastUsedAt": "2026-02-22T08:00:00Z"
}
```

## Component Design

Each view maps to Scratchy canvas components. The widget renders `scratchy-canvas` ops server-side and pushes them to the client.

### Component Mapping

| View | Components Used | Notes |
|------|----------------|-------|
| Repo List | `table`, `stats`, `tags` | Table of repos with stars/forks/language tags |
| Repo Detail | `kv`, `stats`, `chart-bar`, `tags`, `timeline` | Key-value metadata + language chart + recent commits |
| Issue List | `table`, `tags`, `stats` | Filterable table with label tags, open/closed counts |
| Issue Detail | `card`, `kv`, `timeline`, `tags`, `checklist`, `buttons` | Issue body as card, comments as timeline, task lists as checklist |
| PR List | `table`, `tags`, `stats` | Like issues but with review status and CI checks |
| PR Detail | `card`, `kv`, `timeline`, `tags`, `checklist`, `buttons` | PR body, review timeline, file checklist, merge button |
| Notifications | `timeline`, `stats`, `buttons` | Notification feed with mark-read actions |
| Activity Graph | `chart-bar`, `sparkline`, `stats` | Commit frequency bar chart + contribution sparklines |
| Auth/Login | `form`, `alert` | PAT input form or OAuth initiation |

### Component ID Convention

All GitHub widget component IDs use the `gh-` prefix:

```
gh-repos-table        — repository list table
gh-repos-stats        — repo count stats
gh-repo-detail-kv     — repo detail key-value pairs
gh-repo-langs         — language breakdown chart
gh-issues-table       — issue list table
gh-issues-stats       — open/closed issue counts
gh-issue-detail       — issue body card
gh-issue-comments     — comment timeline
gh-issue-labels       — label tags
gh-prs-table          — PR list table
gh-prs-stats          — open/closed/merged PR counts
gh-pr-detail          — PR body card
gh-pr-reviews         — review timeline
gh-pr-checks          — CI check checklist
gh-notifs-timeline    — notification feed
gh-notifs-stats       — unread count stats
gh-activity-chart     — commit activity bar chart
gh-activity-spark     — contribution sparklines
gh-auth-form          — authentication form
gh-auth-alert         — auth status alert
gh-nav                — navigation buttons (back, refresh, filters)
```

## Actions — Widget-Action Protocol

All actions use the `gh-` prefix and are handled entirely within `serve.js`. They are **never** forwarded to the OpenClaw agent.

### Action Catalog

| Action | Method | Description | Parameters |
|--------|--------|-------------|------------|
| `gh-auth` | POST | Authenticate with PAT or initiate OAuth | `{ token }` or `{ method: "oauth" }` |
| `gh-logout` | POST | Clear GitHub session | `{}` |
| `gh-status` | GET | Auth status + rate limit info | — |
| `gh-repos` | GET | List repositories | `?sort=updated&type=owner&per_page=30&page=1` |
| `gh-repo-detail` | GET | Single repo detail | `?repo=owner/name` |
| `gh-issues` | GET | List issues for a repo | `?repo=owner/name&state=open&labels=bug&page=1` |
| `gh-issue-detail` | GET | Single issue with comments | `?repo=owner/name&number=42` |
| `gh-create-issue` | POST | Create a new issue | `{ repo, title, body, labels, assignees, milestone }` |
| `gh-update-issue` | PATCH | Update issue (close, reopen, edit) | `{ repo, number, state, title, body, labels }` |
| `gh-comment-issue` | POST | Add comment to issue | `{ repo, number, body }` |
| `gh-prs` | GET | List pull requests | `?repo=owner/name&state=open&page=1` |
| `gh-pr-detail` | GET | Single PR with reviews + checks | `?repo=owner/name&number=99` |
| `gh-review-pr` | POST | Submit PR review | `{ repo, number, event, body }` |
| `gh-merge-pr` | POST | Merge a pull request | `{ repo, number, method, commitTitle }` |
| `gh-comment-pr` | POST | Add comment to PR | `{ repo, number, body }` |
| `gh-notifications` | GET | List notifications | `?all=false&participating=true&page=1` |
| `gh-mark-read` | POST | Mark notification(s) as read | `{ threadId }` or `{ all: true }` |
| `gh-commit-log` | GET | Commit history for a repo | `?repo=owner/name&sha=main&per_page=30` |
| `gh-activity` | GET | Contribution activity stats | `?repo=owner/name&days=30` |
| `gh-search` | GET | Search repos, issues, or code | `?q=query&type=repositories` |

### Action Flow (Client → Server)

```
1. User clicks button/submits form in canvas
2. Client sends: { type: "widget-action", action: "gh-issues", params: { repo: "owner/repo" } }
3. serve.js intercepts (gh-* prefix match)
4. GitHubWidget.handleAction("gh-issues", params, sessionId)
5. Widget calls GitHub API via Octokit
6. Widget builds scratchy-canvas ops from API response
7. serve.js broadcasts ops to client
8. Canvas renders updated components
```

### Action Response Format

All actions return a standard envelope:

```json
{
  "success": true,
  "action": "gh-issues",
  "data": { ... },
  "ops": [
    { "op": "upsert", "id": "gh-issues-table", "type": "table", "data": { ... } },
    { "op": "upsert", "id": "gh-issues-stats", "type": "stats", "data": { ... } }
  ],
  "meta": {
    "rateLimit": { "remaining": 4832, "limit": 5000, "reset": 1740000000 },
    "pagination": { "page": 1, "totalPages": 5, "hasNext": true },
    "cached": false,
    "timestamp": 1740000000
  }
}
```

## Views

### 1. Auth View (Initial State)

Shown when no GitHub token is configured for the session.

```
┌─────────────────────────────────────────────┐
│  🐙 Connect to GitHub                      │
│                                              │
│  [form: gh-auth-form]                       │
│  Personal Access Token: [________________]  │
│  Scopes needed: repo, notifications         │
│  [        Connect        ]                  │
│                                              │
│  [alert: info]                              │
│  Generate a token at github.com/settings/   │
│  tokens with 'repo' and 'notifications'     │
│  scopes.                                     │
└─────────────────────────────────────────────┘
```

### 2. Repo List (Default Dashboard)

After auth, the landing view. Shows the user's repositories.

```
┌──────────────────────────────────────────────────────┐
│  [stats: gh-repos-stats]                             │
│  Repos: 47  |  Stars: 1.2k  |  Forks: 340          │
│                                                      │
│  [buttons: gh-nav]                                   │
│  [My Repos] [Starred] [Orgs] [🔔 Notifications (3)]│
│                                                      │
│  [table: gh-repos-table]                             │
│  ┌──────────────┬────────┬───────┬──────┬──────────┐│
│  │ Repository   │ ⭐     │ 🍴   │ Lang │ Updated  ││
│  ├──────────────┼────────┼───────┼──────┼──────────┤│
│  │ my-app       │ 234    │ 45    │ TS   │ 2h ago   ││
│  │ dotfiles     │ 12     │ 3     │ Bash │ 1d ago   ││
│  │ lib-core     │ 89     │ 22    │ Rust │ 3d ago   ││
│  └──────────────┴────────┴───────┴──────┴──────────┘│
│                                                      │
│  [buttons: gh-page-nav]                              │
│  [← Prev] [Page 1 of 3] [Next →]                   │
└──────────────────────────────────────────────────────┘
```

### 3. Repo Detail

Drill-down into a single repository.

```
┌──────────────────────────────────────────────────────┐
│  [buttons: gh-nav] [← Back to Repos] [⟳ Refresh]   │
│                                                      │
│  [kv: gh-repo-detail-kv]                            │
│  Name:        owner/my-app                          │
│  Description: A cool application                    │
│  Visibility:  Public                                │
│  Default:     main                                  │
│  Created:     2024-06-15                            │
│  License:     MIT                                   │
│                                                      │
│  [stats: gh-repo-stats]                             │
│  ⭐ 234  |  🍴 45  |  👁 18  |  Issues: 12 open   │
│                                                      │
│  [chart-bar: gh-repo-langs]                         │
│  TypeScript ████████████ 68%                        │
│  JavaScript ████ 20%                                │
│  CSS        ██ 10%                                  │
│  Other      █ 2%                                    │
│                                                      │
│  [timeline: gh-repo-commits]                        │
│  Recent Commits:                                    │
│  ● fix: resolve auth race condition    — 2h ago     │
│  ● feat: add dark mode toggle          — 5h ago     │
│  ● chore: update dependencies          — 1d ago     │
│                                                      │
│  [buttons: gh-repo-actions]                         │
│  [📋 Issues (12)] [🔀 PRs (3)] [📊 Activity]      │
└──────────────────────────────────────────────────────┘
```

### 4. Issue List

```
┌──────────────────────────────────────────────────────┐
│  [buttons: gh-nav] [← Back] [+ New Issue]           │
│                                                      │
│  [stats: gh-issues-stats]                            │
│  Open: 12  |  Closed: 148  |  This week: 3         │
│                                                      │
│  [chips: gh-issues-filter]                           │
│  [Open ✓] [Closed] [All] | [bug] [enhancement]     │
│                                                      │
│  [table: gh-issues-table]                            │
│  ┌────┬───────────────────┬────────┬───────┬───────┐│
│  │ #  │ Title             │ Labels │ By    │ Age   ││
│  ├────┼───────────────────┼────────┼───────┼───────┤│
│  │ 42 │ Login fails on .. │ 🔴bug │ alice │ 2d    ││
│  │ 41 │ Add export feat.. │ 🟢enh │ bob   │ 3d    ││
│  │ 39 │ Docs: update AP.. │ 📝doc │ carol │ 1w    ││
│  └────┴───────────────────┴────────┴───────┴───────┘│
└──────────────────────────────────────────────────────┘
```

### 5. Issue Detail

```
┌──────────────────────────────────────────────────────┐
│  [buttons: gh-nav] [← Back to Issues] [⟳ Refresh]  │
│                                                      │
│  [card: gh-issue-detail]                             │
│  #42 — Login fails on Safari                        │
│  Opened by alice · 2 days ago                       │
│  ─────────────────────────────                      │
│  When I try to log in on Safari 17.2, the page      │
│  shows a blank screen after submitting credentials.  │
│  Steps to reproduce: ...                            │
│                                                      │
│  [tags: gh-issue-labels]                             │
│  [🔴 bug] [🟡 P2] [📱 browser]                     │
│                                                      │
│  [kv: gh-issue-meta]                                │
│  Assignee:   @dave                                  │
│  Milestone:  v2.1                                   │
│  Linked PR:  #44                                    │
│                                                      │
│  [checklist: gh-issue-tasks]                         │
│  ☑ Reproduce on Safari 17.2                        │
│  ☐ Check WebKit bug tracker                         │
│  ☐ Write regression test                            │
│                                                      │
│  [timeline: gh-issue-comments]                       │
│  ● dave (1d ago): I can reproduce this on...        │
│  ● alice (12h ago): Also happening on iOS Safari    │
│  ● bot (6h ago): Linked to PR #44                   │
│                                                      │
│  [form-strip: gh-issue-comment-form]                │
│  Add comment: [________________________] [Send]     │
│                                                      │
│  [buttons: gh-issue-actions]                         │
│  [Close Issue] [Edit] [Lock]                        │
└──────────────────────────────────────────────────────┘
```

### 6. PR List & Detail

Same structure as issues with additional fields:

- **PR List:** adds columns for review status (approved/changes requested/pending), CI checks (✅/❌/🟡), merge status
- **PR Detail:** adds review timeline, file change summary (`+120 −45 across 8 files`), check status checklist, merge button with method selector (merge/squash/rebase)

### 7. Notifications

```
┌──────────────────────────────────────────────────────┐
│  [buttons: gh-nav] [← Dashboard] [Mark All Read]    │
│                                                      │
│  [stats: gh-notifs-stats]                            │
│  Unread: 3  |  Total: 24  |  Participating: 8      │
│                                                      │
│  [timeline: gh-notifs-timeline]                      │
│  ● 🔵 owner/repo #42 — New comment by dave  (1h)   │
│  ● 🔵 owner/repo #99 — PR review requested  (3h)   │
│  ● 🔵 org/lib #15 — Issue assigned to you   (5h)   │
│  ● ⚪ owner/repo #38 — PR merged            (1d)   │
│  ● ⚪ org/lib #12 — Issue closed             (2d)   │
└──────────────────────────────────────────────────────┘
```

### 8. Activity Graph

```
┌──────────────────────────────────────────────────────┐
│  [buttons: gh-nav] [← Dashboard] [7d] [30d] [90d]  │
│                                                      │
│  [stats: gh-activity-stats]                          │
│  Commits (30d): 87  |  PRs merged: 12  |  Reviews: 23│
│                                                      │
│  [chart-bar: gh-activity-chart]                      │
│  Commits per week:                                   │
│  W1 ████████ 22                                     │
│  W2 ██████████ 28                                   │
│  W3 ██████ 18                                       │
│  W4 ███████ 19                                      │
│                                                      │
│  [sparkline: gh-activity-spark]                      │
│  Daily commits: ▂▄▆█▅▃▁▂▅▇█▆▃▂▄▅▇▆▃▂             │
└──────────────────────────────────────────────────────┘
```

## API Integration

### GitHub REST API v3 + GraphQL v4

**Library:** [`octokit`](https://github.com/octokit/octokit.js) — the official GitHub SDK.

```js
const { Octokit } = require("octokit");

// Per-session Octokit instances
const octokit = new Octokit({ auth: decryptedToken });
```

**REST v3** — used for most CRUD operations:
- `GET /user/repos` — list repos
- `GET /repos/{owner}/{repo}` — repo detail
- `GET /repos/{owner}/{repo}/issues` — list issues
- `POST /repos/{owner}/{repo}/issues` — create issue
- `GET /repos/{owner}/{repo}/pulls` — list PRs
- `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` — submit review
- `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` — merge PR
- `GET /notifications` — list notifications
- `PATCH /notifications/threads/{thread_id}` — mark read
- `GET /repos/{owner}/{repo}/commits` — commit log
- `GET /repos/{owner}/{repo}/stats/commit_activity` — weekly commit activity

**GraphQL v4** — used for complex/batched queries:

```graphql
# Efficient repo dashboard query (single request)
query RepoDashboard($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    name
    description
    stargazerCount
    forkCount
    watchers { totalCount }
    issues(states: OPEN) { totalCount }
    pullRequests(states: OPEN) { totalCount }
    languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
      edges { size node { name color } }
      totalSize
    }
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 10) {
            edges {
              node {
                message
                committedDate
                author { name }
                abbreviatedOid
              }
            }
          }
        }
      }
    }
  }
}
```

```graphql
# Notification + activity summary (reduces API calls)
query UserDashboard {
  viewer {
    login
    repositories(first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { nameWithOwner stargazerCount updatedAt }
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date } }
      }
    }
  }
}
```

### Rate Limiting

GitHub API limits:
- **REST:** 5,000 requests/hour (authenticated)
- **GraphQL:** 5,000 points/hour (cost varies by query complexity)
- **Search:** 30 requests/minute

**Strategy:**
1. Track `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers on every response
2. Surface rate limit status in `gh-status` action and in `meta` of every response
3. When remaining < 10%, show a warning alert in the canvas
4. When remaining = 0, queue requests and retry after reset time
5. Prefer GraphQL for dashboard views (1 query vs. 5+ REST calls)
6. Use conditional requests (`If-None-Match` / ETags) to avoid counting against limits

```js
class RateLimitTracker {
  constructor() {
    this.limits = { core: {}, graphql: {}, search: {} };
  }

  update(resource, headers) {
    this.limits[resource] = {
      limit: parseInt(headers['x-ratelimit-limit']),
      remaining: parseInt(headers['x-ratelimit-remaining']),
      reset: parseInt(headers['x-ratelimit-reset']),
      used: parseInt(headers['x-ratelimit-used'])
    };
  }

  canRequest(resource = 'core') {
    const rl = this.limits[resource];
    if (!rl || !rl.remaining) return true;
    return rl.remaining > 0 || Date.now() / 1000 > rl.reset;
  }

  getWaitTime(resource = 'core') {
    const rl = this.limits[resource];
    if (!rl || rl.remaining > 0) return 0;
    return Math.max(0, (rl.reset * 1000) - Date.now());
  }
}
```

### Pagination

Two pagination strategies depending on the API:

**REST — Page-based:**
```js
async function fetchAllPages(octokit, endpoint, params, maxPages = 10) {
  const items = [];
  for await (const response of octokit.paginate.iterator(endpoint, { ...params, per_page: 100 })) {
    items.push(...response.data);
    if (items.length >= maxPages * 100) break; // Safety limit
  }
  return items;
}
```

**GraphQL — Cursor-based:**
```js
async function fetchWithCursor(octokit, query, variables, path, maxPages = 5) {
  let cursor = null;
  const allNodes = [];
  for (let i = 0; i < maxPages; i++) {
    const result = await octokit.graphql(query, { ...variables, after: cursor });
    const connection = getNestedValue(result, path);
    allNodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return allNodes;
}
```

**Widget pagination:** For list views, fetch one page at a time (default 30 items) and render `[← Prev] [Page X of Y] [Next →]` buttons. Let the user navigate on-demand rather than pre-fetching.

### Caching

```js
class GitHubCache {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;       // .scratchy-data/github/cache/
    this.memory = new Map();        // Hot cache (in-memory LRU)
    this.maxMemoryEntries = 200;
    this.defaultTTL = {
      repos: 5 * 60 * 1000,        // 5 min — repo list
      repoDetail: 2 * 60 * 1000,   // 2 min — repo detail
      issues: 60 * 1000,           // 1 min — issue list (changes often)
      issueDetail: 30 * 1000,      // 30 sec — issue detail
      prs: 60 * 1000,             // 1 min
      notifications: 30 * 1000,    // 30 sec — notifications change fast
      commits: 5 * 60 * 1000,      // 5 min — commit log
      activity: 30 * 60 * 1000,    // 30 min — contribution stats
      user: 60 * 60 * 1000,        // 1 hour — user profile
    };
  }

  async get(key, category = 'repos') {
    // Check memory first
    const memEntry = this.memory.get(key);
    if (memEntry && Date.now() < memEntry.expiresAt) {
      return { data: memEntry.data, etag: memEntry.etag, cached: true };
    }
    // Fall through to disk cache or return null
    return null;
  }

  async set(key, data, category = 'repos', etag = null) {
    const ttl = this.defaultTTL[category] || 60000;
    this.memory.set(key, {
      data,
      etag,
      expiresAt: Date.now() + ttl,
      category
    });
    this.evictIfNeeded();
  }
}
```

**Conditional Requests (ETags):**
```js
// Store ETag from responses, send If-None-Match on subsequent requests
// GitHub returns 304 Not Modified (doesn't count against rate limit)
const response = await octokit.request('GET /repos/{owner}/{repo}/issues', {
  owner, repo,
  headers: cachedEtag ? { 'If-None-Match': cachedEtag } : {}
});

if (response.status === 304) {
  return cache.get(cacheKey); // Serve from cache, 0 rate limit cost
}
```

## serve.js Integration

### Routing

All `gh-*` actions route to the `GitHubWidget` class, following the same pattern as Standard Notes:

```js
// In serve.js HTTP handler
if (pathname.startsWith("/api/github/")) {
  setSecurityHeaders(res);
  const action = pathname.replace("/api/github/", "");
  // ... parse body, extract sessionId ...
  const result = await githubWidget.handleAction(action, data, sessionId, reqUrl.searchParams);
  // ... return JSON response ...
  return;
}
```

### Widget Class

```js
// lib/github-widget.js

const { Octokit } = require("octokit");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");

class GitHubWidget {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, "..", ".scratchy-data", "github");
    this.sessions = new Map();          // sessionId → { octokit, user, prefs }
    this.cache = new GitHubCache(path.join(this.dataDir, "cache"));
    this.rateLimits = new Map();        // sessionId → RateLimitTracker
    this.encryptionKey = null;          // Derived on init
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(path.join(this.dataDir, "cache"), { recursive: true });
    await fs.mkdir(path.join(this.dataDir, "sessions"), { recursive: true });
    this.encryptionKey = await this.deriveEncryptionKey();
    await this.restoreSessions();
  }

  async handleAction(action, data, sessionId, searchParams) {
    // Auth actions don't require an active session
    if (action === "auth") return this.authenticate(data, sessionId);
    if (action === "status") return this.getStatus(sessionId);

    // All other actions require auth
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: "Not authenticated. Use gh-auth first.", code: "NOT_AUTHED" };
    }

    // Check rate limit before making request
    const rl = this.rateLimits.get(sessionId);
    if (rl && !rl.canRequest()) {
      const waitMs = rl.getWaitTime();
      return { success: false, error: `Rate limited. Retry in ${Math.ceil(waitMs/1000)}s.`, code: "RATE_LIMITED", retryAfterMs: waitMs };
    }

    switch (action) {
      case "repos":          return this.listRepos(session, searchParams);
      case "repo-detail":    return this.getRepoDetail(session, searchParams);
      case "issues":         return this.listIssues(session, searchParams);
      case "issue-detail":   return this.getIssueDetail(session, searchParams);
      case "create-issue":   return this.createIssue(session, data);
      case "update-issue":   return this.updateIssue(session, data);
      case "comment-issue":  return this.commentOnIssue(session, data);
      case "prs":            return this.listPRs(session, searchParams);
      case "pr-detail":      return this.getPRDetail(session, searchParams);
      case "review-pr":      return this.reviewPR(session, data);
      case "merge-pr":       return this.mergePR(session, data);
      case "comment-pr":     return this.commentOnPR(session, data);
      case "notifications":  return this.listNotifications(session, searchParams);
      case "mark-read":      return this.markRead(session, data);
      case "commit-log":     return this.getCommitLog(session, searchParams);
      case "activity":       return this.getActivity(session, searchParams);
      case "search":         return this.search(session, searchParams);
      case "logout":         return this.logout(sessionId);
      default:               return { success: false, error: `Unknown action: ${action}` };
    }
  }

  // Each method fetches from GitHub API, transforms to scratchy-canvas ops, returns { success, data, ops }
  async listRepos(session, params) {
    const sort = params.get("sort") || "updated";
    const type = params.get("type") || "owner";
    const page = parseInt(params.get("page")) || 1;
    const perPage = parseInt(params.get("per_page")) || 30;

    const { data: repos } = await session.octokit.rest.repos.listForAuthenticatedUser({
      sort, type, page, per_page: perPage
    });

    return {
      success: true,
      data: repos,
      ops: this.buildRepoListOps(repos, page, perPage),
      meta: { pagination: { page, perPage, hasNext: repos.length === perPage } }
    };
  }

  // ... other methods follow the same pattern ...
}
```

### Session Persistence

Sessions survive server restarts:

1. On `gh-auth` success → encrypt token, write session to `.scratchy-data/github/sessions/{sessionId}.json`
2. On `init()` → read all session files, decrypt tokens, re-create Octokit instances
3. On `gh-logout` → delete session file, clear from memory
4. Session cleanup: periodically remove sessions inactive > 30 days

### WebSocket Integration (Widget Actions via WS)

For real-time widget interactions through the existing WebSocket connection:

```js
// In serve.js WS message handler (client → server)
if (frame.type === "widget-action" && frame.action?.startsWith("gh-")) {
  const action = frame.action.replace("gh-", "");
  const result = await githubWidget.handleAction(action, frame.params, sessionId, new URLSearchParams(frame.params));

  // Send result back to client
  ws.send(JSON.stringify({
    type: "widget-action-result",
    action: frame.action,
    requestId: frame.id,
    ...result
  }));

  // If ops are included, broadcast canvas update
  if (result.ops && result.ops.length > 0) {
    broadcast({
      type: "event",
      event: "canvas-update",
      payload: { ops: result.ops }
    });
  }

  return; // Don't forward to gateway
}
```

## Implementation Plan

### Step 1: Core Widget Class & Auth (1-2 sessions)

**New files:**
- `lib/github-widget.js` — `GitHubWidget` class with auth, token encryption, session management
- `lib/github-cache.js` — `GitHubCache` class with in-memory LRU + disk persistence
- `lib/github-rate-limit.js` — `RateLimitTracker` class

**Changes:**
- `serve.js` — add `/api/github/*` route block (modeled on Standard Notes pattern)
- `serve.js` — instantiate and init `GitHubWidget` on startup
- `package.json` — add `octokit` dependency

**Deliverables:**
- `gh-auth` (PAT), `gh-logout`, `gh-status` all working
- Token encrypted at rest
- Session restore on server restart

### Step 2: Repository Views (1 session)

**Implement:**
- `gh-repos` — list repos → `table` + `stats` + `tags` ops
- `gh-repo-detail` — single repo → `kv` + `stats` + `chart-bar` + `timeline` ops
- Navigation buttons between views

**Deliverables:**
- Repo list table with sorting and pagination
- Repo detail with language breakdown chart and recent commits

### Step 3: Issues (1-2 sessions)

**Implement:**
- `gh-issues` — list issues → `table` + `stats` + `tags` + `chips` (filter) ops
- `gh-issue-detail` — issue detail → `card` + `kv` + `timeline` + `checklist` + `tags` ops
- `gh-create-issue` — create issue → `form` + response ops
- `gh-update-issue` — update issue (state, labels)
- `gh-comment-issue` — add comment → append to timeline

**Deliverables:**
- Full issue CRUD in canvas
- Label filtering via chips
- Task list rendering as checklist component

### Step 4: Pull Requests (1-2 sessions)

**Implement:**
- `gh-prs` — list PRs → `table` + `stats` ops (with review/CI columns)
- `gh-pr-detail` — PR detail → `card` + `kv` + `timeline` + `checklist` (checks) ops
- `gh-review-pr` — submit review (approve/request changes/comment)
- `gh-merge-pr` — merge with method selection (merge/squash/rebase)
- `gh-comment-pr` — add comment

**Deliverables:**
- PR list with review status indicators
- PR detail with review timeline and CI check status
- Merge flow with conflict warnings

### Step 5: Notifications (1 session)

**Implement:**
- `gh-notifications` — list notifications → `timeline` + `stats` ops
- `gh-mark-read` — mark individual or all notifications as read
- Notification badge count on the dashboard nav bar

**Deliverables:**
- Notification feed with unread indicators
- Mark-read actions
- Badge count on nav buttons

### Step 6: Activity & Commit Log (1 session)

**Implement:**
- `gh-commit-log` — commit history → `timeline` ops
- `gh-activity` — contribution stats → `chart-bar` + `sparkline` + `stats` ops
- Use GraphQL `contributionsCollection` for efficient data fetching

**Deliverables:**
- Commit log timeline with author, message, SHA
- Weekly commit bar chart
- Daily contribution sparkline
- Aggregate stats (commits, PRs, reviews over period)

### Step 7: Search & Polish (1 session)

**Implement:**
- `gh-search` — search repos, issues, code → `table` ops
- Error handling polish (network errors, 404s, permission denials)
- Loading states (show `alert` with "Loading..." during API calls)
- Keyboard shortcuts and improved navigation

**Deliverables:**
- Unified search across repos, issues, and code
- Graceful error handling with user-friendly messages
- Polished UX with loading indicators

### Step 8: WebSocket Integration & GraphQL Optimization (1 session)

**Implement:**
- Wire up `widget-action` WS frame handling for `gh-*` actions
- Migrate dashboard and detail views to GraphQL batched queries
- Add ETag-based conditional requests for all list endpoints
- WebSocket push for real-time notification count updates

**Deliverables:**
- Full WS-based widget action flow (no HTTP fallback needed)
- Reduced API call count via GraphQL batching
- Conditional requests saving rate limit budget

## Estimated Effort

| Step | Sessions | Description |
|------|----------|-------------|
| 1: Core & Auth | 1-2 | Widget class, PAT auth, encryption, caching infra |
| 2: Repo Views | 1 | Repo list + detail with components |
| 3: Issues | 1-2 | Issue list, detail, create, update, comment |
| 4: Pull Requests | 1-2 | PR list, detail, review, merge |
| 5: Notifications | 1 | Notification feed, mark-read, badges |
| 6: Activity | 1 | Commit log, contribution charts, sparklines |
| 7: Search & Polish | 1 | Search, error handling, loading states |
| 8: WS & GraphQL | 1 | WebSocket actions, GraphQL optimization |
| **Total** | **8-11** | |

## Security Considerations

| Threat | Mitigation |
|--------|-----------|
| Token theft (at rest) | AES-256-GCM encryption, key derived from env var / master key |
| Token theft (in transit) | HTTPS only, tokens never sent to client or logged |
| Token in agent context | Widget actions never forwarded to agent — tokens stay server-side |
| Scope escalation | Validate token scopes on auth; warn if missing required scopes |
| SSRF via repo params | Validate `owner/repo` format strictly (`^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`) |
| XSS via issue/PR content | Sanitize all GitHub-sourced markdown/HTML before rendering in components |
| Rate limit exhaustion | Track limits per-session, queue requests when near limit, prefer conditional requests |
| Stale tokens | Check token validity on session restore, prompt re-auth on 401 |
| Cross-session data leak | Each session has its own Octokit instance; cache keys include sessionId |

## Dependencies to Add

```json
{
  "octokit": "^4.x"
}
```

`octokit` bundles `@octokit/rest`, `@octokit/graphql`, `@octokit/auth-token`, and pagination helpers. Single dependency, well-maintained by GitHub.

## Open Questions

1. **OAuth vs. PAT-only?** — PAT is simpler for Phase 1. Should OAuth be Phase 2, or should we build both from the start? OAuth requires a registered GitHub App and a public callback URL.

2. **Webhook support?** — GitHub webhooks could push real-time updates (new issues, PR reviews) instead of polling. Requires a publicly reachable endpoint or a tunnel (ngrok / Cloudflare Tunnel). Worth the complexity?

3. **GitHub Enterprise?** — Should we support custom GitHub Enterprise Server URLs (`baseUrl` in Octokit)? Adds a config field but minimal code change.

4. **Multi-account?** — Should users be able to connect multiple GitHub accounts (personal + work)? Adds complexity to session management.

5. **Markdown rendering?** — Issue/PR bodies contain GitHub-flavored Markdown. Render server-side to HTML for `card` text, or send raw markdown and let the client handle it? (Scratchy's `card` component may already support markdown.)

6. **File diffs in PR detail?** — Showing file-level diffs is complex (syntax highlighting, large payloads). Defer to Phase 2 and link to GitHub for now?

7. **GitHub Actions integration?** — Workflow run status, logs, re-run triggers. Natural extension but significant scope increase. Separate phase?

8. **Offline / degraded mode?** — If GitHub API is down or rate-limited, should the widget render stale cached data with a warning? How stale is too stale?

9. **Notification polling interval?** — GitHub recommends polling notifications no more than once per minute. Should we auto-poll in the background, or only fetch on user request?

10. **Per-user vs. shared cache?** — For public repos, a shared cache across sessions saves API calls. For private repos, cache must be session-scoped. Hybrid approach?
