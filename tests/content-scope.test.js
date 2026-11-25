// An extension's `window` inside the app (src/electron/extensions/internal/content/scope.js),
// executed in a `node:vm` context that stands in for a Hermes app: no `window`, no
// `document`, no `navigator`, no `Event`, no `MessageChannel`. Each case below is a
// behaviour a real Chrome Web Store extension depends on (named per test); the live run
// against those extensions is recorded in docs/features/CONTENT-SCRIPTS.md.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const {
  scopeExpression,
  scopedExpression,
  mainWorldExpression,
  claimExpression,
  unlessRanEarly,
  markRanEarlyExpression,
} = require("../src/electron/extensions/internal/content/scope");
const {
  BINDING_NAME,
  loaderSource,
  injectionExpression,
  ownInnerPath,
} = require("../src/electron/extensions/internal/content/content-bridge");
const { inWorldOf } = require("../src/electron/extensions/internal/cdp/inspected-window");
const { earlyMainWorldSource } = require("../src/electron/extensions/early-main-world");

/** A bare JS context, as Hermes' global looks before and after InitializeCore. */
const makeApp = (extra = {}) => {
  const context = vm.createContext({
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    Promise,
    JSON,
    Error,
    TypeError,
    Symbol,
    Proxy,
    Reflect,
    Object,
    Array,
    Date,
    Function,
    ...extra,
  });
  const log = [];
  const global = vm.runInContext("globalThis", context);
  global.log = (value) => log.push(value);
  return { run: (code) => vm.runInContext(code, context), global, log };
};

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("the browser surface exists inside the scope and nowhere else", () => {
  const app = makeApp();
  const seen = app.run(
    scopedExpression({
      extensionId: "ext",
      body: `return {
        title: document.title,
        ua: typeof navigator.userAgent,
        href: location.href,
        viaWindow: window.document === document,
        event: new CustomEvent("x", { detail: 1 }).detail,
        isWindow: window === globalThis && self === window,
      };`,
    })
  );
  assert.deepStrictEqual({ ...seen }, { title: "", ua: "string", href: "about:blank", viaWindow: true, event: 1, isWindow: true });
  for (const name of ["document", "location", "navigator", "Event", "CustomEvent", "MessageEvent", "MessageChannel", "window"]) {
    assert.ok(!(name in app.global), `${name} is not installed on the app's global`);
  }
});

test("a class can extend the scope's Event at load time (TanStack Query DevTools' WXT runtime)", async () => {
  const app = makeApp();
  app.run(
    mainWorldExpression({
      extensionId: "ext",
      source: `class Changed extends Event { constructor() { super("changed"); this.n = 7; } }
        document.addEventListener("changed", (e) => log("heard " + e.n + " " + (e instanceof Event)));
        document.dispatchEvent(new Changed());`,
    })
  );
  assert.deepStrictEqual(app.log, ["heard 7 true"]);
});

test("a transferred MessagePort arrives as event.ports, on a trusted MessageEvent (Apollo Client Devtools)", async () => {
  const app = makeApp();
  // tab.js (ISOLATED) listens first, as the manifest orders it, and reads `data` through
  // MessageEvent.prototype's own getter, as Apollo's code does.
  app.run(
    scopedExpression({
      extensionId: "apollo",
      body: `const dataOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data").get);
        const post = Function.prototype.call.bind(MessagePort.prototype.postMessage);
        window.addEventListener("message", (event) => {
          if (!event.isTrusted || event.source !== window || event.ports.length !== 1) return;
          const port = event.ports[0];
          port.addEventListener("message", (e) => log("tab got " + dataOf(e)));
          port.start();
          post(port, "hello hook");
        });`,
    })
  );
  // hook.js (MAIN) hands it a port.
  app.run(
    mainWorldExpression({
      extensionId: "apollo",
      source: `const { port1, port2 } = new MessageChannel();
        port1.onmessage = (e) => { log("hook got " + e.data); port1.postMessage("ack"); };
        window.postMessage({ type: "connect" }, "*", [port2]);`,
    })
  );
  await settle();
  assert.deepStrictEqual(app.log, ["hook got hello hook", "tab got ack"]);
  const constructed = app.run(scopedExpression({ extensionId: "apollo", body: `return new MessageEvent("message", { data: 1 }).isTrusted;` }));
  assert.strictEqual(constructed, false, "an event a script makes itself stays untrusted");
});

test("what the MAIN world posts before the ISOLATED world exists is handed to it once, on claim (Redux DevTools' INIT_INSTANCE)", async () => {
  const app = makeApp();
  app.run(
    mainWorldExpression({
      extensionId: "redux",
      source: `window.addEventListener("message", (e) => log("page heard " + e.data.type));
        window.postMessage({ type: "INIT_INSTANCE" }, "*");`,
    })
  );
  await settle();
  assert.deepStrictEqual(app.log, ["page heard INIT_INSTANCE"]);
  app.run(scopedExpression({ extensionId: "redux", body: `window.addEventListener("message", (e) => log("content heard " + e.data.type));` }));
  app.run(claimExpression("redux"));
  app.run(claimExpression("redux"));
  await settle();
  assert.deepStrictEqual(
    app.log,
    ["page heard INIT_INSTANCE", "content heard INIT_INSTANCE"],
    "the late listener hears it once; the page does not hear its own message twice"
  );
  app.run(mainWorldExpression({ extensionId: "redux", source: `window.postMessage({ type: "LATER" }, "*");` }));
  await settle();
  assert.deepStrictEqual(app.log.slice(2), ["page heard LATER", "content heard LATER"], "after the claim, delivery is plain");
});

test("an ISOLATED world hears React announced when React DevTools' hook has a renderer (React Context DevTool)", async () => {
  const app = makeApp();
  app.global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map([[1, { bundleType: 1 }]]) };
  app.run(scopedExpression({ extensionId: "ctx", body: `window.addEventListener("message", (e) => log(JSON.stringify(e.data)));` }));
  app.run(claimExpression("ctx"));
  await settle();
  assert.deepStrictEqual(app.log, [
    JSON.stringify({ source: "react-devtools-hook", payload: { type: "react-renderer-attached", reactBuildType: "development" } }),
  ]);
});

test("a file run before the app's first module is not run again by the host (Relay's non-configurable hook)", () => {
  const app = makeApp();
  const source = `Object.defineProperty(window, "__HOOK__", { configurable: false, value: {} }); log("installed");`;
  app.run(mainWorldExpression({ extensionId: "relay", source }));
  app.run(markRanEarlyExpression({ extensionId: "relay", innerPath: "build/hook.js" }));
  app.run(unlessRanEarly({ extensionId: "relay", innerPaths: ["build/hook.js"], statement: mainWorldExpression({ extensionId: "relay", source }) }));
  assert.deepStrictEqual(app.log, ["installed"]);
  app.run(unlessRanEarly({ extensionId: "relay", innerPaths: ["build/other.js"], statement: `log("other ran");` }));
  assert.deepStrictEqual(app.log, ["installed", "other ran"], "a file that did not run early runs");
});

test("globalThis.chrome in an ISOLATED world is that extension's own API (TanStack Query DevTools)", () => {
  const app = makeApp();
  app.global[BINDING_NAME] = () => {};
  const loader = loaderSource();
  app.run(injectionExpression({ extensionId: "first", innerPaths: ["a.js"], source: "", loader }));
  app.run(
    injectionExpression({
      extensionId: "second",
      innerPaths: ["b.js"],
      source: `log(globalThis.chrome.runtime.id + " " + window.chrome.runtime.id + " " + chrome.runtime.id + " " + typeof chrome.storage.local.get);`,
      loader,
    })
  );
  assert.deepStrictEqual(app.log, ["second second second function"]);
  assert.strictEqual(app.global.chrome.runtime.id, "first", "the app's one global chrome is unchanged");
});

test("<script src> from a content script asks the host for the extension's own file (Relay DevTools)", async () => {
  const app = makeApp();
  const asked = [];
  app.global.__RozeniteContentBridge = {
    loadScript: (id, src, done) => {
      asked.push([id, src]);
      done(true);
    },
  };
  app.run(
    scopedExpression({
      extensionId: "relay",
      body: `const s = document.createElement("script");
        s.src = "build/backend.js";
        s.onload = () => log("loaded");
        document.documentElement.appendChild(s);
        s.remove();`,
    })
  );
  await settle();
  assert.deepStrictEqual(asked, [["relay", "build/backend.js"]]);
  assert.deepStrictEqual(app.log, ["loaded"]);
});

test("a script src names only the calling extension's own files", () => {
  assert.strictEqual(ownInnerPath("abc", "build/backend.js"), "build/backend.js");
  assert.strictEqual(ownInnerPath("abc", "/build/backend.js?x#y"), "build/backend.js");
  assert.strictEqual(ownInnerPath("abc", "rozenite://abc/x.js"), "x.js");
  assert.strictEqual(ownInnerPath("abc", "chrome-extension://abc/x.js"), "x.js");
  assert.strictEqual(ownInnerPath("abc", "rozenite://other/x.js"), null);
  assert.strictEqual(ownInnerPath("abc", "https://example.com/x.js"), null);
  assert.strictEqual(ownInnerPath("abc", "data:text/javascript,1"), null);
  assert.strictEqual(ownInnerPath("abc", "a/../../x.js"), null);
});

test("inspectedWindow.eval runs an expression in the calling extension's MAIN world (Relay DevTools' panel)", async () => {
  const app = makeApp();
  app.run(scopedExpression({ extensionId: "relay", body: `window.addEventListener("message", (e) => log(e.data.source));` }));
  const value = app.run(inWorldOf("relay", "window.postMessage({ source: 'inject-backend' }, window.origin);"));
  assert.strictEqual(value, undefined);
  await settle();
  assert.deepStrictEqual(app.log, ["inject-backend"]);
  assert.strictEqual(app.run(inWorldOf("relay", "1 + 1")), 2, "an expression's value is still the answer");
  assert.strictEqual(inWorldOf("relay", "var x = 1; x"), "var x = 1; x", "statements run as written");
  assert.strictEqual(inWorldOf(null, "window.x"), "window.x", "no extension, no scope");
});

test("the early installer runs Redux DevTools' page script from its .crx, in its scope, before any module", () => {
  const { source, ran, problems } = earlyMainWorldSource({
    extensionsDir: path.join(__dirname, "..", "extensions"),
    extensions: ["lmhkpmbekcpmknklioeibfkpmmfibljd", "not-installed"],
  });
  assert.deepStrictEqual(ran, [{ id: "lmhkpmbekcpmknklioeibfkpmmfibljd", file: "page.bundle.js" }]);
  assert.match(problems.join("\n"), /not-installed: not installed/);
  // React Native's global before InitializeCore: no timers yet, no window.
  const app = makeApp({ setTimeout: undefined, clearTimeout: undefined });
  app.run(source);
  assert.strictEqual(typeof app.global.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__, "function", "configureStore will find it");
  assert.ok(!("window" in app.global), "and the app's global got no window");
  assert.strictEqual(
    app.run(`${scopeExpression("lmhkpmbekcpmknklioeibfkpmmfibljd")}.__rozeniteEarly["page.bundle.js"]`),
    true,
    "marked, so the host does not run it a second time"
  );
});
