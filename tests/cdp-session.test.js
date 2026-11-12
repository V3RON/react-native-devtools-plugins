// The extension host's own CDP session (src/electron/extensions/internal/cdp/cdp-session.js,
// docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md §5.6), against a fake inspector proxy that
// keeps the real proxy's two rules: an allowed Origin, and /json/list capabilities.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const WebSocket = require("ws");
const {
  createCdpSession,
  cdpTargetOf,
  capabilityOf,
  isEntryFor,
} = require("../src/electron/extensions/internal/cdp/cdp-session");

const waitFor = async (predicate, { timeoutMs = 3000, intervalMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/** A dev server: /json/list plus /inspector/debug, with InspectorProxy's Origin rule. */
const startProxy = async ({ multipleDebuggers = true } = {}) => {
  const sockets = new Set();
  const commands = [];
  const origins = [];
  const refusals = new Map();
  let connections = 0;
  let silent = false;
  const state = { multipleDebuggers };
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith("/json/list")) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          id: "dev-1",
          type: "node",
          title: "fake-app",
          webSocketDebuggerUrl: `ws://localhost:${server.address().port}/inspector/debug?device=dev&page=1`,
          reactNative: { capabilities: { supportsMultipleDebuggers: state.multipleDebuggers } },
        },
      ])
    );
  });
  const wss = new WebSocket.Server({
    server,
    path: "/inspector/debug",
    verifyClient: ({ origin }) => {
      origins.push(origin || null);
      try {
        return ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
      } catch {
        return false;
      }
    },
  });
  wss.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      commands.push(message);
      if (silent) return;
      const refusal = refusals.get(message.method);
      socket.send(
        JSON.stringify(
          refusal
            ? { id: message.id, error: { code: -32601, message: refusal } }
            : { id: message.id, result: { echo: message.method } }
        )
      );
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const frontendUrl = new URL(`http://127.0.0.1:${port}/rozenite/rn_fusebox.html`);
  frontendUrl.searchParams.set("ws", `127.0.0.1:${port}/inspector/debug?device=dev&page=1`);
  return {
    port,
    frontendUrl: frontendUrl.href,
    state,
    commands: (method) => commands.filter((entry) => !method || entry.method === method),
    origins,
    connections: () => connections,
    refuse: (method, message) => refusals.set(method, message),
    silence: () => {
      silent = true;
    },
    push: (message) => {
      for (const socket of sockets) socket.send(JSON.stringify(message));
    },
    dropAll: () => {
      for (const socket of sockets) socket.terminate();
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close(() => server.close(resolve));
      }),
  };
};

const sessionFor = (t, options = {}) => {
  const logs = [];
  const session = createCdpSession({
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    requestTimeoutMs: 500,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...options,
  });
  t.after(() => session.close());
  return { session, logs };
};

// ── pure parts ──────────────────────────────────────────────────────────────
test("the target comes from the frontend URL's ws= (or wss=), the dev server from its origin", () => {
  const url = new URL("http://127.0.0.1:8081/debugger-frontend/rn_fusebox.html");
  url.searchParams.set("ws", "127.0.0.1:8081/inspector/debug?device=a&page=1");
  assert.deepStrictEqual(cdpTargetOf(url.href), {
    ok: true,
    wsUrl: "ws://127.0.0.1:8081/inspector/debug?device=a&page=1",
    devServer: "http://127.0.0.1:8081",
  });
  const secure = new URL("https://dev.example:8443/rn_fusebox.html");
  secure.searchParams.set("wss", "dev.example:8443/inspector/debug?device=a&page=1");
  assert.equal(cdpTargetOf(secure.href).wsUrl, "wss://dev.example:8443/inspector/debug?device=a&page=1");

  assert.match(cdpTargetOf("http://127.0.0.1:8081/rn_fusebox.html").reason, /no ws= or wss=/);
  assert.match(cdpTargetOf("not a url").reason, /not a URL/);
  assert.match(cdpTargetOf("about:blank").reason, /no ws=/);
  assert.match(cdpTargetOf("data:text/html,x?ws=a:1/x").reason, /no origin/);
});

test("the capability check reads supportsMultipleDebuggers off the entry for that target", () => {
  const wsUrl = "ws://127.0.0.1:8081/inspector/debug?device=a&page=1";
  const entry = (capabilities, host = "localhost") => ({
    webSocketDebuggerUrl: `ws://${host}:8081/inspector/debug?device=a&page=1`,
    reactNative: { capabilities },
  });
  assert.ok(isEntryFor(entry({}), wsUrl), "localhost and 127.0.0.1 name the same target");
  assert.equal(isEntryFor({ webSocketDebuggerUrl: wsUrl.replace("page=1", "page=2") }, wsUrl), false);

  assert.equal(capabilityOf([entry({ supportsMultipleDebuggers: true })], wsUrl).ok, true);
  assert.match(capabilityOf([entry({ supportsMultipleDebuggers: false })], wsUrl).reason, /multiple debuggers/);
  assert.match(capabilityOf([entry({})], wsUrl).reason, /multiple debuggers/, "absent is not supported");
  assert.match(capabilityOf([{ webSocketDebuggerUrl: "ws://x/other" }], wsUrl).reason, /does not list/);
  assert.match(capabilityOf({ not: "a list" }, wsUrl).reason, /did not answer with a list/);
});

// ── against the fake proxy ──────────────────────────────────────────────────
test("open checks the capability, dials with the dev server's Origin, primes, then attaches", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { session } = sessionFor(t);
  const attaches = [];
  session.onAttach((target) => attaches.push(target && target.title));

  assert.equal(await session.open(proxy.frontendUrl), true);
  assert.deepStrictEqual(proxy.origins, [`http://127.0.0.1:${proxy.port}`]);
  assert.deepStrictEqual(
    proxy.commands().map((entry) => entry.method),
    ["Runtime.enable"],
    "the prime is the session's first command"
  );
  assert.deepStrictEqual(attaches, ["fake-app"]);
  assert.equal(session.status().attached, true);
  assert.equal(session.status().target.id, "dev-1");
  assert.equal(session.status().reason, null);
});

test("commands round-trip on the session's own ids; errors and timeouts reject", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { session } = sessionFor(t);
  await session.open(proxy.frontendUrl);

  assert.deepStrictEqual(await session.sendCommand("Runtime.evaluate", { expression: "1" }), {
    echo: "Runtime.evaluate",
  });
  const sent = proxy.commands("Runtime.evaluate")[0];
  assert.ok(sent.id > 0 && sent.id < 1000, "ids count from 1 on a session nobody shares");
  assert.deepStrictEqual(sent.params, { expression: "1" });

  proxy.refuse("Network.enable", "Method not found");
  await assert.rejects(session.sendCommand("Network.enable"), /Network\.enable: Method not found/);

  proxy.silence();
  await assert.rejects(
    session.sendCommand("Page.reload", undefined, { timeoutMs: 50 }),
    (error) => error.code === "TIMEOUT"
  );
});

test("events reach exact and '*' subscribers, and unsubscribing stops them", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { session } = sessionFor(t);
  const exact = [];
  const any = [];
  const off = session.onEvent("Network.dataReceived", (params) => exact.push(params.n));
  session.onEvent("*", (params, method) => any.push(method));
  await session.open(proxy.frontendUrl);

  proxy.push({ method: "Network.dataReceived", params: { n: 1 } });
  proxy.push({ method: "Runtime.executionContextsCleared" });
  await waitFor(() => any.length === 2);
  off();
  proxy.push({ method: "Network.dataReceived", params: { n: 2 } });
  await waitFor(() => any.length === 3);
  assert.deepStrictEqual(exact, [1]);
  assert.deepStrictEqual(any, [
    "Network.dataReceived",
    "Runtime.executionContextsCleared",
    "Network.dataReceived",
  ]);
});

test("a target without supportsMultipleDebuggers is never dialled: commands fail with the reason", async (t) => {
  const proxy = await startProxy({ multipleDebuggers: false });
  t.after(() => proxy.close());
  const { session, logs } = sessionFor(t);

  assert.equal(await session.open(proxy.frontendUrl), false);
  await new Promise((resolve) => setTimeout(resolve, 80)); // several re-checks
  assert.equal(proxy.connections(), 0, "connecting would have evicted the frontend");
  assert.match(session.status().reason, /multiple debuggers/);
  await assert.rejects(session.sendCommand("Runtime.evaluate"), /no CDP session is attached \(.*multiple debuggers/);
  assert.equal(
    logs.filter((line) => /multiple debuggers/.test(line)).length,
    1,
    "the reason is logged once, not once per re-check"
  );

  // The app comes back with the capability (an upgraded build): the session attaches.
  proxy.state.multipleDebuggers = true;
  await waitFor(() => session.status().attached);
  assert.equal(proxy.connections(), 1);
});

test("a frontend URL without ws= opens nothing and says why", async (t) => {
  const { session } = sessionFor(t);
  assert.equal(await session.open("http://127.0.0.1:1/rn_fusebox.html"), false);
  assert.match(session.status().reason, /no ws=/);
  await assert.rejects(session.sendCommand("Runtime.evaluate"), /no ws=/);
});

test("a lost socket rejects what was in flight, re-dials the same target and re-announces attach", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { session } = sessionFor(t);
  let attaches = 0;
  session.onAttach(() => {
    attaches += 1;
  });
  await session.open(proxy.frontendUrl);
  proxy.silence();
  const inFlight = session.sendCommand("Runtime.evaluate", { expression: "slow" });
  await waitFor(() => proxy.commands("Runtime.evaluate").length === 1);
  proxy.dropAll();
  await assert.rejects(inFlight, (error) => error.code === "DETACHED");
  assert.equal(session.status().attached, false);
  assert.match(session.status().reason, /closed/);

  // `silence` also stops the prime's answer, which the session tolerates after its timeout.
  await waitFor(() => attaches === 2, { timeoutMs: 3000 });
  assert.equal(proxy.connections(), 2);
  assert.equal(proxy.commands("Runtime.enable").length, 2, "the new session is primed too");
});

test("close stops re-dialling and rejects pending commands", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const { session } = sessionFor(t);
  await session.open(proxy.frontendUrl);
  proxy.silence();
  const inFlight = session.sendCommand("Runtime.evaluate");
  await waitFor(() => proxy.commands("Runtime.evaluate").length === 1);
  await session.close();
  await assert.rejects(inFlight, (error) => error.code === "DETACHED");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(proxy.connections(), 1, "no re-dial after close");
  assert.equal(session.status().attached, false);
});
