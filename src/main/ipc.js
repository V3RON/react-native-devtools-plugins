// IPC handler registration. Delegates state/services; no logic here.
const { ipcMain } = require("electron");
const injectedScripts = require("./injected-scripts");
const preferences = require("./preferences");
const windowOps = require("./window");
const { showContextMenu } = require("./context-menu");
const extensionServer = require("./extension-server");
const {
  STORE_INJECTED_SCRIPT,
  GET_INJECTED_SCRIPT,
  SHOW_CONTEXT_MENU,
  PREF_REGISTER,
  PREF_GET,
  PREF_GET_ALL,
  PREF_SET,
  PREF_REMOVE,
  PREF_CLEAR,
  WINDOW_BRING_TO_FRONT,
  WINDOW_CLOSE,
  RUNTIME_GET_MANIFEST,
} = require("../shared/ipc");

const registerIpcHandlers = () => {
  // Deliberate sendSync exception (see src/shared/ipc.js house rule):
  // the injected script must be installed before extension page scripts run.
  ipcMain.on(STORE_INJECTED_SCRIPT, (event, origin, script) => {
    injectedScripts.set(origin, script);
    event.returnValue = true;
  });

  ipcMain.on(GET_INJECTED_SCRIPT, (event, origin) => {
    event.returnValue = injectedScripts.get(origin);
  });

  // ── async channels (house rule: everything new goes through here) ──────

  ipcMain.handle(SHOW_CONTEXT_MENU, (_event, { x, y, items }) => {
    showContextMenu(windowOps.getCurrentWindow(), { x, y, items });
  });

  ipcMain.handle(PREF_REGISTER, (_event, name, options) => {
    preferences.register(name, options);
  });
  ipcMain.handle(PREF_GET, (_event, name) => preferences.get(name));
  ipcMain.handle(PREF_GET_ALL, () => preferences.getAll());
  ipcMain.handle(PREF_SET, (_event, name, value) => {
    preferences.set(name, value);
  });
  ipcMain.handle(PREF_REMOVE, (_event, name) => {
    preferences.remove(name);
  });
  ipcMain.handle(PREF_CLEAR, () => {
    preferences.clear();
  });

  ipcMain.handle(WINDOW_BRING_TO_FRONT, () => windowOps.bringToFront());
  ipcMain.handle(WINDOW_CLOSE, () => windowOps.closeWindow());

  // chrome.runtime.getManifest: the extension id is taken from the calling
  // frame's URL — never from message arguments (trust boundary).
  ipcMain.handle(RUNTIME_GET_MANIFEST, (event) => {
    try {
      const { hostname } = new URL(event.senderFrame.url);
      return extensionServer.loadManifest(hostname);
    } catch {
      return {};
    }
  });
};

module.exports = { registerIpcHandlers };
