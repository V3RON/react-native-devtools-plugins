// Assembles the chrome.* namespace installed into extension frames
// (window.chrome). Pure assembly: every external capability is injected —
//
//   extensionId    — id == rozenite URL hostname (load-bearing contract)
//   getManifest    — () => manifest object ({} until loaded)
//   platform       — {os, arch} in Chrome's vocabulary
//   storage        — from ./storage createExtensionStorage({ createBackend })
//   networkBridge  — from ./network-bridge createNetworkBridge({ ... }): feeds
//                    BOTH chrome.webRequest and chrome.devtools.network (one CDP
//                    capture in main, two Chrome APIs — docs/features/
//                    DEVTOOLS-NETWORK.md, docs/features/WEBREQUEST.md)
//   transport      — optional host transport for runtime messaging
//                    (see ./messaging); when absent, runtime messaging
//                    degrades to the previous no-op state.
//   onPanelCreated — optional (docs/features/DEVTOOLS-PANELS.md): host hook
//                    behind chrome.devtools.panels.create; absent = inert.
//   evalInPage     — optional (docs/features/INSPECTED-WINDOW.md): host
//                    implementation behind chrome.devtools.inspectedWindow.eval;
//                    absent = honest isError.
//   reloadInPage   — optional (same doc): host implementation behind
//                    inspectedWindow.reload (CDP Page.reload).
//
// Transports and concrete backends are wired by the caller (the
// extension-frame preload). Status per namespace: docs/api/CHROME-EXTENSION-APIS.md.
const { createEvent } = require("./event");
const { createRuntime } = require("./runtime");
const { createMessagingClient } = require("./messaging");
const { createDevtools } = require("./devtools");
const { createTabs } = require("./tabs");

const createChromeNamespace = ({
  extensionId,
  getManifest = () => ({}),
  platform = { os: "linux", arch: "unknown" },
  storage,
  networkBridge,
  transport,
  onPanelCreated,
  evalInPage,
  reloadInPage,
}) => {
  // Shared mutable lastError holder — runtime exposes it as a live getter;
  // the messaging client sets/clears it around callback invocations.
  const lastError = { value: null };

  const runtime = createRuntime({ extensionId, getManifest, platform, lastError });

  let handleDelivery = () => {};
  if (transport) {
    const messaging = createMessagingClient({
      extensionId,
      transport,
      runtimeEvents: runtime.events,
      lastError,
    });
    Object.assign(runtime.namespace, messaging.namespace);
    handleDelivery = messaging.handleDelivery;
  }

  const onChanged = createEvent();
  for (const area of ["local", "sync", "session"]) {
    storage[area].onChanged.addListener((changes, areaName) =>
      onChanged._fire(changes, areaName)
    );
  }

  const chrome = {
    runtime: runtime.namespace,

    // [REAL, observe-only] chrome.webRequest from the host's CDP network model —
    // the same capture as chrome.devtools.network below, and non-blocking by
    // construction (docs/features/WEBREQUEST.md)
    webRequest: networkBridge.webRequest,

    // [REAL storage; Tier-1 devtools] chrome.devtools.* — installed for every
    // extension frame, matching Chrome (devtools page + panel pages alike);
    // panels.create is host-driven (docs/features/DEVTOOLS-PANELS.md),
    // inspectedWindow.eval is host-backed (docs/features/INSPECTED-WINDOW.md),
    // and devtools.network is the shared network bridge's own API object
    // (docs/features/DEVTOOLS-NETWORK.md)
    devtools: createDevtools({
      extensionId,
      onPanelCreated,
      evalInPage,
      reloadInPage,
      networkApi: networkBridge.network,
    }).namespace,

    // [STUB] inert host shell: no browser tab model here (docs/LIMITATIONS.md)
    tabs: createTabs(),

    // [REAL] persistent per-extension storage (session area: per-frame
    // in-memory, see storage.js deviation note)
    // (docs/features/STORAGE-AND-I18N.md)
    storage: {
      ...storage,
      onChanged,
    },
  };

  // Host -> frame delivery entry point (non-enumerable: not part of the
  // exposed chrome namespace). The preload wires it to RUNTIME_DELIVER IPC.
  Object.defineProperty(chrome, "handleDelivery", {
    value: handleDelivery,
    enumerable: false,
  });

  return chrome;
};

module.exports = {
  createChromeNamespace,
  createEvent: require("./event").createEvent,
  createExtensionStorage: require("./storage").createExtensionStorage,
  createMemoryBackend: require("./storage").createMemoryBackend,
  createNetworkBridge: require("./network-bridge").createNetworkBridge,
  createDevtools: require("./devtools").createDevtools,
  createTabs: require("./tabs").createTabs,
};
