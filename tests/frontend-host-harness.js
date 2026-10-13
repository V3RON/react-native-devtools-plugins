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
const { default: Store } = require("electron-store");
const fs = require("fs");
const http = require("http");

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
    await winB.webContents.executeJavaScript(`InspectorFrontendHost.openInNewTab("https://example.com/from-other-origin")`);
    await winB.webContents.executeJavaScript(`InspectorFrontendHost.save("evil.txt", "x", true, false)`);
    result.hostConfigB = await winB.webContents.executeJavaScript(`new Promise((r) => InspectorFrontendHost.getHostConfig(r))`);
    await sleep(500);
    winB.destroy();

    // 5a. a reload (the frontend's own "Reconnect DevTools") is same-origin and untouched
    await call(`location.reload()`);
    await sleep(800);
    result.reloaded = contents.getURL() === `${a.origin}/frontend.html` && (await got()).length === 0;

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

    // 6. chrome.tabs.create's external policy through the real attachTabHost wiring
    const tabs = attachTabHost({ policy: "external", bridgeStatus: () => ({ attached: false }) });
    result.tabsHttps = await tabs.open({ url: "https://example.com/from-tabs" });
    try {
      await tabs.open({ url: "file:///etc/passwd" });
      result.tabsFile = "resolved";
    } catch (error) {
      result.tabsFile = `rejected: ${error.message}`;
    }
  } catch (error) {
    result.harnessError = error && error.stack;
  }
  fs.writeFileSync(outFile, `${JSON.stringify({ kind: "result", ...result })}\n`);
  app.exit(0);
});
