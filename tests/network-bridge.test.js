// chrome.devtools.network + chrome.webRequest as extension frames see them
// (src/chrome-shim/network-bridge.js): host deliveries fan out to both APIs,
// Chrome's Event/listener semantics hold, bodies are fetched lazily with the
// backend's base64 flag, and every unavailable path stays visibly unavailable.
//
// Pure tests: the host calls are fakes and deliveries are pushed in through
// handleDelivery(), so no Electron and no IPC. The real socket path is
// tests/network-end-to-end.test.js.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createNetworkBridge } = require("../src/chrome-shim/network-bridge");
const { createChromeNamespace } = require("../src/chrome-shim");
const { createMemoryBackend, createExtensionStorage } = require("../src/chrome-shim/storage");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A finished GraphQL POST record, as the host serialises it. */
const record = (over = {}) => ({
  requestId: "1",
  status: "finished",
  url: "https://countries.trevorblades.com/",
  method: "POST",
  resourceType: "XHR",
  webRequestType: "xmlhttprequest",
  mimeType: "application/json",
  protocol: "HTTP/1.1",
  documentURL: "mobile",
  initiator: { type: "script" },
  requestHeaders: [{ name: "content-type", value: "application/json" }],
  responseHeaders: [{ name: "content-type", value: "application/json" }],
  postData: '{"query":"{ country(code: \\"BR\\") { name } }"}',
  queryString: [],
  responseStatus: 200,
  statusText: "OK",
  redirects: [],
  timestamp: 100,
  wallTime: 1699975911.862162,
  responseTimestamp: 100.25,
  finishedTimestamp: 100.5,
  dataLength: 120,
  encodedDataLength: 300,
  fromCache: false,
  ...over,
});

const entry = (over = {}) => ({
  startedDateTime: "2023-11-14T22:11:51.862Z",
  time: 500,
  request: { method: "POST", url: "https://countries.trevorblades.com/", queryString: [], headers: [] },
  response: { status: 200, statusText: "OK", content: { size: 120, mimeType: "application/json" } },
  _resourceType: "xhr",
  _requestId: "1",
  ...over,
});

/** The five deliveries one finished request produces. */
const finishedSequence = (rec = record()) => [
  { kind: "request", record: { ...rec, status: "pending" }, redirect: null },
  { kind: "sendHeaders", record: { ...rec, status: "pending" } },
  { kind: "response", record: { ...rec, status: "pending" }, redirect: null },
  { kind: "completed", record: rec, entry: entry() },
];

const makeBridge = (options = {}) => {
  const warnings = [];
  const calls = { subscribe: 0, status: 0, har: 0, body: [] };
  const logger = { warn: (message) => warnings.push(message), log: () => {}, error: () => {} };
  const bridge = createNetworkBridge({
    logger,
    subscribe: () => {
      calls.subscribe += 1;
      return Promise.resolve(options.status ?? { available: true, observing: true, enableState: "enabled", reason: null, requests: 1 });
    },
    getNetworkStatus: () => {
      calls.status += 1;
      return Promise.resolve(options.status ?? { available: true, observing: true, enableState: "enabled", reason: null, requests: 1 });
    },
    fetchHar: (opts) => {
      calls.har += 1;
      return Promise.resolve(options.har ?? { log: { version: "1.2", entries: [entry()] } });
    },
    fetchBody: (requestId) => {
      calls.body.push(requestId);
      return Promise.resolve(
        options.body ?? { available: true, body: '{"data":{"country":{"name":"Brazil"}}}', base64Encoded: false }
      );
    },
    ...options.deps,
  });
  return { bridge, warnings, calls };
};

// ── one capture, two APIs ────────────────────────────────────────────────────
test("one request's deliveries reach devtools.network and webRequest alike", async () => {
  const { bridge } = makeBridge();
  const seen = [];
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onResponseStarted", "onCompleted"]) {
    bridge.webRequest[name].addListener((details) => seen.push([name, details.requestId]));
  }
  let request = null;
  bridge.network.onRequestFinished.addListener((req) => {
    request = req;
  });

  for (const delivery of finishedSequence()) bridge.handleDelivery(delivery);
  await tick();

  assert.deepStrictEqual(
    seen.map(([name]) => name),
    ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onResponseStarted", "onCompleted"]
  );
  assert.ok(request, "onRequestFinished fired once");
  assert.strictEqual(request.requestId, "1");
  assert.strictEqual(request.response.status, 200);
});

test("webRequest details carry the real URL, method, type and headers", async () => {
  const { bridge } = makeBridge();
  const seen = [];
  bridge.webRequest.onBeforeRequest.addListener((details) => seen.push(details));
  for (const delivery of finishedSequence()) bridge.handleDelivery(delivery);
  await tick();

  const details = seen[0];
  assert.strictEqual(details.url, "https://countries.trevorblades.com/");
  assert.strictEqual(details.method, "POST");
  assert.strictEqual(details.type, "xmlhttprequest", "CDP XHR -> Chrome's xmlhttprequest");
  assert.strictEqual(details.tabId, -1);
  assert.deepStrictEqual(details.requestHeaders, [
    { name: "content-type", value: "application/json" },
  ]);
  assert.strictEqual(new TextDecoder().decode(details.requestBody.raw[0].bytes), '{"query":"{ country(code: \\"BR\\") { name } }"}');
});

test("onCompleted gets the status, onErrorOccurred the backend's reason", async () => {
  const { bridge } = makeBridge();
  const completed = [];
  const errors = [];
  bridge.webRequest.onCompleted.addListener((details) => completed.push(details));
  bridge.webRequest.onErrorOccurred.addListener((details) => errors.push(details));

  for (const delivery of finishedSequence()) bridge.handleDelivery(delivery);
  bridge.handleDelivery({
    kind: "error",
    record: { ...record(), status: "failed", failure: { errorText: "net::ERR_FAILED", canceled: false } },
  });
  await tick();

  assert.strictEqual(completed[0].statusCode, 200);
  assert.strictEqual(completed[0].statusLine, "HTTP/1.1 200 OK");
  assert.strictEqual(errors[0].error, "net::ERR_FAILED");
});

test("an aborted request is reported as canceled, the way Chrome spells it", async () => {
  const { bridge } = makeBridge();
  const errors = [];
  bridge.webRequest.onErrorOccurred.addListener((details) => errors.push(details));
  bridge.handleDelivery({ kind: "request", record: record(), redirect: null });
  bridge.handleDelivery({
    kind: "error",
    record: { ...record(), status: "failed", failure: { errorText: "net::ERR_ABORTED", canceled: true } },
  });
  await tick();
  assert.strictEqual(errors[0].canceled, true);
  assert.strictEqual(errors[0].error, undefined);
});

test("a 3xx response arrives as onBeforeRedirect, not onResponseStarted", async () => {
  const { bridge } = makeBridge();
  const started = [];
  const redirects = [];
  bridge.webRequest.onResponseStarted.addListener((d) => started.push(d));
  bridge.webRequest.onBeforeRedirect.addListener((d) => redirects.push(d));
  bridge.handleDelivery({ kind: "request", record: record(), redirect: null });
  bridge.handleDelivery({
    kind: "response",
    record: { ...record(), responseStatus: 302, redirects: [{ url: "https://x.dev/moved", status: 302 }] },
  });
  await tick();
  assert.strictEqual(started.length, 0);
  assert.strictEqual(redirects[0].redirectUrl, "https://x.dev/moved");
});

test("onBeforeRedirect describes the 3xx hop, not the hop that has not happened", async () => {
  const { bridge } = makeBridge();
  const redirects = [];
  bridge.webRequest.onBeforeRedirect.addListener((d) => redirects.push(d));
  bridge.handleDelivery({
    kind: "request",
    record: { ...record(), status: "pending", url: "https://x.dev/long" },
    redirect: {
      url: "https://x.dev/long",
      fromUrl: "https://x.dev/short",
      status: 302,
      statusText: "Found",
      headers: [{ name: "location", value: "https://x.dev/long" }],
    },
  });
  await tick();

  assert.strictEqual(redirects.length, 1);
  assert.strictEqual(redirects[0].url, "https://x.dev/short", "the URL that answered 3xx");
  assert.strictEqual(redirects[0].statusCode, 302);
  assert.strictEqual(redirects[0].statusLine, "HTTP/1.1 302 Found");
  assert.strictEqual(redirects[0].redirectUrl, "https://x.dev/long");
  assert.deepStrictEqual(redirects[0].responseHeaders, [{ name: "location", value: "https://x.dev/long" }]);
});

test("URL filters are honoured, and the wrong type never reaches a listener", async () => {
  const { bridge } = makeBridge();
  const all = [];
  const graphql = [];
  const scripts = [];
  bridge.webRequest.onBeforeRequest.addListener((d) => all.push(d), { urls: ["<all_urls>"] });
  bridge.webRequest.onBeforeRequest.addListener((d) => graphql.push(d), {
    urls: ["https://countries.trevorblades.com/*"],
    types: ["xmlhttprequest"],
  }, ["requestBody"]);
  bridge.webRequest.onBeforeRequest.addListener((d) => scripts.push(d), { types: ["script"] });

  for (const delivery of finishedSequence()) bridge.handleDelivery(delivery);
  bridge.handleDelivery({
    kind: "request",
    record: record({ requestId: "2", url: "https://x.dev/bundle.js", resourceType: "Script", webRequestType: "script" }),
    redirect: null,
  });
  await tick();

  assert.deepStrictEqual(all.map((d) => d.requestId), ["1", "2"]);
  assert.deepStrictEqual(graphql.map((d) => d.requestId), ["1"], "the URL+type filter selected it");
  assert.deepStrictEqual(scripts.map((d) => d.requestId), ["2"], "a script listener never sees an XHR");
});

test("blocking intent is reported once instead of being silently ignored", async () => {
  const { bridge, warnings } = makeBridge();
  const noop = () => {};
  bridge.webRequest.onBeforeRequest.addListener(noop, { urls: ["<all_urls>"] }, ["blocking", "requestBody"]);
  bridge.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["<all_urls>"] }, ["blocking"]);
  await tick();
  const note = warnings.filter((message) => /observe-only/.test(message));
  assert.strictEqual(note.length, 1, "one honest note, not one per listener");
  assert.match(note[0], /never block, cancel or rewrite/);
});

test("the read-only hints this host does answer do not trigger a warning", async () => {
  const { bridge, warnings } = makeBridge();
  bridge.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["<all_urls>"] }, ["requestBody"]);
  bridge.webRequest.onSendHeaders.addListener(() => {}, { urls: ["<all_urls>"] }, ["responseHeaders"]);
  await tick();
  assert.deepStrictEqual(warnings.filter((message) => /observe-only/.test(message)), []);
});

test("the two events RN cannot produce stay quiet but remain registrable", async () => {
  const { bridge } = makeBridge();
  let fired = 0;
  const listener = () => fired++;
  bridge.webRequest.onHeadersReceived.addListener(listener);
  bridge.webRequest.onAuthRequired.addListener(listener);
  for (const delivery of finishedSequence()) bridge.handleDelivery(delivery);
  await tick();
  assert.strictEqual(fired, 0);
  assert.strictEqual(bridge.webRequest.onHeadersReceived.hasListener(listener), true);
  bridge.webRequest.onHeadersReceived.removeListener(listener);
  assert.strictEqual(bridge.webRequest.onHeadersReceived.hasListener(listener), false);
});

// ── Chrome's Event contract ──────────────────────────────────────────────────
test("listener semantics: dedupe by identity, removal, hasListener(s)", async () => {
  const { bridge } = makeBridge();
  const seen = [];
  const listener = (details) => seen.push(details.requestId);

  bridge.webRequest.onBeforeRequest.addListener(listener);
  bridge.webRequest.onBeforeRequest.addListener(listener); // same function object
  assert.strictEqual(bridge.webRequest.onBeforeRequest.hasListeners(), true);
  bridge.handleDelivery({ kind: "request", record: record(), redirect: null });
  await tick();
  assert.deepStrictEqual(seen, ["1"], "Chrome ignores a duplicate registration");

  bridge.webRequest.onBeforeRequest.removeListener(listener);
  assert.strictEqual(bridge.webRequest.onBeforeRequest.hasListener(listener), false);
  bridge.handleDelivery({ kind: "request", record: record(), redirect: null });
  await tick();
  assert.deepStrictEqual(seen, ["1"], "removal is by identity");
});

test("onRequestFinished gets a Request with lazy getContent (promise + callback)", async () => {
  const { bridge, calls } = makeBridge();
  const request = await new Promise((resolve) => {
    bridge.network.onRequestFinished.addListener(resolve);
    bridge.handleDelivery({ kind: "completed", record: record(), entry: entry() });
  });

  const viaPromise = await request.getContent();
  assert.strictEqual(viaPromise.content, '{"data":{"country":{"name":"Brazil"}}}');
  assert.strictEqual(viaPromise.encoding, null, "the backend said plain text");

  const viaCallback = await new Promise((resolve) =>
    request.getContent((content, encoding) => resolve([content, encoding]))
  );
  assert.strictEqual(viaCallback[0], '{"data":{"country":{"name":"Brazil"}}}');
  assert.strictEqual(viaCallback[1], null);
  assert.deepStrictEqual(calls.body, ["1", "1"], "one CDP lookup per call, nothing cached as a guess");
});

test("a base64 body is reported with its encoding, not decoded on a hunch", async () => {
  const { bridge } = makeBridge({ body: { available: true, body: "eyJhIjoxfQ==", base64Encoded: true } });
  const request = await new Promise((resolve) => {
    bridge.network.onRequestFinished.addListener(resolve);
    bridge.handleDelivery({ kind: "completed", record: record(), entry: entry() });
  });
  const result = await request.getContent();
  assert.strictEqual(result.content, "eyJhIjoxfQ==", "the bytes as the backend gave them");
  assert.strictEqual(result.encoding, "base64");
});

test("no body available means null content plus the backend's reason — never a stub", async () => {
  const { bridge, warnings } = makeBridge({
    deps: {
      fetchBody: () =>
        Promise.resolve({
          available: false,
          error: 'Network.getResponseBody: Internal error: Could not retrieve response body for the given requestId.',
        }),
    },
  });
  const request = await new Promise((resolve) => {
    bridge.network.onRequestFinished.addListener(resolve);
    bridge.handleDelivery({ kind: "completed", record: record(), entry: entry() });
  });
  const result = await request.getContent();
  assert.strictEqual(result.content, null);
  assert.strictEqual(result.encoding, null);
  assert.match(warnings.at(-1), /Could not retrieve response body/);

  const viaCallback = await new Promise((resolve) =>
    request.getContent((content, encoding) => resolve([content, encoding]))
  );
  assert.deepStrictEqual(viaCallback, [null, null]);
});

test("getRequestContent is Chrome's alias and callback style returns nothing", async () => {
  const { bridge } = makeBridge();
  const request = await new Promise((resolve) => {
    bridge.network.onRequestFinished.addListener(resolve);
    bridge.handleDelivery({ kind: "completed", record: record(), entry: entry() });
  });
  assert.strictEqual(typeof request.getRequestContent, "function");
  assert.strictEqual(request.getContent(() => {}), undefined, "callback style returns nothing");
  assert.ok(request.getContent() instanceof Promise);
});

test("failed requests fire onRequestFinished too, entry and all", async () => {
  const { bridge } = makeBridge();
  const failedEntry = entry({ response: { status: -1, statusText: "", content: { size: -1 } }, _failure: { errorText: "net::ERR_FAILED", canceled: false } });
  const request = await new Promise((resolve) => {
    bridge.network.onRequestFinished.addListener(resolve);
    bridge.handleDelivery({
      kind: "error",
      record: { ...record(), status: "failed", failure: { errorText: "net::ERR_FAILED", canceled: false } },
      entry: failedEntry,
    });
  });
  assert.strictEqual(request.response.status, -1);
  assert.deepStrictEqual(request._failure, { errorText: "net::ERR_FAILED", canceled: false });
});

// ── getHAR ───────────────────────────────────────────────────────────────────
test("getHAR returns the real log, with entries addressable both ways", async () => {
  const { bridge } = makeBridge();
  const har = await bridge.network.getHAR();
  assert.strictEqual(har.version, "1.2");
  assert.strictEqual(har.entries.length, 1);
  assert.strictEqual(har.log.entries.length, 1, "harLog.entries, as Chrome's docs spell it");
  assert.strictEqual(typeof har.entries[0].getContent, "function", "entries are Requests");
});

test("getHAR callback style gets the same log and returns nothing", async () => {
  const { bridge, calls } = makeBridge();
  const returned = bridge.network.getHAR((harLog) => {
    assert.strictEqual(harLog.log.entries[0].request.url, "https://countries.trevorblades.com/");
  });
  assert.strictEqual(returned, undefined);
  await tick();
  assert.strictEqual(calls.har, 1);
});

test("getHAR subscribes lazily: the first read is what asks the host for data", async () => {
  const { bridge, calls } = makeBridge();
  assert.strictEqual(calls.subscribe, 0, "constructing the API asks for nothing");
  await bridge.network.getHAR();
  assert.strictEqual(calls.subscribe, 1);
  await bridge.network.getHAR();
  assert.strictEqual(calls.subscribe, 1, "and it happens once per frame");
});

test("panels.network.getHAR is the same HAR, and the empty answer is still valid", async () => {
  const { createDevtools } = require("../src/chrome-shim/devtools");
  const { bridge } = makeBridge();
  const { namespace } = createDevtools({
    extensionId: "graphql",
    evalInPage: undefined,
    reloadInPage: async () => ({ ok: true }),
    networkApi: bridge.network,
  });

  const har = await namespace.panels.network.getHAR();
  assert.strictEqual(har.log.entries.length, 1);

  const withoutHost = createDevtools({ extensionId: "graphql" }).namespace;
  const empty = await withoutHost.panels.network.getHAR();
  assert.strictEqual(empty.log.version, "1.2");
  assert.deepStrictEqual(empty.log.entries, []);
});

test("a host that cannot answer getHAR yields an empty log, not an invented one", async () => {
  const { bridge, warnings } = makeBridge({
    deps: { fetchHar: () => Promise.reject(new Error("network.getHAR: unauthorized call")) },
  });
  const har = await bridge.network.getHAR();
  assert.deepStrictEqual(har.entries, []);
  assert.match(warnings.join("\n"), /unauthorized call/);
});

// ── honest degradation ───────────────────────────────────────────────────────
test("getNetworkStatus exposes why the list is empty (multi-host app)", async () => {
  const { bridge, warnings } = makeBridge({
    status: {
      available: false,
      observing: true,
      enableState: "unavailable",
      reason: "Network.enable: The Network domain is unavailable when multiple React Native hosts are registered.",
      requests: 0,
    },
  });
  const status = await bridge.network.getNetworkStatus();
  assert.strictEqual(status.available, false);
  assert.match(status.reason, /multiple React Native hosts/);

  let cbStatus = null;
  const returned = bridge.network.getNetworkStatus((value) => {
    cbStatus = value;
  });
  assert.strictEqual(returned, undefined, "promise and callback styles both work");
  await tick();
  assert.strictEqual(cbStatus.available, false);

  // The console note happens once, and only because data is genuinely unavailable.
  const notes = warnings.filter((message) => /no network data from the inspected app/.test(message));
  assert.strictEqual(notes.length, 1);
  await bridge.network.getNetworkStatus();
  await bridge.network.getNetworkStatus();
  assert.strictEqual(
    warnings.filter((message) => /no network data from the inspected app/.test(message)).length,
    1
  );
});

test("an available capture does not whine about missing data", async () => {
  const { bridge, warnings } = makeBridge();
  await bridge.network.getNetworkStatus();
  assert.strictEqual(
    warnings.filter((message) => /no network data/.test(message)).length,
    0
  );
});

test("a status push from the host is remembered and reported once", async () => {
  const { bridge, warnings } = makeBridge({
    deps: {
      getNetworkStatus: () =>
        Promise.resolve({ available: true, observing: true, enableState: "enabled", reason: null, requests: 0 }),
    },
  });
  bridge.handleDelivery({
    kind: "status",
    status: { available: false, observing: true, enableState: "unavailable", reason: "flag off", requests: 0 },
  });
  assert.strictEqual(bridge._hostStatus().available, false);
  assert.strictEqual(warnings.filter((m) => /no network data/.test(m)).length, 1);
});

test("onNavigated fires from the host's session-change signal", async () => {
  const { bridge } = makeBridge();
  const urls = [];
  bridge.network.onNavigated.addListener((url) => urls.push(url));
  bridge.handleDelivery({ kind: "navigated", url: "devtools-poc (iPhone 17 Pro)" });
  bridge.handleDelivery({ kind: "navigated", url: "" });
  await tick();
  assert.deepStrictEqual(urls, ["devtools-poc (iPhone 17 Pro)", ""]);
});

test("junk deliveries are ignored rather than thrown at listeners", async () => {
  const { bridge } = makeBridge();
  let fired = 0;
  bridge.network.onRequestFinished.addListener(() => fired++);
  bridge.webRequest.onBeforeRequest.addListener(() => fired++);
  for (const junk of [undefined, null, {}, "Events", { kind: 42 }, { kind: "completed" }]) {
    assert.doesNotThrow(() => bridge.handleDelivery(junk));
  }
  await tick();
  assert.strictEqual(fired, 0);
});

test("registering a listener is what subscribes the frame (webRequest too)", async () => {
  const { bridge, calls } = makeBridge();
  bridge.webRequest.onCompleted.addListener(() => {});
  await tick();
  assert.strictEqual(calls.subscribe, 1);
  bridge.network.onRequestFinished.addListener(() => {});
  await tick();
  assert.strictEqual(calls.subscribe, 1, "still one subscribe for the frame");
});

// ── namespace assembly ───────────────────────────────────────────────────────
test("the chrome namespace wires webRequest and devtools.network to one bridge", async () => {
  const { bridge } = makeBridge();
  const chrome = createChromeNamespace({
    extensionId: "graphql",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: bridge,
  });

  assert.ok(chrome.webRequest.onBeforeRequest, "webRequest present");
  // The panel gets the bridge's members; the shell only fills in honesty defaults
  // for anything the bridge does not implement, so the objects are not identical.
  for (const member of ["onRequestFinished", "onNavigated", "getHAR"]) {
    assert.strictEqual(chrome.devtools.network[member], bridge.network[member], "same capture, one bridge");
  }
  assert.strictEqual(typeof chrome.devtools.panels.network.getHAR, "function");

  const seen = [];
  chrome.devtools.network.onRequestFinished.addListener((req) => seen.push(req.requestId));
  bridge.handleDelivery({ kind: "completed", record: record(), entry: entry() });
  await tick();
  assert.deepStrictEqual(seen, ["1"]);

  // Without a host behind it the shapes still answer, honestly.
  const bare = createChromeNamespace({
    extensionId: "altair",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: createNetworkBridge({ logger: { warn: () => {} } }),
  });
  const har = await bare.devtools.network.getHAR();
  assert.deepStrictEqual(har.log.entries, []);
});
