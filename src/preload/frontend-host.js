// InspectorFrontendHost implementation for the DevTools frontend (main frame).
//
// Each cluster is labeled with its kind, mirroring the status table in
// docs/api/INSPECTOR-FRONTEND-HOST.md:
//
//   [REAL]  genuine behavior of this Electron host
//   [FAKE]  synthetic/simplified behavior — looks real, is not (docs/LIMITATIONS.md)
//   [STUB]  intentionally inert (upstream auto-stub semantics; safe to keep)
//
// Not implemented at all: the host -> frontend dispatch channel
// (`events` + InspectorFrontendAPI) — docs/features/DISPATCH-CHANNEL.md.

const { contextBridge, ipcRenderer } = require("electron");
const { STORE_INJECTED_SCRIPT } = require("../shared/ipc");

const InspectorFrontendHost = {
  // ⛔ host -> frontend event dispatch channel; see docs/features/DISPATCH-CHANNEL.md
  events: null,

  // ── [FAKE] platform identity ────────────────────────────────────────────
  platform() {
    // [FAKE] should report the real process.platform
    return "linux";
  },
  isHostedMode() {
    // [REAL] load-bearing: keeps the frontend in hosted (embedded) mode
    return true;
  },

  // ── [REAL] frontend lifecycle ────────────────────────────────────────────
  loadCompleted() {},
  bringToFront() {
    // [STUB] could focus the real BrowserWindow
    console.log("bringToFront");
  },
  closeWindow() {
    // [STUB] could close the real BrowserWindow
    console.log("closeWindow");
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

  // ── [REAL] injected-script channel ───────────────────────────────────────
  // The channel the fork uses to ship chrome.devtools.* implementations into
  // extension frames — see docs/ARCHITECTURE.md.
  async setInjectedScriptForOrigin(origin, script) {
    try {
      ipcRenderer.sendSync(STORE_INJECTED_SCRIPT, origin, script);
    } catch (error) {
      console.error("[Preload] Failed to store injected script:", error);
    }
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

  // ── [STUB] preferences (frontend "forgets" everything; first roadmap win) ─
  registerPreference(name, options) {},
  getPreferences(callback) {
    if (callback) callback({});
  },
  getPreference(name, callback) {
    if (callback) callback("");
  },
  setPreference(name, value) {},
  removePreference(name) {},
  clearPreferences() {},
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
    return 1;
  },
  zoomIn() {},
  zoomOut() {},
  resetZoom() {},
  setWhitelistedShortcuts(shortcuts) {},
  setEyeDropperActive(active) {},
  showContextMenuAtPoint(x, y, items, document) {},
  setOpenNewWindowForPopups(value) {},
  setAddExtensionCallback(callback) {},

  // ── [STUB] frontend -> backend CDP escape hatch ──────────────────────────
  // Important stub: wiring this to the RN CDP socket is the honest way to
  // build devtools.network / inspectedWindow (docs/features/DISPATCH-CHANNEL.md)
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

// ── [FAKE] network-events bridge to extension frames ────────────────────────
// The frontend broadcasts RequestStarted/RequestFinished here; extension-frame
// chrome.webRequest listeners consume them. Temporary transport, replaced by
// the real dispatch channel (docs/features/DISPATCH-CHANNEL.md).
contextBridge.exposeInMainWorld("Events", {
  send: (event, data) => {
    const iframes = document.querySelectorAll("iframe");
    iframes.forEach((iframe) => {
      iframe.contentWindow.postMessage({ event, data }, "*");
    });
  },
});

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
