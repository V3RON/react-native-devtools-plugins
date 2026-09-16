// Extension-frame preload: runs inside every `rozenite://<extension-id>/...`
// iframe. Wires concrete transports/backends into the pure chrome-shim and
// installs, in order (see docs/ARCHITECTURE.md):
//
//   1. the frontend-provided injected script for this origin — evaluated
//      before page scripts, defines chrome.devtools.* (the fork's channel);
//   2. the chrome.* namespace (src/chrome-shim);
//   3. the Events relay over the main-process IPC channel
//      ([FAKE] transport, until the real dispatch channel lands).
//
// SECURITY DEBT (docs/LIMITATIONS.md): exposing ipcRenderer raw and
// evaluating scripts via new Function gives extension frames full Node
// privileges. Must be replaced by a validated, per-extension IPC layer
// before the API surface grows further.

const { contextBridge, ipcRenderer } = require("electron");
const { default: Store } = require("electron-store");
const {
  createChromeNamespace,
  createExtensionStorage,
  createNetworkBridge,
} = require("../chrome-shim");
const { GET_INJECTED_SCRIPT, EVENTS } = require("../shared/ipc");

const extensionId = window.location.hostname; // id == hostname: load-bearing

// [FAKE] placeholder response body so network-inspector extensions have
// something to render. Replaced by real Network.getResponseBody via the
// dispatch channel (docs/features/DEVTOOLS-NETWORK.md).
const FAKE_RESPONSE_BODY_BASE64 =
  "eyJkYXRhIjp7ImNoYXJhY3RlciI6eyJpZCI6IjEiLCJuYW1lIjoiUmljayBTYW5jaGV6Iiwic3RhdHVzIjoiQWxpdmUiLCJzcGVjaWVzIjoiSHVtYW4iLCJnZW5kZXIiOiJNYWxlIiwib3JpZ2luIjp7Im5hbWUiOiJFYXJ0aCAoQy0xMzcpIn0sImxvY2F0aW9uIjp7Im5hbWUiOiJDaXRhZGVsIG9mIFJpY2tzIn19fX0=";

// electron-store -> chrome-shim StorageBackend adapter.
// NOTE: one Store instance per frame per area races on the shared JSON file;
// swap for a main-process-backed backend (docs/LIMITATIONS.md).
const storeBackend = (store) => ({
  getAll: () => store.store,
  get: (key) => store.get(key),
  set: (items) => store.set(items),
  delete: (key) => store.delete(key),
  clear: () => store.clear(),
});

const storage = createExtensionStorage({
  createBackend: (areaName) =>
    storeBackend(new Store({ name: `extension-${extensionId}-${areaName}` })),
});

const networkBridge = createNetworkBridge({
  getContentBase64: () => FAKE_RESPONSE_BODY_BASE64,
});

// [FAKE] transport: the frontend broadcasts RequestStarted/RequestFinished
// via postMessage (frontend-host "Events"); feed the pure bridge.
window.addEventListener("message", ({ data }) => {
  if (data && typeof data === "object" && typeof data.event === "string") {
    networkBridge.onFrontendEvent(data.event, data.data);
  }
});

const chrome = createChromeNamespace({ storage, networkBridge });

// 1. Injected script for this origin (may not exist yet for some frames).
const script = ipcRenderer.sendSync(GET_INJECTED_SCRIPT, window.location.origin);
if (script) {
  contextBridge.executeInMainWorld({
    func: new Function(`${script}(0)`),
  });
}

// 2. chrome.* namespace.
contextBridge.exposeInMainWorld("chromeElectron", chrome);
contextBridge.executeInMainWorld({
  func: () => {
    window.chrome = {
      ...window.chrome,
      ...window.chromeElectron,
    };
  },
});

// 3. Security-debt exposure (see header) + Events relay.
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
