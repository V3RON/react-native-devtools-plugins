// The development shell's preload (webPreferences.preload of the frontend window):
// the InspectorFrontendHost replacement, in the frontend's main frame only.
//
// It runs in the extension iframes too (the window sets nodeIntegrationInSubFrames for
// the extension host), so the main-frame check is what keeps it out of them. The
// extension preload is not loaded from here: the extension host registers its own on
// the session (src/electron/extensions/).
if (process.isMainFrame) {
  require("./frontend-host");
}
