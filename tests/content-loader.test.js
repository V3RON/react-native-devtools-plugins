// The app-side half of the content bridge (src/main/content-bridge.js), verified by
// EXECUTING the generated loader in a `node:vm` context that stands in for the app: a
// real JS context, a `Runtime.addBinding`-shaped global function, and a capture of what
// the loader sends.
//
// This is one honest half of the verification story. A fake Metro cannot run JS, so the
// loader's semantics (merge-not-replace, envelope correlation, binary round-trip, the
// effect of a hostile payload) are asserted HERE by running them; the host's socket
// protocol is asserted in tests/content-bridge-protocol.test.js by driving the host
// against a scripted backend. Neither is offered as proof of the other, and neither is
// proof of what happens inside a real Hermes — that question is answered by the live run
// recorded in docs/features/CONTENT-SCRIPTS.md.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");

const {
  BINDING_NAME,
  DISPATCH_GLOBAL,
  loaderSource,
  injectionExpression,
} = require("../src/main/content-bridge");

/**
 * A stand-in "app": a JS context with the two things the loader needs — the global
 * function `Runtime.addBinding` installs, and a way for the host to evaluate an
 * expression into it (which is what `Runtime.evaluate` is).
 */
function makeApp({ responseWaitMs = 50 } = {}) {
  const sent = [];
  const context = vm.createContext({
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    Promise,
    JSON,
    Math,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Error,
    String,
    Number,
    Object,
    Array,
  });
  const globals = vm.runInContext("globalThis", context);
  // The binding, as RuntimeTarget.cpp installs it: a global function of one string. The
  // app owns this property — `setBinding(false)` is an app that removed it.
  let bindingInstalled = true;
  Object.defineProperty(globals, BINDING_NAME, {
    configurable: true,
    get: () => (bindingInstalled ? (text) => sent.push(text) : undefined),
  });

  const evaluate = (expression) => vm.runInContext(expression, context);
  return {
    evaluate,
    /** Values crossing out of the sandbox are compared as JSON, never by identity. */
    json: (expression) => JSON.parse(evaluate(`JSON.stringify(${expression})`) ?? "null"),
    sent,
    dispatch: (text) =>
      evaluate(`globalThis[${JSON.stringify(DISPATCH_GLOBAL)}].dispatch(${JSON.stringify(text)})`),
    setBinding: (live) => {
      bindingInstalled = live;
    },
    install: (extensionId, innerPaths, source) =>
      evaluate(
        injectionExpression({
          extensionId,
          innerPaths,
          source,
          loader: loaderSource({ responseWaitMs }),
        })
      ),
  };
}

const envelopes = (app) => app.sent.map((text) => JSON.parse(text));

// ── the loader installs, and does not clobber ─────────────────────────────────
test("the loader installs a minimal chrome.runtime in the app context", () => {
  const app = makeApp();
  app.install("ext-a", ["content.js"], "1;");
  assert.deepStrictEqual(
    app.json(`[typeof chrome.runtime.sendMessage, typeof chrome.runtime.connect,
      typeof chrome.runtime.onMessage.addListener, typeof chrome.runtime.onMessage.hasListener,
      typeof chrome.runtime.id, chrome.runtime.id,
      typeof globalThis[${JSON.stringify(DISPATCH_GLOBAL)}].dispatch]`),
    ["function", "function", "function", "function", "string", "ext-a", "function"]
  );
});

test("the generated loader is app-side code, and no shell module evaluates it", () => {
  const loader = loaderSource({});
  assert.match(loader, /INSPECTED APP/);
  assert.doesNotMatch(loader, /require\(/, "self-contained: nothing for the app to resolve");
  // The rule issue #10 established, asserted where the new code lives: this layer builds
  // a string for `Runtime.evaluate` in the APP and grows no evaluator of its own.
  const codeOf = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\*\/)/.test(line))
      .join("\n");
  const sources = ["content-bridge.js", "content-scripts.js", "content-gate.js"]
    .map((name) => codeOf(fs.readFileSync(require.resolve(`../src/main/${name}`), "utf8")))
    .join("\n");
  assert.doesNotMatch(sources, /new Function|\beval\(/, "no shell-side evaluator in this layer");
});

test("merge, not replace: an app that already owns global.chrome keeps what it had", () => {
  const app = makeApp();
  app.evaluate(`
    globalThis.chrome = {
      runtime: { id: "the-app-own-id", sendMessage: function () { return "app"; }, custom: 42 },
      appNamespace: { keep: true },
    };
  `);
  app.install("ext-a", ["content.js"], "1;");
  assert.strictEqual(app.json("chrome.runtime.id"), "the-app-own-id");
  assert.strictEqual(app.json("chrome.runtime.custom"), 42);
  assert.strictEqual(app.json("chrome.appNamespace.keep"), true);
  assert.strictEqual(app.json("chrome.runtime.sendMessage()"), "app", "not even a replaced function runs");
  // Members the app lacked ARE added, which is the other half of a merge.
  assert.strictEqual(app.json("typeof chrome.runtime.onMessage"), "object");
});

test("an app-owned accessor is copied as an accessor, not read flat", () => {
  // Two real failure modes this prevented. A throwing page getter used to crash the
  // wrapper build (forExtension threw, so the extension's script never ran at all); a
  // live page getter used to be read ONCE and frozen, so a page that reports state
  // through `chrome.someFlag` showed the value it had at injection time forever.
  const app = makeApp();
  app.evaluate(`
    globalThis.__pageState = "before";
    globalThis.chrome = {
      get liveFlag() { return globalThis.__pageState; },
      get guarded() { throw new Error("the page refuses to answer this"); },
    };
  `);
  app.install("ext-a", ["a.js"], "globalThis.sawLive = chrome.liveFlag;");
  assert.strictEqual(app.json("globalThis.sawLive"), "before", "the getter ran, in the script's own view");

  const view = `globalThis[${JSON.stringify(DISPATCH_GLOBAL)}].forExtension("ext-a", globalThis.chrome)`;
  assert.strictEqual(
    app.json(`(function () { globalThis.__pageState = "after"; return ${view}.liveFlag; })()`),
    "after",
    "and it still reads live on the next build: nothing was snapshotted"
  );
  assert.strictEqual(
    app.json(`typeof Object.getOwnPropertyDescriptor(${view}, "guarded").get`),
    "function",
    "a throwing page getter is preserved as the accessor it is, not read during the copy"
  );
});

test("the app's own chrome.runtime.lastError accessor is not flattened by the merge", () => {
  // `lastError` only means something as a getter. Flattened, every failure this host
  // reports would reach a script as `null` — that is, as a success — so the shape that
  // carries the honesty is asserted here, on both sides of the merge.
  const app = makeApp();
  app.evaluate(`
    globalThis.__err = null;
    globalThis.chrome = { runtime: { get lastError() { return globalThis.__err; }, id: "app" } };
  `);
  app.install("ext-a", ["a.js"], "1;");
  assert.strictEqual(app.json("chrome.runtime.id"), "app", "the app's runtime still wins");
  app.evaluate(`globalThis.__err = { message: "from the page" };`);
  assert.strictEqual(
    app.json("chrome.runtime.lastError.message"),
    "from the page",
    "and reads live, which is only true if the merge did not read it flat"
  );
});

test("the injected chrome.runtime.lastError stays a getter after the merge", () => {
  const app = makeApp();
  app.install("ext-a", ["a.js"], "1;");
  assert.strictEqual(
    app.json(`typeof Object.getOwnPropertyDescriptor(chrome.runtime, "lastError").get`),
    "function",
    "the member the global has is the accessor the loader owns, not a copied null"
  );
  // What that buys the script: the host reporting "nobody can receive this" really does
  // raise lastError inside the callback (the flat copy made every failure read as null).
  app.evaluate(`
    globalThis.seen = "unset";
    chrome.runtime.sendMessage({ping: 1}, function () {
      globalThis.seen = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
    });
  `);
  const sent = envelopes(app).find((e) => e.t === "send");
  app.dispatch(JSON.stringify({ t: "response", x: "ext-a", s: sent.s, e: "Could not establish connection. Receiving end does not exist." }));
  assert.strictEqual(app.json("globalThis.seen"), "Could not establish connection. Receiving end does not exist.");
});

test("a second script in the same context does not clobber the first, and keeps its own id", () => {
  const app = makeApp();
  app.install("ext-a", ["a.js"], "globalThis.aSawId = chrome.runtime.id;");
  app.install("ext-b", ["b.js"], "globalThis.bSawId = chrome.runtime.id;");
  // The GLOBAL chrome.runtime belongs to whoever installed it (one global, merge-not-
  // replace), while each script's own `chrome` is the wrapper's lexical binding — which
  // is what keeps two extensions' traffic apart despite that one global.
  assert.strictEqual(app.json("aSawId"), "ext-a");
  assert.strictEqual(app.json("bSawId"), "ext-b");
  assert.deepStrictEqual(
    app.json(`globalThis[${JSON.stringify(DISPATCH_GLOBAL)}].scripts.map(function (s) { return s.extensionId; })`),
    ["ext-a", "ext-b"]
  );
});

test("re-running the loader in a live context does not drop listeners or ports", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    "chrome.runtime.onMessage.addListener(function () { globalThis.hits = (globalThis.hits||0)+1; });"
  );
  app.evaluate(loaderSource({}), "a re-injection whose loader sees a live dispatch global returns early");
  app.dispatch(
    JSON.stringify({ t: "delivery", x: "ext-a", k: "message", s: 7, p: { message: { go: true }, sender: {} } })
  );
  assert.strictEqual(app.json("hits"), 1, "the listener installed before the re-run is still there");
  assert.deepStrictEqual(envelopes(app).map((e) => [e.t, e.s]), [["respond", 7]]);
});

// ── the envelope protocol, run for real ───────────────────────────────────────
test("sendMessage rides the binding as one envelope, with ids that cannot collide", async () => {
  const app = makeApp();
  app.install("ext-a", ["a.js"], "1;");
  app.install("ext-b", ["b.js"], "1;");
  app.evaluate(`chrome.runtime.sendMessage({n: 1});`);
  app.evaluate(
    `globalThis[${JSON.stringify(DISPATCH_GLOBAL)}].forExtension("ext-b", globalThis.chrome).runtime.sendMessage({n: 2});`
  );
  assert.deepStrictEqual(
    envelopes(app).map((e) => [e.t, e.x, e.s, e.m]),
    [
      ["send", "ext-a", "ext-a#1", { n: 1 }],
      ["send", "ext-b", "ext-b#1", { n: 2 }],
    ],
    "one dispatch global, two extensions, sequence ids scoped per extension"
  );
});

test("a response comes back on the same sequence id, and lastError means what it says", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `globalThis.reply = "unset"; globalThis.err = "none";
     chrome.runtime.sendMessage({ask: true}, function (response) {
       globalThis.reply = response;
       globalThis.err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "none";
     });`
  );
  const sent = envelopes(app)[0];
  assert.strictEqual(sent.t, "send");
  app.dispatch(JSON.stringify({ t: "response", x: "ext-a", s: sent.s, m: { got: "hi" } }));
  assert.deepStrictEqual(app.json("reply"), { got: "hi" });
  assert.strictEqual(app.json("err"), "none", "a successful callback sees no lastError");

  app.evaluate(`chrome.runtime.sendMessage({ask: 2}, function (r) { globalThis.reply2 = r; });`);
  const second = envelopes(app)[1];
  assert.strictEqual(second.s, "ext-a#2", "sequence ids advance per extension");
  app.dispatch(
    JSON.stringify({ t: "response", x: "ext-a", s: second.s, e: "Could not establish connection." })
  );
  assert.strictEqual(app.json("typeof reply2"), "undefined");
});

test("a response for an id nobody asked about is ignored, not applied to another call", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `chrome.runtime.sendMessage({ask: 1}, function (r) { globalThis.reply = r; });`
  );
  const real = envelopes(app)[0].s;
  app.dispatch(JSON.stringify({ t: "response", x: "ext-a", s: "some-other-extension#9", m: "cross-talk" }));
  app.dispatch(JSON.stringify({ t: "response", x: "who-knows", s: real, m: "wrong extension" }));
  assert.strictEqual(app.json("typeof globalThis.reply"), "undefined");
  app.dispatch(JSON.stringify({ t: "response", x: "ext-a", s: real, m: "mine" }));
  assert.strictEqual(app.json("globalThis.reply"), "mine");
});

test("a wait that expires is reported as the wait that expired, never as an empty success", async () => {
  const app = makeApp({ responseWaitMs: 10 });
  app.install(
    "ext-a",
    ["a.js"],
    `chrome.runtime.sendMessage({ask: true}).then(
       function (v) { globalThis.outcome = ["resolved", v]; },
       function (error) { globalThis.outcome = ["rejected", String(error && error.message)]; }
     );`
  );
  for (let i = 0; i < 20 && app.json("typeof globalThis.outcome") === "undefined"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const outcome = app.json("globalThis.outcome");
  assert.strictEqual(outcome[0], "rejected", "nobody answered, so the promise rejects");
  assert.match(outcome[1], /within 10ms/);
});

test("a message with no listener says so, instead of answering undefined", () => {
  const app = makeApp();
  app.install("ext-a", ["a.js"], "1;");
  app.dispatch(
    JSON.stringify({ t: "delivery", x: "ext-a", k: "message", s: 3, p: { message: {}, sender: {} } })
  );
  const [envelope] = envelopes(app);
  assert.strictEqual(envelope.t, "respond");
  assert.strictEqual(envelope.nr, true, "no receiver, distinctly");
  assert.match(envelope.e, /Receiving end does not exist/);
});

test("a listener that returns true keeps the leg open and answers once", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
       globalThis.__send = sendResponse; globalThis.__sender = sender; return true;
     });`
  );
  app.dispatch(
    JSON.stringify({
      t: "delivery",
      x: "ext-a",
      k: "message",
      s: 11,
      p: { message: { hello: 1 }, sender: { id: "ext-a", url: "rozenite://ext-a/" } },
    })
  );
  assert.deepStrictEqual(app.json("globalThis.__sender"), { id: "ext-a", url: "rozenite://ext-a/" });
  assert.deepStrictEqual(app.sent, [], "the leg stays open while the extension thinks");
  app.evaluate(`globalThis.__send({late: true});`);
  assert.deepStrictEqual(envelopes(app)[0], {
    t: "respond",
    x: "ext-a",
    s: 11,
    m: { late: true },
  });
  app.evaluate(`globalThis.__send({too: "late"});`);
  assert.strictEqual(app.sent.length, 1, "Chrome: only the first sendResponse reaches the sender");
});

test("a throwing listener is reported and does not stop the other listeners", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `chrome.runtime.onMessage.addListener(function () { throw new Error("boom"); });
     chrome.runtime.onMessage.addListener(function () { globalThis.secondRan = true; });`
  );
  app.dispatch(
    JSON.stringify({ t: "delivery", x: "ext-a", k: "message", s: 5, p: { message: {}, sender: {} } })
  );
  assert.strictEqual(app.json("globalThis.secondRan"), true);
  const reports = envelopes(app).filter((e) => e.t === "report");
  assert.deepStrictEqual(reports.map((e) => e.k), ["listener-threw"]);
  assert.match(reports[0].d, /boom/);
});

test("the host's \"no receiver\" arrives as lastError + a rejected promise, not an empty answer", async () => {
  // The app-visible half of the lost-send defect: the live run's fixture reported
  // `{"response":undefined,"lastError":null}` for a message nobody received, because the
  // host answered with the value it reserves for "a listener answered nothing". Once the
  // host says it honestly (src/main/content-bridge.js), THIS is what the script sees.
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `globalThis.reported = "unset"; globalThis.rejected = "unset";
     chrome.runtime.sendMessage({from: "first statement"}, function (response) {
       globalThis.reported = JSON.stringify({
         response: response === undefined ? "<undefined>" : response,
         lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
       });
     });`
  );
  const sent = envelopes(app)[0];
  app.dispatch(
    JSON.stringify({
      t: "response",
      x: "ext-a",
      s: sent.s,
      e: "Could not establish connection. Receiving end does not exist. No other context…",
    })
  );
  const reported = app.json("globalThis.reported");
  assert.match(reported, /"lastError":"Could not establish connection\. Receiving end does not exist/);
  assert.match(reported, /"response":"<undefined>"/);

  // Promise form, with no callback: the same failure rejects rather than resolving.
  const other = makeApp();
  other.install(
    "ext-b",
    ["b.js"],
    `chrome.runtime.sendMessage({from: "first statement"}).then(
       function (v) { globalThis.outcome = ["resolved", String(v)]; },
       function (error) { globalThis.outcome = ["rejected", String(error.message)]; });`
  );
  const envelope = other.sent.map((t) => JSON.parse(t)).find((e) => e.t === "send");
  other.dispatch(
    JSON.stringify({
      t: "response",
      x: "ext-b",
      s: envelope.s,
      e: "Could not establish connection. Receiving end does not exist.",
    })
  );
  // A promise reaction is a microtask, so it needs the host's stack to unwind first —
  // the same reason the timeout test below polls instead of reading straight away.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(other.json("globalThis.outcome"), [
    "rejected",
    "Could not establish connection. Receiving end does not exist.",
  ]);
});

// ── binary + oversized payloads ───────────────────────────────────────────────
test("binary travels base64 and comes back as bytes on both legs", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
       var view = new Uint8Array(message.bytes);
       globalThis.__seen = [view.length, view[0], view[view.length - 1]];
       sendResponse({ echoed: new Uint8Array([9, 8, 7]).buffer, big: "x".repeat(40000) });
       return true;
     });`
  );
  app.dispatch(
    JSON.stringify({
      t: "delivery",
      x: "ext-a",
      k: "message",
      s: 21,
      p: {
        message: { bytes: { __rozeniteBase64: Buffer.from([1, 2, 3, 250, 251, 252]).toString("base64") } },
        sender: {},
      },
    })
  );
  assert.deepStrictEqual(app.json("globalThis.__seen"), [6, 1, 252]);
  const envelope = envelopes(app)[0];
  assert.strictEqual(envelope.t, "respond");
  assert.deepStrictEqual(
    Buffer.from(envelope.m.echoed.__rozeniteBase64, "base64"),
    Buffer.from([9, 8, 7])
  );
  assert.strictEqual(envelope.m.big.length, 40000, "an oversized string survives the JSON envelope");
});

test("a circular payload cannot take the transport down", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `var cyclic = {name: "loop"}; cyclic.self = cyclic; chrome.runtime.sendMessage(cyclic);`
  );
  const envelope = envelopes(app)[0];
  assert.strictEqual(envelope.m.name, "loop");
  assert.strictEqual(envelope.m.self, "[circular]");
});

// ── hostile input ─────────────────────────────────────────────────────────────
test("a hostile dispatch payload cannot break the app-side transport", () => {
  const app = makeApp();
  app.install("ext-a", ["a.js"], "1;");
  const before = app.json(`[chrome.runtime.id, typeof chrome.runtime.sendMessage]`);
  for (const text of [
    "",
    "not json at all",
    "null",
    "42",
    '"a string"',
    JSON.stringify({ t: 17 }),
    JSON.stringify({ t: "delivery" }),
    JSON.stringify({ t: "delivery", x: "ext-a", k: "nonsense", s: 1 }),
    JSON.stringify({ t: "delivery", x: "who-are-you", k: "message", s: 1, p: { message: {} } }),
    JSON.stringify({ t: "response", x: "ext-a", s: "never-asked" }),
    '{"__proto__": {"polluted": true}, "t": "delivery", "x": "ext-a", "k": "message", "s": 2}',
  ]) {
    assert.doesNotThrow(() => app.dispatch(text), `dispatch(${JSON.stringify(text.slice(0, 40))})`);
  }
  assert.deepStrictEqual(app.json(`[chrome.runtime.id, typeof chrome.runtime.sendMessage]`), before);
  assert.strictEqual(app.json("typeof ({}).polluted"), "undefined", "nothing reached Object.prototype");
  const reports = envelopes(app).filter((e) => e.t === "report");
  assert.ok(reports.length >= 5, `bad envelopes are reported: ${JSON.stringify(reports.map((r) => r.k))}`);
});

test("an app that removed the binding gets a failed call, not a message into a void", async () => {
  const app = makeApp({ responseWaitMs: 10 });
  app.install("ext-a", ["a.js"], "1;");
  app.setBinding(false);
  app.evaluate(
    `chrome.runtime.sendMessage({x: 1}).catch(function (e) { globalThis.failure = String(e.message); });`
  );
  for (let i = 0; i < 20 && app.json("typeof globalThis.failure") === "undefined"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(String(app.json("globalThis.failure")), /Could not establish connection/);
  assert.deepStrictEqual(app.sent, [], "nothing was shouted at a missing binding");
});

// ── Ports ─────────────────────────────────────────────────────────────────────
test("a Port the app opens survives connect, post and disconnect", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `globalThis.port = chrome.runtime.connect({name: "relay"});
     globalThis.disconnects = 0; globalThis.inbox = [];
     globalThis.port.onMessage.addListener(function (message, from) { globalThis.inbox.push([message, from]); });
     globalThis.port.onDisconnect.addListener(function () { globalThis.disconnects += 1; });`
  );
  const connect = envelopes(app)[0];
  assert.deepStrictEqual([connect.t, connect.x, connect.n], ["port-connect", "ext-a", "relay"]);
  app.dispatch(JSON.stringify({ t: "port-open", x: "ext-a", s: connect.s, p: 99 }));
  assert.strictEqual(app.json("globalThis.port.portId"), 99, "Chrome exposes the router's id");

  app.evaluate(`globalThis.port.postMessage({tick: 1});`);
  assert.deepStrictEqual(envelopes(app)[1], {
    t: "port-post",
    x: "ext-a",
    s: connect.s,
    m: { tick: 1 },
  });

  app.dispatch(
    JSON.stringify({
      t: "delivery",
      x: "ext-a",
      k: "port-message",
      s: 99,
      p: { message: { from: "panel" }, from: { id: "ext-a" } },
    })
  );
  assert.deepStrictEqual(
    app.json("globalThis.inbox"),
    [[{ from: "panel" }, { id: "ext-a" }]],
    "a host-side port id reaches the port the app opened under its own local id"
  );

  app.evaluate(`globalThis.port.disconnect();`);
  const close = envelopes(app)[envelopes(app).length - 1];
  assert.deepStrictEqual([close.t, close.s], ["port-close", connect.s]);
  // Same rule as the shell's own frame-side client (src/chrome-shim/messaging.js): a
  // local disconnect() closes this leg and tells the HOST; the local onDisconnect is the
  // host's `port-disconnect` to deliver, which is what the mesh does for every other peer.
  assert.strictEqual(app.json("globalThis.disconnects"), 0);
  app.evaluate(`globalThis.port.postMessage({afterClose: true});`);
  assert.strictEqual(envelopes(app).length, envelopes(app).length, "a closed port posts nothing more");
  app.dispatch(JSON.stringify({ t: "delivery", x: "ext-a", k: "port-disconnect", s: 99 }));
  assert.strictEqual(app.json("globalThis.disconnects"), 0, "and a disconnect for a gone leg is not double-fired");
});

test("a Port a panel opens is a real Port inside the app too", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `globalThis.connections = [];
     chrome.runtime.onConnect.addListener(function (port) {
       globalThis.connections.push(port);
       port.onMessage.addListener(function (message) { port.postMessage({echo: message}); });
     });`
  );
  app.dispatch(
    JSON.stringify({ t: "delivery", x: "ext-a", k: "port-connect", s: 4242, p: { name: "from-panel", sender: {} } })
  );
  assert.strictEqual(app.json("globalThis.connections.length"), 1);
  app.dispatch(
    JSON.stringify({
      t: "delivery",
      x: "ext-a",
      k: "port-message",
      s: 4242,
      p: { message: { hi: 1 }, from: { id: "ext-a" } },
    })
  );
  assert.deepStrictEqual(envelopes(app)[0], {
    t: "port-post",
    x: "ext-a",
    s: 4242,
    m: { echo: { hi: 1 } },
  });
  app.dispatch(JSON.stringify({ t: "delivery", x: "ext-a", k: "port-disconnect", s: 4242 }));
  assert.strictEqual(
    app.json("globalThis.connections[0].lastError.message"),
    "Port disconnected",
    "Chrome's shape: the peer's leg ending arrives as lastError + onDisconnect"
  );
  assert.strictEqual(app.json("typeof globalThis.connections[0].lastError"), "object");
  const after = envelopes(app).length;
  app.evaluate(`globalThis.connections[0].postMessage({into: "a dead leg"});`);
  assert.strictEqual(envelopes(app).length, after, "a closed port posts nothing, so nothing can leak");
});

test("connect() with no peer disconnects with Chrome's own message", () => {
  const app = makeApp();
  app.install(
    "ext-a",
    ["a.js"],
    `globalThis.port = chrome.runtime.connect({name: "lonely"});
     globalThis.reason = null;
     globalThis.port.onDisconnect.addListener(function (p) { globalThis.reason = p.lastError && p.lastError.message; });`
  );
  const connect = envelopes(app)[0];
  app.dispatch(
    JSON.stringify({ t: "port-drop", x: "ext-a", s: connect.s, p: "Could not establish connection." })
  );
  assert.strictEqual(app.json("globalThis.reason"), "Could not establish connection.");
});
