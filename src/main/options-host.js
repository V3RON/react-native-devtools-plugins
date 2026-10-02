// `runtime.openOptionsPage()` — the manifest's `options_ui.page` in a real window
// (docs/features/SMALL-SHIMS.md, GitHub issue #4).
//
// Chrome's rule this copies: an extension with no `options_ui` has nothing to open, and
// Chrome reports that as a failure rather than doing nothing quietly. So the verdict is
// computed here, from the manifest ON DISK, and returned to the frame as {ok:false,
// error} — which the shim turns into `runtime.lastError`. A no-op that resolved would be
// the "worse than absent" case: the extension would proceed as if an options page had
// appeared.
//
// `open_in_tab` is honored in the only way this shell can: Chrome's in-tab meaning is
// "open it in a browser tab instead of a popup", and the closest honest equivalent here
// is a window either way. The difference that IS preserved is reported, not dropped —
// see `open()` below.
//
// The window is a normal window over `rozenite://<id>/<page>`, created with the SAME
// webPreferences every other extension frame gets (src/main/frame-security.js), so an
// options page is not a more privileged context than a panel or a worker. The path goes
// through the file server's own containment rules like any other extension URL.
const NO_PAGE = (extensionId) => ({
  ok: false,
  error:
    `Cannot open the options page: this extension (${extensionId}) does not declare ` +
    "options_ui in its manifest.json.",
});

/**
 * The manifest's options page path, or null. Pure: the same reading Chrome does,
 * including `options_ui` as a bare string (an older spelling still in the wild).
 */
const optionsPageOf = (manifest) => {
  const options = manifest && manifest.options_ui;
  if (typeof options === "string" && options) {
    return { page: options, openInTab: false };
  }
  if (options && typeof options === "object" && typeof options.page === "string" && options.page) {
    return { page: options.page, openInTab: options.open_in_tab === true };
  }
  return null;
};

/**
 * @param {object} deps
 * @param {(extensionId: string) => object} deps.readManifest the host's own read of the
 *        manifest on disk — never anything the frame sent
 * @param {(url: string, options: {title?: string}) => any} deps.openWindow opens a
 *        window for a rozenite:// URL and returns a handle
 * @param {(handle: any) => boolean} [deps.closeWindow]
 * @param {(extensionId: string, innerPath: string) => string} deps.buildUrl
 * @param {(message: string) => void} [deps.log]
 */
const createOptionsHost = ({
  readManifest,
  openWindow,
  closeWindow = null,
  buildUrl,
  log = () => {},
}) => {
  const open = new Map(); // extensionId -> handle

  const openOptionsPage = async (extensionId) => {
    let manifest = {};
    try {
      manifest = readManifest(extensionId) || {};
    } catch {
      manifest = {};
    }
    const options = optionsPageOf(manifest);
    if (!options) {
      return NO_PAGE(extensionId);
    }
    const url = buildUrl(extensionId, options.page);
    if (!url) {
      // The file server refused the path (outside the extension's folder, or a
      // reserved one). Say so rather than opening a window on a 404.
      return {
        ok: false,
        error: `Cannot open the options page: ${options.page} is not a file this extension serves.`,
      };
    }
    if (open.has(extensionId)) {
      // Chrome focuses the existing options page instead of opening a second one.
      log(`options_ui for ${extensionId} is already open; focusing it`);
    }
    const handle = await openWindow(url, {
      title: `${extensionId} options${options.openInTab ? " (manifest requests open_in_tab)" : ""}`,
    });
    if (handle === null || handle === undefined) {
      return { ok: false, error: `Could not open a window for ${url}.` };
    }
    open.set(extensionId, handle);
    return { ok: true, url, openInTab: options.openInTab };
  };

  return {
    openOptionsPage,
    pageOf: (extensionId) => {
      try {
        return optionsPageOf(readManifest(extensionId) || {});
      } catch {
        return null;
      }
    },
    closeAll: () => {
      for (const [extensionId, handle] of open) {
        try {
          if (closeWindow) {
            closeWindow(handle);
          }
        } catch {
          // Already gone.
        }
        open.delete(extensionId);
      }
    },
    list: () => [...open.keys()],
  };
};

// ── the Electron-backed singleton src/main/ipc.js installs ───────────────────
let instance;

const attachOptionsHost = (deps = {}) => {
  const { BrowserWindow } = require("electron");
  const config = require("./config");
  const { extensionFramePreferences } = require("./frame-security");
  const { buildExtensionURL } = require("../shared/protocol");
  const { createOptionsHost: build } = require("./options-host");

  instance = build({
    readManifest: deps.readManifest || require("./extension-server").loadManifest,
    buildUrl: (extensionId, innerPath) => {
      // Containment is the file server's call, same as every other extension URL:
      // a manifest that names `../../etc/passwd` gets no URL, not a window on a 404.
      const { resolveExtensionFile } = require("./extension-server");
      if (!resolveExtensionFile(extensionId, innerPath)) {
        return null;
      }
      return buildExtensionURL(extensionId, innerPath);
    },
    openWindow: (url) => {
      const win = new BrowserWindow({
        width: 800,
        height: 600,
        // The same policy a panel or a worker runs under — an options page is an
        // extension page, not a privileged one (src/main/frame-security.js).
        webPreferences: extensionFramePreferences({ preloadPath: config.preloadPath }),
      });
      win.loadURL(url).catch(() => {});
      return win.id;
    },
    closeWindow: (id) => {
      const win = BrowserWindow.getAllWindows().find((entry) => entry.id === id);
      if (win && !win.isDestroyed()) {
        win.close();
        return true;
      }
      return false;
    },
    ...deps,
  });
  return instance;
};

const getOptionsHost = () => instance || attachOptionsHost();

module.exports = { NO_PAGE, createOptionsHost, optionsPageOf, attachOptionsHost, getOptionsHost };
