// chrome.debugger's frame half (src/electron/extensions/internal/shim/debugger.js), through
// createChromeNamespace so the permission gate and the delivery routing are the real ones.
const test = require("node:test");
const assert = require("node:assert");
const { createChromeNamespace } = require("../src/electron/extensions/internal/shim");
const { createExtensionStorage, createMemoryBackend } = require("../src/electron/extensions/internal/shim/storage");
const { createGrantGate } = require("../src/electron/extensions/internal/broker/permissions");

const namespace = ({ permissions = ["debugger"], host = {} } = {}) => {
  const calls = [];
  const grants = Object.fromEntries(permissions.map((permission) => [permission, true]));
  const gate = createGrantGate(() => grants);
  gate.manifestLoaded();
  const record = (name, answer) => (details) => {
    calls.push([name, details]);
    return Promise.resolve(typeof answer === "function" ? answer(details) : answer);
  };
  const chrome = createChromeNamespace({
    extensionId: "dbg.local",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    permissions: gate,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    debuggerHost: {
      attach: record("attach", host.attach || { ok: true }),
      detach: record("detach", host.detach || { ok: true }),
      sendCommand: record("sendCommand", host.sendCommand || { ok: true, result: { value: 2 } }),
      getTargets: record("getTargets", host.getTargets || { ok: true, result: [{ id: "t", tabId: 7 }] }),
    },
  });
  return { chrome, calls };
};

// Outside the preload, `chrome.runtime.lastError` is a plain field; the preload turns it
// into a live getter over this accessor (preload/extension-frame.js).
const lastErrorOf = (chrome) => {
  const error = chrome.runtime._getLastLastError();
  return error ? error.message : null;
};

/** Run a callback-style call; resolve with its arguments and the lastError it saw. */
const viaCallback = (start) =>
  new Promise((resolve) => {
    start((...args) => resolve({ args, lastError: undefined }));
  });

test("promise style: each call reaches the host with what the extension passed", async () => {
  const { chrome, calls } = namespace();
  assert.equal(await chrome.debugger.attach({ tabId: 7 }, "1.3"), undefined);
  assert.deepStrictEqual(await chrome.debugger.sendCommand({ tabId: 7 }, "Runtime.evaluate", { expression: "1+1" }), {
    value: 2,
  });
  assert.deepStrictEqual(await chrome.debugger.getTargets(), [{ id: "t", tabId: 7 }]);
  assert.equal(await chrome.debugger.detach({ tabId: 7 }), undefined);
  assert.deepStrictEqual(calls, [
    ["attach", { target: { tabId: 7 }, requiredVersion: "1.3" }],
    ["sendCommand", { target: { tabId: 7 }, method: "Runtime.evaluate", params: { expression: "1+1" } }],
    ["getTargets", undefined],
    ["detach", { target: { tabId: 7 } }],
  ]);
});

test("callback style: attach/detach get no argument, sendCommand may omit its params", async () => {
  const { chrome, calls } = namespace();
  const attached = await viaCallback((done) => chrome.debugger.attach({ tabId: 7 }, "1.3", done));
  assert.deepStrictEqual(attached.args, []);
  const sent = await viaCallback((done) => chrome.debugger.sendCommand({ tabId: 7 }, "Network.enable", done));
  assert.deepStrictEqual(sent.args, [{ value: 2 }]);
  assert.deepStrictEqual(calls[1], ["sendCommand", { target: { tabId: 7 }, method: "Network.enable", params: undefined }]);
  const detached = await viaCallback((done) => chrome.debugger.detach({ tabId: 7 }, done));
  assert.deepStrictEqual(detached.args, []);
});

test("a refusal is runtime.lastError for a callback and a rejection for a promise, in the host's words", async () => {
  const backendError = '{"code":-32601,"message":"Unsupported method \'DOM.getDocument\'"}';
  const { chrome } = namespace({ host: { sendCommand: { ok: false, error: backendError } } });
  await assert.rejects(chrome.debugger.sendCommand({ tabId: 7 }, "DOM.getDocument"), (error) => {
    assert.equal(error.message, backendError);
    return true;
  });
  const seen = await new Promise((resolve) =>
    chrome.debugger.sendCommand({ tabId: 7 }, "DOM.getDocument", {}, (result) =>
      resolve({ result, lastError: lastErrorOf(chrome) })
    )
  );
  assert.deepStrictEqual(seen, { result: undefined, lastError: backendError });
  assert.equal(lastErrorOf(chrome), null, "lastError lasts only for the callback");
});

test("without the `debugger` permission nothing reaches the host", async () => {
  const { chrome, calls } = namespace({ permissions: [] });
  await assert.rejects(chrome.debugger.attach({ tabId: 7 }, "1.3"), /permission 'debugger' is not declared/);
  const seen = await new Promise((resolve) =>
    chrome.debugger.getTargets(() => resolve(lastErrorOf(chrome)))
  );
  assert.match(seen, /permission 'debugger' is not declared/);
  assert.deepStrictEqual(calls, []);
  assert.equal(typeof chrome.debugger.onEvent.addListener, "function", "the shape stays");
});

test("host deliveries fire onEvent and onDetach with Chrome's arguments", () => {
  const { chrome } = namespace();
  const events = [];
  chrome.debugger.onEvent.addListener((source, method, params) => events.push(["event", source, method, params]));
  chrome.debugger.onDetach.addListener((source, reason) => events.push(["detach", source, reason]));
  chrome.handleDelivery({
    kind: "debugger",
    payload: { type: "event", source: { tabId: 7 }, method: "Network.webSocketCreated", params: { url: "wss://x" } },
  });
  chrome.handleDelivery({ kind: "debugger", payload: { type: "detach", source: { tabId: 7 }, reason: "target_closed" } });
  assert.deepStrictEqual(events, [
    ["event", { tabId: 7 }, "Network.webSocketCreated", { url: "wss://x" }],
    ["detach", { tabId: 7 }, "target_closed"],
  ]);
});

test("a context with no host says so instead of pretending to attach", async () => {
  const chrome = createChromeNamespace({
    extensionId: "bare.local",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  await assert.rejects(chrome.debugger.attach({ tabId: 1 }, "1.3"), /no host/);
});
