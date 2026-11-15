// The extension preload's entry point: context dispatch only — no logic here.
//
// Registered on the host's session (`session.registerPreloadScript`, ExtensionHost.js),
// so it runs in every frame of every window on that session, BEFORE the embedder's own
// `webPreferences.preload`:
//
//   <scheme>: frames  -> ./extension-frame   (chrome.* shim)
//   other main frame  -> ./frontend-bridge   (__RN_DEVTOOLS_EXTENSIONS__ for the panel bridge)
//   anything else     -> nothing installed
//
// The protocol check comes FIRST, on purpose. An extension page is an extension
// page whether it is an iframe in the frontend or the main document of its own
// hidden window, and the host runs an extension's background context exactly
// that way: a `show: false` BrowserWindow whose MAIN frame is
// `rozenite://<id>/__rozenite_background__` (background-host.js,
// docs/features/BACKGROUND-WORKER.md). Ordering these the other way round hands
// that window the frontend bridge and no `chrome.*` at all.
//
// The frontend bridge is installed in any non-extension main frame because a preload
// cannot know which page is the attached frontend; main accepts its two calls only
// from the attached window's main frame on the frontend's origin (frontend-frame.js).
const { EXTENSION_SCHEME } = require("../scheme/protocol");

if (window.location.protocol === `${EXTENSION_SCHEME}:`) {
  require("./extension-frame");
} else if (process.isMainFrame) {
  require("./frontend-bridge");
}
