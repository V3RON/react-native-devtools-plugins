const { contextBridge, ipcRenderer } = require("electron");
const { getChromeNamespace } = require("./chrome-runtime.js");
const { EXTENSION_SCHEME } = require("./src/shared/protocol");
const {
  STORE_INJECTED_SCRIPT,
  GET_INJECTED_SCRIPT,
  EVENTS,
} = require("./src/shared/ipc");

if (process.isMainFrame) {
  const InspectorFrontendHost = {
    events: null,
    platform() {
      return "linux";
    },

    loadCompleted() {},
    bringToFront() {
      console.log("bringToFront");
    },
    closeWindow() {
      console.log("closeWindow");
    },
    setIsDocked(isDocked, callback) {
      if (callback) callback();
    },
    showSurvey(trigger, callback) {
      if (callback) callback({ surveyShown: false });
    },
    canShowSurvey(trigger, callback) {
      if (callback) callback({ canShowSurvey: false });
    },
    setInspectedPageBounds(bounds) {},
    inspectElementCompleted() {},
    async setInjectedScriptForOrigin(origin, script) {
      // Store the script in the main process (see docs/ARCHITECTURE.md:
      // this is the channel the frontend uses to inject chrome.devtools.*
      // implementations into extension frames).
      try {
        ipcRenderer.sendSync(STORE_INJECTED_SCRIPT, origin, script);
      } catch (error) {
        console.error("[Preload] Failed to store injected script:", error);
      }
    },
    inspectedURLChanged(url) {
      document.title = "DevTools - " + (url || "");
    },
    copyText(text) {
      if (navigator.clipboard) navigator.clipboard.writeText(text || "");
      console.log("copyText", text);
    },
    openInNewTab(url) {
      window.open(url, "_blank");
    },
    openSearchResultsInNewTab(query) {},
    showItemInFolder(fileSystemPath) {},
    save(url, content, forceSaveAs, isBase64) {
      // Basic download
      const blob = new Blob([content], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = url || "untitled.txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      console.log("save", { url, content, forceSaveAs, isBase64 });
    },
    append(url, content) {},
    close(url) {},
    sendMessageToBackend(message) {},
    recordCountHistogram(
      histogramName,
      sample,
      min,
      exclusiveMax,
      bucketSize
    ) {},
    recordEnumeratedHistogram(actionName, actionCode, bucketSize) {},
    recordPerformanceHistogram(histogramName, duration) {},
    recordUserMetricsAction(umaName) {},
    connectAutomaticFileSystem(
      fileSystemPath,
      fileSystemUUID,
      addIfMissing,
      callback
    ) {
      if (callback) callback({ success: false });
    },
    disconnectAutomaticFileSystem(fileSystemPath) {},
    requestFileSystems() {},
    addFileSystem(type) {},
    removeFileSystem(fileSystemPath) {},
    isolatedFileSystem(fileSystemId, registeredName) {
      return null;
    },
    loadNetworkResource(url, headers, streamId, callback) {
      if (callback) callback({ statusCode: 404 });
    },
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
      if (callback)
        callback({ isSyncActive: false, arePreferencesSynced: false });
    },
    getHostConfig(callback) {
      if (callback) callback({});
    },
    upgradeDraggedFileSystemPermissions(fileSystem) {},
    indexPath(requestId, fileSystemPath, excludedFolders) {},
    stopIndexing(requestId) {},
    searchInPath(requestId, fileSystemPath, query) {},
    zoomFactor() {
      return 1;
    },
    zoomIn() {},
    zoomOut() {},
    resetZoom() {},
    setWhitelistedShortcuts(shortcuts) {},
    setEyeDropperActive(active) {},
    showCertificateViewer(certChain) {},
    reattach(callback) {
      if (callback) callback();
    },
    readyForTest() {},
    connectionReady() {},
    setOpenNewWindowForPopups(value) {},
    setDevicesDiscoveryConfig(config) {},
    setDevicesUpdatesEnabled(enabled) {},
    openRemotePage(browserId, url) {},
    openNodeFrontend() {},
    showContextMenuAtPoint(x, y, items, document) {},
    isHostedMode() {
      return true;
    },
    setAddExtensionCallback(callback) {},
    async initialTargetId() {
      return null;
    },
    doAidaConversation(request, streamId, callback) {
      if (callback) callback({ error: "Not implemented" });
    },
    registerAidaClientEvent(request, callback) {
      if (callback) callback({ error: "Not implemented" });
    },
    recordImpression(event) {},
    recordResize(event) {},
    recordClick(event) {},
    recordHover(event) {},
    recordDrag(event) {},
    recordChange(event) {},
    recordKeyDown(event) {},
    recordSettingAccess(event) {},
    performActionOnRemotePage(action, browserId, targetId, callback) {
      // No-op stub; log for debug
      console.log("performActionOnRemotePage", { action, browserId, targetId });
      if (callback) callback({ error: "Not implemented" });
    },
  };

  contextBridge.exposeInMainWorld(
    "InspectorFrontendHostElectron",
    InspectorFrontendHost
  );

  contextBridge.exposeInMainWorld("Events", {
    send: (event, data) => {
      // Get all iframes and send the message to them
      const iframes = document.querySelectorAll("iframe");
      iframes.forEach((iframe) => {
        iframe.contentWindow.postMessage({ event, data }, "*");
      });
    },
  });

  contextBridge.executeInMainWorld({
    func: () => {
      window.InspectorFrontendHost = {
        ...window.InspectorFrontendHostElectron,
      };
    },
  });

  return;
}

const protocol = window.location.protocol;
const extensionId = window.location.hostname;

if (protocol !== `${EXTENSION_SCHEME}:`) {
  return;
}

const chrome = getChromeNamespace(extensionId);

const script = ipcRenderer.sendSync(GET_INJECTED_SCRIPT, window.location.origin);

if (script) {
  contextBridge.executeInMainWorld({
    func: new Function(`${script}(0)`),
  });
}

contextBridge.exposeInMainWorld("chromeElectron", chrome);
contextBridge.executeInMainWorld({
  func: () => {
    window.chrome = {
      ...window.chrome,
      ...window.chromeElectron,
    };
  },
});
contextBridge.exposeInMainWorld("ipcRenderer", ipcRenderer);
contextBridge.exposeInMainWorld(EVENTS, {
  addListener: (event, callback) => {
    ipcRenderer.on(EVENTS, (receivedEvent, data) => {
      if (event !== receivedEvent) {
        return;
      }

      callback(data);
    });
  },
  removeListener: (event, callback) => {
    ipcRenderer.removeListener(EVENTS, callback);
  },
});
