# Small shims (Tier 2 one-offs)

| | |
| --- | --- |
| **Status** | ❌ none implemented yet |
| **Tier** | 2 |
| **Blocked by** | [RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) (messaging router + contract rules apply to all of these) |

Cheap, independent wins. All must follow the house rules from
[RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) (promise+callback, `lastError`, real Event
objects) and the stubbing rule of thumb from [../OVERVIEW.md](../OVERVIEW.md).

## `chrome.permissions`

`contains/request/remove/getAll/onAdded/onRemoved` → report **everything declared as
granted**. Trivial, unblocks feature-detection code paths.

## `chrome.tabs` / `chrome.windows` (subset)

Simulate exactly one synthetic "tab" = the inspected RN target.
`query`/`get` → the one fake tab; `create(url)` → `shell.openExternal` (+ return a throwaway
id); `update` → no-op resolving; `remove` → no-op; `sendMessage` → routed messaging.
Everything else → no-op shells. This alone unblocks Altair (`tabs.js` uses only
`create`/`get`/`update`).

## `chrome.notifications`

→ Electron `Notification`. Genuinely useful (build finished, error alerts).

## `chrome.alarms`

`create/update/clear/getAll/onAlarm` → `setTimeout`/`setInterval` inside the
[background worker](BACKGROUND-WORKER.md) context.

## `chrome.downloads`

`download({url | data})` → Electron save dialog + fs. Shares plumbing with
`InspectorFrontendHost.save` (see [../api/INSPECTOR-FRONTEND-HOST.md](../api/INSPECTOR-FRONTEND-HOST.md)).

## `chrome.action` / `commands` / `contextMenus` (browser-side)

Accept-and-no-op shells with the full method shape (`setIcon`/`setTitle`/`onClicked`,
`onCommand`, `create/update/remove`…). No toolbar/right-click exists; they must not throw.

## Manifest `options_ui`

`runtime.openOptionsPage()` → open the options HTML in a separate Electron window using
the `rozenite://` protocol.

## `panels.elements` / `panels.sources` / `panels.performance`

Covered in [DEVTOOLS-PANELS.md](DEVTOOLS-PANELS.md); listed here only to complete the
Tier-2 inventory: all remain ❌ and depend on
[INSPECTED-WINDOW.md](INSPECTED-WINDOW.md) / frontend events.
