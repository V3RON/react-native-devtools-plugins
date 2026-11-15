// chrome.debugger's main half (src/electron/extensions/internal/cdp/debugger-service.js):
// real CDP sessions (cdp-session.js) against a fake inspector proxy that keeps each
// connection its own session (tests/fake-inspector-proxy.js). Connection 0 plays the
// host's own session wherever a test needs one; each attached extension dials its own.
const test = require("node:test");
const assert = require("node:assert");
const { startProxy } = require("./fake-inspector-proxy");
const { createCdpSession } = require("../src/electron/extensions/internal/cdp/cdp-session");
const { createDebuggerService } = require("../src/electron/extensions/internal/cdp/debugger-service");

const TAB = { "ext-a": 101, "ext-b": 202 };

const waitFor = async (predicate, { timeoutMs = 3000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** A service over `proxy`, recording what it delivers to which extension. */
const serviceFor = (t, proxy, { target = { attached: true, id: "dev-1", url: "", title: "fake-app" } } = {}) => {
  const delivered = [];
  const sessions = [];
  let frontendUrl = proxy ? proxy.frontendUrl : null;
  const service = createDebuggerService({
    createSession: () => {
      const session = createCdpSession({ reconnect: false, requestTimeoutMs: 0, prime: [] });
      sessions.push(session);
      return session;
    },
    getFrontendUrl: () => frontendUrl,
    describeTarget: async () => target,
    tabIdFor: (extensionId) => TAB[extensionId],
    deliver: (extensionId, delivery) => delivered.push({ extensionId, ...delivery.payload }),
  });
  t.after(() => service.detachAll());
  return {
    service,
    delivered,
    sessions,
    setFrontendUrl: (url) => {
      frontendUrl = url;
    },
  };
};

test("attach opens the extension's own session; one per extension, refused like Chrome", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { service } = serviceFor(t, proxy);

  assert.deepStrictEqual(await service.attach("ext-a", { tabId: 101 }, "1.3"), { ok: true });
  assert.equal(proxy.connections(), 1);
  assert.deepStrictEqual(proxy.origins, [`http://127.0.0.1:${proxy.port}`], "the dev server's Origin");
  assert.deepStrictEqual(proxy.commands(), [], "attaching enables nothing, as in Chrome");

  assert.deepStrictEqual(await service.attach("ext-a", { tabId: 101 }, "1.3"), {
    ok: false,
    error: "Another debugger is already attached to the tab with id: 101.",
  });
  // A different extension is a different client with a session of its own.
  assert.deepStrictEqual(await service.attach("ext-b", { tabId: 202 }, "1.3"), { ok: true });
  assert.equal(proxy.openConnections(), 2);
});

test("a debuggee names the inspected app or nothing", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { service } = serviceFor(t, proxy);
  const refusals = {
    "another extension's tab": [{ tabId: 202 }, "No tab with given id 202."],
    "an extension": [{ extensionId: "x" }, /Cannot attach to the extension with id: x/],
    "an unknown target": [{ targetId: "nope" }, "No target with given id nope."],
    nothing: [{}, "Either tab id or extension id must be specified."],
    "not an object": [undefined, "Either tab id or extension id must be specified."],
  };
  for (const [label, [target, error]] of Object.entries(refusals)) {
    const reply = await service.attach("ext-a", target, "1.3");
    assert.equal(reply.ok, false, label);
    if (error instanceof RegExp) assert.match(reply.error, error, label);
    else assert.equal(reply.error, error, label);
  }
  assert.deepStrictEqual(await service.attach("ext-a", { tabId: 101 }, "2.0"), {
    ok: false,
    error: "Requested protocol version is not supported: 2.0.",
  });
  assert.equal(proxy.connections(), 0, "nothing was dialled for a refusal");

  // The target id getTargets reports is as good as the tab id.
  const [info] = (await service.getTargets("ext-a")).result;
  assert.deepStrictEqual(info, {
    type: "page",
    id: "dev-1",
    tabId: 101,
    title: "fake-app",
    url: "",
    attached: true,
  });
  assert.deepStrictEqual(await service.attach("ext-a", { targetId: info.id }, "1.3"), { ok: true });
  assert.equal(
    (await service.sendCommand("ext-a", { tabId: 101 }, "Runtime.evaluate", {})).ok,
    true,
    "one attachment, whichever way the app was named"
  );
});

test("commands are forwarded unchanged and the app's answer comes back unchanged", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { service } = serviceFor(t, proxy);
  await service.attach("ext-a", { tabId: 101 }, "1.3");

  const params = { expression: "globalThis.x", returnByValue: true, awaitPromise: true };
  assert.deepStrictEqual(await service.sendCommand("ext-a", { tabId: 101 }, "Runtime.evaluate", params), {
    ok: true,
    result: { echo: "Runtime.evaluate" },
  });
  assert.deepStrictEqual(proxy.commands("Runtime.evaluate")[0].params, params);

  // No list of supported methods: an unknown one reaches the app, and the app refuses it.
  proxy.refuse("DOM.getDocument", { code: -32601, message: "Unsupported method 'DOM.getDocument'" });
  assert.deepStrictEqual(await service.sendCommand("ext-a", { tabId: 101 }, "DOM.getDocument"), {
    ok: false,
    error: '{"code":-32601,"message":"Unsupported method \'DOM.getDocument\'"}',
  });
  assert.equal(proxy.commands("DOM.getDocument").length, 1, "it was sent, not filtered");
  assert.equal(proxy.commands("DOM.getDocument")[0].params, undefined, "absent params stay absent");

  // A child session id travels with the command.
  await service.sendCommand("ext-a", { tabId: 101, sessionId: "child" }, "Runtime.enable");
  assert.equal(proxy.commands("Runtime.enable")[0].sessionId, "child");

  assert.deepStrictEqual(await service.sendCommand("ext-b", { tabId: 202 }, "Runtime.enable"), {
    ok: false,
    error: "Debugger is not attached to the tab with id: 202.",
  });
  assert.equal((await service.sendCommand("ext-a", { tabId: 101 }, "")).ok, false);
  assert.equal((await service.sendCommand("ext-a", { tabId: 101 }, "X.y", [1])).ok, false);
});

test("a command waits as long as the app takes, and fails only when the attachment ends", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { service, delivered } = serviceFor(t, proxy);
  await service.attach("ext-a", { tabId: 101 }, "1.3");
  proxy.silence("Profiler.stop");
  const reply = service.sendCommand("ext-a", { tabId: 101 }, "Profiler.stop");
  await new Promise((resolve) => setTimeout(resolve, 300));
  proxy.drop(0);
  assert.deepStrictEqual(await reply, { ok: false, error: "Detached while handling command." });
  await waitFor(() => delivered.length === 1);
});

test("events from the extension's own session reach that extension, and only those", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { service, delivered } = serviceFor(t, proxy);
  // Connection 0 stands in for the host's (or the frontend's) session.
  const host = createCdpSession({ prime: [] });
  t.after(() => host.close());
  await host.open(proxy.frontendUrl);
  await service.attach("ext-a", { tabId: 101 }, "1.3"); // connection 1
  await service.attach("ext-b", { tabId: 202 }, "1.3"); // connection 2

  proxy.push({ method: "Network.requestWillBeSent", params: { requestId: "r1" } }, 1);
  proxy.push({ method: "Network.requestWillBeSent", params: { requestId: "host-only" } }, 0);
  proxy.push({ method: "Debugger.paused", params: { reason: "b" } }, 2);
  proxy.push({ method: "Runtime.consoleAPICalled", params: {}, sessionId: "child" }, 1);
  await waitFor(() => delivered.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Three sockets, so arrival order across them is not the push order: compare as sets.
  const sorted = (list) => list.map((entry) => JSON.stringify(entry)).sort();
  assert.deepStrictEqual(sorted(delivered), sorted([
    {
      extensionId: "ext-a",
      type: "event",
      source: { tabId: 101 },
      method: "Network.requestWillBeSent",
      params: { requestId: "r1" },
    },
    { extensionId: "ext-b", type: "event", source: { tabId: 202 }, method: "Debugger.paused", params: { reason: "b" } },
    {
      extensionId: "ext-a",
      type: "event",
      source: { tabId: 101, sessionId: "child" },
      method: "Runtime.consoleAPICalled",
      params: {},
    },
  ]));
});

test("the app closing the session is onDetach(target_closed), once, with no re-dial", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { service, delivered } = serviceFor(t, proxy);
  await service.attach("ext-a", { targetId: "dev-1" }, "1.3");
  proxy.drop(0);
  await waitFor(() => delivered.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepStrictEqual(delivered, [
    { extensionId: "ext-a", type: "detach", source: { targetId: "dev-1" }, reason: "target_closed" },
  ]);
  assert.equal(proxy.connections(), 1, "not dialled again");
  assert.equal(service.isAttached("ext-a"), false);
  assert.equal((await service.sendCommand("ext-a", { targetId: "dev-1" }, "Runtime.enable")).ok, false);
  // And the extension may attach again, to a fresh session.
  assert.deepStrictEqual(await service.attach("ext-a", { tabId: 101 }, "1.3"), { ok: true });
  assert.equal(proxy.connections(), 2);
});

test("detach closes quietly; detachAll tells every attached extension", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { service, delivered } = serviceFor(t, proxy);
  await service.attach("ext-a", { tabId: 101 }, "1.3");
  assert.deepStrictEqual(await service.detach("ext-a", { tabId: 101 }), { ok: true });
  await waitFor(() => proxy.openConnections() === 0);
  assert.deepStrictEqual(delivered, [], "Chrome fires no onDetach for the extension's own detach");
  assert.deepStrictEqual(await service.detach("ext-a", { tabId: 101 }), {
    ok: false,
    error: "Debugger is not attached to the tab with id: 101.",
  });

  await service.attach("ext-a", { tabId: 101 }, "1.3");
  await service.attach("ext-b", { tabId: 202 }, "1.3");
  service.detachAll("target_closed");
  assert.deepStrictEqual(
    delivered.map((entry) => [entry.extensionId, entry.type, entry.reason]),
    [
      ["ext-a", "detach", "target_closed"],
      ["ext-b", "detach", "target_closed"],
    ]
  );
  await waitFor(() => proxy.openConnections() === 0);
});

test("no app, or an app that would lose its frontend: attach fails with the reason", async (t) => {
  const { service: noWindow } = serviceFor(t, null);
  assert.deepStrictEqual(await noWindow.attach("ext-a", { tabId: 101 }, "1.3"), {
    ok: false,
    error: "Cannot attach to the tab with id: 101: no app is being inspected.",
  });

  const proxy = await startProxy({ multipleDebuggers: false });
  t.after(() => proxy.close());
  const { service } = serviceFor(t, proxy);
  const reply = await service.attach("ext-a", { tabId: 101 }, "1.3");
  assert.equal(reply.ok, false);
  assert.match(reply.error, /^Cannot attach to the tab with id: 101: .*multiple debuggers/);
  assert.equal(proxy.connections(), 0);
  assert.equal(service.isAttached("ext-a"), false, "a failed attach leaves nothing behind");

  const { service: detached } = serviceFor(t, proxy, { target: { attached: false } });
  assert.deepStrictEqual(await detached.getTargets("ext-a"), { ok: true, result: [] });
});

test("a detach while attaching wins: the attach reports it and nothing stays open", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { service } = serviceFor(t, proxy);
  const attaching = service.attach("ext-a", { tabId: 101 }, "1.3");
  assert.deepStrictEqual(await service.attach("ext-a", { tabId: 101 }, "1.3"), {
    ok: false,
    error: "Another debugger is already attached to the tab with id: 101.",
  });
  service.detachAll();
  const reply = await attaching;
  assert.equal(reply.ok, false);
  assert.match(reply.error, /detached while attaching/);
  await waitFor(() => proxy.openConnections() === 0);
});
