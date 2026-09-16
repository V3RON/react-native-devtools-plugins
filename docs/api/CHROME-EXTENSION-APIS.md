# `chrome.*` gap analysis

Extension-API surface in real Chrome vs. this shim (`chrome-runtime.js` + injected
scripts). Status legend: [../README.md](../README.md) + [README.md](README.md).
Per-namespace plans live in [../features/README.md](../features/README.md).

## A. DevTools-only namespaces (must be complete — nothing works otherwise)

- **`devtools.panels`** — `create` 🟨 via frontend injected script; `Panel` events,
  `themeName/themeChanged`, `elements` sidebar panes, `sources`, `performance` ❌ →
  [features/DEVTOOLS-PANELS.md](../features/DEVTOOLS-PANELS.md). `recorder` 🚫.
  `openExtensionInDevtools(descriptor)` 🔧 (install flow).
- **`devtools.network`** — 🟡 synthetic + hardcoded bodies; must be rebuilt on the
  frontend's CDP `Network.*` model →
  [features/DEVTOOLS-NETWORK.md](../features/DEVTOOLS-NETWORK.md).
- **`devtools.inspectedWindow`** — ❌; `eval` → CDP `Runtime.evaluate`
  (`returnByValue`, `awaitPromise`), works great against Hermes; `frameURL` degrades;
  `getResources` → `Debugger.getScriptParsed` →
  [features/INSPECTED-WINDOW.md](../features/INSPECTED-WINDOW.md).

## B. Extension-foundation namespaces (used by *every* extension page)

| API | Real Chrome surface | Verdict here |
| --- | --- | --- |
| `runtime` | `id`, `getURL`, `sendMessage`, `connect` (Port: `postMessage/onMessage/onDisconnect`, transferables), `onMessage`, `getManifest`, `reload`, `openOptionsPage`, `getBackgroundPage`, `lastError`, `onInstalled`, `onStartup`, `onUpdateAvailable`; omitted: `requestUpdate`, `connectNative`, `sendMessageExternal` | 🔧 mostly implementable 1:1 with Electron IPC; today a no-op. `getURL` → `rozenite://<id>/<path>` → [RUNTIME-MESSAGING.md](../features/RUNTIME-MESSAGING.md) |
| `storage` | `local/session/sync/managed`, `onChanged`; StorageArea `get/set/remove/clear/getBytesInUse/getKeys`, `QUOTA_BYTES` | 🟡→✅ local/sync real (electron-store); session/managed + cross-frame `onChanged` → [STORAGE-AND-I18N.md](../features/STORAGE-AND-I18N.md) |
| `extension` (legacy) | `getURL`, `getViews`, `getBackgroundPage`, `lastError`, `isWritableFileSystem`, `inIncognitoContext`, `sendRequest/onRequest` (dead) | 🔧 thin aliases; omit `sendRequest/onRequest` |
| `i18n` | `getMessage`, `getUILanguage`, `acceptLanguages`, `detectLanguage` | 🔧 read `_locales/*.json` from the extension dir → [STORAGE-AND-I18N.md](../features/STORAGE-AND-I18N.md) |
| `permissions` | `contains/request/remove/getAll/onAdded/onRemoved` | 🔧 "everything declared is granted" → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `events` (types) | Event contract: `addListener/removeListener/hasListener/hasListeners`; Rule APIs (`addRules/getRules/removeRules`) | 🔧 shim hand-rolls `addListener` only; full Event shape required — feature detection uses `hasListener` |
| `webRequest` | 9 events + blocking responses, filters, `ResourceType` | 🔌🟡 observability from CDP `Network.*`; blocking infeasible (no CDP `Fetch` in RN backends); 7 of 9 events missing today → [WEBREQUEST.md](../features/WEBREQUEST.md) |
| `tabs` | huge surface | 🟡 one synthetic tab = inspected app target; `get/query/create/update/remove/sendMessage` only → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `action`, `notifications`, `alarms`, `downloads`, `contextMenus`, `commands`, `sidePanel`, `windows` | browser UI / lifecycle | Tier-2 subset: notifications→Electron, alarms→timers, action/contextMenus→present-but-inert → [SMALL-SHIMS.md](../features/SMALL-SHIMS.md) |
| `cookies`, `history`, `bookmarks`, `webNavigation`, `scripting`, `declarativeNetRequest`, `identity`, `gcm`, `offscreen`, `system.*`, `power`, `idle`, `sessions`, `topSites`, `readingList`, `search`, `omnibox`, `proxy`, `privacy`, `debugger`, `management`, `tabCapture`, `pageCapture`, `desktopCapture`, `loginState`, `enterprise.*`, ChromeOS-only | 🚫 | [TIER3-OMITTED.md](../features/TIER3-OMITTED.md) |

## C. Cross-cutting contract details the shim currently misses

These break real extensions more often than missing namespaces:

1. **Promise + callback dual style everywhere** (done in `storage`; must be a house rule
   for `runtime.sendMessage`, `tabs.*`, `permissions.*`, …).
2. **`chrome.runtime.lastError` semantics** — set (and only set) inside error callbacks;
   extensions branch on it.
3. **Real Event objects** — `addListener` dedupe, `removeListener` identity semantics,
   `hasListener`, `hasListeners`.
4. **Port messaging with structured cloning** (`runtime.connect`) — Redux DevTools and
   many others only work through Ports.
5. **`runtime.getURL` returns the `rozenite://` URL** — Altair's `tabs.js`
   regex-parses it to derive the extension id; keep hostname == extension id.
6. **Background context**: `chrome.*` must exist there too — today there is no background
   context at all → [BACKGROUND-WORKER.md](../features/BACKGROUND-WORKER.md).
