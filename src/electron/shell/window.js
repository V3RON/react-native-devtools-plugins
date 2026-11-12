// BrowserWindow creation and window-level ops for the DevTools frontend.
//
// The window's webPreferences are the shell's own (its preload) passed through the
// extension host's `webPreferences(base)`, which lays the frame policy over them
// (src/electron/extensions/internal/contexts/frame-security.js). There is exactly one
// webPreferences object per WebContents and every extension page is an iframe inside
// THIS frame tree, so those settings are the frontend's and the extension frames' at
// the same time. Read that file before changing anything here.
const { BrowserWindow } = require("electron");
const config = require("./config");
const { setFrontendWebContents } = require("./dispatch");
const { windowOpenHandler } = require("./window-open-policy");
const { setFrontendContents, guardNavigation } = require("./frontend-frame");

let currentWindow = null;

/**
 * The shell's own preferences: its preload. The extension host lays the frame policy
 * over them (contextIsolation, no Node in page worlds, and sandbox off — which this
 * preload also needs, because it `require`s its siblings).
 */
const shellPreferences = () => ({ preload: config.preloadPath });

/** @param {object} extensionHost the extension host (src/electron/extensions/index.js) */
const createWindow = (extensionHost) => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: extensionHost.webPreferences(shellPreferences()),
  });

  win.webContents.setWindowOpenHandler(windowOpenHandler); // see the policy file

  currentWindow = win;
  setFrontendWebContents(win.webContents);
  setFrontendContents(win.webContents); // who may call the shell's frontend-only channels
  guardNavigation(win.webContents); // ...and the frontend cannot be navigated away from its origin
  extensionHost.attachWindow(win, config.frontendURL); // before loadURL
  win.loadURL(config.frontendURL);

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

module.exports = { createWindow, getCurrentWindow, bringToFront, closeWindow, shellPreferences };
