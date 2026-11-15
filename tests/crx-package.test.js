// .crx packages (src/electron/extensions/internal/registry/packages/crx-package.js): a
// signed CRX3 read in place. The shared contract is in tests/extension-packages.test.js;
// this file is what only a .crx has — the header, the id, hostile archive entries, large
// deflated ranges, and how the catalog finds one.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCrx, buildZip, makeKey } = require("./crx-fixture");
const { createCrxPackage } = require("../src/electron/extensions/internal/registry/packages/crx-package");
const { idFromPublicKey } = require("../src/electron/extensions/internal/registry/packages/crx");
const { settings: config } = require("../src/electron/extensions/internal/settings");
const packages = require("../src/electron/extensions/internal/registry/packages");
const { loadManifest } = require("../src/electron/extensions/internal/scheme/extension-server");

const MANIFEST = JSON.stringify({ name: "Packed", version: "1.2", manifest_version: 3 });

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-crx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const writeCrx = (dir, name, options) => {
  const built = buildCrx(options);
  const file = path.join(dir, name);
  fs.writeFileSync(file, built.bytes);
  return { ...built, file };
};

const readAll = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

test("the id is Chrome's: SHA-256 of the signing key, first 16 bytes as a–p", (t) => {
  for (const algorithm of ["rsa", "ecdsa"]) {
    const key = makeKey(algorithm);
    const { file } = writeCrx(tempDir(t), "a.crx", { key, entries: [{ name: "manifest.json", data: MANIFEST }] });
    const pkg = createCrxPackage({ file });
    assert.match(pkg.id, /^[a-p]{32}$/, algorithm);
    assert.equal(pkg.id, key.id, `${algorithm}: the id the key gives`);
    assert.equal(idFromPublicKey(key.spki), key.id);
    assert.equal(JSON.parse(pkg.readText("manifest.json")).name, "Packed");
  }
});

test("a file that does not verify, or is not a CRX3, is not loaded", (t) => {
  const dir = tempDir(t);
  const entries = [{ name: "manifest.json", data: MANIFEST }];
  const flip = (bytes) => {
    const copy = Buffer.from(bytes);
    copy[copy.length - 30] ^= 0xff; // inside the archive, after signing
    return copy;
  };
  const cases = [
    ["changed after signing", buildCrx({ entries, tamper: flip }).bytes, /does not verify/],
    ["no magic", Buffer.from("PK\x03\x04 not a crx at all"), /no "Cr24" magic/],
    ["too short", Buffer.from("Cr24"), /too short/],
  ];
  const crx2 = Buffer.alloc(16);
  crx2.write("Cr24", 0, "binary");
  crx2.writeUInt32LE(2, 4);
  cases.push(["CRX2", crx2, /CRX2 is not supported/]);
  // Signed by one key, claiming another key's id.
  const signer = makeKey();
  const impostor = makeKey();
  cases.push([
    "an id the key does not give",
    buildCrx({ entries, key: { ...signer, crxId: impostor.crxId } }).bytes,
    /no signing key matches the crx_id/,
  ]);
  for (const [label, bytes, reason] of cases) {
    const file = path.join(dir, `${label.replace(/\W+/g, "-")}.crx`);
    fs.writeFileSync(file, bytes);
    assert.throws(() => createCrxPackage({ file }), reason, label);
  }
});

test("hostile or ambiguous archive entries are never reachable", (t) => {
  const { file } = writeCrx(tempDir(t), "h.crx", {
    entries: [
      { name: "manifest.json", data: MANIFEST },
      { name: "../escape.js", data: "evil" },
      { name: "/absolute.js", data: "evil" },
      { name: "a/../b.js", data: "evil" },
      { name: "win\\path.js", data: "evil" },
      { name: "link.js", data: "/etc/passwd", symlink: true },
      { name: "_metadata/verified_contents.json", data: "[]" },
      { name: "ok/real.js", data: "fine" },
    ],
  });
  const pkg = createCrxPackage({ file });
  assert.equal(pkg.problems.length, 4, pkg.problems.join("\n"));
  assert.equal(pkg.entry("b.js").kind, "missing", "a/../b.js does not alias b.js");
  assert.equal(pkg.entry("escape.js").kind, "missing");
  assert.equal(pkg.entry("absolute.js").kind, "missing");
  assert.equal(pkg.entry("link.js").kind, "refused", "a symlink entry is refused, not followed");
  assert.match(pkg.entry("link.js").reason, /symlink/);
  assert.equal(pkg.read("link.js"), null);
  assert.equal(pkg.entry("_metadata/verified_contents.json").kind, "refused", "Chrome reserves _metadata");
  assert.equal(pkg.readText("ok/real.js"), "fine");
});

test("a corrupt entry reads as nothing, not as garbage", (t) => {
  const archive = buildZip([
    { name: "manifest.json", data: MANIFEST },
    { name: "a.txt", data: "abcdefgh", method: 0 },
  ]);
  // Change a stored byte and re-sign, so the signature passes and only the CRC catches it.
  const corrupted = Buffer.from(archive);
  corrupted[corrupted.indexOf("abcdefgh")] = 0x58;
  const { file } = writeCrx(tempDir(t), "c.crx", { archive: corrupted });
  const pkg = createCrxPackage({ file });
  assert.equal(pkg.entry("a.txt").kind, "file");
  assert.equal(pkg.read("a.txt"), null, "the CRC mismatch is a refusal to read");
});

test("ranges of a large deflated entry inflate from the start and keep only the range", async (t) => {
  const big = Buffer.alloc(6 * 1024 * 1024);
  for (let index = 0; index < big.length; index += 1) big[index] = (index * 31 + (index >> 10)) & 0xff;
  const { file } = writeCrx(tempDir(t), "big.crx", {
    entries: [
      { name: "manifest.json", data: MANIFEST },
      { name: "big.bin", data: big, method: 8 },
      { name: "stored.bin", data: big.subarray(0, 4096), method: 0 },
    ],
  });
  const pkg = createCrxPackage({ file });
  const start = 5 * 1024 * 1024 + 7;
  const end = start + 99999;
  const opened = pkg.open("big.bin", { start, end });
  assert.equal(opened.size, big.length);
  assert.ok((await readAll(opened.stream)).equals(big.subarray(start, end + 1)), "the late slice of the deflated entry");
  assert.ok((await readAll(pkg.open("big.bin", { start: 0, end: 9 }).stream)).equals(big.subarray(0, 10)), "an early one stops early");
  assert.ok(
    (await readAll(pkg.open("stored.bin", { start: 100, end: 199 }).stream)).equals(big.subarray(100, 200)),
    "a stored entry is a slice of the file"
  );
});

test("the catalog installs .crx files next to folders: folders win, then the first file per id", (t) => {
  const dir = tempDir(t);
  const previous = config.extensionsDir;
  config.extensionsDir = dir;
  t.after(() => {
    config.extensionsDir = previous;
  });
  const packed = writeCrx(dir, "b-packed.crx", { entries: [{ name: "manifest.json", data: MANIFEST }] });
  // The same id again, later by name: skipped.
  writeCrx(dir, "c-duplicate.crx", {
    key: packed.key,
    entries: [{ name: "manifest.json", data: JSON.stringify({ name: "Duplicate", version: "9" }) }],
  });
  // A folder that claims a .crx's id wins over it.
  const shadowed = writeCrx(dir, "d-shadowed.crx", { entries: [{ name: "manifest.json", data: MANIFEST }] });
  fs.mkdirSync(path.join(dir, shadowed.id));
  fs.writeFileSync(path.join(dir, shadowed.id, "manifest.json"), JSON.stringify({ name: "Folder", version: "1" }));
  // Not loaded: a broken file and a symlinked one.
  fs.writeFileSync(path.join(dir, "e-broken.crx"), "Cr24 nope");
  fs.symlinkSync(packed.file, path.join(dir, "f-linked.crx"));
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  t.after(() => {
    console.warn = warn;
  });

  const listed = packages.listPackages().map((pkg) => [pkg.id, pkg.source]);
  assert.deepStrictEqual(listed, [
    [shadowed.id, "directory"],
    [packed.id, "crx"],
  ]);
  assert.equal(packages.packageFor(packed.id).source, "crx");
  assert.equal(loadManifest(packed.id).name, "Packed", "the first file by name provides the id");
  assert.equal(loadManifest(shadowed.id).name, "Folder");
  assert.strictEqual(packages.packageFor(packed.id), packages.packageFor(packed.id), "parsed once per file version");
  assert.ok(warnings.some((line) => /c-duplicate\.crx is not loaded/.test(line)), warnings.join("\n"));
  assert.ok(warnings.some((line) => /d-shadowed\.crx is not loaded: the folder/.test(line)), warnings.join("\n"));
  assert.ok(warnings.some((line) => /e-broken\.crx is not loaded/.test(line)), warnings.join("\n"));
  assert.ok(!warnings.some((line) => /f-linked/.test(line)), "a symlinked .crx is not even considered");
});
