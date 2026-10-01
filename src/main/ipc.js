// IPC handler registration. Delegates state/services; no logic here.
//
// Every channel is async (`ipcMain.handle` + `invoke`) — the house rule in
// src/shared/ipc.js, unconditional since the injected-script channel went away.
// The two `sendSync` handlers that used to sit at the top of this function were
// the whole point of that exception: they handed extension frames a
// frontend-supplied script to `new Function`. `chrome.devtools.*` is implemented
// shell-side now (docs/features/DEVTOOLS-PANELS.md), so there is nothing to
// deliver synchronously and no arbitrary-code-evaluation channel left.
const { ipcMain } = require("electron");
const preferences = require("./preferences");
const windowOps = require("./window");
const { showContextMenu } = require("./context-menu");
const extensionServer = require("./extension-server");
const panelHost = require("./panel-host");
const { createMessageRouter } = require("./message-router");
const { evalInPage, reloadInPage } = require("./inspected-window");
const { createNetworkService } = require("./network-service");
const { sendCommand, onEvent, status: bridgeStatus } = require("./cdp-bridge");
const { createPermissionGate } = require("../shared/permissions");
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
  EXT_PANEL_CREATE,
  DEVTOOLS_EVAL,
  DEVTOOLS_RELOAD,
  NETWORK_SUBSCRIBE,
  NETWORK_GET_HAR,
  NETWORK_GET_STATUS,
  NETWORK_GET_BODY,
  NETWORK_DELIVER,
} = require("../shared/ipc");

// ── runtime messaging router wiring ─────────────────────────────────────────
const router = createMessageRouter();

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
  for (const permission of ["storage", "tabs", "webRequest", "notifications"]) {
    granted[permission] = gate.has(permission);
  }
  return granted;
};

let unregisterRouterFrame; // set below to avoid closure-order issues

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
    // Which declared permissions this frame's extension has, decided from the
    // manifest on disk and handed back once, at registration. The frame's shim
    // uses it for lastError reporting; the network handlers below enforce the
    // `webRequest` grant themselves, so a frame that ignores the answer still
    // gets no data (docs/features/EXTENSION-MANAGEMENT.md).
    const granted = grantedPermissions(event);
    grants.set(key, granted);
    router.registerFrame({
      key,
      extensionId,
      url: frame.url,
      send: makeFrameSender(key, event.sender, frame),
    });
    notifyFrameObservers({
      key,
      extensionId,
      url: frame.url,
      send: makeFrameSender(key, event.sender, frame),
    });
    event.sender.once("destroyed", () => unregisterRouterFrame(key));
    return { ok: true, granted };
  });

  const registeredHandle = (channel, handler) =>
    ipcMain.handle(channel, (event, payload) => {
      const fromKey = resolveFrameKey(event);
      if (!fromKey) {
        return payload?.requestId !== undefined ? undefined : { ok: false };
      }
      return handler(fromKey, payload);
    });

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
    if (
      typeof title !== "string" ||
      typeof pagePath !== "string" ||
      !extensionServer.resolveExtensionFile(extensionId, "")
    ) {
      return { ok: false };
    }
    return { ok: panelHost.addPanel({ extensionId, title, pagePath }) };
  });

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
};

module.exports = { registerIpcHandlers, subscribeRouterFrames };
