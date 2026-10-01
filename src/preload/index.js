// Preload entry point: context dispatch only — no logic here.
//
//   rozenite: frames    -> ./extension-frame  (chrome.* shim)
//   main frame          -> ./frontend-host    (InspectorFrontendHost for the frontend)
//   anything else       -> nothing installed
//
// The protocol check comes FIRST, on purpose. An extension page is an extension
// page whether it is an iframe in the frontend or the main document of its own
// hidden window, and the shell hosts an extension's background context exactly
// that way: a `show: false` BrowserWindow whose MAIN frame is
// `rozenite://<id>/__rozenite_background__` (src/main/background-host.js,
// docs/features/BACKGROUND-WORKER.md). Ordering these the other way round hands
// that window the frontend's InspectorFrontendHost stub and no `chrome.*` at all.
const { EXTENSION_SCHEME } = require("../shared/protocol");

if (window.location.protocol === `${EXTENSION_SCHEME}:`) {
  require("./extension-frame");
} else if (process.isMainFrame) {
  require("./frontend-host");
}
