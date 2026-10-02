// Single source of truth for IPC channel names shared between the main
// process and the preloads.
//
// House rule: new channels are async (`invoke`/`handle` or `send`/`on`).
// The only surviving sendSync channels are STORE/GET_INJECTED_SCRIPT, where
// synchronous semantics are required (the injected script must be installed
// before extension page scripts run — same reason Chrome injects sync).

module.exports = {
  /** (origin, script) -> stores the frontend-provided injected script. */
  STORE_INJECTED_SCRIPT: "store-injected-script",
  /** (origin) -> returns the stored injected script for that origin. */
  GET_INJECTED_SCRIPT: "get-injected-script",
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
  /** main -> frame push: {kind: message|connect|port-message|port-disconnect}. */
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
};
