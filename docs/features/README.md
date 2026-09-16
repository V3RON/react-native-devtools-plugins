# Feature status matrix

One doc per functionality: status, Chrome API surface, RN mapping, current state, what's
needed. Legend and tiers: [../README.md](../README.md). Last reviewed: 2026-09-16.

## Tier 1 — extensions are nonfunctional without these

| Functionality | Status | Tier | Blocked by |
| --- | --- | --- | --- |
| [Extension management & manifest support](EXTENSION-MANAGEMENT.md) | 🟡 folder-at-repo-root | 1 | — |
| [DevTools panels](DEVTOOLS-PANELS.md) (`chrome.devtools.panels`) | 🟨 create works; theme/events/sidebars missing | 1 | dispatch channel |
| [DevTools network](DEVTOOLS-NETWORK.md) (`chrome.devtools.network`) | 🟡 synthetic events + fake bodies | 1 | dispatch channel, RN network inspection |
| [Inspected window](INSPECTED-WINDOW.md) (`chrome.devtools.inspectedWindow`) | ❌ | 1 | — |
| [Runtime messaging](RUNTIME-MESSAGING.md) (`chrome.runtime`, Ports, event contract) | 🟨 surface + sendMessage + Ports real; background/lifecycle pending | 1 | — |
| [Storage & i18n](STORAGE-AND-I18N.md) (`chrome.storage`, `chrome.i18n`) | 🟨 storage real (local/sync); session/managed/i18n missing | 1 | — |
| [Host→frontend dispatch channel](DISPATCH-CHANNEL.md) (`InspectorFrontendAPI` / `events` / `sendMessageToBackend`) | 🟨 channel live (context-menu round-trip); backend messaging pending | 1 (infrastructure) | — |

## Tier 2 — real extensions ask for these

| Functionality | Status | Tier | Blocked by |
| --- | --- | --- | --- |
| [Content scripts (bridge-style)](CONTENT-SCRIPTS.md) | ❌ (design done) | 2 | dispatch channel, runtime messaging |
| [Background worker](BACKGROUND-WORKER.md) (MV3 service worker) | ❌ | 2 | extension management, runtime messaging |
| [webRequest](WEBREQUEST.md) (`chrome.webRequest`) | 🟡 observe-only, 2 of 9 events, fake bodies | 2 | dispatch channel |
| [`chrome.permissions`](SMALL-SHIMS.md) — "everything declared is granted" shim | ❌ | 2 | runtime messaging |
| [`chrome.tabs`/`windows` subset](SMALL-SHIMS.md) — one synthetic tab = inspected target | ❌ | 2 | runtime messaging |
| [`chrome.notifications`](SMALL-SHIMS.md) → Electron `Notification` | ❌ | 2 | — |
| [`chrome.alarms`](SMALL-SHIMS.md) → timers | ❌ | 2 | background worker |
| [`chrome.downloads`](SMALL-SHIMS.md) → save dialog | ❌ | 2 | dispatch channel (save flow) |
| [`chrome.action`/`commands`/`contextMenus`](SMALL-SHIMS.md) — accept-and-no-op shells | ❌ | 2 | — |
| [Manifest `options_ui`](SMALL-SHIMS.md) → separate window | ❌ | 2 | extension management |
| [`panels.elements.createSidebarPane` + context menu](DEVTOOLS-PANELS.md) | ❌ | 2 | inspected window |
| [`panels.sources` / `panels.performance`](DEVTOOLS-PANELS.md) | ❌ | 2 | — |

## Tier 3 — deliberately out of scope

| Functionality | Status | Tier |
| --- | --- | --- |
| [Tier-3: omitted browser APIs](TIER3-OMITTED.md) | 🚫 no-op shells | 3 |

## Cross-cutting host surfaces

| Surface | Status | Doc |
| --- | --- | --- |
| `InspectorFrontendHost.*` (frontend ⇄ embedder) | 🟨 ~60 methods stubbed, semantics missing for most | [../api/INSPECTOR-FRONTEND-HOST.md](../api/INSPECTOR-FRONTEND-HOST.md) |
| `chrome.*` (extension API) | 🟡 mostly stub; storage is the exception | [../api/CHROME-EXTENSION-APIS.md](../api/CHROME-EXTENSION-APIS.md) |

## Dependency sketch

```
dispatch-channel ──┬── devtools-network ── webRequest
                   ├── devtools-panels (events, theme, context menus)
                   └── save/downloads
extension-management ──► background-worker ──► alarms
runtime-messaging ──► background-worker, content-scripts, tabs
inspected-window ──► content-scripts, panels.elements sidebar panes
```
