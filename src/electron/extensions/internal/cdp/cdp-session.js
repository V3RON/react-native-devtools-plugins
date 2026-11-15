// The extension host's own debugger session (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md §5.6).
//
// The host opens a SECOND, independent session to the inspector URL in the frontend's
// `ws=`, next to the frontend's own. Nothing sits between the frontend and the app: no
// listening socket, no URL rewrite, no id multiplexing, no ownership rule. What the host
// needs from the dev server's inspector proxy is two things:
//
//   - an `Origin` it accepts. The proxy refuses a debugger socket whose Origin is neither
//     the dev server's own nor a loopback hostname (InspectorProxy.js verifyClient), and a
//     missing Origin too. The host sends the frontend URL's origin, which is the dev
//     server's: the frontend is served by it.
//   - the target's `supportsMultipleDebuggers`. Without it the proxy evicts the previous
//     debugger of that page when a new one connects (Device.js), so connecting would
//     disconnect the frontend. One read-only `GET <dev server>/json/list` before every dial
//     finds the entry for `ws=` and reads `reactNative.capabilities`. This is not target
//     discovery: the session never picks a target, it only checks the one it was given.
//     When the check fails, the session does not connect, and every command rejects with
//     the reason (status().reason), which is what an extension sees as lastError/isError.
//
// Per-session isolation is the backend's (jsinspector-modern): `Runtime.bindingCalled`
// reaches only sessions that added that binding, and `Network.*` fans out to each session
// that enabled the domain. So the host's bindings and events stay out of the frontend's
// models, and the frontend's stay out of the host's.
//
// Lifetime: `open(frontendUrl)` at attach, `close()` at detach. Handlers registered with
// `onEvent` / `onAttach` outlive both, so the consumers built once by the host
// (inspected-window, network model, content bridge, tab host) keep working across
// reconnects. A lost socket is re-dialled with back-off; each new session runs the prime
// commands (`Runtime.enable`, for execution-context events and evaluation) and then
// `onAttach` fires, which is where consumers re-arm what a session owns (`Network.enable`,
// `Runtime.addBinding`).
//
// The same object also backs `chrome.debugger` (./debugger-service.js), one per attached
// extension, with two options changed: `reconnect: false`, because an extension's
// attachment ends when its socket does (Chrome's onDetach "target_closed") rather than
// silently coming back without the domains it had enabled; and no request timeout,
// because Chrome puts none on `sendCommand` and a heap snapshot or a profile can take
// longer than any budget chosen here.
//
// No Electron here: transports and logging are injectable, so tests/cdp-session.test.js
// runs it against a fake inspector proxy in the same process.
const WebSocket = require("ws");

const DEFAULTS = Object.freeze({
  // How long a command waits for its reply (chrome.devtools.inspectedWindow.eval's budget).
  // 0 means no limit: the command waits until it is answered or the session ends.
  requestTimeoutMs: 10000,
  // How long the capability lookup may take before the attempt counts as failed.
  capabilityTimeoutMs: 3000,
  // Re-dial back-off, doubling from min to max; reset after a session that attached.
  reconnectMinMs: 250,
  reconnectMaxMs: 5000,
  // Whether a lost or refused session is dialled again. False: one attempt, and an
  // attached session that closes stays closed (onDetach fires).
  reconnect: true,
  // Sent on every new session before it reports attached. `Runtime.enable` is what makes
  // the backend report execution contexts (created / cleared), which the network model and
  // the content bridge re-arm on.
  prime: Object.freeze(["Runtime.enable"]),
});

/**
 * Where the host's session dials, read from the frontend URL. Pure.
 *
 * The frontend is given its backend as `?ws=<host:port/path?query>` (or `wss=`), the same
 * parameter the frontend build itself reads (core/sdk/Connections). The dev server is the
 * URL's origin.
 *
 * @returns {{ok: true, wsUrl: string, devServer: string} | {ok: false, reason: string}}
 */
const cdpTargetOf = (frontendUrl) => {
  let url;
  try {
    url = new URL(String(frontendUrl));
  } catch {
    return { ok: false, reason: "the frontend URL is not a URL" };
  }
  const secure = url.searchParams.has("wss");
  const raw = secure ? url.searchParams.get("wss") : url.searchParams.get("ws");
  if (!raw) {
    return { ok: false, reason: "the frontend URL names no debugger (no ws= or wss= parameter)" };
  }
  let wsUrl;
  try {
    wsUrl = new URL(`${secure ? "wss" : "ws"}://${raw}`).href;
  } catch {
    return { ok: false, reason: `the frontend URL's ${secure ? "wss" : "ws"}= is not a host and path` };
  }
  if (url.origin === "null") {
    return { ok: false, reason: "the frontend URL has no origin to send as the debugger's Origin" };
  }
  return { ok: true, wsUrl, devServer: url.origin };
};

/**
 * Is this `/json/list` entry the target `wsUrl` names? Compared on path and query (the
 * proxy's `device` and `page`), so `localhost` and `127.0.0.1` spellings of the same dev
 * server still match. Pure.
 */
const isEntryFor = (entry, wsUrl) => {
  if (!entry || typeof entry.webSocketDebuggerUrl !== "string") {
    return false;
  }
  try {
    const listed = new URL(entry.webSocketDebuggerUrl);
    const wanted = new URL(wsUrl);
    return listed.pathname === wanted.pathname && listed.search === wanted.search;
  } catch {
    return false;
  }
};

/**
 * The capability decision for one `/json/list` answer. Pure.
 * @returns {{ok: true, entry: object} | {ok: false, reason: string}}
 */
const capabilityOf = (entries, wsUrl) => {
  if (!Array.isArray(entries)) {
    return { ok: false, reason: "the dev server's /json/list did not answer with a list" };
  }
  const entry = entries.find((candidate) => isEntryFor(candidate, wsUrl));
  if (!entry) {
    return { ok: false, reason: "the dev server does not list this debugger target (the app may have gone)" };
  }
  const capabilities = (entry.reactNative && entry.reactNative.capabilities) || {};
  if (capabilities.supportsMultipleDebuggers !== true) {
    return {
      ok: false,
      reason:
        "the target does not support multiple debuggers (reactNative.capabilities." +
        "supportsMultipleDebuggers), so a second session would disconnect the DevTools frontend",
    };
  }
  return { ok: true, entry };
};

/**
 * @param {object} [options]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.capabilityTimeoutMs]
 * @param {number} [options.reconnectMinMs]
 * @param {number} [options.reconnectMaxMs]
 * @param {boolean} [options.reconnect] dial again after a loss (default true)
 * @param {string[]} [options.prime] commands every new session sends before attaching
 * @param {Function} [options.WebSocket] ws-compatible client (tests)
 * @param {Function} [options.fetch] fetch-compatible implementation (tests)
 * @param {(level: string, message: string) => void} [options.log]
 */
const createCdpSession = (options = {}) => {
  const {
    requestTimeoutMs,
    capabilityTimeoutMs,
    reconnectMinMs,
    reconnectMaxMs,
    reconnect,
    prime,
    WebSocket: WS = WebSocket,
    fetch = globalThis.fetch,
    log = () => {},
  } = { ...DEFAULTS, ...options };

  /** CDP method | "*" -> handlers */
  const handlers = new Map();
  const attachHandlers = new Set();
  const detachHandlers = new Set();
  /** id -> {method, resolve, reject, timer} */
  const pending = new Map();
  let nextId = 0;

  // One run per open(): `run` is bumped by close() and by a later open(), so a loop that
  // outlived its run stops at its next check instead of racing the new one.
  let run = 0;
  let socket = null;
  let attached = false;
  let target = null; // the /json/list entry the session is attached to
  let reason = "the debugger session is not open";
  let lastLoggedReason = null;
  let wake = null; // resolves the current back-off sleep early (close)
  let settleOpen = null; // resolves the promise the current open() returned

  const setReason = (next) => {
    reason = next;
    if (next && next !== lastLoggedReason) {
      lastLoggedReason = next;
      log("warn", `not connected: ${next}`);
    }
  };

  const isOpen = (candidate) => Boolean(candidate) && candidate.readyState === WS.OPEN;

  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  // ── events ───────────────────────────────────────────────────────────────
  const emit = (method, params, sessionId) => {
    for (const key of [method, "*"]) {
      for (const handler of [...(handlers.get(key) || [])]) {
        try {
          handler(params || {}, method, sessionId);
        } catch (error) {
          log("error", `CDP event handler for ${method} threw: ${error.message}`);
        }
      }
    }
  };

  // Only for a session that WAS attached and closed from the other side: close() takes the
  // socket first, so a session the host closed itself never reports a detach.
  const emitDetach = () => {
    for (const handler of [...detachHandlers]) {
      try {
        handler(reason);
      } catch (error) {
        log("error", `CDP detach handler threw: ${error.message}`);
      }
    }
  };

  const emitAttach = () => {
    for (const handler of [...attachHandlers]) {
      try {
        handler(target);
      } catch (error) {
        log("error", `CDP attach handler threw: ${error.message}`);
      }
    }
  };

  // ── commands ─────────────────────────────────────────────────────────────
  const rejectPending = (why) => {
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      clearTimeout(entry.timer);
      const error = new Error(`${entry.method}: ${why}`);
      error.code = "DETACHED";
      entry.reject(error);
    }
  };

  const send = (via, method, params, timeoutMs, sessionId) => {
    const id = ++nextId;
    const message = { id, method };
    if (params !== undefined) {
      message.params = params;
    }
    if (sessionId !== undefined) {
      message.sessionId = sessionId;
    }
    const budget = timeoutMs || requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer =
        budget > 0 && Number.isFinite(budget)
          ? setTimeout(() => {
              if (pending.delete(id)) {
                const error = new Error(`${method}: timed out after ${budget}ms without a reply`);
                error.code = "TIMEOUT";
                reject(error);
              }
            }, budget)
          : null;
      pending.set(id, { method, resolve, reject, timer });
      try {
        via.send(JSON.stringify(message));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`${method}: ${error.message}`));
      }
    });
  };

  /**
   * Send a CDP command on the host's session and wait for its reply. Rejects when no
   * session is attached (with the reason), when the backend answers with an error, or
   * after the timeout. It never resolves with invented data. A backend error keeps the
   * backend's own object as `error.cdpError` ({code, message, data?}).
   *
   * @param {{timeoutMs?: number, sessionId?: string}} [options] `sessionId` addresses a
   *        child session, and is sent as given
   */
  const sendCommand = (method, params, { timeoutMs, sessionId } = {}) => {
    if (!attached || !isOpen(socket)) {
      const error = new Error(`${method}: no CDP session is attached (${reason})`);
      error.code = "DETACHED";
      return Promise.reject(error);
    }
    return send(socket, method, params, timeoutMs, sessionId);
  };

  const onMessage = (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return; // not CDP; nothing to correlate
    }
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) {
        return;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(`${entry.method}: ${message.error.message || "CDP error"}`);
        error.code = message.error.code;
        error.method = entry.method;
        error.cdpError = message.error;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      emit(message.method, message.params, message.sessionId);
    }
  };

  // ── one attempt: check, dial, prime, then wait for the socket to close ────
  const checkCapability = async (wsUrl, devServer) => {
    let entries;
    try {
      const response = await fetch(`${devServer}/json/list`, {
        signal: AbortSignal.timeout(capabilityTimeoutMs),
      });
      entries = await response.json();
    } catch (error) {
      return { ok: false, reason: `the dev server's /json/list could not be read (${error.message})` };
    }
    return capabilityOf(entries, wsUrl);
  };

  const dial = (wsUrl, devServer) =>
    new Promise((resolve) => {
      const candidate = new WS(wsUrl, { headers: { Origin: devServer } });
      const fail = (error) => {
        candidate.removeAllListeners("open");
        resolve({ socket: null, error });
      };
      candidate.once("open", () => {
        candidate.removeListener("error", fail);
        resolve({ socket: candidate, error: null });
      });
      candidate.once("error", fail);
    });

  /** @returns {Promise<boolean>} whether this attempt attached */
  const attempt = async (mine, wsUrl, devServer, onFirst) => {
    const capability = await checkCapability(wsUrl, devServer);
    if (mine !== run) {
      return false;
    }
    if (!capability.ok) {
      setReason(capability.reason);
      onFirst(false);
      return false;
    }
    const { socket: opened, error } = await dial(wsUrl, devServer);
    if (mine !== run) {
      if (opened) opened.close();
      return false;
    }
    if (!opened) {
      setReason(`the debugger socket did not open (${error ? error.message : "unknown error"})`);
      onFirst(false);
      return false;
    }
    socket = opened;
    target = capability.entry;
    const closed = new Promise((resolve) => {
      opened.on("close", (code, why) => {
        if (socket === opened) {
          socket = null;
          const wasAttached = attached;
          attached = false;
          target = null;
          setReason(`the debugger session closed (${code} ${String(why) || "no reason"})`);
          rejectPending("the debugger session closed");
          if (wasAttached) {
            log("info", reconnect ? "detached; re-dialling the same target" : "detached");
            emitDetach();
          }
        }
        resolve();
      });
    });
    opened.on("message", onMessage);
    opened.on("error", (socketError) => log("warn", `debugger socket error: ${socketError.message}`));

    for (const method of prime) {
      try {
        await send(opened, method, undefined, requestTimeoutMs);
      } catch (primeError) {
        log("warn", `${primeError.message} (continuing without it)`);
      }
      if (socket !== opened) {
        break;
      }
    }
    if (socket === opened && mine === run) {
      attached = true;
      reason = null;
      lastLoggedReason = null;
      log("info", `attached to ${target.title || target.id || wsUrl}`);
      onFirst(true);
      emitAttach();
    } else {
      onFirst(false);
    }
    await closed;
    return true;
  };

  const loop = async (mine, wsUrl, devServer, onFirst) => {
    let delay = reconnectMinMs;
    while (mine === run) {
      const wasAttached = await attempt(mine, wsUrl, devServer, onFirst).catch((error) => {
        setReason(`the session attempt failed (${error.message})`);
        onFirst(false);
        return false;
      });
      if (mine !== run) {
        return;
      }
      if (!reconnect) {
        onFirst(false);
        return;
      }
      if (wasAttached) {
        delay = reconnectMinMs;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, reconnectMaxMs);
    }
  };

  /**
   * Start the session for the frontend URL's `ws=`. Resolves after the FIRST attempt:
   * true when it attached, false when it did not (status().reason says why; the loop
   * keeps trying). Never rejects. A second open() replaces the first.
   */
  const open = (frontendUrl) => {
    close();
    const mine = ++run;
    const where = cdpTargetOf(frontendUrl);
    if (!where.ok) {
      setReason(where.reason);
      return Promise.resolve(false);
    }
    reason = "connecting";
    return new Promise((resolve) => {
      let first = true;
      const onFirst = (value) => {
        if (first) {
          first = false;
          if (settleOpen === onFirst) {
            settleOpen = null;
          }
          resolve(value);
        }
      };
      // close() before the first attempt finished settles this as "did not attach",
      // rather than leaving the caller waiting on a run that has stopped.
      settleOpen = onFirst;
      loop(mine, where.wsUrl, where.devServer, onFirst).catch((error) => {
        log("error", `session loop: ${error.message}`);
        onFirst(false);
      });
    });
  };

  /** Stop: close the socket, reject what is in flight, stop re-dialling. Idempotent. */
  const close = () => {
    run += 1;
    if (wake) {
      wake();
    }
    if (settleOpen) {
      const settle = settleOpen;
      settleOpen = null;
      settle(false);
    }
    const current = socket;
    socket = null;
    attached = false;
    target = null;
    reason = "the debugger session is not open";
    rejectPending("the debugger session was closed by the host");
    if (current) {
      try {
        current.close();
      } catch {
        // already closing
      }
    }
    return Promise.resolve();
  };

  /**
   * Subscribe to CDP notifications: `method` exact ("Network.requestWillBeSent") or "*".
   * Handlers get (params, method, sessionId) — sessionId only for a child session's event.
   * @returns {() => void} unsubscribe
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

  /**
   * Called after every new session attached (and primed): the place to re-arm what a
   * session owns. @returns {() => void} unsubscribe
   */
  const onAttach = (handler) => {
    if (typeof handler !== "function") {
      throw new TypeError("onAttach(handler: function)");
    }
    attachHandlers.add(handler);
    return () => {
      attachHandlers.delete(handler);
    };
  };

  /**
   * Called when an ATTACHED session's socket closed from the other side (the app went
   * away, the proxy dropped it), with the reason. Not called for close().
   * @returns {() => void} unsubscribe
   */
  const onDetach = (handler) => {
    if (typeof handler !== "function") {
      throw new TypeError("onDetach(handler: function)");
    }
    detachHandlers.add(handler);
    return () => {
      detachHandlers.delete(handler);
    };
  };

  return {
    open,
    close,
    sendCommand,
    onEvent,
    onAttach,
    onDetach,
    isAttached: () => attached && isOpen(socket),
    /** @returns {{attached: boolean, target: object|null, reason: string|null}} */
    status: () => ({ attached: attached && isOpen(socket), target, reason: attached ? null : reason }),
  };
};

module.exports = { createCdpSession, cdpTargetOf, capabilityOf, isEntryFor, DEFAULTS };
