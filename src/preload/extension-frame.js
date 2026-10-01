// Extension-frame preload: runs inside every `rozenite://<extension-id>/...`
// iframe. Wires concrete transports/backends into the pure chrome-shim and
// installs, in order (see docs/ARCHITECTURE.md):
//
//   1. the frontend-provided injected script for this origin — evaluated
//      before page scripts, defines chrome.devtools.* (the fork's channel);
//   2. the chrome.* namespace (src/chrome-shim), whose network APIs ride the
//      host's CDP network model over async IPC
//      (src/main/network-service.js, docs/features/DEVTOOLS-NETWORK.md);
//   3. the two delivery channels: runtime messaging and network events.
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
  EXT_PANEL_CREATE,
  DEVTOOLS_EVAL,
  DEVTOOLS_RELOAD,
  NETWORK_SUBSCRIBE,
  NETWORK_GET_HAR,
  NETWORK_GET_STATUS,
  NETWORK_GET_BODY,
  NETWORK_DELIVER,
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

// chrome.devtools.network + chrome.webRequest, both fed by the host's CDP network
// model (src/main/network-service.js). Reads are async IPC; request lifecycle
// steps arrive as NETWORK_DELIVER pushes. Nothing is answered from a cache here
// and no body is invented: when the backend cannot report traffic, the host says
// so and the shim reports "no network data" (docs/features/DEVTOOLS-NETWORK.md).
// Every call waits for RUNTIME_REGISTER, because the host derives this frame's
// identity from the registered principal — an unregistered frame is not entitled
// to the app's traffic.
const registered = ipcRenderer.invoke(RUNTIME_REGISTER).catch(() => ({ ok: false }));
const asNetworkCaller = (call) => registered.then(() => call());

const networkBridge = createNetworkBridge({
  subscribe: () => asNetworkCaller(() => ipcRenderer.invoke(NETWORK_SUBSCRIBE)),
  getNetworkStatus: () => asNetworkCaller(() => ipcRenderer.invoke(NETWORK_GET_STATUS)),
  fetchHar: (options) => asNetworkCaller(() => ipcRenderer.invoke(NETWORK_GET_HAR, { options })),
  fetchBody: (requestId) =>
    asNetworkCaller(() => ipcRenderer.invoke(NETWORK_GET_BODY, { requestId })),
});

// chrome.runtime messaging transport over IPC (docs/features/RUNTIME-MESSAGING.md).
// Registration gates all traffic: until it resolves the frame is unknown to
// the router (methods above still call it, so pending sends simply queue on
// the promise).
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
  // chrome.devtools.panels.create -> host -> real frontend tab
  // (docs/features/DEVTOOLS-PANELS.md, src/main/panel-host.js).
  onPanelCreated: ({ title, pagePath }) => {
    ipcRenderer.invoke(EXT_PANEL_CREATE, { title, pagePath }).catch(() => {});
  },
  // chrome.devtools.inspectedWindow.eval -> host -> CDP Runtime.evaluate
  // (docs/features/INSPECTED-WINDOW.md, src/main/inspected-window.js).
  // The host never throws across IPC: a missing CDP session comes back as
  // ok:false with a message, which becomes Chrome's exceptionInfo.isError.
  evalInPage: (expression, options) =>
    ipcRenderer
      .invoke(DEVTOOLS_EVAL, { expression, options })
      .then((reply) =>
        reply && reply.ok
          ? { value: reply.value, exceptionInfo: reply.exceptionInfo || null }
          : {
              value: undefined,
              exceptionInfo: {
                isError: true,
                value: (reply && reply.error) || "inspectedWindow.eval failed",
              },
            }
      ),
  // chrome.devtools.inspectedWindow.reload -> host -> CDP Page.reload. Chrome
  // gives this API no callback and no promise, so the host's {ok, error} answer is
  // handed back for the shim to report — the preload adds no policy of its own.
  reloadInPage: (options) =>
    ipcRenderer.invoke(DEVTOOLS_RELOAD, { options }).then((reply) => reply || { ok: false }),
});

// Router -> frame deliveries (messages, ports).
ipcRenderer.on(RUNTIME_DELIVER, (_event, delivery) => chrome.handleDelivery(delivery));

// Network deliveries (devtools.network events + webRequest listeners). The host
// wraps them as {kind, payload}; the shim consumes the payload shape.
ipcRenderer.on(NETWORK_DELIVER, (_event, delivery) =>
  networkBridge.handleDelivery(delivery && delivery.payload ? delivery.payload : delivery)
);

// 1. Injected script for this origin (may not exist yet for some frames).
const script = ipcRenderer.sendSync(GET_INJECTED_SCRIPT, window.location.origin);
if (script) {
  contextBridge.executeInMainWorld({
    func: new Function(`${script}(0)`),
  });
}

// 2. chrome.* namespace. The merge runs in the main world: keep any
// chrome.* the injected frontend script defined (chrome.devtools.*), deep-
// merge runtime and devtools, and re-establish `lastError` as a LIVE getter —
// contextBridge cloning evaluates getters only once (chrome-shim/runtime.js).
contextBridge.exposeInMainWorld("chromeElectron", chrome);
contextBridge.executeInMainWorld({
  func: () => {
    const bridge = window.chromeElectron;
    const merged = { ...window.chrome, ...bridge };
    merged.runtime = { ...(window.chrome && window.chrome.runtime), ...bridge.runtime };
    merged.devtools = { ...(window.chrome && window.chrome.devtools), ...bridge.devtools };
    Object.defineProperty(merged.runtime, "lastError", {
      get: () => bridge.runtime._getLastLastError(),
    });
    delete merged.runtime._getLastLastError; // internal helper stays shim-side
    window.chrome = merged;
  },
});

// 3. Security-debt exposure (see header).
contextBridge.exposeInMainWorld("ipcRenderer", ipcRenderer);
