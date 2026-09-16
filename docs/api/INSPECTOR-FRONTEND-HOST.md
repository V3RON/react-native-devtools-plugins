# `InspectorFrontendHost.*` gap analysis

Full real surface per upstream `InspectorFrontendHostAPI.ts`. Implementation today:
`preload.js` (main frame). Status legend: [../README.md](../README.md) +
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
| `platform()` | ✅ returns `"linux"` | Return real `process.platform` (`darwin`/`win32` shortcuts differ in the frontend) |
| `loadCompleted()` | ✅ no-op | fine |
| `bringToFront()` / `closeWindow()` | ✅ log-only | 🔧 `BrowserWindow.focus()/close()` |
| `setIsDocked(docked, cb)` | ✅ | No docking concept; keep no-op + `cb()` |
| `setInspectedPageBounds(bounds)` | ✅ | no-op (no attached browser viewport) |
| `zoomFactor()/zoomIn()/zoomOut()/resetZoom()` | ✅ `1`/no-ops | 🔧 `webContents.setZoomFactor` — real frontend zoom for free |
| `showContextMenuAtPoint(x, y, items, doc)` | ✅ no-op | 🔧 convert `ContextMenuDescriptor[]` → Electron `Menu.popup()`; reply via ⛔ `contextMenuItemSelected` |
| `setUseSoftMenu`/`setOpenNewWindowForPopups`/`setWhitelistedShortcuts` | ✅/🟡 | keybinding registry doable; shortcuts otherwise ignored |
| `setEyeDropperActive(active)` | ✅ no-op | 🔧 Chromium `EyeDropper` API (available in modern Electron), else screenshot picker; result via ⛔ `eyeDropperPickedColor` |
| `enterInspectElementMode` (event) | ⛔ | dispatch channel |
| `copyText(text)` | ✅ clipboard | already real |
| `openInNewTab(url)` | ✅ `window.open` | 🔧 better: `shell.openExternal` |
| `openSearchResultsInNewTab(query)` | ✅ no-op | 🔧 same |
| `showItemInFolder(path)` | 🟡 no-op | 🔧 one line: `shell.showItemInFolder` |
| `showCertificateViewer(chain)` | 🟡 | low value; stub |
| `reattach(cb)`, `readyForTest()`, `connectionReady()` | ✅ | fine |
| `initialTargetId()` | ✅ `null` | 🔧 return the active RN target id — enables multi-target UX |
| `isHostedMode()` | ✅ `true` | correct and load-bearing |

## Persistence: preferences, files, workspace

| Method | Status | Electron wiring |
| --- | --- | --- |
| `registerPreference` / `get{,All}Preference(s)` / `setPreference` / `removePreference` / `clearPreferences` | ✅ empty stubs | 🔧 back with `electron-store` — **do this first**: preferences drive frontend behavior (theme, experiments, panel sizing). Currently the frontend "forgets" everything |
| `getSyncInformation(cb)` | ✅ reports no-sync | fine — no Chrome Sync exists |
| `getHostConfig(cb)` | ✅ `{}` | 🔧 feed `experiments`, `disableAutosave`, etc. |
| `save/append/close(url, content…)` | ✅ anchor-download hack | 🔧 Electron `dialog.showSaveDialog` + fs; report via ⛔ `savedURL` |
| `requestFileSystems` / `add/removeFileSystem` / `isolatedFileSystem` / `upgradeDraggedFileSystemPermissions` / `connect/disconnectAutomaticFileSystem` | ✅ no-ops | 🔧 workspace folders: `dialog.showOpenDialog` + fs watch → ⛔ `fileSystemsLoaded/fileSystemAdded/…`. Needed for Sources autosave & overrides; nice-to-have |
| `indexPath` / `stopIndexing` / `searchInPath` | ✅ no-ops | 🔧 ripgrep/fs scan → ⛔ `indexing*`/`searchCompleted` |

## Frontend lifecycle & injected scripts

| Method | Status | Electron wiring |
| --- | --- | --- |
| `setInjectedScriptForOrigin(origin, script)` | ✅ repurposed as the **extension-API injection channel** | keep, but make async and scoped (see [../LIMITATIONS.md](../LIMITATIONS.md)) |
| `sendMessageToBackend(message)` | ✅ no-op | 🔌 **important**: the frontend→backend CDP escape hatch. Wiring it to the RN CDP socket is the honest way to build `devtools.network`/`inspectedWindow` ([features](../features/README.md)) |
| ⛔ `events` EventTarget + `InspectorFrontendAPI` dispatcher (`dispatchMessage`, `dispatchMessageChunk`, `showPanel`, `setInspectedTabId`, `contextMenuItemSelected`, `savedURL`, `revealSourceLine`, `keyEventUnhandled`, `colorThemeChanged`, `reloadInspectedPage`, …) | ⛔ `events: null` | **The biggest architectural gap** → [features/DISPATCH-CHANNEL.md](../features/DISPATCH-CHANNEL.md) |
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
