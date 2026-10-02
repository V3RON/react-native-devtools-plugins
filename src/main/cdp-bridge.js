// The shell-owned CDP bridge: main process holds the React Native debugger
// session and hands the frontend a plain WebSocket to talk to it through
// (docs/features/INSPECTED-WINDOW.md, docs/features/DISPATCH-CHANNEL.md).
//
// Why this exists: the frontend opens its CDP connection itself — with `?ws=`
// in its URL (src/main/config.js) the frontend build picks
// core/sdk/WebSocketConnection, so `InspectorFrontendHost.sendMessageToBackend`
// is never called and the host cannot reach the backend *through* the frontend.
// The bridge therefore sits on the wire: the frontend connects to this server,
// and this module owns the upstream socket to Metro's inspector proxy.
//
// Topology (one upstream, one frontend client at a time — see handleClient):
//
//   RN app ⇄ Metro /inspector/debug?device=…&page=… ⇄ THIS BRIDGE ⇄ frontend
//                                                      ▲
//                                                      └── host commands (sendCommand)
//
// Host commands ride the *same* backend session the frontend owns: the bridge
// multiplexes by message id instead of opening a second debugger connection, so
// the app never learns that a second debugger exists.
//
// Id discipline is what keeps the two clients from corrupting each other: the
// frontend allocates 1,2,3,… (`nextMessageId()` in its core/protocol_client) and
// never goes near HOST_ID_BASE, so a reply whose id is in the host range belongs
// to the bridge and is NOT forwarded to the frontend. Everything else relays
// verbatim in both directions.
//
// Everything that used to live in src/tools/rn-cdp.js is here: Metro
// /json/list discovery, the 127.0.0.1 Origin guard, the re-attach loop, and the
// bounded buffer for messages that arrive while upstream is (re)connecting.
// rn-cdp.js is now a thin CLI around this module, so there is one relay.
//
// No Electron and no config import at the factory level: transports, timers and
// logging are injectable, which is what lets tests/cdp-bridge.test.js run this
// against a fake upstream WebSocket server in the same process.
const WebSocket = require("ws");
const { default: nodeFetch } = require("node-fetch");

// Host-owned CDP message ids. `>= HOST_ID_BASE` is host territory: the frontend
// counts up from 1 and would need ~9 quadrillion commands to reach it. The
// backend's own internal ids (jsinspector-modern's HostCommandSender) start at 1
// too, but they never leave the device.
const HOST_ID_BASE = 1e15;

const DEFAULTS = {
  metroHost: "127.0.0.1",
  metroPort: 8081,
  // undefined -> bind every interface, as src/tools/rn-cdp.js did.
  listenHost: undefined,
  listenPort: 9223,
  pollIntervalMs: 1500,
  // Messages arriving while upstream is reconnecting must not be lost: the
  // frontend fires Runtime.enable/Debugger.enable immediately on connect.
  maxBufferedSends: 1000,
  requestTimeoutMs: 10000,
};

/**
 * @param {object} [options]
 * @param {string} [options.metroHost]          Metro dev-server host
 * @param {number} [options.metroPort]          Metro dev-server port
 * @param {string} [options.listenHost]         bind address for frontend clients
 * @param {number} [options.listenPort]         port the frontend dials (`?ws=`)
 * @param {string|null} [options.app]           substring filter on /json/list app
 * @param {string|null} [options.device]        substring filter on /json/list device
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {boolean} [options.enabled]           false -> owns nothing (external relay mode)
 * @param {Function} [options.WebSocket]        ws-compatible implementation (tests)
 * @param {Function} [options.fetch]            fetch-compatible implementation (tests)
 * @param {Function} [options.log]              (level, message) => void
 */
const createCdpBridge = (options = {}) => {
  const {
    metroHost,
    metroPort,
    listenHost,
    listenPort,
    pollIntervalMs,
    maxBufferedSends,
    requestTimeoutMs,
    app: appFilter = null,
    device: deviceFilter = null,
    enabled = true,
    WebSocket: WS = WebSocket,
    fetch = nodeFetch,
    log = () => {},
  } = { ...DEFAULTS, ...options };

  /** @type {Set<object>} frontend connections */
  const clients = new Set();
  /** @type {Map<number, {method: string, resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();
  /** @type {Map<string, Set<Function>>} CDP method | "*" -> handlers */
  const handlers = new Map();
  /** @type {object|null} upstream (Metro inspector-proxy) socket */
  let upstream = null;
  let server = null;
  let stopped = false;
  let attachLoopRunning = false;
  let hostIdSeq = 0;
  let target = null;
  /** Messages from the frontend that could not go out yet (bounded). */
  const pendingSends = [];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isOpen = (socket) => !!socket && socket.readyState === WS.OPEN;

  // ── outgoing ─────────────────────────────────────────────────────────────
  const broadcastToFrontend = (message) => {
    for (const client of clients) {
      if (isOpen(client)) {
        client.send(message);
      }
    }
  };

  const upstreamSend = (message) => {
    if (isOpen(upstream)) {
      upstream.send(message);
    } else if (pendingSends.length < maxBufferedSends) {
      pendingSends.push(message);
    } else {
      log("warn", "CDP bridge: dropped a message, reconnect buffer full");
    }
  };

  // ── incoming: upstream -> (host pending map | frontend) ───────────────────
  const settlePending = (id, error, result) => {
    const entry = pending.get(id);
    if (!entry) {
      return false;
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) {
      entry.reject(error);
    } else {
      entry.resolve(result);
    }
    return true;
  };

  const emitEvent = (method, params) => {
    for (const handler of [...(handlers.get(method) || [])]) {
      try {
        handler(params || {}, method);
      } catch (error) {
        log("error", `CDP event handler for ${method} threw: ${error.message}`);
      }
    }
    for (const handler of [...(handlers.get("*") || [])]) {
      try {
        handler(params || {}, method);
      } catch (error) {
        log("error", `CDP event handler threw: ${error.message}`);
      }
    }
  };

  const onUpstreamMessage = (raw) => {
    const text = String(raw);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // Not JSON: nothing to correlate against, so relay it as-is rather than
      // drop data we do not understand.
      broadcastToFrontend(text);
      return;
    }
    if (!message || typeof message !== "object") {
      broadcastToFrontend(text);
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      // Reply to a host command: the frontend never sent it, so it must not see
      // it (an unexpected response id is a protocol error on that side).
      const { method } = pending.get(message.id);
      if (message.error) {
        const error = new Error(
          `${method}: ${message.error.message || "CDP error"}`
        );
        error.code = message.error.code;
        error.method = method;
        settlePending(message.id, error, undefined);
      } else {
        settlePending(message.id, null, message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      emitEvent(message.method, message.params);
    }
    // Replies the frontend is waiting for, plus every notification: untouched.
    broadcastToFrontend(text);
  };

  // ── upstream lifecycle ───────────────────────────────────────────────────
  const rejectAllPending = (reason) => {
    for (const [id, entry] of [...pending]) {
      if (!pending.delete(id)) {
        continue;
      }
      clearTimeout(entry.timer);
      const error = new Error(`${entry.method}: ${reason}`);
      error.code = "DETACHED";
      entry.reject(error);
    }
  };

  const findTarget = async () => {
    let entries;
    try {
      const response = await fetch(`http://${metroHost}:${metroPort}/json/list`);
      entries = await response.json();
    } catch {
      return null; // Metro not up yet
    }
    if (!Array.isArray(entries)) {
      return null;
    }
    const pages = entries.filter(
      (t) =>
        t &&
        t.type === "node" &&
        t.webSocketDebuggerUrl &&
        (!appFilter || (t.description || t.appId || "").includes(appFilter)) &&
        (!deviceFilter || (t.deviceName || "").includes(deviceFilter))
    );
    return pages[0] || null;
  };

  const openUpstream = (url) =>
    new Promise((resolve) => {
      // Both RN's inspector proxy (origin allowlist) and Expo's extra guard
      // (origin host must equal the dev server's own host) are satisfied by a
      // 127.0.0.1 / loopback Origin.
      const candidate = new WS(url, {
        headers: { Origin: `http://${metroHost}:${metroPort}` },
      });
      candidate.on("open", () => resolve(candidate));
      candidate.on("error", (error) => {
        log("warn", `CDP upstream failed: ${error.message}`);
        resolve(null);
      });
    });

  const attachLoop = async () => {
    // One loop per bridge: start() after stop() must not stack loops, or two of
    // them would race to open upstream sockets.
    if (attachLoopRunning) {
      return;
    }
    attachLoopRunning = true;
    try {
      await pollAndAttach();
    } finally {
      attachLoopRunning = false;
    }
  };

  const pollAndAttach = async () => {
    while (!stopped) {
      if (!isOpen(upstream)) {
        const found = await findTarget();
        if (!found) {
          target = null;
          await sleep(pollIntervalMs);
          continue;
        }
        target = found;
        log("info", `CDP bridge attaching to: ${found.webSocketDebuggerUrl}`);
        const socket = await openUpstream(found.webSocketDebuggerUrl);
        if (!socket) {
          target = null;
          await sleep(pollIntervalMs); // device/page may have changed
          continue;
        }
        if (stopped) {
          // stop() landed while we were connecting: don't adopt this socket.
          socket.close();
          return;
        }
        upstream = socket;
        socket.on("message", onUpstreamMessage);
        socket.on("close", (code, reason) => {
          if (upstream === socket) {
            upstream = null;
            target = null;
          }
          rejectAllPending(
            `session closed (${code} ${String(reason) || "no reason"})`
          );
          log("info", "CDP bridge detached, waiting for the app to come back…");
        });
        socket.on("error", (error) =>
          log("warn", `CDP upstream error: ${error.message}`)
        );
        // Flush what the frontend sent while we were (re)connecting.
        const queued = pendingSends.splice(0, pendingSends.length);
        for (const message of queued) {
          socket.send(message);
        }
        log("info", "CDP bridge attached");
      }
      await sleep(pollIntervalMs);
    }
  };

  // ── frontend clients ─────────────────────────────────────────────────────
  // Last connection wins. A CDP session cannot be shared: two frontend pages
  // would both allocate ids from 1 and both see the other's replies and events,
  // so the second connection replaces the first (same rule Chrome applies when a
  // second DevTools attaches to one target). A reconnect is safe — the discarded
  // socket is the one being replaced anyway.
  const handleClient = (client) => {
    for (const previous of clients) {
      log("info", "CDP bridge: replacing the previous frontend connection");
      previous.close(1000, "replaced by a new frontend connection");
    }
    clients.clear();
    clients.add(client);
    log("info", `CDP bridge: frontend connected (${clients.size} client(s))`);
    client.on("message", (raw) => upstreamSend(String(raw)));
    client.on("close", () => {
      clients.delete(client);
      log("info", `CDP bridge: frontend disconnected (${clients.size} client(s))`);
      // The upstream session deliberately stays open: reloading the frontend
      // must not churn the device's debugger session.
    });
    client.on("error", () => clients.delete(client));
  };

  // ── host-side API ────────────────────────────────────────────────────────
  /**
   * Send a CDP command over the frontend's session and wait for its reply.
   * Rejects when no session is attached, when the backend answers with an
   * error, or after the timeout — it never resolves with invented data.
   */
  const sendCommand = (method, params, { timeoutMs } = {}) => {
    if (stopped || !enabled) {
      return Promise.reject(
        new Error(`${method}: CDP bridge is not running (external relay mode?)`)
      );
    }
    if (!isOpen(upstream)) {
      return Promise.reject(new Error(`${method}: no CDP session is attached`));
    }
    const id = HOST_ID_BASE + ++hostIdSeq;
    const message = { id, method };
    if (params !== undefined) {
      message.params = params;
    }
    const budget = timeoutMs || requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          const error = new Error(
            `${method}: timed out after ${budget}ms without a reply`
          );
          error.code = "TIMEOUT";
          reject(error);
        }
      }, budget);
      pending.set(id, { method, resolve, reject, timer });
      upstream.send(JSON.stringify(message));
    });
  };

  /**
   * Subscribe to CDP notifications on this session. `method` is exact
   * ("Network.requestWillBeSent") or "*" for every notification.
   * @returns {Function} unsubscribe
   */
  const onEvent = (method, handler) => {
    if (typeof method !== "string" || typeof handler !== "function") {
      throw new TypeError("onEvent(method: string, handler: function)");
    }
    if (!handlers.has(method)) {
      handlers.set(method, new Set());
    }
    handlers.get(method).add(handler);
    return () => {
      handlers.get(method)?.delete(handler);
    };
  };

  // ── control ──────────────────────────────────────────────────────────────
  const start = () => {
    if (!enabled) {
      log(
        "info",
        "CDP bridge disabled — leaving the socket to the frontend (external relay mode)"
      );
      return Promise.resolve(false);
    }
    if (server) {
      return Promise.resolve(true);
    }
    stopped = false;
    return new Promise((resolve, reject) => {
      const instance = new WS.Server(
        listenHost ? { port: listenPort, host: listenHost } : { port: listenPort }
      );
      instance.once("listening", () => {
        server = instance;
        log(
          "info",
          `CDP bridge listening on ws://localhost:${listenPort} (Metro: ${metroHost}:${metroPort})`
        );
        attachLoop().catch((error) => log("error", `CDP bridge attach loop: ${error}`));
        resolve(true);
      });
      instance.on("connection", handleClient);
      instance.on("error", (error) => {
        if (!server) {
          reject(error);
          return;
        }
        log("error", `CDP bridge server error: ${error.message}`);
      });
    });
  };

  const stop = () => {
    stopped = true;
    for (const client of clients) {
      client.close();
    }
    clients.clear();
    if (upstream) {
      upstream.close();
      upstream = null;
    }
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      clearTimeout(entry.timer);
      const error = new Error(`${entry.method}: bridge stopped`);
      error.code = "DETACHED";
      entry.reject(error);
    }
    pendingSends.length = 0;
    const closing = server
      ? new Promise((resolve) => server.close(() => resolve(true)))
      : Promise.resolve(false);
    server = null;
    return closing;
  };

  return {
    start,
    stop,
    sendCommand,
    onEvent,
    isAttached: () => isOpen(upstream),
    /** @returns {{attached: boolean, target: object|null, clients: number}} */
    status: () => ({ attached: isOpen(upstream), target, clients: clients.size }),
  };
};

// ── process singleton (built from config; nothing binds until start()) ─────
const config = require("./config");

const bridge = createCdpBridge({
  ...config.cdpBridge,
  log: (level, message) => {
    const line = `[cdp-bridge] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  },
});

module.exports = {
  createCdpBridge,
  HOST_ID_BASE,
  DEFAULTS,
  bridge,
  start: bridge.start,
  stop: bridge.stop,
  sendCommand: bridge.sendCommand,
  onEvent: bridge.onEvent,
  isAttached: bridge.isAttached,
  status: bridge.status,
};
