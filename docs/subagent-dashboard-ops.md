# Sub-agent Dashboard Canvas Ops

When spawning parallel sub-agents, render a live dashboard using these canvas op patterns.

## Initial render (when spawning agents):

Use scratchy-toon for token efficiency:

```scratchy-toon
op: upsert
id: sa-header
type: hero
data:
  title: 🤖 Sub-agent Sprint
  subtitle: 3 agents deployed
  icon: ⚡
  gradient: true
---
op: upsert
id: sa-stats
type: stats
data:
  title: Progress
  items[3]{label,value}:
    Active,3
    Complete,0
    Failed,0
---
op: upsert
id: sa-task-1
type: card
data:
  title: 🧪 Task Name
  text: Brief description of what this agent is doing...
  icon: ⏳
```

Repeat the card block for each agent (`sa-task-2`, `sa-task-3`, etc.).

## When an agent completes:

```scratchy-canvas
{"op":"patch","id":"sa-task-1","data":{"text":"✅ Done — brief summary of result","icon":"✅"}}
{"op":"patch","id":"sa-stats","data":{"items":[{"label":"Active","value":"2"},{"label":"Complete","value":"1"},{"label":"Failed","value":"0"}]}}
```

## When an agent fails:

```scratchy-canvas
{"op":"patch","id":"sa-task-1","data":{"text":"❌ Error description","icon":"❌"}}
{"op":"patch","id":"sa-stats","data":{"items":[{"label":"Active","value":"1"},{"label":"Complete","value":"1"},{"label":"Failed","value":"1"}]}}
```

## Final summary:

```scratchy-canvas
{"op":"patch","id":"sa-header","data":{"title":"🤖 Sprint Complete","subtitle":"Finished in 2m 34s"}}
{"op":"upsert","id":"sa-summary","type":"alert","data":{"title":"Summary","message":"3/3 tasks completed successfully","severity":"success"}}
```

## Component field reference (quick reminder)

- **hero**: `title`, `subtitle`, `icon`, `badge`, `gradient`, `style`
- **stats**: `title`, `items[]{label, value}`
- **card**: `title`, `text` (⚠️ NOT body), `icon`
- **alert**: `title`, `message`, `severity` (info|warning|error|success)

## Server-side helper

`lib/subagent-dashboard.js` exports helpers for programmatic op generation:

```javascript
const { createSubagentDashboard, agentCompleted, agentFailed, sprintComplete } = require('../lib/subagent-dashboard');

// Generate initial ops
const ops = createSubagentDashboard([
  { id: 'task-1', label: '🧪 Preview Middleware', task: 'Add preview middleware to serve.js' },
  { id: 'task-2', label: '🔄 Version Toast', task: 'Add version check toast notification' },
  { id: 'task-3', label: '📦 Deploy Script', task: 'Create production deploy script' },
]);

// When task-1 completes
const patchOps = agentCompleted('task-1', 'Added preview middleware to serve.js', {
  active: 2, complete: 1, failed: 0
});

// When task-2 fails
const failOps = agentFailed('task-2', 'Module not found: toast-lib', {
  active: 1, complete: 1, failed: 1
});

// When all done
const doneOps = sprintComplete('2m 34s', '2/3 tasks completed, 1 failed');
```
