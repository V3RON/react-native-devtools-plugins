// Maps inbound frontend network events to chrome.webRequest-style
// observable events. Pure: transports (window postMessage today, the real
// dispatch channel later) push events in via onFrontendEvent(); no
// `window`/`ipcRenderer` reference in here.
//
// Observe-only: blocking listeners require the CDP Fetch domain, which RN
// backends do not support (docs/features/WEBREQUEST.md).
const { EventEmitter } = require("events");

// chrome.webRequest event names that the frontend's synthetic feed maps to:
//   RequestStarted   -> onBeforeRequest + onBeforeSendHeaders
//   RequestFinished  -> onRequestFinished (devtools.network-style)
const OBSERVED = [
  "onBeforeRequest",
  "onBeforeSendHeaders",
  "onRequestFinished",
];

// Events present in the chrome.webRequest shape but never emitted today.
const SILENT = [
  "onSendHeaders",
  "onHeadersReceived",
  "onAuthRequired",
  "onBeforeRedirect",
  "onResponseStarted",
  "onCompleted",
];

/**
 * @param {object} deps
 * @param {() => string} [deps.getContentBase64] [FAKE] placeholder response
 *        body for finished requests, until real Network.getResponseBody
 *        lands (docs/features/DEVTOOLS-NETWORK.md).
 */
const createNetworkBridge = ({ getContentBase64 } = {}) => {
  const emitter = new EventEmitter();

  const on = (name) => ({
    addListener: (callback) => emitter.on(name, callback),
    removeListener: (callback) => emitter.removeListener(name, callback),
    hasListener: (callback) => emitter.listenerCount(name) > 0,
  });

  const webRequest = {};
  for (const name of SILENT) {
    webRequest[name] = { addListener: () => {} };
  }

  return {
    webRequest: {
      ...webRequest,
      onBeforeRequest: on("onBeforeRequest"),
      onBeforeSendHeaders: on("onBeforeSendHeaders"),
    },

    /** Called by the transport for every frontend network event. */
    onFrontendEvent(eventName, data) {
      if (eventName === "RequestStarted") {
        emitter.emit("onBeforeRequest", data);
        emitter.emit("onBeforeSendHeaders", data);
      }

      if (eventName === "RequestFinished") {
        emitter.emit("onRequestFinished", {
          ...data,
          getContent: (cb) => cb(getContentBase64 ? getContentBase64() : "", "base64"),
        });
      }
    },
  };
};

module.exports = { createNetworkBridge };
