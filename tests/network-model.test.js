// The CDP -> network-model mapping (src/main/network-model.js): CDP event
// sequences become request records, records become HAR 1.2 entries, the buffer
// stays bounded, bodies are fetched lazily with the backend's own base64 flag, and
// every failure path reports "no data" instead of inventing one.
//
// Pure tests: sendCommand/onEvent are fakes, so no socket and no Electron. The
// live round-trip over a real WebSocket is tests/network-service.test.js.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const {
  createNetworkModel,
  resourceTypeFromMime,
  headerListToPairs,
  queryStringFrom,
  contentTypeOf,
  byteLength,
} = require("../src/main/network-model");

/** A model with a scripted command sender. */
const makeModel = ({ commands = {}, ...rest } = {}) => {
  const sent = [];
  const observed = [];
  const warnings = [];
  const sendCommand = async (method, params) => {
    sent.push({ method, params });
    const handler = commands[method];
    if (!handler) {
      const error = new Error(`${method}: Method not found.`);
      throw error;
    }
    return handler(params);
  };
  const model = createNetworkModel({
    sendCommand,
    onEvent: () => () => {},
    onObserved: (record, event, extra) => observed.push({ record, event, extra }),
    log: (level, message) => warnings.push({ level, message }),
    ...rest,
  });
  return { model, sent, observed, warnings };
};

/** The notification sequence RN's NetworkHandler emits for one JSON POST. */
const jsonPostSequence = (over = {}) => [
  ["Network.requestWillBeSent", {
    requestId: "1",
    loaderId: "",
    documentURL: "mobile",
    request: {
      url: "https://countries.trevorblades.com/",
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "RN" },
      postData: '{"query":"{ country(code: \\"BR\\") { name } }"}',
    },
    timestamp: 100,
    wallTime: 1699975911.862162,
    initiator: { type: "script" },
    redirectHasExtraInfo: false,
  }],
  ["Network.requestWillBeSentExtraInfo", {
    requestId: "1",
    headers: { "content-type": "application/json", "content-length": "45" },
    connectTiming: { requestTime: 100 },
  }],
  ["Network.responseReceived", {
    requestId: "1",
    loaderId: "",
    timestamp: 100.25,
    type: "XHR",
    response: {
      url: "https://countries.trevorblades.com/",
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      mimeType: "application/json",
      encodedDataLength: 300,
    },
    hasExtraInfo: false,
  }],
  ["Network.dataReceived", { requestId: "1", timestamp: 100.3, dataLength: 120, encodedDataLength: 140 }],
  ["Network.loadingFinished", { requestId: "1", timestamp: 100.5, encodedDataLength: 300 }],
];

const feed = (model, sequence) => {
  for (const [method, params] of sequence) model.feed(method, params);
};

// ── record accumulation ──────────────────────────────────────────────────────
test("a CDP event sequence accumulates one real request record", () => {
  const { model, observed } = makeModel();
  feed(model, jsonPostSequence());

  const record = model.get("1");
  assert.ok(record, "the request is tracked by CDP requestId");
  assert.strictEqual(record.status, "finished");
  assert.strictEqual(record.url, "https://countries.trevorblades.com/");
  assert.strictEqual(record.method, "POST");
  assert.strictEqual(record.responseStatus, 200);
  assert.strictEqual(record.mimeType, "application/json");
  assert.strictEqual(record.resourceType, "XHR");
  assert.strictEqual(record.dataLength, 120);
  assert.strictEqual(record.encodedDataLength, 300, "the finish notification's total wins");
  assert.strictEqual(record.redirects.length, 0);

  assert.deepStrictEqual(
    observed.map((entry) => entry.event),
    ["request", "sendHeaders", "response", "data", "completed"],
    "every lifecycle step is announced once"
  );
});

test("requestWillBeSentExtraInfo replaces the headers actually put on the wire", () => {
  const { model } = makeModel();
  feed(model, jsonPostSequence());
  assert.deepStrictEqual(
    model.get("1").requestHeaders.map((header) => header.name),
    ["content-type", "content-length"],
    "the real wire headers win over the announced ones"
  );
});

test("headers survive when the backend never sends the extra-info notification", () => {
  const { model } = makeModel();
  feed(
    model,
    jsonPostSequence().filter(([method]) => method !== "Network.requestWillBeSentExtraInfo")
  );
  assert.deepStrictEqual(
    model.get("1").requestHeaders.map((header) => header.name),
    ["content-type", "user-agent"]
  );
});

test("a failure records the backend's error text and stays answerable", () => {
  const { model, observed } = makeModel();
  model.feed("Network.requestWillBeSent", {
    requestId: "9",
    request: { url: "https://x.dev/gone", method: "GET", headers: {} },
    timestamp: 5,
    wallTime: 1700000000,
  });
  model.feed("Network.loadingFailed", {
    requestId: "9",
    timestamp: 5.1,
    type: "XHR",
    errorText: "net::ERR_FAILED",
    canceled: false,
  });
  const record = model.get("9");
  assert.strictEqual(record.status, "failed");
  assert.strictEqual(record.failure.errorText, "net::ERR_FAILED");
  assert.strictEqual(record.failure.canceled, false);
  assert.strictEqual(observed.at(-1).event, "error");
  assert.strictEqual(model.get("9").responseStatus, 0, "no response was ever reported");
});

test("an aborted load keeps canceled:true (webRequest maps it, not error)", () => {
  const { model } = makeModel();
  model.feed("Network.requestWillBeSent", {
    requestId: "a",
    request: { url: "https://x.dev/slow", method: "GET", headers: {} },
    timestamp: 1,
    wallTime: 1700000000,
  });
  model.feed("Network.loadingFailed", {
    requestId: "a",
    timestamp: 2,
    type: "XHR",
    errorText: "net::ERR_ABORTED",
    canceled: true,
  });
  assert.strictEqual(model.get("a").failure.canceled, true);
});

test("a redirect re-announcement keeps one record and records the chain", () => {
  const { model, observed } = makeModel();
  model.feed("Network.requestWillBeSent", {
    requestId: "r",
    request: { url: "https://x.dev/short", method: "GET", headers: { a: "1" } },
    timestamp: 1,
    wallTime: 1700000000,
  });
  model.feed("Network.responseReceived", {
    requestId: "r",
    timestamp: 1.1,
    type: "Document",
    response: { url: "https://x.dev/short", status: 302, statusText: "Found", headers: { location: "https://x.dev/long" }, mimeType: "text/html" },
  });
  model.feed("Network.requestWillBeSent", {
    requestId: "r",
    request: { url: "https://x.dev/long", method: "GET", headers: { a: "1" } },
    redirectResponse: { url: "https://x.dev/short", status: 302, statusText: "Found", headers: {} },
    timestamp: 1.2,
    wallTime: 1700000000,
  });
  model.feed("Network.loadingFinished", { requestId: "r", timestamp: 1.5, encodedDataLength: 900 });

  const record = model.get("r");
  assert.strictEqual(record.url, "https://x.dev/long", "the final URL describes the request");
  assert.strictEqual(record.redirects.length, 1);
  assert.strictEqual(record.redirects[0].status, 302);
  assert.strictEqual(model.list().length, 1, "one record, not two");
  assert.deepStrictEqual(
    observed
      .filter((entry) => entry.event === "request")
      .map((entry) => (entry.extra.redirect ? entry.extra.redirect.status : null)),
    [null, 302],
    "the redirect step is visible to observers"
  );
});

test("a response with no preceding request is ignored, not invented into a record", () => {
  const { model } = makeModel();
  model.feed("Network.responseReceived", { requestId: "ghost", response: { status: 200 } });
  model.feed("Network.loadingFinished", { requestId: "ghost", timestamp: 1, encodedDataLength: 1 });
  assert.strictEqual(model.get("ghost"), null);
  assert.deepStrictEqual(model.list(), []);
});

test("a duplicate loadingFinished does not double-count a request", () => {
  const { model, observed } = makeModel();
  feed(model, jsonPostSequence());
  model.feed("Network.loadingFinished", { requestId: "1", timestamp: 100.9, encodedDataLength: 300 });
  assert.deepStrictEqual(
    observed.filter((entry) => entry.event === "completed").length,
    1
  );
});

// ── HAR 1.2 ──────────────────────────────────────────────────────────────────
test("the finished record becomes a HAR 1.2 entry with the real values", () => {
  const { model } = makeModel();
  feed(model, jsonPostSequence());
  const entry = model.toHarEntry(model.get("1"));

  assert.strictEqual(entry.startedDateTime, new Date(1699975911.862162 * 1000).toISOString());
  assert.strictEqual(entry.time, 500);
  assert.strictEqual(entry.request.method, "POST");
  assert.strictEqual(entry.request.url, "https://countries.trevorblades.com/");
  assert.deepStrictEqual(entry.request.queryString, []);
  assert.strictEqual(entry.request.postData.mimeType, "application/json");
  assert.match(entry.request.postData.text, /^{"query"/);
  assert.strictEqual(entry.response.status, 200);
  assert.strictEqual(entry.response.content.mimeType, "application/json");
  assert.strictEqual(entry.response.content.size, 120);
  assert.strictEqual(entry._resourceType, "xhr");
  assert.strictEqual(entry._transferSize, 300);
  assert.deepStrictEqual(entry._initiator, { type: "script" });
  assert.strictEqual(entry._requestId, "1", "the fork's own API keys bodies off this");
  assert.strictEqual(entry.response.content.text, undefined, "HAR carries no body (Chrome's rule)");
});

test("getHAR builds a real HAR 1.2 log with pages and entries", () => {
  const { model } = makeModel();
  feed(model, jsonPostSequence());
  const har = model.buildHar();

  assert.strictEqual(har.log.version, "1.2");
  assert.strictEqual(har.log.creator.name, "rozenite-shell");
  assert.ok(har.log.browser.name, "HAR 1.2 requires browser");
  assert.strictEqual(har.log.pages.length, 1);
  assert.strictEqual(har.log.entries.length, 1);
  assert.strictEqual(har.log.entries[0].response.status, 200);
});

test("getHAR's urlFilter narrows entries the way panels.network.getHAR uses it", () => {
  const { model } = makeModel();
  feed(model, jsonPostSequence());
  model.feed("Network.requestWillBeSent", {
    requestId: "2",
    request: { url: "https://jsonplaceholder.typicode.com/todos?_limit=5", method: "GET", headers: {} },
    timestamp: 101,
    wallTime: 1699975920,
  });
  model.feed("Network.loadingFinished", { requestId: "2", timestamp: 101.5, encodedDataLength: 500 });

  assert.strictEqual(model.buildHar().log.entries.length, 2);
  const filtered = model.buildHar({ urlFilter: "jsonplaceholder" });
  assert.strictEqual(filtered.log.entries.length, 1);
  assert.match(filtered.log.entries[0].request.url, /jsonplaceholder/);
});

test("queryString is parsed for GETs, and headersSize/timings say -1 when unknown", () => {
  const { model } = makeModel();
  model.feed("Network.requestWillBeSent", {
    requestId: "g",
    request: { url: "https://api.dev/todos?_limit=5&title=a%20b", method: "GET", headers: {} },
    timestamp: 3,
    wallTime: 1700000000,
  });
  model.feed("Network.loadingFinished", { requestId: "g", timestamp: 3.25, encodedDataLength: 42 });
  const entry = model.toHarEntry(model.get("g"));

  assert.deepStrictEqual(entry.request.queryString, [
    { name: "_limit", value: "5" },
    { name: "title", value: "a b" },
  ]);
  assert.strictEqual(entry.request.headersSize, -1, "CDP never reported it");
  assert.strictEqual(entry.request.bodySize, 0, "GET has no body");
  assert.deepStrictEqual(entry.timings, {
    blocked: -1,
    dns: -1,
    ssl: -1,
    connect: -1,
    send: 0,
    wait: -1,
    receive: -1,
  });
  assert.strictEqual(entry._transferSize, 42);
});

test("an in-flight request appears in the HAR with status -1, not a made-up 200", () => {
  const { model } = makeModel();
  model.feed("Network.requestWillBeSent", {
    requestId: "p",
    request: { url: "https://x.dev/pending", method: "GET", headers: {} },
    timestamp: 3,
    wallTime: 1700000000,
  });
  const entry = model.toHarEntry(model.get("p"));
  assert.strictEqual(entry.response.status, -1);
  assert.strictEqual(entry.time, -1);
  assert.strictEqual(entry.response.content.size, -1, "no dataReceived yet == unknown size");
});

test("a failed request's entry reports the failure instead of a status", () => {
  const { model } = makeModel();
  model.feed("Network.requestWillBeSent", {
    requestId: "f",
    request: { url: "https://x.dev/boom", method: "GET", headers: {} },
    timestamp: 1,
    wallTime: 1700000000,
  });
  model.feed("Network.loadingFailed", {
    requestId: "f",
    timestamp: 1.5,
    type: "XHR",
    errorText: "net::ERR_FAILED",
    canceled: false,
  });
  const entry = model.toHarEntry(model.get("f"));
  assert.strictEqual(entry.response.status, -1);
  assert.deepStrictEqual(entry._failure, { errorText: "net::ERR_FAILED", canceled: false });
});

test("a redirect chain lands in HAR as redirectURL + _redirects", () => {
  const { model } = makeModel();
  model.feed("Network.requestWillBeSent", {
    requestId: "h",
    request: { url: "https://x.dev/1", method: "GET", headers: {} },
    timestamp: 1,
    wallTime: 1700000000,
  });
  model.feed("Network.requestWillBeSent", {
    requestId: "h",
    request: { url: "https://x.dev/2", method: "GET", headers: {} },
    redirectResponse: { url: "https://x.dev/1", status: 301, statusText: "", headers: {} },
    timestamp: 1.1,
    wallTime: 1700000000,
  });
  model.feed("Network.loadingFinished", { requestId: "h", timestamp: 1.2, encodedDataLength: 10 });
  const entry = model.toHarEntry(model.get("h"));
  assert.strictEqual(entry.response.redirectURL, "https://x.dev/2");
  assert.deepStrictEqual(entry._redirects, [301]);
});

// ── bounded buffer ───────────────────────────────────────────────────────────
test("the buffer is bounded and evicts the oldest settled request", () => {
  const { model } = makeModel({ maxEntries: 3 });
  for (let i = 1; i <= 6; i++) {
    model.feed("Network.requestWillBeSent", {
      requestId: String(i),
      request: { url: `https://x.dev/${i}`, method: "GET", headers: {} },
      timestamp: i,
      wallTime: 1700000000 + i,
    });
    model.feed("Network.loadingFinished", { requestId: String(i), timestamp: i + 1, encodedDataLength: 1 });
  }
  const ids = model.list().map((record) => record.requestId);
  assert.deepStrictEqual(ids, ["4", "5", "6"], "oldest finished records fall out first");
  assert.strictEqual(model.get("1"), null);
  assert.strictEqual(model.maxEntries, 3);
});

test("an in-flight request is never evicted: the cap holds the settled ones", () => {
  const { model } = makeModel({ maxEntries: 2 });
  model.feed("Network.requestWillBeSent", {
    requestId: "slow",
    request: { url: "https://x.dev/slow", method: "GET", headers: {} },
    timestamp: 1,
    wallTime: 1700000000,
  });
  for (const id of ["a", "b", "c"]) {
    model.feed("Network.requestWillBeSent", {
      requestId: id,
      request: { url: `https://x.dev/${id}`, method: "GET", headers: {} },
      timestamp: 2,
      wallTime: 1700000000,
    });
    model.feed("Network.loadingFinished", { requestId: id, timestamp: 3, encodedDataLength: 1 });
  }
  assert.ok(model.get("slow"), "the pending request survived the overflow");
  assert.strictEqual(model.get("a"), null, "the oldest settled one did not");
});

test("an evicted request's body is reported as unknown, not served from nowhere", async () => {
  const { model } = makeModel({
    maxEntries: 1,
    commands: { "Network.getResponseBody": () => ({ body: "{}", base64Encoded: false }) },
  });
  model.feed("Network.requestWillBeSent", {
    requestId: "old",
    request: { url: "https://x.dev/old", method: "GET", headers: {} },
    timestamp: 1,
    wallTime: 1700000000,
  });
  model.feed("Network.loadingFinished", { requestId: "old", timestamp: 2, encodedDataLength: 1 });
  model.feed("Network.requestWillBeSent", {
    requestId: "new",
    request: { url: "https://x.dev/new", method: "GET", headers: {} },
    timestamp: 3,
    wallTime: 1700000000,
  });
  const reply = await model.getResponseBody("old");
  assert.strictEqual(reply.available, false);
  assert.match(reply.error, /No request with requestId "old"/);
});

// ── lazy bodies ──────────────────────────────────────────────────────────────
test("bodies are fetched lazily per requestId, honouring the base64Encoded flag", async () => {
  const { model, sent } = makeModel({
    commands: {
      "Network.getResponseBody": ({ requestId }) =>
        requestId === "1"
          ? { body: "e30=", base64Encoded: true }
          : { body: '{"data":1}', base64Encoded: false },
    },
  });
  feed(model, jsonPostSequence());

  const binary = await model.getResponseBody("1");
  assert.deepStrictEqual(binary, { available: true, body: "e30=", base64Encoded: true });

  const text = await model.getResponseBody("1");
  assert.strictEqual(text.body, "e30=", "the model does not cache a decoded guess");

  const plain = await model.getResponseBody("999-not-known");
  assert.strictEqual(plain.available, false, "an unknown id is answered honestly");
  assert.match(plain.error, /No request with requestId/);

  const bodyCommands = sent.filter((entry) => entry.method === "Network.getResponseBody");
  assert.deepStrictEqual(
    bodyCommands.map((entry) => entry.params),
    [{ requestId: "1" }, { requestId: "1" }],
    "a request the model does not know is not even asked about"
  );
});

test("the backend's own reason is passed through when it has no body", async () => {
  const { model } = makeModel({
    commands: {
      "Network.getResponseBody": () => {
        const error = new Error(
          'Network.getResponseBody: Internal error: Could not retrieve response body for the given requestId.'
        );
        throw error;
      },
    },
  });
  feed(model, jsonPostSequence());
  const reply = await model.getResponseBody("1");
  assert.strictEqual(reply.available, false);
  assert.match(reply.error, /Could not retrieve response body/);
  assert.strictEqual(reply.body, undefined, "no empty-string body is handed over");
});

test("a reply with no body field is not turned into an empty success", async () => {
  const { model } = makeModel({
    commands: { "Network.getResponseBody": () => ({ base64Encoded: false }) },
  });
  feed(model, jsonPostSequence());
  const reply = await model.getResponseBody("1");
  assert.deepStrictEqual(reply, { available: false, error: "Network.getResponseBody returned no body." });
});

// ── lazy Network.enable and honest degradation ───────────────────────────────
test("Network.enable is lazy: only sent once someone actually looks", async () => {
  const { model, sent } = makeModel({ commands: { "Network.enable": () => ({}) } });
  assert.deepStrictEqual(sent, [], "constructing the model asks for nothing");
  model.start();
  await model.requestEnable();
  assert.deepStrictEqual(
    sent.map((entry) => entry.method),
    ["Network.enable"]
  );
});

test("overlapping enable requests cost one CDP command", async () => {
  const { model, sent } = makeModel({
    commands: {
      "Network.enable": () => new Promise((resolve) => setTimeout(() => resolve({}), 10)),
    },
  });
  model.start();
  await Promise.all([model.requestEnable(), model.requestEnable(), model.requestEnable()]);
  assert.strictEqual(sent.filter((entry) => entry.method === "Network.enable").length, 1);
});

test("a refused Network.enable becomes an observable reason, reported once", async () => {
  const { model, warnings } = makeModel({
    commands: {
      "Network.enable": () => {
        throw new Error(
          "Network.enable: The Network domain is unavailable when multiple React Native hosts are registered."
        );
      },
    },
  });
  model.start();
  await model.requestEnable();
  const status = model.status();
  assert.strictEqual(status.available, false);
  assert.strictEqual(status.enableState, "unavailable");
  assert.match(status.reason, /multiple React Native hosts are registered/);
  assert.strictEqual(warnings.filter((entry) => entry.level === "warn").length, 1);

  // Back-off: a second immediate ask does not hammer the app.
  const second = await model.requestEnable();
  assert.strictEqual(second, false);
  assert.strictEqual(warnings.length, 1, "the same reason is not repeated");
});

test("a backend compiled without network inspection reports the method-not-found text", async () => {
  const { model } = makeModel(); // no command handlers -> Method not found
  model.start();
  await model.requestEnable();
  assert.strictEqual(model.status().available, false);
  assert.match(model.status().reason, /Method not found/);
  assert.strictEqual(model.list().length, 0, "and nothing is accumulated in the meantime");
});

test("a fresh session re-arms Network.enable (app reload / host-count change)", async () => {
  const handlers = [];
  const sent = [];
  const model = createNetworkModel({
    sendCommand: async (method) => {
      sent.push(method);
      return {};
    },
    onEvent: (method, handler) => {
      handlers.push(handler);
      return () => {};
    },
  });
  model.start();
  await model.requestEnable();
  assert.deepStrictEqual(sent, ["Network.enable"]);

  // Same handler the bridge fans out for every notification.
  handlers[0](undefined, "Runtime.executionContextsCleared");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(
    sent.filter((method) => method === "Network.enable").length,
    2,
    "an app reload re-enables the domain"
  );

  // Each churn signal re-arms separately, and only once per signal: the counts are
  // asserted per step, because a single trailing requestEnable() would pass even if
  // one of the two signals were ignored.
  handlers[0](undefined, "Network.disable");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(
    sent.filter((method) => method === "Network.enable").length,
    3,
    "the host-count broadcast (Network.disable) re-enables it too"
  );

  handlers[0]({}, "Network.requestWillBeSent");
  handlers[0]({}, "Network.loadingFinished");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await model.requestEnable();
  assert.strictEqual(
    sent.filter((method) => method === "Network.enable").length,
    3,
    "ordinary traffic never re-arms, not even after the domain went down and came back"
  );
});

test("stop() unsubscribes and the model stops asking", async () => {
  let unsubscribed = 0;
  const model = createNetworkModel({
    sendCommand: async () => ({}),
    onEvent: () => {
      unsubscribed += 1;
      return () => {
        unsubscribed -= 1;
      };
    },
  });
  model.start();
  model.start(); // idempotent
  assert.strictEqual(unsubscribed, 1);
  model.stop();
  assert.strictEqual(unsubscribed, 0);
  model.stop();
  assert.strictEqual(unsubscribed, 0);
});

test("status distinguishes a live-but-idle capture from a dead one", async () => {
  const enabled = makeModel({ commands: { "Network.enable": () => ({}) } });
  enabled.model.start();
  await enabled.model.requestEnable();
  assert.deepStrictEqual(
    { ...enabled.model.status(), observing: undefined },
    { available: true, observing: undefined, enableState: "enabled", reason: null, requests: 0, finished: 0 }
  );

  const dead = makeModel();
  dead.model.start();
  await dead.model.requestEnable();
  assert.strictEqual(dead.model.status().available, false);
  assert.ok(dead.model.status().reason, "a reason is always present when unavailable");
});

// ── pure helpers ─────────────────────────────────────────────────────────────
test("resourceTypeFromMime mirrors RN's own MIME mapping", () => {
  assert.strictEqual(resourceTypeFromMime("application/json"), "XHR");
  assert.strictEqual(resourceTypeFromMime("image/png"), "Image");
  assert.strictEqual(resourceTypeFromMime("text/javascript"), "Script");
  assert.strictEqual(resourceTypeFromMime("text/css"), "Stylesheet");
  assert.strictEqual(resourceTypeFromMime("video/mp4"), "Media");
  assert.strictEqual(resourceTypeFromMime("application/vnd.api+json"), "Other");
  assert.strictEqual(resourceTypeFromMime(undefined), "Other");
});

test("CDP headers arrive as a map or a list and both become header pairs", () => {
  assert.deepStrictEqual(headerListToPairs({ a: "1", b: ["2", "3"] }), [
    { name: "a", value: "1" },
    { name: "b", value: "2, 3" },
  ]);
  assert.deepStrictEqual(headerListToPairs([{ name: "a", value: "1" }]), [
    { name: "a", value: "1" },
  ]);
  assert.deepStrictEqual(headerListToPairs(null), []);
});

test("queryString / content-type / byteLength helpers", () => {
  assert.deepStrictEqual(queryStringFrom("https://x.dev/a"), []);
  assert.deepStrictEqual(queryStringFrom("https://x.dev/a?x"), [{ name: "x", value: "" }]);
  // An undecodable escape falls back to the raw text instead of throwing.
  assert.deepStrictEqual(queryStringFrom("https://x.dev/a?bad%zz=1"), [
    { name: "bad%zz", value: "1" },
  ]);
  assert.strictEqual(
    contentTypeOf([{ name: "Content-Type", value: "application/json" }]),
    "application/json"
  );
  assert.strictEqual(byteLength("héllo"), 6);
  assert.strictEqual(byteLength("😀"), 4);
});

test("a malformed notification never takes the model down", () => {
  const { model, warnings } = makeModel();
  model.feed("Network.requestWillBeSent", null);
  model.feed("Network.requestWillBeSent", { request: { url: "https://x.dev" } });
  model.feed("Network.loadingFinished", { requestId: 42 });
  assert.deepStrictEqual(model.list(), []);
  assert.strictEqual(warnings.length, 0, "unknown input is ignored quietly, not a crash");
});

test("the model requires the two CDP deps it cannot work without", () => {
  assert.throws(() => createNetworkModel({}), /sendCommand and onEvent/);
});
