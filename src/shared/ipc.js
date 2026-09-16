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
  /** main-world event relay channel used by the extension-frame Events API. */
  EVENTS: "Events",

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
};
