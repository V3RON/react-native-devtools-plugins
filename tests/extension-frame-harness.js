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
// bridge (DEVTOOLS_CDP_BRIDGE=off) unless `--fake-rn-app=on`, which serves a fake
// inspected app inside this process and starts the PRODUCTION CDP bridge against
// it (tests/fake-rn-app.js) so the live network delivery path is observable.
// Extension pages report through console.log, which the harness records; so do
// load failures, preload errors and the final frame tree. One NDJSON line per
// observation on --out, then exit.
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
// Start the production background host too (src/main/background-host.js). Off by
// default so every pre-existing run of this harness is unchanged.
// Name the loopback page as THE frontend window (src/main/panel-host.js), so its
// main frame may send THEME_REPORT. Off by default: nothing else here has a frontend.
const registerDelayMs = Number(arg("register-delay-ms") || "0");
const frontendIsHost = ["on", "true", "1"].includes(arg("frontend-host"));
// Run the PRODUCTION panel bridge (src/frontend/panel-bridge.js) in the loopback page, via
// panelHost.attach — the page then plays the part of a frontend whose legacy.js is a fake
// (tests/panel-events-electron.test.js). Implies --frontend-host.
const panelBridge = ["on", "true", "1"].includes(arg("panel-bridge"));
const withBackgroundHost = ["on", "true", "1"].includes(arg("background-host"));
// Which extension id's CSP to report in the `harness` line.
const reportedExtensionId = arg("extension-id") || "probe.local";
// The chrome.notifications backend, chosen per run:
//   fake   (default) — RECORDS the show and raises nothing. No click, no close.
//   click            — records, then scripts a user who clicks and dismisses it, so a
//                      worker's notifications.onClicked can be observed end to end.
//   deny             — records AND fails every show: the "nothing was shown, so no id
//                      is named" path.
//   real             — Electron's own Notification. NO TEST USES IT: a suite that
//                      raises a real notification on the user's machine is not a suite.
// `fake` is the default so every pre-existing run of this harness stays unchanged.
const notifierMode = (arg("notifier") || "fake").toLowerCase();
// Compress the background context's alarm clock (src/main/config.js). 1 = real time.
const alarmClockScale = Number(arg("alarm-clock-scale") || "1");
// Where a save lands, and whether the save dialog and the download's fetch are real.
// A run that names a directory gets a save service whose dialog is auto-answered and
// whose fetch is canned — so a headless test can prove bytes reached a real file
// without raising a dialog on the developer's machine or depending on the network.
// Unset means the production save service: the real dialog and `~/Downloads`, which
// no test ever runs.
const downloadsDir = arg("downloads-dir");
// Whether `runtime.openOptionsPage` may create a window. The production host would
// open a VISIBLE one, and a suite that pops windows on the developer's machine is not
// a suite, so the default is `record`: the harness installs a recording opener and
// reports the URL each window was asked for. `real` additionally creates a HIDDEN
// window that loads the page through the production preload, which is the only way to
// observe that the options page really is an extension page with a working shim.
// Either way the manifest decision, the URL from the file server's containment rules,
// and the open-window tracking are the production host's own.
const optionsWindowMode = (arg("options-windows") || "record").toLowerCase();
// Run the PRODUCTION CDP bridge against a FAKE inspected app that this harness
// serves in its own process (tests/fake-rn-app.js). Off by default:
// every pre-existing run stays exactly as it was, with no debugger session.
// Both ports default to 0, which means "let the OS choose": the fake app binds an
// ephemeral port and reports it on the `harness` line, so a parallel run cannot
// collide and a developer's real Metro (8081) or bridge (9223) is never touched.
// Naming a port is for pointing a real frontend at a manual run, never for a suite.
const fakeRNApp = ["on", "true", "1"].includes(arg("fake-rn-app"));
const fakeMetroPort = Number(arg("metro-port") || 0);
const fakeCdpPort = Number(arg("cdp-port") || 0);
// Record every host->frame network push as main actually sends it, on the frame it
// is addressed to (`--observe-frame-sends=on`). Off by default: an extra NDJSON
// line per delivery per frame is noise for every run that is not studying the
// delivery path (tests/delivery-scope.test.js).
const observeFrameSends = ["on", "true", "1"].includes(arg("observe-frame-sends"));

// Must precede requiring config: it captures DEVTOOLS_EXTENSIONS_DIR at module
// load and the file server resolves against it. Production code unchanged,
// pointed at the caller's extensions dir.
process.env.DEVTOOLS_EXTENSIONS_DIR = extensionsDir;
// With a fake app to talk to, the bridge runs for real (src/main/index.js does the
// same); loopback only, so a headless run cannot open a port on the LAN and does
// not ask macOS's firewall about it.
process.env.DEVTOOLS_CDP_BRIDGE = fakeRNApp ? "on" : "off";
if (fakeRNApp) {
  process.env.DEVTOOLS_CDP_HOST = "127.0.0.1";
}
process.env.DEVTOOLS_ALARM_CLOCK_SCALE = String(alarmClockScale);

// Keep electron-store (and every other userData writer) inside the test tree.
const userDataDir = arg("user-data-dir");
if (userDataDir) {
  app.setPath("userData", userDataDir);
}

const production = require("../src/main/extension-server");
const { frontendPreferences, extensionFramePreferences } = require("../src/main/frame-security");
const config = require("../src/main/config");
const { createBackgroundHost } = require("../src/main/background-host");
const { createInstallState } = require("../src/main/install-state");
const notificationHost = require("../src/main/notification-host");
const saveService = require("../src/main/save-service");
const optionsHost = require("../src/main/options-host");
const { NETWORK_DELIVER } = require("../src/shared/ipc");

// Production privileges, once, before ready.
production.registerExtensionSchemePrivileges();

/**
 * The fake inspected app, the resolved CDP ports, and the modules that consume
 * them — required here rather than at the top of this file, and this is ordering
 * with a reason, not tidiness.
 *
 * `src/main/config` reads DEVTOOLS_METRO_PORT / DEVTOOLS_CDP_PORT once, at its own
 * module load, and normalises 0 to its defaults (8081 / 9223). A fake app that is
 * asked for an ephemeral port cannot have a number until its `listen` callback has
 * run, which is after that load — so the environment cannot carry it. The harness
 * therefore writes the two resolved values into the one object the bridge singleton
 * is built from (`config.cdpBridge`), which is exactly what the environment variable
 * would have done had the ordering allowed it.
 *
 * Requiring `src/main/ipc` is what loads `src/main/cdp-bridge` and constructs that
 * singleton, so nothing that can reach the bridge may be required before this
 * returns. Getting that wrong is loud, not silent: the bridge would dial Metro's
 * default port, never attach to the fake app, and any suite that depends on a
 * debugger session fails its own premise assertion.
 */
const loadCdpConsumers = async () => {
  let fakeApp = null;
  if (fakeRNApp) {
    const { startFakeRNApp } = require("./fake-rn-app");
    fakeApp = await startFakeRNApp({
      port: fakeMetroPort,
      intervalMs: Number(arg("fake-app-interval") || 500),
      note: (entry) => write(entry),
    });
    // The bridge dials the app, so it dials the port the app REPORTED — which is the
    // one it bound, whether the caller named it or let the OS pick.
    config.cdpBridge.metroPort = fakeApp.port;
  }
  if (fakeCdpPort) {
    config.cdpBridge.listenPort = fakeCdpPort;
  } else if (fakeRNApp) {
    // An ephemeral bind asked for, and `config` cannot carry a 0 through from the
    // environment (see above). 0 is what ws binds an unused port with.
    config.cdpBridge.listenPort = 0;
  }
  return {
    fakeApp,
    cdpBridge: require("../src/main/cdp-bridge"),
    registerIpcHandlers: require("../src/main/ipc").registerIpcHandlers,
  };
};

const MARKER = "__ROZENITE_PROBE__";

const write = (payload) => {
  fs.appendFileSync(outFile, `${JSON.stringify(payload)}\n`);
};

app
  .whenReady()
  .then(async () => {
    // First, because requiring src/main/ipc is what builds the CDP bridge singleton
    // from config (see loadCdpConsumers). Store.initRenderer is what
    // src/main/index.js does for electron-store's renderer adapter.
    const { fakeApp, cdpBridge, registerIpcHandlers } = await loadCdpConsumers();

    // The production IPC substrate, unchanged: a frame's first act is
    // RUNTIME_GET_MANIFEST / RUNTIME_REGISTER, so without these handlers there is
    // no extension frame to observe.
    Store.initRenderer();
    registerIpcHandlers();
    if (registerDelayMs > 0) {
      // Test-only: hold every RUNTIME_REGISTER reply back, so a page script that runs in
      // that window provably cannot have learned anything from it (tests/theme-electron.test.js).
      const { ipcMain } = require("electron");
      const { RUNTIME_REGISTER } = require("../src/shared/ipc");
      const original = ipcMain._invokeHandlers.get(RUNTIME_REGISTER);
      ipcMain.removeHandler(RUNTIME_REGISTER);
      ipcMain.handle(RUNTIME_REGISTER, async (event, ...rest) => {
        await new Promise((resolve) => setTimeout(resolve, registerDelayMs));
        return original(event, ...rest);
      });
    }

    // chrome.notifications: a RECORDING notifier, so this suite never raises a real
    // system notification (the rule the whole harness runs under). It behaves like
    // the platform: it records what was asked for, and then hands back the click and
    // close callbacks the OS would call — the test decides whether a click happens,
    // so `onClicked` firing in a worker is evidence about the DELIVERY path, not a
    // notification this process invented.
    //
    // `--notifier=deny` additionally makes every show FAIL, which is how the "nothing
    // was shown, so no id is named" path is observed. Electron's own notifier is
    // installed only by a run that asks for it with `--notifier=real`, and no test
    // does (asserted in tests/notifications-shim.test.js).
    if (notifierMode !== "real") {
      const deny = notifierMode === "deny";
      const scriptedUser = notifierMode === "click";
      const live = new Map();
      const fakeNotifier = async (notification, handlers) => {
        note({
          kind: "notification-show",
          id: notification.id,
          title: notification.title,
          message: notification.message,
          silent: notification.silent,
        });
        if (deny) {
          return "fake notifier refusing (test condition)";
        }
        live.set(notification.id, handlers);
        if (scriptedUser) {
          // The harness plays the user. The shell only ever forwards what this
          // backend calls, so a click observed in a worker is evidence about the
          // delivery path — never a click the shell invented.
          setTimeout(() => handlers.onClick(), 60);
          setTimeout(() => handlers.onClose(), 160);
        }
        return null;
      };
      fakeNotifier.hide = (id) => live.delete(id);
      notificationHost.attachNotificationHost({
        notifier: fakeNotifier,
        permissionLevel: () => "granted",
      });
    }

    // chrome.downloads / InspectorFrontendHost.save: the PRODUCTION save service with
    // two capabilities replaced. `showSaveDialog` is answered without a dialog (a
    // suite that raised a modal on the developer's screen could not finish), and
    // `fetchUrl` is canned, so a URL download needs no network. The filesystem is the
    // REAL one and the directory is the run's temp dir, which is what makes "the bytes
    // really landed" an observable rather than a claim.
    //
    // Without --downloads-dir the production service is not installed at all: it would
    // open Electron's dialog and write into ~/Downloads, and no run of this harness
    // does that.
    if (downloadsDir) {
      const bodyFor = (url) => `fake body for ${url}`;
      saveService.attachSaveService({
        showSaveDialog: async ({ defaultPath }) => {
          note({ kind: "save-dialog", defaultPath });
          // `--dialog=cancel` exercises the "user said no" path through the same code.
          return arg("dialog") === "cancel"
            ? { canceled: true }
            : { canceled: false, filePath: path.join(downloadsDir, path.basename(String(defaultPath))) };
        },
        fetchUrl: async (url) => {
          note({ kind: "save-fetch", url });
          return { buffer: Buffer.from(bodyFor(url)), contentType: "text/plain" };
        },
        // The REAL filesystem, into the run's temp dir, with each write recorded so a
        // test can tell "the service said complete" from "bytes reached a file".
        writeFile: async (target, data, options) => {
          await fs.promises.writeFile(target, data, options);
          note({
            kind: "save-write",
            path: target,
            name: path.basename(target),
            bytes: Buffer.byteLength(Buffer.isBuffer(data) ? data : String(data)),
          });
        },
        unlink: (target) =>
          fs.promises.unlink(target).then(() => note({ kind: "save-unlink", path: target })),
        downloadsDir: () => downloadsDir,
      });
    }

    // runtime.openOptionsPage: the PRODUCTION options host (it reads the manifest from
    // disk, builds the URL through the file server's containment rules, tracks what it
    // opened, and refuses an extension with no options_ui) with the window step
    // observed rather than assumed.
    //
    //   record (default) — the opener RECORDS the url it was handed, so a headless run
    //                      pops nothing on the developer's machine.
    //   real             — additionally creates a HIDDEN window that loads the page
    //                      through the production preload, which is the only way to
    //                      observe that the options page really is an extension page
    //                      with a working chrome.* shim, and reports its console.
    // Either way the manifest decision, the URL from the file server's containment
    // rules, and the open-window tracking are the production host's own.
    const openedOptions = [];
    optionsHost.attachOptionsHost({
      openWindow: (url) => {
        const record = { url, extensionId: (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return null;
          }
        })(), loaded: false };
        openedOptions.push(record);
        if (optionsWindowMode === "real") {
          const win = new BrowserWindow({
            show: false,
            width: 700,
            height: 500,
            webPreferences: extensionFramePreferences({ preloadPath: config.preloadPath }),
          });
          record.win = win;
          win.webContents.on("console-message", (...args) => {
            const first = args[0];
            const message =
              first && typeof first === "object"
                ? first.message || ""
                : args[2] || "";
            if (String(message).includes("OPTIONS:")) {
              record.loaded = true;
              note({ kind: "options-console", message: String(message).slice(0, 300), url: record.url });
            }
          });
          win.webContents.on("did-fail-load", (_e, code, description) =>
            note({ kind: "options-fail-load", code, description, url: record.url })
          );
          win.loadURL(url).catch(() => {});
        }
        note({ kind: "options-window", url, extensionId: record.extensionId, mode: optionsWindowMode });
        return record;
      },
      closeWindow: (handle) => {
        if (handle && handle.win && !handle.win.isDestroyed()) {
          handle.win.close();
          return true;
        }
        return false;
      },
    });

    const policyFor = production.registerExtensionProtocol();

    // The bridge sits in front of the fake app the same way src/main/index.js puts
    // it there: after the IPC handlers and the protocol. With this pair running, a
    // frame's network data arrives over a real debugger socket from an app that
    // keeps reporting traffic — which is what makes "the live push reached the
    // frame" observable at all (tests/delivery-scope.test.js).
    if (fakeApp) {
      await cdpBridge.start();
    }

    // The production background host, in the process that will actually hold it
    // (src/main/index.js does the same, after the protocol and the IPC handlers).
    // The install state is the real one, in userData — which is how a second run
    // with the same --user-data-dir sees an already-installed extension.
    const host = withBackgroundHost
      ? createBackgroundHost({
          installState: createInstallState(new Store({ name: "extension-installs" })),
          onWorkerConsole: (record) => note({ kind: "worker-console", ...record }),
          log: {
            log: (message) => note({ kind: "background-log", level: "log", message }),
            warn: (message) => note({ kind: "background-log", level: "warn", message }),
            error: (message) => note({ kind: "background-log", level: "error", message }),
          },
        })
      : null;

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
      // A file the page asks for that the fixture does not provide is a 404, not an
      // unhandled stream error (which would be an uncaught exception in main).
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": inner.endsWith(".js") ? "text/javascript" : "text/html",
      });
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

    // `--observe-frame-sends=on`: record every host->frame network push at the one
    // place main really puts it on the wire — the frame's own `send`. This exists
    // because a delivery the delivery-scope filter REJECTS is invisible from the
    // frame's side by construction (nothing arrives, and the reason for the nothing
    // is the filter's `false`), and invisible-from-everywhere is exactly how issue
    // #20 stayed hidden. Recording the passes lets a test name a drop: main pushed
    // this payload kind, some frames were sent it, THIS frame was not.
    //
    // The patch is on WebFrameMain's prototype, obtained from a frame this window
    // already has (Electron 38 does not export the class), and it holds for every
    // frame in every window: Electron hands out the same instance per frame, so one
    // wrapper sees all of them and `this.url` names the addressee.
    //
    // What the record can PROVE is bounded by where the patch is installed: after
    // cdpBridge.start() and after this frontend BrowserWindow exists. A push before
    // that moment is simply unrecorded, so "absent from the record" never by itself
    // means "the filter dropped it". Current tests are safe because a frame can only
    // push after it has subscribed, which is after installation, and because the
    // completed >= 2 precondition fails loudly if that ever stops holding.
    if (observeFrameSends) {
      const frameProto = Object.getPrototypeOf(win.webContents.mainFrame);
      const originalSend = frameProto.send;
      frameProto.send = function (channel, ...rest) {
        if (channel === NETWORK_DELIVER) {
          // The recorder must never touch the delivery path. `write` is a
          // synchronous fs append and can throw, and this call sits INSIDE main's
          // own `send`; an exception here would unwind into the caller's try/catch
          // (makeFrameSender's, say), which unregisters the frame on failure. A
          // harness I/O error would then look exactly like a lost delivery — the
          // opposite of what this recorder is for. Swallow it and let the real send
          // through; a broken record shows up as an incomplete record, not a
          // phantom bug.
          try {
            const payload = rest[0] && rest[0].payload;
            write({
              kind: "frame-send",
              channel,
              to: this.url,
              payloadKind: payload && payload.kind,
              requestId: payload && payload.record && payload.record.requestId,
            });
          } catch {
            // deliberately ignored: observation only
          }
        }
        return originalSend.apply(this, [channel, ...rest]);
      };
    }

    if (panelBridge || frontendIsHost) {
      // The shared rule also checks the main frame is still on the frontend ORIGIN
      // (src/main/frontend-frame.js), so the configured frontend URL is this loopback page's.
      config.frontendURL = `http://127.0.0.1:${port}/`;
      // AND the environment has to say it, not just main's config: the PRELOAD applies the
      // same identity rule to decide which surface this window gets, and a renderer reads it
      // from the environment (src/shared/frontend-identity.js — it cannot require
      // src/main/config.js). Setting only `config.frontendURL` would leave the renderer with
      // "no frontend declared" and install nothing here, which since F4 is the correct answer
      // to that question — so the page would have no host surface and this harness's
      // panel/theme pages would fail for a reason that has nothing to do with what they test.
      // Same variable src/main/config.js reads, and the same one
      // tests/frontend-host-harness.js already sets.
      process.env.DEVTOOLS_FRONTEND_URL = config.frontendURL;
      require("../src/main/frontend-frame").setFrontendContents(win.webContents);
    }
    if (panelBridge) {
      const { windowOpenHandler } = require("../src/main/window-open-policy");
      win.webContents.setWindowOpenHandler(windowOpenHandler);
      require("../src/main/panel-host").attach(win.webContents);
      app.on("browser-window-created", (_event, created) => {
        if (created !== win) {
          note({ kind: "window-created" });
        }
      });
    }

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
      // the same function the protocol handler uses.
      servedCsp: policyFor(reportedExtensionId),
      backgroundHost: Boolean(host),
      notifier: notifierMode,
      // Which save backend this run installed: "fake" means the dialog and the fetch
      // were answered by the harness and the files went to a temp dir. Asserted by the
      // tier-2 tests, because a run that silently used the real dialog would be a test
      // that interrupts a human.
      saveDialog: downloadsDir ? "fake" : "production",
      downloadsDir: downloadsDir || null,
      optionsWindows: optionsWindowMode,
      alarmClockScale,
      // Whether this run had a debugger session at all, and the two ports it holds.
      // Both are ports ACTUALLY BOUND, reported by the thing that bound them: a run
      // that asks for an unused port has no other way to learn the number, and a
      // number the parent guessed would not be the one anything had to dial. The
      // defaults this harness would otherwise inherit are Metro's 8081 and the port a
      // real frontend dials (9223), so reporting them lets a suite prove it never
      // grabbed either — attaching to a developer's own Metro would measure the wrong
      // app, and failing to bind would measure nothing.
      // `cdpListenPort` is null for a run that never started the bridge.
      fakeRNApp: Boolean(fakeApp),
      fakeAppPort: fakeApp ? fakeApp.port : null,
      cdpListenPort: fakeApp ? cdpBridge.listenPort() : null,
      frameSendsObserved: observeFrameSends,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
    });

    await Promise.race([
      win
        .loadURL(`http://127.0.0.1:${port}/${arg("page") || "host.html"}`)
        .catch((error) => note({ kind: "load-rejected", message: error.message })),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);

    // The background host starts AFTER the protocol and IPC handlers exist, which
    // is the same ordering src/main/index.js uses, and — deliberately — not
    // because the frontend window loaded: it does not depend on it.
    if (host) {
      host.attach();
    }

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
          (line) =>
            ["console", "worker-console", "background-log"].includes(line.kind) &&
            String(line.message).includes(waitFor)
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
    // What the fake inspected app ended up seeing (the CDP commands it was sent and
    // the requests it announced). The `harness` line is written before the page
    // loads, so the end-of-run state has to be recorded separately.
    if (fakeApp) {
      note({ kind: "fake-app", stats: fakeApp.stats() });
    }
    if (host) {
      note({ kind: "background-windows", windows: host.list() });
    }
    // What the production options host ended up with, as main knows it: one record per
    // window it was asked to open, and whether that window's page ever reported.
    note({
      kind: "options-windows",
      windows: openedOptions.map(({ url, extensionId, loaded }) => ({ url, extensionId, loaded })),
      tracked: optionsHost.getOptionsHost().list(),
    });
    server.close();
    // Close the things this harness opened BEFORE taking the process down. A bare
    // app.exit() is a clean kill, which the run tolerates — what it would cost is
    // the ability to tell a harness that released its sockets from one that leaked
    // them, and the two look identical from the parent's side. Bounded, because a
    // close that hangs must not turn a finished run into a timed-out one: the
    // evidence is already on disk at this point.
    await Promise.race([
      (async () => {
        if (fakeApp) {
          await fakeApp.close();
        }
        await cdpBridge.stop();
      })(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    app.exit(0);
  })
  .catch((error) => {
    write({
      kind: "harness-error",
      message: error && error.message,
      stack: error && error.stack ? String(error.stack).split("\n").slice(0, 8).join(" | ") : "",
    });
    app.exit(1);
  });
