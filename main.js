const { app, BrowserWindow, protocol, ipcMain } = require("electron/main");
const path = require("path");
const { default: Store } = require("electron-store");
const config = require("./src/main/config");
const {
  EXTENSION_SCHEME,
  parseExtensionURL,
} = require("./src/shared/protocol");
const {
  STORE_INJECTED_SCRIPT,
  GET_INJECTED_SCRIPT,
} = require("./src/shared/ipc");

Store.initRenderer();

// Store injected scripts by origin
const injectedScripts = new Map();

const createWindow = () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: config.preloadPath,
      webSecurity: false, // Allow custom protocols in iframes
      allowRunningInsecureContent: true, // Allow custom protocol content
      nodeIntegrationInSubFrames: true,
      sandbox: false,
    },
  });

  win.loadURL(config.frontendURL);
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: EXTENSION_SCHEME,
    privileges: { standard: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

app.whenReady().then(() => {
  // Injected-script store (frontend -> host -> extension frames).
  ipcMain.on(STORE_INJECTED_SCRIPT, (event, origin, script) => {
    injectedScripts.set(origin, script);
    event.returnValue = true;
  });

  ipcMain.on(GET_INJECTED_SCRIPT, (event, origin) => {
    event.returnValue = injectedScripts.get(origin);
  });

  // Serve extension files: rozenite://<extension-id>/<path>
  protocol.registerFileProtocol(EXTENSION_SCHEME, (request, callback) => {
    const parsed = parseExtensionURL(request.url);
    if (!parsed) {
      callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
      return;
    }
    callback({
      path: path.join(config.extensionsDir, parsed.extensionId, parsed.innerPath),
    });
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
