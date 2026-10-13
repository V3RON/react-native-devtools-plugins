// The StorageArea rules (src/shared/storage-core.js): what get/set/remove/clear mean,
// independent of where the state lives.
const test = require("node:test");
const assert = require("node:assert");

const core = require("../src/shared/storage-core");

const area = (entries = {}) => new Map(Object.entries(entries));

test("get: absent keys are absent, defaults fill only the object form", () => {
  const map = area({ a: 1, b: { c: 2 } });
  assert.deepStrictEqual(core.get(map, null), { a: 1, b: { c: 2 } });
  assert.deepStrictEqual(core.get(map, "a"), { a: 1 });
  assert.deepStrictEqual(core.get(map, "missing"), {}, "not {missing: undefined}");
  assert.deepStrictEqual(core.get(map, ["a", "missing"]), { a: 1 });
  assert.deepStrictEqual(core.get(map, { a: 9, z: 9, u: undefined }), { a: 1, z: 9 });
  assert.throws(() => core.get(map, 5), /No matching signature/);
});

test("values are JSON copies in both directions", () => {
  const map = area();
  const input = { nested: { n: 1 }, drop: undefined, fn() {}, when: new Date(0), nan: NaN };
  core.set(map, "local", { v: input, gone: undefined });
  assert.deepStrictEqual(core.get(map, null), {
    v: { nested: { n: 1 }, when: "1970-01-01T00:00:00.000Z", nan: null },
  });
  input.nested.n = 2;
  assert.strictEqual(core.get(map, "v").v.nested.n, 1, "the caller holds no reference into the store");
  const out = core.get(map, "v");
  out.v.nested.n = 3;
  assert.strictEqual(core.get(map, "v").v.nested.n, 1, "nor into a result");
});

test("set: only keys that really changed are reported, with Chrome's shape", () => {
  const map = area({ keep: { x: 1 }, change: 1 });
  const changes = core.set(map, "local", { keep: { x: 1 }, change: 2, fresh: "f" });
  assert.deepStrictEqual(changes, {
    change: { oldValue: 1, newValue: 2 },
    fresh: { newValue: "f" },
  });
  assert.deepStrictEqual(core.set(map, "local", { change: 2 }), {}, "an identical write is no change");
  assert.throws(() => core.set(map, "local", "nope"), /No matching signature/);
  assert.throws(() => core.set(map, "local", [1]), /No matching signature/);
});

test("remove and clear report oldValue only, and only for keys that existed", () => {
  const map = area({ a: 1, b: 2, c: 3 });
  assert.deepStrictEqual(core.remove(map, ["a", "nope"]), { a: { oldValue: 1 } });
  assert.deepStrictEqual(core.remove(map, "b"), { b: { oldValue: 2 } });
  assert.deepStrictEqual(core.clear(map), { c: { oldValue: 3 } });
  assert.deepStrictEqual(core.clear(map), {}, "clearing nothing changes nothing");
  assert.throws(() => core.remove(map, 5), /No matching signature/);
});

test("getBytesInUse counts key + JSON value in UTF-8, per key or in total", () => {
  const map = area();
  core.set(map, "local", { ab: "é", n: 12 });
  const ab = "ab".length + JSON.stringify("é").length + 1; // é is 2 bytes in UTF-8
  const n = 1 + 2;
  assert.strictEqual(core.getBytesInUse(map, "ab"), ab);
  assert.strictEqual(core.getBytesInUse(map, ["n", "nope"]), n);
  assert.strictEqual(core.getBytesInUse(map, null), ab + n);
  assert.strictEqual(core.getBytesInUse(map, ["n", "n"]), n, "a repeated key counts once");
  assert.deepStrictEqual(core.getKeys(map), ["ab", "n"]);
});

test("quota: a write that would exceed it fails whole, with Chrome's text", () => {
  const session = area({ keep: "x" });
  assert.strictEqual(core.LIMITS.session.QUOTA_BYTES, 10485760);
  const big = "y".repeat(10485760);
  assert.throws(
    () => core.set(session, "session", { small: 1, big }),
    /Session storage quota bytes exceeded\. Values were not stored\./
  );
  assert.deepStrictEqual(core.get(session, null), { keep: "x" }, "not even the small half was stored");

  const local = area();
  assert.throws(() => core.set(local, "local", { big }), /QUOTA_BYTES quota exceeded/);
  // Replacing a key frees its old bytes first.
  core.set(local, "local", { k: "z".repeat(10485000) });
  assert.doesNotThrow(() => core.set(local, "local", { k: "w".repeat(10485000) }));
});

test("sync keeps Chrome's tighter limits", () => {
  const sync = area();
  assert.throws(() => core.set(sync, "sync", { k: "x".repeat(8200) }), /QUOTA_BYTES_PER_ITEM quota exceeded/);
  const items = {};
  for (let i = 0; i < 513; i += 1) {
    items[`k${i}`] = 1;
  }
  assert.throws(() => core.set(sync, "sync", items), /MAX_ITEMS quota exceeded/);
  const fat = {};
  for (let i = 0; i < 20; i += 1) {
    fat[`k${i}`] = "x".repeat(7000);
  }
  assert.throws(() => core.set(sync, "sync", fat), /QUOTA_BYTES quota exceeded/);
  assert.strictEqual(sync.size, 0, "and a failed write stores nothing");
});

test("key names that are special on plain objects are ordinary keys", () => {
  for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const map = area();
    const changes = core.set(map, "local", Object.fromEntries([[key, { v: 1 }]]));
    assert.deepStrictEqual(Object.keys(changes), [key], `${key}: reported as changed`);
    assert.deepStrictEqual(changes[key], { newValue: { v: 1 } });
    assert.deepStrictEqual(Object.keys(core.get(map, null)), [key], `${key}: get(null) returns it`);
    assert.deepStrictEqual(core.get(map, key)[key], { v: 1 });
    assert.deepStrictEqual(Object.keys(core.get(map, { [key]: 0 })), [key]);
    assert.deepStrictEqual(core.getKeys(map), [key]);
    assert.strictEqual(core.getBytesInUse(map, null), core.getBytesInUse(map, [key]));
    assert.strictEqual(Object.getPrototypeOf(core.get(map, null)), Object.prototype, "no prototype was replaced");
    assert.deepStrictEqual(Object.keys(core.set(map, "local", Object.fromEntries([[key, 2]]))), [key]);
    const removed = core.remove(map, [key]);
    assert.deepStrictEqual(Object.keys(removed), [key], `${key}: remove reports it`);
    assert.strictEqual(map.size, 0);
  }
  const map = area({ a: 1 });
  map.set("__proto__", 2);
  assert.deepStrictEqual(Object.keys(core.clear(map)).sort(), ["__proto__", "a"]);
});

test("the running byte total follows every write, and a shrinking write is never refused", () => {
  const map = area();
  core.set(map, "local", { a: "xx", b: "yyy" });
  core.remove(map, "a");
  core.set(map, "local", { b: "z" });
  const recomputed = [...map].reduce((n, [k, v]) => n + core.bytesOf(k, v), 0);
  assert.strictEqual(core.getBytesInUse(map, null), recomputed);
  core.clear(map);
  assert.strictEqual(core.getBytesInUse(map, null), 0);

  const over = new Map([["k", "x".repeat(core.LIMITS.local.QUOTA_BYTES + 50)]]);
  assert.throws(() => core.set(over, "local", { more: 1 }), /QUOTA_BYTES quota exceeded/);
  assert.doesNotThrow(() => core.set(over, "local", { k: "x".repeat(core.LIMITS.local.QUOTA_BYTES + 10) }));
});
