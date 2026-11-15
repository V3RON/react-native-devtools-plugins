// Extension packages (src/electron/extensions/internal/registry/packages): one read-only
// view of an extension's files, addressed by inner path. Every implementation answers the
// same contract, so the contract is one suite run against each of them.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createDirectoryPackage,
  createMemoryPackage,
  createCrxPackage,
  innerPathOf,
} = require("../src/electron/extensions/internal/registry/packages");
const { buildCrx } = require("./crx-fixture");
const { contentTypeFor } = require("../src/electron/extensions/internal/scheme/mime");

const FILES = {
  "manifest.json": '﻿{"name":"x"}',
  "panel/index.html": "<p>hi</p>",
  "panel/app.js": "0123456789",
  "_locales/en/messages.json": "{}",
  "_locales/pt_BR/messages.json": "{}",
};

const readAll = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const implementations = {
  directory: (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-pkg-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    return createDirectoryPackage({ id: "x", root });
  },
  memory: () => createMemoryPackage({ id: "x", files: FILES, mtimeMs: 7 }),
  // A signed .crx read in place; one entry stored, the rest deflated.
  crx: (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-pkg-crx-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { bytes } = buildCrx({
      entries: Object.entries(FILES).map(([name, data]) => ({ name, data, method: name.endsWith(".js") ? 0 : 8 })),
    });
    const file = path.join(dir, "x.crx");
    fs.writeFileSync(file, bytes);
    return createCrxPackage({ file });
  },
};

for (const [kind, make] of Object.entries(implementations)) {
  test(`${kind} package: entry, list and read answer by inner path`, (t) => {
    const pkg = make(t);
    assert.equal(pkg.id, kind === "crx" ? pkg.id : "x", "a .crx is named by its key");
    assert.equal(pkg.source, kind);
    assert.equal(pkg.entry("panel/app.js").kind, "file");
    assert.equal(pkg.entry("panel/app.js").size, 10);
    assert.equal(typeof pkg.entry("panel/app.js").mtimeMs, "number");
    assert.equal(pkg.entry("/panel/app.js").kind, "file", "a leading / is the extension's root");
    assert.equal(pkg.entry("panel/../panel/app.js").kind, "file", "dot segments collapse inside the root");
    assert.equal(pkg.entry("panel").kind, "directory");
    assert.equal(pkg.entry("nope.js").kind, "missing");
    assert.deepEqual(
      (pkg.list("_locales") || []).map((entry) => [entry.name, entry.kind]).sort(),
      [["en", "directory"], ["pt_BR", "directory"]]
    );
    assert.equal(pkg.list("panel/app.js"), null, "a file is not listable");
    assert.equal(pkg.read("panel/app.js").toString(), "0123456789");
    assert.equal(pkg.readText("manifest.json"), '{"name":"x"}', "readText strips the BOM");
    assert.equal(pkg.read("nope.js"), null);
  });

  test(`${kind} package: nothing outside the root or reserved is reachable`, (t) => {
    const pkg = make(t);
    for (const name of ["../x/manifest.json", "../../etc/passwd", "__rozenite_background__", "__rozenite_i18n__"]) {
      assert.equal(pkg.entry(name).kind, "refused", name);
      assert.match(pkg.entry(name).reason, /^refused/, name);
      assert.equal(pkg.read(name), null, name);
      assert.equal(pkg.open(name), null, name);
    }
  });

  test(`${kind} package: open streams the whole file or an inclusive byte range`, async (t) => {
    const pkg = make(t);
    const whole = pkg.open("panel/app.js");
    assert.equal(whole.size, 10);
    assert.equal(await readAll(whole.stream), "0123456789");
    const range = pkg.open("panel/app.js", { start: 2, end: 5 });
    assert.equal(range.size, 10, "size is the file's, not the range's");
    assert.equal(await readAll(range.stream), "2345");
    assert.equal(await readAll(pkg.open("panel/app.js", { start: 8, end: 99 }).stream), "89", "end is clamped");
    assert.equal(await readAll(pkg.open("panel/app.js", { start: 12 }).stream), "", "past the end is empty");
    assert.equal(pkg.open("nope.js"), null);
  });
}

test("the directory package refuses everything under a symlinked root", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-pkg-link-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "real"));
  fs.writeFileSync(path.join(base, "real", "a.js"), "1");
  fs.symlinkSync(path.join(base, "real"), path.join(base, "linked"));
  const pkg = createDirectoryPackage({ id: "linked", root: path.join(base, "linked") });
  assert.equal(pkg.entry("a.js").kind, "refused");
  assert.match(pkg.entry("a.js").reason, /cannot be resolved/);
  assert.equal(pkg.read("a.js"), null);
});

test("the inner-path rule normalizes like path.resolve inside a root, and refuses climbing out", () => {
  assert.equal(innerPathOf(""), "");
  assert.equal(innerPathOf("/a//b/./c.js"), "a/b/c.js");
  assert.equal(innerPathOf("a/../b.js"), "b.js");
  assert.equal(innerPathOf(".."), null);
  assert.equal(innerPathOf("a/../../b"), null);
  assert.equal(innerPathOf("a\0b"), null);
});

test("content types come from the name; an unknown one is left to Chromium's sniffing", () => {
  assert.equal(contentTypeFor("panel/index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("worker.mjs"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("a/B.JS"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("lib.wasm"), "application/wasm");
  assert.equal(contentTypeFor("icon.svg"), "image/svg+xml; charset=utf-8");
  assert.equal(contentTypeFor("clip.mp4"), "video/mp4");
  assert.equal(contentTypeFor("html"), null, "no extension: sniffed, as file:// did");
  assert.equal(contentTypeFor(".hidden"), null);
  assert.equal(contentTypeFor("data.unknownext"), null);
});

test("host code reads extension files only through a package", () => {
  // The modules that used to open extension files themselves. A `require("fs")` coming
  // back to one of them is a read that bypasses the package's containment rule.
  const internal = path.join(__dirname, "..", "src", "electron", "extensions", "internal");
  for (const rel of [
    "scheme/extension-server.js",
    "registry/i18n-host.js",
    "registry/extensions.js",
    "content/content-scripts.js",
    "broker/ipc.js",
  ]) {
    const code = fs.readFileSync(path.join(internal, rel), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /require\(\s*["'](node:)?fs["']\s*\)/, `${rel} reads the filesystem directly`);
  }
});

test("one byte range is honoured; anything else is the whole file or a 416", () => {
  const { parseRange } = require("../src/electron/extensions/internal/scheme/range");
  const partial = (start, end) => ({ kind: "partial", start, end });
  assert.deepEqual(parseRange(undefined, 10), { kind: "whole" });
  assert.deepEqual(parseRange(null, 10), { kind: "whole" });
  assert.deepEqual(parseRange("bytes=2-5", 10), partial(2, 5));
  assert.deepEqual(parseRange("bytes=2-", 10), partial(2, 9));
  assert.deepEqual(parseRange("bytes=8-99", 10), partial(8, 9), "the end is clamped to the file");
  assert.deepEqual(parseRange("bytes=-3", 10), partial(7, 9), "a suffix is the last bytes");
  assert.deepEqual(parseRange("bytes=-30", 10), partial(0, 9), "a suffix longer than the file is all of it");
  assert.deepEqual(parseRange("BYTES = 0 - 0", 10), partial(0, 0));
  assert.deepEqual(parseRange("bytes=10-", 10), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=-0", 10), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=0-", 0), { kind: "unsatisfiable" }, "an empty file has no bytes to range");
  for (const ignored of ["bytes=0-1,4-5", "items=0-1", "bytes=5-2", "bytes=-", "nonsense"]) {
    assert.deepEqual(parseRange(ignored, 10), { kind: "whole" }, ignored);
  }
});
