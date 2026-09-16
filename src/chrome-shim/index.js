// Assembles the chrome.* namespace installed into extension frames
// (window.chrome). Pure assembly: every external capability is injected —
//
//   extensionId    — id == rozenite URL hostname (load-bearing contract)
//   getManifest    — () => manifest object ({} until loaded)
//   platform       — {os, arch} in Chrome's vocabulary
//   storage        — from ./storage createExtensionStorage({ createBackend })
//   networkBridge  — from ./network-bridge createNetworkBridge({ ... })
//
// Transports and concrete backends are wired by the caller (the
// extension-frame preload). Status per namespace: docs/api/CHROME-EXTENSION-APIS.md.
const { createEvent } = require("./event");
const { createRuntime } = require("./runtime");

const createChromeNamespace = ({
  extensionId,
  getManifest = () => ({}),
  platform = { os: "linux", arch: "unknown" },
  storage,
  networkBridge,
}) => {
  // Shared mutable lastError holder — runtime exposes it as a live getter;
  // the messaging client (docs/features/RUNTIME-MESSAGING.md) sets/clears it
  // around callback/listener invocations.
  const lastError = { value: null };

  const runtime = createRuntime({ extensionId, getManifest, platform, lastError });

  const onChanged = createEvent();
  for (const area of ["local", "sync", "session"]) {
    storage[area].onChanged.addListener((changes, areaName) =>
      onChanged._fire(changes, areaName)
    );
  }

  return {
    runtime: runtime.namespace,

    // [FAKE transport] observe-only, synthetic feed
    // (docs/features/WEBREQUEST.md)
    webRequest: networkBridge.webRequest,

    // [REAL] persistent per-extension storage (session area: per-frame
    // in-memory, see storage.js deviation note)
    // (docs/features/STORAGE-AND-I18N.md)
    storage: {
      ...storage,
      onChanged,
    },
  };
};

module.exports = {
  createChromeNamespace,
  createEvent: require("./event").createEvent,
  createExtensionStorage: require("./storage").createExtensionStorage,
  createMemoryBackend: require("./storage").createMemoryBackend,
  createNetworkBridge: require("./network-bridge").createNetworkBridge,
};
