// Host-owned chrome.storage (src/main/storage-service.js) with the frame-side shim
// (src/chrome-shim/storage.js) on the other end of a simulated IPC: one store per
// extension shared by all its contexts, change events to every context of THAT
// extension only, persistence for local/sync and none for session.
const test = require("node:test");
const assert = require("node:assert");

const { createStorageService } = require("../src/main/storage-service");
const { createExtensionStorage } = require("../src/chrome-shim/storage");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A world: one service, and `context(...)` adds a frame with a real shim wired to it. */
const world = (serviceOptions = {}) => {
  const service = createStorageService(serviceOptions);
  let count = 0;
  const context = (extensionId, { trusted = true, granted = true, pushDelayMs = 0 } = {}) => {
    const frameKey = `ctx:${(count += 1)}`;
    let shim;
    const lastErrors = [];
    service.attach({
      frameKey,
      extensionId,
      trusted,
      allowed: () => granted,
      // The push is slower than the reply when asked to be: the ordering guarantee
      // must not depend on which of the two arrives first.
      send: ({ seq, area, changes }) =>
        setTimeout(() => shim.handleDelivery({ kind: "storage-changed", payload: { seq, area, changes } }), pushDelayMs),
    });
    shim = createExtensionStorage({
      call: (area, op, arg) => Promise.resolve(service.call({ frameKey, area, op, arg })),
    });
    let current = null;
    shim.bindLastError({
      setError: (error) => {
        current = error;
      },
      clearError: () => {
        current = null;
      },
    });
    const events = [];
    shim.onChanged.addListener((changes, area) => events.push({ area, changes }));
    return { frameKey, storage: shim, events, lastErrors, lastError: () => current };
  };
  return { service, context };
};

test("session storage is one store for every context of an extension", async () => {
  const { context } = world();
  const panel = context("ext.a");
  const worker = context("ext.a");
  await panel.storage.session.set({ token: { n: 1 } });
  assert.deepStrictEqual(await worker.storage.session.get("token"), { token: { n: 1 } });
  await worker.storage.session.remove("token");
  assert.deepStrictEqual(await panel.storage.session.get(null), {});
});

test("onChanged reaches every context of the extension, the writer included, and nobody else", async () => {
  const { context } = world();
  const panel = context("ext.a");
  const worker = context("ext.a");
  const other = context("ext.b");
  const perArea = [];
  worker.storage.session.onChanged.addListener((changes) => perArea.push(changes));

  await panel.storage.session.set({ k: 1 });
  await sleep(5);

  const expected = [{ area: "session", changes: { k: { newValue: 1 } } }];
  assert.deepStrictEqual(panel.events, expected, "the writer hears its own change");
  assert.deepStrictEqual(worker.events, expected);
  assert.deepStrictEqual(perArea, [{ k: { newValue: 1 } }], "the per-area event carries (changes) alone");
  assert.deepStrictEqual(other.events, [], "a different extension hears nothing");

  assert.deepStrictEqual(await other.storage.session.get(null), {}, "and cannot read it either");
  await other.storage.session.set({ k: "theirs" });
  assert.deepStrictEqual(await panel.storage.session.get("k"), { k: 1 }, "same key, separate stores");
});

test("local and sync broadcast too, under their own area name", async () => {
  const { context } = world();
  const a = context("ext.a");
  const b = context("ext.a");
  await a.storage.local.set({ l: 1 });
  await a.storage.sync.set({ s: 2 });
  await a.storage.local.clear();
  await sleep(5);
  const expected = [
    { area: "local", changes: { l: { newValue: 1 } } },
    { area: "sync", changes: { s: { newValue: 2 } } },
    { area: "local", changes: { l: { oldValue: 1 } } },
  ];
  assert.deepStrictEqual(b.events, expected);
  assert.deepStrictEqual(a.events, expected);
});

test("a write's callback runs after its own onChanged, even when the push is slower than the reply", async () => {
  const { context } = world();
  const a = context("ext.a", { pushDelayMs: 30 });
  const order = [];
  a.storage.onChanged.addListener(() => order.push("event"));
  await new Promise((resolve) =>
    a.storage.local.set({ k: 1 }, () => {
      order.push("callback");
      resolve();
    })
  );
  assert.deepStrictEqual(order, ["event", "callback"]);

  // Two writes in a row: events keep the order the host applied them in.
  await a.storage.local.set({ k: 2 });
  await a.storage.local.set({ k: 3 });
  assert.deepStrictEqual(
    a.events.map((e) => e.changes.k.newValue),
    [1, 2, 3]
  );
});

test("a write that changes nothing raises no event and does not wait for one", async () => {
  const { context } = world();
  const a = context("ext.a", { pushDelayMs: 500 });
  await a.storage.session.set({ k: 1 });
  const started = Date.now();
  await a.storage.session.set({ k: 1 });
  await a.storage.session.remove("absent");
  assert.ok(Date.now() - started < 200);
  await sleep(550);
  assert.strictEqual(a.events.length, 1);
});

test("errors: promise rejection, and lastError with no value for the callback style", async () => {
  const { context } = world();
  const a = context("ext.a");
  const huge = { big: "x".repeat(11 * 1024 * 1024) };
  await assert.rejects(a.storage.session.set(huge), /Session storage quota bytes exceeded/);

  const seen = await new Promise((resolve) =>
    a.storage.session.set(huge, (...args) => resolve({ args, error: a.lastError() && a.lastError().message }))
  );
  assert.deepStrictEqual(seen.args, [], "no value alongside the error");
  assert.match(seen.error, /Session storage quota bytes exceeded/);
  assert.strictEqual(a.lastError(), null, "lastError is only set for the callback's duration");
  assert.deepStrictEqual(await a.storage.session.get(null), {});
  assert.deepStrictEqual(a.events, []);
});

test("get/getBytesInUse/getKeys accept their optional leading argument", async () => {
  const { context } = world();
  const a = context("ext.a");
  await a.storage.local.set({ k: "v" });
  assert.deepStrictEqual(await new Promise((r) => a.storage.local.get((all) => r(all))), { k: "v" });
  assert.strictEqual(await new Promise((r) => a.storage.local.getBytesInUse((n) => r(n))), 1 + 3);
  assert.deepStrictEqual(await a.storage.local.getKeys(), ["k"]);
  assert.strictEqual(a.storage.session.QUOTA_BYTES, 10485760);
  assert.strictEqual(a.storage.local.QUOTA_BYTES, 10485760);
  assert.strictEqual(a.storage.sync.QUOTA_BYTES, 102400);
  assert.strictEqual(a.storage.local.setAccessLevel, undefined, "setAccessLevel is session-only");
});

test("setAccessLevel: untrusted contexts are denied unless the extension widens it", async () => {
  const { context, service } = world();
  const page = context("ext.a");
  const script = context("ext.a", { trusted: false });

  await page.storage.session.set({ k: 1 });
  await sleep(5);
  assert.deepStrictEqual(script.events, [], "no events for a context the area is closed to");
  await assert.rejects(script.storage.session.get("k"), /Access to storage is not allowed from this context/);
  await assert.rejects(
    script.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }),
    /not allowed/,
    "an untrusted context cannot open the door itself"
  );
  assert.deepStrictEqual(await script.storage.local.get("k"), {}, "local is not behind the access level");

  await assert.rejects(page.storage.session.setAccessLevel({ accessLevel: "EVERYONE" }), /accessLevel/);
  await page.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  assert.deepStrictEqual(await script.storage.session.get("k"), { k: 1 });
  await page.storage.session.set({ k: 2 });
  await sleep(5);
  assert.deepStrictEqual(script.events, [{ area: "session", changes: { k: { oldValue: 1, newValue: 2 } } }]);

  await page.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await assert.rejects(script.storage.session.get("k"), /not allowed/);

  // The level is per extension.
  const stranger = context("ext.b", { trusted: false });
  await assert.rejects(stranger.storage.session.get(null), /not allowed/);
  assert.deepStrictEqual(service.contextsOf("ext.b").length, 1);
});

test("a context without the storage permission is neither served nor told", async () => {
  const { context } = world();
  const holder = context("ext.a");
  const denied = context("ext.a", { granted: false });
  await assert.rejects(denied.storage.local.get(null), /permission 'storage' is not declared/);
  await holder.storage.local.set({ k: 1 });
  await sleep(5);
  assert.deepStrictEqual(denied.events, []);
  assert.strictEqual(holder.events.length, 1);
});

test("a detached context stops receiving, and the rest carry on", async () => {
  const { context, service } = world();
  const a = context("ext.a");
  const b = context("ext.a");
  service.detach(b.frameKey);
  await a.storage.session.set({ k: 1 });
  await sleep(5);
  assert.strictEqual(b.events.length, 0);
  assert.strictEqual(a.events.length, 1);
  assert.deepStrictEqual((await Promise.resolve(service.call({ frameKey: b.frameKey, area: "local", op: "get" }))).ok, false);
});

test("an unknown area or operation is refused, not guessed at", () => {
  const { service, context } = world();
  const a = context("ext.a");
  assert.strictEqual(service.call({ frameKey: a.frameKey, area: "managed", op: "get" }).ok, false);
  assert.strictEqual(service.call({ frameKey: a.frameKey, area: "local", op: "__proto__" }).ok, false);
  assert.strictEqual(service.call({ frameKey: "nobody", area: "local", op: "get" }).ok, false);
});

test("local/sync persist through the injected store, session never does", async () => {
  const disk = new Map(); // `${ext}/${area}` -> object
  const opened = [];
  const openPersistence = (extensionId, area) => {
    opened.push(`${extensionId}/${area}`);
    return {
      load: () => disk.get(`${extensionId}/${area}`) || {},
      save: (items) => disk.set(`${extensionId}/${area}`, JSON.parse(JSON.stringify(items))),
    };
  };
  disk.set("ext.a/local", { before: "restart" });

  const first = world({ openPersistence });
  const a = first.context("ext.a");
  assert.deepStrictEqual(await a.storage.local.get(null), { before: "restart" }, "what an earlier run saved is there");
  await a.storage.local.set({ "dotted.key": 1 });
  await a.storage.session.set({ volatile: 1 });
  assert.deepStrictEqual(disk.get("ext.a/local"), { before: "restart", "dotted.key": 1 });
  assert.ok(!opened.some((entry) => entry.endsWith("/session")), "session never touches the disk");

  // "Restart the shell": a new service over the same disk.
  const second = world({ openPersistence });
  const b = second.context("ext.a");
  assert.deepStrictEqual(await b.storage.local.get(null), { before: "restart", "dotted.key": 1 });
  assert.deepStrictEqual(await b.storage.session.get(null), {}, "session is cleared by the restart");
});

test("a failing disk fails the write, changes nothing, and is retried from disk next time", async () => {
  let failing = true;
  const disk = {};
  const { context } = world({
    openPersistence: () => ({
      load: () => ({ ...disk }),
      save: (items) => {
        if (failing) {
          throw new Error("disk full");
        }
        Object.assign(disk, items);
      },
    }),
  });
  const a = context("ext.a");
  await assert.rejects(a.storage.local.set({ k: 1 }), /could not persist \(disk full\)/);
  assert.deepStrictEqual(await a.storage.local.get(null), {}, "the in-memory copy did not run ahead of the disk");
  assert.deepStrictEqual(a.events, []);
  failing = false;
  await a.storage.local.set({ k: 1 });
  assert.deepStrictEqual(disk, { k: 1 });
});
