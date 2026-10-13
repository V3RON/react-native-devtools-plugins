// chrome.devtools.panels.themeName / themeChanged (docs/features/DEVTOOLS-PANELS.md):
// the shim's live property + event, the host's validated fan-out, and the
// chrome namespace's delivery routing.
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
const { createThemeHost } = require("../src/main/theme-host");
const { createContextRegistry } = require("../src/main/context-registry");

const makeShim = () => createDevtools({ extensionId: "my-ext" });

test("themeName is a live property that follows setThemeName", () => {
  const { namespace, setThemeName } = makeShim();
  assert.strictEqual(namespace.panels.themeName, "default");
  assert.strictEqual(setThemeName("dark"), true);
  assert.strictEqual(namespace.panels.themeName, "dark");
  assert.strictEqual(setThemeName("default"), true);
  assert.strictEqual(namespace.panels.themeName, "default");
});

test("themeChanged fires once per real change, with the new name", () => {
  const { namespace, setThemeName } = makeShim();
  const seen = [];
  namespace.panels.themeChanged.addListener((name) => seen.push(name));
  setThemeName("dark");
  setThemeName("dark"); // no change, no event
  setThemeName("default");
  assert.deepStrictEqual(seen, ["dark", "default"]);
});

test("the shim refuses names that are not Chrome's two", () => {
  const { namespace, setThemeName } = makeShim();
  const seen = [];
  namespace.panels.themeChanged.addListener((name) => seen.push(name));
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
  chrome.devtools.panels.themeChanged.addListener((name) => seen.push(name));
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

test("registry broadcast reaches every context and retires dead ones", () => {
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
