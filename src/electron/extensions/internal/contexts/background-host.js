// Background host: the main-process half of an extension's background context
// (docs/features/BACKGROUND-WORKER.md, GitHub issue #3).
//
// Route chosen: ONE hidden BrowserWindow (`show: false`) per extension that
// declares a background, loading a synthesized bootstrap document from the
// extension's own origin
// (`rozenite://<id>/__rozenite_background__?script=<path>`). The window is not
// shown and has no UI: it exists to be a WebContents the extension-frame
// preload runs in, which is what gives the worker the SAME `chrome.*` shim, the
// same permission gate and the same messaging registration as any panel.
//
// Route NOT taken (and why): hosting the worker as another hidden iframe inside
// the frontend, the pattern src/frontend/panel-bridge.js uses for devtools
// pages. A background worker is not part of DevTools' UI lifecycle — closing
// DevTools in Chrome does not kill it — so that route would kill every worker on
// every frontend reload/restart, and the extension's state would go with it.
// The rejected route and that reload caveat are recorded in the feature doc.
//
// MV3 lifecycle semantics (idle eviction, event-driven wake) are deliberately
// skipped: this context is always-on, which is a superset of event-driven wake
// for a devtools host.
//
// Nothing here evaluates page logic: the worker's own script is what runs,
// served from its own extension origin under that extension's CSP.
const { BrowserWindow } = require("electron");
const config = require("./config");
const { scanBackgroundExtensions } = require("./extensions");
const { BACKGROUND_BOOTSTRAP_PATH, loadManifest } = require("./extension-server");
const { extensionFramePreferences } = require("./frame-security");
const { installReasonFor } = require("./install-state");
/**
 * The default observer source. Required lazily, inside attach(): `./ipc` pulls in
 * `./preferences`, which opens an electron-store at import time — that is fine in
 * the running shell but would make this module impossible to unit-test under bare
 * Node (docs/ARCHITECTURE.md keeps the host layer testable for exactly this).
 */
const defaultObserveFrame = () => require("./ipc").subscribeRouterFrames;

/**
 * The URL a worker window loads. `script` rides the query string but is resolved
 * through the file server's containment rules, never trusted from here: a crafted
 * path is refused with a 404 rather than served (src/main/extension-server.js).
 */
const backgroundURL = ({ extensionId, script, type }) =>
  `rozenite://${extensionId}/${BACKGROUND_BOOTSTRAP_PATH}?script=${encodeURIComponent(
    script
  )}&type=${type}`;

/**
 * Whether one registered router frame is an extension's background context: its
 * URL is that extension's reserved bootstrap path. The frame's identity is the
 * host's own `WebFrameMain` and its URL, both derived in main — a frame cannot
 * claim to be a background context by sending a message.
 */
const isBackgroundFrame = (frame) => {
  try {
    const url = new URL(frame.url);
    return (
      url.hostname === frame.extensionId &&
      url.pathname.replace(/^\/+/, "") === BACKGROUND_BOOTSTRAP_PATH
    );
  } catch {
    return false;
  }
};

/**
 * What to tell a background context about its extension's lifecycle, from what
 * the host remembers. Pure, so the rule is unit-tested without Electron.
 *
 * @param {object|null} stored remembered {version} for this id, or null
 * @param {string} version the manifest's version now
 * @returns {"install"|"update"|"startup"|null} the reason to deliver, or null
 */
const lifecycleFor = (stored, version) => {
  const change = installReasonFor(stored, version);
  if (change) {
    return change; // install | update — the event the extension has been waiting for
  }
  // Nothing new happened: Chrome fires onStartup once per browser launch for
  // already-installed extensions, so this host fires it once per launch too —
  // the "once" is the caller's `lifecycleDone` set, not this function's business.
  return "startup";
};

// Electron 38 reports console-message as (event, level, message, …) where
// `event.level` is a NAME ("error"/"warning"/"log"/"info"/"debug"), while older
// shapes pass a NUMBER. Both are read here rather than assumed, because a level
// that silently normalizes to "log" is how a worker's uncaught error stops being
// reportable — measured, not guessed.
const LEVELS = { debug: 0, info: 1, log: 1, warning: 2, warn: 2, error: 3 };
const consoleRecord = (args) => {
  const first = args[0];
  const isObject = first && typeof first === "object";
  const raw = isObject ? first.level : first;
  const name =
    typeof raw === "string"
      ? raw.toLowerCase()
      : Object.keys(LEVELS).find((key) => LEVELS[key] === raw) || "log";
  const message = (isObject ? first.message : args[2]) || "";
  return { level: name, value: LEVELS[name] === undefined ? 1 : LEVELS[name], message };
};

/**
 * @param {object} deps
 * @param {() => object[]} [deps.scan] background-extension discovery
 * @param {(options: object) => object} [deps.createWindow] BrowserWindow factory
 * @param {object} [deps.installState] src/main/install-state instance
 * @param {(frame: object) => (delivery) => void} [deps.observeFrame] called for each
 *        router frame the host sees; returns the listener for that frame
 * @param {(extensionId: string) => object} [deps.readManifest] the host's own read
 *        of the manifest on disk (version is what install/update compares)
 * @param {(record: {extensionId: string, level: number, message: string}) => void} [deps.onWorkerConsole]
 *        raw worker console records, bypassing the log prefixing
 * @param {object} [deps.log]
 */
const createBackgroundHost = ({
  scan = scanBackgroundExtensions,
  createWindow = null,
  installState,
  observeFrame = defaultObserveFrame(),
  readManifest = loadManifest,
  onWorkerConsole = null,
  log = console,
} = {}) => {
  const windows = new Map(); // extensionId -> {win, url, script, reported}
  // One lifecycle delivery per extension per host launch, whatever the frame does
  // afterwards (reload, crash). Repeating `install` on a reload would be a
  // fabrication: nothing was installed.
  const lifecycleDone = new Set();

  const line = (message) => log.warn(`[background] ${message}`);

  /** The options every worker window is created with. `show: false` is the route. */
  const windowOptions = (entry) => ({
    show: false,
    width: 800,
    height: 600,
    // The same table every other extension frame runs on (that split exists
    // for exactly this): production preload, context isolation, no Node
    // surface, webSecurity on.
    webPreferences: extensionFramePreferences({ preloadPath: config.preloadPath }),
    title: `Background: ${entry.name}`,
  });

  const makeWindow = (entry) => {
    const options = windowOptions(entry);
    const win = createWindow ? createWindow(options, entry) : new BrowserWindow(options);
    // A worker that dies must be reported, never swallowed: these three events
    // are the only way the failure is visible at all, because there is no window
    // to look at.
    win.webContents.on("did-fail-load", (_e, code, description, failedURL) => {
      line(`${entry.extensionId}: load failed (${code} ${description}) ${failedURL}`);
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      line(`${entry.extensionId}: renderer gone (${details.reason})`);
    });
    win.webContents.on("unresponsive", () => {
      line(`${entry.extensionId}: renderer unresponsive`);
    });
    // The worker's console is its only stdout. Everything it logs is relayed with
    // the extension id in front of it, and errors/warnings are elevated. A caller
    // that wants the raw records (the headless harness) gets them verbatim.
    win.webContents.on("console-message", (...args) => {
      const record = consoleRecord(args);
      if (onWorkerConsole) {
        onWorkerConsole({
          extensionId: entry.extensionId,
          level: record.level,
          value: record.value,
          message: record.message,
        });
        return;
      }
      const text = `[${entry.extensionId}] ${record.message}`;
      if (record.value >= 3) log.error(text);
      else if (record.value === 2) log.warn(text);
      else log.log(text);
    });
    return win;
  };

  /** Start (or restart) every declared background context. Returns the entries. */
  const start = () => {
    let found = [];
    try {
      found = scan() || [];
    } catch (error) {
      line(`scan failed: ${error.message}`);
      return [];
    }
    for (const entry of found) {
      if (windows.has(entry.extensionId)) {
        continue;
      }
      let win;
      try {
        win = makeWindow(entry);
      } catch (error) {
        line(`${entry.extensionId}: could not create the hidden window: ${error.message}`);
        continue;
      }
      windows.set(entry.extensionId, { win, entry, url: backgroundURL(entry) });
      win.loadURL(backgroundURL(entry)).catch((error) => {
        // did-fail-load already reported it; this keeps the rejection from
        // escaping as an unhandled error inside the main process.
        line(`${entry.extensionId}: loadURL rejected: ${error.message}`);
      });
      win.on("closed", () => windows.delete(entry.extensionId));
    }
    return found;
  };

  /**
   * A router frame appeared: if it is a background context, tell it about its
   * extension's lifecycle. Delivered through the ordinary RUNTIME_DELIVER path of
   * the frame that registered — the same `send` closure the message router uses,
   * so there is no privileged channel to the worker.
   */
  const onFrameRegistered = (frame) => {
    if (!isBackgroundFrame(frame)) {
      return;
    }
    const { extensionId } = frame;
    if (!installState || lifecycleDone.has(extensionId)) {
      return;
    }
    lifecycleDone.add(extensionId);
    let manifest = {};
    try {
      // The host's own read of the manifest on disk, never anything the frame sent.
      manifest = readManifest(extensionId) || {};
    } catch {
      manifest = {};
    }
    const version = manifest.version || "";
    const stored = installState.get(extensionId);
    const previousVersion = stored && stored.version !== undefined ? String(stored.version) : null;
    const reason = lifecycleFor(stored, version);
    installState.record(extensionId, version);
    if (!reason) {
      return;
    }
    frame.send({
      kind: "lifecycle",
      payload: { reason, version, previousVersion },
    });
  };

  /** Every worker window, for the callers that own app shutdown. */
  const list = () =>
    [...windows.entries()].map(([extensionId, { win, url }]) => ({
      extensionId,
      url,
      id: win.id,
      visible: win.isVisible(),
    }));

  /**
   * Is this BrowserWindow one of the shell's background worker windows? The
   * question exists because `window-all-closed` counts them: a hidden worker is
   * not a window the user can close, so it must not be what keeps the app alive
   * (src/main/window.js → appApplicationWindows).
   */
  const isWorkerWindow = (windowId) =>
    [...windows.values()].some(({ win }) => win.id === windowId);

  /** Close all worker windows (app shutdown). */
  const closeAll = () => {
    for (const { win } of windows.values()) {
      try {
        if (!win.isDestroyed()) {
          win.destroy();
        }
      } catch {
        // already gone
      }
    }
    windows.clear();
  };

  const attach = () => {
    // Registered BEFORE the windows load: the frames arrive during load, and a
    // listener attached afterwards would miss the very event it exists for.
    observeFrame(onFrameRegistered);
    return start();
  };

  return {
    attach,
    start,
    closeAll,
    list,
    isWorkerWindow,
    onFrameRegistered,
    backgroundURL,
    lifecycleFor,
  };
};

// The one process-wide host the shell owns (src/main/index.js wires it after the
// extension protocol exists; the test harness wires its own).
let instance;
const attachBackgroundHost = (deps = {}) => {
  const host = createBackgroundHost({
    installState: deps.installState || require("./install-state").openInstallState(),
    ...deps,
  });
  instance = host;
  host.attach();
  if (host.list().length > 0) {
    console.log(
      `[background] ${host.list().length} background context(s) running: ` +
        host
          .list()
          .map((entry) => entry.extensionId)
          .join(", ")
    );
  }
  return host;
};

const getBackgroundHost = () => instance;

module.exports = {
  attachBackgroundHost,
  createBackgroundHost,
  getBackgroundHost,
  isBackgroundFrame,
  lifecycleFor,
  backgroundURL,
};

