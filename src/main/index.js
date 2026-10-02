// Electron main-process entry point: bootstrap and lifecycle wiring only.
// State and services live in ./ipc, ./extension-server, ./cdp-bridge,
// ./network-service, ./background-host.
const { app, BrowserWindow } = require("electron");
const { default: Store } = require("electron-store");
const { createWindow } = require("./window");
const { registerIpcHandlers, startContentBridge } = require("./ipc");
const cdpBridge = require("./cdp-bridge");
const {
  registerExtensionSchemePrivileges,
  registerExtensionProtocol,
} = require("./extension-server");
const { attachBackgroundHost, getBackgroundHost } = require("./background-host");

Store.initRenderer();

registerExtensionSchemePrivileges();

app.whenReady().then(() => {
  registerIpcHandlers();
  registerExtensionProtocol();

  // Owns the RN debugger session before the frontend dials its `?ws=` socket.
  // Rejected only when the port is taken; the shell still runs and
  // inspectedWindow.eval reports isError instead of guessing
  // (docs/features/INSPECTED-WINDOW.md).
  cdpBridge.start().catch((error) => {
    console.error(
      `[cdp-bridge] listen failed: ${error.message} — stop the external relay ` +
        "(npm run rn-cdp / fake-cdp) or set DEVTOOLS_CDP_BRIDGE=off"
    );
  });

  createWindow();

  // An extension's background context (docs/features/BACKGROUND-WORKER.md) after
  // the protocol it loads from and after the IPC handlers its preload calls —
  // but independent of the frontend window: in Chrome, closing DevTools does not
  // kill the worker, and here the worker does not live in the frontend's frame
  // tree either.
  attachBackgroundHost();

  // The content-script runner (docs/features/CONTENT-SCRIPTS.md, GitHub issue #5). It
  // is inert unless DEVTOOLS_CONTENT_SCRIPTS names an extension, and injecting a script
  // into the user's app is exactly the kind of thing that must not happen by surprise —
  // so this line normally only prints why nothing will be injected. It starts AFTER the
  // IPC handlers (its app context takes a seat in the messaging router they own).
  startContentBridge();

  app.on("activate", () => {
    if (userWindows().length === 0) {
      createWindow();
    }
  });
});

// Windows the user can actually see and close. A background worker window is
// `show: false`: nobody can close it, so it must not be the reason the shell
// stays alive after the last DevTools window is gone (docs/features/
// BACKGROUND-WORKER.md §App shutdown).
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

const userWindows = () => {
  const host = getBackgroundHost();
  return BrowserWindow.getAllWindows().filter(
    (win) => !(host && host.isWorkerWindow(win.id))
  );
};

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// `window-all-closed` alone is not enough here: with hidden worker windows still
// open it never fires, and the app would linger invisibly forever. So the same
// decision is made when the last *user* window closes. One place owns the rule,
// and it is the place that already owns `window-all-closed`.
app.on("browser-window-created", (_event, win) => {
  win.on("closed", () => {
    if (!quitting && process.platform !== "darwin" && userWindows().length === 0) {
      app.quit();
    }
  });
});

app.on("will-quit", () => {
  cdpBridge.stop().catch(() => {});
  const host = getBackgroundHost();
  if (host) {
    host.closeAll();
  }
});
