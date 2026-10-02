// InspectorFrontendHost implementation for the DevTools frontend (main frame).
//
// Each cluster is labeled with its kind, mirroring the status table in
// docs/api/INSPECTOR-FRONTEND-HOST.md:
//
//   [REAL]  genuine behavior of this Electron host
//   [FAKE]  synthetic/simplified behavior — looks real, is not (docs/LIMITATIONS.md)
//   [STUB]  intentionally inert (upstream auto-stub semantics; safe to keep)
//
// The host -> frontend dispatch channel is LIVE (docs/features/DISPATCH-CHANNEL.md):
// main process events arrive over HOST_EVENT and are invoked on the frontend's
// own window.InspectorFrontendAPI. Context menus are the first round-trip
// consumer (contextMenuItemSelected / contextMenuCleared).
//
// `sendMessageToBackend` is a no-op **by design, not by omission**: the frontend
// URL carries `?ws=` (src/main/config.js), so the frontend build selects
// core/sdk/WebSocketConnection and talks to the CDP socket itself — MainConnection,
// the only user of sendMessageToBackend, is never constructed. The host reaches
// the backend on that socket instead (src/main/cdp-bridge.js).

const { contextBridge, ipcRenderer, webFrame } = require("electron");
const {
  HOST_EVENT,
  SHOW_CONTEXT_MENU,
  PREF_REGISTER,
  PREF_GET,
  PREF_GET_ALL,
  PREF_SET,
  PREF_REMOVE,
  PREF_CLEAR,
  WINDOW_BRING_TO_FRONT,
  WINDOW_CLOSE,
} = require("../shared/ipc");

// ── dispatch channel receiver ───────────────────────────────────────────────
// main -> HOST_EVENT -> window.InspectorFrontendAPI[name](...args).
// InspectorFrontendAPI is defined by the frontend itself and only exists
// after module init; events fired earlier are dropped (same as Chrome —
// the host only raises events once the frontend is up).
ipcRenderer.on(HOST_EVENT, (_event, { name, args }) => {
  contextBridge.executeInMainWorld({
    func: (eventName, eventArgs) => {
      const api = window.InspectorFrontendAPI;
      const method = api && api[eventName];
      if (typeof method !== "function") {
        console.warn(`[Preload] InspectorFrontendAPI.${eventName} not ready`);
        return;
      }
      method.apply(api, eventArgs);
    },
    arguments: [name, args || []],
  });
});

const InspectorFrontendHost = {
  // Dispatch channel is live: see the HOST_EVENT listener above
  // (docs/features/DISPATCH-CHANNEL.md).
  events: null,

  // ── platform identity ────────────────────────────────────────────────────
  platform() {
    // [REAL] "windows" | "linux" | "mac" (Chrome's contract)
    if (process.platform === "darwin") return "mac";
    if (process.platform === "win32") return "windows";
    return "linux";
  },
  isHostedMode() {
    // [REAL] load-bearing: keeps the frontend in hosted (embedded) mode
    return true;
  },

  // ── [REAL] frontend lifecycle ────────────────────────────────────────────
  loadCompleted() {},
  bringToFront() {
    // [REAL] focuses the DevTools BrowserWindow via main
    ipcRenderer.invoke(WINDOW_BRING_TO_FRONT);
  },
  closeWindow() {
    // [REAL] closes the DevTools BrowserWindow via main
    ipcRenderer.invoke(WINDOW_CLOSE);
  },
  inspectedURLChanged(url) {
    // [REAL]
    document.title = "DevTools - " + (url || "");
  },
  reattach(callback) {
    if (callback) callback();
  },
  readyForTest() {},
  connectionReady() {},
  async initialTargetId() {
    // [STUB] could return the active RN target id
    return null;
  },

  // ── [STUB] injected-script channel (deliberately inert) ──────────────────
  // The fork's channel for shipping a `chrome.devtools.*` implementation into
  // extension frames. It no longer exists here: `chrome.devtools.*` is
  // implemented shell-side (src/chrome-shim/devtools.js), so there is no script
  // to hand over, and the host will not evaluate one it is handed — the path
  // used to store the string and `new Function` it in every frame of that origin
  // (docs/features/DEVTOOLS-PANELS.md, src/shared/ipc.js house rule).
  // Accepting and ignoring the call keeps the frontend's call site working.
  async setInjectedScriptForOrigin(origin, script) {
    // async like the previous implementation, so a frontend that awaits it is
    // not surprised by an undefined return.
    void origin;
    void script;
  },

  // ── [REAL/simple] clipboard, tabs, files ─────────────────────────────────
  copyText(text) {
    // [REAL]
    if (navigator.clipboard) navigator.clipboard.writeText(text || "");
  },
  openInNewTab(url) {
    // [FAKE] window.open inside the DevTools window; shell.openExternal is better
    window.open(url, "_blank");
  },
  save(url, content, forceSaveAs, isBase64) {
    // [FAKE] basic anchor-download hack; should use Electron's save dialog
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = url || "untitled.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  },
  append(url, content) {},
  close(url) {},
  showItemInFolder(fileSystemPath) {},

  // ── [REAL] preferences (persisted via electron-store) ───────────────────
  // Frontend state (theme, experiments, panel sizing) survives restarts.
  // Async IPC; callbacks fire on resolution (Chrome's async contract).
  registerPreference(name, options) {
    ipcRenderer.invoke(PREF_REGISTER, name, options === undefined ? null : options);
  },
  getPreferences(callback) {
    ipcRenderer.invoke(PREF_GET_ALL).then((all) => {
      if (callback) callback(all);
    });
  },
  getPreference(name, callback) {
    ipcRenderer.invoke(PREF_GET, name).then((value) => {
      if (callback) callback(value);
    });
  },
  setPreference(name, value) {
    ipcRenderer.invoke(PREF_SET, name, value);
  },
  removePreference(name) {
    ipcRenderer.invoke(PREF_REMOVE, name);
  },
  clearPreferences() {
    ipcRenderer.invoke(PREF_CLEAR);
  },
  getSyncInformation(callback) {
    // [REAL] honest: there is no Chrome Sync here
    if (callback)
      callback({ isSyncActive: false, arePreferencesSynced: false });
  },
  getHostConfig(callback) {
    // [STUB] could feed experiments, disableAutosave, etc.
    if (callback) callback({});
  },

  // ── [STUB] workspace / filesystem APIs ───────────────────────────────────
  connectAutomaticFileSystem(fileSystemPath, fileSystemUUID, addIfMissing, callback) {
    if (callback) callback({ success: false });
  },
  disconnectAutomaticFileSystem(fileSystemPath) {},
  requestFileSystems() {},
  addFileSystem(type) {},
  removeFileSystem(fileSystemPath) {},
  isolatedFileSystem(fileSystemId, registeredName) {
    return null;
  },
  upgradeDraggedFileSystemPermissions(fileSystem) {},
  indexPath(requestId, fileSystemPath, excludedFolders) {},
  stopIndexing(requestId) {},
  searchInPath(requestId, fileSystemPath, query) {},
  loadNetworkResource(url, headers, streamId, callback) {
    if (callback) callback({ statusCode: 404 });
  },

  // ── [STUB] window/UI integration ─────────────────────────────────────────
  setIsDocked(isDocked, callback) {
    if (callback) callback();
  },
  setInspectedPageBounds(bounds) {},
  inspectElementCompleted() {},
  openSearchResultsInNewTab(query) {},
  showCertificateViewer(certChain) {},
  zoomFactor() {
    // [REAL] actual Electron webFrame zoom
    return webFrame.getZoomFactor();
  },
  zoomIn() {
    webFrame.setZoomFactor(Math.min(webFrame.getZoomFactor() + 0.5, 5));
  },
  zoomOut() {
    webFrame.setZoomFactor(Math.max(webFrame.getZoomFactor() - 0.5, 0.25));
  },
  resetZoom() {
    webFrame.setZoomFactor(1);
  },
  setWhitelistedShortcuts(shortcuts) {},
  setEyeDropperActive(active) {},
  showContextMenuAtPoint(x, y, items) {
    // [REAL] native Electron menu; selection comes back through the
    // dispatch channel as contextMenuItemSelected(id) / contextMenuCleared.
    // JSON-clone: items must be a plain serializable ContextMenuDescriptor[].
    ipcRenderer.invoke(SHOW_CONTEXT_MENU, {
      x,
      y,
      items: JSON.parse(JSON.stringify(items || [])),
    });
  },
  setOpenNewWindowForPopups(value) {},
  setAddExtensionCallback(callback) {},

  // ── frontend -> backend CDP: structurally unused here ────────────────────
  // Chrome's frontend uses this only in MainConnection (InspectorFrontendHost
  // "hosted over IPC"). Our frontend URL carries ?ws=, so the frontend build
  // builds a core/sdk/WebSocketConnection to that host:port and never calls
  // through here — verified against the bundle we load: the connection factory
  // (core/sdk/sdk.js) selects WebSocketConnection whenever the `ws`/`wss` query
  // param is present. The host therefore reaches the RN backend on that socket:
  // src/main/cdp-bridge.js owns it and answers host commands by message id
  // (docs/features/INSPECTED-WINDOW.md, docs/features/DISPATCH-CHANNEL.md).
  sendMessageToBackend(message) {},

  // ── [STUB] device discovery (sleeper feature for an RN host) ─────────────
  setDevicesDiscoveryConfig(config) {},
  setDevicesUpdatesEnabled(enabled) {},
  openRemotePage(browserId, url) {},
  openNodeFrontend() {},
  performActionOnRemotePage(action, browserId, targetId, callback) {
    console.log("performActionOnRemotePage", { action, browserId, targetId });
    if (callback) callback({ error: "Not implemented" });
  },

  // ── [STUB] telemetry (safe to remain no-ops forever) ─────────────────────
  recordCountHistogram(histogramName, sample, min, exclusiveMax, bucketSize) {},
  recordEnumeratedHistogram(actionName, actionCode, bucketSize) {},
  recordPerformanceHistogram(histogramName, duration) {},
  recordUserMetricsAction(umaName) {},
  recordImpression(event) {},
  recordResize(event) {},
  recordClick(event) {},
  recordHover(event) {},
  recordDrag(event) {},
  recordChange(event) {},
  recordKeyDown(event) {},
  recordSettingAccess(event) {},

  // ── [STUB] Chrome built-in AI (AIDA) and surveys ─────────────────────────
  doAidaConversation(request, streamId, callback) {
    if (callback) callback({ error: "Not implemented" });
  },
  registerAidaClientEvent(request, callback) {
    if (callback) callback({ error: "Not implemented" });
  },
  showSurvey(trigger, callback) {
    if (callback) callback({ surveyShown: false });
  },
  canShowSurvey(trigger, callback) {
    if (callback) callback({ canShowSurvey: false });
  },
};

// context-bridge bridge: exposeInMainWorld proxies functions; the frontend
// wants a plain window.InspectorFrontendHost object instead.
contextBridge.exposeInMainWorld("InspectorFrontendHostElectron", InspectorFrontendHost);
contextBridge.executeInMainWorld({
  func: () => {
    window.InspectorFrontendHost = {
      ...window.InspectorFrontendHostElectron,
    };
  },
});
