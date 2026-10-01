# Feature status matrix

One doc per functionality: status, Chrome API surface, RN mapping, current state, what's
needed. Legend and tiers: [../README.md](../README.md). Last reviewed: 2026-10-01.

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
| [Content scripts (bridge-style)](CONTENT-SCRIPTS.md) | ❌ (design done) | 2 | dispatch channel, runtime messaging |
| [Background worker](BACKGROUND-WORKER.md) (MV3 service worker) | 🟨 always-on hidden context: script executes, lifecycle fires, worker is a messaging peer; MV3 eviction skipped | 2 | — |
| [webRequest](WEBREQUEST.md) (`chrome.webRequest`) | 🟨 observe-only, 7 of 9 events from the real CDP model; filters + `ResourceType` real | 2 | — (blocking needs CDP `Fetch`) |
| [`chrome.permissions`](SMALL-SHIMS.md) — "everything declared is granted" shim | 🟨 accept-and-grant: reports the host's real verdict, `request` grants nothing new | 2 | — |
| [`chrome.tabs`/`windows` subset](SMALL-SHIMS.md) — one synthetic tab = inspected target | 🟨 one synthetic tab is real (`query`/`get`/`update`/`create`/`remove`); `sendMessage` has no receiver until content scripts; no window model | 2 | content scripts (for `sendMessage`) |
| [`chrome.notifications`](SMALL-SHIMS.md) → Electron `Notification` | ❌ registrable shell only, so a worker can load | 2 | — |
| [`chrome.alarms`](SMALL-SHIMS.md) → timers | ❌ | 2 | ~~background worker~~ host exists now |
| [`chrome.downloads`](SMALL-SHIMS.md) → save dialog | ❌ | 2 | dispatch channel (save flow) |
| [`chrome.action`/`commands`/`contextMenus`](SMALL-SHIMS.md) — accept-and-no-op shells | 🟨 `action` is a registrable no-op shell (worker-load only); `commands`/`contextMenus` missing | 2 | — |
| [Manifest `options_ui`](SMALL-SHIMS.md) → separate window | ❌ | 2 | extension management |
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
