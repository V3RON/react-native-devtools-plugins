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
// Tier-1 slice: `create` is real; the rest are inert shapes per the stubbing
// rule of thumb (docs/OVERVIEW.md) — extensions feature-detect by calling.
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

const createDevtools = ({ extensionId, onPanelCreated = () => {} }) => {
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
    // [DEGRADED] no CDP Runtime.evaluate bridge yet — honest isError
    // (docs/features/INSPECTED-WINDOW.md).
    eval(expression, options, cb) {
      if (typeof options === "function") {
        cb = options;
      }
      const failure = [
        undefined,
        { isError: true, value: "inspectedWindow.eval is not supported by this host" },
      ];
      if (typeof cb === "function") {
        callAsync(cb, ...failure);
        return undefined;
      }
      return Promise.resolve(failure);
    },
    getSelectedNode: (cb) => callAsync(cb, null),
    getResources: (cb) => callAsync(cb, []),
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
