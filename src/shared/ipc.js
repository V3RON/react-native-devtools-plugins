// Single source of truth for IPC channel names shared between the main
// process and the preloads.
//
// House rule (unconditional): every channel is async
// (`ipcMain.handle` + `ipcRenderer.invoke`). There are no `sendSync` channels
// left — the last two (`STORE_/GET_INJECTED_SCRIPT`, which let the frontend
// hand an arbitrary script to extension frames) were deleted together with the
// `new Function` that evaluated them: `chrome.devtools.*` is implemented
// shell-side (src/chrome-shim/devtools.js), so the fork's injected-script
// channel has no consumer (docs/features/DEVTOOLS-PANELS.md).

module.exports = {
  // ── dispatch channel (docs/features/DISPATCH-CHANNEL.md) ────────────────
  /** main -> main-frame preload -> window.InspectorFrontendAPI[name](...args) */
  HOST_EVENT: "host-event",
  /** ({x, y, items}) -> native context menu; selection dispatched back. */
  SHOW_CONTEXT_MENU: "show-context-menu",

  // ── frontend preferences (docs/api/INSPECTOR-FRONTEND-HOST.md) ──────────
  PREF_REGISTER: "pref-register",
  PREF_GET: "pref-get",
  PREF_GET_ALL: "pref-get-all",
  PREF_SET: "pref-set",
  PREF_REMOVE: "pref-remove",
  PREF_CLEAR: "pref-clear",

  // ── window ops ───────────────────────────────────────────────────────────
  WINDOW_BRING_TO_FRONT: "window-bring-to-front",
  WINDOW_CLOSE: "window-close",
  /** ({url, content, forceSaveAs, isBase64}) -> `InspectorFrontendHost.save` over
   *  the shell's one save path (src/main/save-service.js). The frontend used to
   *  click a synthetic `<a download>` at a `blob:` URL, which told nobody whether
   *  anything was written; now it is the same service `chrome.downloads` uses. */
  HOST_SAVE: "host-save",

  // ── chrome.runtime (docs/features/RUNTIME-MESSAGING.md) ──────────────────
  /** () -> manifest of the calling frame's extension (id from frame URL). */
  RUNTIME_GET_MANIFEST: "runtime-get-manifest",
  /** () -> registers the calling frame with the message router (identity
   *  taken from the frame itself, never from message args). */
  RUNTIME_REGISTER: "runtime-register",
  /** ({message}) -> host-relayed sendMessage; resolves {response}. */
  RUNTIME_SEND_MESSAGE: "runtime-send-message",
  /** ({messageId, response}) -> completes one delivery leg. */
  RUNTIME_SEND_RESPONSE: "runtime-send-response",
  /** ({name}) -> host-relayed Port connect; resolves {ok, portId}|{ok,error}. */
  RUNTIME_CONNECT: "runtime-connect",
  /** ({portId, message}) -> Port postMessage relay. */
  RUNTIME_PORT_POST: "runtime-port-post",
  /** ({portId}) -> Port close relay. */
  RUNTIME_PORT_CLOSE: "runtime-port-close",
  /** main -> frame push: {kind: lifecycle|message|connect|port-message|port-disconnect}. */
  RUNTIME_DELIVER: "runtime-deliver",

  // ── shell-driven extension hosting (docs/features/DEVTOOLS-PANELS.md) ────
  /** ({title, pagePath}) from a devtools frame -> registers a frontend panel. */
  EXT_PANEL_CREATE: "ext-panel-create",

  // ── inspected window (docs/features/INSPECTED-WINDOW.md) ──────────────────
  /** ({expression, options}) from an extension frame -> Chrome's
   *  [value, exceptionInfo] pair, answered from the CDP bridge. */
  DEVTOOLS_EVAL: "devtools-eval",

  /** ({options}) from an extension frame -> CDP Page.reload on the bridge. */
  DEVTOOLS_RELOAD: "devtools-reload",

  // ── devtools.network / webRequest (docs/features/DEVTOOLS-NETWORK.md) ──────
  /** () -> registers the calling frame as a network subscriber and returns the
   *  host's current {available, reason, …} status (identity from the frame). */
  NETWORK_SUBSCRIBE: "network-subscribe",
  /** ({options}) -> the real HAR 1.2 log built from the CDP network model. */
  NETWORK_GET_HAR: "network-get-har",
  /** () -> honest "is there network data at all, and if not why" status. */
  NETWORK_GET_STATUS: "network-get-status",
  /** ({requestId}) -> lazy Network.getResponseBody: {available, body, base64Encoded}. */
  NETWORK_GET_BODY: "network-get-body",
  /** main -> frame push: one request lifecycle step, or a navigated/status note. */
  NETWORK_DELIVER: "network-deliver",

  // ── chrome.tabs (docs/features/SMALL-SHIMS.md) ──────────────────────────────
  /** () -> what the host knows about the inspected target {attached, url, title}.
   *  Gated on the frame's `tabs` grant, like the API itself. */
  TABS_TARGET_INFO: "tabs-target-info",
  /** ({url, windowId, active}) -> the shell's open policy applied to one URL;
   *  resolves {via, handle} and is gated on the frame's `tabs` grant. */
  TABS_OPEN: "tabs-open",
  /** ({handle}) -> closes a window THIS host opened for a created tab. */
  TABS_CLOSE: "tabs-close",
  /** ({message}) -> delivers to the content script of the CALLING extension running in
   *  the inspected target, and waits for its answer (issue #5 gave the API a receiver).
   *  Gated on the frame's `tabs` grant; the target is always this frame's OWN extension's
   *  app context, so a payload can never name another extension's script. */
  TABS_SEND_TO_APP: "tabs-send-to-app",

  // ── chrome.notifications (docs/features/SMALL-SHIMS.md) ──────────────────────
  /** ({id, title, message, silent}) -> show one system notification for the calling
   *  context. Main records the caller's OWN frame key as the owner, so a later click
   *  is delivered to that context alone. Gated on the `notifications` grant in main. */
  NOTIFICATION_SHOW: "notification-show",
  /** ({id}) -> clear one this host showed for the calling context. */
  NOTIFICATION_CLEAR: "notification-clear",
  /** () -> the permission level this host can actually observe. */
  NOTIFICATION_PERMISSION: "notification-permission",

  // ── chrome.downloads + chrome.runtime.openOptionsPage (SMALL-SHIMS.md) ──────
  // Every one of these is gated on the frame's own `downloads` grant, in the
  // shape Chrome itself has: `downloads` covers creating a download AND the
  // History API over the ones that exist (`downloads.erase`/`search` read the
  // same history Chrome gates behind the same permission).
  /** ({options, initiator}) -> save one URL; resolves {id} or {error}. */
  DOWNLOAD_START: "download-start",
  /** ({downloadId}) -> cancel a running download this host owns. */
  DOWNLOAD_CANCEL: "download-cancel",
  /** ({query}) -> erase finished downloads from the host's ledger. */
  DOWNLOAD_ERASE: "download-erase",
  /** ({query}) -> the tasks in the ledger matching the query. */
  DOWNLOAD_SEARCH: "download-search",
  /** ({requestId, filename}) -> an extension context answering one filename
   *  suggestion request. Resolves {suggestion, error} — the host's fallback. */
  DOWNLOAD_SUGGEST_REPLY: "download-suggest-reply",
  /** () -> open this extension's `options_ui.page` in a window of its own.
   *  Gated on `options` only where Chrome gates it, which is not at all: the
   *  manifest decides, so an extension without `options_ui` gets lastError. */
  OPTIONS_OPEN: "options-open",
};
