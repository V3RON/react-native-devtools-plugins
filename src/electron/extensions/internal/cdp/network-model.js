// The host-side network model: the shell's own view of the RN app's traffic,
// built from the CDP `Network.*` notifications the bridge already relays
// (docs/features/DEVTOOLS-NETWORK.md, docs/features/WEBREQUEST.md).
//
// Why it lives in main: the CDP session belongs to the bridge
// (src/main/cdp-bridge.js) and every extension frame needs the same answers, so
// the model accumulates once here and is consumed by `chrome.devtools.network`
// and `chrome.webRequest` over one async IPC channel. The frontend's `Events`
// postMessage broadcast and the hardcoded fake body are gone: nothing in this
// file invents a value it did not receive from the backend.
//
// One capture, two APIs: `onObserved(record, event, extra)` is the seam. The
// chrome-shim decides *which* Chrome event a step becomes; this module decides
// what the record contains and when it is complete.
//
// Backend honesty — every claim below was read out of this repo's vendored RN
// (react-native 0.86.3, `app/node_modules/react-native/ReactCommon/`):
//  - `jsinspector-modern/network/NetworkHandler.cpp` emits requestWillBeSent,
//    requestWillBeSentExtraInfo, responseReceived, dataReceived,
//    loadingFinished and loadingFailed, and buffers bodies for getResponseBody.
//  - `NetworkIOAgent.cpp:503` answers `Network.getResponseBody` with
//    `{body, base64Encoded}`, and errors when the domain is off or the body is
//    no longer buffered.
//  - `HostAgent.cpp:150` answers `Network.enable` with an error when the app has
//    more than one registered RN host, and `emitSystemStateChanged`
//    (`HostAgent.cpp:435`) broadcasts a `Network.disable` notification when that
//    count changes — which is our cue that the domain needs re-enabling.
//  - `InspectorFlags.cpp:44` gates the whole domain behind a build flag; when it
//    is off the backend never reaches `NetworkIOAgent`'s Network branch, so
//    `Network.enable` comes back as "Method not found".
// Both failures land in `status()` as an explicit reason, so an extension can say
// "no network data" instead of showing an unexplained empty list.
//
// No Electron and no bridge import: `sendCommand` / `onEvent` are injected, which
// is what makes the whole model testable without a socket.

// Chrome's devtools.network/HAR model is a subset of the CDP Network domain, so
// these are the only notifications worth handling here.
const NETWORK_EVENTS = [
  "Network.requestWillBeSent",
  "Network.requestWillBeSentExtraInfo",
  "Network.responseReceived",
  "Network.dataReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
];

const DEFAULTS = {
  // A network panel is a bounded history, not a database.
  maxEntries: 500,
  // `Network.enable` is lazy and shared: the frontend asks for the domain for
  // its own panel and Rozenite's middleware asks too, so this layer asks only
  // when a frame actually wants network data, and backs off when the backend
  // refuses (multi-host app, network inspection compiled out).
  enableRetryMs: 10000,
  enableTimeoutMs: 5000,
};

/** CDP ResourceType -> the lowercase HAR-ish type chrome's entries report. */
const lowerType = (type) => String(type || "Other").toLowerCase();

/** MIME-derived fallback for the resource type (RN does the same, CdpNetwork.cpp:144). */
const resourceTypeFromMime = (mimeType) => {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "Image";
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "Media";
  if (mime === "text/css") return "Stylesheet";
  if (mime === "application/javascript" || mime === "text/javascript" || mime === "application/x-javascript")
    return "Script";
  if (mime === "application/json" || mime.startsWith("application/xml") || mime === "text/xml")
    return "XHR";
  if (mime.startsWith("text/html")) return "Document";
  return "Other";
};

/** CDP headers (object map or `[{name, value}]` list) -> HAR header list. */
const headerListToPairs = (headers) => {
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

const asNumber = (value, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const isRecord = (value) => !!value && typeof value === "object";

const decodeComponent = (text) => {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, " "));
  } catch {
    return String(text);
  }
};

/** HAR `queryString` from a URL. */
const queryStringFrom = (url) => {
  const query = String(url || "").split("?")[1];
  if (!query) {
    return [];
  }
  return query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf("=");
      return {
        name: decodeComponent(index === -1 ? pair : pair.slice(0, index)),
        value: index === -1 ? "" : decodeComponent(pair.slice(index + 1)),
      };
    });
};

const contentTypeOf = (headers) =>
  (headers.find((header) => String(header.name).toLowerCase() === "content-type") || {})
    .value;

/** UTF-8 byte length without assuming Buffer/TextEncoder in this realm. */
const byteLength = (text) => {
  const encoded = new TextEncoder().encode(text);
  return encoded.length;
};

/**
 * @param {object} deps
 * @param {(method: string, params?: object, opts?: object) => Promise<object>} deps.sendCommand
 *        CDP command sender — the bridge's `sendCommand` in production.
 * @param {(method: string, handler: Function) => Function} deps.onEvent
 *        CDP notification subscription — the bridge's `onEvent`.
 * @param {(record: object, event: string, extra: object) => void} [deps.onObserved]
 *        Called for every lifecycle step of a tracked request; the IPC service
 *        turns it into devtools.network / webRequest deliveries.
 * @param {(status: object) => void} [deps.onStatusChange]
 *        Called when availability flips (the domain came up, or the backend
 *        refused it). Without it a frame could only learn about a refusal by
 *        asking, which is exactly the silence this model exists to remove.
 * @param {(level: string, message: string) => void} [deps.log]
 * @param {number} [deps.maxEntries]      ring-buffer capacity (see evictIfNeeded)
 * @param {number} [deps.enableRetryMs]   back-off after a refused Network.enable
 */
const createNetworkModel = ({
  sendCommand,
  onEvent,
  onObserved = () => {},
  onStatusChange = () => {},
  log = () => {},
  maxEntries = DEFAULTS.maxEntries,
  enableRetryMs = DEFAULTS.enableRetryMs,
  enableTimeoutMs = DEFAULTS.enableTimeoutMs,
  now = () => Date.now(),
} = {}) => {
  if (typeof sendCommand !== "function" || typeof onEvent !== "function") {
    throw new TypeError("createNetworkModel requires sendCommand and onEvent");
  }

  /** requestId -> record, in arrival order (Map iteration == insertion order). */
  const records = new Map();
  let observing = false;
  let offEvents = null;
  /** "idle" (never asked) | "enabling" | "enabled" | "unavailable" */
  let enableState = "idle";
  let unavailableReason = null;
  let lastEnableAttempt = 0;
  /** Single-flight so a re-arm storm costs one CDP command, not one per event. */
  let enableInFlight = null;

  // A CDP request record: only fields the backend reported, plus derived ones.
  // Anything the notifications did not carry stays absent, and the HAR mapping
  // turns "absent" into HAR's own -1 / empty string rather than a plausible
  // number.
  const newRecord = (requestId) => ({
    requestId,
    status: "pending", // pending | finished | failed
    url: "",
    method: "GET",
    resourceType: "Other", // CDP ResourceType, e.g. "XHR"
    mimeType: "",
    protocol: "",
    documentURL: "",
    initiator: undefined,
    requestHeaders: [],
    responseHeaders: [],
    postData: undefined,
    queryString: [],
    responseStatus: 0,
    statusText: "",
    redirects: [],
    timestamp: undefined, // CDP monotonic seconds
    wallTime: undefined, // unix seconds (RN sets both, NetworkHandler.cpp:78)
    responseTimestamp: undefined,
    finishedTimestamp: undefined,
    dataLength: 0,
    encodedDataLength: 0,
    timing: undefined,
    failure: undefined,
    fromCache: false,
    bodySeen: false,
  });

  const observed = (record, event, extra = {}) => {
    try {
      onObserved(record, event, extra);
    } catch (error) {
      log("error", `network observer threw on ${event}: ${error.message}`);
    }
  };

  /**
   * Availability changed: tell whoever forwards it to the frames. Only the model
   * knows when the backend accepted or refused the domain, so this is the moment
   * an "empty list" stops being ambiguous. Keyed on the availability fields only —
   * the record counts change per request and must not ride along on this channel.
   */
  let lastAnnounced = null;
  const announceStatus = () => {
    const key = `${enableState}|${unavailableReason || ""}`;
    if (key === lastAnnounced) {
      return;
    }
    lastAnnounced = key;
    try {
      onStatusChange(status());
    } catch (error) {
      log("error", `network status observer threw: ${error.message}`);
    }
  };

  // ── eviction: bounded history, explicit policy ─────────────────────────────
  // Drop the oldest *settled* record. The Map is in insertion order, so that is
  // the oldest request that can no longer change; an in-flight request is never
  // dropped, because its own finish notification is the only thing that can
  // complete it and losing one would silently lose a request the extension is
  // waiting for. The cap therefore applies to settled records and catches up on
  // the next one. Consequence: an evicted record's body is no longer answerable
  // (`getResponseBody` then reports it as unknown), which is the truth rather
  // than a stale guess.
  const evictIfNeeded = () => {
    if (records.size <= maxEntries) {
      return;
    }
    for (const [requestId, record] of records) {
      if (record.status !== "pending") {
        records.delete(requestId);
        return;
      }
    }
  };

  // ── CDP notification handling ──────────────────────────────────────────────
  const onRequestWillBeSent = (params) => {
    if (!isRecord(params) || typeof params.requestId !== "string") {
      return;
    }
    const existing = records.get(params.requestId);
    const record = existing || newRecord(params.requestId);
    if (!existing) {
      records.set(params.requestId, record);
    }
    const request = isRecord(params.request) ? params.request : {};
    let redirect = null;
    if (existing && isRecord(params.redirectResponse)) {
      // A redirect re-announces the same requestId with the previous response
      // attached: one record per CDP request id, with the chain recorded on it.
      // Both ends of the hop are kept — `fromUrl` is the URL that redirected, so
      // chrome.webRequest's onBeforeRedirect can describe the 3xx itself.
      redirect = {
        url: String(request.url ?? record.url),
        fromUrl: record.url,
        status: asNumber(params.redirectResponse.status),
        statusText: String(params.redirectResponse.statusText ?? ""),
        headers: headerListToPairs(params.redirectResponse.headers),
      };
      record.redirects.push(redirect);
    }
    record.url = String(request.url ?? record.url);
    record.method = String(request.method ?? record.method);
    record.requestHeaders = headerListToPairs(request.headers);
    record.queryString = queryStringFrom(record.url);
    if (typeof request.postData === "string") {
      record.postData = request.postData;
    }
    // `hasPostData: true` with no postData means the body exists but is only
    // served through Network.getResponseBody — left unknown, not guessed.
    record.documentURL =
      typeof params.documentURL === "string" ? params.documentURL : record.documentURL;
    if (isRecord(params.initiator)) {
      record.initiator = params.initiator;
    }
    record.timestamp = asNumber(params.timestamp, record.timestamp);
    record.wallTime = asNumber(params.wallTime, record.wallTime);
    if (typeof params.type === "string" && params.type) {
      record.resourceType = params.type;
    }
    if (!existing) {
      evictIfNeeded();
    }
    // The Chrome-shaped `requestBody` (webRequest) is built by the shim from
    // `record.postData` — this layer only carries the bytes it was given.
    observed(record, "request", { redirect });
  };

  const onRequestWillBeSentExtraInfo = (params) => {
    const record = isRecord(params) ? records.get(params.requestId) : null;
    if (!record) {
      return;
    }
    // The headers actually put on the wire (Chrome's onSendHeaders payload). RN
    // sends these separately, so they win when present.
    const headers = headerListToPairs(params.headers);
    if (headers.length > 0) {
      record.requestHeaders = headers;
    }
    observed(record, "sendHeaders");
  };

  const onResponseReceived = (params) => {
    const record = isRecord(params) ? records.get(params.requestId) : null;
    if (!record) {
      return;
    }
    const response = isRecord(params.response) ? params.response : {};
    if (typeof params.type === "string" && params.type) {
      record.resourceType = params.type;
    }
    record.responseStatus = asNumber(response.status);
    record.statusText = String(response.statusText ?? record.statusText);
    record.mimeType = String(response.mimeType ?? record.mimeType);
    record.responseHeaders = headerListToPairs(response.headers);
    record.responseTimestamp = asNumber(params.timestamp, record.responseTimestamp);
    if (typeof response.protocol === "string") {
      record.protocol = response.protocol;
    }
    if (typeof response.fromCache === "boolean") {
      record.fromCache = response.fromCache;
    }
    if (isRecord(response.timing)) {
      record.timing = response.timing;
    }
    if (!record.resourceType || record.resourceType === "Other") {
      record.resourceType = resourceTypeFromMime(record.mimeType);
    }
    observed(record, "response", { redirect: null });
  };

  const onDataReceived = (params) => {
    const record = isRecord(params) ? records.get(params.requestId) : null;
    if (!record) {
      return;
    }
    record.dataLength += asNumber(params.dataLength);
    record.encodedDataLength = asNumber(params.encodedDataLength, record.encodedDataLength);
    record.bodySeen = true;
    observed(record, "data");
  };

  const onLoadingFinished = (params) => {
    const record = isRecord(params) ? records.get(params.requestId) : null;
    if (!record || record.status !== "pending") {
      return;
    }
    record.status = "finished";
    record.finishedTimestamp = asNumber(params.timestamp, record.finishedTimestamp);
    record.encodedDataLength = asNumber(params.encodedDataLength, record.encodedDataLength);
    observed(record, "completed");
  };

  const onLoadingFailed = (params) => {
    const record = isRecord(params) ? records.get(params.requestId) : null;
    if (!record || record.status !== "pending") {
      return;
    }
    record.status = "failed";
    record.finishedTimestamp = asNumber(params.timestamp, record.finishedTimestamp);
    record.failure = {
      errorText: String(params.errorText ?? "net::ERR_FAILED"),
      canceled: params.canceled === true,
    };
    if (typeof params.type === "string" && params.type) {
      record.resourceType = params.type;
    }
    observed(record, "error");
  };

  const handleNotification = (method, params) => {
    switch (method) {
      case "Network.requestWillBeSent":
        return onRequestWillBeSent(params);
      case "Network.requestWillBeSentExtraInfo":
        return onRequestWillBeSentExtraInfo(params);
      case "Network.responseReceived":
        return onResponseReceived(params);
      case "Network.dataReceived":
        return onDataReceived(params);
      case "Network.loadingFinished":
        return onLoadingFinished(params);
      case "Network.loadingFailed":
        return onLoadingFailed(params);
      default:
        return undefined;
    }
  };

  // ── lazy Network.enable, re-armed when the session churns ──────────────────
  const setUnavailable = (reason) => {
    enableState = "unavailable";
    enableInFlight = null;
    if (unavailableReason !== reason) {
      unavailableReason = reason;
      // Once per distinct reason: a panel whose list stays empty has to be able
      // to say why, and silence is what made the old stub look like it worked.
      log(
        "warn",
        `Network domain unavailable: ${reason} — extensions will report "no network ` +
          'data" instead of showing invented traffic.'
      );
      announceStatus();
    }
  };

  /** Ask the backend for the Network domain (single-flight, backed off on refusal). */
  const requestEnable = () => {
    if (enableState === "enabled") {
      return Promise.resolve(true);
    }
    if (enableInFlight) {
      return enableInFlight;
    }
    if (enableState === "unavailable" && now() - lastEnableAttempt < enableRetryMs) {
      return Promise.resolve(false); // back off; status() carries the reason
    }
    lastEnableAttempt = now();
    enableState = "enabling";
    const attempt = Promise.resolve()
      .then(() => sendCommand("Network.enable", undefined, { timeoutMs: enableTimeoutMs }))
      .then(() => {
        enableState = "enabled";
        unavailableReason = null;
        enableInFlight = null;
        log("info", "Network domain enabled on the inspected app");
        announceStatus();
        return true;
      })
      .catch((error) => {
        // "Method not found." => network inspection is compiled out of this app;
        // the multi-host sentence comes from HostAgent.cpp:150. Both are the
        // backend's own words, surfaced verbatim instead of rewritten.
        setUnavailable(error.message);
        return false;
      });
    enableInFlight = attempt;
    return attempt;
  };

  // The bridge owns the socket, so a fresh debugger session shows up here as the
  // notifications it already fans out — no extra hook in that layer:
  //   Runtime.executionContextsCleared  app reload / instance swap (HostAgent.cpp:417)
  //   Network.disable                   host count changed (HostAgent.cpp:435)
  // Our enable went with the old session, so re-arm it.
  const sessionMayHaveChurned = (method) =>
    method === "Runtime.executionContextsCleared" || method === "Network.disable";

  const onAnyEvent = (params, method) => {
    const name = typeof method === "string" ? method : "";
    // Checked first: `Network.disable` is itself the backend switching the domain
    // off under us (the host-count broadcast), and it must not be swallowed by the
    // notification branch below, which has no record to update for it.
    if (observing && sessionMayHaveChurned(name)) {
      enableState = "idle";
      requestEnable();
      return;
    }
    if (name.startsWith("Network.")) {
      handleNotification(name, params);
    }
  };

  /** Start accumulating: subscribe to Network.* and ask the backend for them. */
  const start = () => {
    if (observing) {
      return;
    }
    observing = true;
    offEvents = onEvent("*", onAnyEvent);
    requestEnable();
  };

  const stop = () => {
    observing = false;
    if (offEvents) {
      offEvents();
      offEvents = null;
    }
  };

  // ── reads ──────────────────────────────────────────────────────────────────
  const list = () => [...records.values()];

  const get = (requestId) => records.get(requestId) || null;

  /**
   * The record as chrome.devtools.network hands it over: one HAR 1.2 entry.
   * Chrome's own extension API hands out HAR *entries* per request, and its
   * entries carry the fork-visible extras (`_resourceType`, `_transferSize`,
   * `_initiator`) that GraphQL Network Inspector reads.
   */
  const toHarEntry = (record) => {
    if (!record) {
      return null;
    }
    const start = Number.isFinite(record.timestamp) ? record.timestamp : 0;
    const end = Number.isFinite(record.finishedTimestamp)
      ? record.finishedTimestamp
      : Number.isFinite(record.responseTimestamp)
        ? record.responseTimestamp
        : undefined;
    const bodySize = record.dataLength > 0 ? record.dataLength : -1;
    return {
      // HAR's startedDateTime wants an ISO wall clock; RN reports unix seconds in
      // both `timestamp` and `wallTime` (NetworkHandler.cpp:78).
      startedDateTime: Number.isFinite(record.wallTime)
        ? new Date(record.wallTime * 1000).toISOString()
        : new Date(now()).toISOString(),
      time: end === undefined ? -1 : Math.max(0, (end - start) * 1000),
      // CDP gives one timestamp per lifecycle point, not Chrome's detailed
      // `timings` breakdown. blocked/dns/connect/ssl therefore stay -1 — HAR's
      // own "unknown" — instead of a fabricated low number.
      timings: {
        blocked: -1,
        dns: -1,
        ssl: -1,
        connect: -1,
        send: 0,
        wait: Number.isFinite(record.responseTimestamp)
          ? Math.max(0, (record.responseTimestamp - start) * 1000)
          : -1,
        receive:
          end !== undefined && Number.isFinite(record.responseTimestamp)
            ? Math.max(0, (end - record.responseTimestamp) * 1000)
            : -1,
      },
      cache: {},
      connection: undefined,
      _initiator: record.initiator,
      _resourceType: lowerType(record.resourceType),
      _transferSize: record.encodedDataLength > 0 ? record.encodedDataLength : -1,
      _requestId: record.requestId,
      request: {
        method: record.method,
        url: record.url,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: record.requestHeaders,
        queryString: record.queryString,
        postData:
          typeof record.postData === "string"
            ? {
                mimeType: contentTypeOf(record.requestHeaders) || "application/octet-stream",
                text: record.postData,
                size: byteLength(record.postData),
              }
            : undefined,
        headersSize: -1,
        bodySize: typeof record.postData === "string" ? byteLength(record.postData) : 0,
      },
      response: {
        // No response was ever reported (in flight, or failed before one
        // arrived): HAR's own "no value".
        status: record.responseTimestamp === undefined ? -1 : record.responseStatus,
        statusText: record.statusText,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: record.responseHeaders,
        content: {
          // HAR wants the body size here; the text itself is deliberately absent
          // ("request content is not provided as part of HAR for efficiency
          // reasons" — Chrome's own docs) and comes from getContent().
          size: bodySize,
          mimeType: record.mimeType || "x-rpced/x-none",
          compression: 0,
        },
        redirectURL: record.redirects.length
          ? record.redirects[record.redirects.length - 1].url
          : "",
        headersSize: -1,
        bodySize,
        _status: record.responseStatus,
      },
      serverIPAddress: "",
      pageref: "",
      _redirects: record.redirects.map((redirect) => redirect.status),
      _failure: record.failure
        ? { errorText: record.failure.errorText, canceled: record.failure.canceled }
        : undefined,
    };
  };

  /** Real HAR 1.2 (http://www.softwareishard.com/blog/har-12-spec/). */
  const buildHar = ({ urlFilter } = {}) => {
    const entries = list()
      .filter((record) => (urlFilter ? record.url.includes(urlFilter) : true))
      .map((record) => toHarEntry(record));
    return {
      log: {
        version: "1.2",
        creator: { name: "rozenite-shell", version: "0.1.0" },
        browser: { name: "rozenite-shell", version: "0.1.0" },
        pages: [
          {
            startedDateTime: new Date(now()).toISOString(),
            id: "page_1",
            title: "React Native app",
            pageTimings: { onContentLoad: -1, onLoad: -1 },
          },
        ],
        entries,
      },
    };
  };

  /**
   * One body, fetched lazily from the backend, honouring its `base64Encoded`
   * flag. Resolves `{available: false, error}` when there is nothing to give:
   * this is the call that used to return a hardcoded payload, so an empty answer
   * has to stay empty.
   */
  const getResponseBody = async (requestId) => {
    const record = records.get(requestId);
    if (!record) {
      return {
        available: false,
        error: `No request with requestId "${requestId}" is in this session's network model.`,
      };
    }
    try {
      const reply = await sendCommand("Network.getResponseBody", { requestId });
      const body = reply && typeof reply.body === "string" ? reply.body : undefined;
      if (body === undefined) {
        return { available: false, error: "Network.getResponseBody returned no body." };
      }
      record.bodySeen = true;
      return { available: true, body, base64Encoded: reply.base64Encoded === true };
    } catch (error) {
      // RN's own words for "the domain is off" and "that body is gone"
      // (NetworkIOAgent.cpp:503) pass through, so callers can tell them apart.
      return { available: false, error: error.message };
    }
  };

  /**
   * What a frame needs in order to be honest about an empty list: whether we are
   * asking for events at all, whether the backend accepted it, and why not.
   * `available` means the domain is live on this session — `requests` then tells
   * an idle-but-working capture apart from one that never started.
   */
  const status = () => ({
    available: enableState === "enabled",
    observing,
    enableState,
    reason: unavailableReason,
    requests: records.size,
    finished: list().filter((record) => record.status !== "pending").length,
  });

  /** Test/dev seam: feed a notification as if the backend had sent it. */
  const feed = (method, params) => handleNotification(method, params);

  /** Test seam: forget the accumulated history (a new app session). */
  const reset = () => {
    records.clear();
    enableState = "idle";
    unavailableReason = null;
    lastEnableAttempt = 0;
    enableInFlight = null;
  };

  return {
    start,
    stop,
    list,
    get,
    feed,
    reset,
    buildHar,
    toHarEntry,
    getResponseBody,
    requestEnable,
    status,
    networkEventNames: NETWORK_EVENTS,
    maxEntries,
  };
};

module.exports = {
  createNetworkModel,
  resourceTypeFromMime,
  headerListToPairs,
  queryStringFrom,
  contentTypeOf,
  byteLength,
  lowerType,
  NETWORK_EVENTS,
  DEFAULTS,
};
