# Feature status matrix

One doc per functionality: status, Chrome API surface, RN mapping, current state, what's
needed. Legend and tiers: [../README.md](../README.md). Last reviewed: 2026-10-02.

## Tier 1 — extensions are nonfunctional without these

| Functionality | Status | Tier | Blocked by |
| --- | --- | --- | --- |
| [Extension management & manifest support](EXTENSION-MANAGEMENT.md) | 🟨 scan (pages + backgrounds) + manifest parse + per-extension CSP + permission enforcement + install/version record; no lifecycle UI | 1 | — |
| [DevTools panels](DEVTOOLS-PANELS.md) (`chrome.devtools.panels`) | 🟨 create works; theme/events/sidebars missing | 1 | dispatch channel |
| [DevTools network](DEVTOOLS-NETWORK.md) (`chrome.devtools.network`) | 🟨 real CDP model (`Network.*`), unverified on device; `onNavigated` diverges | 1 | RN network inspection |
| [Inspected window](INSPECTED-WINDOW.md) (`chrome.devtools.inspectedWindow`) | 🟨 `eval` + `reload` real via the CDP bridge; resources/selected-node inert | 1 | — |
| [Runtime messaging](RUNTIME-MESSAGING.md) (`chrome.runtime`, Ports, event contract) | 🟨 surface + sendMessage + Ports + background peer + `onInstalled`/`onStartup` real | 1 | — |
| [Storage & i18n](STORAGE-AND-I18N.md) (`chrome.storage`, `chrome.i18n`) | 🟨 storage real (local/sync); session/managed/i18n missing | 1 | — |
| [Host→frontend dispatch channel](DISPATCH-CHANNEL.md) (`InspectorFrontendAPI` / `events`) | 🟨 channel live (context-menu round-trip); frontend→backend messaging is structurally unused — the CDP bridge owns the socket | 1 (infrastructure) | — |

## Tier 2 — real extensions ask for these

| Functionality | Status | Tier | Blocked by |
| --- | --- | --- | --- |
| [Content scripts (bridge-style)](CONTENT-SCRIPTS.md) | 🟨 content-bridge runner real and **observed on a real device** (injection, global hook, app→host over `Runtime.bindingCalled`, `tabs.sendMessage` round-trip), behind `DEVTOOLS_CONTENT_SCRIPTS` (default off, so nothing injects); a send with no receiver reports Chrome's connection failure instead of `undefined`, and one entry is evaluated once per app context — both re-observed on the device | 2 | — |
| [Background worker](BACKGROUND-WORKER.md) (MV3 service worker) | 🟨 always-on hidden context: script executes, lifecycle fires, worker is a messaging peer; MV3 eviction skipped | 2 | — |
| [webRequest](WEBREQUEST.md) (`chrome.webRequest`) | 🟨 observe-only, 7 of 9 events from the real CDP model; filters + `ResourceType` real | 2 | — (blocking needs CDP `Fetch`) |
| [`chrome.permissions`](SMALL-SHIMS.md) — "everything declared is granted" shim | 🟨 accept-and-grant: reports the host's real verdict, `request` grants nothing new | 2 | — |
| [`chrome.tabs` subset](SMALL-SHIMS.md) — one synthetic tab = inspected target | 🟨 one synthetic tab is real (`query`/`get`/`update`/`create`/`remove`); `sendMessage` delivers to this extension's opted-in content script and fails with a reason when there is none; no `chrome.windows` (no window model) | 2 | — |
| [`chrome.notifications`](SMALL-SHIMS.md) → Electron `Notification` | 🟨 real: shows, allocates the id, `onClicked`/`onClosed` from the real notification; no button events, no real dismiss on Electron 38 | 2 | — |
| [`chrome.alarms`](SMALL-SHIMS.md) → timers | 🟨 real timers + Chrome's argument rules + `onAlarm`; alarms do not outlive the context (no persistence, always-on worker) | 2 | — |
| [`chrome.downloads`](SMALL-SHIMS.md) → save dialog | 🟨 real saves over the shell's one export path: ids/states/`totalBytes` from main, `onChanged` from what really happened, `onDeterminingFilename` with Chrome's contract; `show`/`showDefaultFolder` inert | 2 | — |
| [`chrome.action`/`commands`/`contextMenus`/`sidePanel`](SMALL-SHIMS.md) — accept-and-grant shells | 🟨 all four exist with Chrome's shape so a worker naming them loads; `action` renders nothing, `commands.getAll` reads the manifest, `contextMenus` keeps a registry, `sidePanel` round-trips options — and the events whose trigger this host lacks never fire | 2 | a toolbar/menu/shortcut surface, to make those events real |
| [Manifest `options_ui`](SMALL-SHIMS.md) → separate window | 🟨 real window over `rozenite://<id>/<page>` with the same frame policy as any extension page; a manifest with none is refused by name | 2 | — |
| [`panels.elements.createSidebarPane` + context menu](DEVTOOLS-PANELS.md) | ❌ | 2 | element selection (inspected-window `eval` is real now) |
| [`panels.sources` / `panels.performance`](DEVTOOLS-PANELS.md) | ❌ | 2 | — |

## Tier 3 — deliberately out of scope

| Functionality | Status | Tier |
| --- | --- | --- |
| [Tier-3: omitted browser APIs](TIER3-OMITTED.md) | 🚫 no-op shells | 3 |

## Cross-cutting host surfaces

| Surface | Status | Doc |
| --- | --- | --- |
| `InspectorFrontendHost.*` (frontend ⇄ embedder) | 🟨 ~60 methods stubbed, semantics missing for most | [../api/INSPECTOR-FRONTEND-HOST.md](../api/INSPECTOR-FRONTEND-HOST.md) |
| `chrome.*` (extension API) | 🟡 mostly stub; storage + `devtools.inspectedWindow.eval` are the exceptions | [../api/CHROME-EXTENSION-APIS.md](../api/CHROME-EXTENSION-APIS.md) |

## Dependency sketch

```
cdp-bridge (src/main/cdp-bridge.js) ──┬── inspected-window.eval ──► content-scripts,
                                      │                             panels.elements sidebars
                                      ├── devtools-network ── webRequest
                                      └── device discovery (later)
dispatch-channel ──┬── devtools-panels (events, theme, context menus)
                   └── save/downloads
extension-management ──► background-worker (live) ──► alarms, tabs, notifications
runtime-messaging ──► background-worker (live), content-scripts, tabs
```
