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
  createMemoryBackend,
  createNetworkBridge,
} = require("../chrome-shim");
const {
  GET_INJECTED_SCRIPT,
  RUNTIME_GET_MANIFEST,
  RUNTIME_REGISTER,
  RUNTIME_SEND_MESSAGE,
  RUNTIME_SEND_RESPONSE,
  RUNTIME_CONNECT,
  RUNTIME_PORT_POST,
  RUNTIME_PORT_CLOSE,
  RUNTIME_DELIVER,
  EVENTS,
} = require("../shared/ipc");

const extensionId = window.location.hostname; // id == hostname: load-bearing

// chrome.runtime.getPlatformInfo vocabulary.
const CHROME_OS = { darwin: "mac", win32: "win", linux: "linux" };
const CHROME_ARCH = { x64: "x86-64", arm64: "arm64", ia32: "x86-32" };

// chrome.runtime.getManifest: loaded from the host (id derived main-side
// from this frame's URL). Resolves well before any extension code runs;
// degrade to {} meanwhile.
let manifestCache = {};
ipcRenderer
  .invoke(RUNTIME_GET_MANIFEST)
  .then((manifest) => {
    manifestCache = manifest || {};
  })
  .catch(() => {});

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
    areaName === "session"
      ? createMemoryBackend() // deviation: per-frame, not extension-wide
      : storeBackend(new Store({ name: `extension-${extensionId}-${areaName}` })),
});

const networkBridge = createNetworkBridge({
  getContentBase64: () => FAKE_RESPONSE_BODY_BASE64,
});

// chrome.runtime messaging transport over IPC (docs/features/RUNTIME-MESSAGING.md).
// Registration gates all traffic: until it resolves the frame is unknown to
// the router (methods below still call it, so pending sends simply queue on
// the promise).
const registered = ipcRenderer.invoke(RUNTIME_REGISTER).catch(() => ({ ok: false }));

const transport = {
  sendMessage: ({ message }) =>
    registered.then((r) => (r.ok ? ipcRenderer.invoke(RUNTIME_SEND_MESSAGE, { message }) : undefined)),
  respond: ({ requestId, response }) =>
    registered.then(() => ipcRenderer.invoke(RUNTIME_SEND_RESPONSE, { requestId, response })),
  connect: ({ name }) =>
    registered.then((r) =>
      r.ok ? ipcRenderer.invoke(RUNTIME_CONNECT, { name }) : { ok: false, error: "Could not establish connection." }
    ),
  portPost: ({ portId, message }) =>
    registered.then(() => ipcRenderer.invoke(RUNTIME_PORT_POST, { portId, message })),
  portClose: ({ portId }) =>
    registered.then(() => ipcRenderer.invoke(RUNTIME_PORT_CLOSE, { portId })),
};

// [FAKE] transport: the frontend broadcasts RequestStarted/RequestFinished
// via postMessage (frontend-host "Events"); feed the pure bridge.
window.addEventListener("message", ({ data }) => {
  if (data && typeof data === "object" && typeof data.event === "string") {
    networkBridge.onFrontendEvent(data.event, data.data);
  }
});

const chrome = createChromeNamespace({
  extensionId,
  getManifest: () => manifestCache,
  platform: {
    os: CHROME_OS[process.platform] || "linux",
    arch: CHROME_ARCH[process.arch] || "unknown",
  },
  storage,
  networkBridge,
  transport,
});

// Router -> frame deliveries (messages, ports).
ipcRenderer.on(RUNTIME_DELIVER, (_event, delivery) => chrome.handleDelivery(delivery));

// 1. Injected script for this origin (may not exist yet for some frames).
const script = ipcRenderer.sendSync(GET_INJECTED_SCRIPT, window.location.origin);
if (script) {
  contextBridge.executeInMainWorld({
    func: new Function(`${script}(0)`),
  });
}

// 2. chrome.* namespace. The merge runs in the main world: keep any
// chrome.* the injected frontend script defined (chrome.devtools.*), deep-
// merge runtime, and re-establish `lastError` as a LIVE getter — contextBridge
// cloning evaluates getters only once (chrome-shim/runtime.js).
contextBridge.exposeInMainWorld("chromeElectron", chrome);
contextBridge.executeInMainWorld({
  func: () => {
    const bridge = window.chromeElectron;
    const merged = { ...window.chrome, ...bridge };
    merged.runtime = { ...(window.chrome && window.chrome.runtime), ...bridge.runtime };
    Object.defineProperty(merged.runtime, "lastError", {
      get: () => bridge.runtime._getLastLastError(),
    });
    delete merged.runtime._getLastLastError; // internal helper stays shim-side
    window.chrome = merged;
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
