// chrome.devtools namespace (docs/features/DEVTOOLS-PANELS.md).
//
// Chrome exposes chrome.devtools.* to every extension page that runs inside
// DevTools — devtools page AND panel pages alike — so the host installs this
// namespace in every extension frame, not only devtools pages.
//
// Shell-driven hosting (no frontend-fork knowledge): panels.create notifies
// the host (onPanelCreated), and the host registers a real tab in the
// frontend — the panel iframe then loads `rozenite://<id>/<pagePath>` like any
// other extension frame.
//
// Tier-1 slice: `create` is real; `inspectedWindow.eval` rides the host's CDP
// bridge; the rest are inert shapes per the stubbing rule of thumb
// (docs/OVERVIEW.md) — extensions feature-detect by calling.
const { createEvent } = require("./event");

// Stable synthetic inspectedWindow.tabId (Chrome's is a small positive int).
const tabIdFor = (extensionId) => {
  let hash = 0;
  for (let i = 0; i < extensionId.length; i++) {
    hash = (hash * 31 + extensionId.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 100000) + 1;
};

// Chrome's getHAR hands the HAR *log* object to the callback (`harLog.entries`);
// the spec's `{log: …}` wrapper is spelled the same way here so both styles of
// consumer find the same (empty) entries. This is the no-host-behind-it state, so
// a fresh copy is handed out per call: a consumer that mutates what it got must
// not empty the next answer.
const emptyHar = () => {
  const log = { version: "1.2", creator: { name: "rozenite-shell" }, entries: [] };
  return { ...log, log };
};

/** getHAR's no-host answer, with Chrome's callback/promise duality intact. */
const getEmptyHar = (optionsOrCallback, maybeCallback) => {
  const callback =
    typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  if (typeof callback === "function") {
    callAsync(callback, emptyHar());
    return undefined; // Chrome: callback style returns nothing
  }
  return Promise.resolve(emptyHar());
};

const callAsync = (cb, ...args) => {
  if (typeof cb === "function") {
    setTimeout(() => cb(...args), 0);
  }
};

const createDevtools = ({
  extensionId,
  onPanelCreated = () => {},
  // chrome.devtools.network: injected from the shared network bridge
  // (./network-bridge.js), because devtools.network and chrome.webRequest are two
  // views of ONE capture. Absent = the documented no-data shapes, never invented
  // traffic (docs/features/DEVTOOLS-NETWORK.md).
  networkApi,
  // chrome.devtools.inspectedWindow.eval: injected host dependency
  // (expression, options) => Promise<{value, exceptionInfo}>. Wired by the
  // extension-frame preload over the DEVTOOLS_EVAL IPC channel to
  // src/main/inspected-window.js; absent = honest isError, like Chrome's
  // "cannot access" answer rather than a silently empty success.
  evalInPage,
  // chrome.devtools.inspectedWindow.reload: injected host dependency
  // (options) => Promise<{ok, error?}>, mapped onto CDP Page.reload. Chrome's API
  // reports nothing, so a failed reload surfaces through `logger` instead.
  reloadInPage = () => Promise.resolve(),
  logger = console,
}) => {
  const createPanel = (title, pagePath) => ({
    onShown: createEvent(), // deviation: never fires until panel events land
    onHidden: createEvent(),
    setWidth: () => {},
    _title: title,
    _pagePath: pagePath,
  });

  const panels = {
    themeName: "dark", // deviation: static; frontend theme not wired yet
    themeChanged: createEvent(),
    create(title, iconPath, pagePath, cb) {
      const panel = createPanel(title, pagePath);
      onPanelCreated({ title, pagePath });
      if (typeof cb === "function") {
        callAsync(cb, panel);
        return undefined; // Chrome: callback style returns nothing
      }
      return Promise.resolve(panel); // promise style (MV3, no callback)
    },
    elements: {
      // [STUB] sidebar panes await inspectedWindow eval + element selection
      // (docs/features/DEVTOOLS-PANELS.md, INSPECTED-WINDOW.md).
      createSidebarPane(title, cb) {
        const pane = {
          title: title || "",
          setTitle: () => {},
          set: () => {},
          setObject: () => {},
          setExpression: () => {},
          onContextMenu: createEvent(),
        };
        callAsync(cb, pane);
        return pane;
      },
      openResource: () => {},
      inspectedObject: null,
      onCreateContextMenu: createEvent(),
    },
    sources: {
      openInFrontend: () => {},
      navigatorView: null,
      onCreateContextMenu: createEvent(),
    },
    network: {
      // Same model as chrome.devtools.network (docs/features/DEVTOOLS-NETWORK.md):
      // Chrome documents panels.network.getHAR as the same underlying HAR log.
      getHAR: (optionsOrCallback, maybeCallback) =>
        networkApi && typeof networkApi.getHAR === "function"
          ? networkApi.getHAR(optionsOrCallback, maybeCallback)
          : getEmptyHar(optionsOrCallback, maybeCallback),
    },
    performance: {
      onRecordingStarted: createEvent(),
      onRecordingStopped: createEvent(),
    },
    recorder: {
      onRecordingStateChanged: createEvent(),
    },
    openExtensionInDevtools: () => Promise.resolve(),
    // [STUB] jump-to-source; rides the future Sources integration.
    openResource: (resource, lineNumber, cb) => callAsync(cb),
  };

  const inspectedWindow = {
    tabId: tabIdFor(extensionId),
    // Chrome semantics: `eval(expression, options?, cb)` always answers with the
    // pair `[value, exceptionInfo]` — it never throws, never rejects, and never
    // touches runtime.lastError. Both argument overloads are real (a function in
    // the options slot *is* the callback), and the promise style is the
    // no-callback form.
    //
    // `frameURL`, `useContentScriptContext` and `scriptExecutionContext` are
    // accepted and ignored: RN has no frames and no isolated content-script
    // worlds — the app's global context is the only context (and RN aliases
    // `global.window = global`, which is what state-debugger extensions need).
    eval(expression, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      const run = async () => {
        if (typeof evalInPage !== "function") {
          return [
            undefined,
            {
              isError: true,
              isException: false,
              value: "inspectedWindow.eval has no CDP backend in this host",
            },
          ];
        }
        const { value, exceptionInfo } = await evalInPage(expression, options || {});
        return [value, exceptionInfo];
      };
      if (typeof cb === "function") {
        run().then(
          (pair) => cb(...pair),
          (error) =>
            cb(undefined, {
              isError: true,
              isException: false,
              value: String((error && error.message) || error),
            })
        );
        return undefined; // Chrome: callback style returns nothing
      }
      return run();
    },
    // [STUB] no DOM node model to select (docs/features/INSPECTED-WINDOW.md).
    getSelectedNode: (cb) => callAsync(cb, null),
    // [STUB] would map to Debugger.getScriptParsed (Tier 2, same doc).
    getResources: (cb) => callAsync(cb, []),
    // Chrome's `reload()` takes `{ignoreCache, injectedScript}` and returns
    // nothing. Mapped onto CDP `Page.reload`, which RN's backend implements
    // (HostAgent.cpp -> onReload), so this really reloads the JS bundle. Chrome's
    // API has no callback, so the only honest place to report a failed reload is
    // the frame's console — the one place an extension author is already looking.
    reload(options) {
      Promise.resolve(reloadInPage(options || {})).then((reply) => {
        if (reply && reply.ok === false) {
          logger.warn(`[devtools.inspectedWindow.reload] ${reply.error}`);
        }
      });
    },
  };

  // chrome.devtools.network — real, shared with chrome.webRequest. The API object
  // comes from ./network-bridge.js (same capture, one delivery channel); without a
  // host behind it, getHAR answers with an empty-but-valid HAR and the events stay
  // quiet, which is the documented no-data state
  // (docs/features/DEVTOOLS-NETWORK.md), never invented traffic.
  const NO_NETWORK = {
    onRequestFinished: createEvent(),
    onNavigated: createEvent(),
    getHAR: getEmptyHar,
    getNetworkStatus: (optionsOrCallback, maybeCallback) => {
      // The documented no-data state, in both of Chrome's call styles; a guess
      // about the backend would be worse than an honest "nothing is being observed".
      const status = {
        available: false,
        observing: false,
        enableState: "idle",
        reason: null,
        requests: 0,
      };
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      if (typeof callback === "function") {
        callAsync(callback, status);
        return undefined; // Chrome: callback style returns nothing
      }
      return Promise.resolve(status);
    },
    // No host, so no body: `null` content with no encoding, and a reason in the
    // console — the old stub answered with a hardcoded payload for every request.
    // Chrome's signature is (request, callback); a requestId string is accepted too.
    getResponseBody: (request, callback) => {
      const reason = "chrome.devtools.network has no network backend in this host";
      logger.warn(`[devtools.network] ${reason}`);
      if (typeof callback === "function") {
        callAsync(callback, null, null);
        return undefined;
      }
      return Promise.resolve({ content: null, encoding: null, reason });
    },
  };
  const network = { ...NO_NETWORK, ...(networkApi || {}) };

  return {
    namespace: {
      inspectedWindow,
      panels,
      network,
      commands: { onCommand: createEvent() },
      pages: {
        addSharedObject: () => {},
        removeSharedObject: () => {},
        onSharedObjectCleared: createEvent(),
      },
    },
  };
};

module.exports = { createDevtools, tabIdFor };
