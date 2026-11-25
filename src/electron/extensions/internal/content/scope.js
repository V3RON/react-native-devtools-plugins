// An extension's `window` inside the inspected app (docs/features/CONTENT-SCRIPTS.md,
// "The extension's window").
//
// Pure string generation: every expression here is evaluated INSIDE THE APP, by the
// content bridge (./content-bridge.js), by inspectedWindow.eval (../cdp/inspected-window.js)
// and by the dev-only early installer a bundler can run before any app module
// (../../early-main-world.js). No Electron, no I/O, so all three can share it.

/** Where the per-extension scopes live on the app's global (non-enumerable, never clobbered). */
const SCOPE_REGISTRY_KEY = "rozenite.content-bridge.scopes";

/** The loader's global (./content-bridge.js); the scope asks it to load `<script src>`. */
const DISPATCH_GLOBAL = "__RozeniteContentBridge";

/** How many bus messages the scope keeps for an ISOLATED world that has not arrived yet. */
const EARLY_BUFFER_LIMIT = 500;

/**
 * Names a script sees as BARE identifiers bound to the scope's values (the wrapper's
 * parameters), in this order. `window.x`-qualified access goes through the Proxy; these
 * cover the unqualified `document.title` / `navigator.userAgent` / `new CustomEvent(…)`
 * that browser-built content scripts write.
 */
const SCOPED_GLOBALS = [
  "window",
  "self",
  "globalThis",
  "document",
  "location",
  "navigator",
  "Event",
  "CustomEvent",
  "MessageEvent",
  "EventTarget",
  "MessageChannel",
  "MessagePort",
];

/**
 * An expression that evaluates, INSIDE THE APP, to extension `extensionId`'s `window`.
 *
 * Chrome's content scripts and the page's MAIN world talk through `window.postMessage`
 * and the `message` event (mobx-devtools: contentScript.js <-> backend.js). A Hermes
 * global has neither, and installing them on the real global would leak one extension's
 * traffic to every other extension and to the app, and would make the app's own
 * libraries (React's scheduler, setImmediate shims) think they run in a browser.
 *
 * So each extension gets a Proxy over the real global instead:
 *   - `postMessage`, `addEventListener`/`removeEventListener` for "message", and
 *     `onmessage` go to a bus PRIVATE TO THAT EXTENSION. Every script that extension
 *     injects, in either world and across evaluates, shares the bus. That is the
 *     channel the two Chrome worlds share, minus the page and other extensions (Chrome
 *     lets both of those see and spoof it: this is deliberately stricter).
 *   - Delivery is asynchronous (`setTimeout(0)`), like the browser's. Handlers that
 *     remove themselves and reply from inside the handler rely on that.
 *   - `data` crosses BY REFERENCE, not structured-cloned (Hermes has no structuredClone).
 *     A `transfer` list's MessagePorts arrive as the event's `ports` (Apollo's hook hands
 *     its content script a MessageChannel port this way).
 *   - `window`, `self` and `globalThis` read through the scope return the scope.
 *   - The browser surface content scripts assume and Hermes lacks is answered from the
 *     scope only, never installed on the app's global: `document` (an event target with
 *     `title: ""`, nodes, and `<script src>` that runs the extension's own file in this
 *     scope), `location` (`about:blank`: an RN target has no URL), `navigator` (the app's,
 *     plus a `userAgent` string when the app has none), `Event`/`CustomEvent`/
 *     `EventTarget` and `MessageChannel`/`MessagePort`. Where the app's runtime has a
 *     real one (RN's own `navigator`, a polyfilled `Event`), the real one is used.
 *   - Messages posted before the extension's ISOLATED world exists are kept (bounded) and
 *     handed to that world's listeners when it arrives (`__rozeniteClaim`). In Chrome a
 *     `document_start` content script always precedes the page's code; here the page's
 *     code (a hook installed before any module, ../../early-main-world.js) runs first,
 *     and Redux DevTools' first `INIT_INSTANCE` would otherwise be lost.
 *   - Everything else (reads, writes, defineProperty, `in`) passes to the real global,
 *     so `window.__MOBX_DEVTOOLS_GLOBAL_HOOK__` is the hook the app's mobx calls.
 *
 * The scope is self-contained (no loader, no binding), because MAIN-world injections run
 * without the loader. It only reaches the loader for `<script src>`, and only if present.
 */
const scopeExpression = (extensionId) => `(function (g, id) {
  var KEY = Symbol.for(${JSON.stringify(SCOPE_REGISTRY_KEY)});
  var registry = g[KEY];
  if (!registry) {
    registry = Object.create(null);
    Object.defineProperty(g, KEY, { value: registry, enumerable: false });
  }
  if (registry[id]) return registry[id];

  var listeners = [];
  var onmessage = null;
  var scope;
  var claimed = false;
  var early = [];
  // Resolved per call: a scope created before React Native's InitializeCore (a hook run
  // by the bundler, ../../early-main-world.js) outlives the moment timers are installed.
  var later = function (fn) {
    if (typeof g.setTimeout === "function") g.setTimeout(fn, 0);
    else Promise.resolve().then(fn);
  };
  function report(error) {
    if (typeof console !== "undefined" && console.error) console.error(error);
  }
  function isListener(fn) {
    return typeof fn === "function" || (fn && typeof fn.handleEvent === "function");
  }
  function invoke(fn, event, self) {
    try {
      if (typeof fn === "function") fn.call(self, event);
      else fn.handleEvent(event);
    } catch (error) {
      // The browser reports a throwing listener and keeps delivering to the rest.
      report(error);
    }
  }
  function currentListeners() {
    var current = listeners.slice();
    if (typeof onmessage === "function") current.push(onmessage);
    return current;
  }

  // ── Event / CustomEvent / EventTarget ───────────────────────────────────────
  function EventShim(type, init) {
    this.type = String(type);
    this.bubbles = !!(init && init.bubbles);
    this.cancelable = !!(init && init.cancelable);
    this.composed = !!(init && init.composed);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.timeStamp = Date.now();
    this.isTrusted = false;
  }
  EventShim.prototype.preventDefault = function () { if (this.cancelable) this.defaultPrevented = true; };
  EventShim.prototype.stopPropagation = function () {};
  EventShim.prototype.stopImmediatePropagation = function () { this.__stopped = true; };
  function CustomEventShim(type, init) {
    EventShim.call(this, type, init);
    this.detail = init && init.detail !== undefined ? init.detail : null;
  }
  CustomEventShim.prototype = Object.create(EventShim.prototype);
  CustomEventShim.prototype.constructor = CustomEventShim;

  // Accessors on the prototype, as in the browser: Apollo's scripts take
  // \`Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data").get\` up front and
  // read every event through it.
  function MessageEventShim(type, init) {
    EventShim.call(this, type, init);
    Object.defineProperty(this, "__message", {
      value: {
        data: init && init.data !== undefined ? init.data : null,
        origin: (init && init.origin) || "",
        lastEventId: (init && init.lastEventId) || "",
        source: (init && init.source) || null,
        ports: (init && init.ports) || []
      },
      enumerable: false
    });
  }
  MessageEventShim.prototype = Object.create(EventShim.prototype);
  MessageEventShim.prototype.constructor = MessageEventShim;
  ["data", "origin", "lastEventId", "source", "ports"].forEach(function (name) {
    Object.defineProperty(MessageEventShim.prototype, name, {
      get: function () { return this.__message[name]; },
      enumerable: true,
      configurable: true
    });
  });
  // A delivery of postMessage, i.e. the event the BROWSER dispatches, so \`isTrusted\` is
  // true (Apollo's content script ignores any message event that is not). An event a
  // script constructs itself stays untrusted, as in the browser.
  function messageEvent(init) {
    var event;
    try { event = new shims.MessageEvent("message", init); } catch (ignored) {
      event = { type: "message", data: init.data, origin: "", lastEventId: "", source: init.source, ports: init.ports };
    }
    try { Object.defineProperty(event, "isTrusted", { value: true, enumerable: true }); } catch (ignored) {}
    return event;
  }

  function EventTargetShim() {}
  function table(target) {
    if (!Object.prototype.hasOwnProperty.call(target, "__rozeniteListeners")) {
      Object.defineProperty(target, "__rozeniteListeners", { value: Object.create(null), enumerable: false });
    }
    return target.__rozeniteListeners;
  }
  EventTargetShim.prototype.addEventListener = function (type, fn, options) {
    if (!isListener(fn)) return;
    var list = table(this)[type] || (table(this)[type] = []);
    for (var i = 0; i < list.length; i++) if (list[i].fn === fn) return;
    var entry = { fn: fn, once: !!(options && typeof options === "object" && options.once) };
    list.push(entry);
    var signal = options && typeof options === "object" ? options.signal : null;
    var target = this;
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) { target.removeEventListener(type, fn); return; }
      signal.addEventListener("abort", function () { target.removeEventListener(type, fn); });
    }
  };
  EventTargetShim.prototype.removeEventListener = function (type, fn) {
    var list = table(this)[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) if (list[i].fn === fn) { list.splice(i, 1); return; }
  };
  EventTargetShim.prototype.dispatchEvent = function (event) {
    var list = (table(this)[event && event.type] || []).slice();
    try { event.target = this; event.currentTarget = this; } catch (ignored) {}
    var handler = this["on" + (event && event.type)];
    if (typeof handler === "function") list.push({ fn: handler, once: false });
    for (var i = 0; i < list.length; i++) {
      if (list[i].once) this.removeEventListener(event.type, list[i].fn);
      invoke(list[i].fn, event, this);
      if (event && event.__stopped) break;
    }
    return !(event && event.defaultPrevented);
  };
  // A target of the scope's own, for the non-message events a script registers on
  // \`window\` (Relay's "pageshow", TanStack's location watcher, Redux's "error").
  var windowEvents = new EventTargetShim();

  // ── MessageChannel / MessagePort ────────────────────────────────────────────
  function PortShim() {
    this.__other = null;
    this.__queue = [];
    this.__started = false;
    this.__closed = false;
    this.__onmessage = null;
  }
  PortShim.prototype = Object.create(EventTargetShim.prototype);
  PortShim.prototype.constructor = PortShim;
  Object.defineProperty(PortShim.prototype, "onmessage", {
    get: function () { return this.__onmessage; },
    set: function (fn) { this.__onmessage = typeof fn === "function" ? fn : null; this.start(); }
  });
  PortShim.prototype.postMessage = function (data, transfer) {
    var other = this.__other;
    if (!other || this.__closed) return;
    var ports = portsOf(transfer);
    later(function () { other.__deliver(data, ports); });
  };
  PortShim.prototype.__deliver = function (data, ports) {
    if (this.__closed) return;
    if (!this.__started) { this.__queue.push([data, ports]); return; }
    var event = messageEvent({ data: data, ports: ports || [], source: null });
    var list = (table(this).message || []).slice();
    try { event.target = this; event.currentTarget = this; } catch (ignored) {}
    for (var i = 0; i < list.length; i++) invoke(list[i].fn, event, this);
    if (typeof this.__onmessage === "function") invoke(this.__onmessage, event, this);
  };
  PortShim.prototype.start = function () {
    if (this.__started) return;
    this.__started = true;
    var port = this;
    var queued = this.__queue.splice(0);
    later(function () { for (var i = 0; i < queued.length; i++) port.__deliver(queued[i][0], queued[i][1]); });
  };
  PortShim.prototype.close = function () {
    this.__closed = true;
    if (this.__other) this.__other.__closed = true;
  };
  function ChannelShim() {
    this.port1 = new PortShim();
    this.port2 = new PortShim();
    this.port1.__other = this.port2;
    this.port2.__other = this.port1;
  }
  function portsOf(transfer) {
    var list = transfer && !Array.isArray(transfer) && Array.isArray(transfer.transfer) ? transfer.transfer : transfer;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i].postMessage === "function") out.push(list[i]);
    }
    return out;
  }

  // ── document ────────────────────────────────────────────────────────────────
  function NodeShim(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.parentNode = null;
    this.childNodes = [];
    this.style = {};
    this.dataset = {};
    this.textContent = "";
  }
  NodeShim.prototype = Object.create(EventTargetShim.prototype);
  NodeShim.prototype.constructor = NodeShim;
  NodeShim.prototype.setAttribute = function (name, value) { this[name] = String(value); };
  NodeShim.prototype.getAttribute = function (name) { return name in this ? this[name] : null; };
  NodeShim.prototype.removeAttribute = function (name) { delete this[name]; };
  NodeShim.prototype.appendChild = function (child) {
    if (child && child.parentNode) child.parentNode.removeChild(child);
    if (child) { child.parentNode = this; this.childNodes.push(child); }
    if (child && child.tagName === "SCRIPT") runScript(child);
    return child;
  };
  NodeShim.prototype.insertBefore = function (child) { return this.appendChild(child); };
  NodeShim.prototype.prepend = function (child) { this.appendChild(child); };
  NodeShim.prototype.append = function (child) { this.appendChild(child); };
  NodeShim.prototype.removeChild = function (child) {
    var at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    if (child) child.parentNode = null;
    return child;
  };
  NodeShim.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  NodeShim.prototype.querySelector = function () { return null; };
  NodeShim.prototype.querySelectorAll = function () { return []; };
  function settle(node, ok, error) {
    later(function () {
      var event = new EventShim(ok ? "load" : "error");
      if (!ok) event.error = error;
      node.dispatchEvent(event);
    });
  }
  // \`<script src>\` is how a content script reaches the MAIN world in a browser (Relay
  // DevTools' detector and backend). The src must be one of this extension's own files;
  // the loader (present once the ISOLATED world is injected) asks the host to run it here.
  function runScript(node) {
    var src = node.src ? String(node.src) : "";
    if (!src) {
      var text = String(node.textContent || node.text || "");
      if (!text) return;
      try {
        new Function(${JSON.stringify(SCOPED_GLOBALS.join(","))}, text).apply(scope, bareArgs());
        settle(node, true);
      } catch (error) { report(error); settle(node, false, error); }
      return;
    }
    var host = g[${JSON.stringify(DISPATCH_GLOBAL)}];
    if (!host || typeof host.loadScript !== "function") {
      settle(node, false, new Error("this script cannot be loaded before the extension's content script is injected"));
      return;
    }
    host.loadScript(id, src, function (ok, error) { settle(node, ok, error); });
  }
  var documentElement = new NodeShim("html");
  var head = new NodeShim("head");
  var body = new NodeShim("body");
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  var documentShim = Object.create(EventTargetShim.prototype);
  documentShim.nodeType = 9;
  documentShim.title = "";
  documentShim.readyState = "complete";
  documentShim.visibilityState = "visible";
  documentShim.hidden = false;
  documentShim.documentElement = documentElement;
  documentShim.head = head;
  documentShim.body = body;
  documentShim.cookie = "";
  documentShim.referrer = "";
  documentShim.createElement = function (tag) { return new NodeShim(tag); };
  documentShim.createTextNode = function (text) { var node = new NodeShim("#text"); node.nodeType = 3; node.textContent = String(text); return node; };
  documentShim.getElementById = function () { return null; };
  documentShim.getElementsByTagName = function (tag) { return String(tag).toLowerCase() === "head" ? [head] : String(tag).toLowerCase() === "body" ? [body] : []; };
  documentShim.querySelector = function () { return null; };
  documentShim.querySelectorAll = function () { return []; };

  // ── location / navigator ─────────────────────────────────────────────────────
  var locationShim = {
    href: "about:blank", origin: "null", protocol: "about:", host: "", hostname: "", port: "",
    pathname: "blank", search: "", hash: "",
    assign: function () {}, replace: function () {}, reload: function () {},
    toString: function () { return this.href; }
  };
  // Also per read, for the same reason: React Native installs \`navigator\` in InitializeCore.
  var navigatorFor = null;
  var navigatorShim = null;
  function currentNavigator() {
    var real = g.navigator;
    if (real && typeof real.userAgent === "string") return real;
    if (navigatorShim && navigatorFor === real) return navigatorShim;
    navigatorFor = real;
    navigatorShim = Object.create(real && typeof real === "object" ? real : null, {
      userAgent: { value: "ReactNative (Hermes) rozenite-content-bridge", enumerable: true },
      language: { value: (real && real.language) || "en-US", enumerable: true },
      languages: { value: (real && real.languages) || ["en-US"], enumerable: true }
    });
    return navigatorShim;
  }

  function realOr(name, shim) { return typeof g[name] === "function" ? g[name] : shim; }
  var shims = {
    document: g.document && typeof g.document === "object" ? g.document : documentShim,
    location: g.location && typeof g.location === "object" ? g.location : locationShim,
    Event: realOr("Event", EventShim),
    CustomEvent: realOr("CustomEvent", CustomEventShim),
    MessageEvent: realOr("MessageEvent", MessageEventShim),
    EventTarget: realOr("EventTarget", EventTargetShim),
    MessageChannel: realOr("MessageChannel", ChannelShim),
    MessagePort: realOr("MessagePort", PortShim)
  };
  if (shims.document === documentShim) documentShim.defaultView = null; // set below, once the scope exists

  // ── the bus ─────────────────────────────────────────────────────────────────
  var overrides = {
    postMessage: function (data, targetOrigin, transfer) {
      var ports = portsOf(transfer !== undefined ? transfer : targetOrigin);
      var item = null;
      if (!claimed) {
        item = { data: data, ports: ports, seen: [] };
        early.push(item);
        if (early.length > ${EARLY_BUFFER_LIMIT}) early.shift();
      }
      later(function () {
        var event = messageEvent({ data: data, source: scope, ports: ports });
        var current = currentListeners();
        // Whoever hears it now must not hear it again from __rozeniteClaim's replay.
        if (item) item.seen = current.slice();
        for (var i = 0; i < current.length; i++) invoke(current[i], event, scope);
      });
    },
    addEventListener: function (type, fn) {
      if (type === "message") {
        if (isListener(fn) && listeners.indexOf(fn) === -1) listeners.push(fn);
        return;
      }
      // Not a message: the real global's, if this runtime has one, else the scope's own.
      if (typeof g.addEventListener === "function") return g.addEventListener.apply(g, arguments);
      return windowEvents.addEventListener.apply(windowEvents, arguments);
    },
    removeEventListener: function (type, fn) {
      if (type === "message") {
        var at = listeners.indexOf(fn);
        if (at !== -1) listeners.splice(at, 1);
        return;
      }
      if (typeof g.removeEventListener === "function") return g.removeEventListener.apply(g, arguments);
      return windowEvents.removeEventListener.apply(windowEvents, arguments);
    },
    dispatchEvent: function (event) {
      if (typeof g.dispatchEvent === "function") return g.dispatchEvent(event);
      return windowEvents.dispatchEvent(event);
    },
    // Inner paths a bundler ran before any app module (../../early-main-world.js): the
    // host does not evaluate them a second time (unlessRanEarly).
    __rozeniteEarly: Object.create(null),
    // The ISOLATED world has arrived (./content-bridge.js injectionExpression): hand it what
    // was posted before it existed, to the listeners that did not hear it then. Once.
    __rozeniteClaim: function () {
      if (claimed) return;
      claimed = true;
      var kept = early.splice(0);
      for (var i = 0; i < kept.length; i++) {
        (function (item) {
          later(function () {
            var event = messageEvent({ data: item.data, source: scope, ports: item.ports });
            var current = currentListeners();
            for (var j = 0; j < current.length; j++) {
              if (item.seen.indexOf(current[j]) === -1) invoke(current[j], event, scope);
            }
          });
        })(kept[i]);
      }
      announceReact();
    }
  };
  // React Native DevTools ships React DevTools built in, so the app always runs its hook
  // (\`__REACT_DEVTOOLS_GLOBAL_HOOK__\`). In a browser the React DevTools extension's hook
  // announces React to the page's window once a renderer registers (installHook.js):
  // \`{source: "react-devtools-hook", payload: {type: "react-renderer-attached",
  // reactBuildType}}\`, and other extensions listen for
  // it (React Context DevTool starts on it). The announcement is the hook's; here it
  // reaches this extension's bus when its content script arrives, after the renderer
  // registered, so the same message a browser page carries is the one heard.
  function announceReact() {
    var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var renderers = hook && hook.renderers;
    if (!renderers || typeof renderers.forEach !== "function" || !renderers.size) return;
    var buildType = "production";
    renderers.forEach(function (renderer) {
      if (renderer && renderer.bundleType === 1) buildType = "development";
    });
    overrides.postMessage({ source: "react-devtools-hook", payload: { type: "react-renderer-attached", reactBuildType: buildType } }, "*");
  }
  var cachedChrome = null;
  function chromeView() {
    if (cachedChrome) return cachedChrome;
    var host = g[${JSON.stringify(DISPATCH_GLOBAL)}];
    if (!host || typeof host.forExtension !== "function") return null;
    cachedChrome = host.forExtension(id, g.chrome);
    return cachedChrome;
  }
  var own = function (key) { return Object.prototype.hasOwnProperty.call(overrides, key); };
  var isShim = function (key) { return Object.prototype.hasOwnProperty.call(shims, key); };
  var self = { window: 1, self: 1, globalThis: 1, top: 1, parent: 1 };
  scope = new Proxy(g, {
    get: function (target, key) {
      if (typeof key === "string") {
        if (own(key)) return overrides[key];
        if (key === "onmessage") return onmessage;
        if (self[key] === 1) return scope;
        if (key === "navigator") return currentNavigator();
        if (key === "chrome" || key === "browser") {
          // \`globalThis.chrome\` must be THIS extension's API, as the lexical \`chrome\` a
          // content script gets is (the app has one global \`chrome\`, owned by whichever
          // extension's loader came first). WXT-built scripts (TanStack Query DevTools)
          // pick \`globalThis.browser ?? globalThis.chrome\`. Before the loader exists
          // (a hook run before any module) there is no API to give.
          var view = chromeView();
          if (view) return key === "chrome" ? view : undefined;
        }
        if (isShim(key)) return shims[key];
      }
      return Reflect.get(target, key);
    },
    set: function (target, key, value) {
      if (key === "onmessage") { onmessage = typeof value === "function" ? value : null; return true; }
      return Reflect.set(target, key, value);
    },
    has: function (target, key) {
      return (typeof key === "string" && (own(key) || key === "onmessage" || key === "navigator" || isShim(key))) || key in target;
    }
  });
  if (shims.document === documentShim) documentShim.defaultView = scope;
  function bareArgs() {
    return [scope, scope, scope, shims.document, shims.location, currentNavigator(), shims.Event,
      shims.CustomEvent, shims.MessageEvent, shims.EventTarget, shims.MessageChannel, shims.MessagePort];
  }
  Object.defineProperty(overrides, "__rozeniteBareArgs", { value: bareArgs, enumerable: true });
  registry[id] = scope;
  return scope;
})(globalThis, ${JSON.stringify(extensionId)})`;

/**
 * Run `body` as a function of the extension's scope: `window`, `self`, `globalThis` and
 * a top-level `this` are all that extension's scope (`scopeExpression`), and the other
 * SCOPED_GLOBALS are bound as bare names. `prelude` is declared first, inside the same
 * function (the ISOLATED world's lexical `chrome`). The expression's value is the
 * function's return value.
 */
const scopedExpression = ({ extensionId, body, prelude = "" }) =>
  `(function (scope) {\n  return (function (${SCOPED_GLOBALS.join(", ")}) {\n${prelude}${body}\n  }).apply(scope, scope.__rozeniteBareArgs());\n})(${scopeExpression(
    extensionId
  )})`;

/** A MAIN-world script: the same scope (so it hears the ISOLATED side), no `chrome`. */
const mainWorldExpression = ({ extensionId, source }) => `${scopedExpression({ extensionId, body: source })};`;

/**
 * `statement`, unless every one of `innerPaths` already ran in this extension's scope
 * before the app's first module (../../early-main-world.js). A hook that installs a
 * non-configurable global (Relay's) must not run twice, and a second Redux
 * `__REDUX_DEVTOOLS_EXTENSION__` would not know the stores the first one serves.
 */
const unlessRanEarly = ({ extensionId, innerPaths, statement }) =>
  Array.isArray(innerPaths) && innerPaths.length > 0
    ? `if (!${JSON.stringify(innerPaths)}.every(function (p) { return ${scopeExpression(
        extensionId
      )}.__rozeniteEarly[p] === true; })) {\n${statement}\n}`
    : statement;

/** Mark `innerPath` as run early in this extension's scope. */
const markRanEarlyExpression = ({ extensionId, innerPath }) =>
  `${scopeExpression(extensionId)}.__rozeniteEarly[${JSON.stringify(innerPath)}] = true;`;

/** The ISOLATED world has arrived: release what the bus kept for it. */
const claimExpression = (extensionId) => `${scopeExpression(extensionId)}.__rozeniteClaim();`;

module.exports = {
  SCOPE_REGISTRY_KEY,
  SCOPED_GLOBALS,
  EARLY_BUFFER_LIMIT,
  scopeExpression,
  scopedExpression,
  mainWorldExpression,
  claimExpression,
  unlessRanEarly,
  markRanEarlyExpression,
};
