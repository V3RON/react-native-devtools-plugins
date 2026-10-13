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
    return { frameKey, storage: shim, events, lastError: () => current };
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

/** A manual clock: timers run only when the test says so. */
const manualTimers = () => {
  const pending = new Map();
  let next = 1;
  return {
    setTimer: (fn) => {
      pending.set(next, fn);
      return next++;
    },
    clearTimer: (id) => pending.delete(id),
    pending: () => pending.size,
    fire: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
  };
};

const memoryDisk = () => {
  const disk = new Map(); // `${ext}/${area}` -> object
  const saves = [];
  const opened = [];
  return {
    disk,
    saves,
    opened,
    openPersistence: (extensionId, area) => {
      opened.push(`${extensionId}/${area}`);
      return {
        load: () => disk.get(`${extensionId}/${area}`) || {},
        save: (items) => {
          saves.push(`${extensionId}/${area}`);
          disk.set(`${extensionId}/${area}`, JSON.parse(JSON.stringify(items)));
        },
      };
    },
  };
};

test("local/sync persist through the injected store, session never does", async () => {
  const d = memoryDisk();
  d.disk.set("ext.a/local", { before: "restart" });
  const timers = manualTimers();

  const first = world({ openPersistence: d.openPersistence, ...timers });
  const a = first.context("ext.a");
  assert.deepStrictEqual(await a.storage.local.get(null), { before: "restart" }, "what an earlier run saved is there");
  await a.storage.local.set({ "dotted.key": 1 });
  await a.storage.session.set({ volatile: 1 });
  first.service.flush();
  assert.deepStrictEqual(d.disk.get("ext.a/local"), { before: "restart", "dotted.key": 1 });
  assert.ok(!d.opened.some((entry) => entry.endsWith("/session")), "session never touches the disk");

  // "Restart the shell": a new service over the same disk.
  const second = world({ openPersistence: d.openPersistence, ...timers });
  const b = second.context("ext.a");
  assert.deepStrictEqual(await b.storage.local.get(null), { before: "restart", "dotted.key": 1 });
  assert.deepStrictEqual(await b.storage.session.get(null), {}, "session is cleared by the restart");
});

test("writes are announced at once and persisted write-behind, coalesced per area", async () => {
  const d = memoryDisk();
  const timers = manualTimers();
  const { context, service } = world({ openPersistence: d.openPersistence, ...timers });
  const a = context("ext.a");
  const b = context("ext.a");

  for (let i = 1; i <= 20; i += 1) {
    await a.storage.local.set({ counter: i });
  }
  await a.storage.sync.set({ other: 1 });
  assert.strictEqual(a.events.length, 21, "every write was announced immediately");
  assert.deepStrictEqual(await b.storage.local.get("counter"), { counter: 20 }, "and is readable at once");
  assert.deepStrictEqual(d.saves, [], "nothing hit the disk yet");
  assert.strictEqual(timers.pending(), 2, "one pending save per (extension, area), not per write");

  timers.fire();
  assert.deepStrictEqual(d.saves.sort(), ["ext.a/local", "ext.a/sync"], "one save each");
  assert.deepStrictEqual(d.disk.get("ext.a/local"), { counter: 20 });

  // A read-only call or a no-op write schedules nothing.
  await a.storage.local.get(null);
  await a.storage.local.set({ counter: 20 });
  assert.strictEqual(timers.pending(), 0);

  // flush() writes what is pending right now (quit), and cancels the timer.
  await a.storage.local.set({ counter: 21 });
  assert.strictEqual(timers.pending(), 1);
  service.flush();
  assert.strictEqual(timers.pending(), 0);
  assert.deepStrictEqual(d.disk.get("ext.a/local"), { counter: 21 });
  service.flush();
  assert.strictEqual(d.saves.length, 3, "a clean area is not rewritten");
});

test("a failing disk is logged and retried, and does not undo or reject the write", async () => {
  let failing = true;
  const disk = {};
  const logged = [];
  const timers = manualTimers();
  const { context, service } = world({
    log: (message) => logged.push(message),
    ...timers,
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
  await a.storage.local.set({ k: 1 });
  timers.fire();
  assert.match(logged.join("\n"), /could not persist ext\.a\/local: disk full/);
  assert.deepStrictEqual(await a.storage.local.get(null), { k: 1 }, "the write stands and was announced");
  assert.strictEqual(a.events.length, 1);
  failing = false;
  service.flush();
  assert.deepStrictEqual(disk, { k: 1 }, "the next flush retries");
});

// What the old per-frame shim left on disk for set({"settings.theme": "dark", plain: 1}).
const OLD_FILE = { settings: { theme: "dark" }, plain: 1 };

const legacyWorld = () => {
  const d = memoryDisk();
  d.disk.set("ext.a/local", JSON.parse(JSON.stringify(OLD_FILE)));
  const meta = {};
  const w = world({
    ...manualTimers(),
    openPersistence: (extensionId, area) => ({
      ...d.openPersistence(extensionId, area),
      legacy: { snapshot: JSON.parse(JSON.stringify(OLD_FILE)), shadow: [] },
      saveMeta: (value) => Object.assign(meta, value),
    }),
  });
  return { ...w, a: w.context("ext.a"), meta };
};

test("a legacy area answers dotted keys from the pre-upgrade snapshot", async () => {
  const { a } = legacyWorld();
  assert.deepStrictEqual(await a.storage.local.get("settings.theme"), { "settings.theme": "dark" });
  assert.deepStrictEqual(await a.storage.local.get({ "settings.theme": "x", "settings.none": "d" }), {
    "settings.theme": "dark",
    "settings.none": "d",
  });
  assert.deepStrictEqual(await a.storage.local.get("settings"), { settings: { theme: "dark" } }, "the nested form too");
});

test("a legacy dotted key that was written or removed is never resolved from the snapshot again", async () => {
  const { a, service, meta } = legacyWorld();
  // remove of a fallback-resolved key: an event, and it stays gone.
  await a.storage.local.remove("settings.theme");
  assert.deepStrictEqual(a.events.at(-1), { area: "local", changes: { "settings.theme": { oldValue: "dark" } } });
  assert.deepStrictEqual(await a.storage.local.get("settings.theme"), {});
  const count = a.events.length;
  await a.storage.local.remove("settings.theme");
  await sleep(5);
  assert.strictEqual(a.events.length, count, "removing it again is no change");

  // set -> remove -> get must not bring the old value back either.
  await a.storage.local.set({ "settings.theme": "light" });
  assert.deepStrictEqual(await a.storage.local.get("settings.theme"), { "settings.theme": "light" });
  await a.storage.local.remove("settings.theme");
  assert.deepStrictEqual(await a.storage.local.get("settings.theme"), {}, "the pre-upgrade value did not resurrect");

  service.flush();
  assert.deepStrictEqual(meta.shadow, ["settings.theme"], "the shadow set is persisted next to the snapshot");
});

test("data written after the upgrade is never read as a path", async () => {
  const { a } = legacyWorld();
  await a.storage.local.set({ cfg: { mode: "x" } });
  assert.deepStrictEqual(await a.storage.local.get("cfg.mode"), {});
  // Changing the legacy parent object ends the fallback for paths below it.
  await a.storage.local.set({ settings: { theme: "light", extra: 1 } });
  assert.deepStrictEqual(await a.storage.local.get("settings.theme"), {});
  assert.deepStrictEqual(await a.storage.local.get("settings"), { settings: { theme: "light", extra: 1 } });
});

test("the real electron-store persistence: old file, snapshot fallback, shadow state across restarts", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { electronStorePersistence } = require("../src/main/storage-service");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-storage-legacy-"));
  const worlds = [];
  const launch = (extensionId = "ext.a") => {
    const w = world({ openPersistence: electronStorePersistence({ cwd }) });
    worlds.push(w.service);
    return w.context(extensionId);
  };
  try {
    fs.writeFileSync(path.join(cwd, "extension-ext.a-local.json"), JSON.stringify(OLD_FILE));

    const first = launch();
    assert.deepStrictEqual(await first.storage.local.get(["settings.theme", "plain"]), {
      "settings.theme": "dark",
      plain: 1,
    });
    assert.deepStrictEqual(Object.keys(await first.storage.local.get(null)).sort(), ["plain", "settings"]);
    await first.storage.local.remove("settings.theme");
    await first.storage.local.set({ fresh: 1, cfg: { mode: "x" } });
    worlds.forEach((service) => service.flush());
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, "extension-ext.a-local.json"), "utf8"));
    assert.deepStrictEqual(Object.keys(onDisk).sort(), ["cfg", "fresh", "plain", "settings"], "the data file holds the extension's keys only");

    // Restart: the shadow persisted, so the removed key stays removed; post-upgrade data is not a path.
    const second = launch();
    assert.deepStrictEqual(await second.storage.local.get("settings.theme"), {}, "removed stays removed after a restart");
    assert.deepStrictEqual(await second.storage.local.get("cfg.mode"), {});
    assert.deepStrictEqual(await second.storage.local.get("fresh"), { fresh: 1 });
    // Another pre-upgrade path (never touched) is still resolvable.
    fs.writeFileSync(path.join(cwd, "extension-ext.b-local.json"), JSON.stringify({ a: { b: 1, c: 2 } }));
    const b1 = launch("ext.b");
    await b1.storage.local.remove("a.b");
    worlds.forEach((service) => service.flush());
    const b2 = launch("ext.b");
    assert.deepStrictEqual(await b2.storage.local.get(["a.b", "a.c"]), { "a.c": 2 });

    // A brand-new area has no fallback, even after its first data is on disk.
    const fresh = launch("ext.new");
    await fresh.storage.local.set({ nested: { x: 1 } });
    worlds.forEach((service) => service.flush());
    assert.deepStrictEqual(await launch("ext.new").storage.local.get("nested.x"), {});

    // The extension's own key namespace is untouched: any key name survives a restart.
    await fresh.storage.local.set({ __rozenite_storage_format__: "mine" });
    worlds.forEach((service) => service.flush());
    assert.deepStrictEqual(await launch("ext.new").storage.local.get("__rozenite_storage_format__"), {
      __rozenite_storage_format__: "mine",
    });
  } finally {
    worlds.forEach((service) => service.flush());
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a failed meta write on first open loses nothing: data survives, meta is retried before data", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { electronStorePersistence } = require("../src/main/storage-service");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-storage-meta-"));
  const dataFile = path.join(cwd, "extension-ext.a-local.json");
  const metaFile = path.join(cwd, "extension-ext.a-local.meta.json");
  fs.writeFileSync(dataFile, JSON.stringify(OLD_FILE));

  // The REAL electron-store, except that writing a *.meta.json fails (ENOSPC-like) while
  // `failMeta` is set.
  let failMeta = true;
  const RealStore = require("electron-store").default;
  class FlakyStore extends RealStore {
    set store(value) {
      if (failMeta && this.path.endsWith(".meta.json")) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      super.store = value;
    }
    get store() {
      return super.store;
    }
  }
  const services = [];
  try {
    const launch = () => {
      const w = world({ openPersistence: electronStorePersistence({ cwd, Store: FlakyStore }) });
      services.push(w.service);
      return w.context("ext.a");
    };
    const first = launch();
    assert.deepStrictEqual(await first.storage.local.get("plain"), { plain: 1 }, "the area still reads its data");
    assert.deepStrictEqual(Object.keys(await first.storage.local.get(null)).sort(), ["plain", "settings"]);
    assert.deepStrictEqual(await first.storage.local.get("settings.theme"), { "settings.theme": "dark" }, "and is still classified legacy");
    await first.storage.local.set({ n: 1 });

    // Disk still refuses the meta file: data must NOT be written ahead of it.
    services.forEach((service) => service.flush());
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(dataFile, "utf8")), OLD_FILE, "data untouched while meta cannot be written");

    // The disk recovers: meta first, then data.
    failMeta = false;
    services.forEach((service) => service.flush());
    assert.strictEqual(JSON.parse(fs.readFileSync(metaFile, "utf8")).legacy.snapshot.settings.theme, "dark");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(dataFile, "utf8")), { ...OLD_FILE, n: 1 });

    const second = launch();
    assert.deepStrictEqual(await second.storage.local.get(["n", "plain", "settings.theme"]), {
      n: 1,
      plain: 1,
      "settings.theme": "dark",
    });
  } finally {
    failMeta = false;
    services.forEach((service) => service.flush());
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an area whose file could not be read is not cached, so no write can overwrite it", async () => {
  let failing = true;
  const saved = [];
  const timers = manualTimers();
  const { context, service } = world({
    ...timers,
    openPersistence: () => ({
      load: () => {
        if (failing) {
          throw new Error("EIO: read failed");
        }
        return { precious: 1 };
      },
      save: (items) => saved.push(items),
    }),
  });
  const a = context("ext.a");
  await assert.rejects(a.storage.local.get(null), /could not read local storage \(EIO: read failed\)/);
  await assert.rejects(a.storage.local.set({ n: 1 }), /could not read local storage/);
  service.flush();
  timers.fire();
  assert.deepStrictEqual(saved, [], "nothing was ever written over the unread file");
  assert.deepStrictEqual(a.events, []);

  failing = false;
  assert.deepStrictEqual(await a.storage.local.get(null), { precious: 1 }, "the next call reads it again");
  await a.storage.local.set({ n: 1 });
  service.flush();
  assert.deepStrictEqual(saved, [{ precious: 1, n: 1 }]);
});

test("legacy data over the new limits can shrink but not grow", async () => {
  // 20 items of ~7 KB: 140 KB, over sync's 100 KB, as the unlimited old shim allowed.
  const legacy = {};
  for (let i = 0; i < 20; i += 1) {
    legacy[`k${i}`] = "x".repeat(7000);
  }
  const { context } = world({ openPersistence: () => ({ load: () => legacy, save() {} }) });
  const a = context("ext.a");
  await assert.rejects(a.storage.sync.set({ extra: "y".repeat(100) }), /QUOTA_BYTES quota exceeded/);
  await a.storage.sync.set({ k0: "tiny" });
  await a.storage.sync.remove(["k1", "k2"]);
  await a.storage.sync.set({ k3: "x".repeat(6000) });
  assert.strictEqual((await a.storage.sync.get("k0")).k0, "tiny", "writes that shrink the area succeed");
  assert.ok((await a.storage.sync.getBytesInUse(null)) < 100000 + 20 * 7010, "and the running total tracked them");
});
