// BrowserWindow creation for the DevTools frontend.
const { BrowserWindow } = require("electron");
const config = require("./config");

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
  return win;
};

module.exports = { createWindow };
