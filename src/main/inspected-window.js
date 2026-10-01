// chrome.devtools.inspectedWindow.eval on top of the CDP bridge
// (docs/features/INSPECTED-WINDOW.md).
//
// Chrome's contract (developer.chrome.com/docs/extensions/reference/api/devtools/
// inspectedWindow): `eval(expression, options?, cb)` always answers with a pair,
// it never throws and never touches runtime.lastError.
//   - success            -> [value, null]
//   - JS exception       -> [undefined, {isException: true, value: "<thrown text>"}]
//   - DevTools-side error-> [undefined, {isError: true, code, value}]
// The returned value must be JSON-compliant; anything else comes back undefined.
//
// RN mapping: CDP `Runtime.evaluate` against the app's JS context. The command
// rides the *frontend's* debugger session through src/main/cdp-bridge.js, so the
// app never learns that a second debugger exists.
//
// `mapEvaluation` is pure (CDP reply -> Chrome pair) and exported for tests;
// `createEvalInPage` binds it to a command sender, and `evalInPage` is the
// dependency injected into src/chrome-shim/devtools.js.
const { sendCommand } = require("./cdp-bridge");

// Chrome's `options.timeout` is not a Chrome option at all — see toEvaluateParams.
// Our own reply deadline therefore sits just behind it so a slow but successful
// answer is not cut off.
const TIMEOUT_SLACK_MS = 1000;

/** A failure on our side of the wire: Chrome's DevTools-side error shape. */
const FAILURE = (value) => ({
  isError: true,
  isException: false,
  value: String(value),
});

/**
 * CDP `Runtime.evaluate` reply -> Chrome's `[value, exceptionInfo]`.
 *
 * Honesty rules (docs/LIMITATIONS.md): nothing is invented here. A result the
 * backend cannot serialize (function, symbol, circular graph -> `objectId` only,
 * or `unserializableValue` such as NaN/BigInt) maps to `undefined` exactly like
 * Chrome's JSON-constrained eval — never guessed at, never stringified into shape.
 *
 * @param {object} reply the `result` object of a Runtime.evaluate response
 * @returns {{value: unknown, exceptionInfo: object|null}}
 */
const mapEvaluation = (reply) => {
  const details = reply && reply.exceptionDetails;
  if (details) {
    const exception = details.exception;
    // Chrome's documented split: a JavaScript exception thrown by the expression
    // arrives with the exception object and reports `isException`; anything else
    // on this path (no exception object — only `text`) is a tooling-side failure
    // and reports `isError`. Same pair, opposite flags.
    const isException = exception !== undefined;
    // Chrome prefixes "Uncaught " itself; Hermes/CDP already puts it in `text`,
    // while `description` carries "ReferenceError: nope is not defined".
    const raw =
      (exception && (exception.description ?? exception.value)) ??
      details.text ??
      "Evaluation of the expression raised an exception.";
    const text = String(raw);
    const exceptionInfo = {
      isError: !isException,
      isException,
      value: text.startsWith("Uncaught") ? text : `Uncaught ${text}`,
    };
    if (typeof details.url === "string") {
      exceptionInfo.url = details.url;
    }
    if (typeof details.lineNumber === "number") {
      exceptionInfo.lineNumber = details.lineNumber;
    }
    if (typeof details.columnNumber === "number") {
      exceptionInfo.columnNumber = details.columnNumber;
    }
    if (details.stackTrace) {
      exceptionInfo.stackTrace = details.stackTrace;
    }
    if (typeof details.code === "number") {
      exceptionInfo.code = details.code;
    }
    return { value: undefined, exceptionInfo };
  }

  const remote = (reply && reply.result) || {};
  if (remote.value !== undefined) {
    return { value: remote.value, exceptionInfo: null };
  }
  // NaN / Infinity / BigInt / -0 (unserializableValue) and functions, symbols,
  // circular graphs (objectId only): no JSON representation exists, so Chrome's
  // eval hands over nothing either. Documented degradation, not a fabricated 0.
  return { value: undefined, exceptionInfo: null };
};

/**
 * Runtime.evaluate params from Chrome's eval options.
 * `frameURL`, `useContentScriptContext` and `scriptExecutionContext` are accepted
 * and ignored: RN has no frames and no isolated content-script worlds — the app's
 * global context is the only context (and RN aliases `global.window = global`,
 * which is exactly what state-debugger extensions need). `timeout` is our own
 * addition (Chrome has none): it bounds the wait for a reply.
 */
const toEvaluateParams = (expression, options = {}) => {
  const params = {
    expression: String(expression ?? ""),
    returnByValue: true,
    awaitPromise: true,
  };
  // Best effort: some backends honour it, others ignore it. The bridge's reply
  // deadline is what actually bounds the wait.
  if (Number.isFinite(options.timeout) && options.timeout > 0) {
    params.timeout = Math.floor(options.timeout);
  }
  return params;
};

/**
 * `evalInPage` bound to a specific command sender, so the whole path except the
 * socket is testable.
 * @param {(method: string, params: object, opts?: object) => Promise<object>} sendCommand
 */
const createEvalInPage =
  (sendCommand) =>
  async (expression, options = {}) => {
    try {
      const reply = await sendCommand(
        "Runtime.evaluate",
        toEvaluateParams(expression, options),
        options.timeout > 0
          ? { timeoutMs: options.timeout + TIMEOUT_SLACK_MS }
          : undefined
      );
      return mapEvaluation(reply);
    } catch (error) {
      // No session, backend error reply, or deadline exceeded: all of them are
      // "the backend could not answer", which Chrome reports as isError.
      return { value: undefined, exceptionInfo: FAILURE(error.message) };
    }
  };

/** The dependency injected into src/chrome-shim/devtools.js (see above). */
const evalInPage = createEvalInPage(sendCommand);

/**
 * `reloadInPage` bound to a command sender. Chrome's `inspectedWindow.reload()`
 * maps onto CDP `Page.reload`, which RN's backend really implements
 * (`jsinspector-modern/HostAgent.cpp`: `Page.reload` -> `onReload({ignoreCache,
 * scriptToEvaluateOnLoad})`), so this is a genuine reload of the JS bundle, not a
 * no-op. Chrome's `options.injectedScript` is the same idea as CDP's
 * `scriptToEvaluateOnLoad`, so it is mapped rather than dropped.
 *
 * Chrome's signature has no callback, so there is no channel to report failure
 * through: the caller (the shim) logs the reason instead of staying quiet.
 *
 * @param {(method: string, params: object, opts?: object) => Promise<object>} sendCommand
 * @returns {(options?: object) => Promise<{ok: boolean, error?: string}>}
 */
const createReloadInPage =
  (sendCommand) =>
  async ({ ignoreCache = false, injectedScript } = {}) => {
    const params = { ignoreCache: !!ignoreCache };
    if (typeof injectedScript === "string") {
      params.scriptToEvaluateOnLoad = injectedScript;
    }
    try {
      await sendCommand("Page.reload", params);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

const reloadInPage = createReloadInPage(sendCommand);

module.exports = {
  mapEvaluation,
  toEvaluateParams,
  createEvalInPage,
  createReloadInPage,
  evalInPage,
  reloadInPage,
  FAILURE,
  TIMEOUT_SLACK_MS,
};
