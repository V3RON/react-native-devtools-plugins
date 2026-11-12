// The main-process network service: one CDP-derived network model, fanned out to
// extension frames over the async IPC substrate
// (docs/features/DEVTOOLS-NETWORK.md, docs/features/WEBREQUEST.md).
//
// Composition:
//   cdp-bridge (the RN debugger session)
//        │ onEvent("*")  ── Network.* ──►  network-model (this file's model)
//        │ sendCommand("Network.enable" / "Network.getResponseBody")
//        ▼
//   network-model  ── onObserved ──►  this service ──► interested extension frames
//
// Frames declare interest (`subscribe`) instead of the shell enabling the Network
// domain unconditionally: the frontend's own Network panel and Rozenite's
// middleware already send `Network.enable`, so this layer asks only when an
// extension actually looks, and reports the backend's refusal verbatim.
//
// Trust boundary: frame identity comes from the calling frame, never from payload
// (same pattern as the runtime-messaging handlers in ipc.js).
const { createNetworkModel } = require("./network-model");
const { toResourceType } = require("../chrome-shim/web-request");

// Lifecycle steps worth a message per request. `data` is deliberately not
// delivered: neither chrome.devtools.network nor chrome.webRequest has an event
// for it, and RN apps stream dataReceived per chunk.
const DELIVERED = new Set(["request", "sendHeaders", "response", "completed", "error"]);

/** The record as it crosses IPC: JSON-safe, with the webRequest vocabulary added. */
const serializeRecord = (record) => ({
  requestId: record.requestId,
  status: record.status,
  url: record.url,
  method: record.method,
  resourceType: record.resourceType,
  // chrome.webRequest's ResourceType, mapped in main so the shim stays free of
  // CDP vocabulary and every frame agrees on the mapping.
  webRequestType: toResourceType(record.resourceType),
  mimeType: record.mimeType,
  protocol: record.protocol,
  documentURL: record.documentURL,
  initiator: record.initiator,
  requestHeaders: record.requestHeaders,
  responseHeaders: record.responseHeaders,
  postData: record.postData,
  queryString: record.queryString,
  responseStatus: record.responseStatus,
  statusText: record.statusText,
  redirects: record.redirects,
  timestamp: record.timestamp,
  wallTime: record.wallTime,
  responseTimestamp: record.responseTimestamp,
  finishedTimestamp: record.finishedTimestamp,
  dataLength: record.dataLength,
  encodedDataLength: record.encodedDataLength,
  failure: record.failure,
  fromCache: record.fromCache,
});

/**
 * @param {object} deps
 * @param {(method: string, params?: object, opts?: object) => Promise<object>} deps.sendCommand
 * @param {(method: string, handler: Function) => Function} deps.onEvent
 * @param {() => {attached: boolean, target: object|null, clients: number}} [deps.bridgeStatus]
 *        the bridge's status, used for the onNavigated payload (RN has no URLs)
 * @param {(level: string, message: string) => void} [deps.log]
 * @param {number} [deps.maxEntries]
 */
const createNetworkService = ({
  sendCommand,
  onEvent,
  bridgeStatus = () => ({ attached: false, target: null, clients: 0 }),
  log = () => {},
  maxEntries,
} = {}) => {
  /** frameKey -> send(payload) — frames that asked for network data */
  const subscribers = new Map();
  /** last document URL seen on any request, for the onNavigated payload */
  let lastDocumentURL = "";

  const broadcast = (payload) => {
    for (const send of [...subscribers.values()]) {
      try {
        send(payload);
      } catch {
        // A frame that vanished mid-notification simply stops being addressed;
        // ipc.js retires it when the frame itself goes away.
      }
    }
  };

  const onObserved = (record, event, extra = {}) => {
    if (!DELIVERED.has(event) || subscribers.size === 0) {
      return;
    }
    if (typeof record.documentURL === "string" && record.documentURL) {
      lastDocumentURL = record.documentURL;
    }
    const settled = record.status !== "pending";
    broadcast({
      kind: "network",
      payload: {
        kind: event,
        record: serializeRecord(record),
        entry: settled ? model.toHarEntry(record) : undefined,
        redirect: extra.redirect || null,
        requestBody: extra.requestBody || null,
      },
    });
  };

  const model = createNetworkModel({
    sendCommand,
    onEvent,
    onObserved,
    // Availability flipped (domain came up, or the backend refused it): push the
    // new status so a frame's "no network data" note is never a guess and never
    // has to wait for the panel to ask.
    onStatusChange: () => {
      if (subscribers.size > 0) {
        broadcast({ kind: "network", payload: { kind: "status", status: model.status() } });
      }
    },
    log,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });

  // chrome.devtools.network.onNavigated: RN has no page navigations, so the
  // closest real signal is "the debugger is now looking at a different app
  // session" — a new Metro target, or the app's JS context being recreated
  // (bundle reload, HostAgent.cpp:417). Chrome fires it with a URL; the best
  // honest payload here is the debugger target's own identity, and the
  // divergence is documented in docs/features/DEVTOOLS-NETWORK.md.
  let lastNavigatedKey = null;
  const maybeNavigate = (cause) => {
    const target = bridgeStatus().target || {};
    const key = `${cause}:${target.id || target.title || lastDocumentURL || ""}`;
    if (key === lastNavigatedKey) {
      return;
    }
    lastNavigatedKey = key;
    broadcast({
      kind: "network",
      payload: {
        kind: "navigated",
        // "" when nothing is attached: an empty string is the honest answer,
        // a made-up URL is not.
        url: target.title || target.description || lastDocumentURL || "",
        cause,
      },
    });
  };

  const offBridgeEvents = onEvent("*", (params, method) => {
    if (method === "Runtime.executionContextsCleared" && subscribers.size > 0) {
      maybeNavigate("reload");
    }
  });

  const syncModelLifecycle = () => {
    if (subscribers.size > 0) {
      model.start();
    } else {
      model.stop();
    }
  };

  return {
    model,

    /** A frame wants network data (first listener / first getHAR). Idempotent. */
    subscribe(frameKey, send) {
      if (!subscribers.has(frameKey)) {
        subscribers.set(frameKey, send);
        syncModelLifecycle();
        // Tell the new subscriber what it cannot know yet: is there any network
        // data at all, and if not why. This is the visible-degradation channel.
        try {
          send({ kind: "network", payload: { kind: "status", status: model.status() } });
        } catch {
          /* frame already gone */
        }
        const target = bridgeStatus().target;
        if (target) {
          maybeNavigate("attach");
        }
      }
      return model.status();
    },

    unregisterFrame(frameKey) {
      if (subscribers.delete(frameKey)) {
        syncModelLifecycle();
      }
    },

    hasSubscriber(frameKey) {
      return subscribers.has(frameKey);
    },

    subscriberCount: () => subscribers.size,

    /** Push the current availability to everyone listening (status changes). */
    publishStatus() {
      broadcast({ kind: "network", payload: { kind: "status", status: model.status() } });
    },

    getHar: (options = {}) => model.buildHar(options),
    getStatus: () => model.status(),
    getBody: (requestId) => model.getResponseBody(requestId),
    list: () => model.list(),

    /** Test seam: a fresh app session (also used by the reload path). */
    reset: () => {
      model.reset();
      lastNavigatedKey = null;
    },

    dispose: () => {
      offBridgeEvents();
      subscribers.clear();
      model.stop();
    },
  };
};

module.exports = { createNetworkService, serializeRecord, DELIVERED };
