// The frontend half of the extension preload: the two calls the panel bridge
// (../frontend/panel-bridge.js) makes, and nothing else. It does not touch
// InspectorFrontendHost — that is the embedding shell's (upstream's
// `reactNativeDecorateInspectorFrontendHostInstance` keeps working unchanged).
//
// main accepts each call only from the attached window's main frame, still on the
// frontend's origin (../frontend/frontend-frame.js): a page that is not the frontend
// can call these and is refused.
const { contextBridge, ipcRenderer } = require("electron");
const { THEME_REPORT, EXT_PANEL_VISIBILITY } = require("../broker/channels");

contextBridge.exposeInMainWorld("__RN_DEVTOOLS_EXTENSIONS__", {
  // The frontend's theme (chrome.devtools.panels.themeName / onThemeChanged).
  reportTheme: (themeName) =>
    ipcRenderer.invoke(THEME_REPORT, { themeName }).catch(() => {}),
  // An extension panel's tab was selected / deselected: main turns it into
  // Panel.onShown / onHidden for the devtools page that created the panel.
  reportPanelVisible: (panelId, shown) =>
    ipcRenderer
      .invoke(EXT_PANEL_VISIBILITY, { panelId: String(panelId), shown: shown === true })
      .catch(() => {}),
});
