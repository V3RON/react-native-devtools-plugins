// Assembles the chrome.* namespace installed into extension frames
// (window.chrome). Pure assembly: every external capability is injected —
//
//   extensionId    — id == rozenite URL hostname (load-bearing contract)
//   getManifest    — () => manifest object ({} until loaded)
//   platform       — {os, arch} in Chrome's vocabulary
//   storage        — from ./storage createExtensionStorage({ createBackend })
//   networkBridge  — from ./network-bridge createNetworkBridge({ ... }): feeds
//                    BOTH chrome.webRequest and chrome.devtools.network (one CDP
//                    capture in main, two Chrome APIs — docs/features/
//                    DEVTOOLS-NETWORK.md, docs/features/WEBREQUEST.md)
//   transport      — optional host transport for runtime messaging
//                    (see ./messaging); when absent, runtime messaging
//                    degrades to the previous no-op state.
//   onPanelCreated — optional (docs/features/DEVTOOLS-PANELS.md): host hook
//                    behind chrome.devtools.panels.create; absent = inert.
//   evalInPage     — optional (docs/features/INSPECTED-WINDOW.md): host
//                    implementation behind chrome.devtools.inspectedWindow.eval;
//                    absent = honest isError.
//   reloadInPage   — optional (same doc): host implementation behind
//                    inspectedWindow.reload (CDP Page.reload).
//   permissions    — optional gate from src/shared/permissions (see
//                    ./permission-gate): when present, an API whose permission the
//                    manifest does not declare fails instead of working. Absent =
//                    ungated, which is what every unit test that predates
//                    permission enforcement injects.
//   onPermissionDenied — optional (reason, api) sink for the console/log
//   getTargetInfo  — optional (docs/features/SMALL-SHIMS.md): what the host knows
//                    about the inspected target, {attached, url, title}. Feeds
//                    chrome.tabs' one synthetic tab. Absent = never attached, i.e.
//                    the documented `about:blank` fallback.
//   openTabIn / closeTabById — optional host capability behind tabs.create/remove.
//                    Absent = nothing opens, and the returned tab says so with
//                    `openedVia: null` rather than pretending to be a browser tab.
//   getAlarmClockScale — optional () => number: the host's clock multiplier for
//                    chrome.alarms (src/main/config.js explains why main decides it
//                    and the frame is handed it). 1 = real time.
//   showNotification / hideNotification / getNotificationPermissionLevel —
//                    optional host capability behind chrome.notifications (issue #4).
//                    Absent = no backend, so create() names no id at all.
//
// Transports and concrete backends are wired by the caller (the
// extension-frame preload). Status per namespace: docs/api/CHROME-EXTENSION-APIS.md.
const { createEvent } = require("./event");
const { createRuntime } = require("./runtime");
const { createMessagingClient } = require("./messaging");
const { createDevtools, tabIdFor } = require("./devtools");
const { createTabs } = require("./tabs");
const { createAction, createNotifications } = require("./browser-apis");
const { createPermissionsApi } = require("./permissions-api");
const { createAlarms } = require("./alarms");
const { createDownloads } = require("./downloads");
const { createCommands, createContextMenus, createSidePanel } = require("./browser-shells");
const { declaredPermissions } = require("../shared/permissions");
const { buildExtensionURL } = require("../shared/protocol");
const {
  gateCallbackNamespace,
  gateWebRequest,
} = require("./permission-gate");

const createChromeNamespace = ({
  extensionId,
  getManifest = () => ({}),
  platform = { os: "linux", arch: "unknown" },
  storage,
  networkBridge,
  transport,
  onPanelCreated,
  evalInPage,
  reloadInPage,
  permissions,
  getTargetInfo = () => ({ attached: false }),
  openTabIn = null,
  sendToApp = null,
  closeTabById = null,
  showNotification = null,
  hideNotification = null,
  getNotificationPermissionLevel = () => "granted",
  getAlarmClockScale = () => 1,
  saveDownload = null,
  cancelDownload = null,
  eraseDownloads = null,
  searchDownloads = null,
  respondSuggestion = null,
  openOptionsPage = null,
  logger = console,
}) => {
  // Shared mutable lastError holder — runtime exposes it as a live getter;
  // the messaging client sets/clears it around callback invocations.
  const lastError = { value: null };

  /**
   * What `promiseOrCallback` wants as `options.lastError`: the same shared cell, wrapped in
   * the `{setError, clearError}` pair it documents. Handing a shim the bare cell instead —
   * which is what happened while each shim guessed — leaves `setError` missing, so
   * `promiseOrCallback` falls back to `callback(undefined, {message})`: an argument Chrome
   * never passes, delivered while `chrome.runtime.lastError` stays empty. The extension's
   * `if (chrome.runtime.lastError)` then reads a failure as a successful `undefined`.
   *
   * Only the shims that raise their OWN failures need this (`tabs`). The shells in
   * src/chrome-shim/browser-shells.js build the pair themselves around the cell, which is
   * why the two shapes coexist here.
   */
  const lastErrorScope = {
    setError: (error) => {
      lastError.value = error;
    },
    clearError: () => {
      lastError.value = null;
    },
  };

  // Declared permissions gate real capability (docs/features/EXTENSION-MANAGEMENT.md).
  // Absent means ungated: the shape stays and every call works, which is the
  // state a unit test injects when it is not testing enforcement.
  const gate = permissions || { check: () => ({ ok: true }) };
  const setLastError = (value) => {
    lastError.value = value;
  };
  const reportDenied = (detail, api) => {
    logger.warn(`[chrome.${api}] permission denied: ${detail}`);
  };

  const runtime = createRuntime({
    extensionId,
    getManifest,
    platform,
    lastError,
    openOptionsPage,
  });

  // What this extension actually holds, from the HOST's verdict when there is one
  // (RUNTIME_REGISTER read the manifest from disk) and from the manifest otherwise.
  // May be a promise while that verdict is in flight — `chrome.permissions` waits
  // rather than guessing (src/chrome-shim/permissions-api.js).
  const declaredPermissionsList = () =>
    permissions && typeof permissions.declaredList === "function"
      ? permissions.declaredList()
      : declaredPermissions(getManifest());

  // Built before the namespace so host->frame deliveries can be routed to the REAL
  // object: the gated wrapper adds lastError behaviour for denied callers, which is
  // right for a page calling `create` and wrong for the host reporting a click the
  // user already made.
  const notifications = createNotifications({
    show: showNotification,
    hide: hideNotification,
    permissionLevel: getNotificationPermissionLevel,
    onUnsupported: (message) => logger.warn(`[chrome.notifications] ${message}`),
  });

  // [REAL] `chrome.alarms` — timers in THIS context (docs/features/SMALL-SHIMS.md).
  // Chrome's other half, persistence plus event-driven wake, does not exist here:
  // this host's worker is always-on (docs/features/BACKGROUND-WORKER.md), so an alarm
  // lives and dies with the context that created it. That divergence is stated in
  // docs/LIMITATIONS.md; what is implemented is Chrome's argument rules, its
  // replace-on-recreate behavior, and its `scheduledTime` semantics.
  const alarms = createAlarms({ clockScale: getAlarmClockScale });

  // [REAL] `chrome.downloads` over the shell's one save path (src/main/save-service.js).
  // The id, the state transitions, and the byte count all come from main, which is
  // where the write actually happens; this shim only shapes the answer and routes the
  // pushes. Built before the namespace because host deliveries are routed into it.
  const downloads = createDownloads({
    start: saveDownload,
    cancel: cancelDownload,
    erase: eraseDownloads,
    search: searchDownloads,
    respondSuggestion,
    onUnsupported: (message) => logger.warn(`[chrome.downloads] ${message}`),
  });

  let handleDelivery = () => {};
  if (transport) {
    const messaging = createMessagingClient({
      extensionId,
      transport,
      runtimeEvents: runtime.events,
      lastError,
    });
    Object.assign(runtime.namespace, messaging.namespace);
    handleDelivery = messaging.handleDelivery;
  }

  const onChanged = createEvent();
  for (const area of ["local", "sync", "session"]) {
    storage[area].onChanged.addListener((changes, areaName) =>
      onChanged._fire(changes, areaName)
    );
  }

  const chrome = {
    runtime: runtime.namespace,

    // [REAL, observe-only] chrome.webRequest from the host's CDP network model —
    // the same capture as chrome.devtools.network below, and non-blocking by
    // construction (docs/features/WEBREQUEST.md). Gated on the declared
    // `webRequest` permission: a listener from an extension that does not
    // declare it is never registered, so no request data reaches it — this is
    // the gate the content-script layer (docs/features/CONTENT-SCRIPTS.md)
    // builds on. Chrome's Event objects have no callback, so a denial cannot
    // travel as lastError; it is reported once, through the console.
    webRequest: gateWebRequest(networkBridge.webRequest, {
      check: (api) => gate.check(api),
      onDenied: (reason) => reportDenied(reason, "webRequest"),
      logger,
    }),

    // [REAL storage; Tier-1 devtools] chrome.devtools.* — installed for every
    // extension frame, matching Chrome (devtools page + panel pages alike);
    // panels.create is host-driven (docs/features/DEVTOOLS-PANELS.md),
    // inspectedWindow.eval is host-backed (docs/features/INSPECTED-WINDOW.md),
    // and devtools.network is the shared network bridge's own API object
    // (docs/features/DEVTOOLS-NETWORK.md).
    //
    // NOT permission-gated, on purpose: Chrome's DevTools-extension APIs
    // (`devtools.*`, and `devtools.network` since MV3) need no manifest
    // permission, and the bundled extensions prove the point — Altair declares
    // no `webRequest` yet uses the network capture. Gating these would break
    // them without Chrome's blessing.
    devtools: createDevtools({
      extensionId,
      onPanelCreated,
      evalInPage,
      reloadInPage,
      networkApi: networkBridge.network,
    }).namespace,

    // [REAL for one tab] `chrome.tabs` answers with the ONE tab this shell has: the
    // inspected RN target, under the same id `devtools.inspectedWindow.tabId`
    // reports, with url/title from the host's CDP target info and Chrome's
    // `about:blank` + `""` fallback when no session is attached. `create` returns a
    // real descriptor with an id and a resolved url (what Altair's tabs.js needs)
    // and reports what it actually opened via `openedVia`; `sendMessage` stays an
    // honest no-receivers answer until content scripts exist (issue #5).
    // Gated on the declared `tabs` permission (Chrome requires it): every method
    // keeps its shape and its promise/callback duality, and fails with
    // runtime.lastError when the permission is missing.
    tabs: gateCallbackNamespace(
      createTabs({
        // The SAME id chrome.devtools.inspectedWindow.tabId reports, so an
        // extension that talks to both APIs is talking about one thing.
        tabId: tabIdFor(extensionId),
        getTarget: getTargetInfo,
        resolveUrl: (innerPath) => buildExtensionURL(extensionId, innerPath),
        openTab: openTabIn,
        closeTab: closeTabById,
        // issue #5: the receiver `tabs.sendMessage` addresses is this extension's own
        // content script in the inspected target, and the host does the delivering.
        sendToApp,
        onUnsupported: (message) => logger.warn(`[chrome.tabs] ${message}`),
        // The pair, not the bare cell. `createTabs` documents `{setError, clearError}` and
        // its own unit tests pass exactly that, so this call site was the one place the
        // contract was broken — every failure this model raises ("No tab with id") was
        // invisible to `if (chrome.runtime.lastError)`.
        lastError: lastErrorScope,
      }),
      {
      api: "tabs",
      check: (api) => gate.check(api),
      setLastError,
      onDenied: (method, error) => reportDenied(`${method}: ${error.message}`, "tabs"),
    }),

    // [REAL] persistent per-extension storage (session area: per-frame
    // in-memory, see storage.js deviation note)
    // (docs/features/STORAGE-AND-I18N.md). Gated on the declared `storage`
    // permission, like Chrome's. The methods live one level down (per area), so
    // each area is gated and `onChanged` — an Event, not an API — is left alone.
    storage: {
      ...Object.fromEntries(
        ["local", "sync", "session"].map((area) => [
          area,
          gateCallbackNamespace(storage[area], {
            api: "storage",
            check: (api) => gate.check(api),
            setLastError,
            onDenied: (method, error) =>
              reportDenied(`${method}: ${error.message}`, "storage"),
          }),
        ])
      ),
      onChanged,
    },

    // [ACCEPT-AND-GRANT, truthful] `chrome.permissions` reports what this extension
    // really holds and grants nothing new: capability is decided from the manifest
    // on disk (src/main/ipc.js), so a request() that answered "true" for an
    // undeclared permission would only move the failure to the first real call.
    // Ungated, like Chrome's — an extension may always ask what it holds.
    // docs/features/SMALL-SHIMS.md + docs/LIMITATIONS.md record the divergence.
    permissions: createPermissionsApi({
      declared: declaredPermissionsList,
      onUnsupportedRequest: (message) =>
        logger.warn(`[chrome.permissions] ${message}`),
    }),

    // [ACCEPT-AND-GRANT] `chrome.action`: registrable, inert. Its whole reason for
    // existing is that MV3 workers reference `chrome.action.onClicked.addListener` at
    // module scope, and an ESM worker that throws at load has no background context at
    // all (Altair's does). No button, no badge, no popup, and `onClicked` never fires:
    // Chrome hands that listener a Tab, and the one tab this shell has is the inspected
    // RN target, which has no toolbar button to click. Ungated, like Chrome's
    // (src/shared/permissions.js lists `action` as needing nothing).
    action: createAction(),

    // [REAL] `chrome.notifications` → Electron `Notification`, on the declared
    // `notifications` permission like Chrome's (an extension that does not declare it
    // gets lastError, not a silent no-op). `create` allocates the id only if something
    // really showed, `clear`/`getAll` answer from the live registry, and `onClicked`/
    // `onClosed` fire from the OS's own click/close callbacks — never fabricated.
    notifications: gateCallbackNamespace(notifications, {
      api: "notifications",
      check: (api) => gate.check(api),
      setLastError,
      onDenied: (method, error) =>
        reportDenied(`${method}: ${error.message}`, "notifications"),
    }),

    // [REAL] `chrome.alarms` — real timers in this context, gated on the declared
    // `alarms` permission like Chrome's. `create` validates alarmInfo the way Chrome
    // does (throwing synchronously), and `onAlarm` carries the time the occurrence was
    // SCHEDULED for rather than the tick's Date.now(). Alarms do NOT survive the
    // context: this worker is always-on, so there is no eviction to persist through
    // (docs/LIMITATIONS.md).
    alarms: gateCallbackNamespace(alarms, {
      api: "alarms",
      check: (api) => gate.check(api),
      setLastError,
      onDenied: (method, error) => reportDenied(`${method}: ${error.message}`, "alarms"),
    }),

    // [REAL] `chrome.downloads` — Chrome's API over the shell's one save path
    // (src/main/save-service.js), gated on the declared `downloads` permission like
    // Chrome's. `download()` resolves the id main allocated (no id for a save that
    // did not happen), `onChanged` carries the transitions main observed, and
    // `onDeterminingFilename` keeps Chrome's contract that nothing is decided until
    // the extension's callback runs — with Chrome's other half intact too: with no
    // listener the download proceeds immediately under the suggested name.
    // `show`/`showDefaultFolder` do nothing and say so, because there is no download
    // shelf to reveal anything in (docs/LIMITATIONS.md).
    downloads: gateCallbackNamespace(downloads, {
      api: "downloads",
      check: (api) => gate.check(api),
      setLastError,
      onDenied: (method, error) => reportDenied(`${method}: ${error.message}`, "downloads"),
    }),

    // [ACCEPT-AND-GRANT, truthful] The three namespaces whose SURFACE this host does not
    // have: no keyboard shortcut is routed to an extension, there is no browser right-click
    // menu, and there is no panel drawer. They exist with Chrome's shape so a worker naming
    // them at module scope LOADS (docs/OVERVIEW.md's stubbing rule), and each reports once
    // which producer is missing. No event here fires, because firing one would run the
    // handler the extension wrote for a real click or keypress. `commands.getAll` is the one
    // method that can be genuinely real: it reads the manifest, which is a fact.
    // Ungated, like Chrome's (src/shared/permissions.js lists all three under UNGATED_APIS).
    // docs/features/SMALL-SHIMS.md + docs/LIMITATIONS.md record each divergence.
    commands: createCommands({
      getManifest,
      onUnsupported: (message) => logger.warn(`[chrome.commands] ${message}`),
      lastError,
    }),

    contextMenus: createContextMenus({
      onUnsupported: (message) => logger.warn(`[chrome.contextMenus] ${message}`),
      lastError,
    }),

    sidePanel: createSidePanel({
      onUnsupported: (message) => logger.warn(`[chrome.sidePanel] ${message}`),
      lastError,
    }),
  };

  // Host -> frame delivery entry point (non-enumerable: not part of the exposed
  // chrome namespace). The preload wires it to RUNTIME_DELIVER IPC.
  //
  // Order matters and is not arbitrary: a `notification` delivery is consumed by
  // the notifications namespace and must not reach the messaging client, which
  // would otherwise ignore it silently (its default branch is a no-op).
  Object.defineProperty(chrome, "handleDelivery", {
    value: (delivery) => {
      if (delivery && delivery.kind === "notification" && notifications._onDelivery) {
        if (notifications._onDelivery(delivery)) {
          return;
        }
      }
      // `download` pushes are chrome.downloads' own (onChanged / onDeterminingFilename),
      // and are consumed here for the same reason: the messaging client would drop them.
      if (delivery && delivery.kind === "download" && downloads._onDelivery) {
        if (downloads._onDelivery(delivery)) {
          return;
        }
      }
      handleDelivery(delivery);
    },
    enumerable: false,
  });

  // The un-gated alarms instance, for the caller that has to stop its timers when
  // the context goes away (the preload tears it down on `pagehide`). Non-enumerable:
  // not part of the exposed chrome namespace.
  Object.defineProperty(chrome, "_alarmsShim", { value: alarms, enumerable: false });

  return chrome;
};

module.exports = {
  createChromeNamespace,
  createEvent: require("./event").createEvent,
  createExtensionStorage: require("./storage").createExtensionStorage,
  createMemoryBackend: require("./storage").createMemoryBackend,
  createNetworkBridge: require("./network-bridge").createNetworkBridge,
  createDevtools: require("./devtools").createDevtools,
  createTabs: require("./tabs").createTabs,
};
