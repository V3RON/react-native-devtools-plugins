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
// Topology (one upstream, ONE frontend client at a time — see handleClient):
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
// WHO MAY TALK TO THIS SOCKET (docs/SECURITY-PLATFORM.md F3): the socket is the
// inspected app's debugger session, so `Runtime.evaluate` on it is arbitrary code
// in the developer's app and `Network.*` is their traffic. It is therefore bound
// to loopback and gated on the WebSocket `Origin` (see `verifyClient`) —
// a browser sends an `Origin` a web page cannot forge, which is what stops *any*
// page the developer happens to have open from becoming the debugger.
//
// No Electron and no config import at the factory level: transports, timers and
// logging are injectable, which is what lets tests/cdp-bridge.test.js run this
// against a fake upstream WebSocket server in the same process.
const WebSocket = require("ws");
const net = require("net");
const { default: nodeFetch } = require("node-fetch");

// Host-owned CDP message ids. `>= HOST_ID_BASE` is host territory: the frontend
// counts up from 1 and would need ~9 quadrillion commands to reach it. The
// backend's own internal ids (jsinspector-modern's HostCommandSender) start at 1
// too, but they never leave the device.
const HOST_ID_BASE = 1e15;

// Application-defined close code (`ws` allows 4000-4999): "the session already has
// an owner". Distinct from 1000/1001 so a frontend can tell a refusal from the
// bridge shutting down, and the frontend's own reconnect logic can decide whether
// retrying is pointless (docs/SECURITY-PLATFORM.md F3).
const REFUSE_CLOSE_CODE = 4001;

const DEFAULTS = {
  metroHost: "127.0.0.1",
  metroPort: 8081,
  // Loopback only (docs/SECURITY-PLATFORM.md F3): this socket IS the inspected
  // app's debugger session, so binding every interface hands `Runtime.evaluate`
  // to anyone on the LAN. Both loopbacks because the frontend dials
  // `?ws=localhost:…` and `localhost` may resolve to either family — binding
  // both removes the question rather than depending on resolver fallback.
  // An explicit `listenHost` is the documented opt-in for remote-device work.
  listenHost: ["127.0.0.1", "::1"],
  listenPort: 9223,
  pollIntervalMs: 1500,
  // Messages arriving while upstream is reconnecting must not be lost: the
  // frontend fires Runtime.enable/Debugger.enable immediately on connect.
  maxBufferedSends: 1000,
  requestTimeoutMs: 10000,
  // No browser origin is trusted by the factory itself: the caller decides who
  // the frontend is (the singleton below passes the origin of `config.frontendURL`
  // plus `DEVTOOLS_CDP_ALLOWED_ORIGINS`).
  allowedOrigins: [],
  // How long the current owner has to answer a liveness ping before a newcomer may
  // take the session. See `handleClient` for why a refusal needs a probe at all.
  probeTimeoutMs: 1000,
};

/** Loopback peer test for an Origin-less upgrade (a CLI/tool/test dial). */
const isLoopbackAddress = (address) => {
  const value = String(address || "").replace(/^::ffff:/i, "");
  if (net.isIPv4(value)) {
    return value.startsWith("127.");
  }
  if (net.isIPv6(value)) {
    return value === "::1";
  }
  return false;
};

/**
 * The whole access rule for one upgrade request, as a pure function so it can be
 * tested for peers the loopback bind makes unreachable in a test (and so
 * `verifyClient` below is wiring, not policy).
 *
 *   - an `Origin` in the allowlist          -> the frontend, accepted;
 *   - no `Origin` AND a loopback peer       -> a local non-browser client
 *     (`npm run rn-cdp`'s CLI shape, a test, curl). A browser CANNOT hide an
 *     Origin, so its absence is evidence of a tool on this machine, not of an
 *     attacker;
 *   - anything else                         -> refused.
 *
 * A browser sends `Origin` on every WebSocket upgrade and a page cannot set that
 * header itself — CORS does not apply to WebSockets, which is precisely why any
 * page used to be able to dial this socket and become the frontend
 * (docs/SECURITY-PLATFORM.md F3).
 */
const upgradeAllowed = ({ origin, peerAddress, allowedOrigins }) => {
  if (origin) {
    return allowedOrigins.has(origin);
  }
  return isLoopbackAddress(peerAddress);
};

/**
 * @returns {string[]} the addresses to bind. Empty/undefined (the config default)
 * means "nobody said": the loopback default applies. An explicit host is an
 * opt-in for remote-device development, and binding it is exactly what
 * `verifyClient` + a firewall are for.
 */
const normalizeListenHosts = (listenHost) => {
  const hosts = (Array.isArray(listenHost) ? listenHost : [listenHost]).filter(
    (host) => typeof host === "string" && host !== ""
  );
  return hosts.length > 0 ? hosts : DEFAULTS.listenHost;
};

/**
 * @param {object} [options]
 * @param {string} [options.metroHost]          Metro dev-server host
 * @param {number} [options.metroPort]          Metro dev-server port
 * @param {string|string[]} [options.listenHost] bind address(es) for frontend
 *                                               clients; loopback by default
 * @param {number} [options.listenPort]         port the frontend dials (`?ws=`)
 * @param {string|string[]} [options.allowedOrigins] browser origins allowed on
 *                                               the upgrade (the frontend's own)
 * @param {number} [options.probeTimeoutMs]     how long the current owner has to
 *                                               answer a liveness ping
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
    allowedOrigins,
    probeTimeoutMs,
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

  // The frontend's origin(s) plus anything the operator vouched for. A browser
  // always sends `Origin` on a WebSocket upgrade and a page cannot forge it, so
  // this list is what separates the frontend from "some page the developer has
  // open" (docs/SECURITY-PLATFORM.md F3).
  const origins = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins])
      .filter((origin) => typeof origin === "string")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== "")
  );

  const listenHosts = normalizeListenHosts(listenHost);

  /** @type {Map<number, {method: string, resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();
  /** @type {Map<string, Set<Function>>} CDP method | "*" -> handlers */
  const handlers = new Map();
  /** @type {object|null} upstream (Metro inspector-proxy) socket */
  let upstream = null;
  /** @type {object[]} one WS.Server per bind address */
  let servers = [];
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
    if (isOpen(owner)) {
      owner.send(message);
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
  // ONE owner at a time, and a newcomer is REFUSED while that owner is alive.
  //
  // A CDP session still cannot be shared: two frontend pages would both allocate
  // ids from 1 and both see the other's replies, so exactly one client may own the
  // upstream session. What changed is what happens to the second one. Chrome's
  // rule (evict the old DevTools, let the newcomer take over) is safe there
  // because *who* may attach is decided by Chrome's own UI; here the socket is
  // reachable by anything that passes `verifyClient`, and eviction would
  // turn a refused attacker into the frontend with one line of JS — silently, with
  // the real frontend's socket closed on top of it. Refusal is the same
  // single-owner guarantee without that failure mode: takeover is a log line and a
  // close code, and the owner keeps its session (docs/SECURITY-PLATFORM.md F3).
  //
  // "First wins" must not mean "wedged forever": the owner's socket can go away
  // without this process being told (a half-open connection after sleep/wake or a
  // network drop; a client killed with its socket still open). So contention is
  // settled on LIVENESS, not on arrival order: the current owner is pinged, and a
  // socket that answers is the frontend (refuse the newcomer), while one that does
  // not answer within `probeTimeoutMs` is unreachable (replace it). That is what
  // distinguishes "the old socket just died" from "an attacker while attached",
  // without asking either side to identify itself a second time.
  //
  // What the probe does NOT do is evict a live-but-slow frontend: a WebSocket pong
  // is a control frame answered by the peer's network stack, not by page JS (RFC
  // 6455 §5.5.2), so a frontend whose renderer is stuck still pongs and keeps its
  // session. Losing it requires not answering at the socket layer at all.
  /** @type {object|null} the socket that owns the upstream session */
  let owner = null;
  /** The owner's pending liveness probe, so concurrent newcomers share one ping. */
  let livenessProbe = null;

  /** Ask the current owner to prove it is alive; resolves true when it does. */
  const ownerIsAlive = () => {
    const probed = owner;
    if (!isOpen(probed)) {
      return Promise.resolve(false);
    }
    if (livenessProbe) {
      return livenessProbe;
    }
    livenessProbe = new Promise((resolve) => {
      let settled = false;
      const settle = (alive) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        probed.removeListener("pong", onPong);
        probed.removeListener("close", onGone);
        livenessProbe = null;
        resolve(alive);
      };
      const onPong = () => settle(true);
      // A close that lands while we are probing settles the question the way the
      // frontend reload needs it to: the old document is gone, so the newcomer
      // (the reloaded frontend) may take the session instead of being refused.
      const onGone = () => settle(false);
      const timer = setTimeout(() => settle(false), probeTimeoutMs);
      probed.on("pong", onPong);
      probed.once("close", onGone);
      try {
        probed.ping();
      } catch {
        settle(false);
      }
    });
    return livenessProbe;
  };

  const refuse = (client, reason) => {
    log("warn", `CDP bridge: refusing a frontend connection — ${reason}`);
    try {
      client.close(REFUSE_CLOSE_CODE, reason);
    } catch {
      // The socket is already gone; the refusal was for the log anyway.
    }
  };

  const promote = (client, staged = []) => {
    owner = client;
    log("info", "CDP bridge: frontend connected (1 client)");
    client.on("message", (raw) => upstreamSend(String(raw)));
    client.on("close", () => {
      // The upstream session deliberately stays open: reloading the frontend
      // must not churn the device's debugger session.
      if (owner === client) {
        owner = null;
        log("info", "CDP bridge: frontend disconnected (0 clients)");
      }
    });
    // No `error` handler here: it belongs to `handleClient`, where it covers the
    // clients that never reach this function.
    // The frontend fires Runtime.enable/Debugger.enable the moment the socket
    // opens, which can be while a liveness probe is still running. Those frames
    // were held back (a refused client must not be able to write upstream); now
    // that it owns the session they go out in order, through the same buffer the
    // reconnect path uses.
    for (const message of staged) {
      upstreamSend(message);
    }
  };

  const handleClient = (client) => {
    // Held until this socket either owns the session or is refused: an attacker who
    // is about to be refused must not get a single CDP command upstream first.
    const staged = [];
    const stage = (raw) => {
      if (staged.length < maxBufferedSends) {
        staged.push(String(raw));
      }
    };
    const refuseClient = (reason) => {
      client.removeListener("message", stage);
      refuse(client, reason);
    };
    // Registered on ARRIVAL, not in `promote`. `ws` emits `error` on the
    // server-side socket for a protocol error, and an EventEmitter with no
    // `error` listener throws — so any client that completes the handshake and
    // then writes one malformed frame (an unmasked `[0x82, 0x00]` is enough)
    // would take the Electron main process down with it. A client that is
    // refused, or still inside the liveness-probe window, is exactly the client
    // that never reaches `promote`, so the handler cannot live there: it has to
    // be here, before the first await. The refused case has no state to undo;
    // the owner losing its socket to a protocol error must still free the seat.
    client.on("error", (error) => {
      if (owner === client) {
        owner = null;
        log("warn", `CDP bridge: the frontend's socket errored (${error.message})`);
      }
    });
    client.on("message", stage);

    const decide = async () => {
      if (owner && owner !== client) {
        const current = owner;
        const wasOpen = isOpen(current);
        if (wasOpen && (await ownerIsAlive())) {
          refuseClient(
            "another frontend already owns the session (close that DevTools window first)"
          );
          return;
        }
        // The owner is gone or deaf. Replacing a socket nobody is answering with
        // is not the takeover this rule protects against — it is the frontend
        // reload, or a renderer that died without saying goodbye.
        log(
          "info",
          `CDP bridge: the previous frontend ${wasOpen ? "is not answering" : "has gone"}, replacing it`
        );
        try {
          current.terminate();
        } catch {
          // already gone
        }
        if (owner === current) {
          owner = null;
        }
      }
      if (stopped) {
        refuseClient("the bridge is stopping");
        return;
      }
      if (owner && owner !== client) {
        // Another newcomer won the session while this one waited on the probe.
        refuseClient("another frontend took the session first");
        return;
      }
      if (!isOpen(client)) {
        // It hung up while the probe ran. Promoting a dead socket would strand it:
        // its `close` listener is registered below, so nothing would ever clear
        // `owner` and the bridge would refuse every frontend that came after.
        client.removeListener("message", stage);
        return;
      }
      client.removeListener("message", stage);
      promote(client, staged);
    };

    decide().catch((error) => {
      log("error", `CDP bridge: could not decide a frontend connection: ${error}`);
      refuseClient("the bridge could not accept the connection");
    });
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
  // Wiring for `upgradeAllowed`: reject at upgrade time rather than in
  // `connection`, so a rejected client never becomes a client at all — no
  // eviction, no relay, no host-range ids.
  const verifyClient = ({ origin, req }, callback) => {
    const peer = req?.socket?.remoteAddress;
    if (upgradeAllowed({ origin, peerAddress: peer, allowedOrigins: origins })) {
      callback(true);
      return;
    }
    log(
      "warn",
      `CDP bridge: refused an upgrade${origin ? ` from Origin ${origin}` : " without an Origin"} (peer ${peer})`
    );
    callback(false, 403, "Forbidden: origin not allowed");
  };

  /** One WS.Server per bind address; `["127.0.0.1", "::1"]` -> two on one port. */
  const listenOn = (host) =>
    new Promise((resolve, reject) => {
      const instance = new WS.Server({
        port: listenPort,
        host,
        verifyClient,
      });
      let listening = false;
      instance.once("listening", () => {
        listening = true;
        resolve(instance);
      });
      instance.on("error", (error) => {
        if (listening) {
          // Post-listen: the shell is serving, so report rather than tear down —
          // the behaviour the single-server `error` handler had before the bridge
          // learned to hold two bind addresses.
          log("error", `CDP bridge server error: ${error.message}`);
          return;
        }
        instance.close();
        reject(error);
      });
      instance.on("connection", handleClient);
    });

  const start = async () => {
    if (!enabled) {
      log(
        "info",
        "CDP bridge disabled — leaving the socket to the frontend (external relay mode)"
      );
      return false;
    }
    if (servers.length > 0) {
      return true;
    }
    stopped = false;
    const opened = [];
    let failure = null;
    // Sequential, not Promise.all: two binds on one port would race, and the
    // first address is the one that matters.
    for (const host of listenHosts) {
      try {
        opened.push(await listenOn(host));
      } catch (error) {
        if (opened.length === 0) {
          // Nothing is listening: the port is taken, which src/main/index.js
          // reports as "stop the external relay".
          stopped = true;
          throw error;
        }
        // A secondary loopback that will not bind (IPv6 disabled, or something
        // else holds ::1) must not cost the developer their debugging: the
        // primary address is up, so say what is missing and carry on.
        failure = error;
        log("warn", `CDP bridge: could not bind ${host}:${listenPort} (${error.code || error.message})`);
        break;
      }
    }
    servers = opened;
    // `ws://[::1]:9223`, not `ws://::1:9223`: an unbracketed IPv6 literal is not a
    // URL anybody can dial, and this line is what a developer copy-pastes.
    log(
      "info",
      `CDP bridge listening on ${listenHosts
        .slice(0, opened.length)
        .map((host) => `ws://${net.isIPv6(host) ? `[${host}]` : host}:${listenPort}`)
        .join(", ")} (Metro: ${metroHost}:${metroPort})${
        failure ? " — see the warning above" : ""
      }`
    );
    attachLoop().catch((error) => log("error", `CDP bridge attach loop: ${error}`));
    return true;
  };

  const stop = () => {
    stopped = true;
    if (owner) {
      owner.close();
      owner = null;
    }
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
    const closing =
      servers.length > 0
        ? Promise.all(
            servers.map((instance) => new Promise((resolve) => instance.close(resolve)))
          ).then(() => true)
        : Promise.resolve(false);
    servers = [];
    return closing;
  };

  return {
    start,
    stop,
    sendCommand,
    onEvent,
    isAttached: () => isOpen(upstream),
    /** @returns {{attached: boolean, target: object|null, clients: number}} */
    status: () => ({ attached: isOpen(upstream), target, clients: owner ? 1 : 0 }),
    /** Addresses the socket is actually bound to — `[{address, family, port}]`. */
    listeningAddresses: () => servers.map((instance) => instance.address()),
  };
};

// ── process singleton (built from config; nothing binds until start()) ─────
const config = require("./config");

const bridge = createCdpBridge({
  // Includes `allowedOrigins`: the frontend's own origin, which is the only
  // browser document that dials this socket, plus DEVTOOLS_CDP_ALLOWED_ORIGINS
  // (src/main/config.js).
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
  REFUSE_CLOSE_CODE,
  DEFAULTS,
  isLoopbackAddress,
  upgradeAllowed,
  bridge,
  start: bridge.start,
  stop: bridge.stop,
  sendCommand: bridge.sendCommand,
  onEvent: bridge.onEvent,
  isAttached: bridge.isAttached,
  status: bridge.status,
  listeningAddresses: bridge.listeningAddresses,
};
