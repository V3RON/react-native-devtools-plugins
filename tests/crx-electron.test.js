// A .crx in the extensions folder, served in place to a real Electron frame: no unpack
// step, Chrome's id from the signing key, the extension's own files (deflated and stored)
// and byte ranges straight out of the archive.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { electronBinary, runHarness, consoleLines } = require("./electron-runner");
const { buildCrx } = require("./crx-fixture");

const binary = electronBinary();
const suite = binary ? test : test.skip;

const probe = `
const report = (key, value) => console.log("CRX:" + key + "=" + JSON.stringify(value));
(async () => {
  report("id", { id: chrome.runtime.id, host: location.hostname, url: chrome.runtime.getURL("x") });
  report("manifest", chrome.runtime.getManifest().name);
  const deflated = await fetch("notes/deflated.txt");
  report("deflated", { status: deflated.status, type: deflated.headers.get("content-type"), body: await deflated.text() });
  const ranged = await fetch("stored.bin", { headers: { Range: "bytes=3-6" } });
  report("ranged", { status: ranged.status, range: ranged.headers.get("content-range"), body: await ranged.text() });
  const reserved = await fetch("_metadata/verified_contents.json");
  report("reserved", reserved.status);
  report("done", true);
})().catch((error) => { report("error", String(error)); report("done", true); });
`;

suite("a .crx is served in place to a real Electron frame", { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-crx-electron-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const extensionsDir = path.join(root, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  const { bytes, id } = buildCrx({
    entries: [
      { name: "manifest.json", data: JSON.stringify({ name: "Packed panel", version: "1", manifest_version: 3 }) },
      { name: "panel.html", data: '<!DOCTYPE html><html><head><script src="panel.js"></script></head><body></body></html>' },
      { name: "panel.js", data: probe },
      { name: "notes/", data: "" },
      { name: "notes/deflated.txt", data: "deflated text", method: 8 },
      { name: "stored.bin", data: "0123456789", method: 0 },
      { name: "_metadata/verified_contents.json", data: "[]" },
    ],
  });
  fs.writeFileSync(path.join(extensionsDir, "packed.crx"), bytes);

  const run = await runHarness({
    binary,
    root: path.join(root, "run"),
    extensionsDir,
    hostPage: `<!DOCTYPE html><html><body><iframe src="rozenite://${id}/panel.html"></iframe></body></html>`,
    extensionId: id,
    waitFor: "CRX:done=",
    timeoutMs: 90000,
    settleMs: 300,
  });
  const lines = consoleLines(run.observed).map(String);
  const reported = {};
  for (const line of lines) {
    const match = /CRX:(\w+)=(.*)$/.exec(line);
    if (match && !(match[1] in reported)) reported[match[1]] = JSON.parse(match[2]);
  }
  const dump = `exit ${run.code}\n${lines.slice(-20).join("\n")}`;

  assert.strictEqual(reported.error, undefined, `no probe error\n${dump}`);
  assert.deepStrictEqual(
    reported.id,
    { id, host: id, url: `rozenite://${id}/x` },
    `the frame runs as the id the signing key gives\n${dump}`
  );
  assert.strictEqual(reported.manifest, "Packed panel", `getManifest reads the archive\n${dump}`);
  assert.deepStrictEqual(
    reported.deflated,
    { status: 200, type: "text/plain; charset=utf-8", body: "deflated text" },
    `a deflated entry is served inflated, with its type\n${dump}`
  );
  assert.deepStrictEqual(
    reported.ranged,
    { status: 206, range: "bytes 3-6/10", body: "3456" },
    `a stored entry serves a byte range\n${dump}`
  );
  assert.strictEqual(reported.reserved, 404, `Chrome's _metadata is never served\n${dump}`);
});
