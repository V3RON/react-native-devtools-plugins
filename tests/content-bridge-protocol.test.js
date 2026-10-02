// The HOST half of the content bridge (src/main/content-bridge.js), driven against a
// scripted CDP backend and the REAL message router (src/main/message-router.js).
//
// What this proves and what it does not: it proves host-side behaviour — what the shell
// asks the app to evaluate, in what order, under which gate verdicts, how it correlates
// replies across two extensions, and how it behaves when the session is gone or a
// payload is hostile. A scripted backend cannot execute JavaScript, so NOTHING here is
// evidence that a script ran inside an app; the loader's actual semantics are executed in
// tests/content-loader.test.js, and the real app run is recorded in
// docs/features/CONTENT-SCRIPTS.md.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const {
  BINDING_NAME,
  DISPATCH_GLOBAL,
  createContentBridge,
} = require("../src/main/content-bridge");
const { parseContentScripts } = require("../src/main/content-scripts");
const { createMessageRouter } = require("../src/main/message-router");
const { tabIdFor } = require("../src/chrome-shim/devtools");
const { ALL_RN_TARGETS } = require("../src/main/content-gate");

/**
 * A scripted CDP backend: it answers the Runtime methods this layer uses with the
 * shapes RN's backend really answers (the same shapes tests/cdp-bridge.test.js pins)
 * and records everything it was asked to evaluate.
 */
function makeBackend({
  attached = true,
  bindingLive = true,
  loaderLive = true,
  evaluationsFail = false,
} = {}) {
  const commands = [];
  const handlers = new Set();
  const state = { attached, bindingLive, loaderLive, evaluationsFail };
  /** What an `expression` is answering, per the switches a test wants to flip. */
  const truthOf = (expression) => {
    if (expression.includes(`typeof globalThis[${JSON.stringify(BINDING_NAME)}]`)) {
      return state.bindingLive;
    }
    if (expression.includes(`${DISPATCH_GLOBAL}.__protocol`)) {
      return state.loaderLive;
    }
    // A refusal is only ever about a SCRIPT or a DELIVERY: the probes above still
    // answer, so a test that says "the app refused" means the injection was refused.
    if (state.evaluationsFail) return null;
    return undefined;
  };
  const sendCommand = async (method, params = {}) => {
    commands.push({ method, params });
    if (!state.attached) {
      throw Object.assign(new Error(`${method}: no CDP session is attached`), { code: "DETACHED" });
    }
    if (method === "Runtime.addBinding") {
      return {}; // RN answers `{}` (HostTarget.cpp:175-192)
    }
    if (method === "Runtime.evaluate") {
      const answer = truthOf(String(params.expression || ""));
      if (answer === null) {
        // A tooling-side refusal: `text` only, no `exception` object — which is how
        // src/main/inspected-window.js maps it to `isError` rather than `isException`.
        return { exceptionDetails: { text: "EvalError: the app refused the expression" } };
      }
      if (answer !== undefined) {
        // returnByValue, as toEvaluateParams asks for.
        return { result: { type: "boolean", value: answer } };
      }
      return { result: { type: "string", value: "ok" } };
    }
    return {};
  };
  return {
    state,
    commands,
    sendCommand,
    evaluates: () => commands.filter((c) => c.method === "Runtime.evaluate"),
    addBindings: () => commands.filter((c) => c.method === "Runtime.addBinding"),
    onEvent: (method, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit: (method, params) => {
      for (const handler of [...handlers]) handler(params || {}, method);
    },
    isAttached: () => state.attached,
  };
}

/**
 * One extension folder's worth of registry data, without touching the filesystem — but
 * run through the REAL parser, so a test cannot accidentally invent a field the registry
 * would never produce (an unnormalized entry used to carry `index: undefined`).
 */
const fixture = (extensionId, entries = [{ matches: ["https://app.test/*"], js: ["content.js"] }]) => ({
  extensionId,
  name: extensionId,
  entries: parseContentScripts({ content_scripts: entries }).entries,
  problems: parseContentScripts({ content_scripts: entries }).problems,
});

const scanOf = (...found) => () => found;

const readerFor = (sources) => ({
  resolvePaths: (extensionId, entry) => ({
    js: entry.js.map((innerPath) => ({
      ok: sources[innerPath] !== undefined,
      kind: "js",
      innerPath,
      reason:
        sources[innerPath] === undefined
          ? `js "${innerPath}" is declared in the manifest but is not a file in ${extensionId}`
          : undefined,
    })),
    css: (entry.css || []).map(() => ({ ok: false, kind: "css", innerPath: "x.css", reason: "no css" })),
  }),
  readSources: (extensionId, resolved) => {
    const out = [];
    const problems = [];
    for (const file of resolved.js) {
      if (!file.ok) {
        problems.push(file.reason);
        continue;
      }
      out.push({ innerPath: file.innerPath, source: sources[file.innerPath] });
    }
    return { sources: out, problems };
  },
});

function makeWorld(options = {}) {
  const backend = makeBackend(options.backend || {});
  const router = createMessageRouter();
  const logs = [];
  const found = options.found || [fixture("ext-a")];
  const reader = readerFor(options.sources || { "content.js": "globalThis.hooked = true;" });
  const bridge = createContentBridge({
    sendCommand: backend.sendCommand,
    onEvent: backend.onEvent,
    isAttached: backend.isAttached,
    scan: options.scan || scanOf(...found),
    readManifest: options.readManifest || (() => ({ name: "Fixture" })),
    resolvePaths: reader.resolvePaths,
    readSources: reader.readSources,
    allowlist: options.allowlist ?? null,
    router,
    targetInfo: options.targetInfo || (() => ({ attached: true, url: "my-app://rn", title: "RN" })),
    log: { warn: (message) => logs.push(message), error: (m) => logs.push(m), log: (m) => logs.push(m) },
    requestTimeoutMs: 200,
    sweepIntervalMs: 0,
    ...options.bridge,
  });
  /**
   * A panel of the same extension, speaking the router's own frame protocol. `which`
   * keeps two panels of one extension distinct, the way two real frames are.
   */
  const makePanel = (extensionId = "ext-a", which = "panel") => {
    const key = `${which}:${extensionId}`;
    const received = [];
    let respond = null;
    router.registerFrame({
      key,
      extensionId,
      url: `rozenite://${extensionId}/panel.html`,
      send: (delivery) => {
        received.push(delivery);
        if (respond && delivery.kind === "message") respond(delivery.payload);
      },
    });
    return {
      key,
      received,
      setResponder: (fn) => {
        respond = fn;
      },
      /** Completes one leg exactly the way a real frame's RUNTIME_SEND_RESPONSE does. */
      answer: ({ requestId, response }) => router.resolveDelivery({ fromKey: key, requestId, response }),
    };
  };
  return { backend, router, bridge, logs, makePanel };
}

const injectedExpressions = (world) =>
  world.backend
    .evaluates()
    .map((command) => String(command.params.expression))
    .filter((expression) => expression.includes(`${DISPATCH_GLOBAL}.inject(`));

/**
 * The host->app envelopes this shell asked the app to run, decoded. A
 * `dispatchExpression` nests two levels of JSON on purpose (a JSON envelope carried by a
 * JS string literal), so unwrapping means parsing twice — and a test that skipped that
 * would silently compare against strings and see nothing.
 */
const dispatched = (world) =>
  world.backend
    .evaluates()
    .map((command) => String(command.params.expression))
    .filter((expression) => expression.includes(`${DISPATCH_GLOBAL}.dispatch(`))
    .map((expression) => {
      const literal = expression.slice(
        expression.indexOf(`${DISPATCH_GLOBAL}.dispatch(`) + `${DISPATCH_GLOBAL}.dispatch(`.length,
        -2
      );
      return JSON.parse(JSON.parse(literal));
    });

const binding = (envelope) => ({ name: BINDING_NAME, payload: JSON.stringify(envelope) });

/**
 * Let the host finish the work its deliveries turned into. Re-injection is deliberately
 * debounced through a real timer (a burst of context notifications should re-run it
 * once), so awaiting microtasks is not enough — this awaits a macrotask too.
 */
const settleApp = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// ── the gate is what runs first ───────────────────────────────────────────────
test("the default injects nothing at all, and the report says why", async () => {
  const world = makeWorld();
  const report = await world.bridge.attach();
  assert.deepStrictEqual(
    report.map((entry) => [entry.extensionId, entry.injected, entry.pending]),
    [["ext-a", false, false]]
  );
  assert.deepStrictEqual(injectedExpressions(world), [], "no Runtime.evaluate carried a script");
  assert.strictEqual(world.backend.addBindings().length, 0, "not even the binding is installed");
  const entry = report[0].entries[0];
  assert.strictEqual(entry.allowed, false);
  assert.strictEqual(entry.code, "not-allowlisted");
  assert.match(entry.reasons.join(" "), /DEVTOOLS_CONTENT_SCRIPTS/);
  assert.match(entry.notes.join(" "), /has no RN analog/);
  assert.match(world.logs.join("\n"), /not allowlisted/);
  world.bridge.dispose();
});

test("allowlisting an extension is what makes the injection happen", async () => {
  const world = makeWorld({ allowlist: "ext-a" });
  const report = await world.bridge.attach();
  assert.strictEqual(report[0].injected, true);
  const [injection] = injectedExpressions(world);
  assert.match(injection, /globalThis\.hooked = true;/, "the manifest's script is the one that went over");
  assert.match(injection, /__RozeniteContentBridge\.inject\("ext-a", \["content\.js"\]\)/);
  // The binding is the shell's one reserved name, asked for exactly once per context.
  assert.deepStrictEqual(
    world.backend.addBindings().map((c) => c.params),
    [{ name: BINDING_NAME }]
  );
  assert.ok(world.router, "and the app has a seat in the one mesh");
  world.bridge.dispose();
});

test("an unattached session is an honest rejection, never a queued lie", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS, backend: { attached: false } });
  const report = await world.bridge.attach();
  assert.strictEqual(report[0].injected, false);
  assert.strictEqual(report[0].pending, true);
  assert.match(report[0].lastError, /no CDP session is attached/);
  assert.match(report[0].lastError, /not queued/);
  assert.deepStrictEqual(injectedExpressions(world), []);
  assert.match(world.logs.join("\n"), /deferred/);

  // Attaching later is what picks it up — the sweep, not a stored promise.
  world.backend.state.attached = true;
  world.backend.state.bindingLive = true;
  const after = await world.bridge.refresh();
  assert.strictEqual(after[0].injected, true);
  assert.strictEqual(after[0].pending, false);
  world.bridge.dispose();
});

test("an app that never installs the binding gets no script at all", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS, backend: { bindingLive: false } });
  const report = await world.bridge.attach();
  assert.strictEqual(report[0].injected, false);
  assert.match(report[0].lastError, /did not install __rozeniteContentBridgeDispatch/);
  assert.deepStrictEqual(injectedExpressions(world), []);
  world.bridge.dispose();
});

test("a script the app refuses is reported with the app's own reason, not swallowed", async () => {
  const world = makeWorld({
    allowlist: ALL_RN_TARGETS,
    backend: { evaluationsFail: true },
  });
  const report = await world.bridge.attach();
  assert.strictEqual(report[0].injected, false);
  assert.strictEqual(report[0].entries[0].injected, false);
  assert.match(report[0].entries[0].injectError, /the app refused/);
  world.bridge.dispose();
});

test("a declared script that is not on disk is reported, and nothing is injected", async () => {
  const world = makeWorld({
    allowlist: ALL_RN_TARGETS,
    sources: {},
    found: [fixture("ext-a", [{ matches: ["<all_urls>"], js: ["gone.js"] }])],
  });
  const report = await world.bridge.attach();
  assert.strictEqual(report[0].injected, false);
  assert.match(report[0].entries[0].problems.join(" "), /gone\.js.*is not a file/);
  assert.deepStrictEqual(injectedExpressions(world), []);
  world.bridge.dispose();
});

// ── re-injection ──────────────────────────────────────────────────────────────
test("a recreated execution context re-runs injection, and re-installs the binding", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  assert.strictEqual(injectedExpressions(world).length, 1);
  assert.strictEqual(world.backend.addBindings().length, 1);

  world.backend.emit("Runtime.executionContextCreated", {
    context: { id: 2, name: "", origin: "", uniqueId: "2" },
  });
  await settleApp();
  assert.strictEqual(injectedExpressions(world).length, 2, "the script went in again");
  assert.strictEqual(world.backend.addBindings().length, 2, "a fresh context has no binding handler");
  world.bridge.dispose();
});

test("cleared contexts withdraw the app's mesh seat before re-injecting", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  const panel = world.makePanel();
  const inFlight = world.router.sendMessage({ fromKey: "panel:ext-a", message: { hi: 1 } });

  world.backend.emit("Runtime.executionContextsCleared", {});
  await settleApp();
  // The panel's own leg still settles: the router settles a leg whose frame is gone
  // rather than hanging the sender.
  const settled = await Promise.race([
    inFlight.then(() => "settled").catch(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
  ]);
  assert.strictEqual(settled, "settled");
  assert.ok(injectedExpressions(world).length >= 2, "and injection ran again afterwards");
  world.bridge.dispose();
});

test("a session that died while injected withdraws the seat instead of queueing deliveries", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  assert.strictEqual(world.backend.isAttached(), true);
  world.backend.state.attached = false;
  assert.strictEqual(world.bridge.sweep(), false);
  const panel = world.makePanel();
  await world.router.sendMessage({ fromKey: "panel:ext-a", message: { hi: 1 } });
  assert.strictEqual(panel.received.length, 0, "a dead app is not addressed any more");
  world.bridge.dispose();
});

// ── the envelope protocol, host side ──────────────────────────────────────────
test("two extensions' replies are correlated by the id each one used", async () => {
  const world = makeWorld({
    allowlist: ALL_RN_TARGETS,
    found: [fixture("ext-a"), fixture("ext-b", [{ matches: ["https://other.test/*"], js: ["content.js"] }])],
  });
  await world.bridge.attach();
  const panel = world.makePanel();
  panel.setResponder(({ message, requestId }) => {
    // Answer out of order, the way two real panels would.
    world.router.resolveDelivery({
      fromKey: "panel:ext-a",
      requestId,
      response: { saw: message.n, from: "panel" },
    });
  });
  world.router.registerFrame({
    key: "panel:ext-b",
    extensionId: "ext-b",
    url: "rozenite://ext-b/panel.html",
    send: (delivery) => {
      if (delivery.kind === "message") {
        world.router.resolveDelivery({
          fromKey: "panel:ext-b",
          requestId: delivery.payload.requestId,
          response: { only: "ext-b" },
        });
      }
    },
  });

  await world.bridge.onBindingCalled(
    binding({ t: "send", x: "ext-b", s: "ext-b#1", m: { n: 20 } })
  );
  await world.bridge.onBindingCalled(
    binding({ t: "send", x: "ext-a", s: "ext-a#1", m: { n: 1 } })
  );
  await settleApp();
  const answers = dispatched(world).filter((envelope) => envelope.t === "response");
  assert.deepStrictEqual(
    answers.map((a) => [a.x, a.s, a.m]),
    [
      ["ext-b", "ext-b#1", { only: "ext-b" }],
      ["ext-a", "ext-a#1", { saw: 1, from: "panel" }],
    ],
    "each answer went back on the id that asked, to the extension that asked"
  );
});

test("an envelope naming an extension that was never injected is refused", async () => {
  const world = makeWorld({ allowlist: "ext-a" });
  await world.bridge.attach();
  const before = world.backend.evaluates().length;
  await world.bridge.onBindingCalled(binding({ t: "send", x: "evil", s: "evil#1", m: {} }));
  await world.bridge.onBindingCalled(binding({ t: "send", x: "ext-b", s: "ext-b#1", m: {} }));
  assert.strictEqual(world.backend.evaluates().length, before, "no delivery was attempted");
  assert.match(world.logs.join("\n"), /claiming unknown extension/);
  world.bridge.dispose();
});

test("a malformed or hostile binding payload cannot break the host", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  const before = world.backend.evaluates().length;
  for (const payload of [
    "",
    "not json",
    "null",
    "[]",
    '{"t": 42}',
    '{"t": "send"}',
    '{"t": "send", "x": {"__proto__": {}}, "s": 1, "m": {}}',
    '{"t": "port-post", "x": "ext-a", "s": "no-such-port", "m": {}}',
    '{"t": "respond", "x": "ext-a", "s": 999999, "m": "injected-leg-completion"}',
    '{"t": "__proto__", "x": "ext-a", "s": 1}',
    `{"t": "send", "x": "ext-a", "s": "ext-a#1", "m": {"big": "${"y".repeat(200000)}"}}`,
  ]) {
    await assert.doesNotReject(() => world.bridge.onBindingCalled({ name: BINDING_NAME, payload }));
  }
  const text = world.logs.join("\n");
  assert.match(text, /unparsable binding payload/);
  assert.match(text, /no envelope type/);
  assert.match(text, /ignored envelope type "__proto__"/);
  assert.match(text, /port the router never opened/);
  assert.strictEqual(
    ({}) && Object.prototype.polluted === undefined,
    true,
    "nothing reached Object.prototype"
  );
  // The oversized send DID reach the router: it is a legitimate message, and the mesh
  // settles a leg with no receiver rather than hanging.
  await settleApp();
  const answers = dispatched(world).filter((e) => e.t === "response");
  assert.strictEqual(answers.length, 1);
  assert.strictEqual(answers[0].s, "ext-a#1");
  assert.ok(world.backend.evaluates().length >= before);
  world.bridge.dispose();
});

test("a respond envelope settles a router leg exactly like a frame's RUNTIME_SEND_RESPONSE", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  const panel = world.makePanel();
  const toApp = world.router.sendTo({
    fromKey: "panel:ext-a",
    targetKey: world.bridge.appFrameKey("ext-a"),
    message: { ask: true },
  });
  assert.strictEqual(toApp.ok, true);
  await settleApp();
  const delivery = dispatched(world).find((e) => e.k === "message");
  assert.strictEqual(delivery.s, toApp.requestId, "the router's request id is what the app sees");
  assert.strictEqual(delivery.p.sender.id, "ext-a", "sender.id is the CALLER's real extension id");
  assert.strictEqual(delivery.p.sender.url, "rozenite://ext-a/panel.html", "and its real url");
  // The app context IS the inspected tab, so the message appears to come from it — the
  // same synthetic tab chrome.tabs.query reports (docs/features/TABS.md).
  assert.strictEqual(delivery.p.sender.tab.url, "my-app://rn");
  assert.strictEqual(delivery.p.sender.tab.title, "RN");
  assert.strictEqual(delivery.p.sender.tab.id, tabIdFor("ext-a"));

  await world.bridge.onBindingCalled(
    binding({ t: "respond", x: "ext-a", s: toApp.requestId, m: { answered: "from the app" } })
  );
  assert.deepStrictEqual(await toApp.promise, { answered: "from the app" });
  world.bridge.dispose();
});

// The reason `nr` exists: issue #12 refused to wire tabs.sendMessage rather than let an
// extension read "nothing answered" as "the page answered nothing". Now that the call is
// wired, that hazard has to be closed on the host side too.
test("an app with no listener FAILS a targeted send instead of answering undefined", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  const panel = world.makePanel();
  const toApp = world.router.sendTo({
    fromKey: panel.key,
    targetKey: world.bridge.appFrameKey("ext-a"),
    message: { ask: true },
  });
  await settleApp();

  await world.bridge.onBindingCalled(
    binding({
      t: "respond",
      x: "ext-a",
      s: toApp.requestId,
      nr: true,
      e: "Could not establish connection. Receiving end does not exist.",
    })
  );
  await assert.rejects(
    () => toApp.promise,
    /Receiving end does not exist/,
    "Chrome's connection failure, not a resolved undefined"
  );
  assert.strictEqual(
    panel.received.length,
    0,
    "and the silent app's answer did not become a delivery to the sender"
  );
  world.bridge.dispose();
});

test("a silent leg settles itself without becoming the fan-out's answer", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  const sender = world.makePanel("ext-a", "sender");
  // A second real frame that answers LATE, so the app's silent verdict is the only thing
  // in flight when the mesh decides what the sender will resolve with.
  const slow = world.makePanel("ext-a", "worker");
  slow.setResponder((message) => {
    setTimeout(
      () => world.router.resolveDelivery({ fromKey: slow.key, requestId: message.requestId, response: "late" }),
      10
    );
    return "late";
  });

  const fromPanel = world.router.sendMessage({ fromKey: sender.key, message: { ask: true } });
  await settleApp();
  const delivery = dispatched(world).find((e) => e.k === "message");
  assert.ok(delivery, "the app context was asked like any other peer");

  // The app reports "nothing is listening in here" FIRST.
  await world.bridge.onBindingCalled(
    binding({ t: "respond", x: "ext-a", s: delivery.s, nr: true, e: "Receiving end does not exist." })
  );
  // ...and the mesh still waits for the frame that is actually thinking, then answers
  // with ITS value. A silent leg that resolved the sender would report success from an
  // empty page; one that became the response would replace a real answer with a shrug.
  assert.strictEqual(await fromPanel, "late");
  world.bridge.dispose();
});

test("a targeted send stays targeted, and only the app can answer it", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  const sender = world.makePanel();
  const sibling = world.makePanel("ext-a", "worker");
  const toApp = world.router.sendTo({
    fromKey: sender.key,
    targetKey: world.bridge.appFrameKey("ext-a"),
    message: { one: true },
  });
  assert.strictEqual(toApp.ok, true);
  await settleApp();
  assert.strictEqual(sibling.received.length, 0, "a targeted send does not fan out");
  assert.strictEqual(sender.received.length, 0, "and it does not loop back to the sender");

  // A sibling frame answering a leg it was not asked about settles nothing: the mesh
  // only ever hears from the frame it addressed (issue #12's self-answering hazard).
  sibling.answer({ requestId: toApp.requestId, response: "cross-talk" });
  sender.answer({ requestId: toApp.requestId, response: "cross-talk" });
  const settled = await Promise.race([
    toApp.promise.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 20)),
  ]);
  assert.strictEqual(settled, "waiting", "so the leg is still open, exactly as Chrome's would be");

  await world.bridge.onBindingCalled(
    binding({ t: "respond", x: "ext-a", s: toApp.requestId, m: "the app, and only the app" })
  );
  assert.strictEqual(await toApp.promise, "the app, and only the app");
  world.bridge.dispose();
});

test("tabs.sendMessage's receiver: refused while nothing is injected, routed once there is", async () => {
  const world = makeWorld({ allowlist: null });
  await world.bridge.attach();
  let target = world.bridge.tabTarget({ extensionId: "ext-a" });
  assert.strictEqual(target.ok, false);
  assert.match(target.error, /no content script of "ext-a" is running/);
  assert.match(target.error, /not allowlisted|not injected|not scanned/);

  world.backend.state.attached = true;
  const allowlisted = createContentBridgeLike(world, "ext-a");
  await allowlisted.refresh();
  target = allowlisted.tabTarget({ extensionId: "ext-a" });
  assert.strictEqual(target.ok, true);
  assert.strictEqual(target.frameKey, "rozenite-app:ext-a");
  allowlisted.dispose();
});

/** A second bridge over the same backend/router, with the gate open for one id. */
function createContentBridgeLike(world, allowlist) {
  const reader = readerFor({ "content.js": "globalThis.hooked = true;" });
  return createContentBridge({
    sendCommand: world.backend.sendCommand,
    onEvent: world.backend.onEvent,
    isAttached: world.backend.isAttached,
    scan: scanOf(fixture("ext-a")),
    readManifest: () => ({ name: "Fixture" }),
    resolvePaths: reader.resolvePaths,
    readSources: reader.readSources,
    allowlist,
    router: world.router,
    targetInfo: () => ({ attached: true, url: "my-app://rn", title: "RN" }),
    log: { warn: () => {}, error: () => {}, log: () => {} },
    requestTimeoutMs: 200,
    sweepIntervalMs: 0,
  });
}

test("an un-attached session refuses a tab send rather than resolving undefined", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  world.backend.state.attached = false;
  const target = world.bridge.tabTarget({ extensionId: "ext-a" });
  assert.strictEqual(target.ok, false);
  assert.match(target.error, /not attached/);
  world.bridge.dispose();
});

test("a Port the app opens reaches a panel of the same extension, and only that extension", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  const panel = world.makePanel();
  const otherPanel = {
    key: "panel:other",
    received: [],
  };
  world.router.registerFrame({
    key: otherPanel.key,
    extensionId: "ext-b",
    url: "rozenite://ext-b/panel.html",
    send: (delivery) => otherPanel.received.push(delivery),
  });

  await world.bridge.onBindingCalled(
    binding({ t: "port-connect", x: "ext-a", s: "ext-a#1", n: "relay" })
  );
  assert.strictEqual(panel.received.length, 1, "the panel of the same extension got it");
  assert.deepStrictEqual(panel.received[0].payload.name, "relay");
  assert.deepStrictEqual(otherPanel.received, [], "another extension never sees it");

  await settleApp();
  const opened = dispatched(world).find((e) => e.t === "port-open");
  assert.strictEqual(opened.p, panel.received[0].payload.portId);

  const panelKey = "panel:ext-a";
  const portId = panel.received[0].payload.portId;
  world.router.portPost({ fromKey: panelKey, portId, message: { from: "panel" } });
  await settleApp();
  const posted = dispatched(world).find((e) => e.k === "port-message");
  assert.deepStrictEqual([posted.s, posted.p.message], ["ext-a#1", { from: "panel" }]);
  assert.notStrictEqual(posted.s, portId, "the host translated the router's id back to the app's own");

  await world.bridge.onBindingCalled(
    binding({ t: "port-post", x: "ext-a", s: "ext-a#1", m: { from: "app" } })
  );
  assert.deepStrictEqual(
    panel.received.filter((d) => d.kind === "port-message").map((d) => d.payload.message),
    [{ from: "app" }],
    "the app's post translated its own port id back to the router's"
  );

  world.router.portDisconnect({ fromKey: panelKey, portId });
  await settleApp();
  const dropped = dispatched(world).find((e) => e.t === "port-drop");
  assert.strictEqual(dropped === undefined, true, "a peer's disconnect is a delivery, not a drop");
  assert.ok(
    dispatched(world).some((e) => e.k === "port-disconnect"),
    "and the app is told through the delivery channel"
  );
  world.bridge.dispose();
});

test("a Port the app opens with no peer is refused with Chrome's own message", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  world.router.registerFrame({
    key: "panel:ext-z",
    extensionId: "ext-z",
    url: "rozenite://ext-z/panel.html",
    send: () => {},
  });
  await world.bridge.attach();
  await world.bridge.onBindingCalled(
    binding({ t: "port-connect", x: "ext-a", s: "ext-a#1", n: "lonely" })
  );
  await settleApp();
  const dropped = dispatched(world).find((e) => e.t === "port-drop");
  assert.strictEqual(dropped.s, "ext-a#1");
  assert.match(String(dropped.p), /Could not establish connection/);
  world.bridge.dispose();
});

test("an app report is logged and never treated as messaging", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  await world.bridge.onBindingCalled(
    binding({ t: "report", x: "ext-a", k: "listener-threw", d: "boom in the app" })
  );
  assert.match(world.logs.join("\n"), /the app reported "listener-threw": boom in the app/);
  assert.deepStrictEqual(dispatched(world), [], "a report does not open a leg");
  world.bridge.dispose();
});

test("an extension's own report about a sibling extension is refused", async () => {
  const world = makeWorld({ allowlist: ALL_RN_TARGETS });
  await world.bridge.attach();
  await world.bridge.onBindingCalled(
    binding({ t: "respond", x: "not-scanned", s: 1, m: "cross-extension" })
  );
  assert.match(world.logs.join("\n"), /claiming unknown extension "not-scanned"/);
  world.bridge.dispose();
});
