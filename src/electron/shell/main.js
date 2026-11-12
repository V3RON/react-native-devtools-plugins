// The development shell's Electron entry point: bootstrap and lifecycle wiring only.
//
// It stands in for upstream's @react-native/debugger-shell (index.flow.js +
// MainInstanceEntryPoint.js) and reaches the extension host through its public API
// only (src/electron/extensions/index.js), at the same call sites the spec gives
// upstream (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md §5.2). Everything else here — the
// InspectorFrontendHost replacement, its IPC, the env config — is this repository's
// development shell and is not ported.
const { app, BrowserWindow } = require("electron");
const { registerExtensionSchemes, createExtensionHost } = require("../extensions");
const config = require("./config");
const { createWindow } = require("./window");
const { registerShellIpcHandlers } = require("./ipc");

// Before 'ready': the scheme's privileges can only be registered now.
registerExtensionSchemes();

let extensionHost = null;

app.whenReady().then(() => {
  registerShellIpcHandlers();
  extensionHost = createExtensionHost(config.extensionHostConfig());
  createWindow(extensionHost);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(extensionHost);
    }
  });
});

// Background contexts are hidden windows of the attached frontend window and close
// with it (the extension host detaches on the window's `closed`), so the last visible
// window closing is the last window closing.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  if (extensionHost) {
    extensionHost.dispose().catch(() => {});
  }
});
