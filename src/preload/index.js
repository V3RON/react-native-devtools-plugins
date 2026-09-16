// Preload entry point: context dispatch only — no logic here.
//
//   main frame          -> ./frontend-host    (InspectorFrontendHost for the frontend)
//   rozenite: iframes   -> ./extension-frame  (chrome.* shim + injected script install)
//   anything else       -> nothing installed
const { EXTENSION_SCHEME } = require("../shared/protocol");

if (process.isMainFrame) {
  require("./frontend-host");
} else if (window.location.protocol === `${EXTENSION_SCHEME}:`) {
  require("./extension-frame");
}
