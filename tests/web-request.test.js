// chrome.webRequest pieces (src/chrome-shim/web-request.js): the CDP -> webRequest
// shape, the ResourceType vocabulary, and Chrome's URL-filter matching.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const {
  EMITTED,
  SILENT,
  RESOURCE_TYPES,
  toResourceType,
  toHeaderList,
  toRequestDetails,
  toRequestBody,
  urlMatchesPattern,
  urlMatchesAny,
  listenerMatches,
} = require("../src/chrome-shim/web-request");

const record = (over = {}) => ({
  requestId: "1",
  status: "pending",
  url: "https://countries.trevorblades.com/",
  method: "POST",
  resourceType: "XHR",
  mimeType: "application/json",
  responseStatus: 0,
  statusText: "",
  requestHeaders: [{ name: "content-type", value: "application/json" }],
  responseHeaders: [],
  redirects: [],
  wallTime: 1699975911.862162,
  ...over,
});

test("the emitted/silent split matches what RN's NetworkHandler can report", () => {
  assert.deepStrictEqual(EMITTED, [
    "onBeforeRequest",
    "onBeforeSendHeaders",
    "onSendHeaders",
    "onBeforeRedirect",
    "onResponseStarted",
    "onCompleted",
    "onErrorOccurred",
  ]);
  assert.deepStrictEqual(SILENT, ["onHeadersReceived", "onAuthRequired"]);
  // All nine of Chrome's events are accounted for.
  const chromeNine = [
    "onBeforeRequest",
    "onBeforeSendHeaders",
    "onSendHeaders",
    "onHeadersReceived",
    "onResponseStarted",
    "onAuthRequired",
    "onBeforeRedirect",
    "onCompleted",
    "onErrorOccurred",
  ];
  assert.deepStrictEqual([...EMITTED, ...SILENT].sort(), chromeNine.sort());
});

test("CDP resource types land on real webRequest ResourceTypes", () => {
  assert.strictEqual(toResourceType("XHR"), "xmlhttprequest");
  assert.strictEqual(toResourceType("Fetch"), "xmlhttprequest");
  assert.strictEqual(toResourceType("Script"), "script");
  assert.strictEqual(toResourceType("Stylesheet"), "stylesheet");
  assert.strictEqual(toResourceType("Image"), "image");
  assert.strictEqual(toResourceType("Font"), "font");
  assert.strictEqual(toResourceType("Media"), "media");
  assert.strictEqual(toResourceType("Document"), "main_frame");
  assert.strictEqual(toResourceType("WebSocket"), "websocket");
  assert.strictEqual(toResourceType("Ping"), "ping");
  assert.strictEqual(toResourceType("Other"), "other");
  assert.strictEqual(toResourceType("SomethingNew"), "other");
  // Every mapped value is part of Chrome's enum.
  for (const type of ["XHR", "Script", "Image", "Font", "Media", "Document", "WebSocket", "Ping", "Other"]) {
    assert.ok(RESOURCE_TYPES.includes(toResourceType(type)), type);
  }
});

test("the details object carries Chrome's documented fields", () => {
  const details = toRequestDetails({ ...record(), webRequestType: toResourceType("XHR") });
  assert.strictEqual(details.requestId, "1");
  assert.strictEqual(details.type, "xmlhttprequest");
  assert.strictEqual(details.url, "https://countries.trevorblades.com/");
  assert.strictEqual(details.method, "POST");
  assert.strictEqual(details.tabId, -1, "Chrome's own constant for 'no tab'");
  assert.strictEqual(details.timeStamp, 1699975911862);
  assert.strictEqual(details.timeStampISO, new Date(1699975911862).toISOString());
  assert.deepStrictEqual(details.requestHeaders, [
    { name: "content-type", value: "application/json" },
  ]);
  assert.deepStrictEqual(details.responseHeaders, []);
  assert.strictEqual(details.initiator, undefined, "not reported -> absent, not {}");
});

test("webRequest header lists accept both CDP shapes", () => {
  assert.deepStrictEqual(toHeaderList({ a: "1" }), [{ name: "a", value: "1" }]);
  assert.deepStrictEqual(toHeaderList([{ name: "a", value: "1" }]), [
    { name: "a", value: "1" },
  ]);
  assert.deepStrictEqual(toHeaderList("nonsense"), []);
});

test("requestBody carries the real bytes Chrome's extraInfoSpec asks for", () => {
  const body = toRequestBody('{"query":"{ country { name } }"}');
  assert.ok(body.raw[0].bytes instanceof Uint8Array);
  assert.strictEqual(new TextDecoder().decode(body.raw[0].bytes), '{"query":"{ country { name } }"}');
  assert.strictEqual(toRequestBody(undefined), undefined, "no body -> no field");
});

// ── URL filter matching ──────────────────────────────────────────────────────
test("<all_urls> and *://*/* match anything with a scheme", () => {
  assert.ok(urlMatchesPattern("https://x.dev/a", "<all_urls>"));
  assert.ok(urlMatchesPattern("https://x.dev/a", "*://*/*"));
  assert.ok(urlMatchesPattern("ws://x.dev/socket", "<all_urls>"));
});

test("match patterns honour scheme, host wildcard, path wildcard", () => {
  assert.ok(urlMatchesPattern("https://x.dev/api/v1/q", "https://x.dev/*"));
  assert.ok(urlMatchesPattern("https://x.dev/api/v1/q", "https://*.dev/*"));
  assert.ok(urlMatchesPattern("https://x.dev/api/v1/q", "https://x.dev/api/*/q"));
  assert.ok(!urlMatchesPattern("http://x.dev/a", "https://x.dev/*"), "scheme must match");
  assert.ok(!urlMatchesPattern("https://y.dev/a", "https://x.dev/*"), "host must match");
  assert.ok(!urlMatchesPattern("https://x.dev/b", "https://x.dev/a"));
});

test("the _ subdomain wildcard behaves like Chrome's", () => {
  assert.ok(urlMatchesPattern("https://api.x.dev/q", "https://_.x.dev/q"));
  assert.ok(!urlMatchesPattern("https://x.dev/q", "https://_.x.dev/q"), "the bare host is not a subdomain");
});

test("glob patterns still work (WebRequest's historical syntax)", () => {
  assert.ok(urlMatchesPattern("https://api.example.com/graphql", "*example.com*"));
  assert.ok(urlMatchesPattern("https://x.dev/graphql", "*graphql"));
  assert.ok(!urlMatchesPattern("https://x.dev/rest", "*graphql"));
});

test("host matching is case-insensitive; path matching is not (Chrome's rule)", () => {
  assert.ok(urlMatchesPattern("https://X.DEV/graphql", "https://x.dev/graphql"));
  assert.ok(!urlMatchesPattern("https://x.dev/GraphQL", "https://x.dev/graphql"));
  // Glob patterns stay case-insensitive, matching WebRequest's historical behavior.
  assert.ok(urlMatchesPattern("https://x.dev/GraphQL", "*graphql"));
});

test("ports are ignored on both sides (a dev-server request still matches)", () => {
  assert.ok(urlMatchesPattern("http://127.0.0.1:8081/graphql", "http://127.0.0.1/*"));
  assert.ok(urlMatchesPattern("http://localhost:8081/graphql", "http://localhost:3000/*"));
});

test("a match pattern with a bare host also matches subdomains only via *.", () => {
  assert.ok(urlMatchesPattern("https://example.com/x", "https://*.example.com/*"));
  assert.ok(urlMatchesPattern("https://a.b.example.com/x", "https://*.example.com/*"));
  assert.ok(!urlMatchesPattern("https://notexample.com/x", "https://*.example.com/*"));
});

test("an unusable pattern matches nothing instead of throwing", () => {
  assert.strictEqual(urlMatchesPattern("https://x.dev", ""), false);
  assert.strictEqual(urlMatchesPattern("https://x.dev", null), false);
  assert.strictEqual(urlMatchesAny("https://x.dev", ["", null]), false);
});

test("no patterns means match everything", () => {
  assert.ok(urlMatchesAny("https://x.dev", []));
  assert.ok(urlMatchesAny("https://x.dev", undefined));
  assert.strictEqual(urlMatchesAny("https://x.dev", ["https://other.dev/*"]), false);
});

test("ListenerFilters: urls and types both apply", () => {
  const details = toRequestDetails({ ...record(), webRequestType: "xmlhttprequest" });
  assert.ok(listenerMatches(details, { urls: ["<all_urls>"] }));
  assert.ok(listenerMatches(details, { urls: ["https://*.trevorblades.com/*"], types: ["xmlhttprequest"] }));
  assert.ok(!listenerMatches(details, { types: ["script"] }), "type filter excludes");
  assert.ok(!listenerMatches(details, { urls: ["https://other.dev/*"] }), "url filter excludes");
  assert.ok(listenerMatches(details, undefined), "no filters -> every event");
  assert.ok(listenerMatches(details, {}), "empty filters -> every event");
  // MV3 spellings and junk must not throw.
  assert.ok(listenerMatches(details, { resourceType: ["xmlhttprequest"] }));
  assert.ok(listenerMatches(details, { urls: "not-an-array" }));
});
