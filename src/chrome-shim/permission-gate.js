// Turning a permission verdict into Chrome-visible behavior, for namespaces
// whose APIs need no callback of their own to report through
// (docs/features/EXTENSION-MANAGEMENT.md, docs/LIMITATIONS.md §Security).
//
// Two shapes, because Chrome has two shapes:
//
//   gateCallbackNamespace — `chrome.tabs.*`: promise AND callback style, so a
//     denial is a rejected promise plus `runtime.lastError` for the callback
//     caller, exactly like a real permission error.
//   gateWebRequest — `chrome.webRequest.on*`: Chrome's event objects have no
//     callback, so there is no lastError to set. A denied listener is simply
//     never registered (it can therefore never receive data) and the reason is
//     reported once, loudly, through `onDenied`.
//
// Both keep the namespace's SHAPE intact — every method and every event object
// still exists — so extensions that feature-detect by calling get a failing
// call rather than a TypeError (the stubbing rule in docs/OVERVIEW.md). The
// capability is what goes away, not the shape.
//
// Pure: `check` and `onDenied` are injected, so nothing here knows about IPC
// (the layering rule in docs/ARCHITECTURE.md).
const permissionError = (api, verdict) => {
  const error = new Error(
    (verdict && verdict.error) || `Permission denied for chrome.${api}.*`
  );
  error.permission = (verdict && verdict.permission) || null;
  return error;
};

/** `check` may answer synchronously or after the manifest loads. */
const whenAllowed = (verdict, allow, deny) => {
  if (verdict && typeof verdict.then === "function") {
    verdict.then((settled) =>
      settled && settled.ok ? allow() : deny(settled || { ok: false })
    );
    return;
  }
  if (verdict && verdict.ok) {
    allow();
    return;
  }
  deny(verdict || { ok: false });
};

/**
 * Wrap an async namespace so every method fails when the permission is missing.
 *
 * @param {object} target the real namespace (shape is preserved)
 * @param {object} options
 * @param {string} options.api namespace name, for the error text
 * @param {(api: string) => {ok: boolean}|Promise<{ok: boolean}>} options.check
 * @param {(error: Error) => void} options.setLastError Chrome-scoped lastError setter
 * @param {(method: string, error: Error) => void} [options.onDenied]
 */
const gateCallbackNamespace = (
  target,
  { api, check, setLastError = () => {}, onDenied = () => {} }
) => {
  const gated = {};
  for (const [name, value] of Object.entries(target)) {
    if (typeof value !== "function") {
      gated[name] = value; // constants (TAB_ID_NONE) and Event objects stay as-is
      continue;
    }
    gated[name] = (...args) => {
      const lastArg = args[args.length - 1];
      const callback = typeof lastArg === "function" ? lastArg : undefined;
      const fail = (verdict) => {
        const error = permissionError(`${api}.${name}`, verdict);
        onDenied(`${api}.${name}`, error);
        if (!callback) {
          return Promise.reject(error);
        }
        // Chrome's callback style: lastError is set for the duration of the
        // callback, and the callback gets no value to work with.
        return Promise.reject(error)
          .catch(() => {
            setLastError(error);
            try {
              callback();
            } finally {
              setLastError(null);
            }
          })
          .then(() => undefined);
      };
      const verdict = check(api);
      if (verdict && typeof verdict.then === "function") {
        return verdict.then((settled) =>
          settled && settled.ok ? value(...args) : fail(settled || { ok: false })
        );
      }
      if (verdict && verdict.ok) {
        return value(...args);
      }
      return fail(verdict);
    };
  }
  return gated;
};

/**
 * Wrap chrome.webRequest's event objects.
 *
 * Chrome's Event objects are synchronous, so registration cannot wait for the
 * permission verdict — and this shell's verdict arrives with RUNTIME_REGISTER,
 * which is async by nature. The resolution is register-then-revoke:
 *
 *   - when the verdict is already known (the common case, since registration
 *     resolves during page load), the listener is withdrawn synchronously and is
 *     therefore never observably registered at all;
 *   - when the verdict is still in flight, the listener exists until the reply
 *     lands and is removed the moment it does. No data can slip through in that
 *     window: main starts pushing network deliveries only after RUNTIME_REGISTER
 *     is answered, and the revocation is queued off that very reply;
 *   - a denial is reported once, through the console, because Chrome's Event
 *     objects have no callback for a lastError to travel through.
 *
 * What page code can OBSERVE is narrower than what happens here: `chrome` crosses
 * `contextBridge`, which clones callbacks, so `hasListener(fn)` is false for a
 * page-world function in every state (measured on Electron 38). `hasListeners()`
 * is the observable, and it is what the end-to-end test asserts. Deviation
 * recorded in docs/features/RUNTIME-MESSAGING.md.
 *
 * @param {object} target the real `chrome.webRequest` object
 * @param {object} options
 * @param {(api: string) => {ok: boolean}|Promise<{ok: boolean}>} options.check
 * @param {(reason: string) => void} options.onDenied
 * @param {object} [options.logger]
 */
const gateWebRequest = (target, { check, onDenied = () => {}, logger = console }) => {
  let reported = false;
  const report = (verdict) => {
    const error = permissionError("webRequest", verdict);
    if (reported) {
      return;
    }
    reported = true;
    onDenied(error.message);
    logger.error(
      `[chrome.webRequest] ${error.message} Registered listeners are withdrawn, so this ` +
        "extension receives no request data (docs/features/WEBREQUEST.md)."
    );
  };

  const gated = {};
  for (const [name, event] of Object.entries(target)) {
    gated[name] = {
      addListener(callback, filters, extraInfoSpec) {
        event.addListener(callback, filters, extraInfoSpec);
        whenAllowed(
          check("webRequest"),
          () => {},
          (verdict) => {
            event.removeListener(callback);
            report(verdict);
          }
        );
      },
      removeListener: (callback) => event.removeListener(callback),
      hasListener: (callback) => event.hasListener(callback),
      hasListeners: () => event.hasListeners(),
    };
  }
  return gated;
};

module.exports = {
  gateCallbackNamespace,
  gateWebRequest,
  permissionError,
  whenAllowed,
};
