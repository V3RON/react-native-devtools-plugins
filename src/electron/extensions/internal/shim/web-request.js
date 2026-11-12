// chrome.webRequest support pieces: the CDP -> webRequest shape mapping, the
// ResourceType vocabulary, and Chrome's URL-filter matching.
//
// Pure: no `window`, no `ipcRenderer`, no transport (docs/ARCHITECTURE.md
// layering rule). `src/main/network-model.js` produces the CDP-derived record,
// this module turns that record into the details object a listener receives,
// and `src/chrome-shim/network-bridge.js` decides which listeners see it.
//
// Chrome's webRequest gives a listener nine possible events; RN's backend can
// honestly produce seven of them, because jsinspector-modern's NetworkHandler
// emits exactly these notifications
// (`ReactCommon/jsinspector-modern/network/NetworkHandler.cpp`):
//
//   Network.requestWillBeSent            -> onBeforeRequest + onBeforeSendHeaders
//   Network.requestWillBeSentExtraInfo   -> onSendHeaders
//   Network.responseReceived             -> onResponseStarted (onBeforeRedirect on a 3xx)
//   Network.loadingFinished              -> onCompleted
//   Network.loadingFailed                -> onErrorOccurred
//
// `onBeforeRequest` and `onBeforeSendHeaders` come from ONE CDP notification: RN
// reports a request together with its headers
// (`react/networking/NetworkReporter.cpp:57`), so there is no earlier "headers not
// attached yet" moment to separate the two into. Both carry the real headers the
// backend reported; nothing is invented to stretch the lifecycle out.
//
// `onHeadersReceived` and `onAuthRequired` have no CDP counterpart on this
// backend, and *blocking* is impossible on all of them: RN implements no CDP
// `Fetch` domain, so nothing can be cancelled, redirected or rewritten here
// (docs/features/WEBREQUEST.md).

// The events this host can actually emit, in lifecycle order.
const EMITTED = [
  "onBeforeRequest",
  "onBeforeSendHeaders",
  "onSendHeaders",
  "onBeforeRedirect",
  "onResponseStarted",
  "onCompleted",
  "onErrorOccurred",
];

// Present in Chrome's shape, never emitted here — listeners are accepted and
// stay quiet rather than being absent (extensions feature-detect by calling).
const SILENT = ["onHeadersReceived", "onAuthRequired"];

// chrome.webRequest.ResourceType vocabulary
// (developer.chrome.com/docs/extensions/reference/api/webRequest#type-ResourceType).
const RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "other",
];

// CDP `Network.ResourceType` -> webRequest `ResourceType`. RN's own mapping is
// MIME-derived and only ever produces Document / Stylesheet / Image / Media /
// Script / XHR / Other (`network/CdpNetwork.cpp:144` `resourceTypeFromMimeType`),
// but the table covers the whole CDP enum so a richer backend still lands on a
// real Chrome value — never an invented one.
const CDP_TO_RESOURCE_TYPE = {
  Document: "main_frame",
  document: "main_frame",
  Other: "other",
  Stylesheet: "stylesheet",
  stylesheet: "stylesheet",
  Image: "image",
  image: "image",
  Media: "media",
  media: "media",
  Font: "font",
  font: "font",
  Script: "script",
  script: "script",
  TextTrack: "other",
  XHR: "xmlhttprequest",
  xhr: "xmlhttprequest",
  Fetch: "xmlhttprequest",
  fetch: "xmlhttprequest",
  Preflight: "xmlhttprequest",
  EventSource: "other",
  WebSocket: "websocket",
  websocket: "websocket",
  Manifest: "other",
  SignedExchange: "other",
  Ping: "ping",
  ping: "ping",
  CSPViolationReport: "csp_report",
  Prefetch: "other",
  Prerender: "other",
  ServiceWorker: "other",
};

/** CDP resource type -> chrome.webRequest ResourceType (unknown -> "other"). */
const toResourceType = (cdpType) => CDP_TO_RESOURCE_TYPE[cdpType] || "other";

/** CDP header collection (object map or [{name, value}] list) -> webRequest list. */
const toHeaderList = (headers) => {
  if (Array.isArray(headers)) {
    return headers
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        name: String(entry.name ?? ""),
        value: Array.isArray(entry.value) ? entry.value.join(", ") : String(entry.value ?? ""),
      }));
  }
  if (headers && typeof headers === "object") {
    return Object.entries(headers).map(([name, value]) => ({
      name,
      value: Array.isArray(value) ? value.join(", ") : String(value),
    }));
  }
  return [];
};

/** Chrome's `Request`-shaped body for onBeforeRequest (`opt_extraInfoSpec`). */
const toRequestBody = (postData) =>
  typeof postData === "string"
    ? { raw: [{ bytes: new TextEncoder().encode(postData) }] }
    : undefined;

/**
 * A record from src/main/network-model.js -> chrome.webRequest's `details`.
 * Field names follow Chrome's docs; anything the CDP event does not carry is
 * left out rather than guessed at. `timeStamp` comes from the request's own wall
 * clock. `tabId` is Chrome's own constant for "no tab" — a DevTools panel frame
 * has no tab of its own, and RN has no tab model at all.
 *
 * @param {object} record network-model record (`webRequestType` already mapped)
 * @param {object} [overrides] event-specific additions (statusCode, error, …)
 */
const toRequestDetails = (record, overrides = {}) => {
  const wallSeconds = Number.isFinite(record.wallTime) ? record.wallTime : Date.now() / 1000;
  return {
    requestId: record.requestId,
    tabId: -1,
    type: record.webRequestType || toResourceType(record.resourceType),
    url: record.url,
    originUrl: record.url,
    documentUrl: record.documentURL || record.url,
    method: record.method,
    timeStamp: Math.round(wallSeconds * 1000),
    timeStampISO: new Date(wallSeconds * 1000).toISOString(),
    frameId: 0,
    frameType: "top_frame",
    parentFrameId: -1,
    fromCache: record.fromCache === true,
    initiator: record.initiator || undefined,
    requestHeaders: toHeaderList(record.requestHeaders),
    responseHeaders: toHeaderList(record.responseHeaders),
    ...overrides,
  };
};

// ── URL filter matching ──────────────────────────────────────────────────────
// Chrome documents two syntaxes for `filters.urls` and both are accepted here:
//   - match patterns (`https://*.example.com/*`, `<all_urls>`), split into
//     scheme / host / path and matched with Chrome's own rules — case-insensitive
//     host, `*.` matching any subdomain *or* none, `_` matching inside one label;
//   - the glob patterns WebRequest historically accepted (`*example.com*`), i.e.
//     anything that is not a valid match pattern.
// Ports are ignored on both sides: a request to a dev server does carry one, and
// a filter that only worked against port 80/443 would be useless here.

const ALL_URLS = /^(<all_urls>|\*:\/\/\*\/\*|\*:\/\/\*:\*\/\*)$/;

const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

// A leading `*.` covers any subdomains *or* none (Chrome's documented rule);
// `*` spans a run of non-slash characters; `_` stays inside one label.
const hostToRegExp = (host) => {
  let source = "";
  let index = 0;
  if (host.startsWith("*.")) {
    source += "([^/]*\\.)?";
    index = 2;
  }
  for (; index < host.length; index++) {
    const char = host[index];
    if (char === "*") source += "[^/]*";
    else if (char === "_") source += "[^.]*";
    else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, "i");
};

// Path/query wildcards: `*` spans anything. Chrome matches the pattern's path
// against the URL's path *including* query and fragment.
const pathToRegExp = (path) =>
  new RegExp(`^${path.split("*").map(escapeRegExp).join(".*")}$`);

const splitUrl = (url) => {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(String(url ?? ""));
  if (!match) {
    return null;
  }
  const [, scheme, authority, rest] = match;
  return {
    scheme: scheme.toLowerCase(),
    host: authority.replace(/:[0-9]*$/, "").toLowerCase(),
    path: rest || "/",
  };
};

/**
 * Compile one filter pattern into a matcher, or null for a pattern that can never
 * match (empty / non-string). A pattern the app cannot address must not blow up
 * a listener registration.
 */
const compilePattern = (pattern) => {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return null;
  }
  if (ALL_URLS.test(pattern)) {
    return (url) => String(url ?? "").includes("://");
  }
  const parts = /^([*a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/i.exec(pattern);
  if (parts) {
    const [, scheme, host, path] = parts;
    const schemeOk = scheme === "*" ? () => true : (given) => given === scheme.toLowerCase();
    const hostOk = hostToRegExp(host.replace(/:[0-9*]+$/, ""));
    const pathOk = pathToRegExp(path);
    return (url) => {
      const parsed = splitUrl(url);
      return (
        !!parsed && schemeOk(parsed.scheme) && hostOk.test(parsed.host) && pathOk.test(parsed.path)
      );
    };
  }
  // Glob fallback: any run of characters, case-insensitive.
  const glob = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "i");
  return (url) => glob.test(String(url ?? ""));
};

/** Does one URL match one filter pattern (match pattern or glob)? */
const urlMatchesPattern = (url, pattern) => {
  const matches = compilePattern(pattern);
  return matches ? matches(url) : false;
};

/** Does one URL match ANY of the filter's patterns? No patterns -> match all. */
const urlMatchesAny = (url, patterns) => {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return true;
  }
  return patterns.some((pattern) => urlMatchesPattern(url, pattern));
};

/**
 * Chrome's ListenerFilters applied to one event. `urls` is matched against the
 * request URL, `types` against the mapped ResourceType (`resourceType` is the
 * same predicate spelled the MV3 way). Returns true when the listener wants this
 * event; non-array values are treated as "no filter", never as a throw.
 */
const listenerMatches = (details, filters) => {
  if (!filters || typeof filters !== "object") {
    return true;
  }
  const types = filters.types || filters.resourceType;
  if (Array.isArray(types) && types.length > 0 && !types.includes(details.type)) {
    return false;
  }
  return urlMatchesAny(details.url, filters.urls);
};

module.exports = {
  EMITTED,
  SILENT,
  RESOURCE_TYPES,
  toResourceType,
  toHeaderList,
  toRequestDetails,
  toRequestBody,
  compilePattern,
  urlMatchesPattern,
  urlMatchesAny,
  listenerMatches,
};
