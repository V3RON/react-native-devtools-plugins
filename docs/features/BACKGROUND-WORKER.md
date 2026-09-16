# Background worker (MV3 service worker)

| | |
| --- | --- |
| **Status** | ❌ not run at all |
| **Tier** | 2 |
| **Blocked by** | [EXTENSION-MANAGEMENT.md](EXTENSION-MANAGEMENT.md), [RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) |

## What Chrome does

`background.service_worker` runs in an ephemeral worker context that owns the "browser"
APIs (`tabs`, `webRequest`, `alarms`, `notifications`, `action`…) and is woken by events.
Many DevTools extensions keep their real logic here (GraphQL Network Inspector and Altair
both ship a `background.js` that currently **never executes** in this prototype).

## Design here

Skip MV3 lifecycle semantics (idle eviction, event-driven wake): run the worker as an
**always-on hidden context** — a hidden `BrowserWindow`/`utilityProcess` frame evaluating
`background.js` with the full `chrome.*` shim and [runtime messaging](RUNTIME-MESSAGING.md)
wired. Simpler, and "always running" is a superset of event-driven wake for a devtools host.

Notes:

- Worker-side `chrome.*` must be the same shim surface (this is where
  `tabs`/`webRequest`/`alarms`/`notifications` actually matter).
- Import vs. classic worker: honor `type: "module"`.
- `alarms` become timers inside this context
  ([CONTENT-SCRIPTS.md](CONTENT-SCRIPTS.md)'s injected code reaches the worker through
  the messaging router).
- Later refinement (optional): true suspended lifecycle to match MV3 resource model.

## Definition of done

GraphQL Network Inspector's `background.js` executes against the shim (its
`runtime.onInstalled` fires; a fake `tabs.create` call resolves).
