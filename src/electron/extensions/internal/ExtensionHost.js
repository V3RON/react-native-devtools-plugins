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
//                                               theme, the CDP session object, the
//                                               chrome.debugger service and the broker's
//                                               handler table
//   attachment  attachWindow() (one in v1)      frontend guard, the broker's channels on
//                                               the window's WebContents, panel host, the
//                                               CDP session to the frontend URL's ws=,
//                                               content bridge, background contexts
//
// Background contexts belong to the attachment: `detach()` (the window's `closed`)
// closes their hidden windows, so the embedder's `window-all-closed` still fires.
const fs = require("fs");
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
const { createCdpSession } = require("./cdp/cdp-session");
const { createEvalInPage, createReloadInPage } = require("./cdp/inspected-window");
const { createNetworkService } = require("./cdp/network-service");
const { createDebuggerService } = require("./cdp/debugger-service");
const { tabIdFor } = require("./shim/devtools");
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
 *        options of the host's CDP session (cdp/cdp-session.js: requestTimeoutMs, …)
 * @param {object} [options]
 * @param {string} [options.partition] the session the embedder's windows use; the
 *        default session when omitted
 * @param {object} [hooks] test-only collaborators (never read from the environment):
 *        `notifications`, `save`, `options`, `tabs` override the matching service's
 *        Electron-backed defaults; `background` is the background host's options, or
 *        `false` for no background contexts; `installState` replaces the store;
 *        `wrapIpcHandler(channel, handler)` decorates each broker handler;
 *        `cdpFrontendUrl` is the URL the CDP session reads ws= and the dev server from,
 *        when the test's frontend page is not served by the dev server it debugs
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
  if (!fs.existsSync(EXTENSION_PRELOAD_PATH)) {
    // A sandboxed preload is one bundled file; without it no extension frame gets chrome.*.
    throw new Error(
      `the extension preload is not built (${EXTENSION_PRELOAD_PATH}): run npm run build:preload`
    );
  }
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

  // The host's own debugger session, next to the frontend's (cdp/cdp-session.js). The
  // consumers below subscribe once; attachWindow opens it for that window's ws=.
  const cdp = createCdpSession({ ...(config.cdp || {}), log: prefixed("cdp") });
  const networkService = createNetworkService({
    sendCommand: cdp.sendCommand,
    onEvent: cdp.onEvent,
    onAttach: cdp.onAttach,
    sessionStatus: cdp.status,
    log: prefixed("network"),
  });
  const tabHost = attachTabHost({ cdp, externalOpener, policy: settings.tabsOpen, ...(hooks.tabs || {}) });

  // chrome.debugger (cdp/debugger-service.js): each attached extension gets a debugger
  // session of its own to the same app, which ends with its socket and has no command
  // timeout. Its events go to every context of that extension.
  const debuggerService = createDebuggerService({
    createSession: (extensionId) =>
      createCdpSession({
        ...(config.cdp || {}),
        reconnect: false,
        requestTimeoutMs: 0,
        prime: [],
        log: prefixed(`debugger ${extensionId}`),
      }),
    getFrontendUrl: () => (attachment ? hooks.cdpFrontendUrl || attachment.frontendUrl : null),
    describeTarget: async () => {
      const status = cdp.status();
      if (!status.attached) {
        return { attached: false };
      }
      const info = await tabHost.targetInfo();
      return { attached: true, id: status.target && status.target.id, url: info.url, title: info.title };
    },
    tabIdFor,
    deliver: (extensionId, delivery) => {
      for (const context of contextRegistry.list()) {
        if (context.extensionId === extensionId) {
          contextRegistry.deliver(context.frameKey, delivery);
        }
      }
    },
    log: prefixed("debugger"),
  });

  const frontendGuard = createFrontendGuard();
  let attachment = null; // {win, frontendUrl, panelHost, detachIpc, backgroundHost, cdpStarted}
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
    debuggerService,
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
    // The inspected app goes with the window: every extension's attachment ends.
    debuggerService.detachAll("target_closed");
    detachIpc();
    if (backgroundHost) {
      backgroundHost.closeAll();
    }
    await cdp.close();
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
    attachment = { win, frontendUrl, panelHost, detachIpc, backgroundHost: null, cdpStarted: null };

    // The host's own session to the target in the frontend URL's ws=. It never blocks
    // the window: until (or unless) it attaches, CDP-backed APIs fail with the reason
    // (status().reason), and panels, storage and messaging work without it.
    attachment.cdpStarted = cdp.open(hooks.cdpFrontendUrl || frontendUrl);

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
      debuggerService,
      optionsHost,
      policyFor,
      backgroundHost: attachment ? attachment.backgroundHost : null,
      session: ses,
    }),
  };
};

module.exports = { createExtensionHost, PRELOAD_ID };
