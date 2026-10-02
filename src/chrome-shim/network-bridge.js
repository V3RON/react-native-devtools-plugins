// The frame-side network APIs: `chrome.devtools.network` and `chrome.webRequest`
// built on ONE host-supplied network model (docs/features/DEVTOOLS-NETWORK.md,
// docs/features/WEBREQUEST.md).
//
// Both namespaces are consumers of the same main-process capture: the host
// delivers one message per lifecycle step of a request and this module decides
// which Chrome event it becomes. Nothing is invented here — when the host has no
// network data, `getNetworkStatus()` says so and the frame logs it once, instead
// of a panel silently showing an empty list that reads as "the app made no
// requests".
//
// Pure: no `window`, no `ipcRenderer`, no Electron, no transport (the layering
// rule in docs/ARCHITECTURE.md). The caller (src/preload/extension-frame.js)
// injects the async host calls and pushes deliveries in via `handleDelivery()`.
//
// Chrome semantics honoured here (docs/api/CHROME-EXTENSION-APIS.md §C): real
// Event objects from ./event.js (dedupe, identity removal, hasListener), promise
// AND callback styles on the async methods, and webRequest's
// `addListener(callback, filters, opt_extraInfoSpec)` signature — with filters
// matched locally (./web-request.js) and `opt_extraInfoSpec` answered honestly:
// nothing blocks.
const { createEvent } = require("./event");
const {
  EMITTED,
  SILENT,
  toRequestDetails,
  toRequestBody,
  toHeaderList,
  listenerMatches,
} = require("./web-request");

// Chrome's own redirect range: a 3xx response announces itself as
// onBeforeRedirect rather than onResponseStarted.
const isRedirectStatus = (status) => Number.isFinite(status) && status >= 300 && status < 400;

/**
 * Which webRequest events one host delivery produces. The `request` step carries
 * `onBeforeSendHeaders` too: RN reports a request together with its headers
 * (`react/networking/NetworkReporter.cpp:57`), so there is no earlier "headers not
 * attached yet" moment to separate the two events into.
 */
const webRequestEventsFor = (delivery) => {
  const record = delivery.record || {};
  switch (delivery.kind) {
    case "request":
      return delivery.redirect
        ? ["onBeforeRedirect", "onBeforeRequest", "onBeforeSendHeaders"]
        : ["onBeforeRequest", "onBeforeSendHeaders"];
    case "sendHeaders":
      return ["onSendHeaders"];
    case "response":
      return isRedirectStatus(record.responseStatus)
        ? ["onBeforeRedirect"]
        : ["onResponseStarted"];
    case "completed":
      return ["onCompleted"];
    case "error":
      return ["onErrorOccurred"];
    default:
      return [];
  }
};

/**
 * chrome.webRequest's `details` for one delivery, with the event's own fields.
 * `eventName` matters for one case: a redirect re-announcement feeds both
 * onBeforeRedirect (which describes the 3xx hop) and the new request's
 * onBeforeRequest (which is about the hop that follows), and the two cannot share
 * one details object.
 */
const detailsFor = (delivery, eventName) => {
  const record = delivery.record || {};
  const overrides = {};
  if (eventName === "onBeforeRedirect" && delivery.kind === "request" && delivery.redirect) {
    // Chrome's onBeforeRedirect carries the URL that answered 3xx, its status and
    // its headers, plus the target. CDP reports exactly that on the
    // re-announcement (Network.redirectResponse), so nothing has to be inferred.
    overrides.url = delivery.redirect.fromUrl || record.url;
    overrides.statusCode = delivery.redirect.status;
    overrides.statusLine = ["HTTP/1.1", delivery.redirect.status, delivery.redirect.statusText]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    overrides.redirectUrl = delivery.redirect.url;
    overrides.responseHeaders = toHeaderList(delivery.redirect.headers);
  }
  if (delivery.kind === "response" || delivery.kind === "completed") {
    overrides.statusCode = record.responseStatus;
    overrides.statusLine = [
      record.protocol || "HTTP/1.1",
      record.responseStatus,
      record.statusText,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    if (isRedirectStatus(record.responseStatus)) {
      overrides.redirectUrl =
        (record.redirects.length && record.redirects[record.redirects.length - 1].url) ||
        record.url;
    }
  }
  if (delivery.kind === "error") {
    const errorText = (record.failure && record.failure.errorText) || "net::ERR_FAILED";
    // Chrome reports net::ERR_ABORTED as `canceled`, not as an error.
    if (/ABORTED/i.test(errorText)) {
      overrides.canceled = true;
    } else {
      overrides.error = errorText;
    }
  }
  if (delivery.kind === "request") {
    const body = toRequestBody(record.postData);
    if (body) {
      overrides.requestBody = body;
    }
  }
  return toRequestDetails(record, overrides);
};

/**
 * @param {object} deps every one optional — absent means "the host cannot answer",
 *        which surfaces as an explicit reason rather than a fabricated value.
 * @param {() => Promise<object>} [deps.subscribe] ask the host to start sending
 *        this frame network data; the lazy CDP `Network.enable` lives behind it
 * @param {() => Promise<object>} [deps.getNetworkStatus] host status:
 *        `{available, observing, enableState, reason, requests, finished}`
 * @param {(options?: object) => Promise<object>} [deps.fetchHar] host HAR log
 * @param {(requestId: string) => Promise<{available: boolean, body?: string, base64Encoded?: boolean, error?: string}>} [deps.fetchBody]
 *        lazy body lookup (CDP `Network.getResponseBody` behind it)
 * @param {object} [deps.logger]
 */
const createNetworkBridge = ({
  subscribe,
  getNetworkStatus,
  fetchHar,
  fetchBody,
  logger = console,
} = {}) => {
  /** webRequest listener registry: event name -> [{callback, filters}] */
  const registry = new Map();
  const registryFor = (name) => {
    if (!registry.has(name)) {
      registry.set(name, []);
    }
    return registry.get(name);
  };

  let blockingWarned = false;
  const warnOnceAboutBlocking = (extraInfoSpec) => {
    // Only `blocking` is worth a note: the other values Chrome documents
    // (requestBody, responseHeaders) are read-only hints this host does answer,
    // and complaining about them would be noise.
    if (!Array.isArray(extraInfoSpec) || !extraInfoSpec.includes("blocking") || blockingWarned) {
      return;
    }
    blockingWarned = true;
    logger.warn(
      `[chrome.webRequest] "blocking" requested, but this host is observe-only: RN ` +
        "backends implement no CDP Fetch domain, so a listener can never block, cancel " +
        "or rewrite a request (docs/features/WEBREQUEST.md)."
    );
  };

  let hostStatus = {
    available: false,
    observing: false,
    enableState: "idle",
    reason: null,
    requests: 0,
  };
  let warnedAboutStatus = false;
  const rememberStatus = (status) => {
    if (!status || typeof status !== "object") {
      return;
    }
    hostStatus = status;
    // Only a refusal explains an empty list. "idle" (nobody asked) and "enabling"
    // (the CDP command is still on the wire) are not verdicts, and warning about
    // them would tell a panel that its data is missing a moment before it arrives.
    if (warnedAboutStatus || hostStatus.enableState !== "unavailable") {
      return;
    }
    warnedAboutStatus = true;
    logger.warn(
      "[devtools.network] no network data from the inspected app" +
        (hostStatus.reason ? `: ${hostStatus.reason}` : "") +
        " — the request list stays empty until the CDP Network domain is available " +
        "(docs/features/DEVTOOLS-NETWORK.md)."
    );
  };

  /** Lazy and single-flight: nobody pays for Network.enable until someone looks. */
  let subscribeCall = null;
  const ensureSubscribed = () => {
    if (typeof subscribe !== "function") {
      return Promise.resolve(null);
    }
    if (!subscribeCall) {
      subscribeCall = Promise.resolve()
        .then(() => subscribe())
        .then((status) => {
          rememberStatus(status);
          return status;
        })
        .catch(() => null);
    }
    return subscribeCall;
  };

  // Chrome's Event semantics plus the filter list its signature accepts.
  const makeWebRequestEvent = (name, { emitted = true } = {}) => {
    const event = createEvent();
    const entries = registryFor(name);
    return {
      addListener(callback, filters, extraInfoSpec) {
        event.addListener(callback);
        if (emitted && !entries.some((entry) => entry.callback === callback)) {
          entries.push({ callback, filters });
        }
        warnOnceAboutBlocking(extraInfoSpec);
        ensureSubscribed();
      },
      removeListener(callback) {
        event.removeListener(callback);
        const index = entries.findIndex((entry) => entry.callback === callback);
        if (index !== -1) {
          entries.splice(index, 1);
        }
      },
      hasListener: (callback) => event.hasListener(callback),
      hasListeners: () => event.hasListeners(),
      // Internal: fire only the listeners whose filters accept this event.
      _dispatch: (details) => {
        if (!emitted) {
          return;
        }
        for (const entry of [...entries]) {
          if (listenerMatches(details, entry.filters)) {
            entry.callback(details);
          }
        }
      },
    };
  };

  const webRequest = {};
  for (const name of EMITTED) {
    webRequest[name] = makeWebRequestEvent(name);
  }
  for (const name of SILENT) {
    // Chrome's shape, permanently quiet on this backend: registering is allowed
    // (so feature detection and removeListener keep working) but no CDP
    // notification exists on RN that could feed it. Documented in WEBREQUEST.md.
    webRequest[name] = makeWebRequestEvent(name, { emitted: false });
  }

  // ── devtools.network ───────────────────────────────────────────────────────
  const finished = createEvent();
  const navigated = createEvent();

  // Chrome's Event contract, wrapped so that registering a listener is also the
  // moment this frame asks the host for network data.
  const subscribing = (event) => ({
    addListener: (fn) => {
      event.addListener(fn);
      ensureSubscribed();
    },
    removeListener: event.removeListener,
    hasListener: event.hasListener,
    hasListeners: event.hasListeners,
  });

  /**
   * A `Request`, in Chrome's sense: the HAR entry for one request plus the lazy
   * content accessors HAR deliberately omits ("request content is not provided as
   * part of HAR for efficiency reasons" — Chrome's own docs).
   */
  const makeRequest = (entry, requestId) => {
    const id = requestId ?? (entry && entry._requestId);
    const loadContent = (callback) => {
      const settled = Promise.resolve()
        .then(() => (typeof fetchBody === "function" ? ensureSubscribed().then(() => fetchBody(id)) : null))
        .then((reply) => {
          if (!reply || reply.available !== true) {
            // No body is invented to keep a panel happy: the caller gets null and
            // the console gets the backend's own reason.
            const reason = (reply && reply.error) || "the host has no body for this request";
            logger.warn(`[devtools.network] no response body for ${id}: ${reason}`);
            return { content: null, encoding: null };
          }
          return {
            content: reply.body,
            encoding: reply.base64Encoded ? "base64" : null,
          };
        });
      if (typeof callback === "function") {
        settled.then((result) => callback(result.content, result.encoding));
        return undefined; // Chrome: callback style returns nothing
      }
      return settled;
    };

    // Chrome's accessor for the HAR entry behind a `Request`. The object a listener
    // receives *is* that entry, so this hands back its own HAR fields without the
    // accessors rather than inventing a second representation. The accessor-free
    // copy keeps a panel replacing a top-level field from writing back through an
    // object the host still uses.
    const request = {
      ...(entry || {}),
      requestId: id,
      getContent: loadContent,
      // Chrome's alias, same behavior.
      getRequestContent: loadContent,
      getHarEntry: () => {
        const { getContent, getRequestContent, getHarEntry, ...harEntry } = request;
        return harEntry;
      },
    };
    return request;
  };

  /**
   * Chrome hands the HAR *log* to `getHAR`'s callback (callers read
   * `harLog.entries`), while the HAR 1.2 spec wraps that log in `{log: …}` for
   * files and viewers. Both spellings address the same real entries here, so
   * neither style of consumer has to guess.
   */
  const asHarLog = (har) => {
    const log =
      (har && (har.log || har)) || {
        version: "1.2",
        creator: { name: "rozenite-shell" },
        entries: [],
      };
    const harLog = {
      ...log,
      entries: (Array.isArray(log.entries) ? log.entries : []).map((entry) =>
        makeRequest(entry, entry && entry._requestId)
      ),
    };
    return { ...harLog, log: harLog };
  };

  const getHAR = (optionsOrCallback, maybeCallback) => {
    const callback =
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback || {};
    const run = () =>
      ensureSubscribed().then(() =>
        typeof fetchHar === "function" ? Promise.resolve(fetchHar(options)).then(asHarLog) : asHarLog(null)
      );
    // Chrome's getHAR never fails: a host that cannot answer yields an empty log.
    const onError = (error) => {
      logger.warn(`[devtools.network.getHAR] ${error.message}`);
      return asHarLog(null);
    };
    if (typeof callback === "function") {
      run().then(callback, (error) => callback(onError(error)));
      return undefined; // Chrome: callback style returns nothing
    }
    return run().catch(onError);
  };

  const network = {
    onRequestFinished: subscribing(finished),
    // Fires when the debugger starts looking at a different app session (bundle
    // reload / target change). RN has no page navigations, so the payload is the
    // debugger target's own description and may be "" — divergence documented in
    // docs/features/DEVTOOLS-NETWORK.md.
    onNavigated: subscribing(navigated),
    getHAR,
    /**
     * Shell addition (Chrome needs no such method): the honest "is there any
     * network data at all" answer, so a panel can print "no network data from the
     * inspected app: <reason>" instead of an unexplained empty list. Promise +
     * callback styles, like every other async API in this shim.
     */
    getNetworkStatus(callback) {
      const run = () =>
        ensureSubscribed().then(() =>
          typeof getNetworkStatus === "function"
            ? Promise.resolve(getNetworkStatus()).then((status) => {
                rememberStatus(status);
                return hostStatus;
              })
            : hostStatus
        );
      if (typeof callback === "function") {
        run().then(
          (status) => callback(status),
          () => callback(hostStatus)
        );
        return undefined;
      }
      return run();
    },
    /**
     * Shell addition, mirroring the body accessor the vendored frontend's own
     * extension API exposes (`getRequestContent` by id): content by entry rather
     * than by listener argument.
     */
    getResponseBody(request, callback) {
      const isEntry = request && typeof request === "object";
      const requestObject = makeRequest(isEntry ? request : null, isEntry ? undefined : request);
      if (typeof callback === "function") {
        requestObject.getContent((content, encoding) => callback(content, encoding));
        return undefined;
      }
      return requestObject.getContent();
    },
  };

  // ── host deliveries ────────────────────────────────────────────────────────
  /**
   * One lifecycle step of one request, as reported by the host
   * (src/main/network-service.js). `kind` is one of
   * request | sendHeaders | response | completed | error | navigated | status.
   */
  const handleDelivery = (delivery) => {
    if (!delivery || typeof delivery !== "object" || typeof delivery.kind !== "string") {
      return;
    }
    if (delivery.kind === "navigated") {
      navigated._fire(delivery.url || "");
      return;
    }
    if (delivery.kind === "status") {
      rememberStatus(delivery.status);
      return;
    }
    const record = delivery.record;
    if (!record || !record.requestId) {
      return;
    }

    // chrome.webRequest: observe-only, filters applied locally.
    for (const name of webRequestEventsFor(delivery)) {
      const details = detailsFor(delivery, name);
      webRequest[name]._dispatch(details);
    }

    // chrome.devtools.network: Chrome fires onRequestFinished for failed requests
    // too — the entry says so through `response.status: -1` and `_failure`, both
    // filled in by the model from the backend's own notification.
    if (delivery.kind === "completed" || delivery.kind === "error") {
      finished._fire(makeRequest(delivery.entry, record.requestId));
    }
  };

  return {
    webRequest,
    network,
    handleDelivery,
    /** Test seam: the status the frame last heard from the host. */
    _hostStatus: () => hostStatus,
  };
};

module.exports = { createNetworkBridge, detailsFor, webRequestEventsFor, isRedirectStatus };
