// chrome.storage shared per extension, in a REAL Electron process.
//
// The unit suites (storage-core, storage-service, storage-shim) cover the rules; this
// file covers the claim only the whole shell can make: a value one context writes is
// seen by the OTHER contexts of the same extension — a panel page, a second panel page,
// the background worker — with the right onChanged in each, and a second extension
// running in the same shell sees none of it.
//
//   store-a.local   panel.html (writer) + panel2.html (listener) + bg.js (worker)
//   store-b.local   panel.html (writer of its own values) + bg.js (worker)
//
// Every context prints `STORE:<who>:<what>`; the host page embeds the panels as iframes
// (what src/frontend/panel-bridge.js does for real panels).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { electronBinary, runHarness, stageExtension } = require("./electron-runner");

const binary = electronBinary();
const suite = binary ? test : test.skip;

const manifest = (name) =>
  JSON.stringify({
    name,
    version: "1.0.0",
    manifest_version: 3,
    background: { service_worker: "bg.js" },
    permissions: ["storage"],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  });

// The worker listens on all three event shapes and answers one question: what does the
// extension's session storage hold, as seen from here?
const workerScript = (who) => `
const say = (m) => console.log("STORE:${who}-bg:" + m);
chrome.storage.onChanged.addListener((changes, area) =>
  say("onChanged:" + area + ":" + JSON.stringify(changes)));
chrome.storage.session.onChanged.addListener((changes) =>
  say("session.onChanged:" + JSON.stringify(changes)));
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message === "ping") { respond("pong"); return; }
  if (message === "read") {
    chrome.storage.session.get(null).then((all) => respond(all));
    return true;
  }
});
say("ready");
`;

// One page script for every panel; the role comes from the file name.
const panelScript = (who) => `
const role = location.pathname.replace(/^\\//, "").replace(".html", "");
const say = (m) => console.log("STORE:${who}-" + role + ":" + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.storage.onChanged.addListener((changes, area) =>
  say("onChanged:" + area + ":" + JSON.stringify(changes)));

const ask = (message) => new Promise((resolve) =>
  chrome.runtime.sendMessage(message, (reply) => resolve(reply)));

(async () => {
  if (role !== "panel") { say("listening"); return; }
  // Wait for the worker (it registers late, like any other context).
  for (let i = 0; i < 100 && (await ask("ping")) !== "pong"; i += 1) { await sleep(100); }
  ${who === "A" ? "await sleep(600);" : "await sleep(2200);"}

  await chrome.storage.session.set({ shared: { n: 1, from: "${who}-panel" } });
  await chrome.storage.session.set({ shared: { n: 1, from: "${who}-panel" } }); // no change: no event
  await chrome.storage.local.set({ kept: "${who}" });
  await chrome.storage.session.set({ temp: 1 });
  await chrome.storage.session.remove("temp");

  say("worker-sees:" + JSON.stringify(await ask("read")));
  say("own-read:" + JSON.stringify(await chrome.storage.session.get(null)));
  say("bytes:" + (await chrome.storage.session.getBytesInUse(null)));
  say("quota:" + chrome.storage.session.QUOTA_BYTES);
  try {
    await chrome.storage.session.set({ big: "x".repeat(11 * 1024 * 1024) });
    say("quota-error:none");
  } catch (error) {
    say("quota-error:" + error.message);
  }
  say("after-quota:" + JSON.stringify(Object.keys(await chrome.storage.session.get(null))));
  say("done");
})();
`;

const page = (script) =>
  `<!DOCTYPE html><html><body><script src="${script}"></script></body></html>`;

suite("session storage is shared per extension and its changes reach every context", { timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-storage-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const extensionsDir = path.join(root, "extensions");
  for (const who of ["A", "B"]) {
    stageExtension(extensionsDir, `store-${who.toLowerCase()}.local`, {
      "manifest.json": manifest(`Store ${who}`),
      "bg.js": workerScript(who),
      "panel.js": panelScript(who),
      "panel.html": page("panel.js"),
      "panel2.html": page("panel.js"),
    });
  }

  const run = await runHarness({
    binary,
    root: path.join(root, "run"),
    extensionsDir,
    backgroundHost: true,
    hostPage: `<!DOCTYPE html><html><body>
  <iframe src="rozenite://store-a.local/panel.html" width="300" height="200"></iframe>
  <iframe src="rozenite://store-a.local/panel2.html" width="300" height="200"></iframe>
  <iframe src="rozenite://store-b.local/panel.html" width="300" height="200"></iframe>
</body></html>`,
    waitFor: "STORE:B-panel:done",
    timeoutMs: 120000,
    settleMs: 2500,
  });

  const said = run.observed
    .filter((l) => l.kind === "console" || l.kind === "worker-console")
    .map((l) => String(l.message))
    .filter((m) => m.startsWith("STORE:"));
  console.log(`  [electron/storage] exit=${run.code}\n  ${said.join("\n  ")}`);
  const of = (prefix) => said.filter((m) => m.startsWith(`STORE:${prefix}:`)).map((m) => m.slice(prefix.length + 7));

  const changesIn = (prefix, kind) =>
    of(prefix)
      .filter((m) => m.startsWith(`${kind}:`))
      .map((m) => m.slice(kind.length + 1));

  // ── the worker reads what the panel wrote (the value is shared, not per-frame) ──
  const workerSees = of("A-panel").find((m) => m.startsWith("worker-sees:"));
  assert.ok(workerSees, `panel A heard back from the worker: ${JSON.stringify(of("A-panel"))}`);
  assert.deepStrictEqual(JSON.parse(workerSees.slice("worker-sees:".length)), {
    shared: { n: 1, from: "A-panel" },
  });

  // ── every context of A heard the same changes, once each, in the same order ────
  const expectedA = [
    'session:{"shared":{"newValue":{"n":1,"from":"A-panel"}}}',
    'local:{"kept":{"newValue":"A"}}',
    'session:{"temp":{"newValue":1}}',
    'session:{"temp":{"oldValue":1}}',
  ];
  for (const who of ["A-panel", "A-panel2", "A-bg"]) {
    assert.deepStrictEqual(
      changesIn(who, "onChanged"),
      expectedA,
      `${who} saw exactly the real changes (the identical second set() and the over-quota set() raised nothing)`
    );
  }
  assert.deepStrictEqual(
    changesIn("A-bg", "session.onChanged"),
    expectedA.filter((m) => m.startsWith("session:")).map((m) => m.slice("session:".length)),
    "the per-area storage.session.onChanged carries the change alone, without the area name"
  );

  // ── quota: Chrome's error, and the failed write changed nothing ────────────────
  assert.deepStrictEqual(
    of("A-panel").filter((m) => m.startsWith("quota")),
    ["quota:10485760", "quota-error:Session storage quota bytes exceeded. Values were not stored."]
  );
  assert.deepStrictEqual(
    JSON.parse(of("A-panel").find((m) => m.startsWith("after-quota:")).slice("after-quota:".length)),
    ["shared"]
  );

  // ── isolation: B has its own session storage and heard none of A's changes ────
  assert.ok(of("B-panel").includes("done"), "extension B's panel ran to completion");
  const bWorkerSees = JSON.parse(
    of("B-panel").find((m) => m.startsWith("worker-sees:")).slice("worker-sees:".length)
  );
  assert.deepStrictEqual(bWorkerSees, { shared: { n: 1, from: "B-panel" } }, "B's worker sees only B's value");
  for (const who of ["B-panel", "B-bg"]) {
    const all = of(who).join("\n");
    assert.ok(!all.includes("A-panel"), `${who} never heard about extension A's storage:\n${all}`);
    assert.ok(!all.includes('"kept":{"newValue":"A"}'), `${who} heard none of A's local writes`);
  }
  assert.ok(
    changesIn("B-bg", "onChanged").some((m) => m.includes("B-panel")),
    "while B's own worker did hear B's panel"
  );
  for (const who of ["A-panel", "A-panel2", "A-bg"]) {
    assert.ok(!of(who).join("\n").includes("B-panel"), `${who} never heard about extension B's storage`);
  }
});
