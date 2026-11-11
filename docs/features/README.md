# Feature status matrix

One doc per functionality: status, Chrome API surface, RN mapping, current state, what's
needed. Legend and tiers: [../README.md](../README.md). Last reviewed: 2026-10-14.

## Tier 1 — extensions are nonfunctional without these

| Functionality | Status | Tier | Blocked by |
| --- | --- | --- | --- |
| [Extension management & manifest support](EXTENSION-MANAGEMENT.md) | 🟨 scan (pages + backgrounds) + manifest parse + per-extension CSP + permission enforcement + install/version record; no lifecycle UI | 1 | — |
| [DevTools panels](DEVTOOLS-PANELS.md) (`chrome.devtools.panels`) | 🟨 create + theme + `Panel.onShown/onHidden` work; `sources`/`performance`/`network.getHAR` implementable; `panels.elements.*` 🚷 no anchor | 1 | — |
| [DevTools network](DEVTOOLS-NETWORK.md) (`chrome.devtools.network`) | 🟨 real CDP model (`Network.*`), unverified on device; `onNavigated` diverges | 1 | RN network inspection |
| [Inspected window](INSPECTED-WINDOW.md) (`chrome.devtools.inspectedWindow`) | 🟨 `eval` + `reload` real via the CDP bridge; `getResources` open, `getSelectedNode` 🚷 no anchor | 1 | — |
| [Runtime messaging](RUNTIME-MESSAGING.md) (`chrome.runtime`, Ports, event contract) | 🟨 surface + sendMessage + Ports + background peer + `onInstalled`/`onStartup` real | 1 | — |
| [Storage & i18n](STORAGE-AND-I18N.md) (`chrome.storage`, `chrome.i18n`) | 🟨 storage real for local/sync/session, host-owned per extension with cross-context `onChanged`; managed missing; **i18n real** (sync `getMessage`, `__MSG_` manifest/CSS; `detectLanguage` stub) | 1 | — |
| [Host→frontend dispatch channel](DISPATCH-CHANNEL.md) (`InspectorFrontendAPI` / `events`) | 🟨 channel live (context-menu round-trip); frontend→backend messaging is structurally unused — the CDP bridge owns the socket | 1 (infrastructure) | — |

## Tier 2 — real extensions ask for these

| Functionality | Status | Tier | Blocked by |
| --- | --- | --- | --- |
| [Content scripts (bridge-style)](CONTENT-SCRIPTS.md) | 🟨 content-bridge runner real and **observed on a real device** (injection, global hook, app→host over `Runtime.bindingCalled`, `tabs.sendMessage` round-trip), behind `DEVTOOLS_CONTENT_SCRIPTS` (default off, so nothing injects); a send with no receiver reports Chrome's connection failure instead of `undefined`, and one entry is evaluated once per app context — both re-observed on the device | 2 | — |
| [Background worker](BACKGROUND-WORKER.md) (MV3 service worker) | 🟨 always-on hidden context: script executes, lifecycle fires, worker is a messaging peer; MV3 eviction skipped | 2 | — |
| [webRequest](WEBREQUEST.md) (`chrome.webRequest`) | 🟨 observe-only, 7 of 9 events from the real CDP model; filters + `ResourceType` real | 2 | — (blocking needs CDP `Fetch`) |
| [`chrome.permissions`](SMALL-SHIMS.md) — "everything declared is granted" shim | 🟨 accept-and-grant: reports the host's real verdict, `request` grants nothing new | 2 | — |
| [`chrome.tabs` subset](SMALL-SHIMS.md) — one synthetic tab = inspected target | 🟨 one synthetic tab is real (`query`/`get`/`update`/`create`/`remove`); `sendMessage` delivers to this extension's opted-in content script and fails with a reason when there is none; `chrome.windows` real behavior 🚷 (no window model) | 2 | — |
| [`chrome.notifications`](SMALL-SHIMS.md) → Electron `Notification` | 🟨 real: shows, allocates the id, `onClicked`/`onClosed` from the real notification; no button events, no real dismiss on Electron 38 | 2 | — |
| [`chrome.alarms`](SMALL-SHIMS.md) → timers | 🟨 real timers + Chrome's argument rules + `onAlarm`; alarms do not outlive the context (no persistence, always-on worker) | 2 | — |
| [`chrome.downloads`](SMALL-SHIMS.md) → save dialog | 🟨 real saves over the shell's one export path: ids/states/`totalBytes` from main, `onChanged` from what really happened, `onDeterminingFilename` with Chrome's contract; `show`/`showDefaultFolder` inert | 2 | — |
| [`chrome.action`/`commands`/`contextMenus`/`sidePanel`](SMALL-SHIMS.md) — accept-and-grant shells | 🟨 all four exist with Chrome's shape so a worker naming them loads; `action` renders nothing, `commands.getAll` reads the manifest, `contextMenus` keeps a registry, `sidePanel` round-trips options; of the events with no trigger, only `commands.onCommand` is producible here | 2 | shortcut routing via the Electron app menu (`commands.onCommand`); the rest is 🚷 no toolbar/menu/drawer |
| [Manifest `options_ui`](SMALL-SHIMS.md) → separate window | 🟨 real window over `rozenite://<id>/<page>` with the same frame policy as any extension page; a manifest with none is refused by name | 2 | — |
| [`panels.elements.createSidebarPane` + context menu](DEVTOOLS-PANELS.md) | 🚷 **no anchor** — no Elements panel, no selected node | — | inert shape only, forever |
| [`panels.sources` / `panels.performance` / `panels.network.getHAR`](DEVTOOLS-PANELS.md) | ❌ | 2 | — (RN DevTools has both panels; `getHAR` reuses the model that already exists) |

## Tier 3 — deliberately out of scope

| Functionality | Status | Tier |
| --- | --- | --- |
| [Tier-3: omitted browser APIs](TIER3-OMITTED.md) | 🚫 no-op shells | 3 |

## Cross-cutting host surfaces

| Surface | Status | Doc |
| --- | --- | --- |
| `InspectorFrontendHost.*` (frontend ⇄ embedder) | 🟨 ~60 methods stubbed, semantics missing for most; `openInNewTab`, `save`/`append`/`close` (+ `savedURL`/`canceledSaveURL`/`appendedToURL`) and `getHostConfig` are real | [../api/INSPECTOR-FRONTEND-HOST.md](../api/INSPECTOR-FRONTEND-HOST.md) |
| `chrome.*` (extension API) | 🟡 mostly stub; storage + `devtools.inspectedWindow.eval` are the exceptions | [../api/CHROME-EXTENSION-APIS.md](../api/CHROME-EXTENSION-APIS.md) |

## 🚷 Closed as "no anchor" — not open items

Each of these sat on a to-do list until it was checked against
[what RN DevTools actually offers](../OVERVIEW.md#what-rn-devtools-actually-offers-the-anchor-list).
They keep their inert shapes (the stubbing rule); they cannot become real in this host:

| Item | The missing anchor | Doc |
| --- | --- | --- |
| `panels.elements.createSidebarPane` / `inspectedObject` / `openResource` / `onCreateContextMenu` | no Elements panel | [DEVTOOLS-PANELS.md](DEVTOOLS-PANELS.md) |
| `inspectedWindow.getSelectedNode` | no DOM, no `DOM` domain, no element selection | [INSPECTED-WINDOW.md](INSPECTED-WINDOW.md) |
| `action.onClicked` and any popup, `contextMenus.onClicked` / `onVisited`, `sidePanel.open` | no toolbar, no page right-click menu, no side-panel drawer | [SMALL-SHIMS.md](SMALL-SHIMS.md) |
| `tabs` events (`onUpdated`/`onActivated`/…), `captureVisibleTab`, window/tab `query` filters | no tab strip, no window model — one synthetic tab stands for the app | [SMALL-SHIMS.md](SMALL-SHIMS.md) |
| `webRequest` **blocking**, `onHeadersReceived`, `onAuthRequired` | no CDP `Fetch` domain; the backend emits nothing for those two | [WEBREQUEST.md](WEBREQUEST.md) |
| DOM `content_scripts` (`css`, `document_start`, isolated worlds, URL `matches`) | no document, no isolated worlds, no page URLs | [CONTENT-SCRIPTS.md](CONTENT-SCRIPTS.md) |
| `webNavigation`, `devtools.recorder`, `offscreen`, `chrome.windows` | no navigations, no Recorder panel, no hidden DOM document, no window model | [TIER3-OMITTED.md](TIER3-OMITTED.md) |

Note: two things look like they belong in this table but do not. `commands.onCommand` has a
producer this shell can write (the Electron app menu / `before-input-event`), and `chrome.windows`
real behavior is 🚷 while the **inert shell** that keeps the stubbing rule is a small open item.
Both are in [../ROADMAP.md](../ROADMAP.md#what-we-can-actually-implement-the-pruned-list).

## Dependency sketch

```
cdp-bridge (src/main/cdp-bridge.js) ──┬── inspected-window.eval ──► content-scripts
                                      │   (panels.elements 🚷: no anchor)
                                      ├── devtools-network ── webRequest
                                      └── device discovery (later)
dispatch-channel ──┬── devtools-panels (events, theme, context menus)
                   └── save/downloads
extension-management ──► background-worker (live) ──► alarms, tabs, notifications
runtime-messaging ──► background-worker (live), content-scripts, tabs
```
