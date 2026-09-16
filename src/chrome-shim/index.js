// Assembles the chrome.* namespace installed into extension frames
// (window.chrome). Pure assembly: every external capability is injected —
//
//   storage        — from ./storage createExtensionStorage({ createBackend })
//   networkBridge  — from ./network-bridge createNetworkBridge({ ... })
//
// Transports and concrete backends are wired by the caller (the
// extension-frame preload). Status per namespace: docs/api/CHROME-EXTENSION-APIS.md.
const { EventEmitter } = require("events");

const createChromeNamespace = ({ storage, networkBridge }) => {
  const onChangedEmitter = new EventEmitter();
  storage.local.onChanged.addListener((changes, areaName) =>
    onChangedEmitter.emit("changed", changes, areaName)
  );
  storage.sync.onChanged.addListener((changes, areaName) =>
    onChangedEmitter.emit("changed", changes, areaName)
  );

  return {
    // [STUB] runtime messaging: no-op until src/chrome-shim ships real Ports
    // (docs/features/RUNTIME-MESSAGING.md)
    runtime: {
      onMessage: { addListener: () => {} },
      lastError: null,
    },

    // [FAKE transport] observe-only, synthetic feed
    // (docs/features/WEBREQUEST.md)
    webRequest: networkBridge.webRequest,

    // [REAL] persistent per-extension storage
    // (docs/features/STORAGE-AND-I18N.md)
    storage: {
      ...storage,
      onChanged: {
        addListener: (callback) => onChangedEmitter.on("changed", callback),
        removeListener: (callback) =>
          onChangedEmitter.removeListener("changed", callback),
        hasListener: (callback) => onChangedEmitter.listenerCount("changed") > 0,
      },
    },
  };
};

module.exports = {
  createChromeNamespace,
  createExtensionStorage: require("./storage").createExtensionStorage,
  createNetworkBridge: require("./network-bridge").createNetworkBridge,
};
