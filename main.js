const {
  app,
  BrowserWindow,
  protocol,
  session,
  ipcMain,
  webContents,
} = require("electron/main");
const path = require("path");
const { default: Store } = require("electron-store");
Store.initRenderer();

// Store injected scripts by origin
const injectedScripts = new Map();

const createWindow = () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webSecurity: false, // Allow custom protocols in iframes
      allowRunningInsecureContent: true, // Allow custom protocol content
      nodeIntegrationInSubFrames: true,
      sandbox: false,
    },
  });

  win.webContents.openDevTools();
  win.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) {
      return;
    }

    console.log(event);
    event.frame.on("dom-ready", () => {
      event.frame.executeJavaScript("console.log('hello')");
    });
    // frame.executeJavaScript("document.body.innerHTML = 'elo'");
  });

  win.loadURL(
    "http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223"
  );
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "rozenite",
    privileges: { standard: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

app.whenReady().then(() => {
  // Handle storing injected scripts
  ipcMain.on("store-injected-script", (event, origin, script) => {
    console.log(`[Main] Storing injected script for origin: ${origin}`);
    injectedScripts.set(origin, script);
    event.returnValue = true;
  });

  ipcMain.on("get-injected-script", (event, origin) => {
    console.log(`[Main] Getting injected script for origin: ${origin}`);
    console.log(injectedScripts.get(origin));
    event.returnValue = injectedScripts.get(origin);
  });

  // Register the custom protocol handler
  protocol.registerFileProtocol("rozenite", (request, callback) => {
    console.log("[Protocol Handler] Received request:", request.url);

    // rozenite://<extension-id>/<path>
    const requestUrlParts = request.url.split("/");
    const extensionId = requestUrlParts[2];
    const innerPath = requestUrlParts.slice(3).join("/");

    console.log(
      "[Protocol Handler] Extension ID:",
      extensionId,
      "Inner Path:",
      innerPath
    );

    const filePath = path.join(__dirname, extensionId, innerPath);
    console.log(filePath);
    callback({ path: filePath });
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
