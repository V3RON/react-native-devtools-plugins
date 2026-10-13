// Extension-frame preload: runs inside every `rozenite://<extension-id>/...`
// iframe. Wires concrete transports/backends into the pure chrome-shim and
// installs the chrome.* namespace (see docs/ARCHITECTURE.md).
//
// What is deliberately NOT here any more:
//
//   - no raw `ipcRenderer` exposure. The frame gets named, validated channels
//     only; the page world has no Node-level IPC handle (asserted by
//     tests/extension-frame-electron.test.js and live in
//     extensions/sample-extension/panel.html).
//   - no injected-script fetch + `new Function`. The stock frontend no longer
//     ships a per-origin script, because chrome.devtools.* is implemented
//     shell-side in src/chrome-shim/devtools.js
//     (docs/features/DEVTOOLS-PANELS.md), so the whole channel — including its
//     two sendSync exceptions — is gone. `InspectorFrontendHost
//     .setInjectedScriptForOrigin` is a documented no-op.
//
// The frame talks to main through `invoke` only, and the two push channels
// (RUNTIME_DELIVER, NETWORK_DELIVER) are the only things main sends here. The
// host derives this frame's identity from the frame itself, never from payload.

const { contextBridge, ipcRenderer } = require("electron");
const { default: Store } = require("electron-store");
const {
  createChromeNamespace,
  createExtensionStorage,
  createMemoryBackend,
  createNetworkBridge,
} = require("../chrome-shim");
const { createGrantGate } = require("../shared/permissions");
const { takeThemeHint } = require("../shared/theme");
const {
  RUNTIME_GET_MANIFEST,
  RUNTIME_REGISTER,
  RUNTIME_SEND_MESSAGE,
  RUNTIME_SEND_RESPONSE,
  RUNTIME_CONNECT,
  RUNTIME_PORT_POST,
  RUNTIME_PORT_CLOSE,
  RUNTIME_DELIVER,
  EXT_PANEL_CREATE,
  EXT_PANEL_EVENT,
  DEVTOOLS_EVAL,
  DEVTOOLS_RELOAD,
  NETWORK_SUBSCRIBE,
  NETWORK_GET_HAR,
  NETWORK_GET_STATUS,
  NETWORK_GET_BODY,
  NETWORK_DELIVER,
  TABS_TARGET_INFO,
  TABS_OPEN,
  TABS_SEND_TO_APP,
  TABS_CLOSE,
  NOTIFICATION_SHOW,
  NOTIFICATION_CLEAR,
  NOTIFICATION_PERMISSION,
  OPTIONS_OPEN,
  DOWNLOAD_START,
  DOWNLOAD_CANCEL,
  DOWNLOAD_ERASE,
  DOWNLOAD_SEARCH,
  DOWNLOAD_SUGGEST_REPLY,
} = require("../shared/ipc");

const extensionId = window.location.hostname; // id == hostname: load-bearing

// chrome.runtime.getPlatformInfo vocabulary.
const CHROME_OS = { darwin: "mac", win32: "win", linux: "linux" };
const CHROME_ARCH = { x64: "x86-64", arm64: "arm64", ia32: "x86-32" };

// chrome.runtime.getManifest: loaded from the host (id derived main-side from
// this frame's URL). Degraded to {} meanwhile, as before.
let manifestCache = {};
ipcRenderer
  .invoke(RUNTIME_GET_MANIFEST)
  .then((manifest) => {
    manifestCache = manifest || {};
  })
  .catch(() => {});
const getManifest = () => manifestCache;

// Declared permissions gate capability (docs/features/EXTENSION-MANAGEMENT.md).
// The verdict this frame is gated on is the HOST's: RUNTIME_REGISTER read the
// manifest from disk. Gating on that reply rather than on
// chrome.runtime.getManifest() means a page-world script cannot widen its own
// permissions by replacing a function it can reach.
//
// `grants` is undefined until that reply lands, and while it is the gate's
// `check`/`has` return a promise instead of guessing — denying a permission the
// extension does hold (page scripts run before IPC resolves) would be a bug
// worse than the few-millisecond window it protects.
let grants;
const permissions = createGrantGate(() => grants);

// chrome.alarms' clock multiplier, decided by the host and handed back at
// registration (src/main/config.js). 1 = real time; the harness shortens it so a
// headless run can observe a real timer fire inside a worker.
let alarmClockScale = 1;

// electron-store -> chrome-shim StorageBackend adapter.
// NOTE: one Store instance per frame per area races on the shared JSON file;
// swap for a main-process-backed backend (docs/LIMITATIONS.md).
const storeBackend = (store) => ({
  getAll: () => store.store,
  get: (key) => store.get(key),
  set: (items) => store.set(items),
  delete: (key) => store.delete(key),
  clear: () => store.clear(),
});

const storage = createExtensionStorage({
  createBackend: (areaName) =>
    areaName === "session"
      ? createMemoryBackend() // deviation: per-frame, not extension-wide
      : storeBackend(new Store({ name: `extension-${extensionId}-${areaName}` })),
});

// chrome.devtools.network + chrome.webRequest, both fed by the host's CDP network
// model (src/main/network-service.js). Reads are async IPC; request lifecycle
// steps arrive as NETWORK_DELIVER pushes. Nothing is answered from a cache here
// and no body is invented: when the backend cannot report traffic, the host says
// so and the shim reports "no network data" (docs/features/DEVTOOLS-NETWORK.md).
// Every call waits for RUNTIME_REGISTER, because the host derives this frame's
// identity from the registered principal — an unregistered frame is not entitled
// to the app's traffic.
// The one place the frame learns whether the host knows it. Registration can fail in
// two ways — the host refuses (an answer of `{ok: false}`) or the handler throws (a
// rejected invoke) — and BOTH have to settle the permission gate:
//
//   - if they did not, `permissions.check` would keep returning a promise that never
//     resolves, and every gated API call in this context would hang forever with no
//     error anywhere. Measured: a throwing RUNTIME_REGISTER handler made a worker's
//     first `chrome.notifications.create` never call back at all.
//   - the fallback is `{}` — nothing declared — which is the honest reading of "the
//     host told us nothing about this frame". Chrome does not run an extension page it
//     cannot identify either, and a gate that defaults to ALLOWED would be the worst
//     possible guess.
//
// The reason is logged, because a frame that silently loses every capability is the
// kind of failure a developer spends a day on.
const registrationFailed = (reason) => {
  grants = {};
  permissions.manifestLoaded();
  console.error(
    `[chrome] this frame could not register with the host (${reason}); every permission-gated ` +
      "API will report that its permission is not declared."
  );
  return { ok: false, error: reason };
};

const registered = ipcRenderer
  .invoke(RUNTIME_REGISTER)
  .then((reply) => {
    if (!reply || !reply.ok) {
      return registrationFailed("the host refused the registration");
    }
    grants = reply.granted || {};
    const scale = Number(reply.alarmClockScale);
    alarmClockScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    permissions.manifestLoaded();
    // The frontend's current theme (chrome.devtools.panels.themeName); later
    // changes arrive as "theme" deliveries on RUNTIME_DELIVER.
    chrome._setThemeName(reply.themeName);
    return reply;
  })
  .catch((error) => registrationFailed((error && error.message) || "registration failed"));
const asNetworkCaller = (call) => registered.then(() => call());

const networkBridge = createNetworkBridge({
  subscribe: () => asNetworkCaller(() => ipcRenderer.invoke(NETWORK_SUBSCRIBE)),
  getNetworkStatus: () => asNetworkCaller(() => ipcRenderer.invoke(NETWORK_GET_STATUS)),
  fetchHar: (options) => asNetworkCaller(() => ipcRenderer.invoke(NETWORK_GET_HAR, { options })),
  fetchBody: (requestId) =>
    asNetworkCaller(() => ipcRenderer.invoke(NETWORK_GET_BODY, { requestId })),
});

// Same rule as the network reads for every other host-backed call: the host derives
// this frame's identity from the registered principal, so nothing is asked before
// RUNTIME_REGISTER resolves.
const asRegisteredCaller = asNetworkCaller;

// chrome.runtime messaging transport over IPC (docs/features/RUNTIME-MESSAGING.md).
// Registration gates all traffic: until it resolves the frame is unknown to
// the router (methods above still call it, so pending sends simply queue on
// the promise).
const transport = {
  sendMessage: ({ message }) =>
    registered.then((r) => (r.ok ? ipcRenderer.invoke(RUNTIME_SEND_MESSAGE, { message }) : undefined)),
  respond: ({ requestId, response }) =>
    registered.then(() => ipcRenderer.invoke(RUNTIME_SEND_RESPONSE, { requestId, response })),
  connect: ({ name }) =>
    registered.then((r) =>
      r.ok ? ipcRenderer.invoke(RUNTIME_CONNECT, { name }) : { ok: false, error: "Could not establish connection." }
    ),
  portPost: ({ portId, message }) =>
    registered.then(() => ipcRenderer.invoke(RUNTIME_PORT_POST, { portId, message })),
  portClose: ({ portId }) =>
    registered.then(() => ipcRenderer.invoke(RUNTIME_PORT_CLOSE, { portId })),
};

// chrome.tabs' view of the inspected target, and the two things main can do that a
// frame cannot (src/main/tab-host.js). Both are gated AGAIN in main from the host's
// own grants, so a frame that ignored its RUNTIME_REGISTER reply gets neither the
// target's url nor a launched window (docs/features/EXTENSION-MANAGEMENT.md).
const chrome = createChromeNamespace({
  extensionId,
  getManifest,
  platform: {
    os: CHROME_OS[process.platform] || "linux",
    arch: CHROME_ARCH[process.arch] || "unknown",
  },
  storage,
  networkBridge,
  transport,
  getTargetInfo: () =>
    asRegisteredCaller(() => ipcRenderer.invoke(TABS_TARGET_INFO)).then((reply) =>
      // A denial or a lost reply both mean the same thing to the shim: the host did
      // not report a target, so the synthetic tab falls back to about:blank + "".
      reply && reply.ok
        ? { attached: Boolean(reply.attached), url: reply.url, title: reply.title }
        : { attached: false }
    ),
  openTabIn: (details) =>
    asRegisteredCaller(() =>
      ipcRenderer.invoke(TABS_OPEN, {
        url: details.url,
        windowId: details.windowId,
        active: details.active,
      })
    ).then((reply) => (reply && reply.ok ? { via: reply.via ?? null, handle: reply.handle } : { via: null })),
  closeTabById: (handle) =>
    asRegisteredCaller(() => ipcRenderer.invoke(TABS_CLOSE, { handle })).then(
      (closed) => Boolean(closed)
    ),
  // chrome.tabs.sendMessage -> this frame's OWN extension's content script in the
  // inspected target (issue #5). The extension id comes from this frame's url in main,
  // never from here, so a frame cannot address another extension's script. A refusal
  // keeps its reason: the shim turns it into Chrome's connection failure.
  sendToApp: ({ message }) =>
    asRegisteredCaller(() => ipcRenderer.invoke(TABS_SEND_TO_APP, { message })).then(
      (reply) => reply || { ok: false, error: "tabs.sendMessage: the host did not answer" }
    ),
  // chrome.notifications -> the host's Electron Notification. The OWNER of a
  // notification is recorded in main from this frame's own identity, so the click
  // comes back to this context alone — the frame never names a recipient.
  showNotification: (notification) =>
    asRegisteredCaller(() => ipcRenderer.invoke(NOTIFICATION_SHOW, notification)).then(
      (reply) => (reply && reply.ok ? null : (reply && reply.error) || "notification could not be shown")
    ),
  hideNotification: (id) =>
    asRegisteredCaller(() => ipcRenderer.invoke(NOTIFICATION_CLEAR, { id })).then(
      (cleared) => Boolean(cleared)
    ),
  getNotificationPermissionLevel: () =>
    asRegisteredCaller(() => ipcRenderer.invoke(NOTIFICATION_PERMISSION)).then(
      // An absent answer is not "granted": say what is unknown rather than assume.
      (level) => (typeof level === "string" ? level : "unspecifed")
    ),
  getAlarmClockScale: () => alarmClockScale,
  // chrome.downloads -> the shell's one save path (src/main/save-service.js). The id
  // this resolves is main's, so an extension can only ever refer to a save main is
  // really tracking; a refusal comes back as main's error and rejects the call.
  saveDownload: (request) =>
    asRegisteredCaller(() => ipcRenderer.invoke(DOWNLOAD_START, request)),
  cancelDownload: (downloadId) =>
    asRegisteredCaller(() => ipcRenderer.invoke(DOWNLOAD_CANCEL, { id: downloadId })).then(
      (canceled) => Boolean(canceled)
    ),
  eraseDownloads: (ids) =>
    asRegisteredCaller(() => ipcRenderer.invoke(DOWNLOAD_ERASE, { ids })).then(
      (erased) => erased || []
    ),
  searchDownloads: (query) =>
    asRegisteredCaller(() => ipcRenderer.invoke(DOWNLOAD_SEARCH, { query })).then(
      (items) => items || []
    ),
  // The extension's answer to one filename-suggestion request. `suggestion === null`
  // is the shim's "no suggestion" (Chrome's callback called with no argument), which
  // the host reads as "keep the name you derived".
  respondSuggestion: (requestId, suggestion) => {
    ipcRenderer
      .invoke(DOWNLOAD_SUGGEST_REPLY, { requestId, filename: suggestion })
      .catch(() => {});
  },
  // chrome.runtime.openOptionsPage -> a window for the manifest's options_ui.page.
  // Main reads the manifest from disk, so an extension with no options_ui gets the
  // refusal (see src/main/options-host.js) rather than a resolved promise.
  openOptionsPage: () =>
    asRegisteredCaller(() => ipcRenderer.invoke(OPTIONS_OPEN)).then(
      (reply) => reply || { ok: false, error: "openOptionsPage: no answer from the host." }
    ),
  // Declared permissions gate capability (docs/features/EXTENSION-MANAGEMENT.md).
  // The verdict this frame is gated on is the host's — RUNTIME_REGISTER read the
  // manifest from disk — so a page-world script cannot widen it by replacing
  // chrome.runtime.getManifest.
  permissions,
  // chrome.devtools.panels.create -> host -> real frontend tab
  // (docs/features/DEVTOOLS-PANELS.md, src/main/panel-host.js).
  onPanelCreated: ({ title, pagePath }) => {
    ipcRenderer.invoke(EXT_PANEL_CREATE, { title, pagePath }).catch(() => {});
  },
  // chrome.devtools.inspectedWindow.eval -> host -> CDP Runtime.evaluate
  // (docs/features/INSPECTED-WINDOW.md, src/main/inspected-window.js).
  // The host never throws across IPC: a missing CDP session comes back as
  // ok:false with a message, which becomes Chrome's exceptionInfo.isError.
  evalInPage: (expression, options) =>
    ipcRenderer
      .invoke(DEVTOOLS_EVAL, { expression, options })
      .then((reply) =>
        reply && reply.ok
          ? { value: reply.value, exceptionInfo: reply.exceptionInfo || null }
          : {
              value: undefined,
              exceptionInfo: {
                isError: true,
                value: (reply && reply.error) || "inspectedWindow.eval failed",
              },
            }
      ),
  // chrome.devtools.inspectedWindow.reload -> host -> CDP Page.reload. Chrome
  // gives this API no callback and no promise, so the host's {ok, error} answer is
  // handed back for the shim to report — the preload adds no policy of its own.
  reloadInPage: (options) =>
    ipcRenderer.invoke(DEVTOOLS_RELOAD, { options }).then((reply) => reply || { ok: false }),
});

// chrome.devtools.panels.themeName, synchronously. The panel bridge appends the theme it
// is showing to the frame URL (`?__rozenite_theme=dark`) before it creates the iframe, and
// this preload runs before any page script, so a classic <head> script already reads the
// right value — no async IPC can promise that. The hint is validated against Chrome's two
// names, then REMOVED from the address (the extension's own query and hash are kept byte
// for byte) so `location` is what the extension expects. Frames the bridge did not create
// (background contexts, options pages) have no hint and learn the theme from the
// RUNTIME_REGISTER reply instead.
{
  const hint = takeThemeHint(window.location.search);
  if (hint.search !== null) {
    if (hint.theme) {
      chrome._setThemeName(hint.theme);
    }
    try {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + hint.search + window.location.hash
      );
    } catch {
      // A document that refuses replaceState keeps the hint in its URL; harmless.
    }
  }
}

// Router -> frame deliveries (messages, ports, lifecycle events).
//
// Deliveries that arrive during startup are queued and flushed once the page's own
// scripts have run. Chrome does not dispatch a runtime event to a worker before its
// initial script has finished evaluating — and it has to work that way, because the
// `onInstalled`/`onMessage` listener the script registers at the top level does not
// exist yet. This frame needs the same rule for the same reason: the host pushes
// `lifecycle` the moment the frame registers, which is during preload evaluation,
// i.e. strictly before the worker's script has had a chance to add its listener.
// Flushing on DOMContentLoaded covers both a classic script (runs during parsing)
// and a `type="module"` one (deferred, runs just before the event).
const startDeliveries = (channel, handle) => {
  let queue = [];
  let live = false;
  const flush = () => {
    if (live) {
      return;
    }
    live = true;
    const queued = queue;
    queue = [];
    for (const delivery of queued) {
      handle(delivery);
    }
  };
  ipcRenderer.on(channel, (_event, delivery) => {
    if (live) {
      handle(delivery);
    } else {
      queue.push(delivery);
    }
  });
  if (document.readyState === "loading") {
    // `document` is the shared DOM object, so a listener registered from this
    // isolated world does observe the page's own DOMContentLoaded.
    document.addEventListener("DOMContentLoaded", flush, { once: true });
    // Backstop for a document whose parse never completes: queued events are late
    // rather than lost.
    window.addEventListener("load", flush, { once: true });
    setTimeout(flush, 5000);
  } else {
    setTimeout(flush, 0);
  }
};

startDeliveries(RUNTIME_DELIVER, (delivery) => chrome.handleDelivery(delivery));

// An alarm is a timer, and this context owns it: when the document goes away, nothing
// may fire any more. Chrome's worker would be evicted and its alarms persisted; this
// shell's worker is always-on, so the teardown is the one place the two models meet,
// and doing it here is what keeps "an alarm outlived its context" from happening.
window.addEventListener("pagehide", () => {
  if (chrome._alarmsShim) {
    chrome._alarmsShim._cancelAll();
  }
});

// Network deliveries (devtools.network events + webRequest listeners). The host
// wraps them as {kind, payload}; the shim consumes the payload shape. A frame
// whose extension does not declare `webRequest` is never sent the lifecycle
// steps that only webRequest consumes (src/main/delivery-scope.js).
ipcRenderer.on(NETWORK_DELIVER, (_event, delivery) =>
  networkBridge.handleDelivery(delivery && delivery.payload ? delivery.payload : delivery)
);

// Panel.onShown / onHidden from the host (the frame that created the panel is the only
// one sent them). The shim fires the Panel's events; the window argument onShown
// carries is attached in the main world below.
ipcRenderer.on(EXT_PANEL_EVENT, (_event, delivery) =>
  chrome.handlePanelEvent(delivery && delivery.payload)
);

// chrome.* namespace. The merge runs in the main world: deep-merge runtime and
// devtools onto anything already present and re-establish `lastError` as a LIVE
// getter — contextBridge cloning evaluates getters only once
// (chrome-shim/runtime.js).
contextBridge.exposeInMainWorld("chromeElectron", chrome);
contextBridge.executeInMainWorld({
  func: () => {
    const bridge = window.chromeElectron;
    const merged = { ...window.chrome, ...bridge };
    merged.runtime = { ...(window.chrome && window.chrome.runtime), ...bridge.runtime };
    merged.devtools = { ...(window.chrome && window.chrome.devtools), ...bridge.devtools };
    // themeName must stay live (a cloned getter would freeze at expose time).
    // Known leftover: `window.chromeElectron` is the raw bridge object and still carries
    // the expose-time snapshot of `themeName` plus `_getThemeName`; it is the shell's own
    // handle (like `chromeElectron.runtime`), not part of `chrome.*`.
    merged.devtools.panels = { ...merged.devtools.panels };
    Object.defineProperty(merged.devtools.panels, "themeName", {
      get: () => bridge.devtools.panels._getThemeName(),
      enumerable: true,
    });
    delete merged.devtools.panels._getThemeName; // internal helper stays shim-side
    Object.defineProperty(merged.runtime, "lastError", {
      get: () => bridge.runtime._getLastLastError(),
    });
    delete merged.runtime._getLastLastError; // internal helper stays shim-side

    // Panel.onShown(window): Chrome passes the panel page's window, and a Window cannot
    // cross the contextBridge, so the main world resolves it. The panel iframe lives in
    // a shadow tree of the frontend (so it is not among window.parent.frames) but is
    // NAMED after its panel id: `window.open("", name)` resolves an existing named frame
    // without navigating it and returns its WindowProxy, which is fully scriptable from
    // here once the panel has loaded, because both pages are `rozenite://<id>`. The
    // shell denies every blank window.open (src/main/window-open-policy.js), so a name that matches no
    // frame gives null instead of a popup. The listeners of one panel are serialized, so
    // onHidden can never overtake an onShown that is still waiting for the panel to load.
    const panels = merged.devtools.panels;
    const panelIdFor = bridge.devtools.panels._panelIdFor; // internal helper
    delete panels._panelIdFor;
    if (typeof panels.create === "function" && typeof panelIdFor === "function") {
      const hrefOf = (win) => {
        try {
          return String(win.location.href);
        } catch {
          return null; // cross-origin: still the frontend's initial about:blank
        }
      };
      const awaitPanelWindow = async (panelId) => {
        let win = null;
        try {
          win = window.open("", panelId);
        } catch {
          // denied or unreachable: no window to hand over
        }
        // Wait (bounded, ~3 s) for the panel's first navigation to commit, so the window
        // is usable the moment the listener gets it.
        for (let attempt = 0; win && attempt < 120; attempt++) {
          const href = hrefOf(win);
          if (href && href.startsWith("rozenite://")) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return win; // null = divergence: Chrome always has a window to hand over
      };
      const decorate = (panel, panelId) => {
        if (!panel || !panel.onShown || !panel.onHidden) {
          return panel;
        }
        let queue = Promise.resolve();
        const wrapEvent = (event, withWindow) => {
          const listeners = [];
          event.addListener(() => {
            queue = queue.then(async () => {
              const win = withWindow ? await awaitPanelWindow(panelId) : undefined;
              for (const listener of [...listeners]) {
                try {
                  listener(...(withWindow ? [win] : []));
                } catch (error) {
                  console.error(error);
                }
              }
            });
          });
          return {
            addListener(fn) {
              if (typeof fn !== "function") {
                throw new TypeError("Listener must be a function");
              }
              if (!listeners.includes(fn)) {
                listeners.push(fn);
              }
            },
            removeListener(fn) {
              const index = listeners.indexOf(fn);
              if (index !== -1) {
                listeners.splice(index, 1);
              }
            },
            hasListener: (fn) => (fn === undefined ? listeners.length > 0 : listeners.includes(fn)),
            hasListeners: () => listeners.length > 0,
          };
        };
        return {
          ...panel,
          onShown: wrapEvent(panel.onShown, true),
          onHidden: wrapEvent(panel.onHidden, false),
        };
      };
      // Assigned onto the existing object, NOT a spread copy: `themeName` above is a
      // live getter and a copy would freeze it.
      const create = panels.create;
      panels.create = (title, iconPath, pagePath, cb) => {
        const panelId = panelIdFor(pagePath);
        if (typeof cb === "function") {
          return create(title, iconPath, pagePath, (panel) => cb(decorate(panel, panelId)));
        }
        return create(title, iconPath, pagePath).then((panel) => decorate(panel, panelId));
      };
    }

    window.chrome = merged;
  },
});
