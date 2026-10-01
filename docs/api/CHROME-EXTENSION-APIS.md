# `chrome.*` gap analysis

Extension-API surface in real Chrome vs. this shim (`src/chrome-shim` + injected
scripts). Status legend: [../README.md](../README.md) + [README.md](README.md).
Per-namespace plans live in [../features/README.md](../features/README.md).

## A. DevTools-only namespaces (must be complete — nothing works otherwise)

- **`devtools.panels`** — `create` 🟨 via frontend injected script; `Panel` events,
  `themeName/themeChanged`, `elements` sidebar panes, `sources`, `performance` ❌ →
  [features/DEVTOOLS-PANELS.md](../features/DEVTOOLS-PANELS.md). `recorder` 🚫.
  `openExtensionInDevtools(descriptor)` 🔧 (install flow).
- **`devtools.network`** — 🟨 real: `onRequestFinished` (a `Request` = a HAR 1.2 entry with
  lazy `getContent`/`getRequestContent`), `getHAR`, `getResponseBody`, `onNavigated`, built
  on the shell's CDP `Network.*` model. Divergences: `onNavigated` fires on a
  debugger-session change with the target's title (RN has no page navigations), unknown HAR
  timings stay `-1`, `getHarEntry()` returns a copy of the entry the `Request` already
  is;
  `getNetworkStatus()` is a shell addition for honest empty states →
  [features/DEVTOOLS-NETWORK.md](../features/DEVTOOLS-NETWORK.md).
- **`devtools.inspectedWindow`** — 🟨 `eval` and `reload` are **real**: CDP
  `Runtime.evaluate` (`returnByValue`, `awaitPromise`) and `Page.reload` over the
  shell's CDP bridge, answering Chrome's `[value, exceptionInfo]` pair. `frameURL` /
  `useContentScriptContext` accepted-and-ignored; `getResources` / `getSelectedNode`
  inert → [features/INSPECTED-WINDOW.md](../features/INSPECTED-WINDOW.md). (Against a
  real Hermes backend this is asserted by the sample panel, not yet run on a device.)

## B. Extension-foundation namespaces (used by *every* extension page)

| API | Real Chrome surface | Verdict here |
| --- | --- | --- |
| `runtime` | `id`, `getURL`, `sendMessage`, `connect` (Port: `postMessage/onMessage/onDisconnect`, transferables), `onMessage`, `getManifest`, `reload`, `openOptionsPage`, `getBackgroundPage`, `lastError`, `onInstalled`, `onStartup`, `onUpdateAvailable`; omitted: `requestUpdate`, `connectNative`, `sendMessageExternal` | ✅ identity/manifest/platform + `sendMessage` + Ports are real (host router, extension-scoped); `lastError` scoped, promise+callback on all methods. Remaining: Port transferables (JSON-only today), lifecycle producers + `getBackgroundPage` (needs background host), `reload`/`openOptionsPage` inert → [RUNTIME-MESSAGING.md](../features/RUNTIME-MESSAGING.md) |
| `storage` | `local/session/sync/managed`, `onChanged`; StorageArea `get/set/remove/clear/getBytesInUse/getKeys`, `QUOTA_BYTES` | ✅ local/sync real (electron-store), session per-frame in-memory; managed + cross-frame `onChanged` remain → [STORAGE-AND-I18N.md](../features/STORAGE-AND-I18N.md) |
| `extension` (legacy) | `getURL`, `getViews`, `getBackgroundPage`, `lastError`, `isWritableFileSystem`, `inIncognitoContext`, `sendRequest/onRequest` (dead) | 🔧 thin aliases; omit `sendRequest/onRequest` |
| `i18n` | `getMessage`, `getUILanguage`, `acceptLanguages`, `detectLanguage` | 🔧 read `_locales/*.json` from the extension dir → [STORAGE-AND-I18N.md](../features/STORAGE-AND-I18N.md) |
| `permissions` | `contains/request/remove/getAll/onAdded/onRemoved` | 🔧 "everything declared is granted" → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `events` (types) | Event contract: `addListener/removeListener/hasListener/hasListeners`; Rule APIs (`addRules/getRules/removeRules`) | 🔧 shim hand-rolls `addListener` only; full Event shape required — feature detection uses `hasListener` |
| `webRequest` | 9 events + blocking responses, filters, `ResourceType` | 🟨 observe-only: 7 of 9 events from the CDP `Network.*` model with real `ResourceType` and Chrome's match-pattern/glob filters; the other two are registrable but have no CDP counterpart; blocking is infeasible (no CDP `Fetch` in RN backends) and is reported, not pretended → [WEBREQUEST.md](../features/WEBREQUEST.md) |
| `tabs` | huge surface | 🟡 one synthetic tab = inspected app target; `get/query/create/update/remove/sendMessage` only → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `action`, `notifications`, `alarms`, `downloads`, `contextMenus`, `commands`, `sidePanel`, `windows` | browser UI / lifecycle | Tier-2 subset: notifications→Electron, alarms→timers, action/contextMenus→present-but-inert → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `cookies`, `history`, `bookmarks`, `webNavigation`, `scripting`, `declarativeNetRequest`, `identity`, `gcm`, `offscreen`, `system.*`, `power`, `idle`, `sessions`, `topSites`, `readingList`, `search`, `omnibox`, `proxy`, `privacy`, `debugger`, `management`, `tabCapture`, `pageCapture`, `desktopCapture`, `loginState`, `enterprise.*`, ChromeOS-only | 🚫 | [TIER3-OMITTED.md](../features/TIER3-OMITTED.md) |

## C. Cross-cutting contract details

These break real extensions more often than missing namespaces. 1–3 are the house rule and
are implemented for `storage`, `runtime`, `devtools.network` and `webRequest`; they apply to
every namespace added from here on:

1. **Promise + callback dual style everywhere** ✅ done in `storage`, `runtime.sendMessage`
   and the network APIs; still required for `tabs.*`, `permissions.*`, …
2. **`chrome.runtime.lastError` semantics** ✅ set (and only set) inside error callbacks;
   extensions branch on it.
3. **Real Event objects** ✅ `src/chrome-shim/event.js`: `addListener` dedupe,
   `removeListener` identity semantics, `hasListener`, `hasListeners` — shared by storage,
   runtime and both network namespaces.
4. **Port messaging with structured cloning** (`runtime.connect`) — Redux DevTools and
   many others only work through Ports.
5. **`runtime.getURL` returns the `rozenite://` URL** — Altair's `tabs.js`
   regex-parses it to derive the extension id; keep hostname == extension id.
6. **Background context**: `chrome.*` must exist there too — today there is no background
   context at all → [BACKGROUND-WORKER.md](../features/BACKGROUND-WORKER.md).
