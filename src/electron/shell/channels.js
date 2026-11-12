// IPC channel names of this repository's development shell: the InspectorFrontendHost
// replacement (src/electron/shell/frontend-host.js) and the window ops behind it. Not
// part of the extension host (src/electron/extensions/), and not ported upstream
// (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md §4). Same house rule as the extension
// channels: every channel is async (`ipcMain.handle` + `ipcRenderer.invoke`), except
// HOST_EVENT, which main sends.
module.exports = {
  // ── dispatch channel (docs/features/DISPATCH-CHANNEL.md) ────────────────
  /** main -> main-frame preload -> window.InspectorFrontendAPI[name](...args) */
  HOST_EVENT: "host-event",
  /** ({x, y, items}) -> native context menu; selection dispatched back. */
  SHOW_CONTEXT_MENU: "show-context-menu",

  // ── window ops ───────────────────────────────────────────────────────────
  WINDOW_BRING_TO_FRONT: "window-bring-to-front",
  WINDOW_CLOSE: "window-close",
  /** ({url, content, forceSaveAs, isBase64}) -> `InspectorFrontendHost.save` over
   *  the shell's one save path (src/electron/extensions/internal/services/save-service.js). The frontend used to
   *  click a synthetic `<a download>` at a `blob:` URL, which told nobody whether
   *  anything was written; now it is the same service `chrome.downloads` uses. */
  HOST_SAVE: "host-save",
  /** ({url, content}) -> `InspectorFrontendHost.append` to the file a prior save of
   *  `url` chose; replies via `appendedToURL` on the dispatch channel. */
  HOST_APPEND: "host-append",
  /** ({url}) -> `InspectorFrontendHost.close`: forget the handle a save of `url` made. */
  HOST_CLOSE_FILE: "host-close-file",
  /** ({url}) -> `InspectorFrontendHost.openInNewTab` through the scheme allowlist. */
  HOST_OPEN_EXTERNAL: "host-open-external",
  /** () -> the host config object `InspectorFrontendHost.getHostConfig` returns. */
  HOST_CONFIG: "host-config",
};
