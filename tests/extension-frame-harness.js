// Electron main-process harness for tests/extension-frame-electron.test.js.
//
// Spawned as a child process (this file IS an Electron main, not a Node module):
//
//   electron tests/extension-frame-harness.js --extensions-dir=<dir>
//     --host-dir=<dir> --out=<ndjson file> --user-data-dir=<dir>
//     [--page=host.html] [--timeout=<ms>] [--wait-for=<console substring>]
//
// It is the smallest possible production-like shell: the PRODUCTION scheme
// privileges, file server and IPC handlers (src/main/extension-server.js,
// src/main/ipc.js), the PRODUCTION webPreferences
// (src/main/frame-security.js) and the PRODUCTION preload
// (src/preload/index.js -> extension-frame.js), with a loopback http:// page
// standing in for the DevTools frontend. The real frontend is Metro at
// 127.0.0.1:8081 and is not needed to assert any of this.
//
// `show: false`: headless — no visible window, no Metro, no device, no CDP
// bridge (DEVTOOLS_CDP_BRIDGE=off). Extension pages report through console.log,
// which the harness records; so do load failures, preload errors and the final
// frame tree. One NDJSON line per observation on --out, then exit.
const { app, BrowserWindow } = require("electron");
const { default: Store } = require("electron-store");
const fs = require("fs");
const path = require("path");
const http = require("http");

const arg = (name) => {
  const prefix = `--${name}=`;
  const found = process.argv.find((entry) => entry.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
};

const extensionsDir = arg("extensions-dir");
const hostDir = arg("host-dir");
const outFile = arg("out");
const TIMEOUT_MS = Number(arg("timeout") || 25000);
// A real extension folder (e.g. the shipped sample extension) reports through
// its own console output rather than the fixture's probe marker, so a run can
// wait for a log line instead.
const waitFor = arg("wait-for");
const SETTLE_MS = Number(arg("settle") || 900);

// Must precede requiring config: it captures DEVTOOLS_EXTENSIONS_DIR at module
// load and the file server resolves against it. Production code unchanged,
// pointed at the caller's extensions dir.
process.env.DEVTOOLS_EXTENSIONS_DIR = extensionsDir;
process.env.DEVTOOLS_CDP_BRIDGE = "off";

// Keep electron-store (and every other userData writer) inside the test tree.
const userDataDir = arg("user-data-dir");
if (userDataDir) {
  app.setPath("userData", userDataDir);
}

const production = require("../src/main/extension-server");
const { registerIpcHandlers } = require("../src/main/ipc");
const { frontendPreferences } = require("../src/main/frame-security");
const config = require("../src/main/config");

// Production privileges, once, before ready.
production.registerExtensionSchemePrivileges();

const MARKER = "__ROZENITE_PROBE__";

const write = (payload) => {
  fs.appendFileSync(outFile, `${JSON.stringify(payload)}\n`);
};

app
  .whenReady()
  .then(async () => {
    // The production IPC substrate, unchanged: a frame's first act is
    // RUNTIME_GET_MANIFEST / RUNTIME_REGISTER, so without these handlers there is
    // no extension frame to observe. Store.initRenderer is what
    // src/main/index.js does for electron-store's renderer adapter.
    Store.initRenderer();
    registerIpcHandlers();
    const policyFor = production.registerExtensionProtocol();

    // Loopback "frontend": an http:// page hosting the extension frames, which is
    // what src/frontend/panel-bridge.js does for real panels.
    const server = http.createServer((request, response) => {
      const inner = request.url.split("?")[0].replace(/^\/+/, "") || "host.html";
      const root = path.resolve(hostDir);
      const target = path.resolve(root, inner);
      if (target !== root && !target.startsWith(root + path.sep)) {
        response.writeHead(404);
        response.end("nope");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      fs.createReadStream(target).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: frontendPreferences({ preloadPath: config.preloadPath }),
    });

    const note = (entry) => write(entry);

    // Electron 38 reports console-message as
    // (event, level, message, line, sourceId); the event object also carries
    // `frame`, so both shapes are read defensively rather than assumed.
    win.webContents.on("console-message", (...args) => {
      const first = args[0];
      const details =
        first && typeof first === "object"
          ? { frameURL: first.frameURL, level: first.level, message: first.message || args[2] || "" }
          : { level: first, message: args[2] || "", frameURL: "" };
      const message = details.message || "";
      const url = details.frameURL || "";
      if (message.startsWith(MARKER)) {
        try {
          note({ kind: "probe", url, data: JSON.parse(message.slice(MARKER.length)) });
        } catch (error) {
          note({
            kind: "probe-unparseable",
            url,
            message: message.slice(0, 500),
            error: error.message,
          });
        }
        return;
      }
      note({ kind: "console", level: details.level, message: message.slice(0, 500), url });
    });
    win.webContents.on(
      "did-fail-load",
      (_e, errorCode, errorDescription, validatedURL, isMainFrame) =>
        note({ kind: "fail-load", errorCode, errorDescription, validatedURL, isMainFrame })
    );
    win.webContents.on("preload-error", (_e, preloadPath, error) =>
      note({ kind: "preload-error", preloadPath, message: error.message })
    );
    win.webContents.on("render-process-gone", (_e, details) =>
      note({ kind: "render-process-gone", reason: details.reason })
    );

    const frameDump = () => {
      try {
        const main = win.webContents.mainFrame;
        return [main, ...win.webContents.mainFrame.framesInSubtree].map((frame) => ({
          url: frame.url,
          processId: frame.processId,
          // Distinct renderer process = out-of-process frame. Recorded rather
          // than assumed: while sandbox is false this is all the isolation that
          // exists, so the docs have to describe exactly this and nothing more.
          separateProcess: frame.processId !== main.processId,
        }));
      } catch {
        return [];
      }
    };

    note({
      kind: "harness",
      port,
      page: arg("page") || "host.html",
      preferences: {
        ...frontendPreferences({ preloadPath: config.preloadPath }),
        preload: "<production preload>",
      },
      // What the production file server decides to serve for this extension id —
      // the same function the protocol callback uses.
      servedCsp: policyFor("probe.local"),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
    });

    await Promise.race([
      win
        .loadURL(`http://127.0.0.1:${port}/${arg("page") || "host.html"}`)
        .catch((error) => note({ kind: "load-rejected", message: error.message })),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);

    const readBack = () => {
      try {
        return fs
          .readFileSync(outFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    };
    // The fixture's probe reports its messaging result last; a real extension
    // page is waited on by log line. Either way the deadline is the backstop.
    const settled = () => {
      const lines = readBack();
      if (waitFor) {
        return lines.some(
          (line) => line.kind === "console" && String(line.message).includes(waitFor)
        );
      }
      return lines.some((line) => line.kind === "probe" && line.data && line.data.ports);
    };
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline && !settled()) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // Let any trailing report land.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    note({ kind: "frames", frames: frameDump() });
    server.close();
    app.exit(0);
  })
  .catch((error) => {
    write({ kind: "harness-error", message: error && error.message });
    app.exit(1);
  });
