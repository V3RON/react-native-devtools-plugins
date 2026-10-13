// BrowserWindow creation and window-level ops for the DevTools frontend.
//
// webPreferences come from ./frame-security — one documented place, because
// there is exactly one webPreferences object per WebContents and every extension
// page is an iframe inside THIS frame tree (src/frontend/panel-bridge.js creates
// them), so these settings are the frontend's and the extension frames' at the
// same time. Read that file before changing anything here.
const { BrowserWindow } = require("electron");
const config = require("./config");
const { frontendPreferences } = require("./frame-security");
const { setFrontendWebContents } = require("./dispatch");
const panelHost = require("./panel-host");
const { setFrontendContents, guardNavigation } = require("./frontend-frame");

let currentWindow = null;

const createWindow = () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: frontendPreferences({ preloadPath: config.preloadPath }),
  });

  win.loadURL(config.frontendURL);
  currentWindow = win;
  setFrontendWebContents(win.webContents);
  setFrontendContents(win.webContents); // who may call the frontend-only IPC channels
  guardNavigation(win.webContents); // ...and the frontend cannot be navigated away from its origin
  panelHost.attach(win.webContents); // shell-driven extensions (panel-bridge)

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
