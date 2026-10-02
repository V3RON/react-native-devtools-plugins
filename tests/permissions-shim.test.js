// `chrome.permissions` (src/chrome-shim/permissions-api.js) — the accept-and-grant
// shim that is not allowed to lie: it reports the HOST's verdict about what the
// manifest declares, and `request` grants nothing new (docs/features/SMALL-SHIMS.md).
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createPermissionsApi } = require("../src/chrome-shim/permissions-api");
const { createChromeNamespace } = require("../src/chrome-shim");
const { createMemoryBackend, createExtensionStorage } = require("../src/chrome-shim/storage");
const { createGrantGate, requiredPermission } = require("../src/shared/permissions");

const makeApi = (declared) => {
  const warnings = [];
  // `declared` is a getter in the shim (the host's verdict can arrive late); a
  // test may hand the list, or a promise for it, directly.
  const list =
    typeof declared === "function"
      ? declared
      : Array.isArray(declared) || (declared && typeof declared.then === "function")
        ? () => declared
        : () => declared;
  return {
    warnings,
    api: createPermissionsApi({
      declared: list,
      onUnsupportedRequest: (message) => warnings.push(message),
    }),
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("permissions is registered as an ungated API", () => {
  assert.strictEqual(requiredPermission("permissions"), null);
});

test("contains: a declared permission reports granted, an undeclared one does not", async () => {
  const { api } = makeApi(["storage", "tabs"]);
  assert.strictEqual(await api.contains({ permissions: ["storage"] }), true);
  assert.strictEqual(await api.contains({ permissions: ["notifications"] }), false);
  // Chrome's AND semantics: one missing entry makes the whole query false.
  assert.strictEqual(await api.contains({ permissions: ["storage", "alarms"] }), false);
  // Mixed declared/undeclared does not silently pass either.
  assert.strictEqual(await api.contains({ permissions: [] }), true, "nothing asked, nothing missing");
});

test("getAll reports exactly the declared list, once each", async () => {
  const { api } = makeApi(["storage", "tabs", "storage"]);
  const all = await api.getAll();
  assert.deepStrictEqual(all, { permissions: ["storage", "tabs"] });
});

test("request resolves true for declared permissions and false for undeclared ones", async () => {
  const { api, warnings } = makeApi(["storage"]);
  assert.strictEqual(await api.request({ permissions: ["storage"] }), true);
  assert.strictEqual(await api.request({ permissions: ["notifications"] }), false);
  assert.strictEqual(await api.request({ permissions: ["storage", "notifications"] }), false);
  assert.strictEqual(warnings.length, 2, "each ungrantable request is reported once");
  assert.match(warnings[0], /grants nothing new/);
  // And reporting it did not change what is granted.
  assert.strictEqual(await api.contains({ permissions: ["notifications"] }), false);
});

test("remove resolves and changes nothing (Chrome cannot remove a required permission)", async () => {
  const { api } = makeApi(["storage", "tabs"]);
  assert.strictEqual(await api.remove({ permissions: ["storage"] }), undefined);
  assert.deepStrictEqual(await api.getAll(), { permissions: ["storage", "tabs"] });
});

test("onAdded / onRemoved are registrable and never fire", async () => {
  const { api } = makeApi(["storage"]);
  for (const event of [api.onAdded, api.onRemoved]) {
    let fired = 0;
    const fn = () => {
      fired++;
    };
    event.addListener(fn);
    event.addListener(fn); // dedupe
    assert.strictEqual(event.hasListener(fn), true);
    assert.strictEqual(event.hasListeners(), true);
    event.removeListener(fn);
    assert.strictEqual(event.hasListener(fn), false);
    await api.request({ permissions: ["storage"] });
    await api.remove({ permissions: ["storage"] });
    assert.strictEqual(fired, 0);
  }
});

test("callback style: no promise back, value arrives asynchronously", async () => {
  const { api } = makeApi(["storage"]);
  let seen;
  const returned = api.contains({ permissions: ["storage"] }, (granted) => {
    seen = granted;
  });
  assert.strictEqual(returned, undefined, "callback style returns nothing, like Chrome");
  await tick();
  assert.strictEqual(seen, true);

  const list = await new Promise((resolve) => api.getAll(resolve));
  assert.deepStrictEqual(list, { permissions: ["storage"] });

  const removed = await new Promise((resolve) => api.remove({ permissions: ["storage"] }, resolve));
  assert.strictEqual(removed, undefined);
});

test("a verdict still in flight is awaited, not guessed", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { api } = makeApi(pending);
  let answered = false;
  const promise = api.contains({ permissions: ["notifications"] }).then((value) => {
    answered = true;
    return value;
  });
  await tick();
  assert.strictEqual(answered, false, "no answer before the host's verdict lands");
  release(["notifications", "storage"]);
  assert.strictEqual(await promise, true);
});

// ── wired through the real namespace, gated on the host's grant map ───────────
const namespaceWith = (grants) => {
  const storage = createExtensionStorage({ createBackend: () => createMemoryBackend() });
  const gate = createGrantGate(() => grants);
  const chrome = createChromeNamespace({
    extensionId: "perm.local",
    getManifest: () => ({ permissions: ["storage"] }),
    storage,
    networkBridge: { webRequest: {}, network: {} },
    permissions: gate,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  gate.manifestLoaded();
  return chrome;
};

test("chrome.permissions reports the host's grants, not the manifest the page can reach", async () => {
  const chrome = namespaceWith({ storage: true, alarms: false, notifications: false });
  // The manifest a page can read says ["storage"]; the HOST's verdict is what
  // counts, and it is what the namespace reports.
  assert.deepStrictEqual(await chrome.permissions.getAll(), { permissions: ["storage"] });
  assert.strictEqual(await chrome.permissions.contains({ permissions: ["alarms"] }), false);
  assert.strictEqual(await chrome.permissions.request({ permissions: ["alarms"] }), false);
});

test("chrome.permissions exists before RUNTIME_REGISTER resolves and then reports the truth", async () => {
  const chrome = namespaceWith({ storage: true, notifications: true });
  assert.strictEqual(typeof chrome.permissions.contains, "function", "shape exists immediately");
  assert.strictEqual(await chrome.permissions.contains({ permissions: ["notifications"] }), true);
});
