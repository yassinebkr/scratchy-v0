# TOON Protocol for Scratchy GenUI

**TOON** (Token-Oriented Object Notation) is a compact, human-readable alternative to JSON for Scratchy canvas operations. It saves **~30-40% tokens** on structured data while remaining easy for LLMs to produce and humans to read.

## Quick Start

Use `scratchy-toon` code blocks instead of `scratchy-canvas`:

````
```scratchy-toon
op: upsert
id: my-card
type: card
data:
  title: Hello World
  text: This is a TOON-encoded component
```
````

Multiple ops are separated by `---`:

````
```scratchy-toon
op: upsert
id: greeting
type: hero
data:
  title: Welcome
  subtitle: Your dashboard is ready
---
op: upsert
id: cpu-gauge
type: gauge
data:
  label: CPU
  value: 73
  max: 100
  unit: %
  color: orange
```
````

## Format Rules

### Simple Key-Value Pairs

```
key: value
```

No quotes needed for most strings. Numbers, booleans (`true`/`false`), and `null` are auto-detected.

### Nesting (2-space indent)

```
data:
  title: My Title
  nested:
    deeper: value
```

### Simple Arrays

```
labels[3]: Jan,Feb,Mar
values[5]: 10,20,30,40,50
```

The `[N]` hint tells the parser how many elements to expect. Items are comma-separated on one line.

### Tabular Arrays (uniform objects)

For arrays of objects with the same keys, use the tabular format:

```
items[3]{label,value}:
  CPU,73%
  RAM,4.2 GB
  Disk,52%
```

This is equivalent to JSON:
```json
"items": [
  {"label": "CPU", "value": "73%"},
  {"label": "RAM", "value": "4.2 GB"},
  {"label": "Disk", "value": "52%"}
]
```

Each indented row is one object. Fields map positionally to the `{field1,field2}` header.

### Quoting

Quote strings that contain commas, colons, or leading/trailing whitespace:

```
title: "Hello, World"
description: "Note: this has a colon"
items[2]{label,value}:
  Simple,100
  "Has, comma","Value: special"
```

### Nested Arrays in Tabular Rows

For fields that are themselves arrays (like chart `data`), wrap in `[]`:

```
datasets[2]{label,data,color}:
  Sales,"[120,150,180]",blue
  Costs,"[80,90,100]",red
```

## Operations

### upsert — Create or Replace

Create a new component or fully replace an existing one.

```
op: upsert
id: my-stats
type: stats
data:
  title: Server Metrics
  items[3]{label,value}:
    Uptime,14d 3h
    Requests,1.2M
    Errors,0.03%
```

Optional layout hint:

```
op: upsert
id: my-stats
type: stats
layout:
  zone: top
  order: 0
data:
  title: Server Metrics
  items[2]{label,value}:
    CPU,73%
    RAM,4.2 GB
```

### patch — Partial Update

Merge into existing component data. Only specified fields are updated.

```
op: patch
id: my-stats
data:
  title: Updated Metrics
```

Patch can update individual items too:

```
op: patch
id: cpu-gauge
data:
  value: 85
  color: red
```

### remove — Delete Component

```
op: remove
id: my-stats
```

### clear — Remove All Components

```
op: clear
```

### layout — Change Canvas Layout

```
op: layout
mode: dashboard
```

Valid modes: `auto`, `dashboard`, `focus`, `columns`, `rows`

### move — Reposition Component

```
op: move
id: my-stats
layout:
  zone: sidebar
  order: 1
```

## Streaming Behavior

TOON ops in `scratchy-toon` blocks are parsed incrementally:

1. **On `---` separator** — the preceding op is parsed and executed immediately
2. **On closing ` ``` `** — the final op in the block is parsed and executed
3. **Partial ops** — buffered until a separator or block end is reached

This means components appear on the canvas as they stream in, not all at once at the end. The first component becomes visible as soon as the `---` after it is emitted (or the block closes).

**Tip for responsiveness:** Put the most important component first so it renders while the rest streams.

## When to Use TOON vs JSON

| Scenario | Recommended | Why |
|----------|-------------|-----|
| Multiple components with arrays | **TOON** | Biggest token savings (30-40%) |
| Tables, stats, checklists, timelines | **TOON** | Tabular format shines here |
| Charts with datasets | **TOON** | Avoids deeply nested JSON |
| Simple single-field patch | **JSON** | Already compact, no savings |
| Single toggle/rating update | **JSON** | Minimal data, not worth overhead |
| Mixed response (some complex, some simple) | **Either/both** | Both can coexist in same response |

### Rule of Thumb

- **3+ components with structured data** → TOON
- **1 simple patch** → JSON
- **Charts or tables** → always TOON

## Token Savings Examples

### Example 1: Dashboard (3 gauges + stats)

**JSON** (`scratchy-canvas`) — ~185 tokens:
````
```scratchy-canvas
{"op":"upsert","id":"g-cpu","type":"gauge","data":{"label":"CPU","value":73,"max":100,"unit":"%","color":"orange"}}
{"op":"upsert","id":"g-ram","type":"gauge","data":{"label":"RAM","value":4.2,"max":8,"unit":"GB","color":"blue"}}
{"op":"upsert","id":"g-disk","type":"gauge","data":{"label":"Disk","value":52,"max":100,"unit":"%","color":"green"}}
{"op":"upsert","id":"srv-stats","type":"stats","data":{"title":"Services","items":[{"label":"Uptime","value":"14d 3h"},{"label":"Requests","value":"1.2M"},{"label":"Errors","value":"0.03%"}]}}
```
````

**TOON** (`scratchy-toon`) — ~110 tokens (**40% savings**):
````
```scratchy-toon
op: upsert
id: g-cpu
type: gauge
data:
  label: CPU
  value: 73
  max: 100
  unit: %
  color: orange
---
op: upsert
id: g-ram
type: gauge
data:
  label: RAM
  value: 4.2
  max: 8
  unit: GB
  color: blue
---
op: upsert
id: g-disk
type: gauge
data:
  label: Disk
  value: 52
  max: 100
  unit: %
  color: green
---
op: upsert
id: srv-stats
type: stats
data:
  title: Services
  items[3]{label,value}:
    Uptime,14d 3h
    Requests,1.2M
    Errors,0.03%
```
````

### Example 2: Table + Buttons

**JSON** — ~150 tokens:
````
```scratchy-canvas
{"op":"upsert","id":"task-table","type":"table","data":{"title":"Tasks","headers":["Task","Status","Due"],"rows":[["Deploy API","In Progress","Feb 22"],["Fix auth bug","Blocked","Feb 23"],["Write docs","Done","Feb 21"]]}}
{"op":"upsert","id":"task-actions","type":"buttons","data":{"title":"Actions","buttons":[{"label":"Refresh","action":"refresh","style":"ghost"},{"label":"Add Task","action":"add","style":"primary"}]}}
```
````

**TOON** — ~95 tokens (**37% savings**):
````
```scratchy-toon
op: upsert
id: task-table
type: table
data:
  title: Tasks
  headers[3]: Task,Status,Due
  rows[3]:
    Deploy API,In Progress,Feb 22
    Fix auth bug,Blocked,Feb 23
    Write docs,Done,Feb 21
---
op: upsert
id: task-actions
type: buttons
data:
  title: Actions
  buttons[2]{label,action,style}:
    Refresh,refresh,ghost
    Add Task,add,primary
```
````

### Example 3: Timeline

**JSON** — ~130 tokens:
````
```scratchy-canvas
{"op":"upsert","id":"deploy-tl","type":"timeline","data":{"title":"Deploy","items":[{"title":"Build","text":"Compiling","time":"10:00","icon":"🔨","status":"done"},{"title":"Test","text":"Running tests","time":"10:15","icon":"🧪","status":"active"},{"title":"Ship","text":"Push to prod","time":"10:30","icon":"🚀","status":"pending"}]}}
```
````

**TOON** — ~80 tokens (**38% savings**):
````
```scratchy-toon
op: upsert
id: deploy-tl
type: timeline
data:
  title: Deploy
  items[3]{title,text,time,icon,status}:
    Build,Compiling,10:00,🔨,done
    Test,Running tests,10:15,🧪,active
    Ship,Push to prod,10:30,🚀,pending
```
````

## Coexistence with JSON

TOON and JSON blocks can appear in the same response:

````
Here's your dashboard:

```scratchy-toon
op: upsert
id: main-stats
type: stats
data:
  title: Overview
  items[4]{label,value}:
    Users,12.5K
    Revenue,$45K
    Growth,+12%
    Churn,1.2%
```

Updated the title:

```scratchy-canvas
{"op":"patch","id":"page-title","data":{"title":"Q1 Dashboard"}}
```
````

## Compatibility Notes

- `scratchy-toon` blocks are parsed by the Scratchy client and converted to the same internal ops as `scratchy-canvas`
- All ops (`upsert`, `patch`, `remove`, `clear`, `layout`, `move`) work identically in both formats
- `scratchy-tpl` (templates) remain JSON — they're already single-line and compact
- Old `scratchy-ui` blocks continue to work (backward compat)

## Component Reference

See [`toon-component-reference.toon`](./toon-component-reference.toon) for the complete field reference for all 32+ component types with TOON examples.

## Common Pitfalls

1. **Don't forget `---` between ops** — without it, fields from different ops merge incorrectly
2. **Quote strings with commas** — `"Hello, World"` not `Hello, World` in tabular rows
3. **Use `data:` nesting** — component fields go under `data:`, not at the top level
4. **Count hint `[N]`** — should match actual row count; parser uses it for validation
5. **2-space indent** — tabs or inconsistent indentation will break parsing
6. **No backticks in values** — same rule as JSON blocks; backticks break the code fence
