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
// URL carries `?ws=` (src/electron/shell/frontend-target.js), so the frontend build selects
// core/sdk/WebSocketConnection and talks to Metro's inspector proxy itself — MainConnection,
// the only user of sendMessageToBackend, is never constructed. The extension host opens
// its own second session to the same target (src/electron/extensions/internal/cdp/cdp-session.js).

const { contextBridge, ipcRenderer, webFrame } = require("electron");
const {
  HOST_EVENT,
  SHOW_CONTEXT_MENU,
  WINDOW_BRING_TO_FRONT,
  WINDOW_CLOSE,
  HOST_SAVE,
  HOST_APPEND,
  HOST_CLOSE_FILE,
  HOST_OPEN_EXTERNAL,
  HOST_CONFIG,
} = require("./channels");

// ── dispatch channel receiver ───────────────────────────────────────────────
// main -> HOST_EVENT -> window.InspectorFrontendAPI[name](...args).
// InspectorFrontendAPI is defined by the frontend itself and only exists
// after module init; events fired earlier are dropped (same as Chrome —
// the host only raises events once the frontend is up).
//
// The option is `args` (Electron's ExecutionScript). It was spelled `arguments`, which
// Electron ignores: the function ran with NO arguments, so every dispatched event hit
// the "not ready" branch below as `InspectorFrontendAPI.undefined`.
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
    args: [name, args || []],
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
  // implemented shell-side (src/electron/extensions/internal/shim/devtools.js), so there is no script
  // to hand over, and the host will not evaluate one it is handed — the path
  // used to store the string and `new Function` it in every frame of that origin
  // (docs/features/DEVTOOLS-PANELS.md, src/electron/extensions/internal/broker/channels.js house rule).
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
    // [REAL] the OS browser through main's http(s)-only allowlist
    // (src/electron/extensions/internal/services/external-open.js). This used to be `window.open`, which made a new
    // window of THIS shell with the DevTools preload attached.
    ipcRenderer
      .invoke(HOST_OPEN_EXTERNAL, { url: String(url) })
      .then((reply) => {
        if (reply && reply.ok === false) {
          console.warn(`InspectorFrontendHost.openInNewTab: ${reply.error}`);
        }
      })
      .catch((error) => console.warn(`InspectorFrontendHost.openInNewTab: ${error && error.message}`));
  },
  // save / append / close are one family (src/electron/shell/host-files.js). `url` is the
  // frontend's own key for the file, sent verbatim: main derives the dialog's default
  // name from it, remembers the chosen path per url, and answers on the dispatch
  // channel with savedURL(url, path) / canceledSaveURL(url) / appendedToURL(url) — the
  // events the frontend's FileManager waits for. Chrome's methods return nothing, so
  // a failure is logged here rather than thrown at a caller that cannot catch it.
  save(url, content, forceSaveAs, isBase64) {
    // [REAL] dialog on the first save of a url (or `forceSaveAs`), then the same path.
    ipcRenderer
      .invoke(HOST_SAVE, { url, content, forceSaveAs, isBase64 })
      .then((reply) => {
        if (reply && reply.ok === false && reply.canceled !== true) {
          console.warn(`InspectorFrontendHost.save: ${reply.error}`);
        }
      })
      .catch((error) => console.warn(`InspectorFrontendHost.save: ${error && error.message}`));
  },
  append(url, content) {
    // [REAL] appends to the file a prior save of `url` chose; ignored for any other url.
    ipcRenderer
      .invoke(HOST_APPEND, { url, content })
      .catch((error) => console.warn(`InspectorFrontendHost.append: ${error && error.message}`));
  },
  close(url) {
    // [REAL] forgets the path `save` remembered for `url`.
    ipcRenderer
      .invoke(HOST_CLOSE_FILE, { url })
      .catch((error) => console.warn(`InspectorFrontendHost.close: ${error && error.message}`));
  },
  // [STUB] no OS file-revealer is wired for a path the frontend names. It stays inert
  // rather than doing something adjacent-looking (bringing this window forward would
  // read as "the file was revealed"), and says why once per call site.
  showItemInFolder(fileSystemPath) {
    console.warn(
      `InspectorFrontendHost.showItemInFolder does nothing: ${String(fileSystemPath || "")} is not a path this host tracks.`
    );
  },

  // ── preferences: NOT here ────────────────────────────────────────────────
  // registerPreference / getPreference(s) / setPreference / removePreference /
  // clearPreferences are installed in the MAIN world below, on the page's own
  // `localStorage`, exactly as the stock frontend's InspectorFrontendHostStub does
  // and as @react-native/debugger-shell therefore stores them. Same store, so
  // settings do not change between this shell and the upstream one.
  getSyncInformation(callback) {
    // [REAL] honest: there is no Chrome Sync here
    if (callback)
      callback({ isSyncActive: false, arePreferencesSynced: false });
  },
  getHostConfig(callback) {
    // [REAL] the frontend's feature gates for this embedder (src/electron/shell/host-config.js).
    // `{}` on failure is the frontend's own "nothing configured" answer.
    ipcRenderer
      .invoke(HOST_CONFIG)
      .catch(() => ({}))
      .then((config) => {
        if (callback) callback(config || {});
      });
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
  // param is present. The extension host reaches the RN backend on its own session
  // instead (src/electron/extensions/internal/cdp/cdp-session.js,
  // docs/features/INSPECTED-WINDOW.md).
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
//
// Preferences are added here, in the main world, rather than on the bridged object:
// they are the stock InspectorFrontendHostStub's methods, verbatim in behavior
// (front_end/core/host/InspectorFrontendHost.ts) — the page's own `localStorage`,
// synchronous callbacks, `registerPreference` a no-op. Matching the stub is the
// point: it is where @react-native/debugger-shell keeps the user's DevTools settings
// (theme, experiments, panel layout), so this shell reads and writes the same store
// instead of a second one. Note the store is per ORIGIN: a frontend served from
// another host/port starts with its own settings, as it does upstream.
contextBridge.executeInMainWorld({
  func: () => {
    window.InspectorFrontendHost = {
      ...window.InspectorFrontendHostElectron,
      registerPreference(name, options) {},
      getPreferences(callback) {
        const prefs = {};
        for (const name in window.localStorage) {
          prefs[name] = window.localStorage[name];
        }
        callback(prefs);
      },
      getPreference(name, callback) {
        callback(window.localStorage[name]);
      },
      setPreference(name, value) {
        window.localStorage[name] = value;
      },
      removePreference(name) {
        delete window.localStorage[name];
      },
      clearPreferences() {
        window.localStorage.clear();
      },
    };
  },
});
