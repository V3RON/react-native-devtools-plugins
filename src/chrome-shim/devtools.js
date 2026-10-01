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

const EMPTY_HAR = JSON.stringify({
  log: { version: "1.2", creator: { name: "rozenite-shell" }, entries: [] },
});

const callAsync = (cb, ...args) => {
  if (typeof cb === "function") {
    setTimeout(() => cb(...args), 0);
  }
};

const createDevtools = ({
  extensionId,
  onPanelCreated = () => {},
  // chrome.devtools.inspectedWindow.eval: injected host dependency
  // (expression, options) => Promise<{value, exceptionInfo}>. Wired by the
  // extension-frame preload over the DEVTOOLS_EVAL IPC channel to
  // src/main/inspected-window.js; absent = honest isError, like Chrome's
  // "cannot access" answer rather than a silently empty success.
  evalInPage,
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
      getHAR: (cb) => callAsync(cb, EMPTY_HAR),
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
    // [STUB] Page.reload is not implemented by RN's inspector backend; reporting
    // success would be a lie, so this stays inert and documented.
    reload: () => {},
  };

  const network = {
    // [STUB until devtools.network rides the dispatch channel]
    // (docs/features/DEVTOOLS-NETWORK.md): events exist but never fire;
    // getHAR answers with an empty-but-valid HAR.
    onRequestFinished: createEvent(),
    onNavigated: createEvent(),
    getHAR: (cb) => callAsync(cb, EMPTY_HAR),
    getResponseBody: (request, cb) => callAsync(cb, null, ""),
  };

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
