// inspectedWindow.eval mapping tests (src/main/inspected-window.js): the pure
// CDP -> Chrome contract rules from docs/features/INSPECTED-WINDOW.md, plus the
// timeout / no-session degradation paths driven through an injected command
// sender (no socket, no Electron).
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const {
  mapEvaluation,
  toEvaluateParams,
  createEvalInPage,
  TIMEOUT_SLACK_MS,
} = require("../src/main/inspected-window");

test("Runtime.evaluate params are the Chrome-fidelity ones", () => {
  assert.deepStrictEqual(toEvaluateParams("globalThis.__REDUX_DEVTOOLS"), {
    expression: "globalThis.__REDUX_DEVTOOLS",
    returnByValue: true,
    awaitPromise: true,
  });
  assert.deepStrictEqual(toEvaluateParams("x", { frameURL: "app://x" }), {
    expression: "x",
    returnByValue: true,
    awaitPromise: true,
  });
  assert.deepStrictEqual(toEvaluateParams("x", { timeout: 2500 }), {
    expression: "x",
    returnByValue: true,
    awaitPromise: true,
    timeout: 2500,
  });
  assert.deepStrictEqual(toEvaluateParams("x", { timeout: 0 }), {
    expression: "x",
    returnByValue: true,
    awaitPromise: true,
  });
});

test("value round-trip: primitives come back as-is, exceptionInfo stays null", () => {
  for (const value of [42, "hello", true, null, { a: [1, 2] }, []]) {
    const mapped = mapEvaluation({ result: { type: typeof value, value } });
    assert.deepStrictEqual(mapped, { value, exceptionInfo: null });
  }
});

test("objectId-only / unserializable results map to undefined (documented degradation)", () => {
  for (const result of [
    { type: "function", className: "Function", objectId: "1828.1" },
    { type: "symbol", description: "Symbol('s')", objectId: "1828.2" },
    { type: "object", className: "Circular", objectId: "1828.3" },
    { type: "number", unserializableValue: "NaN" },
    { type: "bigint", unserializableValue: "10n" },
    {},
  ]) {
    assert.deepStrictEqual(
      mapEvaluation({ result }),
      { value: undefined, exceptionInfo: null },
      JSON.stringify(result)
    );
  }
});

test("exceptionDetails -> exceptionInfo (thrown JavaScript exception)", () => {
  const { value, exceptionInfo } = mapEvaluation({
    result: { type: "object", subtype: "error", objectId: "-1" },
    exceptionDetails: {
      exceptionId: 1,
      text: "Uncaught Error",
      lineNumber: 0,
      columnNumber: 6,
      url: "index.bundle",
      stack: "Error: boom\n at index.bundle:1:7",
      exception: {
        type: "object",
        subtype: "error",
        className: "Error",
        description: "Error: boom\n    at index.bundle:1:7",
        objectId: "-1",
      },
    },
  });
  assert.strictEqual(value, undefined);
  // Chrome: a page-side exception sets isException, not isError.
  assert.strictEqual(exceptionInfo.isException, true);
  assert.strictEqual(exceptionInfo.isError, false);
  assert.strictEqual(
    exceptionInfo.value,
    "Uncaught Error: boom\n    at index.bundle:1:7"
  );
  assert.strictEqual(exceptionInfo.url, "index.bundle");
  assert.strictEqual(exceptionInfo.lineNumber, 0);
  assert.strictEqual(exceptionInfo.columnNumber, 6);
});

test("exceptionDetails without an exception object (tooling-side failure)", () => {
  const { value, exceptionInfo } = mapEvaluation({
    result: { type: "object", objectId: "-2" },
    exceptionDetails: {
      exceptionId: 2,
      text: "Debugger is not attached",
      lineNumber: 3,
      code: -32603,
    },
  });
  assert.strictEqual(value, undefined);
  assert.strictEqual(exceptionInfo.isError, true);
  assert.strictEqual(exceptionInfo.isException, false);
  assert.strictEqual(exceptionInfo.value, "Uncaught Debugger is not attached");
  assert.strictEqual(exceptionInfo.lineNumber, 3);
  assert.strictEqual(exceptionInfo.code, -32603);
  assert.strictEqual(exceptionInfo.url, undefined);
});

test("exceptionInfo.stackTrace is carried when the backend sends one", () => {
  const stackTrace = {
    callFrames: [{ functionName: "f", url: "u", lineNumber: 1, columnNumber: 2 }],
  };
  const { exceptionInfo } = mapEvaluation({
    exceptionDetails: { text: "Uncaught Error: x", stackTrace },
  });
  assert.strictEqual(exceptionInfo.stackTrace, stackTrace);
});

test("a missing exception description still produces a non-empty value", () => {
  const { exceptionInfo } = mapEvaluation({
    exceptionDetails: { exceptionId: 9, text: "Uncaught Error" },
  });
  assert.strictEqual(exceptionInfo.isError, true);
  assert.match(exceptionInfo.value, /^Uncaught Error/);
});

test("empty / malformed replies are not turned into fake success data", () => {
  assert.deepStrictEqual(mapEvaluation({}), { value: undefined, exceptionInfo: null });
  assert.deepStrictEqual(mapEvaluation(undefined), {
    value: undefined,
    exceptionInfo: null,
  });
});

// ── evalInPage: the degradation paths around the command sender ─────────────
test("evalInPage passes Runtime.evaluate params and returns the mapped pair", async () => {
  const calls = [];
  const evalInPage = createEvalInPage(async (method, params, opts) => {
    calls.push({ method, params, opts });
    return { result: { type: "string", value: "ios" } };
  });
  assert.deepStrictEqual(await evalInPage("globalThis.platform", { timeout: 900 }), {
    value: "ios",
    exceptionInfo: null,
  });
  assert.strictEqual(calls[0].method, "Runtime.evaluate");
  assert.strictEqual(calls[0].params.expression, "globalThis.platform");
  assert.strictEqual(calls[0].params.returnByValue, true);
  assert.strictEqual(calls[0].params.awaitPromise, true);
  assert.strictEqual(calls[0].opts.timeoutMs, 1900, "Chrome timeout + bridge slack");
});

test("evalInPage: no session -> isError pair, never a rejection", async () => {
  const evalInPage = createEvalInPage(async () => {
    const error = new Error("Runtime.evaluate: no CDP session is attached");
    error.code = "DETACHED";
    throw error;
  });
  assert.deepStrictEqual(await evalInPage("1+1"), {
    value: undefined,
    exceptionInfo: {
      isError: true,
      isException: false,
      value: "Runtime.evaluate: no CDP session is attached",
    },
  });
});

test("evalInPage: backend error reply -> isError pair with the backend's text", async () => {
  const evalInPage = createEvalInPage(async () => {
    const error = new Error("Runtime.evaluate: Runtime domain is not enabled");
    error.code = -32601;
    throw error;
  });
  const { value, exceptionInfo } = await evalInPage("1+1");
  assert.strictEqual(value, undefined);
  assert.strictEqual(exceptionInfo.isError, true);
  assert.match(exceptionInfo.value, /Runtime domain is not enabled/);
});

test("evalInPage: a timed-out command settles as isError", async () => {
  // Mirrors what the bridge does when no reply arrives within its deadline.
  const evalInPage = createEvalInPage(async (_method, _params, { timeoutMs } = {}) => {
    const error = new Error(`Runtime.evaluate: timed out after ${timeoutMs}ms`);
    error.code = "TIMEOUT";
    throw error;
  });
  const { value, exceptionInfo } = await evalInPage("while(true){}", { timeout: 5 });
  assert.strictEqual(value, undefined);
  assert.strictEqual(exceptionInfo.isError, true);
  // Chrome's timeout + the bridge's slack (src/main/inspected-window.js).
  assert.match(exceptionInfo.value, new RegExp(`timed out after ${5 + TIMEOUT_SLACK_MS}ms`));
});
