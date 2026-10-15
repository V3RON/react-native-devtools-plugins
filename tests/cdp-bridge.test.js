// CDP bridge tests (src/main/cdp-bridge.js) against a fake Metro inspector proxy
// and a fake frontend — both real WebSockets in this process, using the `ws`
// dependency the repo already has. Covers what the layers above depend on: host
// command id correlation, non-matching ids relayed untouched, notification
// fan-out, the reconnect buffer, re-attach after an upstream drop, and the
// request deadline.
//
// The second half is the access policy (docs/SECURITY-PLATFORM.md F3): who the
// socket binds, which `Origin`s it accepts, and what happens to a client that
// dials while the frontend owns the session. Those run against the REAL server
// and real sockets too — a "peer from another machine" is a real socket dialled
// from this machine's own LAN address, not a stubbed verifyClient.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const WebSocket = require("ws");

const {
  createCdpBridge,
  HOST_ID_BASE,
  REFUSE_CLOSE_CODE,
  isLoopbackAddress,
  upgradeAllowed,
} = require("../src/main/cdp-bridge");

// A source address that is NOT loopback, for the one test that has to prove what
// a peer on another machine sees. Empty on a machine with no LAN interface.
const lanAddress = () =>
  (Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && !entry.internal && entry.family === "IPv4")
    .map((entry) => entry.address)[0] || "");

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

// Upper bound only: every predicate returns the moment it holds, so a generous
// deadline costs nothing when things work and only buys tolerance when the
// machine is busy. 4000ms was observed to false-fail the re-attach test inside a
// full `npm test` (three Electron harnesses share the suite): a re-attach needs a
// /json/list fetch plus a WebSocket handshake — two round trips through an event
// loop other processes are starving. The re-attach's own assertions (a NEW
// upstream socket, the relay still working afterwards) are untouched, so this
// bound never lets a wrong behavior pass.
const waitFor = async (predicate, { timeoutMs = 15000, intervalMs = 10 } = {}) => {
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

test("a second frontend connection is refused; the first keeps the one CDP session", async (t) => {
  // This test used to pin the opposite ("the newer one owns it and the discarded
  // socket is closed"). GitHub issue #23 says that rule is the vulnerability —
  // eviction lets anything that dials the socket become the frontend — so the
  // assertion is inverted rather than weakened: the invariant this test was
  // really guarding (ONE CDP session, ONE owner, the app never sees a second
  // debugger) still holds, it is now enforced by refusing the newcomer.
  const { metro, bridge, listenPort } = await makeWorld(t, {});
  const first = connectFrontend(listenPort);
  await first.open();
  await waitFor(() => bridge.isAttached());

  const second = connectFrontend(listenPort);
  await second.open();
  await waitFor(() => second.socket.readyState === second.socket.CLOSED);

  assert.strictEqual(bridge.status().clients, 1, "still exactly one owner");
  assert.strictEqual(
    first.socket.readyState,
    first.socket.OPEN,
    "the frontend that was here first was not evicted"
  );
  first.send({ id: 7, method: "Runtime.enable" });
  assert.deepStrictEqual(await first.next((m) => m.id === 7), {
    id: 7,
    result: { echo: "Runtime.enable" },
  });
  assert.strictEqual(metro.accepted(), 1, "one debugger session on the app");
  await first.close();
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

test("the port reported is the port bound, including when port 0 was asked for", async (t) => {
  // tests/extension-frame-harness.js reports this number as the run's CDP endpoint,
  // so it has to be the one a client would dial. Port 0 is how a caller asks for an
  // unused one, and it is the case where "what was asked for" and "what was bound"
  // differ — an accessor that echoed the option would report 0 forever, and the
  // bridge's own startup line would name a socket that does not exist.
  const fakeMetro = createFakeMetro({});
  const metroPort = await fakeMetro.listen();
  const logs = [];
  const bridgeUnderTest = createCdpBridge({
    metroHost: "127.0.0.1",
    metroPort,
    listenHost: "127.0.0.1",
    listenPort: 0,
    pollIntervalMs: 20,
    requestTimeoutMs: 500,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  t.after(async () => {
    await bridgeUnderTest.stop();
    await fakeMetro.close();
  });

  assert.strictEqual(bridgeUnderTest.listenPort(), null, "nothing is bound before start()");
  await bridgeUnderTest.start();
  const bound = bridgeUnderTest.listenPort();
  assert.ok(Number.isInteger(bound) && bound > 0, `a real port, not the 0 asked for: ${bound}`);

  // The number is not merely plausible: a frontend dialing exactly it gets through.
  const frontend = connectFrontend(bound);
  await frontend.open();
  await frontend.close();

  const line = logs.find((entry) => entry.includes("listening on"));
  assert.ok(line, `the bridge says where it listens: ${logs.join(" | ")}`);
  assert.ok(
    line.includes(`ws://localhost:${bound}`),
    `the startup line names the bound port: ${line}`
  );
  assert.ok(
    !logs.some((entry) => entry.includes("localhost:0")),
    `and never the placeholder: ${logs.join(" | ")}`
  );
});

// ── who may talk to this socket (docs/SECURITY-PLATFORM.md F3) ───────────────
// The socket IS the inspected app's debugger session, so these are the rules that
// keep "a web page the developer happens to have open" and "a machine on the LAN"
// from becoming the frontend. Everything below runs against the real server and
// real sockets; a "remote peer" is a real socket dialled from this machine's own
// non-loopback address.

/** The `Origin` the production frontend sends: the origin of its own URL. */
const FRONTEND_ORIGIN = "http://127.0.0.1:8081";

/** Bridge + Metro with the frontend origin allowed; `bridge` extras per test. */
async function makePolicyWorld(t, { bridge = {}, metro = {} } = {}) {
  return makeWorld(t, {
    bridge: { allowedOrigins: [FRONTEND_ORIGIN], probeTimeoutMs: 200, ...bridge },
    metro,
  });
}

const dial = (url, { origin, localAddress, autoPong = true } = {}) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: origin ? { Origin: origin } : {},
      localAddress,
      autoPong,
    });
    socket.once("error", reject);
    socket.once("open", () => resolve(socket));
  });

let relayId = 500;

/**
 * Proves who owns the session: only the owner's frames are relayed upstream, so
 * the one socket that gets an echo back is the frontend as far as the bridge is
 * concerned. `open` alone proves nothing — a refused client sees `open` too,
 * because the refusal is a close frame with an application code.
 */
const relays = (socket, { timeoutMs = 15000 } = {}) =>
  new Promise((resolve, reject) => {
    const id = ++relayId;
    const timer = setTimeout(
      () => reject(new Error("this socket is not the session owner")),
      timeoutMs
    );
    const onMessage = (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (parsed.id !== id) {
        return;
      }
      clearTimeout(timer);
      socket.removeListener("message", onMessage);
      resolve(parsed);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, method: "Runtime.enable" }));
  });

/** Dials and fails unless the socket ends up owning the session. */
const dialOwner = async (t, url, options) => {
  const socket = await dial(url, options);
  t.after(() => socket.close());
  await relays(socket);
  return socket;
};

/** Dials and resolves with the refusal's `{code, reason}`; rejects if it wins. */
const dialedButRefused = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: options.origin ? { Origin: options.origin } : {},
      localAddress: options.localAddress,
    });
    const timer = setTimeout(
      () => reject(new Error("the newcomer was never refused")),
      15000
    );
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });

/**
 * A TCP connection that completes the WebSocket handshake by hand and then writes
 * `raw` as bytes. A real `WebSocket` client cannot produce this: `ws` would never
 * send an unmasked client frame, and a protocol error is exactly what a hostile
 * peer can send. `host` is bracketed because `net.connect` does not strip them.
 */
const writeRawFrameAfterHandshake = ({ host, port, path = "/", headers = {}, raw }) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (upgraded || !chunk.toString().startsWith("HTTP/1.1 101")) {
        return;
      }
      upgraded = true;
      socket.write(raw);
      resolve(socket);
    });
    socket.on("error", () => {
      // The server tears the connection down when it rejects the frame, which is
      // the expected end of this peer's story.
      if (!upgraded) {
        reject(new Error("the raw upgrade never completed"));
      }
    });
  });

/** An unmasked client frame: every client frame must be masked (RFC 6455 §5.2),
 *  so `ws` raises a protocol error on the SERVER-side socket for it. */
const UNMASKED_FRAME = Buffer.from([0x82, 0x00]);

test("the default bind is loopback, and nothing else", async (t) => {
  // `listenHost` is deliberately NOT passed: this test is about the default.
  // The spy wraps the REAL `ws` server (so the bind itself is real) and records
  // what was handed to it — the assertion the finding asks for is "which host
  // went into `.listen`", and a bind to `undefined` would silently mean "every
  // interface".
  const listenCalls = [];
  class SpyServer extends WebSocket.Server {
    constructor(options) {
      listenCalls.push(options);
      super(options);
    }
  }
  class SpyWebSocket extends WebSocket {
    static Server = SpyServer;
  }

  const listenPort = await freePort();
  const bridge = createCdpBridge({
    metroHost: "127.0.0.1",
    metroPort: await freePort(), // nothing is listening there: discovery just retries
    listenPort,
    pollIntervalMs: 20,
    WebSocket: SpyWebSocket,
    log: () => {},
  });
  await bridge.start();
  t.after(() => bridge.stop());

  assert.ok(listenCalls.length > 0, "start() called .listen at least once");
  for (const call of listenCalls) {
    assert.ok(
      isLoopbackAddress(call.host),
      `.listen was given a non-loopback host: ${JSON.stringify(call.host)}`
    );
  }
  // Belt and braces: what the OS actually bound, not what was asked for.
  const bound = bridge.listeningAddresses();
  assert.ok(bound.length > 0);
  for (const address of bound) {
    assert.ok(
      isLoopbackAddress(address.address),
      `the socket is reachable on ${address.address}`
    );
    assert.strictEqual(address.port, listenPort);
  }
  // Both families: the frontend dials `?ws=localhost:…`, and `localhost` may
  // resolve to either, so neither may be missing (SECURITY-PLATFORM.md §8).
  assert.deepStrictEqual(
    bound.map((address) => address.family).sort(),
    ["IPv4", "IPv6"],
    "the default binds 127.0.0.1 AND ::1"
  );

  // And the literal the frontend dials has to work. `?ws=localhost:9223` becomes
  // `ws://localhost:<port>`, and which family the resolver picks is its own mood —
  // so all three spellings are dialled, `[::1]` being the one a `127.0.0.1`-only
  // bind would have missed. This is the measurement SECURITY-PLATFORM.md §8 claims;
  // until now no test had dialled `localhost` at all. One at a time, closed in
  // between: the second would be refused for the seat, which is the right answer to
  // a different question.
  for (const [host, expectedFamily] of [
    ["localhost", undefined], // either family is correct, connecting is the point
    ["[::1]", "IPv6"],
    ["127.0.0.1", "IPv4"],
  ]) {
    const peer = await dial(`ws://${host}:${listenPort}`);
    // `dial` resolves on `open` and rejects on `error`, so reaching here is the
    // assertion for `localhost`; the family is what pins the two literal binds,
    // and it is what a `127.0.0.1`-only bind would have got wrong.
    assert.ok(
      isLoopbackAddress(peer._socket.remoteAddress),
      `ws://${host}:${listenPort} reached a non-loopback socket`
    );
    if (expectedFamily) {
      assert.strictEqual(
        peer._socket.remoteFamily,
        expectedFamily,
        `ws://${host}:${listenPort} did not land on ${expectedFamily}`
      );
    }
    await new Promise((resolve) => {
      peer.once("close", resolve);
      peer.close();
    });
  }
});

/** The URL list `start()` prints for a set of `server.address()` results. */
const listeningLine = (addresses) =>
  addresses.map(
    ({ address, port }) => `ws://${net.isIPv6(address) ? `[${address}]` : address}:${port}`
  );

test("the startup line prints an address that can actually be dialled", async (t) => {
  // The one line a developer copy-pastes was `ws://::1:9223` for the IPv6 bind, and
  // no client on earth dials that — an IPv6 literal in a URL has to be bracketed.
  // Loopback by default, so this covers the shipped shape too.
  const lines = [];
  const listenPort = await freePort();
  const bridge = createCdpBridge({
    metroHost: "127.0.0.1",
    metroPort: await freePort(),
    listenPort,
    pollIntervalMs: 20,
    log: (_level, message) => lines.push(message),
  });
  await bridge.start();
  t.after(() => bridge.stop());

  const line = lines.find((message) => message.includes("CDP bridge listening on"));
  assert.ok(line, `no listening line in ${lines}`);
  const printed = line.match(/ws:\/\/[^\s,]+/g);
  assert.deepStrictEqual(printed, [
    `ws://127.0.0.1:${listenPort}`,
    `ws://[::1]:${listenPort}`,
  ]);
  // Every printed address must parse as a URL, i.e. be something `new WebSocket`
  // accepts — the assertion that would have caught the unbracketed literal.
  for (const url of printed) {
    assert.strictEqual(new URL(url).port, String(listenPort), `not diallable: ${url}`);
  }
  // And it is the same list the socket reports, not a reconstruction of what was
  // asked for — the next test is where that distinction matters.
  assert.deepStrictEqual(printed, listeningLine(bridge.listeningAddresses()));
});

test("the startup line prints the port the socket HAS, not the one it was asked for", async (t) => {
  // `listenPort: 0` means "any free port", and the two default binds on it are each
  // given their own ephemeral port. A line built from the REQUESTED port printed
  // `ws://127.0.0.1:0, ws://[::1]:0` — not a socket anybody can dial, copy-pasted
  // into a browser. Found by the reviewer probing the factory, not by a shipped
  // config (the shell and the CLI always pass a port), which is why it needs its own
  // test rather than riding along on the pinned-port one above.
  const lines = [];
  const bridge = createCdpBridge({
    metroHost: "127.0.0.1",
    metroPort: await freePort(),
    listenPort: 0,
    pollIntervalMs: 20,
    log: (_level, message) => lines.push(message),
  });
  // Unpinned on both sides: nothing is bound before `start()` and nothing survives
  // `stop()`, so this test can neither leak a socket nor hide one behind a stub.
  assert.deepStrictEqual(bridge.listeningAddresses(), [], "something was bound before start()");
  t.after(() => bridge.stop());
  await bridge.start();

  const bound = bridge.listeningAddresses();
  assert.deepStrictEqual(
    bound.map((address) => (net.isIPv6(address.address) ? "::1" : "127.0.0.1")),
    ["127.0.0.1", "::1"],
    "the ephemeral bind did not use both loopbacks"
  );
  const ports = bound.map((address) => address.port);
  assert.ok(ports.every((port) => port > 0), `the OS did not give an ephemeral port: ${ports}`);
  assert.strictEqual(ports.length, 2);
  assert.notStrictEqual(ports[0], ports[1], "the two binds were given one port");

  const line = lines.find((message) => message.includes("CDP bridge listening on"));
  assert.ok(line, `no listening line in ${lines}`);
  const printed = line.match(/ws:\/\/[^\s,]+/g);
  // The line IS the addresses the socket reports — same values, same order, IPv6
  // bracketed. Under the old line this compared `ws://127.0.0.1:0, ws://[::1]:0`
  // against the real ports and failed on both counts.
  assert.deepStrictEqual(printed, listeningLine(bound));
  assert.ok(!printed.some((url) => url.endsWith(":0")), `port 0 printed: ${printed}`);

  await bridge.stop();
  assert.deepStrictEqual(bridge.listeningAddresses(), [], "still bound after stop()");
});

test("an Origin outside the allowlist is refused and does not evict the frontend", async (t) => {
  const { bridge, listenPort } = await makePolicyWorld(t);
  const frontend = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });

  await assert.rejects(
    () => dial(`ws://127.0.0.1:${listenPort}`, { origin: "http://evil.example" }),
    /403/
  );

  // The refusal happens at the upgrade, so the frontend never loses anything.
  assert.strictEqual(frontend.readyState, WebSocket.OPEN, "the frontend survived");
  assert.strictEqual(bridge.status().clients, 1);
  await relays(frontend);
});

test("an Origin-less client is accepted from a loopback peer", async (t) => {
  // The shape of `npm run rn-cdp`, a test, or curl: no browser can hide an
  // Origin, so its absence from a local peer is a tool, not an attacker.
  const { listenPort } = await makePolicyWorld(t);
  const tool = await dialOwner(t, `ws://127.0.0.1:${listenPort}`);
  assert.ok(isLoopbackAddress(tool._socket.remoteAddress));
});

test("an Origin-less client from a non-loopback peer is refused", async (t) => {
  const peer = lanAddress();
  if (!peer) {
    t.skip("this machine has no non-loopback IPv4 address to dial from");
    return;
  }
  // The finding's own scenario: the socket is reachable off-loopback. Only this
  // test opts in to that, which is what DEVTOOLS_CDP_HOST is for. Binding both
  // addresses lets the loopback case act as the control: same server, same
  // Origin-less dial, and only the peer address differs.
  const { bridge, listenPort } = await makePolicyWorld(t, {
    bridge: { listenHost: [peer, "127.0.0.1"] },
  });

  await assert.rejects(
    () => dial(`ws://${peer}:${listenPort}`, { localAddress: peer }),
    /403/
  );
  assert.strictEqual(bridge.status().clients, 0, "the refused peer is not a client");

  const control = await dialOwner(t, `ws://127.0.0.1:${listenPort}`);
  assert.ok(isLoopbackAddress(control._socket.remoteAddress));
});

test("the Origin policy is the same rule for every peer (pure)", () => {
  const allowedOrigins = new Set([FRONTEND_ORIGIN]);
  const cases = [
    // [origin, peer, expected]
    [FRONTEND_ORIGIN, "127.0.0.1", true],
    [FRONTEND_ORIGIN, "192.168.1.26", true], // remote-device dev, opt-in bind
    ["http://evil.example", "127.0.0.1", false],
    ["http://evil.example", "192.168.1.26", false],
    [undefined, "127.0.0.1", true],
    [undefined, "::1", true],
    [undefined, "::ffff:127.0.0.1", true],
    [undefined, "192.168.1.26", false],
    [undefined, "10.0.0.5", false],
    [undefined, undefined, false],
  ];
  for (const [origin, peerAddress, expected] of cases) {
    assert.strictEqual(
      upgradeAllowed({ origin, peerAddress, allowedOrigins }),
      expected,
      `Origin=${origin} peer=${peerAddress}`
    );
  }
});

test("a second client while one is attached is refused, not replacing it", async (t) => {
  const { bridge, listenPort } = await makePolicyWorld(t);
  const first = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });

  const refused = await dialedButRefused(`ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });
  assert.strictEqual(refused.code, REFUSE_CLOSE_CODE, "the refusal has its own close code");
  assert.match(refused.reason, /already owns the session/);

  // First-wins means the owner keeps everything: still open, still relaying,
  // still the only client.
  assert.strictEqual(first.readyState, WebSocket.OPEN);
  assert.strictEqual(bridge.status().clients, 1);
  await relays(first);
});

test("a refused client cannot get a single CDP command upstream", async (t) => {
  // Ownership is decided asynchronously (the liveness probe), so a newcomer's
  // frames are staged until it wins or is refused. Otherwise a refused attacker
  // would still get its `Runtime.evaluate` into the app before the close landed.
  const { metro, bridge, listenPort } = await makePolicyWorld(t);
  const owner = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });

  const attacker = new WebSocket(`ws://127.0.0.1:${listenPort}`, {
    headers: { Origin: FRONTEND_ORIGIN },
  });
  attacker.on("error", () => {});
  await new Promise((resolve) => attacker.once("open", resolve));
  attacker.send(
    JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "evil()" } })
  );
  await dialedButRefused(`ws://127.0.0.1:${listenPort}`, { origin: FRONTEND_ORIGIN });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const methods = metro.commands().map((m) => m.method);
  assert.ok(!methods.includes("Runtime.evaluate"), `staged frames escaped: ${methods}`);
  assert.strictEqual(bridge.status().clients, 1);
  attacker.close();
  await relays(owner);
});

test("allowlist entries are compared as origins, and one that names none grants nothing", async (t) => {
  // Operators type a URL; a browser sends an origin. `http://host:1234/frontend/`
  // has to mean `http://host:1234`, or the documented escape hatch does nothing at
  // all and the developer just sees a 403. Both halves are checked over real
  // upgrades, not against the internal Set.
  const logs = [];
  const { listenPort } = await makeWorld(t, {
    bridge: {
      allowedOrigins: ["http://127.0.0.1:8081/frontend/", "not-an-origin"],
      probeTimeoutMs: 200,
      log: (level, message) => logs.push(`${level}: ${message}`),
    },
  });

  // The path is dropped...
  await dialOwner(t, `ws://127.0.0.1:${listenPort}`, { origin: "http://127.0.0.1:8081" });
  // ...and it is not part of the match either: `Origin` never carries one.
  await assert.rejects(
    () => dial(`ws://127.0.0.1:${listenPort}`, { origin: "http://127.0.0.1:8081/frontend/" }),
    /403/
  );
  // Fails closed: an entry that names no origin admits no peer, including a peer
  // crude enough to send that string as its `Origin` header — which is why the entry
  // is dropped from the set rather than kept as written.
  await assert.rejects(
    () => dial(`ws://127.0.0.1:${listenPort}`, { origin: "not-an-origin" }),
    /403/
  );

  // And the operator is told what is actually in force, both the normalized form and
  // the entry that was discarded.
  const listed = logs.find((line) => line.includes("allowed Origins"));
  assert.ok(listed, `the effective allowlist is not logged: ${logs}`);
  assert.ok(listed.includes("http://127.0.0.1:8081"), listed);
  assert.ok(!listed.includes("not-an-origin"), listed);
  const dropped = logs.find((line) => line.includes("name no origin"));
  assert.ok(dropped, `the discarded entry is not reported: ${logs}`);
  assert.ok(dropped.includes("not-an-origin"), dropped);
});

test("a malformed frame from a REFUSED client does not take the process down", async (t) => {
  // `ws` emits `error` on the SERVER-side socket when a peer breaks the protocol,
  // and an EventEmitter with no `error` listener throws — which in the shell means
  // the Electron main process dies. The bridge decides ownership asynchronously,
  // so a client that is refused (or still inside the liveness-probe window) has not
  // been through `promote`; if the error handler lived only there, this peer would
  // be the one socket on earth with no handler. One unmasked frame is all it takes,
  // after a handshake that the access rules PASS (a loopback Origin-less dial).
  const { bridge, listenPort } = await makePolicyWorld(t);
  const owner = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });

  const attacker = await writeRawFrameAfterHandshake({
    host: "127.0.0.1",
    port: listenPort,
    raw: UNMASKED_FRAME,
  });
  t.after(() => attacker.destroy());

  // The whole point: this test runs IN the process under test, so an unhandled
  // 'error' event would fail it rather than pass it. What is left to pin is that
  // the bridge is still a bridge afterwards.
  await relays(owner);
  assert.strictEqual(bridge.status().clients, 1, "the owner was not disturbed");
});

test("a malformed frame from a client inside the probe window does not take the process down", async (t) => {
  // The other un-promoted shape: the newcomer is STAGED while the owner is probed,
  // so for `probeTimeoutMs` it is a client that exists and has not been through
  // `promote` either. It writes its malformed frame in that window, and the
  // bridge has to survive it and still hand the session to the next frontend.
  const { bridge, listenPort } = await makePolicyWorld(t, {
    bridge: { probeTimeoutMs: 400 },
  });
  await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
    autoPong: false,
  });

  const attacker = await writeRawFrameAfterHandshake({
    host: "127.0.0.1",
    port: listenPort,
    headers: { Origin: FRONTEND_ORIGIN },
    raw: UNMASKED_FRAME,
  });
  t.after(() => attacker.destroy());

  // Still serving: a later frontend that dials gets the session (the zombie never
  // answered a ping, so the probe retires it).
  await dialOwner(t, `ws://127.0.0.1:${listenPort}`, { origin: FRONTEND_ORIGIN });
  assert.strictEqual(bridge.status().clients, 1);
});

test("the frontend still reconnects after its socket closes", async (t) => {
  // Refusal must not mean "wedged": the everyday frontend reload closes the old
  // socket and dials again, and that reconnect has to win without waiting on a
  // liveness timeout.
  const { bridge, listenPort } = await makePolicyWorld(t);
  const first = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });
  const closed = new Promise((resolve) => first.once("close", resolve));
  first.close();
  await closed;

  const reloaded = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });
  assert.strictEqual(bridge.status().clients, 1, "exactly one owner again");
});

test("an owner that stops answering does not wedge the socket", async (t) => {
  // The other half of the rule: `probeTimeoutMs` is what tells "the old socket
  // just died" apart from "someone else, while the frontend is attached". A peer
  // that never answers pings is unreachable — the shape of a half-open connection
  // or a killed client (a merely busy frontend still pongs: control frames are
  // answered below page JS, RFC 6455 §5.5.2).
  const { bridge, listenPort } = await makePolicyWorld(t);
  const zombie = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
    autoPong: false,
  });

  const t0 = Date.now();
  const fresh = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });
  assert.ok(
    Date.now() - t0 >= 150,
    "the takeover waited for the liveness probe instead of skipping it"
  );
  assert.strictEqual(bridge.status().clients, 1, "still one owner, now the newcomer");
});

test("a reload that loses the race is refused while the live owner keeps the seat", async (t) => {
  // The stale-tab shape, which is what "first wins" has to survive: the frontend's
  // OLD document is still alive and pinging (a tab the user never closed, a peer
  // that answers control frames, a cross-family dial) while a NEW dial arrives. The
  // newcomer must be refused, and — the half a loosely-written rule gets wrong —
  // refused *without* the old owner being replaced. Only the owner's own close may
  // free the seat. Three sequential dials rather than one racing promise: that is
  // the sequence someone can actually cause by reloading a tab.
  const { bridge, listenPort } = await makePolicyWorld(t);
  const live = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });

  const refused = await dialedButRefused(`ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
  });
  assert.strictEqual(refused.code, REFUSE_CLOSE_CODE);
  assert.strictEqual(bridge.status().clients, 1, "the refusal changed no ownership");
  await relays(live);

  // The refused dial gives up and the live owner finally goes away (the user closes
  // the old tab): the next dial is in, with no probe window to sit through.
  const closed = new Promise((resolve) => live.once("close", resolve));
  live.close();
  await closed;

  await dialOwner(t, `ws://127.0.0.1:${listenPort}`, { origin: FRONTEND_ORIGIN });
  assert.strictEqual(bridge.status().clients, 1, "exactly one owner, the third dial");
});

test("an owner that dies mid-probe hands the session to the newcomer", async (t) => {
  // The close can land *inside* `probeTimeoutMs` — a tab killed at the moment the
  // newcomer dials. The probe settles on that close instead of sitting out its
  // timer, so the newcomer is not refused for a seat nobody holds. The owner has to
  // be deaf (`autoPong: false`) for the window to exist at all: a live one pongs in
  // the first millisecond and settles the probe before any close could arrive.
  const { bridge, listenPort } = await makePolicyWorld(t, {
    bridge: { probeTimeoutMs: 4000 },
  });
  const zombie = await dialOwner(t, `ws://127.0.0.1:${listenPort}`, {
    origin: FRONTEND_ORIGIN,
    autoPong: false,
  });

  const t0 = Date.now();
  setTimeout(() => zombie.terminate(), 100);
  await dialOwner(t, `ws://127.0.0.1:${listenPort}`, { origin: FRONTEND_ORIGIN });
  assert.ok(
    Date.now() - t0 < 3000,
    "the newcomer took over on the close, not after the whole probe window"
  );
  assert.strictEqual(bridge.status().clients, 1);
});

test("an explicit listenHost is honoured (remote-device development)", async (t) => {
  const peer = lanAddress();
  if (!peer) {
    t.skip("this machine has no non-loopback IPv4 address to bind");
    return;
  }
  const { bridge } = await makePolicyWorld(t, { bridge: { listenHost: peer } });
  assert.deepStrictEqual(
    bridge.listeningAddresses().map((address) => address.address),
    [peer]
  );
});

/**
 * Runs `src/tools/rn-cdp.js` the way a developer does and waits for its listening
 * line, returning the addresses it printed. A child process is the only honest way
 * to test the CLI — the flag/env resolution happens at its load time. Metro is not
 * running, which is fine: discovery retries and the socket still binds.
 */
const runRnCdp = (t, { args = [], env = {} } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "..", "src", "tools", "rn-cdp.js"), ...args],
      {
        // Cleared, not inherited: a developer running the suite with this set would
        // otherwise change what the no-flag test sees.
        env: { ...process.env, DEVTOOLS_CDP_HOST: "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    t.after(() => child.kill("SIGTERM"));
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`rn-cdp.js never listened. Output:\n${out}`)),
      15000
    );
    const onData = (chunk) => {
      out += String(chunk);
      const match = out.match(/CDP bridge listening on (.*?) \(Metro:/);
      if (match) {
        clearTimeout(timer);
        // The default bind is two addresses separated by ", ", so this is a list;
        // each test says how many it expects.
        resolve(match[1].split(", "));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`rn-cdp.js exited (${code}) before listening:\n${out}`))
    );
  });

test("rn-cdp.js binds where it is told: --listen-host, then DEVTOOLS_CDP_HOST", async (t) => {
  // F3 gave the bridge a loopback default, which took the remote-device relay away
  // from the one tool people run BECAUSE they want a peer on another machine. `::1`
  // is the smallest address that proves the value reached `.listen` (the default is
  // IPv4-first) and it has to come back bracketed, since the log line is what gets
  // pasted into a browser.
  const flagPort = await freePort();
  assert.deepStrictEqual(
    await runRnCdp(t, { args: ["--listen-host", "::1", "--listen-port", String(flagPort)] }),
    [`ws://[::1]:${flagPort}`]
  );
  // Not just the log line: the address in it is really reachable. No Metro is up,
  // so this proves the connect, not a session. Closed inline rather than in a
  // teardown: the child is killed first otherwise, and the reset would surface as an
  // unhandled 'error' on this side.
  const byFlag = await dial("ws://[::1]:" + flagPort);
  await new Promise((resolve) => {
    byFlag.once("close", resolve);
    byFlag.close();
  });

  // Same address by env, the knob the shell reads too — the two must not drift.
  // Its own port: the first child is still holding that one.
  const envPort = await freePort();
  assert.deepStrictEqual(
    await runRnCdp(t, {
      args: ["--listen-port", String(envPort)],
      env: { DEVTOOLS_CDP_HOST: "::1" },
    }),
    [`ws://[::1]:${envPort}`]
  );
  const byEnv = await dial("ws://[::1]:" + envPort);
  await new Promise((resolve) => {
    byEnv.once("close", resolve);
    byEnv.close();
  });
});

test("rn-cdp.js with no --listen-host keeps the loopback default", async (t) => {
  // The CLI must not become a way around F3 just because it is a tool.
  const listenPort = await freePort();
  const listening = await runRnCdp(t, { args: ["--listen-port", String(listenPort)] });
  assert.deepStrictEqual(listening, [
    `ws://127.0.0.1:${listenPort}`,
    `ws://[::1]:${listenPort}`,
  ]);
});

test("DEVTOOLS_CDP_ALLOWED_ORIGINS is unset-by-default and additive", () => {
  // src/main/config.js resolves this at LOAD time, so the env has to be set in a
  // real child process — a mutated `process.env` here would not be the thing the
  // shell actually reads.
  const read = (env) => {
    const childEnv = { ...process.env, ...env };
    // "Unset by default" has to mean unset for the child too, even if whoever ran
    // the suite happens to have one of these exported.
    for (const name of [
      "DEVTOOLS_CDP_ALLOWED_ORIGINS",
      "DEVTOOLS_CDP_HOST",
      "DEVTOOLS_FRONTEND_URL",
    ]) {
      if (!(name in env)) {
        delete childEnv[name];
      }
    }
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify(require(process.argv[1]).cdpBridge))",
        path.join(__dirname, "..", "src", "main", "config.js"),
      ],
      { env: childEnv, encoding: "utf8" }
    );
    return JSON.parse(out);
  };

  // Unset (and no DEVTOOLS_FRONTEND_URL): the frontend's own origin, and nothing
  // else. This is the shipped default — the escape hatch adds, it does not replace.
  const base = read({});
  assert.deepStrictEqual(base.allowedOrigins, ["http://127.0.0.1:8081"]);
  assert.strictEqual(
    base.listenHost,
    undefined,
    "DEVTOOLS_CDP_HOST stays unset: the bridge's loopback default applies"
  );

  const withEnv = read({
    DEVTOOLS_CDP_ALLOWED_ORIGINS: "http://host:1234 http://other:80",
    DEVTOOLS_FRONTEND_URL: "http://192.168.1.5:3000/rozenite/rn_fusebox.html?ws=localhost:9223",
  });
  assert.deepStrictEqual(withEnv.allowedOrigins, [
    "http://192.168.1.5:3000",
    "http://host:1234",
    "http://other:80",
  ]);
});
