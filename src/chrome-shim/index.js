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
//
// Transports and concrete backends are wired by the caller (the
// extension-frame preload). Status per namespace: docs/api/CHROME-EXTENSION-APIS.md.
const { createEvent } = require("./event");
const { createRuntime } = require("./runtime");
const { createMessagingClient } = require("./messaging");
const { createDevtools } = require("./devtools");
const { createTabs } = require("./tabs");
const { createAction, createNotifications } = require("./browser-apis");
const { createPermissionsApi } = require("./permissions-api");
const { declaredPermissions } = require("../shared/permissions");
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
  logger = console,
}) => {
  // Shared mutable lastError holder — runtime exposes it as a live getter;
  // the messaging client sets/clears it around callback invocations.
  const lastError = { value: null };

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

  const runtime = createRuntime({ extensionId, getManifest, platform, lastError });

  // What this extension actually holds, from the HOST's verdict when there is one
  // (RUNTIME_REGISTER read the manifest from disk) and from the manifest otherwise.
  // May be a promise while that verdict is in flight — `chrome.permissions` waits
  // rather than guessing (src/chrome-shim/permissions-api.js).
  const declaredPermissionsList = () =>
    permissions && typeof permissions.declaredList === "function"
      ? permissions.declaredList()
      : declaredPermissions(getManifest());

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

    // [STUB] inert host shell: no browser tab model here (docs/LIMITATIONS.md).
    // Gated on the declared `tabs` permission (Chrome requires it): every method
    // keeps its shape and its promise/callback duality, and fails with
    // runtime.lastError when the permission is missing.
    tabs: gateCallbackNamespace(createTabs(), {
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

    // [STUB — issue #4 owns making this real] `chrome.action`: registrable,
    // inert. Its whole reason for existing is that MV3 workers reference
    // `chrome.action.onClicked.addListener` at module scope, and an ESM worker
    // that throws at load has no background context at all (Altair's does).
    // No button, no badge, no popup, and onClicked never fires. Ungated, like
    // Chrome's (src/shared/permissions.js lists `action` as needing nothing).
    action: createAction(),

    // [STUB — issue #4 owns making this real] `chrome.notifications`: `create`
    // shows NOTHING and names nothing; onClicked never fires. Gated on the
    // declared `notifications` permission like Chrome's (Altair declares it;
    // an extension that does not gets lastError, not a silent no-op).
    notifications: gateCallbackNamespace(
      createNotifications({
        onStubCall: (message) =>
          logger.warn(`[chrome.notifications] ${message}`),
      }),
      {
        api: "notifications",
        check: (api) => gate.check(api),
        setLastError,
        onDenied: (method, error) =>
          reportDenied(`${method}: ${error.message}`, "notifications"),
      }
    ),
  };

  // Host -> frame delivery entry point (non-enumerable: not part of the
  // exposed chrome namespace). The preload wires it to RUNTIME_DELIVER IPC.
  Object.defineProperty(chrome, "handleDelivery", {
    value: handleDelivery,
    enumerable: false,
  });

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
