// Host -> frontend event dispatch channel
// (docs/features/DISPATCH-CHANNEL.md).
//
// Flow: main process -> HOST_EVENT IPC -> main-frame preload ->
// window.InspectorFrontendAPI[name](...args) in the frontend's main world.
//
// This replaces the ad-hoc `Events` postMessage broadcast (now the only
// consumer left there is the frontend's synthetic network feed, until
// devtools.network moves onto this channel — docs/features/DEVTOOLS-NETWORK.md).
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
