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
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");

const arg = (name) => {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : "";
};
const outFile = arg("out");
const userDataDir = arg("user-data-dir");
if (userDataDir) app.setPath("userData", userDataDir);

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
    // The development shell's own half: its IPC, its preload, its frontend guard. The
    // extension host is not involved — these channels are the shell's InspectorFrontendHost.
    const { registerShellIpcHandlers } = require("../src/electron/shell/ipc");
    const { frontendPreferences } = require("../src/electron/extensions/internal/contexts/frame-security");
    const config = require("../src/electron/shell/config");
    const { shellPreferences } = require("../src/electron/shell/window");
    const { setFrontendWebContents, dispatchToFrontend } = require("../src/electron/shell/dispatch");
    const frame = require("../src/electron/shell/frontend-frame");
    const { attachTabHost } = require("../src/electron/extensions/internal/services/tab-host");
    const { electronExternalOpener } = require("../src/electron/extensions/internal/services/external-open");
    registerShellIpcHandlers();

    const open = () =>
      new BrowserWindow({ show: false, webPreferences: frontendPreferences(shellPreferences()) });
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

    // 2b. preferences live in the page's own localStorage — the stock
    //     InspectorFrontendHostStub's store, so the upstream shell reads the same one
    const getPref = (run, name) =>
      run(`new Promise((r) => InspectorFrontendHost.getPreference(${JSON.stringify(name)}, (v) => r(v ?? null)))`);
    await call(`InspectorFrontendHost.setPreference("probe-pref", "v1")`);
    result.prefGet = await getPref(call, "probe-pref");
    result.prefInLocalStorage = await call(`localStorage.getItem("probe-pref")`);
    // Only the probe's entry is read back: the stub's `for…in` over localStorage also
    // enumerates Storage's own methods, which cannot cross executeJavaScript's clone.
    result.prefAll = await call(
      `new Promise((r) => InspectorFrontendHost.getPreferences((all) => r(all["probe-pref"] ?? null)))`
    );
    await call(`InspectorFrontendHost.setPreference("probe-removed", "x")`);
    await call(`InspectorFrontendHost.removePreference("probe-removed")`);
    result.prefRemoved = await call(`localStorage.getItem("probe-removed")`);

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
    await winB.webContents.executeJavaScript(`InspectorFrontendHost.openInNewTab("https://example.com/from-other-origin")`);
    await winB.webContents.executeJavaScript(`InspectorFrontendHost.save("evil.txt", "x", true, false)`);
    result.hostConfigB = await winB.webContents.executeJavaScript(`new Promise((r) => InspectorFrontendHost.getHostConfig(r))`);
    // localStorage is per origin: another origin does not see the frontend's settings
    result.prefOtherOrigin = await getPref((code) => winB.webContents.executeJavaScript(code), "probe-pref");
    await sleep(500);
    winB.destroy();

    // 5a. a reload (the frontend's own "Reconnect DevTools") is same-origin and untouched
    await call(`location.reload()`);
    await sleep(800);
    result.reloaded = contents.getURL() === `${a.origin}/frontend.html` && (await got()).length === 0;
    result.prefAfterReload = await getPref(call, "probe-pref");
    await call(`InspectorFrontendHost.clearPreferences()`);
    result.storageAfterClear = await call(`localStorage.length`);

    // 5. the frontend window top-navigates away: the guard denies it...
    await call(`location.href = ${JSON.stringify(`${b.origin}/other.html`)}`);
    await sleep(800);
    result.urlAfterNavigationAttempt = contents.getURL();
    // ...and if a navigation gets past the guard anyway (programmatic loadURL does not fire
    // will-navigate), the origin check is what is left.
    await contents.loadURL(`${b.origin}/other.html`);
    await sleep(500);
    result.originAfterLoad = new URL(contents.getURL()).origin === b.origin;
    result.movedMainAccepted = frame.isFrontendFrame({ sender: contents, senderFrame: contents.mainFrame });
    await call(`InspectorFrontendHost.openInNewTab("https://example.com/from-navigated-away")`);
    await call(`InspectorFrontendHost.save("moved.txt", "x", true, false)`);
    await sleep(800);

    // 6. chrome.tabs.create's policies through the real attachTabHost wiring: both
    //    agree about what is openable, and both refuse the same way (F6).
    const noSession = { status: () => ({ attached: false }), sendCommand: async () => ({}) };
    const externalOpener = electronExternalOpener({ testOpenLog: config.testOpenLog });
    const tabs = attachTabHost({ policy: "external", cdp: noSession, externalOpener });
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
    // run would hand the recorder the file: URL and land in the catch below. Each
    // attachTabHost call builds its own host, so this one replaces nothing.
    const loaded = [];
    const win = attachTabHost({
      policy: "window",
      cdp: noSession,
      externalOpener,
      openWindow: (url) => {
        loaded.push(url);
        return loaded.length;
      },
    });
    result.windowHttps = await win.open({ url: "https://example.com/from-tabs" });
    // This shell's own scheme is allowed by this branch, which is what lets a create of a
    // relative path — the form Altair uses — still open. The id is not scoped to the caller
    // (see src/electron/extensions/internal/services/tab-host.js's note on that).
    result.windowRozenite = await win.open({ url: "rozenite://probe.local/index.html" });
    try {
      await win.open({ url: "file:///etc/passwd" });
      result.windowFile = "resolved";
    } catch (error) {
      result.windowFile = `rejected: ${error.message}`;
    }
    result.windowLoaded = loaded;
  } catch (error) {
    result.harnessError = error && error.stack;
  }
  fs.writeFileSync(outFile, `${JSON.stringify({ kind: "result", ...result })}\n`);
  app.exit(0);
});
