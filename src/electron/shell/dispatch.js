// Host -> frontend event dispatch channel
// (docs/features/DISPATCH-CHANNEL.md).
//
// Flow: main process -> HOST_EVENT IPC -> main-frame preload ->
// window.InspectorFrontendAPI[name](...args) in the frontend's main world.
//
// It used to be described as the replacement for the ad-hoc `Events` postMessage
// broadcast; that broadcast is now gone entirely — devtools.network and webRequest
// are fed from the shell's own CDP network model (src/main/network-service.js),
// not from the frontend, so there is no consumer left to migrate
// (docs/features/DEVTOOLS-NETWORK.md, docs/features/WEBREQUEST.md).
const { HOST_EVENT } = require("../shared/ipc");

let frontendContents = null;

// Called by window.js when the frontend window is (re)created.
const setFrontendWebContents = (webContents) => {
  frontendContents = webContents;
};

/**
 * Deliver an InspectorFrontendAPI event to the frontend.
 * @param {string} eventName camelCase InspectorFrontendAPI method name
 * @param {Array} args JSON-serializable arguments
 * @returns {boolean} whether a live frontend received it
 */
const dispatchToFrontend = (eventName, args = []) => {
  if (!frontendContents || frontendContents.isDestroyed()) {
    return false;
  }
  frontendContents.send(HOST_EVENT, { name: eventName, args });
  return true;
};

module.exports = { setFrontendWebContents, dispatchToFrontend };
