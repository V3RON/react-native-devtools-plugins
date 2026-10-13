// chrome.devtools.panels.themeName / setThemeChangeHandler (docs/features/DEVTOOLS-PANELS.md):
// the shim's live property + event, the host's validated fan-out, the chrome
// namespace's delivery routing, the THEME_REPORT frame check and the URL boot hint.
// The cross-process chain is tests/theme-electron.test.js.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createDevtools } = require("../src/chrome-shim/devtools");
const {
  createChromeNamespace,
  createExtensionStorage,
  createMemoryBackend,
  createNetworkBridge,
} = require("../src/chrome-shim");
const {
  createThemeHost,
  createThemeReportHandler,
} = require("../src/main/theme-host");
const { isFrontendFrame } = require("../src/main/frontend-frame");
const { createContextRegistry } = require("../src/main/context-registry");
const { takeThemeHint, stripThemeHintFromUrl, THEME_PARAM } = require("../src/shared/theme");

const makeShim = () => createDevtools({ extensionId: "my-ext" });

test("themeName is a live property that follows setThemeName", () => {
  const { namespace, setThemeName } = makeShim();
  assert.strictEqual(namespace.panels.themeName, "default");
  assert.strictEqual(setThemeName("dark"), true);
  assert.strictEqual(namespace.panels.themeName, "dark");
  assert.strictEqual(setThemeName("default"), true);
  assert.strictEqual(namespace.panels.themeName, "default");
});

test("setThemeChangeHandler is called once per real change, with the new name", () => {
  const { namespace, setThemeName } = makeShim();
  const seen = [];
  namespace.panels.setThemeChangeHandler((name) => seen.push(name));
  setThemeName("dark");
  setThemeName("dark"); // no change, no event
  setThemeName("default");
  assert.deepStrictEqual(seen, ["dark", "default"]);
});

test("setThemeChangeHandler: one handler, replaced per call, cleared by a non-function; no themeChanged", () => {
  const { namespace, setThemeName } = makeShim();
  assert.strictEqual("themeChanged" in namespace.panels, false, "Chrome has no such event");
  const first = [];
  const second = [];
  assert.strictEqual(namespace.panels.setThemeChangeHandler((n) => first.push(n)), undefined);
  setThemeName("dark");
  namespace.panels.setThemeChangeHandler((n) => second.push(n)); // replaces, not adds
  setThemeName("default");
  assert.deepStrictEqual(first, ["dark"]);
  assert.deepStrictEqual(second, ["default"]);
  namespace.panels.setThemeChangeHandler(null); // cleared
  setThemeName("dark");
  assert.deepStrictEqual(second, ["default"]);
  assert.strictEqual(namespace.panels.themeName, "dark", "themeName still tracks without a handler");
  // registering does not call it (only a change does), and a throwing handler cannot break the shim
  const logged = [];
  const shim = createDevtools({ extensionId: "x", logger: { error: (...a) => logged.push(a), warn() {} } });
  let calls = 0;
  shim.namespace.panels.setThemeChangeHandler(() => {
    calls++;
    throw new Error("boom");
  });
  assert.strictEqual(calls, 0);
  assert.strictEqual(shim.setThemeName("dark"), true);
  assert.strictEqual(shim.namespace.panels.themeName, "dark");
  assert.strictEqual(logged.length, 1);
});

test("the shim refuses names that are not Chrome's two", () => {
  const { namespace, setThemeName } = makeShim();
  const seen = [];
  namespace.panels.setThemeChangeHandler((name) => seen.push(name));
  for (const bad of ["light", "", undefined, null, 1, {}]) {
    assert.strictEqual(setThemeName(bad), false);
  }
  assert.strictEqual(namespace.panels.themeName, "default");
  assert.deepStrictEqual(seen, []);
});

test("the chrome namespace routes `theme` deliveries and the registration answer", () => {
  const chrome = createChromeNamespace({
    extensionId: "my-ext",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: createNetworkBridge({ logger: { warn: () => {} } }),
  });
  const seen = [];
  chrome.devtools.panels.setThemeChangeHandler((name) => seen.push(name));
  chrome._setThemeName("dark"); // RUNTIME_REGISTER reply
  assert.strictEqual(chrome.devtools.panels.themeName, "dark");
  chrome.handleDelivery({ kind: "theme", payload: { themeName: "default" } });
  assert.strictEqual(chrome.devtools.panels.themeName, "default");
  chrome.handleDelivery({ kind: "theme", payload: { themeName: "bogus" } });
  chrome.handleDelivery({ kind: "theme" });
  assert.deepStrictEqual(seen, ["dark", "default"]);
});

test("theme host broadcasts only real, valid changes", () => {
  const sent = [];
  const host = createThemeHost({ broadcast: (delivery) => sent.push(delivery) });
  assert.strictEqual(host.get(), "default");
  assert.strictEqual(host.report("default"), false); // already so
  assert.strictEqual(host.report("dark"), true);
  assert.strictEqual(host.report("dark"), false);
  for (const bad of ["light", "systemPreferred", undefined, null, 5, {}]) {
    assert.strictEqual(host.report(bad), false);
  }
  assert.strictEqual(host.get(), "dark");
  assert.deepStrictEqual(sent, [{ kind: "theme", payload: { themeName: "dark" } }]);
});

test("THEME_REPORT: only the frontend's own main frame is believed, payload or not", () => {
  const sent = [];
  const host = createThemeHost({ broadcast: (d) => sent.push(d) });
  const FRONTEND = "http://127.0.0.1:8081/";
  const mainFrame = { id: "main", url: `${FRONTEND}rozenite/rn_fusebox.html?ws=x` };
  const contents = { isDestroyed: () => false, mainFrame };
  const handler = createThemeReportHandler({
    themeHost: host,
    isFrontendFrame: (event) => isFrontendFrame(event, { contents, frontendURL: FRONTEND }),
  });
  const payload = { themeName: "dark" };

  // an extension iframe in the SAME webContents
  assert.deepStrictEqual(handler({ sender: contents, senderFrame: { id: "ext" } }, payload), { ok: false });
  // another webContents entirely (a background window, an options page)
  const other = { isDestroyed: () => false, mainFrame: { id: "bg" } };
  assert.deepStrictEqual(handler({ sender: other, senderFrame: other.mainFrame }, payload), { ok: false });
  // no frame at all, no event at all
  assert.deepStrictEqual(handler({ sender: contents, senderFrame: null }, payload), { ok: false });
  assert.deepStrictEqual(handler(undefined, payload), { ok: false });
  assert.deepStrictEqual(sent, [], "nothing was broadcast for any of them");
  assert.strictEqual(host.get(), "default");

  // a destroyed frontend is not a frontend
  const dead = { isDestroyed: () => true, mainFrame };
  assert.deepStrictEqual(
    createThemeReportHandler({ themeHost: host, isFrontendFrame: (e) => isFrontendFrame(e, { contents: dead, frontendURL: FRONTEND }) })(
      { sender: dead, senderFrame: mainFrame },
      payload
    ),
    { ok: false }
  );

  // the frontend's main frame navigated away (still the same WebContents and preload)
  const navigated = { sender: contents, senderFrame: { ...mainFrame } };
  contents.mainFrame = navigated.senderFrame;
  navigated.senderFrame.url = "https://evil.example/";
  assert.deepStrictEqual(handler(navigated, payload), { ok: false });
  contents.mainFrame = mainFrame;
  assert.deepStrictEqual(sent, [], "still nothing broadcast");

  // the real one: accepted, validated, a null payload cannot throw
  const frontend = { sender: contents, senderFrame: mainFrame };
  assert.deepStrictEqual(handler(frontend, null), { ok: true, changed: false });
  assert.deepStrictEqual(handler(frontend, undefined), { ok: true, changed: false });
  assert.deepStrictEqual(handler(frontend, { themeName: "light" }), { ok: true, changed: false });
  assert.deepStrictEqual(handler(frontend, payload), { ok: true, changed: true });
  assert.deepStrictEqual(sent, [{ kind: "theme", payload: { themeName: "dark" } }]);
});

test("registry broadcast reaches every context; a throwing sender is retired and not counted", () => {
  const registry = createContextRegistry();
  const got = { a: [], b: [] };
  registry.register({ frameKey: "1:1", extensionId: "x", send: (d) => got.a.push(d) });
  registry.register({ frameKey: "1:2", extensionId: "y", send: (d) => got.b.push(d) });
  registry.register({
    frameKey: "1:3",
    extensionId: "z",
    send: () => {
      throw new Error("frame gone");
    },
  });
  const delivery = { kind: "theme", payload: { themeName: "dark" } };
  assert.strictEqual(registry.broadcast(delivery), 2);
  assert.deepStrictEqual(got.a, [delivery]);
  assert.deepStrictEqual(got.b, [delivery]);
  assert.strictEqual(registry.has("1:3"), false);
});

test("takeThemeHint validates the hint and leaves the extension's own query byte for byte", () => {
  assert.strictEqual(THEME_PARAM, "__rozenite_theme");
  assert.deepStrictEqual(takeThemeHint(""), { theme: null, search: null });
  assert.deepStrictEqual(takeThemeHint("?a=1"), { theme: null, search: null });
  assert.deepStrictEqual(takeThemeHint("?__rozenite_theme=dark"), { theme: "dark", search: "" });
  assert.deepStrictEqual(takeThemeHint("?__rozenite_theme=default"), { theme: "default", search: "" });
  // order, encoding, `+`, repeats and valueless keys are preserved
  assert.deepStrictEqual(takeThemeHint("?x=a%20b+c&__rozenite_theme=dark&x=2&flag"), {
    theme: "dark",
    search: "?x=a%20b+c&x=2&flag",
  });
  // not one of Chrome's two names: stripped, but no theme
  for (const bad of ["light", "evil", "", "DARK", "dark%20"]) {
    assert.strictEqual(takeThemeHint(`?__rozenite_theme=${bad}`).theme, null, bad);
  }
  assert.deepStrictEqual(takeThemeHint("?__rozenite_theme"), { theme: null, search: "" });
  // a look-alike key is the extension's own
  assert.deepStrictEqual(takeThemeHint("?__rozenite_theme_x=dark"), { theme: null, search: null });
});

test("takeThemeHint is byte-preserving: only the hint and its own separator go", () => {
  assert.strictEqual(takeThemeHint("?a=1&&b=2&__rozenite_theme=dark&").search, "?a=1&&b=2&");
  assert.strictEqual(takeThemeHint("?&a&__rozenite_theme=dark").search, "?&a");
  assert.strictEqual(takeThemeHint("?__rozenite_theme=dark&&a=1").search, "?&a=1");
  assert.strictEqual(takeThemeHint("?a=1&__rozenite_theme=dark&b=%zz&c=+").search, "?a=1&b=%zz&c=+");
  assert.strictEqual(takeThemeHint("?__rozenite_theme=dark&__rozenite_theme=default").theme, "dark");
});

test("stripThemeHintFromUrl leaves everything else of an address alone", () => {
  assert.strictEqual(
    stripThemeHintFromUrl("rozenite://x/probe.html?id=A&__rozenite_theme=dark#frag"),
    "rozenite://x/probe.html?id=A#frag"
  );
  assert.strictEqual(stripThemeHintFromUrl("rozenite://x/p.html?__rozenite_theme=dark"), "rozenite://x/p.html");
  assert.strictEqual(stripThemeHintFromUrl("rozenite://x/p.html?a=1#h?__rozenite_theme=dark"), "rozenite://x/p.html?a=1#h?__rozenite_theme=dark");
  assert.strictEqual(stripThemeHintFromUrl("rozenite://x/p.html"), "rozenite://x/p.html");
  assert.strictEqual(stripThemeHintFromUrl(""), "");
});
