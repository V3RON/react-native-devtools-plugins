// chrome.runtime namespace: identity, manifest, platform info, lifecycle
// events (docs/features/RUNTIME-MESSAGING.md).
//
//   - id === extensionId === rozenite URL hostname — load-bearing contract:
//     Altair regex-parses getURL() output to derive the id.
//   - Messaging (sendMessage / connect) is NOT part of this file: the
//     messaging client attaches those onto the namespace.
//   - Lifecycle events (onInstalled / onStartup) are registrable now; their
//     producer arrives with the background host (bucket 3).
const { createEvent } = require("./event");
const { buildExtensionURL } = require("../shared/protocol");

// Chrome's dual promise + callback style for value-returning methods.
const promiseOrCallback = (produce, callback) => {
  const value = produce();
  if (callback) {
    callback(value);
    return undefined;
  }
  return Promise.resolve(value);
};

/**
 * @param {object} deps
 * @param {string} deps.extensionId
 * @param {() => object} deps.getManifest live manifest (may be {} until loaded)
 * @param {{os: string, arch: string}} deps.platform
 * @param {{value: any}} deps.lastError shared mutable holder — the messaging
 *        client sets it around callback invocations (Chrome scoping).
 */
const createRuntime = ({ extensionId, getManifest, platform, lastError }) => {
  const events = {
    onMessage: createEvent(),
    onConnect: createEvent(),
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onSuspend: createEvent(),
    onUpdateAvailable: createEvent(),
  };

  const namespace = {
    id: extensionId,

    getURL: (innerPath = "") => buildExtensionURL(extensionId, innerPath),

    getManifest: () => getManifest(),

    // [STUB until bucket 3] background host does not exist yet.
    getBackgroundPage: () => undefined,

    getPlatformInfo: (callback) => promiseOrCallback(() => ({ ...platform }), callback),

    getPackages: (callback) => promiseOrCallback(() => [], callback),

    // No options pages, no updater, no restart — honest inert answers.
    openOptionsPage: (callback) => {
      if (callback) callback();
    },
    requestUpdate: (callback) => {
      if (callback) callback(false);
    },
    reload: () => {},

    // Scoped lastError: the messaging client sets/clears the holder around
    // listener and callback invocations; extensions branch on this.
    // Exposed as a data placeholder + an accessor helper — contextBridge
    // cloning loses live getters, so the frame preload re-defines `lastError`
    // as a real getter in the main world (see src/preload/extension-frame.js).
    lastError: null,
    _getLastLastError: () => lastError.value,
  };

  for (const [name, event] of Object.entries(events)) {
    namespace[name] = event;
  }

  return { namespace, events };
};

module.exports = { createRuntime };
