// chrome.devtools shim tests (src/chrome-shim/devtools.js):
// panels.create semantics (callback vs promise style, host notification),
// inspectedWindow.eval (both argument overloads, promise vs callback, mapping of
// the host's CDP answer onto Chrome's [value, exceptionInfo] pair), and the
// inert-shape stub rule.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createDevtools, tabIdFor } = require("../src/chrome-shim/devtools");
const { createEvalInPage } = require("../src/main/inspected-window");
const makeDevtools = ({ evalInPage, reloadInPage, logger } = {}) => {
  const created = [];
  const { namespace } = createDevtools({
    extensionId: "my-ext",
    onPanelCreated: (p) => created.push(p),
    evalInPage,
    reloadInPage,
    logger,
  });
  return { devtools: namespace, created };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("panels.create (callback style) notifies the host and calls back with a Panel", async () => {
  const { devtools, created } = makeDevtools();
  let panel = null;
  const returned = devtools.panels.create("Osudio", null, "/panel.html", (p) => {
    panel = p;
  });
  assert.strictEqual(returned, undefined, "callback style returns nothing");
  assert.deepStrictEqual(created, [{ title: "Osudio", pagePath: "/panel.html" }]);
  await tick();
  assert.ok(panel, "callback fired");
  assert.ok(panel.onShown.hasListener !== undefined, "Panel event shape");
  assert.ok(panel.onHidden.hasListener !== undefined);
  assert.doesNotThrow(() => panel.setWidth(400));
});

test("panels.create tolerates a null callback (real extensions do this)", async () => {
  const { devtools, created } = makeDevtools();
  const result = devtools.panels.create("X", null, "/p.html", null);
  assert.strictEqual(created.length, 1);
  await result; // null cb -> promise style; must resolve with a Panel
  assert.ok(result instanceof Promise);
});

test("panels.create (promise style, 3 args) resolves with a Panel", async () => {
  const { devtools } = makeDevtools();
  const panel = await devtools.panels.create("Altair GraphQL", "icon.png", "/panel.html");
  assert.strictEqual(panel._title, "Altair GraphQL");
  assert.strictEqual(panel._pagePath, "/panel.html");
});

test("inspectedWindow.eval without a CDP backend degrades honestly", async () => {
  const { devtools } = makeDevtools(); // no evalInPage injected
  let cbArgs = null;
  const returned = devtools.inspectedWindow.eval("1+1", (result, info) => {
    cbArgs = [result, info];
  });
  assert.strictEqual(returned, undefined, "callback style returns nothing");
  await tick();
  assert.strictEqual(cbArgs[0], undefined);
  assert.strictEqual(cbArgs[1].isError, true);
  assert.match(cbArgs[1].value, /no CDP backend/);

  const [result, info] = await devtools.inspectedWindow.eval("1+1");
  assert.strictEqual(result, undefined);
  assert.strictEqual(info.isError, true);
});

// ── inspectedWindow.eval over an injected CDP answer ─────────────────────────
const okEval = (result) =>
  createEvalInPage(async () => ({ result: { type: typeof result, value: result } }));

test("inspectedWindow.eval round-trips the value (callback + promise)", async () => {
  const { devtools } = makeDevtools({
    evalInPage: createEvalInPage(async () => ({
      result: { type: "object", value: { dev: true, platform: "ios" } },
    })),
  });
  const pair = await devtools.inspectedWindow.eval(
    "JSON.stringify({dev: globalThis.__DEV__})"
  );
  assert.deepStrictEqual(pair, [{ dev: true, platform: "ios" }, null]);

  const viaCallback = await new Promise((resolve) =>
    devtools.inspectedWindow.eval("1+1", (value, info) => resolve([value, info]))
  );
  assert.deepStrictEqual(viaCallback, [{ dev: true, platform: "ios" }, null]);
});

test("inspectedWindow.eval(expr, cb) and eval(expr, options, cb) overloads", async () => {
  const seen = [];
  const { devtools } = makeDevtools({
    evalInPage: createEvalInPage(async (method, params, opts) => {
      seen.push({ params, opts });
      return { result: { type: "string", value: "ok" } };
    }),
  });

  const twoArgs = await new Promise((resolve) =>
    devtools.inspectedWindow.eval("a", (value) => resolve(value))
  );
  assert.strictEqual(twoArgs, "ok");
  assert.strictEqual(seen[0].opts, undefined, "no options slot consumed");
  assert.strictEqual(seen[0].params.expression, "a");

  const threeArgs = await new Promise((resolve) =>
    devtools.inspectedWindow.eval("b", { timeout: 500 }, (value) => resolve(value))
  );
  assert.strictEqual(threeArgs, "ok");
  assert.strictEqual(seen[1].params.expression, "b");
  assert.strictEqual(seen[1].params.timeout, 500, "Chrome timeout reaches Runtime.evaluate");
  assert.deepStrictEqual(seen[1].opts, { timeoutMs: 1500 });
});

test("inspectedWindow.eval maps exceptionDetails onto Chrome's exceptionInfo", async () => {
  const { devtools } = makeDevtools({
    evalInPage: createEvalInPage(async () => ({
      result: { type: "object", subtype: "error", objectId: "-12345" },
      exceptionDetails: {
        exceptionId: 3,
        text: "Uncaught ReferenceError: nope is not defined",
        lineNumber: 12,
        columnNumber: 7,
        url: "http://127.0.0.1:8081/index.bundle//&platform=ios",
        stackTrace: {
          callFrames: [
            {
              functionName: "",
              url: "http://127.0.0.1:8081/index.bundle",
              lineNumber: 12,
              columnNumber: 7,
            },
          ],
        },
        exception: {
          type: "object",
          subtype: "error",
          className: "ReferenceError",
          description: "ReferenceError: nope is not defined",
          objectId: "-12345",
        },
      },
    })),
  });
  const [value, info] = await devtools.inspectedWindow.eval("nope");
  assert.strictEqual(value, undefined);
  assert.strictEqual(info.isException, true, "a page-side throw");
  assert.strictEqual(info.isError, false, "Chrome keeps isError for tooling failures");
  assert.strictEqual(info.value, "Uncaught ReferenceError: nope is not defined");
  assert.strictEqual(info.lineNumber, 12);
  assert.strictEqual(info.columnNumber, 7);
  assert.match(info.url, /index\.bundle/);
  assert.strictEqual(info.stackTrace.callFrames.length, 1);
});

test("inspectedWindow.eval: unserializable / objectId-only results are undefined, not faked", async () => {
  const { devtools } = makeDevtools({
    evalInPage: createEvalInPage(async () => ({
      result: { type: "function", className: "Function", objectId: "1234.5" },
    })),
  });
  const [value, info] = await devtools.inspectedWindow.eval("globalThis.__store");
  assert.strictEqual(value, undefined);
  assert.strictEqual(info, null, "not an error — Chrome returns undefined too");
});

test("inspectedWindow.eval: evaluate-time failures settle as isError", async () => {
  const { devtools } = makeDevtools({
    // The bridge rejects when there is no session / the deadline passes.
    evalInPage: createEvalInPage(async () => {
      const error = new Error("Runtime.evaluate: no CDP session is attached");
      error.code = "DETACHED";
      throw error;
    }),
  });
  const [value, info] = await devtools.inspectedWindow.eval("1+1");
  assert.strictEqual(value, undefined);
  assert.strictEqual(info.isError, true);
  assert.match(info.value, /no CDP session is attached/);

  const viaCallback = await new Promise((resolve) =>
    devtools.inspectedWindow.eval("1+1", (v, i) => resolve([v, i]))
  );
  assert.strictEqual(viaCallback[0], undefined);
  assert.strictEqual(viaCallback[1].isError, true);
});

test("inspectedWindow.reload reaches the host with Chrome's options", async () => {
  const seen = [];
  const { devtools } = makeDevtools({
    reloadInPage: async (options) => {
      seen.push(options);
      return { ok: true };
    },
  });
  assert.strictEqual(devtools.inspectedWindow.reload(), undefined, "Chrome returns nothing");
  assert.strictEqual(devtools.inspectedWindow.reload({ ignoreCache: true }), undefined);
  await tick();
  assert.deepStrictEqual(seen, [{}, { ignoreCache: true }]);
});

test("inspectedWindow.reload reports a failed reload instead of hiding it", async () => {
  const warnings = [];
  const { devtools } = makeDevtools({
    reloadInPage: async () => ({ ok: false, error: "Page.reload: no CDP session is attached" }),
    logger: { warn: (message) => warnings.push(message) },
  });
  devtools.inspectedWindow.reload();
  await tick();
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /no CDP session is attached/);
});

test("inspectedWindow.eval: a host-side throw still yields the callback pair", async () => {
  const { devtools } = makeDevtools({
    evalInPage: async () => {
      throw new Error("ipc exploded");
    },
  });
  const pair = await new Promise((resolve) =>
    devtools.inspectedWindow.eval("1+1", (value, info) => resolve([value, info]))
  );
  assert.strictEqual(pair[0], undefined);
  assert.strictEqual(pair[1].isError, true);
  assert.match(pair[1].value, /ipc exploded/);
});

test("out-of-scope APIs exist as inert shapes (stubbing rule)", async () => {
  const { devtools } = makeDevtools();

  // devtools.network with no host behind it: events never fire and getHAR answers
  // with an empty-but-valid HAR log — Chrome's object shape (`harLog.entries`),
  // never invented entries (tests/network-bridge.test.js covers the real feed).
  let fired = 0;
  devtools.network.onRequestFinished.addListener(() => fired++);
  const har = await new Promise((resolve) => devtools.network.getHAR(resolve));
  assert.deepStrictEqual(har.log.entries, []);
  assert.strictEqual(har.version, "1.2");
  assert.strictEqual(fired, 0);
  devtools.network.onNavigated.addListener(() => fired++);
  await tick();
  assert.strictEqual(fired, 0);
  // The honest "why is this empty" channel, so a panel can say "no network data".
  assert.deepStrictEqual(await devtools.network.getNetworkStatus(), {
    available: false,
    observing: false,
    enableState: "idle",
    reason: null,
    requests: 0,
  });
  // Chrome's duality holds on the no-data shapes too: callback style returns nothing.
  const viaCallback = await new Promise((resolve) =>
    devtools.network.getNetworkStatus((status) => resolve(status))
  );
  assert.strictEqual(viaCallback.available, false);
  const body = await devtools.network.getResponseBody({ requestId: "nope" });
  assert.deepStrictEqual(body, {
    content: null,
    encoding: null,
    reason: "chrome.devtools.network has no network backend in this host",
  });
  const bodyViaCallback = await new Promise((resolve) =>
    devtools.network.getResponseBody("nope", (content, encoding) => resolve([content, encoding]))
  );
  assert.deepStrictEqual(bodyViaCallback, [null, null]);

  // panels.elements sidebar panes: inert but addressable
  const pane = await new Promise((resolve) =>
    devtools.panels.elements.createSidebarPane("State", resolve)
  );
  assert.doesNotThrow(() => {
    pane.setTitle("x");
    pane.setExpression("a");
    pane.setObject({});
  });

  // theme + misc namespaces exist without throwing
  assert.strictEqual(devtools.panels.themeName, "dark");
  devtools.panels.themeChanged.addListener(() => {});
  devtools.commands.onCommand.addListener(() => {});
  assert.doesNotThrow(() => devtools.panels.openResource("a.js", 1));
  assert.ok(devtools.inspectedWindow.tabId > 0);
});

test("inspectedWindow.tabId is a stable positive int per extension", () => {
  assert.strictEqual(tabIdFor("altair"), tabIdFor("altair"));
  assert.notStrictEqual(tabIdFor("altair"), tabIdFor("graphql"));
  assert.ok(Number.isInteger(tabIdFor("graphql")) && tabIdFor("graphql") > 0);
});

test("chrome.tabs keeps its shape: events, TAB_ID_NONE, and the honest sendMessage", async () => {
  const { createTabs } = require("../src/chrome-shim/tabs");
  const tabs = createTabs();
  tabs.onUpdated.addListener(() => {});
  assert.strictEqual(tabs.TAB_ID_NONE, -1);
  assert.deepStrictEqual(await tabs.sendMessage(1, "hi"), undefined); // no receivers, yet
  // The one-tab model itself (query/get/create/update/remove) is tested in
  // tests/tabs.test.js, where its host-backed injections can be faked.
});
