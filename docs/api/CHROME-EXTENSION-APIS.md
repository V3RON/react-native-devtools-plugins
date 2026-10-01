# `chrome.*` gap analysis

Extension-API surface in real Chrome vs. this shim (`src/chrome-shim` + injected
scripts). Status legend: [../README.md](../README.md) + [README.md](README.md).
Per-namespace plans live in [../features/README.md](../features/README.md).

## A. DevTools-only namespaces (must be complete — nothing works otherwise)

- **`devtools.panels`** — `create` 🟨 shell-driven (`chrome.devtools.*` is implemented in
  `src/chrome-shim/devtools.js`, not by a frontend-injected script); `Panel` events,
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
| `runtime` | `id`, `getURL`, `sendMessage`, `connect` (Port: `postMessage/onMessage/onDisconnect`, transferables), `onMessage`, `getManifest`, `reload`, `openOptionsPage`, `getBackgroundPage`, `lastError`, `onInstalled`, `onStartup`, `onUpdateAvailable`; omitted: `requestUpdate`, `connectNative`, `sendMessageExternal` | ✅ identity/manifest/platform + `sendMessage` + Ports are real (host router, extension-scoped); `lastError` scoped, promise+callback on all methods; **`onInstalled` (`install`/`update`) and `onStartup` fire** (produced by the background host); **`openOptionsPage` opens a real window** for a manifest that declares `options_ui` and refuses, by extension id, one that does not. Remaining: Port transferables (JSON-only today); `getBackgroundPage` is `undefined` — Chrome's answer too, for an MV3 service worker; `reload` inert; `onUpdateAvailable`/`onSuspend` never fire → [RUNTIME-MESSAGING.md](../features/RUNTIME-MESSAGING.md) |
| `storage` | `local/session/sync/managed`, `onChanged`; StorageArea `get/set/remove/clear/getBytesInUse/getKeys`, `QUOTA_BYTES` | ✅ local/sync real (electron-store), session per-frame in-memory; managed + cross-frame `onChanged` remain → [STORAGE-AND-I18N.md](../features/STORAGE-AND-I18N.md) |
| `extension` (legacy) | `getURL`, `getViews`, `getBackgroundPage`, `lastError`, `isWritableFileSystem`, `inIncognitoContext`, `sendRequest/onRequest` (dead) | 🔧 thin aliases; omit `sendRequest/onRequest` |
| `i18n` | `getMessage`, `getUILanguage`, `acceptLanguages`, `detectLanguage` | 🔧 read `_locales/*.json` from the extension dir → [STORAGE-AND-I18N.md](../features/STORAGE-AND-I18N.md) |
| `permissions` | `contains/request/remove/getAll/onAdded/onRemoved` | 🟨 real as a report: `contains`/`getAll` answer the manifest's truth from the host's verdict; `request` resolves `true` only for what is already declared and grants nothing new; `onAdded`/`onRemoved` never fire → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `events` (types) | Event contract: `addListener/removeListener/hasListener/hasListeners`; Rule APIs (`addRules/getRules/removeRules`) | 🔧 shim hand-rolls `addListener` only; full Event shape required — feature detection uses `hasListener` |
| `webRequest` | 9 events + blocking responses, filters, `ResourceType` | 🟨 observe-only: 7 of 9 events from the CDP `Network.*` model with real `ResourceType` and Chrome's match-pattern/glob filters; the other two are registrable but have no CDP counterpart; blocking is infeasible (no CDP `Fetch` in RN backends) and is reported, not pretended → [WEBREQUEST.md](../features/WEBREQUEST.md) |
| `tabs` | huge surface | 🟨 one synthetic tab = the inspected app target, under the id `devtools.inspectedWindow.tabId` reports; `query`/`get`/`getCurrent`/`update`/`create`/`remove` are real over that one tab, `create` adds an `openedVia` field and opens nothing unless the host is configured to, `sendMessage` has no receiver (no content scripts), and `onUpdated`/`onActivated`/… never fire → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `action`, `notifications`, `alarms`, `downloads`, `contextMenus`, `commands`, `sidePanel`, `windows` | browser UI / lifecycle | Tier-2 subset: notifications→Electron `Notification`, alarms→timers, downloads→the shell's save path, `commands.getAll`→the manifest, `contextMenus`→a registry with no menu, `sidePanel`→options that round-trip; the events whose trigger this host lacks never fire → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `cookies`, `history`, `bookmarks`, `webNavigation`, `scripting`, `declarativeNetRequest`, `identity`, `gcm`, `offscreen`, `system.*`, `power`, `idle`, `sessions`, `topSites`, `readingList`, `search`, `omnibox`, `proxy`, `privacy`, `debugger`, `management`, `tabCapture`, `pageCapture`, `desktopCapture`, `loginState`, `enterprise.*`, ChromeOS-only | 🚫 | [TIER3-OMITTED.md](../features/TIER3-OMITTED.md) |

## C. Cross-cutting contract details

These break real extensions more often than missing namespaces. 1–3 are the house rule and
are implemented for `storage`, `runtime`, `devtools.network` and `webRequest`; they apply to
every namespace added from here on:

1. **Promise + callback dual style everywhere** ✅ done in `storage`, `runtime`, the network
   APIs and every Tier-2 namespace added since (`tabs`, `permissions`, `notifications`,
   `alarms`, `downloads`, `commands`, `contextMenus`, `sidePanel`), all through the one
   helper in `src/chrome-shim/async-style.js`.
2. **`chrome.runtime.lastError` semantics** ✅ set (and only set) inside error callbacks;
   extensions branch on it.
3. **Real Event objects** ✅ `src/chrome-shim/event.js`: `addListener` dedupe,
   `removeListener` identity semantics, `hasListener`, `hasListeners` — shared by storage,
   runtime and both network namespaces.
4. **Port messaging with structured cloning** (`runtime.connect`) — Redux DevTools and
   many others only work through Ports.
5. **`runtime.getURL` returns the `rozenite://` URL** — Altair's `tabs.js`
   regex-parses it to derive the extension id; keep hostname == extension id.
6. **Background context**: `chrome.*` must exist there too — ✅ it does now, and it is the
   *same* shim, the same permission gate and an ordinary router seat as any panel, in a hidden
   window per extension → [BACKGROUND-WORKER.md](../features/BACKGROUND-WORKER.md). The
   browser APIs a worker asks for (`tabs`, `notifications`, `action`, `alarms`) are what is
   still missing.
