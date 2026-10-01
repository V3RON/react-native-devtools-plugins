// End-to-end network model: a fake RN app that speaks CDP over a real WebSocket,
// the real CDP bridge (src/main/cdp-bridge.js), the real main-process service
// (src/main/network-service.js) and the real frame-side shim
// (src/chrome-shim/network-bridge.js) wired together the way
// src/main/ipc.js + src/preload/extension-frame.js wire them in the app.
//
// This is the layer unit tests cannot prove: the notifications travel a real
// socket, the `Network.enable` an extension's first listener triggers is a real
// CDP command with a host-allocated id, and a response body comes back through
// `Network.getResponseBody` instead of from a constant.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const WebSocket = require("ws");

const { createCdpBridge, HOST_ID_BASE } = require("../src/main/cdp-bridge");
const { createNetworkService } = require("../src/main/network-service");
const { createNetworkBridge } = require("../src/chrome-shim/network-bridge");
const { createChromeNamespace } = require("../src/chrome-shim");
const { createMemoryBackend, createExtensionStorage } = require("../src/chrome-shim/storage");

// ── fake RN app: /json/list plus one /inspector/debug socket ─────────────────
const GraphQLUrl = "https://countries.trevorblades.com/";
const GraphQLBody = '{"data":{"country":{"name":"Brazil"}}}';
const GraphQLQuery = '{"query":"{ country(code: \\"BR\\") { name } }"}';

/** The notifications a real RN app produces for one successful XHR. */
const graphqlExchange = () => [
  {
    method: "Network.requestWillBeSent",
    params: {
      requestId: "fetch-1",
      loaderId: "loader-1",
      documentURL: "rn://devtools-poc",
      timestamp: 100.5,
      wallTime: 1700000000.5,
      type: "XHR",
      request: {
        url: GraphQLUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: '{"query":"{ country(code: \\"BR\\") { name } }"}',
        hasPostData: true,
      },
      initiator: { type: "fetch", stack: { callFrames: [] } },
    },
  },
  {
    method: "Network.requestWillBeSentExtraInfo",
    params: {
      requestId: "fetch-1",
      headers: { "content-type": "application/json", "user-agent": "com.example.app/1.0" },
    },
  },
  {
    method: "Network.responseReceived",
    params: {
      requestId: "fetch-1",
      type: "XHR",
      timestamp: 100.9,
      response: {
        url: GraphQLUrl,
        status: 200,
        statusText: "",
        httpVersion: "HTTP/1.1",
        mimeType: "application/json",
        headers: { "content-type": "application/json", "content-length": "37" },
        protocol: "http/1.1",
      },
    },
  },
  {
    method: "Network.dataReceived",
    params: { requestId: "fetch-1", timestamp: 100.95, dataLength: 37, encodedDataLength: 138 },
  },
  { method: "Network.loadingFinished", params: { requestId: "fetch-1", timestamp: 101.1, encodedDataLength: 138 } },
];

function createFakeApp() {
  const sockets = new Set();
  /** every CDP command the fake app received, in arrival order */
  const commands = [];
  /** method -> error message, making the app refuse a domain */
  const refusals = new Map();

  const server = http.createServer((req, res) => {
    if (!req.url.startsWith("/json/list")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify([
        {
          id: "1",
          type: "node",
          title: "devtools-poc (iPhone 17 Pro)",
          description: "devtools-poc [C++ connection]",
          appId: "devtools-poc",
          deviceName: "iPhone 17 Pro",
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/inspector/debug?device=1&page=1`,
        },
      ])
    );
  });

  const wss = new WebSocket.Server({ server, path: "/inspector/debug" });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      commands.push(message);
      const refusal = refusals.get(message.method);
      if (refusal) {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: refusal } }));
        return;
      }
      if (message.method === "Network.getResponseBody") {
        const buffered = message.params && message.params.requestId === "fetch-1";
        socket.send(
          JSON.stringify(
            buffered
              ? { id: message.id, result: { body: GraphQLBody, base64Encoded: false } }
              : {
                  id: message.id,
                  error: {
                    code: -32603,
                    message:
                      "Network.getResponseBody: Internal error: Could not retrieve response body for the given requestId.",
                  },
                }
          )
        );
        return;
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    listen: () =>
      new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        sockets.clear();
        wss.close(() => server.close(resolve));
      }),
    commands: (method) => commands.filter((m) => !method || m.method === method),
    refuse: (method, message) => refusals.set(method, message),
    /** push a CDP notification to every connected debugger client */
    push: (message) => {
      for (const socket of sockets) socket.send(JSON.stringify(message));
    },
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

const waitFor = async (predicate, { timeoutMs = 4000, intervalMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The whole stack with one extension frame attached: fake app ⇄ real bridge ⇄
 * real service ⇄ real shim. `hostToFrame` is the push channel
 * (webContents.send in the app) and the four `invoke*` functions are the
 * ipcMain.handle calls of src/main/ipc.js.
 */
async function makeWorld(t, { app = () => {} } = {}) {
  const fakeApp = createFakeApp();
  const appPort = await fakeApp.listen();
  app(fakeApp);

  const logs = [];
  const bridgeUnderTest = createCdpBridge({
    metroHost: "127.0.0.1",
    metroPort: appPort,
    listenHost: "127.0.0.1",
    listenPort: await freePort(),
    pollIntervalMs: 20,
    requestTimeoutMs: 2000,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  await bridgeUnderTest.start();

  const service = createNetworkService({
    sendCommand: (method, params, opts) => bridgeUnderTest.sendCommand(method, params, opts),
    onEvent: (method, handler) => bridgeUnderTest.onEvent(method, handler),
    bridgeStatus: () => bridgeUnderTest.status(),
    log: (level, message) => logs.push(`${level}: ${message}`),
  });

  // One extension frame, addressed by the key ipc.js derives from the frame
  // itself; the host's pushes land on the shim exactly as the preload forwards them.
  const deliveries = [];
  const shim = createNetworkBridge({
    subscribe: () => Promise.resolve(service.subscribe("frame-1", hostToFrame)),
    getNetworkStatus: () => Promise.resolve(service.getStatus()),
    fetchHar: (options) => Promise.resolve(service.getHar(options)),
    fetchBody: (requestId) => Promise.resolve(service.getBody(requestId)),
    logger: { log: () => {}, info: () => {}, warn: (m) => logs.push(`warn: ${m}`), error: (m) => logs.push(`error: ${m}`) },
  });
  function hostToFrame(payload) {
    deliveries.push(payload);
    shim.handleDelivery(payload && payload.payload ? payload.payload : payload);
  }

  const chrome = createChromeNamespace({
    extensionId: "ext-1",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: shim,
  });

  t.after(async () => {
    service.dispose();
    await bridgeUnderTest.stop();
    await fakeApp.close();
  });

  return {
    app: fakeApp,
    bridge: bridgeUnderTest,
    service,
    shim,
    chrome,
    logs,
    deliveries,
    /** every network payload the host has pushed to this frame */
    networkSteps: () =>
      deliveries.map((d) => d.payload || d).filter((p) => p.kind !== "status" && p.kind !== "navigated"),
    attached: () => waitFor(() => bridgeUnderTest.isAttached()),
    observing: () => waitFor(() => service.getStatus().available),
  };
}

// ── the path a GraphQL Network Inspector panel takes ────────────────────────
test("one live CDP session feeds webRequest, devtools.network and HAR with real data", async (t) => {
  const world = await makeWorld(t);
  await world.attached();

  const started = [];
  world.chrome.webRequest.onBeforeRequest.addListener((details) => started.push(details), {
    urls: ["https://countries.trevorblades.com/*"],
    types: ["xmlhttprequest"],
  }, ["requestBody"]);
  const sent = [];
  world.chrome.webRequest.onSendHeaders.addListener((details) => sent.push(details));
  const finished = [];
  world.chrome.devtools.network.onRequestFinished.addListener((request) => finished.push(request));

  await world.observing();
  const enables = world.app.commands("Network.enable");
  assert.strictEqual(enables.length, 1, "an extension's first listener is what asks the app for the domain");
  assert.ok(enables[0].id >= HOST_ID_BASE, "the host allocates its own ids on the shared socket");

  for (const notification of graphqlExchange()) world.app.push(notification);
  await waitFor(() => finished.length > 0);

  // chrome.webRequest saw the request on the other side of the socket.
  assert.deepStrictEqual(started.map((d) => d.url), [GraphQLUrl]);
  assert.strictEqual(started[0].type, "xmlhttprequest", "main maps the resource type once");
  assert.strictEqual(started[0].method, "POST");
  assert.strictEqual(
    new TextDecoder().decode(started[0].requestBody.raw[0].bytes),
    GraphQLQuery,
    "the real POST body, as Chrome's Uint8Array raw bytes"
  );
  assert.ok(
    started[0].requestHeaders.some((h) => h.name === "content-type"),
    "the headers announced with the request"
  );
  assert.ok(
    sent[0].requestHeaders.some((h) => h.name === "user-agent"),
    "onSendHeaders carries the wire headers from the extra-info notification"
  );

  // chrome.devtools.network saw the same request finish.
  const request = finished[0];
  assert.strictEqual(request.response.status, 200);
  assert.strictEqual(request.response.content.mimeType, "application/json");
  assert.strictEqual(request.request.method, "POST");
  assert.strictEqual(request._resourceType, "xhr");
  assert.strictEqual(request._transferSize, 138, "encodedDataLength, not a made-up size");
  assert.strictEqual(request.startedDateTime, new Date(1700000000.5 * 1000).toISOString());
  assert.ok(Math.abs(request.time - 600) < 1e-6, `finished minus started in ms, from CDP's own float clock (${request.time})`);

  // The body arrives from Network.getResponseBody, not from a constant.
  const content = await request.getContent();
  assert.strictEqual(content.content, GraphQLBody);
  assert.strictEqual(content.encoding, null, "the backend said plain text");
  assert.strictEqual(world.app.commands("Network.getResponseBody").length, 1);

  // getHAR holds the same real entry, addressable both ways.
  const har = await world.chrome.devtools.network.getHAR();
  assert.strictEqual(har.version, "1.2");
  assert.strictEqual(har.entries.length, 1);
  assert.strictEqual(har.log.entries, har.entries, "one entry, both spellings");
  assert.strictEqual(har.entries[0].request.url, GraphQLUrl);
  assert.strictEqual(har.entries[0].request.postData.text, GraphQLQuery);
  assert.strictEqual(har.entries[0].request.postData.size, GraphQLQuery.length, "UTF-8 bytes of the real body");
  assert.strictEqual(har.entries[0].response.headers.find((h) => h.name === "content-type").value, "application/json");
  assert.strictEqual(har.entries[0].timings.dns, -1, "a breakdown CDP never reported stays HAR's -1");
  assert.ok(Math.abs(har.entries[0].timings.receive - 200) < 1e-6, "receive = finished - response");

  const status = await world.chrome.devtools.network.getNetworkStatus();
  assert.deepStrictEqual(
    { available: status.available, enableState: status.enableState, requests: status.requests, finished: status.finished },
    { available: true, enableState: "enabled", requests: 1, finished: 1 }
  );
  assert.deepStrictEqual(
    world.logs.filter((line) => line.startsWith("warn") && !/observe-only/.test(line)),
    [],
    `a working capture stays quiet: ${world.logs.join(" | ")}`
  );
});

test("a failed request is reported with the backend's error text", async (t) => {
  const world = await makeWorld(t);
  await world.attached();

  const failures = [];
  world.chrome.webRequest.onErrorOccurred.addListener((details) => failures.push(details));
  const finished = [];
  world.chrome.devtools.network.onRequestFinished.addListener((request) => finished.push(request));
  world.chrome.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["<all_urls>"] });

  await world.observing();
  world.app.push({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "fetch-9",
      timestamp: 200,
      wallTime: 1700000100,
      type: "XHR",
      request: { url: "https://x.dev/gone", method: "GET", headers: {} },
    },
  });
  world.app.push({
    method: "Network.loadingFailed",
    params: { requestId: "fetch-9", timestamp: 200.2, type: "XHR", errorText: "net::ERR_CONNECTION_REFUSED", canceled: false },
  });

  await waitFor(() => finished.length > 0);
  assert.strictEqual(failures[0].error, "net::ERR_CONNECTION_REFUSED");
  assert.strictEqual(finished[0].response.status, -1, "no response was ever reported");
  assert.deepStrictEqual(finished[0]._failure, { errorText: "net::ERR_CONNECTION_REFUSED", canceled: false });
  assert.strictEqual(finished[0].response.content.size, -1, "no bytes, HAR's own -1");
});

test("a redirect chain stays one entry with the intermediate response kept", async (t) => {
  const world = await makeWorld(t);
  await world.attached();

  const redirects = [];
  world.chrome.webRequest.onBeforeRedirect.addListener((details) => redirects.push(details));
  const started = [];
  world.chrome.webRequest.onBeforeRequest.addListener((details) => started.push(details));
  const finished = [];
  world.chrome.devtools.network.onRequestFinished.addListener((request) => finished.push(request));

  await world.observing();
  world.app.push({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "r-1",
      timestamp: 300,
      wallTime: 1700000200,
      request: { url: "https://x.dev/short", method: "GET", headers: {} },
    },
  });
  world.app.push({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "r-1",
      timestamp: 300.4,
      wallTime: 1700000200.4,
      request: { url: "https://x.dev/long", method: "GET", headers: {} },
      redirectResponse: {
        url: "https://x.dev/short",
        status: 302,
        statusText: "Found",
        headers: { location: "https://x.dev/long" },
      },
    },
  });
  world.app.push({
    method: "Network.responseReceived",
    params: {
      requestId: "r-1",
      type: "XHR",
      timestamp: 300.8,
      response: { url: "https://x.dev/long", status: 200, mimeType: "application/json", headers: {} },
    },
  });
  world.app.push({ method: "Network.loadingFinished", params: { requestId: "r-1", timestamp: 300.9, encodedDataLength: 90 } });

  await waitFor(() => finished.length > 0);
  assert.deepStrictEqual(redirects.map((d) => [d.url, d.statusCode, d.redirectUrl]), [
    ["https://x.dev/short", 302, "https://x.dev/long"],
  ]);
  assert.deepStrictEqual(started.map((d) => d.url), ["https://x.dev/short", "https://x.dev/long"]);
  assert.strictEqual(finished.length, 1, "one CDP requestId is one entry");
  assert.strictEqual(finished[0].request.url, "https://x.dev/long");
  assert.deepStrictEqual(finished[0]._redirects, [302]);
});

test("a body the app no longer buffers is answered with its error, never a stub payload", async (t) => {
  const world = await makeWorld(t);
  await world.attached();

  const finished = [];
  world.chrome.devtools.network.onRequestFinished.addListener((request) => finished.push(request));
  await world.observing();

  world.app.push({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "unbuffered",
      timestamp: 400,
      wallTime: 1700000400,
      type: "XHR",
      request: { url: "https://x.dev/stream", method: "GET", headers: {} },
    },
  });
  world.app.push({ method: "Network.loadingFinished", params: { requestId: "unbuffered", timestamp: 400.1, encodedDataLength: 12 } });
  await waitFor(() => finished.length > 0);

  const content = await finished[0].getContent();
  assert.deepStrictEqual(content, { content: null, encoding: null });
  assert.match(world.logs.join("\n"), /Could not retrieve response body/);
});

// ── honesty when the app cannot provide the domain ──────────────────────────
test("an app compiled without network inspection says so instead of showing fake traffic", async (t) => {
  const world = await makeWorld(t, { app: (app) => app.refuse("Network.enable", "Method not found.") });
  await world.attached();

  const finished = [];
  world.chrome.devtools.network.onRequestFinished.addListener((request) => finished.push(request));
  await waitFor(() => world.service.getStatus().enableState === "unavailable");

  const status = await world.chrome.devtools.network.getNetworkStatus();
  assert.deepStrictEqual(
    { available: status.available, reason: status.reason, requests: status.requests },
    { available: false, reason: "Network.enable: Method not found.", requests: 0 },
    "the bridge's method prefix plus the backend's own words, verbatim"
  );

  const har = await world.chrome.devtools.network.getHAR();
  assert.deepStrictEqual(har.entries, [], "an empty log, not an invented one");
  assert.strictEqual(finished.length, 0);
  assert.match(world.logs.join("\n"), /no network data/);

  // The frame learned about the refusal from a push, not only by asking: the
  // status the host sent is the one the shim reports.
  const pushed = world.deliveries
    .map((d) => d.payload || d)
    .filter((p) => p.kind === "status")
    .map((p) => p.status.enableState);
  assert.ok(pushed.includes("unavailable"), `status pushes: ${pushed.join(", ")}`);
  assert.strictEqual(
    pushed.filter((state) => state === "unavailable").length,
    1,
    "one announcement per distinct state, not one per retry"
  );
});

test("the multi-host refusal arrives as a reason, not as a thrown error", async (t) => {
  const world = await makeWorld(t, {
    app: (app) =>
      app.refuse(
        "Network.enable",
        "Network domain is not supported when there is more than one instance of React Native Host running on the device."
      ),
  });
  await world.attached();

  world.chrome.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["<all_urls>"] });
  await waitFor(() => world.service.getStatus().enableState === "unavailable");
  const status = await world.chrome.devtools.network.getNetworkStatus();
  assert.strictEqual(status.available, false);
  assert.match(status.reason, /more than one instance of React Native Host/);
});

test("a capture that goes down mid-session tells the frames instead of going quiet", async (t) => {
  const world = await makeWorld(t);
  await world.attached();
  world.chrome.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["<all_urls>"] });
  await world.observing();

  // The app's host count changes: RN broadcasts Network.disable and then refuses
  // a fresh enable (HostAgent.cpp:435 / :150).
  world.app.refuse(
    "Network.enable",
    "Network domain is not supported when there is more than one instance of React Native Host running on the device."
  );
  world.app.push({ method: "Network.disable", params: {} });
  await waitFor(() => world.service.getStatus().enableState === "unavailable");

  const pushed = world.deliveries
    .map((d) => d.payload || d)
    .filter((p) => p.kind === "status")
    .map((p) => p.status.enableState);
  assert.ok(pushed.includes("enabled") && pushed.includes("unavailable"), `pushes: ${pushed.join(", ")}`);
  assert.strictEqual(world.shim._hostStatus().available, false, "the frame knows without asking");
});

// ── session churn over the same socket ──────────────────────────────────────
test("an app reload re-arms Network.enable exactly once and captures again", async (t) => {
  const world = await makeWorld(t);
  await world.attached();
  world.chrome.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["<all_urls>"] });
  await world.observing();
  assert.strictEqual(world.app.commands("Network.enable").length, 1, "one enable per armed session");

  // Bundle reload: RN clears the JS context and stops reporting until asked again.
  world.app.push({ method: "Runtime.executionContextsCleared", params: {} });
  await waitFor(() => world.app.commands("Network.enable").length > 1);
  assert.strictEqual(world.app.commands("Network.enable").length, 2, "exactly one re-arm");
  await world.observing();

  const finished = [];
  world.chrome.devtools.network.onRequestFinished.addListener((request) => finished.push(request));
  for (const notification of graphqlExchange()) world.app.push(notification);
  await waitFor(() => finished.length > 0);
  assert.strictEqual(finished[0].response.status, 200);
});

test("onNavigated reports the debugger target, the closest thing to a navigation here", async (t) => {
  const world = await makeWorld(t);
  await world.attached();

  const navigations = [];
  world.chrome.devtools.network.onNavigated.addListener((url) => navigations.push(url));
  await world.observing();
  await settle();

  assert.ok(navigations.length >= 1, "attaching to a target is the nearest real signal");
  assert.strictEqual(navigations[0], "devtools-poc (iPhone 17 Pro)", "the target's own title, not an invented URL");

  world.app.push({ method: "Runtime.executionContextsCleared", params: {} });
  await waitFor(() => navigations.length >= 2);
});

// ── what crosses the host -> frame channel ──────────────────────────────────
test("one lifecycle step is one message, and dataReceived is not fanned out", async (t) => {
  const world = await makeWorld(t);
  await world.attached();

  world.chrome.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["<all_urls>"] });
  world.chrome.devtools.network.onRequestFinished.addListener(() => {});
  await world.observing();

  for (const notification of graphqlExchange()) world.app.push(notification);
  await waitFor(() => world.networkSteps().some((step) => step.kind === "completed"));

  assert.deepStrictEqual(world.networkSteps().map((step) => step.kind), [
    "request",
    "sendHeaders",
    "response",
    "completed",
  ]);
  const steps = world.networkSteps();
  assert.strictEqual(steps.filter((step) => step.entry === undefined).length, 3, "only a settled record has a HAR entry");
  assert.ok(steps.every((step) => step.record && step.record.requestId === "fetch-1"));
  assert.deepStrictEqual(steps[0].record.webRequestType, "xmlhttprequest");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(steps.at(-1).entry)).response.status,
    200,
    "the HAR entry survives structured cloning, as it must over IPC"
  );
});

test("a frame that never asks for network data costs the app no CDP traffic", async (t) => {
  const world = await makeWorld(t);
  await world.attached();
  await settle();

  assert.deepStrictEqual(world.app.commands("Network.enable"), [], "the domain is lazy, not eager");
  assert.strictEqual(world.service.subscriberCount(), 0, "no listener, no subscription");
  assert.strictEqual(world.service.getStatus().enableState, "idle");
});
