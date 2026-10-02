// IPC handler registration. Delegates state/services; no logic here.
const { ipcMain } = require("electron");
const injectedScripts = require("./injected-scripts");
const preferences = require("./preferences");
const windowOps = require("./window");
const { showContextMenu } = require("./context-menu");
const extensionServer = require("./extension-server");
const panelHost = require("./panel-host");
const { createMessageRouter } = require("./message-router");
const { evalInPage, reloadInPage } = require("./inspected-window");
const { createNetworkService } = require("./network-service");
const { sendCommand, onEvent, status: bridgeStatus } = require("./cdp-bridge");
const {
  STORE_INJECTED_SCRIPT,
  GET_INJECTED_SCRIPT,
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

let unregisterRouterFrame; // set below to avoid closure-order issues

const makeFrameSender = (key, webContents, frame, frameId, channel = RUNTIME_DELIVER) => ({
  kind,
  payload,
}) => {
  try {
    if (webContents.isDestroyed() || (frame && frame.isDestroyed())) {
      throw new Error("frame gone");
    }
    webContents.sendToFrame([webContents.id, frameId], channel, {
      kind,
      payload,
    });
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
  // Deliberate sendSync exception (see src/shared/ipc.js house rule):
  // the injected script must be installed before extension page scripts run.
  ipcMain.on(STORE_INJECTED_SCRIPT, (event, origin, script) => {
    injectedScripts.set(origin, script);
    event.returnValue = true;
  });

  ipcMain.on(GET_INJECTED_SCRIPT, (event, origin) => {
    event.returnValue = injectedScripts.get(origin);
  });

  // ── async channels (house rule: everything new goes through here) ──────

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
    if (!extensionId || !extensionServer.resolveExtensionFile(extensionId, "")) {
      return { ok: false };
    }
    const key = `${event.sender.id}:${event.frameId}`;
    principals.set(key, frame);
    router.registerFrame({
      key,
      extensionId,
      url: frame.url,
      send: makeFrameSender(key, event.sender, frame, event.frameId),
    });
    event.sender.once("destroyed", () => unregisterRouterFrame(key));
    return { ok: true };
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
    return {
      key,
      send: makeFrameSender(key, event.sender, frame, event.frameId, NETWORK_DELIVER),
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

module.exports = { registerIpcHandlers };
