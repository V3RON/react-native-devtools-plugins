// BrowserWindow creation and window-level ops for the DevTools frontend.
const { BrowserWindow } = require("electron");
const config = require("./config");
const { setFrontendWebContents } = require("./dispatch");

let currentWindow = null;

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
  currentWindow = win;
  setFrontendWebContents(win.webContents);

  win.on("closed", () => {
    if (currentWindow === win) {
      currentWindow = null;
    }
  });

  return win;
};

const getCurrentWindow = () => currentWindow;

const bringToFront = () => {
  if (currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.focus();
  }
};

const closeWindow = () => {
  if (currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.close();
  }
};

module.exports = { createWindow, getCurrentWindow, bringToFront, closeWindow };
