// Electron main-process entry point: bootstrap and lifecycle wiring only.
// State and services live in ./injected-scripts, ./ipc, ./extension-server,
// ./cdp-bridge.
const { app, BrowserWindow } = require("electron");
const { default: Store } = require("electron-store");
const { createWindow } = require("./window");
const { registerIpcHandlers } = require("./ipc");
const cdpBridge = require("./cdp-bridge");
const {
  registerExtensionSchemePrivileges,
  registerExtensionProtocol,
} = require("./extension-server");

Store.initRenderer();

registerExtensionSchemePrivileges();

app.whenReady().then(() => {
  registerIpcHandlers();
  registerExtensionProtocol();

  // Owns the RN debugger session before the frontend dials its `?ws=` socket.
  // Rejected only when the port is taken; the shell still runs and
  // inspectedWindow.eval reports isError instead of guessing
  // (docs/features/INSPECTED-WINDOW.md).
  cdpBridge.start().catch((error) => {
    console.error(
      `[cdp-bridge] listen failed: ${error.message} — stop the external relay ` +
        "(npm run rn-cdp / fake-cdp) or set DEVTOOLS_CDP_BRIDGE=off"
    );
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  cdpBridge.stop().catch(() => {});
});
