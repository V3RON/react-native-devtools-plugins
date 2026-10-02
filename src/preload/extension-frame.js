// Extension-frame preload: runs inside every `rozenite://<extension-id>/...`
// iframe. Wires concrete transports/backends into the pure chrome-shim and
// installs the chrome.* namespace (see docs/ARCHITECTURE.md).
//
// What is deliberately NOT here any more:
//
//   - no raw `ipcRenderer` exposure. The frame gets named, validated channels
//     only; the page world has no Node-level IPC handle (asserted by
//     tests/extension-frame-electron.test.js and live in
//     extensions/sample-extension/panel.html).
//   - no injected-script fetch + `new Function`. The stock frontend no longer
//     ships a per-origin script, because chrome.devtools.* is implemented
//     shell-side in src/chrome-shim/devtools.js
//     (docs/features/DEVTOOLS-PANELS.md), so the whole channel — including its
//     two sendSync exceptions — is gone. `InspectorFrontendHost
//     .setInjectedScriptForOrigin` is a documented no-op.
//
// The frame talks to main through `invoke` only, and the two push channels
// (RUNTIME_DELIVER, NETWORK_DELIVER) are the only things main sends here. The
// host derives this frame's identity from the frame itself, never from payload.

const { contextBridge, ipcRenderer } = require("electron");
const { default: Store } = require("electron-store");
const {
  createChromeNamespace,
  createExtensionStorage,
  createMemoryBackend,
  createNetworkBridge,
} = require("../chrome-shim");
const { createGrantGate } = require("../shared/permissions");
const {
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

// chrome.runtime.getManifest: loaded from the host (id derived main-side from
// this frame's URL). Degraded to {} meanwhile, as before.
let manifestCache = {};
ipcRenderer
  .invoke(RUNTIME_GET_MANIFEST)
  .then((manifest) => {
    manifestCache = manifest || {};
  })
  .catch(() => {});
const getManifest = () => manifestCache;

// Declared permissions gate capability (docs/features/EXTENSION-MANAGEMENT.md).
// The verdict this frame is gated on is the HOST's: RUNTIME_REGISTER read the
// manifest from disk. Gating on that reply rather than on
// chrome.runtime.getManifest() means a page-world script cannot widen its own
// permissions by replacing a function it can reach.
//
// `grants` is undefined until that reply lands, and while it is the gate's
// `check`/`has` return a promise instead of guessing — denying a permission the
// extension does hold (page scripts run before IPC resolves) would be a bug
// worse than the few-millisecond window it protects.
let grants;
const permissions = createGrantGate(() => grants);

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
const registered = ipcRenderer.invoke(RUNTIME_REGISTER).then((reply) => {
  grants = (reply && reply.granted) || {};
  permissions.manifestLoaded();
  return reply || { ok: false };
});
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
  getManifest,
  platform: {
    os: CHROME_OS[process.platform] || "linux",
    arch: CHROME_ARCH[process.arch] || "unknown",
  },
  storage,
  networkBridge,
  transport,
  // Declared permissions gate capability (docs/features/EXTENSION-MANAGEMENT.md).
  // The verdict this frame is gated on is the host's — RUNTIME_REGISTER read the
  // manifest from disk — so a page-world script cannot widen it by replacing
  // chrome.runtime.getManifest.
  permissions,
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
// wraps them as {kind, payload}; the shim consumes the payload shape. A frame
// whose extension does not declare `webRequest` is never sent the lifecycle
// steps that only webRequest consumes (src/main/delivery-scope.js).
ipcRenderer.on(NETWORK_DELIVER, (_event, delivery) =>
  networkBridge.handleDelivery(delivery && delivery.payload ? delivery.payload : delivery)
);

// chrome.* namespace. The merge runs in the main world: deep-merge runtime and
// devtools onto anything already present and re-establish `lastError` as a LIVE
// getter — contextBridge cloning evaluates getters only once
// (chrome-shim/runtime.js).
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
