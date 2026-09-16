// Extension-frame preload: runs inside every `rozenite://<extension-id>/...`
// iframe. Installs, in order (see docs/ARCHITECTURE.md):
//
//   1. the frontend-provided injected script for this origin — evaluated
//      before page scripts, defines chrome.devtools.* (the fork's channel);
//   2. the chrome.* shim (currently ../../chrome-runtime.js; extracted to
//      src/chrome-shim/ in step 4 of the refactoring);
//   3. the Events relay over the main-process IPC channel
//      ([FAKE] transport, until the real dispatch channel lands).
//
// SECURITY DEBT (docs/LIMITATIONS.md): exposing ipcRenderer raw and
// evaluating scripts via new Function gives extension frames full Node
// privileges. Must be replaced by a validated, per-extension IPC layer
// before the API surface grows further.

const { contextBridge, ipcRenderer } = require("electron");
const { getChromeNamespace } = require("../../chrome-runtime.js");
const { GET_INJECTED_SCRIPT, EVENTS } = require("../shared/ipc");

const extensionId = window.location.hostname; // id == hostname: load-bearing
const chrome = getChromeNamespace(extensionId);

// 1. Injected script for this origin (may not exist yet for some frames).
const script = ipcRenderer.sendSync(GET_INJECTED_SCRIPT, window.location.origin);
if (script) {
  contextBridge.executeInMainWorld({
    func: new Function(`${script}(0)`),
  });
}

// 2. chrome.* namespace.
contextBridge.exposeInMainWorld("chromeElectron", chrome);
contextBridge.executeInMainWorld({
  func: () => {
    window.chrome = {
      ...window.chrome,
      ...window.chromeElectron,
    };
  },
});

// 3. Security-debt exposure (see header) + Events relay.
contextBridge.exposeInMainWorld("ipcRenderer", ipcRenderer);
contextBridge.exposeInMainWorld(EVENTS, {
  addListener: (event, callback) => {
    ipcRenderer.on(EVENTS, (receivedEvent, data) => {
      if (event !== receivedEvent) {
        return;
      }

      callback(data);
    });
  },
  removeListener: (event, callback) => {
    ipcRenderer.removeListener(EVENTS, callback);
  },
});
