// The composition root of the extension host (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md
// §5.1, §5.3). Every service is created here, takes its collaborators as arguments, and
// is released by `dispose()`; nothing under extensions/internal builds state at import.
//
// Scopes:
//
//   process     registerExtensionSchemes()      scheme privileges, nothing else
//   host        createExtensionHost()           session protocol handler + preload,
//                                               registry settings, storage, install
//                                               state, router, context registry, request
//                                               queue, notifications, save, options,
//                                               theme, the CDP bridge and the broker's
//                                               handler table
//   attachment  attachWindow() (one in v1)      frontend guard, the broker's channels on
//                                               the window's WebContents, panel host, the
//                                               CDP bridge's listener, content bridge,
//                                               background contexts
//
// Background contexts belong to the attachment: `detach()` (the window's `closed`)
// closes their hidden windows, so the embedder's `window-all-closed` still fires.
const { session: electronSession } = require("electron");
const { configure, reset, settings } = require("./settings");
const { EXTENSION_SCHEME } = require("./scheme/protocol");
const { registerExtensionProtocol } = require("./scheme/extension-server");
const { openInstallState } = require("./registry/install-state");
const { createBroker } = require("./broker/ipc");
const { createFrontendGuard } = require("./frontend/frontend-frame");
const { createPanelHost } = require("./frontend/panel-host");
const { createThemeHost } = require("./frontend/theme-host");
const { createMessageRouter } = require("./contexts/message-router");
const { createContextRegistry } = require("./contexts/context-registry");
const { createRequestQueue } = require("./contexts/context-request");
const { attachBackgroundHost } = require("./contexts/background-host");
const { attachOptionsHost } = require("./contexts/options-host");
const {
  EXTENSION_PRELOAD_PATH,
  extensionFramePreferences,
  frontendPreferences,
} = require("./contexts/frame-security");
const { createCdpBridge } = require("./cdp/cdp-bridge");
const { createEvalInPage, createReloadInPage } = require("./cdp/inspected-window");
const { createNetworkService } = require("./cdp/network-service");
const { attachContentBridge } = require("./content/content-bridge");
const { createStorageService, electronStorePersistence } = require("./services/storage-service");
const { attachNotificationHost } = require("./services/notification-host");
const { attachSaveService } = require("./services/save-service");
const { attachTabHost } = require("./services/tab-host");
const { electronExternalOpener } = require("./services/external-open");

const PRELOAD_ID = "react-native-devtools-extensions";

const prefixed = (prefix) => (level, message) => {
  const line = `[${prefix}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/**
 * @param {object} config what the embedder decided (src/electron/shell/config.js maps
 *        the DEVTOOLS_* environment): extensionsDir, contentScripts, uiLocale, tabsOpen,
 *        showPanel, alarmClockScale, testOpenLog, testSaveDialog, and `cdp` — the
 *        options of the CDP bridge (cdp/cdp-bridge.js)
 * @param {object} [options]
 * @param {string} [options.partition] the session the embedder's windows use; the
 *        default session when omitted
 * @param {object} [hooks] test-only collaborators (never read from the environment):
 *        `notifications`, `save`, `options`, `tabs` override the matching service's
 *        Electron-backed defaults; `background` is the background host's options, or
 *        `false` for no background contexts; `installState` replaces the store;
 *        `wrapIpcHandler(channel, handler)` decorates each broker handler
 * @returns {{webPreferences: function, attachWindow: function, dispose: function}}
 */
const createExtensionHost = (config = {}, options = {}, hooks = {}) => {
  configure(config);
  const log = prefixed("extensions");
  const ses = options.partition
    ? electronSession.fromPartition(options.partition)
    : electronSession.defaultSession;
  const windowPreferences = extensionFramePreferences(
    options.partition ? { partition: options.partition } : {}
  );

  // ── scheme + preload, on the host's session ───────────────────────────────
  const policyFor = registerExtensionProtocol({ protocol: ses.protocol });
  ses.registerPreloadScript({ type: "frame", id: PRELOAD_ID, filePath: EXTENSION_PRELOAD_PATH });

  // ── host scope ────────────────────────────────────────────────────────────
  const contextRegistry = createContextRegistry();
  const requestQueue = createRequestQueue({
    deliver: (frameKey, delivery) => contextRegistry.deliver(frameKey, delivery),
  });
  const router = createMessageRouter();
  // chrome.storage, owned by the host (docs/features/STORAGE-AND-I18N.md). The
  // persistence is opened on the first local/sync access.
  let storagePersistence;
  const storageService = createStorageService({
    openPersistence: (extensionId, area) => {
      storagePersistence = storagePersistence || electronStorePersistence();
      return storagePersistence(extensionId, area);
    },
    log: (message) => console.warn(`[storage] ${message}`),
  });
  const installState = hooks.installState || openInstallState();
  const themeHost = createThemeHost({ broadcast: (delivery) => contextRegistry.broadcast(delivery) });
  const notificationHost = attachNotificationHost({ contextRegistry, ...(hooks.notifications || {}) });
  const saveService = attachSaveService({
    contextRegistry,
    requestQueue,
    testSaveDialog: settings.testSaveDialog,
    ...(hooks.save || {}),
  });
  // The broker's channels go on each WebContents the host owns, never on ipcMain
  // (broker/ipc.js). Late-bound: options windows open only after the broker exists.
  const attachIpc = (contents) => broker.attachContents(contents);
  const optionsHost = attachOptionsHost({
    webPreferences: windowPreferences,
    attachIpc,
    ...(hooks.options || {}),
  });
  const externalOpener = electronExternalOpener({ testOpenLog: settings.testOpenLog });

  // The debugger session extensions use (today: the in-process bridge in front of the
  // frontend's socket, cdp/cdp-bridge.js). Nothing binds until attachWindow starts it.
  const cdp = createCdpBridge({ ...(config.cdp || {}), log: prefixed("cdp-bridge") });
  const networkService = createNetworkService({
    sendCommand: cdp.sendCommand,
    onEvent: cdp.onEvent,
    bridgeStatus: cdp.status,
    log: prefixed("network"),
  });
  const tabHost = attachTabHost({ cdp, externalOpener, policy: settings.tabsOpen, ...(hooks.tabs || {}) });

  const frontendGuard = createFrontendGuard();
  let attachment = null; // {win, panelHost, detachIpc, backgroundHost, cdpStarted}
  let contentBridge = null;

  /**
   * The content-script runner (docs/features/CONTENT-SCRIPTS.md), on first need: at
   * attach, or when chrome.tabs.sendMessage asks before any window was attached. It is
   * inert unless the content-script opt-in names an extension.
   */
  const ensureContentBridge = () => {
    if (!contentBridge) {
      try {
        contentBridge = attachContentBridge({
          router,
          cdp,
          targetInfo: () => tabHost.targetInfo(),
          allowlist: settings.contentScripts,
        });
      } catch (error) {
        console.warn(`[content-scripts] could not start: ${error.message}`);
        return null;
      }
    }
    return contentBridge;
  };

  const broker = createBroker({
    router,
    storageService,
    networkService,
    themeHost,
    contextRegistry,
    requestQueue,
    getPanelHost: () => (attachment ? attachment.panelHost : null),
    isFrontendFrame: frontendGuard.isFrontendFrame,
    evalInPage: createEvalInPage(cdp.sendCommand),
    reloadInPage: createReloadInPage(cdp.sendCommand),
    tabHost,
    notificationHost,
    saveService,
    optionsHost,
    getContentBridge: ensureContentBridge,
    wrapHandler: hooks.wrapIpcHandler,
  });
  broker.register();

  const detach = async () => {
    if (!attachment) {
      return;
    }
    const { backgroundHost, detachIpc } = attachment;
    attachment = null;
    frontendGuard.detach();
    detachIpc();
    if (backgroundHost) {
      backgroundHost.closeAll();
    }
    await cdp.stop().catch(() => {});
  };

  const attachWindow = (win, frontendUrl) => {
    if (attachment) {
      // v1 hosts one window: later windows stay stock.
      return null;
    }
    const contents = win.webContents;
    frontendGuard.attach(contents, frontendUrl);
    // Before loadURL: the frontend's main frame and its extension iframes call these.
    const detachIpc = broker.attachContents(contents);
    const panelHost = createPanelHost({ showPanel: settings.showPanel });
    panelHost.attach(contents);
    attachment = { win, panelHost, detachIpc, backgroundHost: null, cdpStarted: null };

    // Owns the RN debugger session before the frontend dials its `?ws=` socket.
    // Rejected only when the port is taken; the shell still runs and
    // inspectedWindow.eval reports isError instead of guessing.
    attachment.cdpStarted = cdp.start().catch((error) => {
      console.error(
        `[cdp-bridge] listen failed: ${error.message} — stop the external relay ` +
          "(npm run rn-cdp / fake-cdp) or set DEVTOOLS_CDP_BRIDGE=off"
      );
    });

    // Background contexts after the protocol and the IPC handlers their preload calls.
    if (hooks.background !== false) {
      attachment.backgroundHost = attachBackgroundHost({
        installState,
        observeFrame: broker.subscribeRouterFrames,
        webPreferences: windowPreferences,
        attachIpc,
        ...(hooks.background || {}),
      });
    }
    ensureContentBridge();

    win.once("closed", () => {
      void detach();
    });
    return { detach };
  };

  const dispose = async () => {
    await detach();
    if (contentBridge && typeof contentBridge.dispose === "function") {
      contentBridge.dispose();
    }
    contentBridge = null;
    broker.dispose();
    // chrome.storage persists write-behind: whatever waits for its debounce goes to disk.
    storageService.flush();
    try {
      ses.protocol.unhandle(EXTENSION_SCHEME);
      ses.unregisterPreloadScript(PRELOAD_ID);
    } catch (error) {
      log("warn", `dispose: ${error.message}`);
    }
    reset();
  };

  return {
    webPreferences: (base = {}) => frontendPreferences(base),
    attachWindow,
    dispose,
    // Test-only views of the host's own objects (tests/extension-frame-harness.js);
    // not part of the public API (../index.js does not re-export them).
    _internals: () => ({
      cdp,
      cdpStarted: attachment ? attachment.cdpStarted : Promise.resolve(),
      broker,
      optionsHost,
      policyFor,
      backgroundHost: attachment ? attachment.backgroundHost : null,
      session: ses,
    }),
  };
};

module.exports = { createExtensionHost, PRELOAD_ID };
