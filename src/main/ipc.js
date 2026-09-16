// IPC handler registration. Delegates state to services; no logic here.
const { ipcMain } = require("electron");
const injectedScripts = require("./injected-scripts");
const {
  STORE_INJECTED_SCRIPT,
  GET_INJECTED_SCRIPT,
} = require("../shared/ipc");

const registerIpcHandlers = () => {
  ipcMain.on(STORE_INJECTED_SCRIPT, (event, origin, script) => {
    injectedScripts.set(origin, script);
    event.returnValue = true;
  });

  ipcMain.on(GET_INJECTED_SCRIPT, (event, origin) => {
    event.returnValue = injectedScripts.get(origin);
  });
};

module.exports = { registerIpcHandlers };
