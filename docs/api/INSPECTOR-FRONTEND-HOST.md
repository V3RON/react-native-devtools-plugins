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
| `enterInspectElementMode` (event) | ⛔ | dispatch channel |
| `copyText(text)` | ✅ clipboard | already real |
| `openInNewTab(url)` | ✅ `window.open` | 🔧 better: `shell.openExternal` |
| `openSearchResultsInNewTab(query)` | ✅ no-op | 🔧 same |
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
| `getHostConfig(cb)` | ✅ `{}` | 🔧 feed `experiments`, `disableAutosave`, etc. |
| `save/append/close(url, content…)` | ✅ `save` is real: `dialog.showSaveDialog` + fs over the shell's one save path (`src/main/save-service.js`), the same one `chrome.downloads.download` uses; `append` is inert + one warning; `close` is a no-op (nothing stays open) | 🔧 `append` needs the save to hold a handle open; report via ⛔ `savedURL` |
| `requestFileSystems` / `add/removeFileSystem` / `isolatedFileSystem` / `upgradeDraggedFileSystemPermissions` / `connect/disconnectAutomaticFileSystem` | ✅ no-ops | 🔧 workspace folders: `dialog.showOpenDialog` + fs watch → ⛔ `fileSystemsLoaded/fileSystemAdded/…`. Needed for Sources autosave & overrides; nice-to-have |
| `indexPath` / `stopIndexing` / `searchInPath` | ✅ no-ops | 🔧 ripgrep/fs scan → ⛔ `indexing*`/`searchCompleted` |

## Frontend lifecycle & injected scripts

| Method | Status | Electron wiring |
| --- | --- | --- |
| `setInjectedScriptForOrigin(origin, script)` | ✅ **no-op, correctly** | the channel is deleted, not stubbed: `chrome.devtools.*` is implemented shell-side in `src/chrome-shim/devtools.js`, so there is nothing left to ship into frames. Removing it also removed the in-memory per-origin script store, its `new Function` evaluation, and the last two `sendSync` channels. A frontend that awaits the call still gets a clean `undefined`. |
| `sendMessageToBackend(message)` | ✅ no-op, **correctly** | not a gap: with `?ws=` in the frontend URL the frontend build selects `WebSocketConnection`, and only `MainConnection` calls this method, so it is structurally dead here. The host reaches the backend on that socket itself → [src/main/cdp-bridge.js](../../src/main/cdp-bridge.js) ([features/DISPATCH-CHANNEL.md](../features/DISPATCH-CHANNEL.md)) |
| `events` + `InspectorFrontendAPI` dispatcher (`dispatchMessage`, `dispatchMessageChunk`, `showPanel`, `setInspectedTabId`, `contextMenuItemSelected`, `savedURL`, `revealSourceLine`, `keyEventUnhandled`, `colorThemeChanged`, `reloadInspectedPage`, …) | 🟨 dispatch channel **live**: main dispatches to `window.InspectorFrontendAPI[name]` (upstream impl forwards onto the events EventTarget). First consumer: context menus | `dispatchMessage`/`dispatchMessageChunk` only matter to `MainConnection`, which our `?ws=` URL never builds — dead like `sendMessageToBackend`. Remaining producers (`showPanel`, …) come with the APIs that need them → [features/DISPATCH-CHANNEL.md](../features/DISPATCH-CHANNEL.md) |
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
