// The extension host's IPC broker: every extension channel, the frame principals and
// grants they are checked against, and nothing else (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md
// §5.5). Built by the extension host (../ExtensionHost.js) with every service it routes to;
// nothing here is created at import time.
//
// Every channel is async (`handle` + `invoke`) — the house rule in
// ./channels.js, unconditional since the injected-script channel went away.
// The two `sendSync` handlers that used to sit at the top of this function were
// the whole point of that exception: they handed extension frames a
// frontend-supplied script to `new Function`. `chrome.devtools.*` is implemented
// shell-side now (docs/features/DEVTOOLS-PANELS.md), so there is nothing to
// deliver synchronously and no arbitrary-code-evaluation channel left.
//
// The embedding shell's own channels (InspectorFrontendHost, window ops) are not here:
// src/electron/shell/ipc.js.
//
// Handlers live on each WebContents the host owns (`attachContents`: the attached
// frontend window, every background and options window), never on the global ipcMain
// (spec §5.5). A WebContents nobody attached has no extension channel at all: a second
// frontend window, a `chrome.tabs` window, or any other page of the embedder that the
// session preload also runs in gets "no handler registered" for every invoke. It also
// means no clash with the embedder's own ipcMain channels, and detaching removes exactly
// what was installed.
const extensionServer = require("../scheme/extension-server");
const { packageFor } = require("../registry/packages");
// The grant filter `networkSenderFor` below applies to every host->frame network
// push. Importing it here is load-bearing: the call sits inside the sender filter
// that network-service's `broadcast` wraps in `try { … } catch {}`, so an unbound
// name threw a ReferenceError that the catch swallowed — every live delivery died
// silently, for every frame, with no log line (issue #20). Pinned live by
// tests/delivery-scope.test.js.
const { deliveryAllowed } = require("./delivery-scope");
const { deliverTabMessage } = require("../services/tab-send");
const { createPermissionGate, API_PERMISSIONS } = require("./permissions");
const { createThemeReportHandler } = require("../frontend/theme-host");
const { stripThemeHintFromUrl } = require("../frontend/theme");
const { settings } = require("../settings");
const {
  RUNTIME_GET_MANIFEST,
  RUNTIME_REGISTER,
  RUNTIME_SEND_MESSAGE,
  RUNTIME_SEND_RESPONSE,
  RUNTIME_CONNECT,
  RUNTIME_PORT_POST,
  RUNTIME_PORT_CLOSE,
  RUNTIME_DELIVER,
  STORAGE_CALL,
  STORAGE_DELIVER,
  EXT_PANEL_CREATE,
  EXT_PANEL_VISIBILITY,
  EXT_PANEL_EVENT,
  THEME_REPORT,
  DEVTOOLS_EVAL,
  DEVTOOLS_RELOAD,
  NETWORK_SUBSCRIBE,
  NETWORK_GET_HAR,
  NETWORK_GET_STATUS,
  NETWORK_GET_BODY,
  NETWORK_DELIVER,
  TABS_TARGET_INFO,
  TABS_OPEN,
  TABS_CLOSE,
  TABS_SEND_TO_APP,
  NOTIFICATION_SHOW,
  NOTIFICATION_CLEAR,
  NOTIFICATION_PERMISSION,
  OPTIONS_OPEN,
  DOWNLOAD_START,
  DOWNLOAD_CANCEL,
  DOWNLOAD_ERASE,
  DOWNLOAD_SEARCH,
  DOWNLOAD_SUGGEST_REPLY,
} = require("./channels");


/**
 * @param {object} deps every service a channel routes to, built by the extension host
 * @param {object} deps.router the runtime messaging router (../contexts/message-router.js)
 * @param {object} deps.storageService chrome.storage (../services/storage-service.js)
 * @param {object} deps.networkService the CDP network model (../cdp/network-service.js)
 * @param {object} deps.themeHost the frontend's theme (../frontend/theme-host.js)
 * @param {object} deps.contextRegistry ../contexts/context-registry.js
 * @param {object} deps.requestQueue ../contexts/context-request.js
 * @param {() => object|null} deps.getPanelHost the attached window's panel host
 * @param {(event) => boolean} deps.isFrontendFrame the attached window's frontend rule
 * @param {(expression: string, options: object) => Promise<object>} deps.evalInPage
 * @param {(options: object) => Promise<object>} deps.reloadInPage
 * @param {object} deps.tabHost ../services/tab-host.js
 * @param {object} deps.notificationHost ../services/notification-host.js
 * @param {object} deps.saveService ../services/save-service.js
 * @param {object} deps.optionsHost ../contexts/options-host.js
 * @param {() => object|null} deps.getContentBridge the attached window's content bridge
 * @param {(channel: string, handler: function) => function} [deps.wrapHandler] test-only:
 *        decorates each handler before it is installed (tests/extension-frame-harness.js)
 */
const createBroker = ({
  router,
  storageService,
  networkService,
  themeHost,
  contextRegistry,
  requestQueue,
  getPanelHost,
  isFrontendFrame,
  evalInPage,
  reloadInPage,
  tabHost,
  notificationHost,
  saveService,
  optionsHost,
  getContentBridge,
  wrapHandler = (_channel, handler) => handler,
}) => {
  // frameKey -> WebFrameMain that registered it: every later call claiming a
  // frameKey must come from the same principal object (a frame cannot spoof
  // another frame's key). Extension identity always comes from the frame's
  // URL — never from payload. Addressing uses IpcMainEvent.frameId, which the
  // main process derives from the frame itself.
  const principals = new Map();

  // frameKey -> the declared permissions that mattered when the frame registered.
  // The network handlers enforce the `webRequest` grant from here, so a frame that
  // ignores the answer in its RUNTIME_REGISTER reply still gets no data.
  const grants = new Map();

  // Registered extension frames the host wants watched beyond the router's own
  // bookkeeping (src/electron/extensions/internal/contexts/background-host.js: a background context has to hear
  // about its extension's lifecycle the moment it registers). Observers get a
  // read-only view of the frame the host verified, and cannot change routing.
  const frameObservers = new Set();

  /**
   * Watch router-frame registrations. Called with the frame descriptor plus the
   * frame's own `send` (the same closure the router pushes messages through), so a
   * legitimate delivery needs no privileged channel. Returns an unsubscribe.
   *
   * @param {(frame: {extensionId: string, key: string, url: string, send: function}) => void} observer
   */
  const subscribeRouterFrames = (observer) => {
    frameObservers.add(observer);
    return () => frameObservers.delete(observer);
  };

  const notifyFrameObservers = (descriptor) => {
    for (const observer of [...frameObservers]) {
      try {
        observer(descriptor);
      } catch (error) {
        // A broken observer must not cost the extension its registration.
        console.error(`[extensions] frame observer failed: ${error && error.message}`);
      }
    }
  };

  /**
   * The declared permissions a frame's extension holds, decided in main from the
   * manifest on disk — never from anything the frame sends. This matters: the
   * naive implementation reads `chrome.runtime.getManifest()` inside the frame,
   * and a page-world script can overwrite that function. Handing the verdict back
   * from RUNTIME_REGISTER means the gate's input is host state
   * (docs/features/EXTENSION-MANAGEMENT.md).
   */
  const grantedPermissions = (event) => {
    let gate;
    try {
      const { hostname } = new URL(event.senderFrame.url);
      gate = createPermissionGate(() => extensionServer.loadManifest(hostname));
    } catch {
      return {};
    }
    const granted = {};
    // Every permission the shim's own table knows about, so a namespace added later
    // is reported — and therefore gated — without anyone extending an array here.
    // Under-reporting has one dangerous direction: `chrome.permissions.getAll`
    // answers from this map, so a permission in the table but not here would be
    // reported as NOT granted for a manifest that declares it.
    for (const permission of new Set(Object.values(API_PERMISSIONS))) {
      granted[permission] = gate.has(permission);
    }
    return granted;
  };

  let unregisterRouterFrame; // set below to avoid closure-order issues

  /**
   * The extension the calling frame belongs to, read from the frame's own URL by the
   * host. Several features need an owner for host-side state (the download ledger,
   * the options window) and this is the only source that is not something the frame
   * asserted about itself. Returns null for a frame whose URL is not an extension URL.
   */
  const extensionIdOfFrame = (event) => {
    try {
      return new URL(event.senderFrame.url).hostname;
    } catch {
      return null;
    }
  };

  /** Whether `pagePath` (query/hash ignored) names an existing file inside the extension. */
  const panelPageExists = (extensionId, pagePath) => {
    const file = pagePath.split(/[?#]/)[0].replace(/^\/+/, "");
    const pkg = file ? packageFor(extensionId) : null;
    return Boolean(pkg) && pkg.entry(file).kind === "file";
  };

  const makeFrameSender =
    (key, webContents, frame, channel = RUNTIME_DELIVER, filter = null) =>
    ({ kind, payload }) => {
      // Permission-scoped deliveries (src/electron/extensions/internal/broker/delivery-scope.js): a frame whose
      // extension does not declare `webRequest` is not sent the lifecycle steps
      // that only chrome.webRequest consumes. Everything else flows.
      if (filter && !filter(payload)) {
        return;
      }
      try {
        if (webContents.isDestroyed() || (frame && frame.isDestroyed())) {
          throw new Error("frame gone");
        }
        // WebFrameMain.send addresses the principal we registered, which is the
        // only form that is correct by construction here. Measured in a headless
        // Electron 38 run with an out-of-process `rozenite://` iframe: addressing
        // with `sendToFrame([webContents.id, event.frameId], …)` delivered NOTHING
        // and threw nothing — that tuple is read as [processId, routingId], not
        // [webContentsId, frameId], so the message went to a process with no such
        // frame and the failure was silent. `frame.send(…)` is what lands.
        frame.send(channel, { kind, payload });
      } catch {
        // detached frame: retire it so pending legs/ports settle
        unregisterRouterFrame(key);
      }
    };

  // Resolve the calling frame's key, or null if it is not (or no longer) the
  // principal registered under it.
  const resolveFrameKey = (event) => {
    const key = `${event.sender.id}:${event.frameId}`;
    return principals.get(key) === event.senderFrame ? key : null;
  };

  // Every channel's handler, collected by `register` and installed on each WebContents
  // `attachContents` is given.
  const handlers = new Map();
  const handle = (channel, handler) => {
    handlers.set(channel, wrapHandler(channel, handler));
  };

  // WebContents -> its detach, so `dispose` removes exactly what was installed.
  const attached = new Map();

  /**
   * Install every extension channel on `contents.ipc`. Call it before the WebContents
   * loads anything: a frame's first act is RUNTIME_GET_MANIFEST / RUNTIME_REGISTER.
   * A destroyed WebContents takes its handlers with it.
   *
   * @returns {() => void} detach: removes the handlers again (idempotent)
   */
  const attachContents = (contents) => {
    if (!contents || contents.isDestroyed() || attached.has(contents)) {
      return attached.get(contents) || (() => {});
    }
    for (const [channel, handler] of handlers) {
      contents.ipc.handle(channel, handler);
    }
    const onDestroyed = () => {
      attached.delete(contents);
    };
    const detach = () => {
      if (!attached.delete(contents)) {
        return;
      }
      contents.removeListener("destroyed", onDestroyed);
      if (!contents.isDestroyed()) {
        for (const channel of handlers.keys()) {
          contents.ipc.removeHandler(channel);
        }
      }
    };
    contents.once("destroyed", onDestroyed);
    attached.set(contents, detach);
    return detach;
  };

  const register = () => {
    // ── async channels (the house rule; there is nothing else) ───────────────

    // chrome.runtime.getManifest: the extension id is taken from the calling
    // frame's URL — never from message arguments (trust boundary).
    handle(RUNTIME_GET_MANIFEST, (event) => {
      try {
        const { hostname } = new URL(event.senderFrame.url);
        return extensionServer.loadManifest(hostname);
      } catch {
        return {};
      }
    });

    // ── runtime messaging (docs/features/RUNTIME-MESSAGING.md) ──────────────
    unregisterRouterFrame = (key) => {
      principals.delete(key);
      grants.delete(key);
      // A context that goes away stops being a target for host events. Without this a
      // notification click would be pushed into a detached frame (the registry's own
      // send throws for that, but the id would stay owned forever).
      contextRegistry.unregister(key);
      storageService.detach(key);
      // The same for a host->context REQUEST that is still open: a download waiting on
      // a filename suggestion from a frame that has died would otherwise sit until its
      // timeout. Settling it now lets the save proceed with the name it derived, and
      // the save service reports that it did.
      requestQueue.dropContext(key);
      router.unregisterFrame(key);
      // A frame that goes away also stops being a network subscriber; the model
      // stops asking the backend for Network events once no frame wants them.
      networkService.unregisterFrame(key);
    };

    handle(RUNTIME_REGISTER, (event) => {
      const frame = event.senderFrame;
      if (!frame) {
        return { ok: false };
      }
      let extensionId;
      try {
        extensionId = new URL(frame.url).hostname;
      } catch {
        return { ok: false };
      }
      // An installed package, not just a plausible name: the frame's origin has to be
      // an extension this host actually has.
      if (!packageFor(extensionId)) {
        return { ok: false };
      }
      const key = `${event.sender.id}:${event.frameId}`;
      principals.set(key, frame);
      // Reachability registry (src/electron/extensions/internal/contexts/context-registry.js): the same `send` closure
      // the router gets, kept so a host-produced, context-owned event — a system
      // notification the user clicked — can go to the ONE context that created it,
      // which is what Chrome does and what the router (fan-out to every frame of the
      // extension) is not.
      contextRegistry.register({ frameKey: key, extensionId, send: makeFrameSender(key, event.sender, frame) });
      // Which declared permissions this frame's extension has, decided from the
      // manifest on disk and handed back once, at registration. The frame's shim
      // uses it for lastError reporting; the network handlers below enforce the
      // `webRequest` grant themselves, so a frame that ignores the answer still
      // gets no data (docs/features/EXTENSION-MANAGEMENT.md).
      const granted = grantedPermissions(event);
      grants.set(key, granted);
      // The frame's address as the EXTENSION knows it: the panel bridge's theme hint
      // (src/electron/extensions/internal/frontend/theme.js) is the shell's detail and must not reach MessageSender.url.
      // Done here, not by relying on the preload having stripped it first (a race).
      const frameUrl = stripThemeHintFromUrl(frame.url);
      router.registerFrame({
        key,
        extensionId,
        url: frameUrl,
        send: makeFrameSender(key, event.sender, frame),
      });
      // chrome.storage change events: every registered context of the extension hears
      // every change to its storage. `allowed` is read at delivery time from the host's
      // own grants, so an extension without `storage` is neither served nor told.
      // Every frame this host registers is an extension page (a trusted context); the
      // untrusted kind Chrome has is a content script, which has no chrome.storage here.
      const sendStorage = makeFrameSender(key, event.sender, frame, STORAGE_DELIVER);
      storageService.attach({
        frameKey: key,
        extensionId,
        send: (change) => sendStorage({ kind: "storage-changed", payload: change }),
        allowed: () => Boolean(grants.get(key) && grants.get(key).storage),
      });
      notifyFrameObservers({
        key,
        extensionId,
        url: frameUrl,
        send: makeFrameSender(key, event.sender, frame),
      });
      event.sender.once("destroyed", () => unregisterRouterFrame(key));
      // `alarmClockScale` is decided here rather than read in the frame: a page-world
      // script must not be able to see or influence the host's test configuration
      // (src/electron/shell/config.js explains what the value is for, and why the config exports
      // it as a number: this reply crosses IPC through the structured-clone serializer,
      // which DROPS a function-valued property rather than transferring it — so a
      // function here reached the frame as `undefined` and every context ran unscaled,
      // silently. tests/tier2-worker-electron.test.js is what measured that.)
      return {
        ok: true,
        granted,
        alarmClockScale: settings.alarmClockScale,
        themeName: themeHost.get(),
      };
    });

    const registeredHandle = (channel, handler) =>
      handle(channel, (event, payload) => {
        const fromKey = resolveFrameKey(event);
        if (!fromKey) {
          return payload?.requestId !== undefined ? undefined : { ok: false };
        }
        return handler(fromKey, payload);
      });

    // chrome.storage: the frame names an area and an operation; whose storage it is comes
    // from the registered frame, and the permission is enforced here as well as in the shim.
    registeredHandle(STORAGE_CALL, (fromKey, { area, op, arg } = {}) =>
      storageService.call({ frameKey: fromKey, area, op, arg })
    );

    registeredHandle(RUNTIME_SEND_MESSAGE, (fromKey, { message }) =>
      router.sendMessage({ fromKey, message })
    );
    registeredHandle(RUNTIME_SEND_RESPONSE, (fromKey, { requestId, response }) =>
      router.resolveDelivery({ fromKey, requestId, response })
    );
    registeredHandle(RUNTIME_CONNECT, (fromKey, { name }) =>
      router.connect({ fromKey, name })
    );
    registeredHandle(RUNTIME_PORT_POST, (fromKey, { portId, message }) =>
      router.portPost({ fromKey, portId, message })
    );
    registeredHandle(RUNTIME_PORT_CLOSE, (fromKey, { portId }) =>
      router.portDisconnect({ fromKey, portId })
    );

    // ── shell-driven extension hosting (docs/features/DEVTOOLS-PANELS.md) ────
    // chrome.devtools.panels.create from an extension frame. Identity from the
    // calling frame (must be a registered router frame); never from payload.
    handle(EXT_PANEL_CREATE, (event, { title, pagePath } = {}) => {
      if (!resolveFrameKey(event)) {
        return { ok: false };
      }
      let extensionId;
      try {
        extensionId = new URL(event.senderFrame.url).hostname;
      } catch {
        return { ok: false };
      }
      // The page must be a real file of THIS extension: an empty or missing path would
      // host a tab that can only show a 404, and the old check (does the extension
      // folder exist) passed for any path.
      if (
        typeof title !== "string" ||
        typeof pagePath !== "string" ||
        !panelPageExists(extensionId, pagePath)
      ) {
        return { ok: false };
      }
      // The creating frame owns the Panel object, so it is the one that hears
      // onShown/onHidden (Chrome gives them to no other context).
      const key = resolveFrameKey(event);
      const owner = {
        send: makeFrameSender(key, event.sender, event.senderFrame, EXT_PANEL_EVENT),
      };
      const panelHost = getPanelHost();
      return { ok: Boolean(panelHost) && panelHost.addPanel({ extensionId, title, pagePath, owner }) };
    });

    // The frontend reports its tab selection for extension panels. Only the frontend's
    // own main frame may say so: an extension frame cannot make another extension's
    // panel look shown, and panelId only selects among panels main already hosts.
    handle(EXT_PANEL_VISIBILITY, (event, { panelId, shown } = {}) => {
      if (!isFrontendFrame(event)) {
        return { ok: false };
      }
      const panelHost = getPanelHost();
      return { ok: Boolean(panelHost) && panelHost.setPanelVisible(panelId, shown === true) };
    });

    // The frontend reporting its theme. Identity is the frame (the frontend's own
    // main frame), never the payload; the value is validated against Chrome's two
    // names inside the theme host before any extension hears it.
    handle(
      THEME_REPORT,
      createThemeReportHandler({ themeHost, isFrontendFrame })
    );

    // ── inspected window (docs/features/INSPECTED-WINDOW.md) ──────────────────
    // chrome.devtools.inspectedWindow.eval -> CDP Runtime.evaluate over the
    // host's own debugger session (src/electron/extensions/internal/cdp/cdp-session.js). Same frame gate as
    // panels.create: an unregistered frame gets a visible isError, never a
    // fabricated value.
    handle(DEVTOOLS_EVAL, (event, { expression, options } = {}) => {
      if (!resolveFrameKey(event) || typeof expression !== "string") {
        return { ok: false, error: "inspectedWindow.eval: unauthorized call" };
      }
      return evalInPage(expression, options || {}).then(({ value, exceptionInfo }) => ({
        ok: true,
        value,
        exceptionInfo,
      }));
    });

    // inspectedWindow.reload() -> Page.reload. Chrome's version has no callback, so
    // the reply exists only for the frame to log: a failed reload is reported, not
    // silently swallowed (src/electron/extensions/internal/preload/extension-frame.js).
    handle(DEVTOOLS_RELOAD, (event, { options } = {}) => {
      if (!resolveFrameKey(event)) {
        return { ok: false, error: "inspectedWindow.reload: unauthorized call" };
      }
      return reloadInPage(options || {});
    });

    // ── devtools.network / webRequest (docs/features/DEVTOOLS-NETWORK.md) ──────
    // All three reads ride the same frame gate as eval/panels.create: identity comes
    // from the calling frame, and an unauthorized frame gets an explicit failure
    // instead of data. Deliveries flow back on NETWORK_DELIVER. The replies are
    // never thrown across IPC — every failure comes back as a value the shim can
    // report, matching the DEVTOOLS_EVAL pattern.
    const networkSenderFor = (event) => {
      const key = resolveFrameKey(event);
      if (!key) {
        return null;
      }
      const frame = event.senderFrame;
      // The inner payload kind is the lifecycle step (request | sendHeaders |
      // response | completed | error | navigated | status); the outer wrapper is
      // always "network" (src/electron/extensions/internal/cdp/network-service.js).
      const filter = (payload) =>
        deliveryAllowed(grants.get(key), payload && payload.kind);
      return {
        key,
        send: makeFrameSender(key, event.sender, frame, NETWORK_DELIVER, filter),
      };
    };

    // A frame calls this from its first network listener / first getHAR and gets the
    // honest availability snapshot back immediately; the model starts asking the
    // backend for Network events from here on.
    handle(NETWORK_SUBSCRIBE, (event) => {
      const target = networkSenderFor(event);
      if (!target) {
        return { available: false, reason: "network.subscribe: unauthorized call", requests: 0 };
      }
      if (!networkService.hasSubscriber(target.key)) {
        return networkService.subscribe(target.key, target.send);
      }
      return networkService.getStatus();
    });

    handle(NETWORK_GET_HAR, (event, { options } = {}) => {
      const target = networkSenderFor(event);
      if (!target) {
        // No fabricated HAR for a frame the host does not know.
        return { ok: false, error: "network.getHAR: unauthorized call" };
      }
      // First read counts as interest: an extension that only polls getHAR never
      // registers a listener, and the HAR must not be empty just because nobody
      // asked the backend for events yet.
      if (!networkService.hasSubscriber(target.key)) {
        networkService.subscribe(target.key, target.send);
      }
      return networkService.getHar(options || {});
    });

    handle(NETWORK_GET_STATUS, (event) => {
      const target = networkSenderFor(event);
      if (!target) {
        return { available: false, reason: "network.getStatus: unauthorized call", requests: 0 };
      }
      return networkService.getStatus();
    });

    // Bodies are the exact place a fake used to live, so every failure path returns
    // `{available: false, error}` with the backend's own reason and never a body.
    handle(NETWORK_GET_BODY, (event, { requestId } = {}) => {
      const target = networkSenderFor(event);
      if (!target) {
        return { available: false, error: "network.getResponseBody: unauthorized call" };
      }
      if (typeof requestId !== "string" || requestId.length === 0) {
        return { available: false, error: "Network.getResponseBody: requestId is required." };
      }
      return networkService.getBody(requestId);
    });
    // ── chrome.tabs (docs/features/SMALL-SHIMS.md) ─────────────────────────────
    // The frame's shim is already gated by its RUNTIME_REGISTER grants; these
    // handlers enforce the same verdict from host state anyway, for the same reason
    // the network handlers do: a frame that ignores the answer in its registration
    // reply must still not be able to ask for the inspected target's url/title or
    // launch a window. Identity from the frame, never from payload.
    const tabsCaller = (event) => {
      const key = resolveFrameKey(event);
      if (!key) {
        return false;
      }
      const frameGrants = grants.get(key) || {};
      return frameGrants.tabs === true;
    };

    /** The calling frame's key when its extension declares `permission`, else false. */
    const gatedFrameKey = (event, permission) => {
      const key = resolveFrameKey(event);
      if (!key) {
        return null;
      }
      const frameGrants = grants.get(key) || {};
      return frameGrants[permission] === true ? key : null;
    };

    handle(TABS_TARGET_INFO, (event) => {
      if (!tabsCaller(event)) {
        // Not `{attached: false}`: that would be the shape of a truthful "nothing is
        // attached", which is a claim about the app the caller has not earned.
        return { ok: false, error: "tabs: permission 'tabs' is not declared" };
      }
      return tabHost.targetInfo();
    });

    handle(TABS_OPEN, (event, details = {}) => {
      if (!tabsCaller(event)) {
        return { ok: false, error: "tabs: permission 'tabs' is not declared" };
      }
      return tabHost
        .open({ url: details.url, windowId: details.windowId, active: details.active })
        .then((outcome) => ({ ok: true, ...outcome }))
        .catch((error) => ({ ok: false, error: error && error.message }));
    });

    // ── chrome.tabs.sendMessage (GitHub issue #5's other half) ────────────────
    // Issue #12 refused to wire this because there was no receiver, and routing it into
    // the extension's own `runtime.onMessage` would have let an extension message itself
    // and call the success "a page answered". Issue #5 supplied the real receiver — the
    // extension's allowlisted content script, inside the inspected app — so the message
    // now goes THERE, through the same router seat a panel uses.
    //
    // The decisions (grant check, whose app context is addressable, what silence means)
    // live in src/electron/extensions/internal/services/tab-send.js so they can be tested; this is the part that cannot be.
    handle(TABS_SEND_TO_APP, (event, details = {}) => {
      return deliverTabMessage({
        // Same two checks every other chrome.tabs channel makes, from host state rather
        // than from anything the frame says about itself.
        granted: tabsCaller(event),
        fromKey: resolveFrameKey(event),
        frameUrl: event.senderFrame ? stripThemeHintFromUrl(event.senderFrame.url) : "",
        // The production shell started it in src/electron/shell/main.js; a harness that never ran
        // that file gets it built here, against the same router, so the answer is always
        // "what this shell really did" rather than "the bridge was never started".
        bridge: getContentBridge(),
        sendTo: (args) => router.sendTo(args),
        message: details.message,
      });
    });

    // ── chrome.notifications (docs/features/SMALL-SHIMS.md) ────────────────────
    // The `notifications` permission is enforced HERE as well as in the frame's gate:
    // a frame that ignored its RUNTIME_REGISTER reply must not be able to raise a
    // system notification. The OWNER is this event's own frame key, which main derives
    // from the frame — a payload can never name a context to receive a click.
    handle(NOTIFICATION_SHOW, (event, details = {}) => {
      const key = gatedFrameKey(event, "notifications");
      if (!key) {
        return { ok: false, error: "notifications: permission 'notifications' is not declared" };
      }
      return notificationHost
        .show({
          frameKey: key,
          id: details.id,
          title: details.title,
          message: details.message,
          silent: details.silent,
          iconUrl: details.iconUrl,
        })
        .catch((error) => ({ ok: false, error: (error && error.message) || "notification failed" }));
    });

    handle(NOTIFICATION_CLEAR, (event, { id } = {}) => {
      if (!gatedFrameKey(event, "notifications")) {
        return false;
      }
      return notificationHost.clear({ notificationId: id });
    });

    handle(NOTIFICATION_PERMISSION, (event) => {
      if (!gatedFrameKey(event, "notifications")) {
        return "unspecifed";
      }
      return notificationHost.permissionLevel();
    });

    handle(TABS_CLOSE, async (event, { handle } = {}) => {
      if (!tabsCaller(event)) {
        return false;
      }
      return tabHost.close(handle);
    });

    // ── chrome.downloads + runtime.openOptionsPage (docs/features/SMALL-SHIMS.md) ──
    //
    // The save machinery is src/electron/extensions/internal/services/save-service.js and the filename-suggestion
    // round trip is src/electron/extensions/internal/contexts/context-request.js; both are transport-agnostic, so the
    // DevTools frontend's own `InspectorFrontendHost.save` and an extension's
    // `chrome.downloads.download` share one implementation and get the same honest
    // states (in_progress → complete only after a write resolved, interrupted with
    // the platform's own message otherwise).
    //
    // All of `downloads` is gated, including `erase`/`search`: in Chrome the same
    // permission covers creating a download AND reading the history of the ones that
    // exist. `OPTIONS_OPEN` is deliberately NOT gated, because Chrome does not gate
    // `runtime.openOptionsPage` — the manifest on disk is the only authority, and an
    // extension that declares no `options_ui` is told so (see options-host.js).

    /**
     * The calling frame when its extension declares `downloads`, with the extension id
     * the host derived from the frame's own URL. That id is what scopes the download
     * ledger: Chrome's download history belongs to one extension, so `search`/`erase`
     * for one must never return another's files.
     */
    const downloadCaller = (event) => {
      const frameKey = gatedFrameKey(event, "downloads");
      if (!frameKey) {
        return null;
      }
      return { frameKey, owner: extensionIdOfFrame(event) };
    };

    handle(DOWNLOAD_START, (event, details = {}) => {
      const caller = downloadCaller(event);
      if (!caller) {
        return { ok: false, error: "downloads: permission 'downloads' is not declared" };
      }
      return saveService
        .start({
          // Owned by THIS frame: onChanged and any filename question go to the context
          // that started the download, which is Chrome's rule. Both key and owner are
          // main's own, never taken from the payload.
          frameKey: caller.frameKey,
          owner: caller.owner,
          url: details.url,
          content: details.content,
          isBase64: details.isBase64 === true,
          filename: details.filename,
          saveAs: details.saveAs === true,
          title: details.title,
        })
        .catch((error) => ({ ok: false, error: (error && error.message) || "the save failed" }));
    });

    handle(DOWNLOAD_CANCEL, (event, { id } = {}) => {
      const caller = downloadCaller(event);
      if (!caller) {
        return false;
      }
      return saveService.cancel({ id, owner: caller.owner });
    });

    handle(DOWNLOAD_ERASE, (event, { ids } = {}) => {
      const caller = downloadCaller(event);
      if (!caller) {
        return { id: [] };
      }
      return saveService.erase({ ids, owner: caller.owner });
    });

    handle(DOWNLOAD_SEARCH, (event, { query } = {}) => {
      const caller = downloadCaller(event);
      if (!caller) {
        return [];
      }
      return saveService.search({ query: query || {}, owner: caller.owner });
    });

    handle(DOWNLOAD_SUGGEST_REPLY, (event, { requestId, filename } = {}) => {
      const caller = downloadCaller(event);
      if (!caller) {
        return { ok: false };
      }
      // `resolve` returns false when nothing was waiting on THIS frame for that id, so
      // a late or invented answer cannot influence a download that is already decided.
      const answered = requestQueue.resolve(caller.frameKey, requestId, {
        suggestion: typeof filename === "string" && filename ? filename : null,
      });
      return { ok: answered };
    });

    handle(OPTIONS_OPEN, (event) => {
      // Identity from the frame's URL, like every other extension channel: a payload
      // can never name the extension whose options page gets opened.
      let extensionId;
      try {
        extensionId = new URL(event.senderFrame.url).hostname;
      } catch {
        return { ok: false, error: "openOptionsPage: the caller is not an extension page." };
      }
      if (!packageFor(extensionId)) {
        return { ok: false, error: "openOptionsPage: unknown extension." };
      }
      return optionsHost.openOptionsPage(extensionId);
    });

  };

  const dispose = () => {
    for (const detach of [...attached.values()]) {
      detach();
    }
    if (unregisterRouterFrame) {
      for (const key of [...principals.keys()]) {
        unregisterRouterFrame(key);
      }
    }
  };

  return { register, attachContents, dispose, subscribeRouterFrames };
};

module.exports = { createBroker };
