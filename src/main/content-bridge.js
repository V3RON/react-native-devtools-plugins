// The content-bridge runner: injects an allowlisted content script INTO THE
// INSPECTED APP and gives it a `chrome.runtime` that reaches this shell
// (docs/features/CONTENT-SCRIPTS.md, GitHub issue #5).
//
// ── what this file is, honestly ─────────────────────────────────────────────────
// It generates a JS source string (the "loader") and evaluates `loader + script` into
// the app through the CDP bridge's `Runtime.evaluate`. That string is CONTENT-SCRIPT
// CODE RUNNING IN THE APP — which is exactly what a content script is, and exactly
// what the issue's definition of done asks for.
//
// It is NOT the channel this shell deleted in issue #10. That channel was a SHELL-side
// `new Function(hostStoredString)`: the frontend handed an arbitrary script to main,
// main stored it, and every extension FRAME was made to evaluate it — arbitrary code
// executed inside contexts this shell owns, over a synchronous IPC channel. Nothing
// here evaluates anything inside an extension frame, a preload, or the frontend;
// `src/shared/ipc.js` still has zero `sendSync` channels; and the only string that
// leaves this process goes into a debugger command whose destination is the app under
// inspection. A shell frame never sees it.
//
// ── the two legs ────────────────────────────────────────────────────────────────
//   app → host : `Runtime.addBinding`, i.e. a call to a global the backend installs,
//                arriving as `Runtime.bindingCalled`. RN's backend really supports it
//                (HostAgent.cpp:296 handles addBinding "at any time during a session,
//                even while the JS runtime hasn't been created yet"; RuntimeAgent.cpp:53
//                installs it per matching context) and React Native DevTools already
//                uses the same round-trip for React DevTools. String-only and
//                fire-and-forget, so every message is one JSON envelope and anything
//                non-JSON (ArrayBuffer / TypedArray) travels base64-wrapped.
//   host → app : `Runtime.evaluate` into the dispatch function the loader installed —
//                the only direction with a reply, which is why an answer to an
//                app-initiated `sendMessage` rides this leg and can only arrive while a
//                session exists. A wait that expires says it expired.
//
// ── the binding name is a host-wide resource ───────────────────────────────────
// `RuntimeAgent::notifyBindingCalled` (RuntimeAgent.cpp:100-118) dispatches
// `Runtime.bindingCalled` to every session subscribed to that BINDING NAME, without
// re-checking the execution context, and `installBindingHandler` (RuntimeTarget.cpp:94)
// defines it as a property on the APP'S GLOBAL. One name is therefore one channel across
// every session on that runtime, so it must not collide: the frontend's React-DevTools
// channel reads ITS name out of the app (`BINDING_NAME` on a global the fork installs —
// see models/react_native/react_native.js) rather than sharing a constant with anyone,
// and RN's internal client (HostTarget.cpp:166) uses its own. This shell reserves
// `__rozeniteContentBridgeDispatch`, uses exactly one for every extension, and never
// lets a manifest or a message choose it.
//
// ── lifecycle, and the two things it will not do ───────────────────────────────
// Inject on attach, re-inject when the bridge sees the app's execution context created
// or cleared (Hermes has no `Page.addScriptToEvaluateOnNewDocument`, so re-injection is
// the host's job). Injecting while detached is never queued as a lie: the entry is
// marked pending and the report says so in words. When the session dies, the app's seat
// in the messaging mesh is withdrawn rather than left to accumulate undeliverable work.
const { createEvalInPage } = require("./inspected-window");
const { decideEntries } = require("./content-gate");
const { tabIdFor } = require("../chrome-shim/devtools");
const { syntheticTab } = require("../chrome-shim/tab-model");

// Reserved, host-wide, one per shell — see the note above.
const BINDING_NAME = "__rozeniteContentBridgeDispatch";
const DISPATCH_GLOBAL = "__RozeniteContentBridge";
const APP_FRAME_PREFIX = "rozenite-app:";

// How long an app-side `sendMessage` waits for the host before reporting that no answer
// came. The wait really elapses in the app, so reporting it is honest; the number is
// this host's policy, not a Chrome constant.
const RESPONSE_WAIT_MS = 5000;

// How often the bridge re-checks whether the app is attached again after a drop.
const SWEEP_INTERVAL_MS = 4000;

/**
 * The app-side loader. Pure string generation: nothing in this function runs in this
 * process, and nothing in this shell evaluates it.
 *
 * Merge-not-replace, in two places, deliberately:
 *   - the loader itself returns early when a loader is already installed, so a second
 *     content script never throws away the first one's listeners or open ports;
 *   - `chrome.runtime` is MERGED onto whatever `chrome` already exists (an app that
 *     ships its own global.chrome, or another extension's loader), and only members the
 *     existing object lacks are added. Nothing here overwrites an existing function.
 *
 * Each extension's script is evaluated inside a wrapper that declares a LEXICAL `chrome`
 * bound to that extension's own API. That is what keeps two extensions' traffic apart
 * even though the app has one global `chrome`: a content script's closures capture the
 * wrapper's binding, and the global install stays a merge rather than a takeover.
 */
const loaderSource = ({
  bindingName = BINDING_NAME,
  globalName = DISPATCH_GLOBAL,
  responseWaitMs = RESPONSE_WAIT_MS,
} = {}) => `(() => {
  // Generated by the host (src/main/content-bridge.js) and evaluated INSIDE THE
  // INSPECTED APP. This is the app's own JS context: Hermes has no isolated content
  // script worlds, so "ISOLATED" and "MAIN" both land here (docs/features/CONTENT-SCRIPTS.md).
  "use strict";
  var BINDING = ${JSON.stringify(bindingName)};
  var RESPONSE_WAIT = ${JSON.stringify(responseWaitMs)};
  var g = typeof globalThis !== "undefined" ? globalThis : this;
  var existing = g[${JSON.stringify(globalName)}];
  if (existing && existing.__protocol === 1) {
    return;
  }

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function toB64(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | ((b || 0) >> 4));
      out += b === undefined ? "=" : B64.charAt(((b & 15) << 2) | ((c || 0) >> 6));
      out += c === undefined ? "=" : B64.charAt(c & 63);
    }
    return out;
  }
  function fromB64(text) {
    var clean = String(text).replace(/=+$/, "");
    var bytes = [];
    for (var i = 0; i < clean.length; i += 4) {
      var n = (B64.indexOf(clean.charAt(i)) << 18) |
              (B64.indexOf(clean.charAt(i + 1)) << 12) |
              (B64.indexOf(clean.charAt(i + 2)) << 6) |
              B64.indexOf(clean.charAt(i + 3));
      bytes.push((n >> 16) & 255);
      if (i + 2 < clean.length) bytes.push((n >> 8) & 255);
      if (i + 3 < clean.length) bytes.push(n & 255);
    }
    return bytes;
  }
  function binaryOf(v) {
    try {
      if (typeof ArrayBuffer === "undefined") return null;
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    } catch (ignored) {}
    return null;
  }
  function encode(value) {
    var stack = [];
    var text;
    try {
      text = JSON.stringify(value, function (key, v) {
        if (v && typeof v === "object") {
          var bin = binaryOf(v);
          if (bin) return { __rozeniteBase64: toB64(bin) };
          if (stack.indexOf(v) >= 0) return "[circular]";
          stack.push(v);
        }
        return v;
      });
    } catch (error) {
      report("encode-threw", error && error.message);
      return JSON.stringify({ t: "report", k: "encode-threw", d: String(error && error.message) });
    }
    return typeof text === "string" ? text : "null";
  }
  function revive(value) {
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) value[i] = revive(value[i]);
      return value;
    }
    if (!value || typeof value !== "object") return value;
    if (typeof value.__rozeniteBase64 === "string") {
      var bytes = fromB64(value.__rozeniteBase64);
      try { return new Uint8Array(bytes).buffer; } catch (ignored) { return bytes; }
    }
    var out = {};
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = revive(value[key]);
    }
    return out;
  }

  var host = {
    __protocol: 1,
    bindingName: BINDING,
    scripts: [],
    exts: {},
    lastError: null
  };

  function report(kind, detail) {
    try {
      post(JSON.stringify({ t: "report", k: String(kind), d: String(detail == null ? "" : detail) }));
    } catch (ignored) {}
  }

  function post(text) {
    var fn = g[BINDING];
    if (typeof fn !== "function") {
      return false;
    }
    try { fn(text); return true; } catch (error) { return false; }
  }

  function mkEvent() {
    var listeners = [];
    return {
      addListener: function (fn) {
        if (typeof fn === "function" && listeners.indexOf(fn) < 0) listeners.push(fn);
      },
      removeListener: function (fn) {
        var at = listeners.indexOf(fn);
        if (at >= 0) listeners.splice(at, 1);
      },
      hasListener: function (fn) { return listeners.indexOf(fn) >= 0; },
      hasListeners: function () { return listeners.length > 0; },
      _fire: function () {
        var args = Array.prototype.slice.call(arguments);
        var snapshot = listeners.slice();
        for (var i = 0; i < snapshot.length; i++) {
          try { snapshot[i].apply(null, args); } catch (error) { report("listener-threw", error && error.message); }
        }
      },
      _list: function () { return listeners.slice(); }
    };
  }

  function channel(extensionId) {
    var ch = host.exts[extensionId];
    if (ch) return ch;
    ch = { id: extensionId, seq: 0, pending: {}, ports: {}, routerOf: {}, localOf: {}, files: [] };
    ch.onMessage = mkEvent();
    ch.onConnect = mkEvent();
    ch.nextSeq = function () { ch.seq += 1; return ch.id + "#" + ch.seq; };
    host.exts[extensionId] = ch;
    return ch;
  }

  function errorOf(text) { return { message: text }; }

  function withError(error, run) {
    host.lastError = error || null;
    try { return run(); } finally { host.lastError = null; }
  }

  // Reporting a missing binding through the binding is impossible, so this returns the
  // verdict and each caller states it its own way. The host checks the binding BEFORE it
  // injects anything (see content-bridge.js: "the app did not install ... nothing is
  // injected"), so the ordinary way to see a false here is an app that deleted
  // globalThis[BINDING] after injection — and then the honest answer is a failed call.
  function sendToHost(envelope) {
    return post(encode(envelope));
  }

  // ── the per-extension chrome.runtime ────────────────────────────────────────
  function runtimeApi(ch) {
    var api = {
      id: ch.id,
      onMessage: ch.onMessage,
      onConnect: ch.onConnect,
      sendMessage: function () {
        var args = Array.prototype.slice.call(arguments);
        var callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
        if (typeof args[0] === "string" && args.length >= 2) args.shift();
        var message = args.shift();
        var seq = ch.nextSeq();
        var settled = false;
        var resolveOuter = function () {};
        var rejectOuter = function () {};
        var promise = new Promise(function (resolve, reject) {
          resolveOuter = resolve;
          rejectOuter = reject;
        });
        var finish = function (response, error) {
          if (settled) return;
          settled = true;
          delete ch.pending[seq];
          if (callback) {
            withError(error, function () { callback(response); });
          } else if (error) {
            rejectOuter(errorOf(error.message || "Could not establish connection."));
          } else {
            resolveOuter(response);
          }
        };
        ch.pending[seq] = finish;
        var ok = sendToHost({ t: "send", x: ch.id, s: seq, m: message });
        if (!ok) {
          finish(undefined, errorOf("Could not establish connection. Receiving end does not exist."));
        } else {
          setTimeout(function () {
            if (!settled) finish(undefined, errorOf("No response from the extension within " + RESPONSE_WAIT + "ms."));
          }, RESPONSE_WAIT);
        }
        // A no-op handler is attached either way: a rejected promise nobody is watching
        // would surface as an unhandled rejection IN THE USER'S APP, which is a worse
        // failure than the one being reported. A caller that attaches its own handler
        // still sees the rejection — this only prevents the noise, never the error.
        promise.then(function () {}, function () {});
        if (callback) return undefined;
        return promise;
      },
      connect: function (first, second) {
        var name = "";
        if (typeof first === "string" && second && typeof second === "object") name = second.name || "";
        else if (first && typeof first === "object") name = first.name || "";
        var local = "port:" + ch.nextSeq();
        var port = {
          name: name,
          portId: local,
          onMessage: mkEvent(),
          onDisconnect: mkEvent(),
          disconnect: function () {
            if (!ch.ports[local]) return;
            delete ch.ports[local];
            sendToHost({ t: "port-close", x: ch.id, s: local });
          },
          postMessage: function (message) {
            if (!ch.ports[local]) return;
            sendToHost({ t: "port-post", x: ch.id, s: local, m: message });
          },
          _close: function (reason) {
            if (!ch.ports[local]) return;
            delete ch.ports[local];
            port.lastError = errorOf(reason || "Port disconnected");
            port.onDisconnect._fire(port);
          },
          _key: function () { return local; }
        };
        ch.ports[local] = port;
        var ok = sendToHost({ t: "port-connect", x: ch.id, s: local, n: name });
        if (!ok) port._close("Could not establish connection.");
        return port;
      },
      getManifest: function () { return {}; },
      getURL: function (innerPath) { return String(innerPath == null ? "" : innerPath).replace(/^\\/+/, ""); },
      getPlatformInfo: function (callback) {
        if (typeof callback === "function") { callback(undefined); return undefined; }
        return Promise.reject(new Error("runtime.getPlatformInfo is not answered from an injected content script."));
      },
      reload: function () {},
      getBackgroundPage: function () { return undefined; }
    };
    Object.defineProperty(api, "lastError", { get: function () { return host.lastError; } });
    return api;
  }

  function mergeInto(target, additions) {
    for (var key in additions) {
      if (!Object.prototype.hasOwnProperty.call(additions, key)) continue;
      if (target[key] === undefined) {
        try { target[key] = additions[key]; } catch (ignored) {}
      }
    }
    return target;
  }

  /**
   * Which members of the app's 'chrome' / 'chrome.runtime' THIS loader installed. The
   * distinction matters for merge-not-replace: an existing member is only ever honoured
   * when the app (or another page script) put it there. Members this loader added for
   * extension A must not win over extension B's own API later — so they are skipped when
   * building B's view, while anything the app itself defined keeps winning for everyone.
   */
  var installedKeys = { root: [], runtime: [] };
  function mergeOwn(target, additions, bucket) {
    for (var key in additions) {
      if (!Object.prototype.hasOwnProperty.call(additions, key)) continue;
      if (target[key] === undefined) {
        try {
          target[key] = additions[key];
          installedKeys[bucket].push(key);
        } catch (ignored) {}
      }
    }
    return target;
  }
  function isOwn(bucket, key) {
    return installedKeys[bucket].indexOf(key) >= 0;
  }

  /**
   * The view one extension's script sees: its own runtime API, over whatever 'chrome'
   * the APP provided. Never replaces an app member; never inherits another extension's
   * transport members.
   */
  host.forExtension = function (extensionId, shared) {
    var ch = channel(String(extensionId));
    var base = shared && typeof shared === "object" ? shared : {};
    var baseRuntime = base.runtime && typeof base.runtime === "object" ? base.runtime : null;
    var merged = {};
    var runtime = {};
    for (var key in base) {
      if (!Object.prototype.hasOwnProperty.call(base, key) || key === "runtime") continue;
      if (!isOwn("root", key)) merged[key] = base[key];
    }
    if (baseRuntime) {
      for (var member in baseRuntime) {
        if (!Object.prototype.hasOwnProperty.call(baseRuntime, member) || isOwn("runtime", member)) continue;
        runtime[member] = baseRuntime[member];
      }
    }
    mergeInto(runtime, runtimeApi(ch));
    merged.runtime = runtime;
    return merged;
  };

  host.inject = function (extensionId, innerPaths) {
    var ch = channel(String(extensionId));
    ch.files = (innerPaths || []).slice();
    host.scripts.push({ extensionId: ch.id, files: ch.files });
    // The global chrome.runtime belongs to the FIRST extension that installed it: the
    // app has one global, and merge-not-replace means nobody after that can take it.
    // Each script still resolves 'chrome' lexically to its OWN view, which is what keeps
    // two extensions' traffic apart (docs/features/CONTENT-SCRIPTS.md).
    if (!g.chrome || typeof g.chrome !== "object") g.chrome = {};
    if (!g.chrome.runtime || typeof g.chrome.runtime !== "object") g.chrome.runtime = {};
    mergeOwn(g.chrome.runtime, runtimeApi(ch), "runtime");
    return true;
  };

  host.scriptsOf = function (extensionId) {
    var ch = host.exts[String(extensionId)];
    return ch ? ch.files.slice() : [];
  };

  /** The one host->app entry point. */
  host.dispatch = function (text) {
    var envelope;
    try { envelope = JSON.parse(String(text)); }
    catch (error) { report("bad-envelope", error && error.message); return; }
    if (!envelope || typeof envelope !== "object" || typeof envelope.t !== "string") {
      report("bad-envelope", "not an envelope");
      return;
    }
    var ch = envelope.x === undefined ? null : channel(String(envelope.x));
    if (envelope.t === "response") {
      if (!ch) return;
      var finish = ch.pending[envelope.s];
      if (!finish) return;
      if (envelope.e) finish(undefined, errorOf(String(envelope.e)));
      else finish(revive(envelope.m));
      return;
    }
    if (envelope.t === "port-open" || envelope.t === "port-drop") {
      if (!ch) return;
      var opening = ch.ports[envelope.s];
      if (!opening) return;
      if (envelope.t === "port-open") {
        // One port, two ids: the app's own (what its postMessage carries) and the
        // router's (what every later host delivery names). Remember the pair.
        opening.portId = envelope.p;
        ch.routerOf[String(envelope.s)] = envelope.p;
        ch.localOf[String(envelope.p)] = String(envelope.s);
        return;
      }
      opening._close(envelope.p || "Port disconnected");
      return;
    }
    if (envelope.t === "delivery") {
      if (!ch) { report("unknown-extension", String(envelope.x)); return; }
      var payload = revive(envelope.p || {});
      var kind = envelope.k;
      if (kind === "message") {
        var answered = false;
        var sendResponse = function (response) {
          if (answered) return;
          answered = true;
          sendToHost({ t: "respond", x: ch.id, s: envelope.s, m: response });
        };
        // Chrome's answer when the page has nothing listening is a connection error, not
        // "undefined". Reporting "no receiver" distinctly is what stops a sender from
        // reading a shrug as an answer (the false positive issue #12 refused to create).
        var listeners = ch.onMessage._list();
        if (listeners.length === 0) {
          sendToHost({
            t: "respond", x: ch.id, s: envelope.s, nr: true,
            e: "Could not establish connection. Receiving end does not exist."
          });
          return;
        }
        var wantsAsync = false;
        for (var i = 0; i < listeners.length; i++) {
          try {
            if (listeners[i](payload.message, payload.sender || {}, sendResponse) === true) wantsAsync = true;
          } catch (error) { report("listener-threw", error && error.message); }
        }
        if (!wantsAsync && !answered) sendResponse(undefined);
        return;
      }
      if (kind === "port-connect") {
        // A peer (panel or worker) opened this Port, so the id is the ROUTER's. The app
        // addresses it by exactly the value the host sent, so postMessage echoes the
        // same id back rather than a stringified copy the host would not recognize.
        var hostPort = envelope.s;
        var key = String(hostPort);
        if (!ch.ports[key]) {
          var incoming = {
            name: payload.name || "",
            portId: hostPort,
            onMessage: mkEvent(),
            onDisconnect: mkEvent(),
            disconnect: function () {
              if (!ch.ports[key]) return;
              delete ch.ports[key];
              sendToHost({ t: "port-close", x: ch.id, s: hostPort });
            },
            postMessage: function (message) {
              if (!ch.ports[key]) return;
              sendToHost({ t: "port-post", x: ch.id, s: hostPort, m: message });
            },
            _close: function (reason) {
              if (!ch.ports[key]) return;
              delete ch.ports[key];
              incoming.lastError = errorOf(reason || "Port disconnected");
              incoming.onDisconnect._fire(incoming);
            }
          };
          ch.ports[key] = incoming;
          ch.onConnect._fire(incoming);
        }
        return;
      }
      if (kind === "port-message") {
        var targetKey = ch.localOf[String(envelope.s)] || String(envelope.s);
        var target = ch.ports[targetKey];
        if (target) target.onMessage._fire(payload.message, payload.from);
        else report("unknown-port", String(envelope.s));
        return;
      }
      if (kind === "port-disconnect") {
        var dyingKey = ch.localOf[String(envelope.s)] || String(envelope.s);
        var dying = ch.ports[dyingKey];
        if (dying && dying._close) dying._close("Port disconnected");
        return;
      }
      report("unknown-delivery", String(kind));
      return;
    }
    report("unknown-envelope", String(envelope.t));
  };

  g[${JSON.stringify(globalName)}] = host;
})();`;

/** Install the loader, register this entry's files, then run the extension's script. */
const injectionExpression = ({ extensionId, innerPaths, source, loader }) =>
  `${loader}\n;${DISPATCH_GLOBAL}.inject(${JSON.stringify(
    extensionId
  )}, ${JSON.stringify(innerPaths)});\n(function () { var chrome = ${DISPATCH_GLOBAL}.forExtension(${JSON.stringify(
    extensionId
  )}, globalThis.chrome);\n${source}\n})();`;

/** The host->app delivery: one evaluate into the dispatch function the loader installed. */
const dispatchExpression = (envelope) =>
  `${DISPATCH_GLOBAL}.dispatch(${JSON.stringify(JSON.stringify(envelope))});`;

/** The app context's seat in the messaging mesh — a frame key the router never issues. */
const appFrameKey = (extensionId) => `${APP_FRAME_PREFIX}${extensionId}`;

/** Where the injected code came from, as an honest `sender.url` for the mesh. */
const appFrameURL = (extensionId) => `rozenite://${extensionId}/`;

/**
 * @param {object} deps
 * @param {(method: string, params?: object, opts?: object) => Promise<object>} deps.sendCommand
 * @param {(method: string, handler: Function) => Function} deps.onEvent
 * @param {() => boolean} deps.isAttached
 * @param {() => object[]} [deps.scan] content-script extensions (the registry scan)
 * @param {(id: string) => object} [deps.readManifest]
 * @param {(id: string, entry: object) => object} [deps.resolvePaths] registry path resolution
 * @param {(id: string, resolved: object, mayRead: Function) => {sources, problems}} [deps.readSources]
 * @param {string|null|object} [deps.allowlist] DEVTOOLS_CONTENT_SCRIPTS
 * @param {object} [deps.router] the ONE message router: the app joins this mesh
 * @param {() => Promise<object>|object} [deps.targetInfo] the inspected target's url/title
 * @param {object} [deps.log]
 * @param {number} [deps.requestTimeoutMs]
 * @param {Function} [deps.setTimeout]
 * @param {Function} [deps.clearTimeout]
 * @param {number} [deps.responseWaitMs]
 * @param {number} [deps.sweepIntervalMs]
 */
const createContentBridge = ({
  sendCommand,
  onEvent,
  isAttached = () => false,
  scan = () => [],
  readManifest = () => ({}),
  resolvePaths = null,
  readSources = null,
  allowlist = null,
  router = null,
  targetInfo = () => ({ attached: false }),
  log = console,
  requestTimeoutMs = 10000,
  setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout,
  responseWaitMs = RESPONSE_WAIT_MS,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
} = {}) => {
  const line = (message) => log.warn(`[content-scripts] ${message}`);
  const loader = loaderSource({ responseWaitMs });
  const evaluate = createEvalInPage(sendCommand);

  /** extensionId -> the live decision and what happened to it */
  const state = new Map();
  /** extensionId -> Map(app port id ⇄ router port id) */
  const appPorts = new Map();
  /**
   * "Which app context is this?" — the bridge has no generation counter of its own, so
   * it counts the context notifications the fan-out shows it. A changed epoch means the
   * backend has a fresh context, and a fresh context has no binding handler installed
   * (the backend's own tests: `RemovedBindingDoesNotSurviveReload`).
   */
  let contextEpoch = 0;
  const bindingGeneration = () => (isAttached() ? `epoch:${contextEpoch}` : null);
  let unsubscribe = null;
  let unsubscribeBinding = null;
  let reinjectTimer = null;
  let sweeper = null;
  let disposed = false;
  let bindingInstalledFor = null;

  const safeManifest = (extensionId) => {
    try {
      return readManifest(extensionId) || {};
    } catch {
      return {};
    }
  };

  const targetSnapshot = async () => {
    try {
      return (await targetInfo()) || {};
    } catch {
      return {};
    }
  };

  /** registry + gate + source reading in one place, so a test can drive all three. */
  const decideEntriesFor = (found, manifest, targetUrl) => {
    const decided = decideEntries({
      extensionId: found.extensionId,
      manifest,
      entries: found.entries,
      allowlist,
      targetUrl,
    });
    return decided.map((entry) => {
      if (!entry.decision.allowed) {
        return { ...entry, sources: [], problems: [], unreadable: false };
      }
      if (!resolvePaths || !readSources) {
        return { ...entry, sources: [], problems: ["no registry reader is wired"], unreadable: true };
      }
      const resolved = resolvePaths(found.extensionId, entry);
      const read = readSources(found.extensionId, resolved, () => true);
      return {
        ...entry,
        sources: read.sources,
        problems: read.problems,
        unreadable: read.sources.length === 0,
      };
    });
  };

  const logVerdicts = (extensionId, entries) => {
    for (const entry of entries) {
      for (const reason of entry.decision.reasons) line(`${extensionId}[${entry.index}]: ${reason}`);
      for (const note of entry.decision.notes) line(`${extensionId}[${entry.index}]: ${note}`);
      for (const problem of entry.problems || []) line(`${extensionId}[${entry.index}]: ${problem}`);
    }
  };

  /** One `Runtime.evaluate` into the app. Never throws: an honest {ok, error} either way. */
  const evaluateInApp = async (expression) => {
    if (!isAttached()) {
      return { ok: false, error: "no CDP session is attached" };
    }
    const { value, exceptionInfo } = await evaluate(expression, { timeout: requestTimeoutMs });
    if (exceptionInfo) {
      return { ok: false, error: exceptionInfo.value || "the app refused the expression" };
    }
    return { ok: true, value };
  };

  const askApp = async (expression) => {
    const outcome = await evaluateInApp(expression);
    return outcome.ok ? outcome.value === true : false;
  };

  const bindingIsLive = () =>
    askApp(`typeof globalThis[${JSON.stringify(BINDING_NAME)}] === "function"`);

  const loaderIsLive = () =>
    askApp(
      `typeof ${DISPATCH_GLOBAL} === "object" && ${DISPATCH_GLOBAL} !== null && ` +
        `${DISPATCH_GLOBAL}.__protocol === 1 && typeof ${DISPATCH_GLOBAL}.dispatch === "function"`
    );

  /**
   * The shell's one `Runtime.addBinding`. Re-sent when the session or context changes:
   * the backend's own tests say a removed binding stays installed until the context is
   * recreated, and a recreated context has no handler at all.
   */
  const ensureBinding = async () => {
    if (bindingInstalledFor === bindingGeneration()) {
      return true;
    }
    try {
      await sendCommand("Runtime.addBinding", { name: BINDING_NAME }, { timeoutMs: requestTimeoutMs });
      bindingInstalledFor = bindingGeneration();
      return true;
    } catch (error) {
      line(`Runtime.addBinding refused: ${error.message} — no app→host leg exists, so nothing is injected`);
      return false;
    }
  };

  /** The app context as a mesh member: panel ⇄ worker ⇄ app is the ONE router. */
  const registerAppFrame = (extensionId) => {
    if (!router) return;
    router.registerFrame({
      key: appFrameKey(extensionId),
      extensionId,
      url: appFrameURL(extensionId),
      send: (delivery) => {
        deliverToApp(extensionId, delivery).catch((error) =>
          line(`${extensionId}: delivery failed: ${error.message}`)
        );
      },
    });
    const record = state.get(extensionId) || {};
    state.set(extensionId, { ...record, frameRegistered: true });
  };

  /** Retire an extension's app-side state and withdraw its mesh seat. */
  const withdraw = (extensionId, why) => {
    const record = state.get(extensionId) || {};
    if (record.frameRegistered && router) {
      router.unregisterFrame(appFrameKey(extensionId));
    }
    appPorts.delete(extensionId);
    state.set(extensionId, {
      ...record,
      injected: false,
      frameRegistered: false,
      lastError: why,
    });
  };

  const senderTab = async (extensionId) => {
    const info = await targetSnapshot();
    if (!info.attached) return null;
    return syntheticTab({
      tabId: tabIdFor(extensionId),
      attached: true,
      url: info.url,
      title: info.title,
    });
  };

  /** host → app, with the synthetic tab attached as the honest `sender.tab`. */
  const deliverToApp = async (extensionId, delivery) => {
    const record = state.get(extensionId) || {};
    if (!isAttached()) {
      withdraw(extensionId, "the CDP session went away");
      return;
    }
    const kind = delivery && delivery.kind;
    const payload = (delivery && delivery.payload) || {};
    // Port ids: the router mints its own, the app minted its own for a port IT opened.
    // Translate before dispatching so both sides address one port.
    const appPortKey = appPorts.get(extensionId) && appPorts.get(extensionId).get(payload.portId);
    const envelope = {
      t: "delivery",
      x: extensionId,
      k: kind,
      s: appPortKey !== undefined ? appPortKey : payload.requestId ?? payload.portId,
      p: payload,
    };
    if (kind === "message" || kind === "port-connect") {
      const tab = await senderTab(extensionId);
      if (tab) {
        envelope.p = { ...payload, sender: { ...(payload.sender || {}), tab } };
      }
    }
    const outcome = await evaluateInApp(dispatchExpression(envelope));
    if (!outcome.ok) {
      line(`${extensionId}: the app refused a ${kind} delivery: ${outcome.error}`);
      if (kind === "message" && router) {
        // Chrome settles a leg whose receiver died rather than hanging the sender.
        router.resolveDelivery({
          fromKey: appFrameKey(extensionId),
          requestId: payload.requestId,
          response: undefined,
        });
      }
    }
  };

  /** The answer to an app-initiated sendMessage: host→app, so it needs a session. */
  const answerApp = async (extensionId, seq, response, error) => {
    const outcome = await evaluateInApp(
      dispatchExpression({ t: "response", x: extensionId, s: seq, m: response, e: error })
    );
    if (!outcome.ok) {
      line(`${extensionId}: the answer to ${JSON.stringify(seq)} could not reach the app: ${outcome.error}`);
    }
  };

  const portsOf = (extensionId) => {
    if (!appPorts.has(extensionId)) appPorts.set(extensionId, new Map());
    return appPorts.get(extensionId);
  };

  // ── app → host: the ONE binding every injected extension shares ───────────────
  const onBindingCalled = async (params) => {
    if (!params || params.name !== BINDING_NAME) return;
    let envelope;
    try {
      envelope = JSON.parse(String(params.payload));
    } catch {
      // A malformed or hostile payload can only ever be an unparsable string: it is
      // dropped with one line and never reaches the router or another extension.
      line("ignored an unparsable binding payload");
      return;
    }
    if (!envelope || typeof envelope !== "object" || typeof envelope.t !== "string") {
      line("ignored a binding payload with no envelope type");
      return;
    }
    const extensionId = envelope.x;
    if (typeof extensionId !== "string" || !state.has(extensionId)) {
      line(`ignored a ${JSON.stringify(envelope.t)} envelope claiming unknown extension ${JSON.stringify(extensionId)}`);
      return;
    }
    // Sequence ids come in two namespaces and BOTH are legitimate: the app's own
    // `"<extensionId>#<n>"` strings for an app-initiated send, and the ROUTER's numeric
    // request ids when the app is answering a delivery the mesh started.
    if (envelope.t !== "report" && typeof envelope.s !== "string" && typeof envelope.s !== "number") {
      line("ignored an envelope with no sequence id");
      return;
    }
    const key = appFrameKey(extensionId);

    switch (envelope.t) {
      case "send": {
        if (!router) {
          await answerApp(extensionId, envelope.s, undefined, "no messaging router is running");
          return;
        }
        if (!state.get(extensionId).injected) {
          await answerApp(extensionId, envelope.s, undefined, "this extension is not injected");
          return;
        }
        const response = await router.sendMessage({ fromKey: key, message: envelope.m });
        await answerApp(extensionId, envelope.s, response);
        return;
      }
      case "respond": {
        if (!router) return;
        router.resolveDelivery({
          fromKey: key,
          requestId: envelope.s,
          // `nr: true` is the app saying "this context was reached, nothing is listening
          // in it". It settles the leg but is NOT a response value, so it travels as the
          // router's own marker with the app's reason attached — see message-router.js.
          response:
            envelope.nr === true
              ? {
                  __rozeniteNoReceiver: true,
                  error: envelope.e || "Could not establish connection. Receiving end does not exist.",
                }
              : envelope.m,
        });
        return;
      }
      case "port-connect": {
        if (!router) return;
        const result = router.connect({ fromKey: key, name: envelope.n || "" });
        if (!result.ok) {
          await evaluateInApp(
            dispatchExpression({
              t: "port-drop",
              x: extensionId,
              s: envelope.s,
              p: result.error || "Could not establish connection.",
            })
          );
          return;
        }
        const ports = portsOf(extensionId);
        ports.set(envelope.s, result.portId);
        ports.set(result.portId, envelope.s);
        await evaluateInApp(
          dispatchExpression({ t: "port-open", x: extensionId, s: envelope.s, p: result.portId })
        );
        return;
      }
      case "port-post": {
        if (!router) return;
        const hostPortId = portsOf(extensionId).get(envelope.s);
        if (hostPortId === undefined) {
          line(`${extensionId}: post on an app port the router never opened`);
          return;
        }
        router.portPost({ fromKey: key, portId: hostPortId, message: envelope.m });
        return;
      }
      case "port-close": {
        if (!router) return;
        const ports = portsOf(extensionId);
        const hostPortId = ports.get(envelope.s);
        if (hostPortId === undefined) return;
        router.portDisconnect({ fromKey: key, portId: hostPortId });
        ports.delete(envelope.s);
        ports.delete(hostPortId);
        return;
      }
      case "report": {
        line(`${extensionId}: the app reported ${JSON.stringify(envelope.k)}: ${envelope.d}`);
        return;
      }
      default:
        line(`${extensionId}: ignored envelope type ${JSON.stringify(envelope.t)}`);
    }
  };

  // ── lifecycle ───────────────────────────────────────────────────────────────
  const scheduleReinject = (cause) => {
    if (disposed) return;
    contextEpoch += 1;
    if (reinjectTimer) clearTimer(reinjectTimer);
    reinjectTimer = setTimer(() => {
      reinjectTimer = null;
      line(`${cause}: the app's execution context changed, re-running injection`);
      refresh().catch((error) => line(`re-injection failed: ${error.message}`));
    }, 0);
  };

  const ensureSweeper = () => {
    if (sweeper || disposed || sweepIntervalMs <= 0) return;
    sweeper = setTimer(() => {
      sweeper = null;
      sweep();
      ensureSweeper();
    }, sweepIntervalMs);
  };

  /** Attached state changed? Reconcile mesh seats, and pick up anything deferred. */
  const sweep = () => {
    if (!isAttached()) {
      for (const extensionId of [...state.keys()]) {
        if (state.get(extensionId).injected) {
          withdraw(extensionId, "the CDP session is not attached");
        }
      }
      bindingInstalledFor = null;
      return false;
    }
    const deferred = [...state.values()].some((record) => record.pending);
    if (deferred) {
      refresh().catch(() => {});
      return true;
    }
    const injected = [...state.values()].filter((record) => record.injected);
    if (injected.length > 0) {
      // Nothing tells us the app restarted except a dead loader: if the dispatch global
      // is gone, the scripts that were in there are gone too.
      loaderIsLive().then((live) => {
        if (!live && !disposed) {
          for (const record of injected) {
            withdraw(record.extensionId, "the app's content-bridge loader is gone");
          }
          refresh().catch(() => {});
        }
      });
    }
    return true;
  };

  /** Decide (and, where allowed, inject) everything the scan reports. Idempotent. */
  const refresh = async () => {
    if (disposed) return report();
    let found = [];
    try {
      found = scan() || [];
    } catch (error) {
      line(`scan failed: ${error.message}`);
      return report();
    }
    for (const entry of found) {
      await injectExtension(entry);
    }
    ensureSweeper();
    return report();
  };

  /** Decide + inject one extension's entries; the verdict is recorded either way. */
  const injectExtension = async (found) => {
    const { extensionId } = found;
    const info = await targetSnapshot();
    const targetUrl = info.attached ? String(info.url || "") : "";
    const manifest = safeManifest(extensionId);
    const entries = decideEntriesFor(found, manifest, targetUrl);
    state.set(extensionId, {
      extensionId,
      name: found.name,
      entries,
      injected: false,
      pending: false,
      lastError: null,
      at: Date.now(),
    });
    logVerdicts(extensionId, entries);

    const allowed = entries.filter((entry) => entry.decision.allowed && !entry.unreadable);
    if (allowed.length === 0) {
      const blocked = entries.find((entry) => entry.decision.allowed && entry.unreadable);
      state.set(extensionId, {
        ...state.get(extensionId),
        lastError: blocked
          ? (blocked.problems || []).join("; ")
          : "nothing allowlisted",
      });
      return state.get(extensionId);
    }
    if (!isAttached()) {
      // An honest rejection, not a queued lie.
      const why = "no CDP session is attached: injection is not queued as a promise to do it later";
      line(`${extensionId}: deferred — ${why}`);
      state.set(extensionId, { ...state.get(extensionId), pending: true, lastError: why });
      return state.get(extensionId);
    }

    const binding = await ensureBinding();
    const live = binding && (await bindingIsLive());
    if (!live) {
      // Without the binding every message the app sent would be shouted into a void, so
      // nothing is injected at all: a script with no transport is a silently broken one.
      const why = `the app did not install ${BINDING_NAME}: nothing is injected`;
      line(`${extensionId}: ${why}`);
      state.set(extensionId, { ...state.get(extensionId), lastError: why });
      return state.get(extensionId);
    }

    let injectedAny = false;
    for (const entry of allowed) {
      const expression = injectionExpression({
        extensionId,
        innerPaths: (entry.sources || []).map((source) => source.innerPath),
        source: (entry.sources || []).map((source) => source.source).join("\n;\n"),
        loader,
      });
      const outcome = await evaluateInApp(expression);
      entry.injected = outcome.ok;
      entry.injectError = outcome.ok ? null : outcome.error;
      if (outcome.ok) {
        injectedAny = true;
        line(`${extensionId}[${entry.index}]: injected ${(entry.sources || [])
          .map((source) => source.innerPath)
          .join(", ")}`);
      } else {
        line(`${extensionId}[${entry.index}]: the app refused the script: ${outcome.error}`);
        state.set(extensionId, { ...state.get(extensionId), lastError: outcome.error });
      }
    }
    if (injectedAny) {
      registerAppFrame(extensionId);
      state.set(extensionId, {
        ...state.get(extensionId),
        injected: true,
        pending: false,
        lastError: null,
      });
    }
    return state.get(extensionId);
  };

  const attach = () => {
    // The app→host leg proper. `Runtime.bindingCalled` is the ONLY thing the app has to
    // talk back with (host→app rides an evaluate, whose reply can only arrive while a
    // session exists), so an injection that subscribed to nothing else would leave every
    // injected script permanently mute. Subscribed by exact method name: the payload
    // envelope is untrusted app data, and `onBindingCalled` checks the binding name before
    // parsing it, which is what keeps the frontend's own React-DevTools binding
    // (`__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__`, same session, same notification) from
    // being read as an extension message.
    unsubscribeBinding = onEvent("Runtime.bindingCalled", (params) => {
      void onBindingCalled(params);
    });
    unsubscribe = onEvent("*", (params, method) => {
      if (method === "Runtime.executionContextCreated") {
        scheduleReinject("Runtime.executionContextCreated");
      } else if (method === "Runtime.executionContextsCleared") {
        for (const extensionId of [...state.keys()]) {
          withdraw(extensionId, "the app's execution contexts were cleared");
        }
        scheduleReinject("Runtime.executionContextsCleared");
      }
    });
    return refresh();
  };

  const dispose = () => {
    disposed = true;
    if (unsubscribe) unsubscribe();
    if (unsubscribeBinding) unsubscribeBinding();
    if (reinjectTimer) clearTimer(reinjectTimer);
    if (sweeper) clearTimer(sweeper);
    for (const extensionId of [...state.keys()]) {
      withdraw(extensionId, "the content bridge was disposed");
    }
  };

  /**
   * The receiver `chrome.tabs.sendMessage` is allowed to address: this extension's app
   * context, as its seat in the ONE mesh. Issue #12 left the gap deliberately — routing a
   * tab message into the extension's own listeners let an extension message itself and
   * read the success as a page having answered — and this closes it honestly: the app
   * context really is the inspected tab, and the caller stays whatever frame asked, so
   * the router does the extension scoping and no self-addressing is possible.
   *
   * @returns {{ok: true, frameKey: string}|{ok: false, error: string}}
   */
  const tabTarget = ({ extensionId }) => {
    const record = state.get(extensionId);
    if (!router) {
      return { ok: false, error: "no messaging router is running" };
    }
    if (!record || !record.injected || !record.frameRegistered) {
      return {
        ok: false,
        error:
          `tabs.sendMessage: no content script of "${extensionId}" is running in the inspected ` +
          "target, so nothing can receive this message. docs/features/CONTENT-SCRIPTS.md is the " +
          `opt-in; its current state here is ` +
          `${record ? (record.pending ? "pending an attach" : "not injected") : "not scanned"}` +
          (record && record.lastError ? ` (${record.lastError})` : ""),
      };
    }
    if (!isAttached()) {
      return {
        ok: false,
        error: "tabs.sendMessage: the CDP session to the inspected target is not attached",
      };
    }
    return { ok: true, frameKey: appFrameKey(extensionId) };
  };

  const report = () =>
    [...state.values()].map((record) => ({
      extensionId: record.extensionId,
      name: record.name,
      injected: Boolean(record.injected),
      pending: Boolean(record.pending),
      lastError: record.lastError || null,
      entries: (record.entries || []).map((entry) => ({
        index: entry.index,
        js: entry.js,
        allowed: Boolean(entry.decision && entry.decision.allowed),
        code: (entry.decision && entry.decision.code) || null,
        injected: entry.injected === true,
        injectError: entry.injectError || null,
        reasons: (entry.decision && entry.decision.reasons) || [],
        notes: (entry.decision && entry.decision.notes) || [],
        problems: entry.problems || [],
      })),
    }));

  return {
    attach,
    refresh,
    dispose,
    report,
    tabTarget,
    sweep,
    /** Test seam: the app→host leg exactly as `Runtime.bindingCalled` hands it over. */
    onBindingCalled,
    /** Test seam: what the host evaluates to reach the app. */
    dispatchExpression,
    bindingName: BINDING_NAME,
    appFrameKey,
  };
};

// ── the shell's one content bridge ───────────────────────────────────────────
// Same shape as `attachBackgroundHost` / `getTabHost`: build it with the real
// collaborators, start it, and let the IPC layer reach it. Nothing here reaches a
// frame directly — the bridge talks to the app over the CDP bridge and to every other
// context through the ONE message router it is handed.
let instance = null;

/**
 * @param {object} deps overrides for tests; each default is the real collaborator.
 * @param {object} deps.router the message router the app's seat joins (required: an
 *        injected script with no way to reach a panel is a silently broken one)
 */
const attachContentBridge = ({ router, log = console, ...overrides } = {}) => {
  const cdp = require("./cdp-bridge");
  const config = require("./config");
  const { scanContentScriptExtensions } = require("./extensions");
  const { resolveEntryPaths, readEntrySources } = require("./content-scripts");
  const { loadManifest } = require("./extension-server");
  const tabHost = require("./tab-host");

  const bridge = createContentBridge({
    sendCommand: cdp.sendCommand,
    onEvent: cdp.onEvent,
    isAttached: () => Boolean(cdp.status().attached),
    scan: scanContentScriptExtensions,
    readManifest: loadManifest,
    resolvePaths: resolveEntryPaths,
    readSources: readEntrySources,
    allowlist: config.contentScripts,
    router,
    targetInfo: () => tabHost.getTabHost().targetInfo(),
    log,
    ...overrides,
  });
  instance = bridge;
  const allowlisted = String(config.contentScripts || "").trim();
  console.log(
    allowlisted
      ? `[content-scripts] opt-in is set (${allowlisted}); injection runs when a session is attached`
      : "[content-scripts] DEVTOOLS_CONTENT_SCRIPTS is unset, so NO content script is injected (docs/features/CONTENT-SCRIPTS.md)"
  );
  bridge.attach().catch((error) => {
    console.warn(`[content-scripts] first pass failed: ${error.message}`);
  });
  return bridge;
};

const getContentBridge = () => instance;

module.exports = {
  BINDING_NAME,
  DISPATCH_GLOBAL,
  APP_FRAME_PREFIX,
  RESPONSE_WAIT_MS,
  loaderSource,
  injectionExpression,
  dispatchExpression,
  appFrameKey,
  appFrameURL,
  createContentBridge,
  attachContentBridge,
  getContentBridge,
};
