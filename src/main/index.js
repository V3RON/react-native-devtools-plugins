// Electron main-process entry point: bootstrap and lifecycle wiring only.
// State and services live in ./injected-scripts, ./ipc, ./extension-server.
const { app, BrowserWindow } = require("electron");
const { default: Store } = require("electron-store");
const { createWindow } = require("./window");
const { registerIpcHandlers } = require("./ipc");
const {
  registerExtensionSchemePrivileges,
  registerExtensionProtocol,
} = require("./extension-server");

Store.initRenderer();

registerExtensionSchemePrivileges();

app.whenReady().then(() => {
  registerIpcHandlers();
  registerExtensionProtocol();

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
