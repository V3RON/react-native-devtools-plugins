# `InspectorFrontendHost.*` gap analysis

Full real surface per upstream `InspectorFrontendHostAPI.ts`. Implementation today:
`src/preload/frontend-host.js` (main frame). Status legend: [../README.md](../README.md) +
[README.md](README.md) (🔧/🔌/⛔ marks).

## Key upstream fact: partial coverage is survivable

`installInspectorFrontendHost()` (upstream `InspectorFrontendHost.ts`) copies any
**missing** methods from `InspectorFrontendHostStub` with a `console.error` warning. So
missing methods don't crash — they're inert. The realistic goal is *full shape coverage +
honest semantics*, which the stub already provides for the telemetry tail. The preload can
delete its hand-rolled list and layer real implementations on top of the frontend's own
stub — see "Generate, don't hand-write" in [../ROADMAP.md](../ROADMAP.md).

## Window / UI integration

| Method | Status | Electron wiring |
| --- | --- | --- |
| `platform()` | ✅ real `"mac"`/`"windows"`/`"linux"` (was hardcoded `"linux"`) | — |
| `loadCompleted()` | ✅ no-op | fine |
| `bringToFront()` / `closeWindow()` | ✅ `BrowserWindow.focus()/close()` via IPC | — |
| `setIsDocked(docked, cb)` | ✅ | No docking concept; keep no-op + `cb()` |
| `setInspectedPageBounds(bounds)` | ✅ | no-op (no attached browser viewport) |
| `zoomFactor()/zoomIn()/zoomOut()/resetZoom()` | ✅ real `webFrame` zoom | — |
| `showContextMenuAtPoint(x, y, items, doc)` | ✅ native Electron `Menu.popup()`; replies `contextMenuItemSelected`/`contextMenuCleared` via dispatch channel | — |
| `setUseSoftMenu`/`setOpenNewWindowForPopups`/`setWhitelistedShortcuts` | ✅/🟡 | keybinding registry doable; shortcuts otherwise ignored |
| `setEyeDropperActive(active)` | ✅ no-op | 🔧 Chromium `EyeDropper` API (available in modern Electron), else screenshot picker; result via ⛔ `eyeDropperPickedColor` |
| `enterInspectElementMode` (event) | 🚷 | **no anchor**: inspect-element mode walks the DOM tree of the Elements panel, and RN DevTools has neither ([anchor list](../OVERVIEW.md#what-rn-devtools-actually-offers-the-anchor-list)). Not an open item, unlike the ⛔ dispatch-channel ones — the channel is live and would not help |
| `copyText(text)` | ✅ clipboard | already real |
| `openInNewTab(url)` | ✅ real: `shell.openExternal` behind an **http(s)-only allowlist** (`src/main/external-open.js`). Any other scheme (`file:`, `smb:`, `javascript:`, `ms-msdt:`, …), a URL with embedded credentials (`user:pw@`), an unparsable string or a URL over 8 KB is refused in main and logged in the frontend console. Only the DevTools frontend may call the channel: `src/main/frontend-frame.js` requires its WebContents, its main frame (not an extension iframe) **and** its origin (a frontend navigated away keeps the preload but loses access); the frontend window also denies top-level navigations off its origin. The same allowlist now also guards `chrome.tabs.create` under `DEVTOOLS_TABS_OPEN=external` (it used to hand the URL to the OS unfiltered). It used to be `window.open`, which made a window of this shell with the DevTools preload attached | A DevTools link, a request row's "Open in new tab" and `UIUtils.openInNewTab` all land here (evidence: `docs/evidence/electron-leftovers/`). Test seam, off by default (see "Test seams" below): `DEVTOOLS_TEST_OPEN_LOG=<file>` |
| `openSearchResultsInNewTab(query)` | ✅ no-op | 🔧 would need a search-engine URL policy; nothing in the RN frontend calls it |
| `showItemInFolder(path)` | 🟨 inert + one warning | deliberately not wired to `shell.showItemInFolder`: the frontend names a path this host never wrote, so revealing *something* would show the user a file that is not the one they asked about. `chrome.downloads.show` has the same rule |
| `showCertificateViewer(chain)` | 🟡 | low value; stub |
| `reattach(cb)`, `readyForTest()`, `connectionReady()` | ✅ | fine |
| `initialTargetId()` | ✅ `null` | 🔧 return the active RN target id — enables multi-target UX |
| `isHostedMode()` | ✅ `true` | correct and load-bearing |

## Persistence: preferences, files, workspace

| Method | Status | Electron wiring |
| --- | --- | --- |
| `registerPreference` / `get{,All}Preference(s)` / `setPreference` / `removePreference` / `clearPreferences` | ✅ persisted in `electron-store` (`frontend-preferences.json`), host-side defaults from `registerPreference` honored | — |
| `getSyncInformation(cb)` | ✅ reports no-sync | fine — no Chrome Sync exists |
| `getHostConfig(cb)` | ✅ real: `src/main/host-config.js`, fetched over IPC. Every key is a feature gate this frontend build reads (see below); defaults switch off what cannot work in this shell (Chrome's AI/AIDA features, the privacy/cookie UI, VE-logging telemetry). `DEVTOOLS_HOST_CONFIG='{…}'` merges a JSON object over the defaults, one level deep | **There is no `experiments` or `disableAutosave` key in this frontend's `Root.Runtime.HostConfig`**, so none is sent: the frontend does `Object.assign(Runtime.hostConfig, answer)` and nothing reads those. Experiments are a *preference* here and already persist via `registerPreference`/`setPreference` |
| `save/append/close(url, content…)` | ✅ real (`src/main/host-files.js`). `save` is the shell's one save path (`src/main/save-service.js`, shared with `chrome.downloads`) plus Chrome's per-url file memory: the first save of a `url` (or `forceSaveAs`) opens a save dialog, a later save re-uses the chosen path silently, and the host raises `savedURL(url, fileSystemPath)` — or `canceledSaveURL(url)` when the dialog is dismissed or the write fails. `append` writes to the path a save of that `url` chose and raises `appendedToURL(url)`; an `append` to a url never saved is ignored (logged), so the frontend cannot name an arbitrary file to grow. `close` forgets the path. Operations on one url run in order. The `url` echoed back is the frontend's own string, verbatim — its `FileManager` matches replies to promises by it | Frontend flows driven for real: Console "Save as…" (save → append → close) and Network "Export HAR (sanitized)…" (`docs/evidence/electron-leftovers/`). **Partial:** a failed `append` raises no `appendedToURL` (the frontend's stream then never finishes; only the log says why); the first save of a url now always asks (it used to write to `~/Downloads` silently when `forceSaveAs` was false); `fileSystemPath` is the plain path, not a registered file-system id. A failed re-save to a remembered path removes that file (the write truncates it first; no temp-and-rename). Test seam, off by default: `DEVTOOLS_TEST_SAVE_DIALOG=<dir>` (see "Test seams" below) |
| `requestFileSystems` / `add/removeFileSystem` / `isolatedFileSystem` / `upgradeDraggedFileSystemPermissions` / `connect/disconnectAutomaticFileSystem` | ✅ no-ops | 🔧 workspace folders: `dialog.showOpenDialog` + fs watch → ⛔ `fileSystemsLoaded/fileSystemAdded/…`. Needed for Sources autosave & overrides; nice-to-have |
| `indexPath` / `stopIndexing` / `searchInPath` | ✅ no-ops | 🔧 ripgrep/fs scan → ⛔ `indexing*`/`searchCompleted` |

### Test seams

`DEVTOOLS_TEST_OPEN_LOG=<file>` records the URL `openInNewTab` (or `chrome.tabs.create` under
`external`) *would* have opened instead of launching a browser. `DEVTOOLS_TEST_SAVE_DIALOG=<dir>`
answers the save dialog with `<dir>/<default name>`, or `cancel` for "cancelled". Both are
honoured only when `app.isPackaged` is false (a packaged build ignores them and warns), a
`[config] TEST SEAM ACTIVE` warning is logged at startup whenever one is on, and relative paths
resolve against the process's working directory. **`DEVTOOLS_TEST_SAVE_DIALOG` replaces every
save dialog, so it also affects `chrome.downloads.download({saveAs:true})`.** Never set either in
a user-facing launch.

### `getHostConfig` keys and the choice made for each

`src/main/host-config.js`. The frontend reads these gates from `Root.Runtime.hostConfig`
(grep of the shipped bundle); the visible effect of the AI group is shown in
`docs/evidence/electron-leftovers/` (`01-…` default vs `04-…` with the override: the
"AI assistance" drawer tab appears only when the override turns it on).

| Key | Sent | Why |
| --- | --- | --- |
| `aidaAvailability` | `{enabled:false, blockedBy*:false, disallowLogging:true}` | AIDA calls a Google service with the Chrome profile's credentials; this shell has no account and `doAidaConversation` answers "Not implemented". `blockedBy*:false` is the truth (nothing blocks it — nothing provides it). `disallowLogging:true` is the privacy-safe value if a deployment enables AIDA |
| `devToolsConsoleInsights`, `devToolsFreestyler`, `devToolsAiAssistance{Network,File,Performance}Agent`, `devToolsAiGeneratedTimelineLabels` | `{enabled:false}` | the AI features themselves — a button that can only fail is worse than no button |
| `devToolsPrivacyUI`, `thirdPartyCookieControls` | off / `"Unset"` | the Privacy and Security cookie report reads Chrome's third-party-cookie state; there is none |
| `devToolsVeLogging` | `{enabled:false}` | Chrome's visual-element telemetry; nothing collects it |
| `isOffTheRecord` | `false` | not an incognito profile; settings persist in `frontend-preferences.json` |

The bundle also reads `devToolsAnimationStylesInStylesTab` and `devToolsCssValueTracing`; they are ordinary Elements features that need nothing this shell lacks, so they are left unset (frontend defaults).

Honest caveats: with the old `{}` answer every one of these was already off (an absent key
reads as disabled), so the **defaults change nothing visible by themselves** — what is new is
that the gates are explicit, documented, and switchable (`DEVTOOLS_HOST_CONFIG`). Turning AIDA
on does *not* make it work: `getSyncInformation` still reports no account and there is no AIDA
proxy, so the AI features cannot complete a request (only the tab appearing was exercised, not
a conversation). The config is read once at frontend start.

## Frontend lifecycle & injected scripts

| Method | Status | Electron wiring |
| --- | --- | --- |
| `setInjectedScriptForOrigin(origin, script)` | ✅ **no-op, correctly** | the channel is deleted, not stubbed: `chrome.devtools.*` is implemented shell-side in `src/chrome-shim/devtools.js`, so there is nothing left to ship into frames. Removing it also removed the in-memory per-origin script store, its `new Function` evaluation, and the last two `sendSync` channels. A frontend that awaits the call still gets a clean `undefined`. |
| `sendMessageToBackend(message)` | ✅ no-op, **correctly** | not a gap: with `?ws=` in the frontend URL the frontend build selects `WebSocketConnection`, and only `MainConnection` calls this method, so it is structurally dead here. The host reaches the backend on that socket itself → [src/main/cdp-bridge.js](../../src/main/cdp-bridge.js) ([features/DISPATCH-CHANNEL.md](../features/DISPATCH-CHANNEL.md)) |
| `window.__SHELL_HOST__.reportPanelVisible(panelId, shown)` (**shell-only**, not part of `InspectorFrontendHost`; exposed next to `reportTheme`) | ✅ real | the panel bridge reports an extension panel's tab being selected/deselected; main turns it into `Panel.onShown/onHidden` for the creating devtools page (`EXT_PANEL_VISIBILITY` → `EXT_PANEL_EVENT`, accepted from the frontend main frame only) → [features/DEVTOOLS-PANELS.md](../features/DEVTOOLS-PANELS.md) |
| `events` + `InspectorFrontendAPI` dispatcher (`dispatchMessage`, `dispatchMessageChunk`, `showPanel`, `setInspectedTabId`, `contextMenuItemSelected`, `savedURL`, `canceledSaveURL`, `appendedToURL`, `revealSourceLine`, `keyEventUnhandled`, `colorThemeChanged`, `reloadInspectedPage`, …) | 🟨 dispatch channel **live**: main dispatches to `window.InspectorFrontendAPI[name]` (upstream impl forwards onto the events EventTarget). Consumers: the save family (`savedURL`/`canceledSaveURL`/`appendedToURL`, the first events observed arriving end to end) and context menus. **Fixed here:** the preload passed `executeInMainWorld({func, arguments})`, a key Electron ignores (it is `args`), so the function ran with no arguments and every event was dropped as `InspectorFrontendAPI.undefined` | `dispatchMessage`/`dispatchMessageChunk` only matter to `MainConnection`, which our `?ws=` URL never builds — dead like `sendMessageToBackend`. Remaining producers (`showPanel`, …) come with the APIs that need them → [features/DISPATCH-CHANNEL.md](../features/DISPATCH-CHANNEL.md) |
| `inspectedURLChanged(url)` | ✅ sets title | fine |
| `inspectElementCompleted()` | ✅ | fine |

## Devices (remote debugging) APIs

| Method | Status | Electron wiring |
| --- | --- | --- |
| `setDevicesDiscoveryConfig(config)` / `setDevicesUpdatesEnabled` | ✅ no-ops | 🔌🔧 **sleeper feature**: populate Chrome's device-discovery feed with connected devices/emulators (adb/simctl/metro), dispatching ⛔ `devicesUpdated`/`deviceCountUpdated` |
| `openRemotePage(browserId, url)` / `openNodeFrontend()` | ✅ no-ops | 🔧 open per-target frontend URL |
| Devices events | ⛔ | dispatch channel |

## Telemetry / AI / misc (stub-safe forever)

| Method | Status | Notes |
| --- | --- | --- |
| `recordCountHistogram` / `recordEnumeratedHistogram` / `recordPerformanceHistogram` | ✅ no-ops | could forward to a metrics sink later |
| `recordPerformanceHistogramMedium` | ❌ missing | frontend auto-stubs |
| `recordUserMetricsAction` | ✅ | fine |
| `recordNewBadgeUsage` | ❌ missing | auto-stubbed |
| `recordImpression/Resize/Click/Hover/Drag/Change/KeyDown/SettingAccess` | ✅ no-ops | Chrome UX telemetry — keep no-op |
| `recordFunctionCall` | ❌ missing | auto-stubbed |
| `doAidaConversation` / `registerAidaClientEvent` | ✅ "Not implemented" | Chrome's built-in AI; 🔧 proxy to any LLM later |
| `aidaCodeComplete` | ❌ missing | auto-stubbed |
| `dispatchHttpRequest(request, cb)` | ❌ missing | 🔧 trivial with `net`/`fetch` — used for Google-service calls; errors acceptable |
| `setChromeFlag` / `requestRestart` | ❌ missing | no-op stubs |
| `showSurvey` / `canShowSurvey` | ✅ `{surveyShown:false}` | correct forever |
