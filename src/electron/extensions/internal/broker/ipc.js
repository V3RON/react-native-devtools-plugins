// IPC handler registration. Delegates state/services; no logic here.
//
// Every channel is async (`ipcMain.handle` + `invoke`) — the house rule in
// src/shared/ipc.js, unconditional since the injected-script channel went away.
// The two `sendSync` handlers that used to sit at the top of this function were
// the whole point of that exception: they handed extension frames a
// frontend-supplied script to `new Function`. `chrome.devtools.*` is implemented
// shell-side now (docs/features/DEVTOOLS-PANELS.md), so there is nothing to
// deliver synchronously and no arbitrary-code-evaluation channel left.
const fs = require("fs");
const { app, ipcMain } = require("electron");
const preferences = require("./preferences");
const windowOps = require("./window");
const { showContextMenu } = require("./context-menu");
const extensionServer = require("./extension-server");
const panelHost = require("./panel-host");
const { createMessageRouter } = require("./message-router");
const { evalInPage, reloadInPage } = require("./inspected-window");
const { createNetworkService } = require("./network-service");
// The grant filter `networkSenderFor` below applies to every host->frame network
// push. Importing it here is load-bearing: the call sits inside the sender filter
// that network-service's `broadcast` wraps in `try { … } catch {}`, so an unbound
// name threw a ReferenceError that the catch swallowed — every live delivery died
// silently, for every frame, with no log line (issue #20). Pinned live by
// tests/delivery-scope.test.js.
const { deliveryAllowed } = require("./delivery-scope");
const { getContentBridge, attachContentBridge } = require("./content-bridge");
const { deliverTabMessage } = require("./tab-send");
const { sendCommand, onEvent, status: bridgeStatus } = require("./cdp-bridge");
const { createPermissionGate, API_PERMISSIONS } = require("../shared/permissions");
const tabHost = require("./tab-host");
const notificationHost = require("./notification-host");
const { getContextRegistry } = require("./context-registry");
const { createThemeHost, createThemeReportHandler } = require("./theme-host");
const { stripThemeHintFromUrl } = require("../shared/theme");
const { getRequestQueue } = require("./context-request");
const saveService = require("./save-service");
const { createStorageService, electronStorePersistence } = require("./storage-service");
const optionsHost = require("./options-host");
const { getHostFiles } = require("./host-files");
const { getExternalOpener } = require("./external-open");
const { buildHostConfig } = require("./host-config");
const { isFrontendFrame } = require("./frontend-frame");
const config = require("./config");
const {
  SHOW_CONTEXT_MENU,
  PREF_REGISTER,
  PREF_GET,
  PREF_GET_ALL,
  PREF_SET,
  PREF_REMOVE,
  PREF_CLEAR,
  WINDOW_BRING_TO_FRONT,
  WINDOW_CLOSE,
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
  HOST_SAVE,
  HOST_APPEND,
  HOST_CLOSE_FILE,
  HOST_OPEN_EXTERNAL,
  HOST_CONFIG,
  OPTIONS_OPEN,
  DOWNLOAD_START,
  DOWNLOAD_CANCEL,
  DOWNLOAD_ERASE,
  DOWNLOAD_SEARCH,
  DOWNLOAD_SUGGEST_REPLY,
} = require("../shared/ipc");

// ── runtime messaging router wiring ─────────────────────────────────────────
const router = createMessageRouter();

let contentBridgeInstance = null;

/**
 * The content bridge, on first need. It cannot be built at module load: it wants the
 * router above, and attaching it starts a scan of the extensions folder. The app
 * (src/main/index.js) and the Electron test harness both get here through this one
 * accessor, so `chrome.tabs.sendMessage` always reports against a real bridge — and,
 * when nothing is injected, the reason it is really not injected
 * (docs/features/CONTENT-SCRIPTS.md).
 */
const startContentBridge = () => {
  if (!contentBridgeInstance) {
    try {
      contentBridgeInstance = attachContentBridge({ router });
    } catch (error) {
      console.warn(`[content-scripts] could not start: ${error.message}`);
      return null;
    }
  }
  return contentBridgeInstance;
};

// ── chrome.storage, owned by the host (docs/features/STORAGE-AND-I18N.md) ────
// One store per extension for every one of its contexts, with the change events
// fanned out to all of them. The persistence is built lazily on the first
// local/sync access, so requiring this module (tests) never opens a file.
let storagePersistence;
const storageService = createStorageService({
  openPersistence: (extensionId, area) => {
    storagePersistence = storagePersistence || electronStorePersistence();
    return storagePersistence(extensionId, area);
  },
  log: (message) => console.warn(`[storage] ${message}`),
});

// ── the CDP network model, shared by devtools.network and webRequest ────────
// (docs/features/DEVTOOLS-NETWORK.md). One model for every frame; a frame asks
// for it by id and receives deliveries on NETWORK_DELIVER.
const networkService = createNetworkService({
  sendCommand,
  onEvent,
  bridgeStatus,
  log: (level, message) => {
    const line = `[network] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  },
});

// The frontend's theme, pushed to every registered extension context on change
// (chrome.devtools.panels.setThemeChangeHandler; docs/features/DEVTOOLS-PANELS.md).
const themeHost = createThemeHost({
  broadcast: (delivery) => getContextRegistry().broadcast(delivery),
});

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
// bookkeeping (src/main/background-host.js: a background context has to hear
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
  const resolved = file && extensionServer.resolveExtensionFile(extensionId, file);
  try {
    return Boolean(resolved) && fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
};

const makeFrameSender =
  (key, webContents, frame, channel = RUNTIME_DELIVER, filter = null) =>
  ({ kind, payload }) => {
    // Permission-scoped deliveries (src/main/delivery-scope.js): a frame whose
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

const registerIpcHandlers = () => {
  // chrome.storage persists write-behind (src/main/storage-service.js): whatever is still
  // waiting for its debounce goes to disk before the shell goes away.
  app.on("before-quit", () => storageService.flush());
  app.on("will-quit", () => storageService.flush());

  // ── async channels (the house rule; there is nothing else) ───────────────

  ipcMain.handle(SHOW_CONTEXT_MENU, (_event, { x, y, items }) => {
    showContextMenu(windowOps.getCurrentWindow(), { x, y, items });
  });

  ipcMain.handle(PREF_REGISTER, (_event, name, options) => {
    preferences.register(name, options);
  });
  ipcMain.handle(PREF_GET, (_event, name) => preferences.get(name));
  ipcMain.handle(PREF_GET_ALL, () => preferences.getAll());
  ipcMain.handle(PREF_SET, (_event, name, value) => {
    preferences.set(name, value);
  });
  ipcMain.handle(PREF_REMOVE, (_event, name) => {
    preferences.remove(name);
  });
  ipcMain.handle(PREF_CLEAR, () => {
    preferences.clear();
  });

  ipcMain.handle(WINDOW_BRING_TO_FRONT, () => windowOps.bringToFront());
  ipcMain.handle(WINDOW_CLOSE, () => windowOps.closeWindow());

  // chrome.runtime.getManifest: the extension id is taken from the calling
  // frame's URL — never from message arguments (trust boundary).
  ipcMain.handle(RUNTIME_GET_MANIFEST, (event) => {
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
    getContextRegistry().unregister(key);
    storageService.detach(key);
    // The same for a host->context REQUEST that is still open: a download waiting on
    // a filename suggestion from a frame that has died would otherwise sit until its
    // timeout. Settling it now lets the save proceed with the name it derived, and
    // the save service reports that it did.
    getRequestQueue().dropContext(key);
    router.unregisterFrame(key);
    // A frame that goes away also stops being a network subscriber; the model
    // stops asking the backend for Network events once no frame wants them.
    networkService.unregisterFrame(key);
  };

  ipcMain.handle(RUNTIME_REGISTER, (event) => {
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
    if (!extensionServer.resolveExtensionFile(extensionId, "")) {
      return { ok: false };
    }
    const key = `${event.sender.id}:${event.frameId}`;
    principals.set(key, frame);
    // Reachability registry (src/main/context-registry.js): the same `send` closure
    // the router gets, kept so a host-produced, context-owned event — a system
    // notification the user clicked — can go to the ONE context that created it,
    // which is what Chrome does and what the router (fan-out to every frame of the
    // extension) is not.
    getContextRegistry().register({ frameKey: key, extensionId, send: makeFrameSender(key, event.sender, frame) });
    // Which declared permissions this frame's extension has, decided from the
    // manifest on disk and handed back once, at registration. The frame's shim
    // uses it for lastError reporting; the network handlers below enforce the
    // `webRequest` grant themselves, so a frame that ignores the answer still
    // gets no data (docs/features/EXTENSION-MANAGEMENT.md).
    const granted = grantedPermissions(event);
    grants.set(key, granted);
    // The frame's address as the EXTENSION knows it: the panel bridge's theme hint
    // (src/shared/theme.js) is the shell's detail and must not reach MessageSender.url.
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
    // (src/main/config.js explains what the value is for, and why the config exports
    // it as a number: this reply crosses IPC through the structured-clone serializer,
    // which DROPS a function-valued property rather than transferring it — so a
    // function here reached the frame as `undefined` and every context ran unscaled,
    // silently. tests/tier2-worker-electron.test.js is what measured that.)
    return {
      ok: true,
      granted,
      alarmClockScale: config.alarmClockScale,
      themeName: themeHost.get(),
    };
  });

  const registeredHandle = (channel, handler) =>
    ipcMain.handle(channel, (event, payload) => {
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
  ipcMain.handle(EXT_PANEL_CREATE, (event, { title, pagePath } = {}) => {
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
    return { ok: panelHost.addPanel({ extensionId, title, pagePath, owner }) };
  });

  // The frontend reports its tab selection for extension panels. Only the frontend's
  // own main frame may say so: an extension frame cannot make another extension's
  // panel look shown, and panelId only selects among panels main already hosts.
  ipcMain.handle(EXT_PANEL_VISIBILITY, (event, { panelId, shown } = {}) => {
    if (!isFrontendFrame(event)) {
      return { ok: false };
    }
    return { ok: panelHost.setPanelVisible(panelId, shown === true) };
  });

  // The frontend reporting its theme. Identity is the frame (the frontend's own
  // main frame), never the payload; the value is validated against Chrome's two
  // names inside the theme host before any extension hears it.
  ipcMain.handle(
    THEME_REPORT,
    createThemeReportHandler({ themeHost, isFrontendFrame })
  );

  // ── inspected window (docs/features/INSPECTED-WINDOW.md) ──────────────────
  // chrome.devtools.inspectedWindow.eval -> CDP Runtime.evaluate over the
  // frontend's debugger session (src/main/cdp-bridge.js). Same frame gate as
  // panels.create: an unregistered frame gets a visible isError, never a
  // fabricated value.
  ipcMain.handle(DEVTOOLS_EVAL, (event, { expression, options } = {}) => {
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
  // silently swallowed (src/preload/extension-frame.js).
  ipcMain.handle(DEVTOOLS_RELOAD, (event, { options } = {}) => {
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
    // always "network" (src/main/network-service.js).
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
  ipcMain.handle(NETWORK_SUBSCRIBE, (event) => {
    const target = networkSenderFor(event);
    if (!target) {
      return { available: false, reason: "network.subscribe: unauthorized call", requests: 0 };
    }
    if (!networkService.hasSubscriber(target.key)) {
      return networkService.subscribe(target.key, target.send);
    }
    return networkService.getStatus();
  });

  ipcMain.handle(NETWORK_GET_HAR, (event, { options } = {}) => {
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

  ipcMain.handle(NETWORK_GET_STATUS, (event) => {
    const target = networkSenderFor(event);
    if (!target) {
      return { available: false, reason: "network.getStatus: unauthorized call", requests: 0 };
    }
    return networkService.getStatus();
  });

  // Bodies are the exact place a fake used to live, so every failure path returns
  // `{available: false, error}` with the backend's own reason and never a body.
  ipcMain.handle(NETWORK_GET_BODY, (event, { requestId } = {}) => {
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

  ipcMain.handle(TABS_TARGET_INFO, (event) => {
    if (!tabsCaller(event)) {
      // Not `{attached: false}`: that would be the shape of a truthful "nothing is
      // attached", which is a claim about the app the caller has not earned.
      return { ok: false, error: "tabs: permission 'tabs' is not declared" };
    }
    return tabHost.getTabHost().targetInfo();
  });

  ipcMain.handle(TABS_OPEN, (event, details = {}) => {
    if (!tabsCaller(event)) {
      return { ok: false, error: "tabs: permission 'tabs' is not declared" };
    }
    return tabHost
      .getTabHost()
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
  // live in src/main/tab-send.js so they can be tested; this is the part that cannot be.
  ipcMain.handle(TABS_SEND_TO_APP, (event, details = {}) => {
    return deliverTabMessage({
      // Same two checks every other chrome.tabs channel makes, from host state rather
      // than from anything the frame says about itself.
      granted: tabsCaller(event),
      fromKey: resolveFrameKey(event),
      frameUrl: event.senderFrame ? stripThemeHintFromUrl(event.senderFrame.url) : "",
      // The production shell started it in src/main/index.js; a harness that never ran
      // that file gets it built here, against the same router, so the answer is always
      // "what this shell really did" rather than "the bridge was never started".
      bridge: getContentBridge() || startContentBridge(),
      sendTo: (args) => router.sendTo(args),
      message: details.message,
    });
  });

  // ── chrome.notifications (docs/features/SMALL-SHIMS.md) ────────────────────
  // The `notifications` permission is enforced HERE as well as in the frame's gate:
  // a frame that ignored its RUNTIME_REGISTER reply must not be able to raise a
  // system notification. The OWNER is this event's own frame key, which main derives
  // from the frame — a payload can never name a context to receive a click.
  ipcMain.handle(NOTIFICATION_SHOW, (event, details = {}) => {
    const key = gatedFrameKey(event, "notifications");
    if (!key) {
      return { ok: false, error: "notifications: permission 'notifications' is not declared" };
    }
    return notificationHost
      .getNotificationHost()
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

  ipcMain.handle(NOTIFICATION_CLEAR, (event, { id } = {}) => {
    if (!gatedFrameKey(event, "notifications")) {
      return false;
    }
    return notificationHost.getNotificationHost().clear({ notificationId: id });
  });

  ipcMain.handle(NOTIFICATION_PERMISSION, (event) => {
    if (!gatedFrameKey(event, "notifications")) {
      return "unspecifed";
    }
    return notificationHost.getNotificationHost().permissionLevel();
  });

  ipcMain.handle(TABS_CLOSE, async (event, { handle } = {}) => {
    if (!tabsCaller(event)) {
      return false;
    }
    return tabHost.getTabHost().close(handle);
  });

  // ── chrome.downloads + runtime.openOptionsPage (docs/features/SMALL-SHIMS.md) ──
  //
  // The save machinery is src/main/save-service.js and the filename-suggestion
  // round trip is src/main/context-request.js; both are transport-agnostic, so the
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

  ipcMain.handle(DOWNLOAD_START, (event, details = {}) => {
    const caller = downloadCaller(event);
    if (!caller) {
      return { ok: false, error: "downloads: permission 'downloads' is not declared" };
    }
    return saveService
      .getSaveService()
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

  ipcMain.handle(DOWNLOAD_CANCEL, (event, { id } = {}) => {
    const caller = downloadCaller(event);
    if (!caller) {
      return false;
    }
    return saveService.getSaveService().cancel({ id, owner: caller.owner });
  });

  ipcMain.handle(DOWNLOAD_ERASE, (event, { ids } = {}) => {
    const caller = downloadCaller(event);
    if (!caller) {
      return { id: [] };
    }
    return saveService.getSaveService().erase({ ids, owner: caller.owner });
  });

  ipcMain.handle(DOWNLOAD_SEARCH, (event, { query } = {}) => {
    const caller = downloadCaller(event);
    if (!caller) {
      return [];
    }
    return saveService.getSaveService().search({ query: query || {}, owner: caller.owner });
  });

  ipcMain.handle(DOWNLOAD_SUGGEST_REPLY, (event, { requestId, filename } = {}) => {
    const caller = downloadCaller(event);
    if (!caller) {
      return { ok: false };
    }
    // `resolve` returns false when nothing was waiting on THIS frame for that id, so
    // a late or invented answer cannot influence a download that is already decided.
    const answered = getRequestQueue().resolve(caller.frameKey, requestId, {
      suggestion: typeof filename === "string" && filename ? filename : null,
    });
    return { ok: answered };
  });

  ipcMain.handle(OPTIONS_OPEN, (event) => {
    // Identity from the frame's URL, like every other extension channel: a payload
    // can never name the extension whose options page gets opened.
    let extensionId;
    try {
      extensionId = new URL(event.senderFrame.url).hostname;
    } catch {
      return { ok: false, error: "openOptionsPage: the caller is not an extension page." };
    }
    if (!extensionServer.resolveExtensionFile(extensionId, "")) {
      return { ok: false, error: "openOptionsPage: unknown extension." };
    }
    return optionsHost.getOptionsHost().openOptionsPage(extensionId);
  });

  // `InspectorFrontendHost.save/append/close/openInNewTab/getHostConfig` — channels for
  // the DevTools frontend's own main frame only (src/main/frontend-frame.js: its
  // WebContents, its main frame, still on the frontend origin). An extension page, a
  // background window, a popup or a navigated-away frontend that reached these names is
  // refused: identity is the sender, never anything in the payload.
  const REFUSED = { ok: false, error: "not the DevTools frontend" };
  const failed = (error) => ({ ok: false, error: (error && error.message) || "the call failed" });

  // The frontend's file key (`url`) is echoed back verbatim on savedURL /
  // canceledSaveURL / appendedToURL: its FileManager matches the reply to the pending
  // promise by that exact string (src/main/host-files.js). The save dialog and the write
  // are the same service chrome.downloads uses — no extension gating (the frontend is
  // not an extension) and no filename suggestion (no extension to ask).
  ipcMain.handle(HOST_SAVE, (event, payload) =>
    isFrontendFrame(event) ? getHostFiles().save(payload).catch(failed) : REFUSED
  );
  ipcMain.handle(HOST_APPEND, (event, payload) =>
    isFrontendFrame(event) ? getHostFiles().append(payload).catch(failed) : REFUSED
  );
  ipcMain.handle(HOST_CLOSE_FILE, (event, payload) =>
    isFrontendFrame(event) ? getHostFiles().close(payload).catch(failed) : REFUSED
  );

  // `openInNewTab`: http(s) only (src/main/external-open.js).
  ipcMain.handle(HOST_OPEN_EXTERNAL, (event, payload) =>
    isFrontendFrame(event) ? getExternalOpener().open(payload && payload.url) : REFUSED
  );

  ipcMain.handle(HOST_CONFIG, (event) =>
    isFrontendFrame(event) ? buildHostConfig(config.hostConfigOverride) : {}
  );
};

module.exports = { registerIpcHandlers, subscribeRouterFrames, startContentBridge };
