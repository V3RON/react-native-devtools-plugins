// The development shell's own IPC: the InspectorFrontendHost replacement
// (./frontend-host.js) and the window ops behind it. Not part of the extension host
// (src/electron/extensions/), which registers its own channels; not ported upstream
// (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md §4).
//
// `InspectorFrontendHost.save/append/close/openInNewTab/getHostConfig` are channels for
// the DevTools frontend's own main frame only (./frontend-frame.js: its WebContents, its
// main frame, still on the frontend origin). An extension page, a background window, a
// popup or a navigated-away frontend that reached these names is refused: identity is
// the sender, never anything in the payload.
const { ipcMain } = require("electron");
const windowOps = require("./window");
const { showContextMenu } = require("./context-menu");
const { getHostFiles } = require("./host-files");
const { buildHostConfig } = require("./host-config");
const { isFrontendFrame } = require("./frontend-frame");
const config = require("./config");
const {
  SHOW_CONTEXT_MENU,
  WINDOW_BRING_TO_FRONT,
  WINDOW_CLOSE,
  HOST_SAVE,
  HOST_APPEND,
  HOST_CLOSE_FILE,
  HOST_OPEN_EXTERNAL,
  HOST_CONFIG,
} = require("./channels");

let opener = null;
/**
 * `openInNewTab`: http(s) only. The allowlist and the launcher are the extension
 * host's (`electronExternalOpener`), built as the shell's own instance — the second
 * allowlisted reach into extensions/internal (tests/architecture-boundary.test.js).
 */
const externalOpener = () => {
  if (!opener) {
    const { electronExternalOpener } = require("../extensions/internal/services/external-open");
    opener = electronExternalOpener({ testOpenLog: config.testOpenLog });
  }
  return opener;
};

const registerShellIpcHandlers = () => {
  ipcMain.handle(SHOW_CONTEXT_MENU, (_event, { x, y, items }) => {
    showContextMenu(windowOps.getCurrentWindow(), { x, y, items });
  });

  ipcMain.handle(WINDOW_BRING_TO_FRONT, () => windowOps.bringToFront());
  ipcMain.handle(WINDOW_CLOSE, () => windowOps.closeWindow());

  const REFUSED = { ok: false, error: "not the DevTools frontend" };
  const failed = (error) => ({ ok: false, error: (error && error.message) || "the call failed" });

  // The frontend's file key (`url`) is echoed back verbatim on savedURL /
  // canceledSaveURL / appendedToURL: its FileManager matches the reply to the pending
  // promise by that exact string (./host-files.js). No extension gating (the frontend
  // is not an extension) and no filename suggestion (no extension to ask).
  ipcMain.handle(HOST_SAVE, (event, payload) =>
    isFrontendFrame(event) ? getHostFiles().save(payload).catch(failed) : REFUSED
  );
  ipcMain.handle(HOST_APPEND, (event, payload) =>
    isFrontendFrame(event) ? getHostFiles().append(payload).catch(failed) : REFUSED
  );
  ipcMain.handle(HOST_CLOSE_FILE, (event, payload) =>
    isFrontendFrame(event) ? getHostFiles().close(payload).catch(failed) : REFUSED
  );

  ipcMain.handle(HOST_OPEN_EXTERNAL, (event, payload) =>
    isFrontendFrame(event) ? externalOpener().open(payload && payload.url) : REFUSED
  );

  ipcMain.handle(HOST_CONFIG, (event) =>
    isFrontendFrame(event) ? buildHostConfig(config.hostConfigOverride) : {}
  );
};

module.exports = { registerShellIpcHandlers };
