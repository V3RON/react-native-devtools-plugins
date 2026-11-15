// chrome.debugger end to end: the production shell in Electron
// (tests/extension-frame-harness.js) with the host's CDP session pointed at a fake
// inspected app (tests/fake-rn-app.js), and a real `rozenite://` panel that attaches,
// sends, listens and detaches — next to one whose manifest does not declare `debugger`.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { electronBinary, runHarness, stageExtension, consoleLines } = require("./electron-runner");

const binary = electronBinary();
const suite = binary ? test : test.skip;

const GRANTED_ID = "dbg-granted.local";
const DENIED_ID = "dbg-denied.local";

const manifestFor = (id, permissions) =>
  JSON.stringify({
    name: `Debugger ${id}`,
    version: "1.0.0",
    manifest_version: 3,
    permissions,
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  });

const panelScript = `
const MARKER = "__ROZENITE_PROBE__";
const id = chrome.runtime.id;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (promise) => promise.then(() => null, (error) => error.message);
const viaCallback = (start) =>
  new Promise((resolve) =>
    start((...args) =>
      resolve({ args, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })
    )
  );
const report = (out) => {
  console.log(MARKER + JSON.stringify(out));
  console.log("[dbg-probe] reported " + id);
};

(async () => {
  const out = { extensionId: id, shape: typeof chrome.debugger.attach };
  const tabId = chrome.devtools.inspectedWindow.tabId;
  out.tabId = tabId;
  if (id === "${DENIED_ID}") {
    out.denied = await viaCallback((done) => chrome.debugger.attach({ tabId }, "1.3", done));
    report(out);
    return;
  }
  // The host's own session attaches on its own schedule; the app is a target once it has.
  for (let attempt = 0; attempt < 100; attempt++) {
    out.targets = await chrome.debugger.getTargets();
    if (out.targets.length) break;
    await sleep(100);
  }
  const events = [];
  chrome.debugger.onEvent.addListener((source, method, params) =>
    events.push({ source, method, requestId: params && params.requestId })
  );
  out.attach = await viaCallback((done) => chrome.debugger.attach({ tabId }, "1.3", done));
  out.secondAttach = await viaCallback((done) => chrome.debugger.attach({ tabId }, "1.3", done));
  out.evaluate = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1+1" });
  out.enable = await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  for (let attempt = 0; attempt < 100 && !events.some((e) => e.method === "Network.loadingFinished"); attempt++) {
    await sleep(100);
  }
  out.refused = await failure(
    chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: "never-announced" })
  );
  out.detach = await viaCallback((done) => chrome.debugger.detach({ tabId }, done));
  out.afterDetach = await failure(chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" }));
  out.events = events.slice(0, 5);
  out.eventCount = events.length;
  report(out);
})().catch((error) => report({ extensionId: id, fatal: error.message }));
`;

const panelHtml = `<!DOCTYPE html>
<html><body><script src="/panel.js"></script></body></html>
`;

suite("chrome.debugger attaches its own session to the inspected app", { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-debugger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const extensionsDir = path.join(root, "extensions");
  stageExtension(extensionsDir, GRANTED_ID, {
    "manifest.json": manifestFor(GRANTED_ID, ["debugger"]),
    "panel.html": panelHtml,
    "panel.js": panelScript,
  });
  stageExtension(extensionsDir, DENIED_ID, {
    "manifest.json": manifestFor(DENIED_ID, []),
    "panel.html": panelHtml,
    "panel.js": panelScript,
  });
  const hostPage = `<!DOCTYPE html>
<html><body>
  <iframe src="rozenite://${DENIED_ID}/panel.html" width="100" height="100"></iframe>
  <iframe src="rozenite://${GRANTED_ID}/panel.html" width="600" height="400"></iframe>
</body></html>
`;

  const run = await runHarness({
    binary,
    root: path.join(root, "run"),
    extensionsDir,
    hostPage,
    extraArgs: ["--fake-rn-app=on", "--fake-app-interval=300"],
    waitFor: `[dbg-probe] reported ${GRANTED_ID}`,
    timeoutMs: 150000,
    settleMs: 1500,
  });

  const probes = Object.fromEntries(
    run.observed.filter((line) => line.kind === "probe" && line.data).map((line) => [line.data.extensionId, line.data])
  );
  const granted = probes[GRANTED_ID];
  const denied = probes[DENIED_ID];
  const connections = run.observed.filter((line) => line.kind === "fake-app-attached");
  const fakeApp = (run.observed.find((line) => line.kind === "fake-app") || {}).stats || {};
  const dump = () =>
    [
      `  exit=${run.code}`,
      `  granted: ${JSON.stringify(granted)}`,
      `  denied: ${JSON.stringify(denied)}`,
      `  connections: ${JSON.stringify(connections)}`,
      `  fake app commands: ${JSON.stringify(fakeApp.commands)}`,
      `  console: ${consoleLines(run.observed).slice(-15).join(" | ")}`,
      `  output tail: ${String(run.output).slice(-1500)}`,
    ].join("\n");

  assert.ok(granted && !granted.fatal, `the granted panel reported:${dump()}`);
  assert.ok(denied, `the denied panel reported:${dump()}`);

  // Without the permission: the namespace is there, the call fails with Chrome's lastError.
  assert.equal(denied.shape, "function");
  assert.deepStrictEqual(denied.denied.args, []);
  assert.match(denied.denied.lastError, /permission 'debugger' is not declared/, dump());

  // The inspected app is the one target, under the panel's own inspectedWindow.tabId.
  assert.equal(granted.targets.length, 1, dump());
  assert.equal(granted.targets[0].tabId, granted.tabId);
  assert.equal(granted.targets[0].type, "page");
  assert.equal(granted.targets[0].id, "1", "the app's id from /json/list");

  // attach: no argument, no lastError; a second one is Chrome's refusal.
  assert.deepStrictEqual(granted.attach, { args: [], lastError: null }, dump());
  assert.equal(granted.secondAttach.lastError, `Another debugger is already attached to the tab with id: ${granted.tabId}.`);

  // A session of its own: the fake app saw the host's session AND the extension's.
  assert.ok(connections.length >= 2, `two debugger connections:${dump()}`);
  assert.ok(connections.every((line) => line.origin), "each with the dev server's Origin");

  // Commands went to the app and came back with its answers.
  assert.deepStrictEqual(granted.evaluate, {}, "the fake app answers {} to what it accepts");
  assert.deepStrictEqual(granted.enable, {});
  assert.ok(fakeApp.commands.includes("Runtime.evaluate"), dump());
  assert.equal(
    granted.refused,
    JSON.stringify({
      code: -32603,
      message: "Network.getResponseBody: Internal error: Could not retrieve response body for the given requestId.",
    }),
    "the app's own error object, as Chrome's lastError text"
  );

  // Events the app sent on that session reached the panel, from its tab.
  const methods = granted.events.map((event) => event.method);
  assert.ok(methods.includes("Network.requestWillBeSent"), dump());
  assert.ok(granted.events.every((event) => event.source && event.source.tabId === granted.tabId));

  // detach: quiet, and the attachment is gone.
  assert.deepStrictEqual(granted.detach, { args: [], lastError: null });
  assert.equal(granted.afterDetach, `Debugger is not attached to the tab with id: ${granted.tabId}.`);
});
