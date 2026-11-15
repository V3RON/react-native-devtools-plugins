// chrome.debugger in an extension context (docs/features/DEBUGGER.md).
//
// The frame half only shapes calls and answers; the attachment itself lives in main
// (src/electron/extensions/internal/cdp/debugger-service.js), owned by this frame's
// extension, so every context of the extension shares it the way Chrome's contexts do.
//
//   attach(target, requiredVersion[, callback])
//   detach(target[, callback])
//   sendCommand(target, method[, commandParams][, callback]) -> the backend's result
//   getTargets([callback]) -> TargetInfo[]
//   onEvent(source, method, params) / onDetach(source, reason)
//
// Every method answers both ways (promise, or callback with runtime.lastError), and a
// failure carries the text main produced: Chrome's own wording for an API-level refusal,
// or the backend's error object as JSON for a command the app refused.
//
// Pure: the four host calls are injected, so this is unit-tested under bare Node.
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");

const NO_HOST = { ok: false, error: "chrome.debugger: this context has no host to attach through." };

/**
 * @param {object} deps
 * @param {(details: {target, requiredVersion}) => Promise<object>} [deps.attach]
 * @param {(details: {target}) => Promise<object>} [deps.detach]
 * @param {(details: {target, method, params}) => Promise<object>} [deps.sendCommand]
 * @param {() => Promise<object>} [deps.getTargets]
 *        each resolves `{ok: true, result?}` or `{ok: false, error}`
 * @param {{setError: function, clearError: function}} [deps.lastError]
 */
const createDebugger = ({
  attach = null,
  detach = null,
  sendCommand = null,
  getTargets = null,
  lastError,
} = {}) => {
  const onEvent = createEvent();
  const onDetach = createEvent();

  /** Turn the host's reply into a value or a thrown Chrome error. */
  const settle = (reply) => {
    if (!reply || !reply.ok) {
      throw new Error((reply && reply.error) || "chrome.debugger: the host did not answer.");
    }
    return reply.result;
  };
  const call = (host, details, callback) =>
    promiseOrCallback(
      () => Promise.resolve(host ? host(details) : NO_HOST).then(settle),
      callback,
      lastError
    );

  return {
    attach(target, requiredVersion, callback) {
      if (typeof requiredVersion === "function") {
        callback = requiredVersion;
        requiredVersion = undefined;
      }
      // Chrome calls attach's and detach's callbacks with no argument.
      return call(attach, { target, requiredVersion }, callback && (() => callback()));
    },
    detach(target, callback) {
      return call(detach, { target }, callback && (() => callback()));
    },
    sendCommand(target, method, commandParams, callback) {
      if (typeof commandParams === "function") {
        callback = commandParams;
        commandParams = undefined;
      }
      return call(sendCommand, { target, method, params: commandParams }, callback);
    },
    getTargets(callback) {
      return call(getTargets, undefined, callback);
    },
    onEvent,
    onDetach,
    /** Host -> context push (RUNTIME_DELIVER {kind: "debugger"}). @returns whether consumed */
    _onDelivery(delivery) {
      if (!delivery || delivery.kind !== "debugger") {
        return false;
      }
      const payload = delivery.payload || {};
      if (payload.type === "event") {
        onEvent._fire(payload.source, payload.method, payload.params);
      } else if (payload.type === "detach") {
        onDetach._fire(payload.source, payload.reason);
      }
      return true;
    },
  };
};

module.exports = { createDebugger };
