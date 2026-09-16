// Single source of truth for IPC channel names shared between the main
// process and the preloads.
//
// All channels are currently `sendSync`-style request/reply (see
// docs/ROADMAP.md guardrails — migrating these to async IPC is planned).

module.exports = {
  /** (origin, script) -> stores the frontend-provided injected script. */
  STORE_INJECTED_SCRIPT: "store-injected-script",
  /** (origin) -> returns the stored injected script for that origin. */
  GET_INJECTED_SCRIPT: "get-injected-script",
  /** main-world event relay channel used by the extension-frame Events API. */
  EVENTS: "Events",
};
