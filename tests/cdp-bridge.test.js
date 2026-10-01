// CDP bridge tests (src/main/cdp-bridge.js) against a fake Metro inspector proxy
// and a fake frontend — both real WebSockets in this process, using the `ws`
// dependency the repo already has. Covers what the layers above depend on: host
// command id correlation, non-matching ids relayed untouched, notification
// fan-out, the reconnect buffer, re-attach after an upstream drop, and the
// request deadline.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const WebSocket = require("ws");

const { createCdpBridge, HOST_ID_BASE } = require("../src/main/cdp-bridge");

// ── fake Metro: /json/list discovery + one /inspector/debug upstream ─────────
function createFakeMetro({ targetAvailable = true } = {}) {
  const sockets = new Set();
  /** every CDP command the fake app ever received, across sessions */
  const commands = [];
  let accepted = 0;
  let hasTarget = targetAvailable;
  /** how the fake app answers a CDP command */
  let onCommand = (message, socket) =>
    socket.send(JSON.stringify({ id: message.id, result: { echo: message.method } }));

  const server = http.createServer((req, res) => {
    if (!req.url.startsWith("/json/list")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        hasTarget
          ? [
              {
                id: "1",
                type: "node",
                title: "devtools-poc (iPhone 17 Pro)",
                description: "devtools-poc [C++ connection]",
                appId: "devtools-poc",
                deviceName: "iPhone 17 Pro",
                webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/inspector/debug?device=1&page=1`,
              },
              // must be ignored: not a debuggable runtime entry
              { id: "2", type: "page", title: "not a runtime", webSocketDebuggerUrl: "" },
            ]
          : []
      )
    );
  });

  const wss = new WebSocket.Server({ server, path: "/inspector/debug" });
  wss.on("connection", (socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      commands.push(message);
      onCommand(message, socket);
    });
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    listen: () =>
      new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve(server.address().port))
      ),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        sockets.clear();
        wss.close(() => server.close(resolve));
      }),
    lastSocket: () => [...sockets].pop(),
    /** debugger connections the fake app accepted (multi-session probe) */
    accepted: () => accepted,
    /** every command the app received, in arrival order */
    commands: () => [...commands],
    setTargetAvailable: (value) => {
      hasTarget = value;
    },
    setOnCommand: (fn) => {
      onCommand = fn;
    },
    push: (message) => {
      for (const socket of sockets) socket.send(JSON.stringify(message));
    },
    pushRaw: (text) => {
      for (const socket of sockets) socket.send(text);
    },
  };
}

/** A CDP client (stands in for the DevTools frontend) dialing the bridge. */
function connectFrontend(listenPort) {
  const socket = new WebSocket(`ws://127.0.0.1:${listenPort}`);
  const received = []; // raw frames nobody was waiting for
  const waiters = [];

  const matches = (raw, predicate) => {
    try {
      return predicate(JSON.parse(raw));
    } catch {
      return false;
    }
  };

  socket.on("message", (raw) => {
    const text = String(raw);
    const index = waiters.findIndex((w) => matches(text, w.predicate));
    if (index >= 0) {
      waiters.splice(index, 1)[0].resolve(text);
    } else {
      received.push(text);
    }
  });

  return {
    socket,
    received,
    open: () =>
      new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
    send: (message) => socket.send(JSON.stringify(message)),
    close: () =>
      new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once("close", resolve);
        socket.close();
      }),
    /** the next (or a buffered) frame whose parsed form matches, as an object */
    next: (predicate = () => true, timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        const settle = (text) => resolve(JSON.parse(text));
        const buffered = received.findIndex((text) => matches(text, predicate));
        if (buffered >= 0) {
          settle(received.splice(buffered, 1)[0]);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a frontend frame")),
          timeoutMs
        );
        waiters.push({
          predicate,
          resolve: (text) => {
            clearTimeout(timer);
            settle(text);
          },
        });
      }),
  };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = new WebSocket.Server({ port: 0, host: "127.0.0.1" });
    probe.once("listening", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });

const waitFor = async (predicate, { timeoutMs = 4000, intervalMs = 10 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/** Metro + bridge under test, torn down after the test. */
async function makeWorld(t, { bridge = {}, metro = {} } = {}) {
  const fakeMetro = createFakeMetro(metro);
  const metroPort = await fakeMetro.listen();
  const listenPort = await freePort();
  const bridgeUnderTest = createCdpBridge({
    metroHost: "127.0.0.1",
    metroPort,
    listenHost: "127.0.0.1",
    listenPort,
    pollIntervalMs: 20,
    requestTimeoutMs: 500,
    ...bridge,
  });
  await bridgeUnderTest.start();
  t.after(async () => {
    await bridgeUnderTest.stop();
    await fakeMetro.close();
  });
  return { metro: fakeMetro, bridge: bridgeUnderTest, listenPort };
}

/** World with a live session and a connected frontend. */
async function makeAttachedWorld(t, bridgeOptions) {
  const world = await makeWorld(t, { bridge: bridgeOptions });
  const frontend = connectFrontend(world.listenPort);
  await frontend.open();
  await waitFor(() => world.bridge.isAttached());
  return { ...world, frontend };
}

// ── the relay ────────────────────────────────────────────────────────────────
test("frontend commands reach the app and replies come back untouched", async (t) => {
  const { metro, bridge, frontend } = await makeAttachedWorld(t);

  frontend.send({ id: 1, method: "Runtime.enable", params: { a: 1 } });
  assert.deepStrictEqual(await frontend.next((m) => m.id === 1), {
    id: 1,
    result: { echo: "Runtime.enable" },
  });

  const command = metro.commands().find((m) => m.method === "Runtime.enable");
  assert.strictEqual(command.id, 1, "frontend ids are not rewritten");
  assert.deepStrictEqual(command.params, { a: 1 }, "params pass through verbatim");
  assert.strictEqual(command.sessionId, undefined, "no session juggling");
  assert.strictEqual(bridge.status().clients, 1);
  await frontend.close();
});

test("non-matching ids are relayed untouched (the bridge only eats its own)", async (t) => {
  const { frontend } = await makeAttachedWorld(t);
  for (const id of [3, 1, 2]) {
    frontend.send({ id, method: "Log.enable" });
  }
  for (const id of [3, 1, 2]) {
    assert.deepStrictEqual(await frontend.next((m) => m.id === id), {
      id,
      result: { echo: "Log.enable" },
    });
  }
  await frontend.close();
});

test("host command ids are the bridge's own and never reach the frontend", async (t) => {
  const { metro, bridge, frontend } = await makeAttachedWorld(t);

  metro.setOnCommand((message, socket) => {
    if (message.id >= HOST_ID_BASE) {
      socket.send(
        JSON.stringify({
          id: message.id,
          result: { result: { type: "number", value: 42 } },
        })
      );
      return;
    }
    socket.send(JSON.stringify({ id: message.id, result: {} }));
  });

  const reply = await bridge.sendCommand("Runtime.evaluate", {
    expression: "1+1",
    returnByValue: true,
  });
  assert.deepStrictEqual(reply, { result: { type: "number", value: 42 } });

  await bridge.sendCommand("Runtime.enable");
  const hostCommands = metro.commands().filter((m) => m.id >= HOST_ID_BASE);
  assert.deepStrictEqual(
    hostCommands.map((m) => m.method),
    ["Runtime.evaluate", "Runtime.enable"],
    "host commands went upstream with host-range ids"
  );
  assert.deepStrictEqual(hostCommands[0].params, {
    expression: "1+1",
    returnByValue: true,
  });

  // A host reply must never surface on the frontend's socket.
  await assert.rejects(() => frontend.next(() => true, 200), /timed out/);
  await frontend.close();
});

test("notifications fan out to host handlers and to the frontend", async (t) => {
  const { metro, bridge, frontend } = await makeAttachedWorld(t);

  const network = [];
  const everyMethod = [];
  const off = bridge.onEvent("Network.requestWillBeSent", (params) =>
    network.push(params)
  );
  bridge.onEvent("*", (_params, method) => everyMethod.push(method));

  metro.push({
    method: "Network.requestWillBeSent",
    params: { requestId: "7", request: { url: "https://example.com/q", method: "POST" } },
  });
  metro.push({ method: "Network.responseReceived", params: { requestId: "7" } });

  assert.deepStrictEqual(await frontend.next((m) => m.method === "Network.requestWillBeSent"), {
    method: "Network.requestWillBeSent",
    params: { requestId: "7", request: { url: "https://example.com/q", method: "POST" } },
  });
  await waitFor(() => network.length === 1);
  assert.strictEqual(network[0].request.url, "https://example.com/q");
  assert.deepStrictEqual(everyMethod, [
    "Network.requestWillBeSent",
    "Network.responseReceived",
  ]);

  off();
  metro.push({ method: "Network.requestWillBeSent", params: { requestId: "8" } });
  await frontend.next((m) => m.params && m.params.requestId === "8");
  assert.strictEqual(network.length, 1, "an unsubscribed handler stays quiet");
  await frontend.close();
});

test("frontend and host commands interleave without cross-talk", async (t) => {
  const { metro, bridge, frontend } = await makeAttachedWorld(t);
  metro.setOnCommand((message, socket) => {
    // Answer out of order: host first, the frontend's own second.
    const answer = () =>
      socket.send(
        JSON.stringify({
          id: message.id,
          result: { for: message.id >= HOST_ID_BASE ? "host" : "frontend" },
        })
      );
    if (message.id >= HOST_ID_BASE) setTimeout(answer, 0);
    else setTimeout(answer, 20);
  });

  frontend.send({ id: 99, method: "Debugger.enable" });
  const hostReply = await bridge.sendCommand("Runtime.evaluate", { expression: "2+2" });
  assert.deepStrictEqual(hostReply, { for: "host" });
  assert.deepStrictEqual(await frontend.next((m) => m.id === 99), {
    id: 99,
    result: { for: "frontend" },
  });
  await frontend.close();
});

// ── error paths ──────────────────────────────────────────────────────────────
test("a backend error reply rejects the host command with the backend's text", async (t) => {
  const { metro, bridge } = await makeAttachedWorld(t);
  metro.setOnCommand((message, socket) =>
    socket.send(
      JSON.stringify({
        id: message.id,
        error: { code: -32601, message: "Method not found." },
      })
    )
  );
  await assert.rejects(
    () => bridge.sendCommand("Network.enable"),
    /Network\.enable: Method not found\./
  );
});

test("a host command with no reply hits the deadline instead of hanging", async (t) => {
  const { metro, bridge } = await makeAttachedWorld(t, { requestTimeoutMs: 150 });
  metro.setOnCommand(() => {}); // swallows everything
  await assert.rejects(
    () => bridge.sendCommand("Runtime.evaluate", { expression: "1" }),
    /Runtime\.evaluate: timed out after 150ms/
  );
});

test("host commands are rejected while no session is attached", async (t) => {
  const { bridge } = await makeWorld(t, { metro: { targetAvailable: false } });
  await assert.rejects(
    () => bridge.sendCommand("Runtime.evaluate", { expression: "1" }),
    /Runtime\.evaluate: no CDP session is attached/
  );
});

test("unparsable upstream frames are relayed instead of dropped", async (t) => {
  const { metro, bridge, frontend } = await makeAttachedWorld(t);
  metro.pushRaw("this is not JSON");
  await waitFor(() => frontend.received.includes("this is not JSON"));
  assert.strictEqual(bridge.status().clients, 1, "the relay survived it");
  await frontend.close();
});

// ── reconnect behaviour ─────────────────────────────────────────────────────
test("frontend traffic is buffered while detached and flushed on attach", async (t) => {
  const { metro, bridge, listenPort } = await makeWorld(t, {
    metro: { targetAvailable: false },
  });
  const frontend = connectFrontend(listenPort);
  await frontend.open();

  frontend.send({ id: 1, method: "Runtime.enable" });
  frontend.send({ id: 2, method: "Debugger.enable" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(metro.accepted(), 0, "nothing escaped while detached");
  assert.strictEqual(frontend.received.length, 0, "no phantom replies");

  metro.setTargetAvailable(true);
  await waitFor(() => bridge.isAttached());
  await waitFor(() => metro.commands().length >= 2);
  assert.deepStrictEqual(
    metro.commands().map((m) => m.method),
    ["Runtime.enable", "Debugger.enable"],
    "buffered sends flush in order"
  );
  assert.deepStrictEqual(await frontend.next((m) => m.id === 1), {
    id: 1,
    result: { echo: "Runtime.enable" },
  });
  assert.deepStrictEqual(await frontend.next((m) => m.id === 2), {
    id: 2,
    result: { echo: "Debugger.enable" },
  });
  await frontend.close();
});

test("re-attaches after the upstream closes and keeps relaying", async (t) => {
  const { metro, bridge, frontend } = await makeAttachedWorld(t);
  const first = metro.lastSocket();
  frontend.send({ id: 10, method: "Runtime.enable" });
  assert.deepStrictEqual(await frontend.next((m) => m.id === 10), {
    id: 10,
    result: { echo: "Runtime.enable" },
  });

  // App reload / Metro drops the debugger session.
  first.terminate();
  await waitFor(() => !bridge.isAttached());
  assert.strictEqual(
    bridge.status().clients,
    1,
    "the frontend socket survives an upstream drop"
  );

  await waitFor(() => bridge.isAttached());
  assert.notStrictEqual(metro.lastSocket(), first, "a new upstream session opened");
  frontend.send({ id: 11, method: "Debugger.enable" });
  assert.deepStrictEqual(await frontend.next((m) => m.id === 11), {
    id: 11,
    result: { echo: "Debugger.enable" },
  });
  await frontend.close();
});

test("a pending host command is rejected when the session dies", async (t) => {
  const { metro, bridge } = await makeAttachedWorld(t);
  metro.setOnCommand(() => {}); // never answers
  const inFlight = bridge.sendCommand("Runtime.evaluate", { expression: "1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  metro.lastSocket().terminate();
  await assert.rejects(() => inFlight, /Runtime\.evaluate: session closed/);
});

test("the app is never shown a second debugger connection", async (t) => {
  const { metro, bridge, listenPort } = await makeWorld(t, {});
  const frontend = connectFrontend(listenPort);
  await frontend.open();
  await waitFor(() => bridge.isAttached());

  await bridge.sendCommand("Runtime.evaluate", { expression: "1" });
  frontend.send({ id: 1, method: "Runtime.enable" });
  await frontend.next((m) => m.id === 1);
  assert.strictEqual(metro.accepted(), 1, "one debugger session on the app");

  // Frontend reload: the frontend socket churns, the app session does not.
  await frontend.close();
  const reloaded = connectFrontend(listenPort);
  await reloaded.open();
  await waitFor(() => bridge.isAttached());
  reloaded.send({ id: 2, method: "Debugger.enable" });
  assert.deepStrictEqual(await reloaded.next((m) => m.id === 2), {
    id: 2,
    result: { echo: "Debugger.enable" },
  });
  assert.strictEqual(
    metro.accepted(),
    1,
    "a frontend reload did not open a second app session"
  );
  await reloaded.close();
});

test("stopping while detached stays stopped — no late upstream attach", async (t) => {
  const { metro, bridge, listenPort } = await makeWorld(t, {
    metro: { targetAvailable: false },
  });
  const frontend = connectFrontend(listenPort);
  await frontend.open();
  await new Promise((resolve) => setTimeout(resolve, 40)); // mid-poll

  await bridge.stop();
  metro.setTargetAvailable(true); // the app "appears" after shutdown
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.strictEqual(metro.accepted(), 0, "no socket opened after stop()");
  assert.strictEqual(bridge.isAttached(), false);
  await assert.rejects(
    () => bridge.sendCommand("Runtime.evaluate", { expression: "1" }),
    /not running|no CDP session/
  );
});

test("a second frontend connection replaces the first (one CDP session, one owner)", async (t) => {
  const { bridge, listenPort } = await makeWorld(t, {});
  const first = connectFrontend(listenPort);
  await first.open();
  await waitFor(() => bridge.isAttached());

  const second = connectFrontend(listenPort);
  await second.open();

  // Two frontends cannot share one CDP session (both allocate ids from 1), so the
  // newer one owns it and the discarded socket is closed.
  await waitFor(() => bridge.status().clients === 1);
  await waitFor(() => first.socket.readyState === first.socket.CLOSED);
  second.send({ id: 7, method: "Runtime.enable" });
  assert.deepStrictEqual(await second.next((m) => m.id === 7), {
    id: 7,
    result: { echo: "Runtime.enable" },
  });
  await second.close();
});

test("external relay mode binds nothing and refuses host commands", async (t) => {
  const { bridge, listenPort } = await makeWorld(t, { bridge: { enabled: false } });
  await assert.rejects(
    () => bridge.sendCommand("Runtime.evaluate", { expression: "1" }),
    /Runtime\.evaluate: CDP bridge is not running/
  );
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${listenPort}`);
        socket.once("open", () => reject(new Error("the bridge took the socket")));
        socket.once("error", reject);
      }),
    /ECONNREFUSED|socket hang up|closed/i
  );
});
