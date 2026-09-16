const { contextBridge, ipcRenderer, clipboard, shell } = require("electron");
const { getChromeNamespace } = require("./chrome-runtime.js");

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
      // console.log("setInjectedScriptForOrigin", origin, script);

      // Store the script in the main process
      try {
        ipcRenderer.sendSync("store-injected-script", origin, script);
        console.log(`[Preload] Stored script for origin: ${origin}`);
      } catch (error) {
        console.error("[Preload] Failed to store script:", error);
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
    // Add any other methods as needed

    // Debug utilities
    async getAllStoredScripts() {
      try {
        return await ipcRenderer.invoke("get-all-injected-scripts");
      } catch (error) {
        console.error("[Preload] Failed to get all stored scripts:", error);
        return {};
      }
    },

    async getAllStoredOrigins() {
      try {
        return await ipcRenderer.invoke("get-all-origins");
      } catch (error) {
        console.error("[Preload] Failed to get all stored origins:", error);
        return [];
      }
    },

    async clearAllStoredScripts() {
      try {
        return await ipcRenderer.invoke("clear-injected-scripts");
      } catch (error) {
        console.error("[Preload] Failed to clear stored scripts:", error);
        return false;
      }
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

if (protocol !== "rozenite:") {
  return;
}

console.log("extensionId", extensionId);
const chrome = getChromeNamespace(extensionId);

const script = ipcRenderer.sendSync(
  "get-injected-script",
  window.location.origin
);

if (script) {
  console.log("script", script);
  contextBridge.executeInMainWorld({
    func: new Function(`${script}(0)`),
  });
}

contextBridge.exposeInMainWorld("chromeElectron", chrome);
contextBridge.exposeInMainWorld("hello", "world");
contextBridge.executeInMainWorld({
  func: () => {
    window.chrome = {
      ...window.chrome,
      ...window.chromeElectron,
    };
  },
});
contextBridge.exposeInMainWorld("ipcRenderer", ipcRenderer);
contextBridge.exposeInMainWorld("Events", {
  addListener: (event, callback) => {
    ipcRenderer.on("Events", (receivedEvent, data) => {
      if (event !== receivedEvent) {
        return;
      }

      callback(data);
    });
  },
  removeListener: (event, callback) => {
    ipcRenderer.removeListener("Events", callback);
  },
});

console.log("preload.js with events loaded");
