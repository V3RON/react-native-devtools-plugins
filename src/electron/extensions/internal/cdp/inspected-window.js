// chrome.devtools.inspectedWindow.eval on top of the host's CDP session
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
// rides the host's own debugger session (./cdp-session.js), a second session next to
// the frontend's, so nothing it does lands in the frontend's models.
//
// `mapEvaluation` is pure (CDP reply -> Chrome pair) and exported for tests;
// `createEvalInPage` binds it to a command sender, and `evalInPage` is the
// dependency injected into src/electron/extensions/internal/shim/devtools.js.

// Chrome's `options.timeout` is not a Chrome option at all — see toEvaluateParams.
// Our own reply deadline therefore sits just behind it so a slow but successful
// answer is not cut off.
const TIMEOUT_SLACK_MS = 1000;

const { scopedExpression } = require("../content/scope");

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
 * Every character outside the Basic Multilingual Plane (emoji, 🇵🇱), written as the JS
 * escape pair `\uD83C\uDDF5` instead of the character itself.
 *
 * React Native's Hermes backend (observed on RN 0.88, iOS) refuses to compile a
 * `Runtime.evaluate` whose source contains one: `Compiling JS failed: Invalid UTF-8 code
 * point 0xd83c`, however the CDP frame encodes it (raw UTF-8 or a JSON escape). Every
 * delivery the content bridge makes is an evaluate, so one emoji in a message (a Relay
 * record's `emoji` field) dropped that message. The JS escape is ASCII and means the same
 * string in a string, template or regex literal; only a raw template string
 * (`String.raw`) would see the escape text instead. BMP characters ("zażółć") compile
 * fine and are left alone.
 */
const escapeAstral = (source) =>
  source.replace(/[\ud800-\udfff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Runtime.evaluate params from Chrome's eval options.
 * `frameURL`, `scriptExecutionContext` and `useContentScriptContext` are accepted
 * and ignored: RN has no frames and no
 * isolated content-script worlds — the app's global context is the only context
 * (and RN aliases `global.window = global`, which is exactly what
 * state-debugger extensions need). Chrome itself errors when
 * `useContentScriptContext` is set with no content-script world; erroring here
 * would just make the API unusable, since RN genuinely has no other world.
 * `timeout` is our own addition (Chrome has none): it bounds the wait for a reply.
 */
const toEvaluateParams = (expression, options = {}) => {
  const params = {
    expression: escapeAstral(String(expression ?? "")),
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
 * Chrome runs `inspectedWindow.eval` in the page's MAIN world, where `window.postMessage`
 * reaches the extension's content scripts (Relay DevTools' panel starts its backend
 * that way). Here an extension's MAIN world is its scope (../content/scope.js), so an
 * expression from extension `extensionId` reads `window`/`self`/`globalThis` as that
 * scope; every other global still resolves to the app's.
 *
 * Only a source that parses as ONE expression is wrapped: its value is then the wrapper's
 * return value, exactly the completion value Chrome reports. Statements (`var x = 1; x`)
 * have a completion value no function wrapper can return, so they run as written,
 * against the app's global, as before. The parse check compiles and never runs it.
 */
const inWorldOf = (extensionId, expression) => {
  const source = String(expression ?? "");
  if (!extensionId) return source;
  const body = source.trim().replace(/;+\s*$/, "");
  if (!body) return source;
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${body}\n);`);
  } catch {
    return source;
  }
  return scopedExpression({ extensionId, body: `return (${body}\n);` });
};

/**
 * `evalInPage` bound to a specific command sender, so the whole path except the
 * socket is testable.
 * @param {(method: string, params: object, opts?: object) => Promise<object>} sendCommand
 */
const createEvalInPage =
  (sendCommand) =>
  async (expression, options = {}, { extensionId = null } = {}) => {
    try {
      const reply = await sendCommand(
        "Runtime.evaluate",
        toEvaluateParams(inWorldOf(extensionId, expression), options),
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

module.exports = {
  mapEvaluation,
  toEvaluateParams,
  escapeAstral,
  inWorldOf,
  createEvalInPage,
  createReloadInPage,
  FAILURE,
  TIMEOUT_SLACK_MS,
};
