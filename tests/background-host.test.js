// Background lifecycle decisions, without Electron: what the host remembers about
// extension versions (src/main/install-state.js) and which `chrome.runtime` event
// that implies for a background context (src/main/background-host.js).
//
// The reason these are unit-tested rather than only observed headlessly is that
// the difference between `install`, `update` and `startup` is a pure function of
// stored state — and getting it wrong means an extension either never sees its
// onInstalled or sees it on every launch (GitHub issue #3).
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  createInstallState,
  installReasonFor,
} = require("../src/main/install-state");
const {
  createBackgroundHost,
  isBackgroundFrame,
  lifecycleFor,
  backgroundURL,
} = require("../src/main/background-host");

// electron-store is not available outside an Electron app, so the injected
// store-shaped object is the seam this module was written for.
const memoryStore = (initial = {}) => {
  const data = { ...initial };
  return {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value;
    },
    dump: () => data,
  };
};

// ── install-state ────────────────────────────────────────────────────────────
test("a version the host has never seen is an install; a changed one is an update", () => {
  assert.strictEqual(installReasonFor(null, "1.0"), "install");
  assert.strictEqual(installReasonFor(undefined, "1.0"), "install");
  assert.strictEqual(installReasonFor({ version: "1.0" }, "1.0"), null);
  assert.strictEqual(installReasonFor({ version: "1.0" }, "1.1"), "update");
  // Manifest versions are strings ("8.2.7"), and authors do not always quote them.
  assert.strictEqual(installReasonFor({ version: "1" }, 1), null);
});

test("the first launch records an install, the next one records nothing new", () => {
  const state = createInstallState(memoryStore());
  assert.strictEqual(state.record("ext-a", "1.0"), "install");
  assert.strictEqual(state.record("ext-a", "1.0"), null, "second launch, same version");
  assert.strictEqual(state.record("ext-a", "2.0"), "update");
  assert.strictEqual(state.record("ext-a", "2.0"), null);
  // A different extension id is its own install, regardless of what else is stored.
  assert.strictEqual(state.record("ext-b", "0.1"), "install");
});

test("what is stored is {version, installedAt}, per extension id", () => {
  const store = memoryStore();
  const state = createInstallState(store);
  state.record("ext-a", "1.2.3");
  const entry = state.get("ext-a");
  assert.strictEqual(entry.version, "1.2.3");
  assert.ok(!Number.isNaN(Date.parse(entry.installedAt)), `installedAt: ${entry.installedAt}`);
  assert.deepStrictEqual(Object.keys(store.dump().extensions), ["ext-a"]);
  assert.strictEqual(state.get("nobody"), null, "an unknown id has no state");
});

test("installedAt survives an update — it is the install date, not the launch date", () => {
  const state = createInstallState(memoryStore());
  state.record("ext-a", "1.0");
  const first = state.get("ext-a").installedAt;
  state.record("ext-a", "9.9");
  assert.strictEqual(state.get("ext-a").installedAt, first);
  assert.strictEqual(state.get("ext-a").version, "9.9");
});

test("forget() clears one id or everything", () => {
  const state = createInstallState(memoryStore());
  state.record("ext-a", "1.0");
  state.record("ext-b", "1.0");
  state.forget("ext-a");
  assert.strictEqual(state.get("ext-a"), null);
  assert.ok(state.get("ext-b"));
  state.forget();
  assert.strictEqual(state.get("ext-b"), null);
});

test("a state file that is not the shape we wrote does not crash the launch", () => {
  for (const junk of [undefined, null, "nope", 42, [], { extensions: "corrupt" }]) {
    const state = createInstallState(memoryStore({ extensions: junk }));
    assert.doesNotThrow(() => state.get("x"));
    assert.strictEqual(state.record("x", "1.0"), "install");
  }
});

// ── which event a background context gets ───────────────────────────────────
test("install and update outrank startup, and nothing-new is a startup", () => {
  assert.strictEqual(lifecycleFor(null, "1.0"), "install");
  assert.strictEqual(lifecycleFor({ version: "0.9" }, "1.0"), "update");
  assert.strictEqual(lifecycleFor({ version: "1.0" }, "1.0"), "startup");
});

test("a background context is recognized by the host's own frame URL", () => {
  assert.strictEqual(
    isBackgroundFrame({
      extensionId: "graphql",
      url: "rozenite://graphql/__rozenite_background__?script=background.js",
    }),
    true
  );
  // A panel of the same extension is not a background context.
  assert.strictEqual(
    isBackgroundFrame({ extensionId: "graphql", url: "rozenite://graphql/panel.html" }),
    false
  );
  // Nor a frame that merely loaded another extension's bootstrap path.
  assert.strictEqual(
    isBackgroundFrame({
      extensionId: "altair",
      url: "rozenite://graphql/__rozenite_background__",
    }),
    false
  );
  assert.strictEqual(isBackgroundFrame({ extensionId: "x", url: "not a url" }), false);
});

test("the worker's URL names the script it runs and how", () => {
  assert.strictEqual(
    backgroundURL({ extensionId: "altair", script: "assets/background.js", type: "module" }),
    "rozenite://altair/__rozenite_background__?script=assets%2Fbackground.js&type=module"
  );
});

// ── the host, with a fake window factory ───────────────────────────────────
//
// The fake window carries the two webContents hooks the production guard installs
// (`on`, `setWindowOpenHandler`); the host applies its guard to whatever window it is
// given, so a fake without them is a window the host could not guard, and `start()`'s
// failure path would swallow it as "could not create the hidden window".
const fakeWorkerWindow = (id = 1) => ({
  id,
  webContents: { on: () => {}, setWindowOpenHandler: () => {} },
  on: () => {},
  loadURL: () => Promise.resolve(),
  isVisible: () => false,
  isDestroyed: () => false,
  destroy: () => {},
});

const makeHost = ({
  scan,
  installState = createInstallState(memoryStore()),
  versions = {},
  log = { log: () => {}, warn: () => {}, error: () => {} },
} = {}) => {
  const loaded = [];
  const windows = [];
  let nextId = 1;

  const host = createBackgroundHost({
    scan,
    installState,
    readManifest: (extensionId) => ({ version: versions[extensionId] ?? "" }),
    observeFrame: (observer) => {
      host.observe = observer;
      return () => {};
    },
    createWindow: (options) => {
      loaded.push(options);
      const listeners = {};
      // webContents events and the window-open handler are recorded, because the guard the
      // host installs (src/main/extension-window-policy.js) is asserted through them below.
      const wcEvents = {};
      const openHandlers = [];
      const win = {
        id: nextId++,
        options,
        wcEvents,
        openHandlers,
        webContents: {
          on: (event, fn) => {
            listeners[event] = fn;
            wcEvents[event] = fn;
          },
          setWindowOpenHandler: (fn) => openHandlers.push(fn),
        },
        on: () => {},
        loadURL: (url) => {
          win.url = url;
          return Promise.resolve();
        },
        isVisible: () => false,
        isDestroyed: () => false,
        destroy: () => {
          win.destroyed = true;
        },
        emit: (event, ...args) => listeners[event] && listeners[event](null, ...args),
      };
      windows.push(win);
      return win;
    },
    log,
  });
  host.loaded = loaded;
  host.windows = windows;
  host.logLines = [];
  return host;
};

test("attach() starts one hidden window per declared background", () => {
  const host = makeHost({
    scan: () => [
      { extensionId: "graphql", name: "GQL", script: "background.js", type: "classic" },
      { extensionId: "altair", name: "Altair", script: "assets/background.js", type: "module" },
    ],
  });
  host.attach();
  assert.strictEqual(host.windows.length, 2);
  assert.strictEqual(host.windows[0].options.show, false, "the worker window is hidden");
  assert.ok(host.windows[0].options.webPreferences.preload, "the production preload is used");
  assert.strictEqual(host.windows[0].options.webPreferences.sandbox, false);
  assert.match(host.windows[0].url, /^rozenite:\/\/graphql\/__rozenite_background__/);
  assert.match(host.windows[1].url, /type=module$/, "altair's worker is an ES module");
});

test("the lifecycle reason is delivered once per extension, through the frame's own send", () => {
  const installState = createInstallState(memoryStore());
  const host = makeHost({
    scan: () => [{ extensionId: "graphql", name: "GQL", script: "background.js", type: "classic" }],
    installState,
    versions: { graphql: "2.23.1" },
  });
  host.attach();

  const sent = [];
  host.observe({
    extensionId: "graphql",
    key: "2:1",
    url: "rozenite://graphql/__rozenite_background__?script=background.js",
    send: (delivery) => sent.push(delivery),
  });
  assert.deepStrictEqual(sent, [
    {
      kind: "lifecycle",
      payload: { reason: "install", version: "2.23.1", previousVersion: null },
    },
  ]);

  // A reload gives the worker a new frame — and must not re-fire `install`.
  const second = [];
  host.observe({
    extensionId: "graphql",
    key: "2:2",
    url: "rozenite://graphql/__rozenite_background__?script=background.js",
    send: (delivery) => second.push(delivery),
  });
  assert.deepStrictEqual(second, [], "one lifecycle event per host launch");

  // The state was recorded, so the next host launch sees no install.
  assert.strictEqual(installState.get("graphql").version, "2.23.1", "manifest version recorded");
});

test("a panel frame gets no lifecycle delivery — only the background context does", () => {
  const host = makeHost({
    scan: () => [{ extensionId: "graphql", name: "GQL", script: "background.js", type: "classic" }],
  });
  host.attach();
  const sent = [];
  host.observe({
    extensionId: "graphql",
    key: "1:3",
    url: "rozenite://graphql/panel.html",
    send: (delivery) => sent.push(delivery),
  });
  assert.deepStrictEqual(sent, []);
});

test("a manifest version bump yields `update` on the next host launch", () => {
  // One persisted install state, three host launches: the first sees an install,
  // the next an update once the staged manifest's version changed, and a plain
  // startup when nothing changed.
  const installState = createInstallState(memoryStore());
  const seen = [];
  const versions = { x: "1.0" };

  const launch = () => {
    const sent = [];
    const host = createBackgroundHost({
      scan: () => [{ extensionId: "x", name: "X", script: "bg.js", type: "classic" }],
      installState,
      readManifest: (extensionId) => ({ version: versions[extensionId] ?? "" }),
      observeFrame: (observer) => {
        observer({
          extensionId: "x",
          key: "1:1",
          url: "rozenite://x/__rozenite_background__",
          send: (delivery) => sent.push(delivery),
        });
        return () => {};
      },
      createWindow: () => fakeWorkerWindow(1),
      log: { log: () => {}, warn: () => {}, error: () => {} },
    });
    host.attach();
    seen.push(sent.map((delivery) => delivery.payload && delivery.payload.reason));
    return host;
  };

  launch(); // first sight of this userData -> install
  versions.x = "2.0";
  launch(); // version differs from what was stored -> update
  launch(); // nothing changed -> startup
  assert.deepStrictEqual(seen, [["install"], ["update"], ["startup"]]);
});

test("onStartup is not repeated when the same host launch sees a second frame", () => {
  const installState = createInstallState(memoryStore());
  installState.record("x", "1.0");
  const host = makeHost({
    scan: () => [{ extensionId: "x", name: "X", script: "bg.js", type: "classic" }],
    installState,
    versions: { x: "1.0" },
  });
  host.attach();
  const first = [];
  host.observe({
    extensionId: "x",
    key: "1:1",
    url: "rozenite://x/__rozenite_background__",
    send: (delivery) => first.push(delivery),
  });
  assert.deepStrictEqual(first.map((delivery) => delivery.payload.reason), ["startup"]);
  const second = [];
  host.observe({
    extensionId: "x",
    key: "1:2",
    url: "rozenite://x/__rozenite_background__",
    send: (delivery) => second.push(delivery),
  });
  assert.deepStrictEqual(second, []);
});

test("a scan or window-creation failure is reported and does not stop the other workers", () => {
  const warnings = [];
  const host = createBackgroundHost({
    scan: () => [
      { extensionId: "good", name: "Good", script: "bg.js", type: "classic" },
      { extensionId: "bad", name: "Bad", script: "bg.js", type: "classic" },
    ],
    installState: createInstallState(memoryStore()),
    readManifest: () => ({ version: "1" }),
    observeFrame: () => () => {},
    createWindow: (options, entry) => {
      if (entry.extensionId === "bad") {
        throw new Error("no window for you");
      }
      return fakeWorkerWindow(1);
    },
    log: { log: () => {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
  });
  host.attach();
  assert.strictEqual(host.list().length, 1, "the good worker still started");
  assert.ok(
    warnings.some((message) => message.includes("bad") && message.includes("no window")),
    `failure reported: ${warnings.join(" | ")}`
  );
});

// ── F4: the worker window is a guarded window, not an open one ───────────────
//
// The window is hidden, but hidden is not harmless: it runs the production preload as a
// MAIN frame with an extension origin, so before issue #24 it had no `will-navigate`
// guard and no `setWindowOpenHandler`. One `location.href = "https://evil.test"` moved the
// worker's document to a remote page that still had a preload — and the old preload
// decided "is this the frontend?" by ABSENCE of the extension scheme, so that page got the
// frontend's InspectorFrontendHost surface (docs/SECURITY-PLATFORM.md F4). These pin the
// two hooks the host installs, through the same injected window every other test here uses
// (the host applies the guard to whatever window it was given, so this is the production
// call path); the live half — a real `location.href` attempt that stays on the bootstrap
// URL, and a real `window.open` that creates no window — is asserted in
// tests/background-worker-electron.test.js.
const fireNavigation = (win, url) => {
  const handler = win.wcEvents["will-navigate"];
  assert.ok(handler, "the host installs a will-navigate handler");
  let prevented = false;
  handler({ preventDefault: () => (prevented = true) }, url);
  return prevented;
};

test("the worker window guards its navigations and denies window.open", () => {
  const host = makeHost({
    scan: () => [{ extensionId: "graphql", name: "GQL", script: "bg.js", type: "classic" }],
  });
  host.attach();
  const [win] = host.windows;

  assert.ok(win.wcEvents["will-navigate"], "will-navigate is guarded (it used to be absent)");
  assert.ok(win.wcEvents["will-redirect"], "will-redirect too: a redirect is a navigation");
  assert.strictEqual(win.openHandlers.length, 1, "setWindowOpenHandler is installed");
  assert.deepStrictEqual(
    win.openHandlers[0]({ url: "https://evil.test/popup", frameName: "" }),
    { action: "deny" },
    "window.open from a worker creates no window"
  );

  // Its own extension stays open: the bootstrap URL itself (a reload fires the event too)
  // and the extension's other files.
  assert.strictEqual(fireNavigation(win, win.url), false, "a reload is not a navigation");
  assert.strictEqual(fireNavigation(win, "rozenite://graphql/assets/log.js"), false);
  assert.strictEqual(
    fireNavigation(win, "rozenite://GRAPHQL/x.js"),
    false,
    "URL hosts are case-insensitive, so this is still the same extension"
  );
  // Everything else is refused.
  assert.strictEqual(fireNavigation(win, "https://evil.test/landed"), true);
  assert.strictEqual(fireNavigation(win, "http://127.0.0.1:8081/rozenite/rn_fusebox.html"), true);
  assert.strictEqual(
    fireNavigation(win, "rozenite://altair/panel.html"),
    true,
    "another extension is another principal"
  );
  assert.strictEqual(fireNavigation(win, "about:blank"), true);
  assert.strictEqual(fireNavigation(win, "file:///etc/passwd"), true);
});

test("a refused navigation is reported, never swallowed", () => {
  const warnings = [];
  const host = makeHost({
    scan: () => [{ extensionId: "graphql", name: "GQL", script: "bg.js", type: "classic" }],
    log: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
  });
  host.attach();
  fireNavigation(host.windows[0], "https://evil.test/landed");
  assert.ok(
    warnings.some((m) => /blocked a navigation/.test(m) && /evil\.test/.test(m)),
    `the refusal is said out loud: ${warnings.join(" | ")}`
  );
});

test("closeAll destroys the worker windows it owns", () => {
  const host = makeHost({
    scan: () => [{ extensionId: "graphql", name: "GQL", script: "bg.js", type: "classic" }],
  });
  host.attach();
  const [win] = host.windows;
  host.closeAll();
  assert.strictEqual(win.destroyed, true);
  assert.deepStrictEqual(host.list(), []);
});

test("isWorkerWindow knows its own windows — the shutdown rule depends on it", () => {
  const host = makeHost({
    scan: () => [{ extensionId: "graphql", name: "GQL", script: "bg.js", type: "classic" }],
  });
  host.attach();
  assert.strictEqual(host.isWorkerWindow(host.windows[0].id), true);
  assert.strictEqual(host.isWorkerWindow(999), false, "the frontend window is not a worker");
});

// The quit rule itself cannot be driven headlessly (the harness ends its run with
// app.exit, which skips will-quit), so the rule's SHAPE is pinned here: the two
// decisions that matter are "hidden windows do not count" and "macOS does not quit",
// and both were easy to get silently wrong.
test("src/main/index.js's quit rule excludes worker windows and respects macOS", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "main", "index.js"),
    "utf8"
  );
  // One raw window enumeration only, inside the predicate that filters workers out —
  // if a quit path ever enumerates windows directly, hidden workers keep the app alive.
  assert.strictEqual(
    (source.match(/BrowserWindow\.getAllWindows\(\)/g) || []).length,
    1,
    "getAllWindows is used in exactly one place: the worker-filtered predicate"
  );
  assert.match(source, /host\.isWorkerWindow\(win\.id\)/);

  // `activate` recreates the DevTools window when none is left — counting hidden
  // workers there would mean a dock click doing nothing.
  const activate = source.slice(source.indexOf('app.on("activate"'));
  assert.match(activate.slice(0, 300), /userWindows\(\)\.length === 0/);

  // Closing the DevTools window must quit on non-mac even though worker windows are
  // still open (window-all-closed never fires there), and must NOT quit on mac.
  const created = source.slice(source.indexOf('app.on("browser-window-created"'));
  assert.match(created, /userWindows\(\)\.length === 0/);
  assert.match(created.slice(0, 600), /process\.platform !== "darwin"/);

  // Worker windows are destroyed on the way out rather than left as the last thing
  // standing between the app and exit.
  const willQuit = source.slice(source.indexOf('app.on("will-quit"'));
  assert.match(willQuit, /closeAll\(\)/);
});
