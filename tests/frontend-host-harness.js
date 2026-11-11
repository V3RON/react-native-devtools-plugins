// Electron main-process harness for tests/frontend-host-electron.test.js (this file IS an
// Electron main, spawned as a child):
//
//   electron tests/frontend-host-harness.js --out=<ndjson> --user-data-dir=<dir>
//
// The PRODUCTION IPC handlers, webPreferences, preload, dispatch channel, frontend-frame
// check and tab host, with two loopback http:// origins standing in for "the frontend"
// (A) and "somewhere else" (B). It drives every case itself and writes ONE `result` line.
// The caller sets DEVTOOLS_TEST_OPEN_LOG / DEVTOOLS_TEST_SAVE_DIALOG, so nothing opens a
// browser or raises a dialog.
const { app, BrowserWindow, ipcMain } = require("electron");
const { default: Store } = require("electron-store");
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  PREF_SET,
  PREF_GET_ALL,
  PREF_CLEAR,
  WINDOW_CLOSE,
  HOST_CONFIG,
} = require("../src/shared/ipc");

const arg = (name) => {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : "";
};
const outFile = arg("out");
const userDataDir = arg("user-data-dir");
if (userDataDir) app.setPath("userData", userDataDir);
process.env.DEVTOOLS_CDP_BRIDGE = "off";

// A page that records every InspectorFrontendAPI event it is sent, with a child iframe.
const page = (child) =>
  `<!doctype html><title>t</title><script>
    window.__got = [];
    window.InspectorFrontendAPI = new Proxy({}, { get: (_t, name) => (...args) => window.__got.push([name, ...args]) });
  </script>${child ? '<iframe src="/child.html"></iframe>' : ""}`;

const serve = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url.startsWith("/child") ? "<!doctype html><title>c</title>" : page(true));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const result = {};
  try {
    const a = await serve();
    const b = await serve();
    process.env.DEVTOOLS_FRONTEND_URL = `${a.origin}/frontend.html`;

    // Required AFTER the env is set: config captures it at load.
    const { registerIpcHandlers } = require("../src/main/ipc");
    const { frontendPreferences } = require("../src/main/frame-security");
    const config = require("../src/main/config");
    const { setFrontendWebContents, dispatchToFrontend } = require("../src/main/dispatch");
    const frame = require("../src/main/frontend-frame");
    const { attachTabHost } = require("../src/main/tab-host");
    Store.initRenderer();
    registerIpcHandlers();

    const open = () =>
      new BrowserWindow({ show: false, webPreferences: frontendPreferences({ preloadPath: config.preloadPath }) });
    const winA = open();
    const contents = winA.webContents;
    frame.setFrontendContents(contents);
    setFrontendWebContents(contents);
    frame.guardNavigation(contents);
    await contents.loadURL(`${a.origin}/frontend.html`);
    await sleep(500);
    const got = () => contents.executeJavaScript("window.__got");
    const call = (code) => contents.executeJavaScript(code);

    // 1. the dispatch channel carries its arguments
    dispatchToFrontend("savedURL", ["u", "p"]);
    await sleep(300);
    result.dispatched = await got();

    // 2. the frontend's main frame is accepted: open, save, config
    await call(`InspectorFrontendHost.openInNewTab("https://example.com/from-frontend")`);
    await call(`InspectorFrontendHost.openInNewTab("file:///etc/passwd")`);
    await call(`InspectorFrontendHost.save("f.txt", "hello", false, false)`);
    await sleep(800);
    result.afterSave = await got();
    result.hostConfigA = await call(`new Promise((r) => InspectorFrontendHost.getHostConfig(r))`);

    // 3. a child iframe of the frontend: real frame object, same WebContents
    const child = contents.mainFrame.frames[0];
    result.childFrameFound = Boolean(child);
    result.childAccepted = frame.isFrontendFrame({ sender: contents, senderFrame: child });
    result.mainAccepted = frame.isFrontendFrame({ sender: contents, senderFrame: contents.mainFrame });
    result.nullFrameAccepted = frame.isFrontendFrame({ sender: contents, senderFrame: null });
    result.noEventAccepted = frame.isFrontendFrame(undefined);

    // 4. a main frame on a DIFFERENT origin with the same preload (a popup, a stray window)
    const winB = open();
    await winB.webContents.loadURL(`${b.origin}/other.html`);
    await sleep(500);
    // F4, live: this is the shape a navigated-away extension window has — a main frame, the
    // production preload, not the frontend's origin. The preload used to read that as "is the
    // frontend" and install the host surface here; it now installs nothing. Called through
    // `window.…` guards because after the fix there is no object to call: an unguarded call
    // throws, and the point of the case is the absence, not an exception in the harness.
    result.surfaceOnOtherOrigin = await winB.webContents.executeJavaScript(
      `[typeof window.InspectorFrontendHostElectron, typeof window.chromeElectron]`
    );
    await winB.webContents.executeJavaScript(
      `window.InspectorFrontendHostElectron && InspectorFrontendHost.openInNewTab("https://example.com/from-other-origin")`
    );
    await winB.webContents.executeJavaScript(
      `window.InspectorFrontendHostElectron && InspectorFrontendHost.save("evil.txt", "x", true, false)`
    );
    result.hostConfigB = await winB.webContents.executeJavaScript(
      `window.InspectorFrontendHostElectron ? new Promise((r) => InspectorFrontendHost.getHostConfig(r)) : "no surface"`
    );
    await sleep(500);
    winB.destroy();

    // 4b. the nine channels, at the channel boundary, in this real process: the same
    // registered handlers the renderer's `invoke` reaches (ipcMain._invokeHandlers is the map
    // ipcMain.handle fills, and this harness already leans on that map for --register-delay-ms),
    // driven with events whose sender/senderFrame are REAL objects from REAL windows — the
    // frontend's and a stranger's. The store is the production one, in this run's temp
    // userData, so "refused" means the file on disk did not change.
    //
    // Why the event is built here instead of invoked from a page: after the fix, a
    // non-frontend frame has NO surface from which to call these channels at all (case 4
    // above), so the only way to exercise the gate is main's own side of the real IPC
    // registry. The refusal then has two independent proofs, which is the defense in depth F4
    // asks for: the surface is gone, and the channel would still refuse it.
    const handlers = ipcMain._invokeHandlers;
    const prefsFile = path.join(app.getPath("userData"), "frontend-preferences.json");
    const readStore = () => (fs.existsSync(prefsFile) ? fs.readFileSync(prefsFile, "utf8") : "");
    const storeUnchanged = (before) => readStore() === before;
    const frameEvent = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
    const stranger = open();
    await stranger.webContents.loadURL(`${b.origin}/other.html`);
    await sleep(300);
    const beforeStranger = readStore();
    const strangerEvent = frameEvent(stranger);
    const strangerResults = {
      set: handlers.get(PREF_SET)(strangerEvent, "f4Stolen", "written-by-a-stranger"),
      getAll: handlers.get(PREF_GET_ALL)(strangerEvent),
      clear: handlers.get(PREF_CLEAR)(strangerEvent),
      // The already-gated channel as a control, in the same shape: it refused a stranger
      // before this fix too, so it is the reference for what "refused" looks like here.
      hostConfig: handlers.get(HOST_CONFIG)(strangerEvent),
    };
    // An iframe of the frontend is another refusal: same WebContents, not the main frame.
    const childFrame = contents.mainFrame.frames[0];
    const childRefused =
      Boolean(childFrame) &&
      handlers.get(PREF_SET)({ sender: contents, senderFrame: childFrame }, "f4StolenChild", "no");
    await sleep(200);
    result.strangerRefused = {
      ...strangerResults,
      childFrame: childRefused,
      // The store is what makes "refused" an observation rather than a return value.
      storeUnchanged: storeUnchanged(beforeStranger),
      storeText: readStore(),
    };
    // And the frontend's own main frame still gets through — the same call, the same
    // handlers, the frame that is allowed. Without this the refusals above would only prove
    // the handlers are broken.
    const beforeFrontend = readStore();
    result.frontendAccepted = {
      set: handlers.get(PREF_SET)(frameEvent(winA), "f4Mine", "written-by-the-frontend"),
      storeChanged: readStore() !== beforeFrontend,
    };
    await sleep(200);
    result.frontendStoreText = readStore();
    result.frontendSurface = await winA.webContents.executeJavaScript(
      `typeof window.InspectorFrontendHostElectron`
    );
    // `stranger` stays open until case 7: a destroyed WebContents would be refused for the
    // wrong reason there (`isMainFrameOf` checks liveness first), which is not the fact that
    // case is about.

    // 5a. a reload (the frontend's own "Reconnect DevTools") is same-origin and untouched
    await call(`location.reload()`);
    await sleep(800);
    result.reloaded = contents.getURL() === `${a.origin}/frontend.html` && (await got()).length === 0;

    // 5. the frontend window top-navigates away: the guard denies it...
    await call(`location.href = ${JSON.stringify(`${b.origin}/other.html`)}`);
    await sleep(800);
    result.urlAfterNavigationAttempt = contents.getURL();
    // ...and if a navigation gets past the guard anyway (programmatic loadURL does not fire
    // will-navigate), two things remain. The origin check in main is one. The other is new
    // with F4: the navigated document no longer gets the frontend's host surface at all, so
    // the page has nothing to call — which is why these calls are guarded rather than direct.
    await contents.loadURL(`${b.origin}/other.html`);
    await sleep(500);
    result.originAfterLoad = new URL(contents.getURL()).origin === b.origin;
    result.movedMainAccepted = frame.isFrontendFrame({ sender: contents, senderFrame: contents.mainFrame });
    result.surfaceAfterLoad = await call(`typeof window.InspectorFrontendHostElectron`);
    await call(
      `window.InspectorFrontendHostElectron && InspectorFrontendHost.openInNewTab("https://example.com/from-navigated-away")`
    );
    await call(
      `window.InspectorFrontendHostElectron && InspectorFrontendHost.save("moved.txt", "x", true, false)`
    );
    await sleep(800);

    // 6. chrome.tabs.create's policies through the real attachTabHost wiring: both
    //    agree about what is openable, and both refuse the same way (F6).
    const tabs = attachTabHost({ policy: "external", bridgeStatus: () => ({ attached: false }) });
    result.tabsHttps = await tabs.open({ url: "https://example.com/from-tabs" });
    try {
      await tabs.open({ url: "file:///etc/passwd" });
      result.tabsFile = "resolved";
    } catch (error) {
      result.tabsFile = `rejected: ${error.message}`;
    }

    // The `window` policy's side of the same contract. `openWindow` is the harness's
    // recorder rather than a real BrowserWindow — the same `record` seam this repo's
    // options-window harness uses, so a headless run pops nothing. What is production is
    // attachTabHost's own composition and the filter inside open(): a filter that did not
    // run would hand the recorder the file: URL and land in the catch below.
    //
    // This is the SECOND attachTabHost call, so it replaces the module singleton the first one
    // installed: from here to the end of the process, getTabHost() answers with the
    // recorder-backed host. That is deliberate and safe only because nothing runs after this
    // block — the two `open` pairs below are the harness's last act, and no channel handler
    // asks for the tab host again afterwards. A future case that needs the production wiring
    // has to go above this point, or restore the singleton (there is no setter to restore it
    // with, which is why the comment is cheaper than the capture).
    const loaded = [];
    const win = attachTabHost({
      policy: "window",
      bridgeStatus: () => ({ attached: false }),
      openWindow: (url) => {
        loaded.push(url);
        return loaded.length;
      },
    });
    result.windowHttps = await win.open({ url: "https://example.com/from-tabs" });
    // This shell's own scheme is allowed by this branch, which is what lets a create of a
    // relative path — the form Altair uses — still open. The id is not scoped to the caller
    // (see src/main/tab-host.js's note on that).
    result.windowRozenite = await win.open({ url: "rozenite://probe.local/index.html" });
    try {
      await win.open({ url: "file:///etc/passwd" });
      result.windowFile = "resolved";
    } catch (error) {
      result.windowFile = `rejected: ${error.message}`;
    }
    result.windowLoaded = loaded;

    // 7. WINDOW_CLOSE last of all the stranger calls, because before the fix it is the one
    //    that really does something: it closes the frontend window. Placed here so a pre-fix
    //    run reaches every assertion above first; a refusal means the window is still here.
    result.strangerClose = handlers.get(WINDOW_CLOSE)(frameEvent(stranger));
    result.frontendWindowAlive = !winA.isDestroyed();
  } catch (error) {
    result.harnessError = error && error.stack;
  }
  fs.writeFileSync(outFile, `${JSON.stringify({ kind: "result", ...result })}\n`);
  app.exit(0);
});
