// chrome.devtools.panels.themeName / themeChanged across the real process boundary
// (docs/features/DEVTOOLS-PANELS.md#theme-themename--themechanged): the frontend's
// THEME_REPORT -> main -> RUNTIME_DELIVER -> page world chain, and the synchronous boot
// hint on the frame URL. The unit suites (tests/theme.test.js) prove the rules; this
// proves what a page script actually sees.
//
// The harness's loopback page stands in for the frontend (`--frontend-host=on` names it
// as the frontend window), and acts as the panel bridge: it creates the extension
// iframes and reports the theme through the same `window.__SHELL_HOST__` the real
// bridge uses. Run: npm test (needs a display; the Electron suites skip without Electron).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { electronBinary, runHarness, stageExtension } = require("./electron-runner");

const ID = "theme.probe";

const MANIFEST = JSON.stringify({
  name: "Theme Probe",
  version: "1.0",
  manifest_version: 3,
  devtools_page: "probe.html",
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
});

// A CLASSIC script in <head>, no defer. The harness holds every RUNTIME_REGISTER reply back
// (--register-delay-ms), so whatever this reads at script time provably did not come from
// the host's reply: it is the URL hint, or the shim's own "default".
const PROBE_HTML = `<!DOCTYPE html>
<html><head><script src="/probe.js"></script></head><body>probe</body></html>
`;

const PROBE_JS = `
const M = "__ROZENITE_PROBE__";
const id = new URLSearchParams(location.search).get("id");
const log = (o) => console.log(M + JSON.stringify({ probe: id, ...o }));
const panels = chrome.devtools.panels;
log({
  phase: "sync",
  theme: panels.themeName,
  search: location.search,
  hash: location.hash,
  panelKeys: Object.getOwnPropertyNames(panels),
  hostBridge: typeof window.__SHELL_HOST__,
});
panels.themeChanged.addListener((name) => log({ phase: "changed", arg: name, theme: panels.themeName }));
setTimeout(() => log({ phase: "later", theme: panels.themeName }), 2500);
// MessageSender.url must be the address the extension asked for, hint or no hint.
chrome.runtime.onMessage.addListener((message, sender) => {
  log({ phase: "msg", from: sender.url });
});
if (id === "A") {
  setTimeout(() => chrome.runtime.sendMessage({ hi: 1 }).catch(() => {}), 3000);
}
`;

const hostPage = `<!DOCTYPE html>
<html><body>
<script>
  const say = (m) => console.log("[theme-test] " + m);
  const report = (name) =>
    window.__SHELL_HOST__.reportTheme(name).then((r) => say("report " + name + " -> " + JSON.stringify(r)));
  const frame = (src, delay) =>
    setTimeout(() => {
      const f = document.createElement("iframe");
      f.src = src;
      document.body.appendChild(f);
    }, delay);
  // Like the real bridge: the theme is reported BEFORE any extension frame exists.
  report("light") // not a Chrome name: refused
    .then(() => report("dark"))
    .then(() => {
      // A: the bridge's own hint, plus the extension's own query (encoded, repeated) and hash.
      frame("rozenite://${ID}/probe.html?id=A&q=a%20b+c&q=2&__rozenite_theme=dark#frag", 0);
      // C: a forged hint, which is not one of Chrome's two names.
      frame("rozenite://${ID}/probe.html?id=C&__rozenite_theme=evil", 0);
      // B: no hint at all (a frame the bridge did not create): learns it from the reply.
      frame("rozenite://${ID}/probe.html?id=B", 1000);
    });
  setTimeout(() => report("default"), 4000);
  // G: the hint says dark while the HOST is "default" — only the hint can explain a "dark"
  // read before the (held-back) reply, and the reply must then win.
  frame("rozenite://${ID}/probe.html?id=G&__rozenite_theme=dark", 4500);
  setTimeout(() => say("done"), 8300);
</script>
</body></html>
`;

const binary = electronBinary();
const suite = binary ? test : test.skip;

suite("theme: host broadcast, boot hint and page-world surface in a real Electron process", { timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-theme-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const extensionsDir = path.join(root, "extensions");
  stageExtension(extensionsDir, ID, {
    "manifest.json": MANIFEST,
    "probe.html": PROBE_HTML,
    "probe.js": PROBE_JS,
  });

  const run = await runHarness({
    binary,
    root: path.join(root, "run"),
    extensionsDir,
    hostPage,
    extensionId: ID,
    waitFor: "[theme-test] done",
    settleMs: 400,
    extraArgs: ["--frontend-host=on", "--register-delay-ms=1200"],
    timeoutMs: 90000,
  });
  const probes = run.observed.filter((l) => l.kind === "probe" && l.data && l.data.probe);
  const of = (id, phase) => probes.filter((l) => l.data.probe === id && l.data.phase === phase).map((l) => l.data);
  const said = run.observed
    .filter((l) => l.kind === "console" && l.message.startsWith("[theme-test]"))
    .map((l) => l.message);
  console.log(`  [electron/theme] ${JSON.stringify({ said, probes: probes.map((l) => l.data) })}`);

  // (d) the hint is what a page script sees SYNCHRONOUSLY, and it is gone from the address
  // while the extension's own query and hash survive byte for byte.
  const [aSync] = of("A", "sync");
  assert.ok(aSync, "frame A's head script ran");
  assert.equal(aSync.theme, "dark", "hinted theme at script time, before any reply");
  assert.equal(aSync.search, "?id=A&q=a%20b+c&q=2", "extension query untouched, hint stripped");
  assert.equal(aSync.hash, "#frag");

  // G isolates the hint: host is "default", reply held back, hint "dark" -> the head script
  // reads "dark" (nothing else could say so); the reply then overrides it with the host's truth.
  const [gSync] = of("G", "sync");
  assert.ok(gSync, "frame G ran");
  assert.equal(gSync.theme, "dark", "only the hint can explain this");
  assert.equal(gSync.search, "?id=G");
  assert.deepEqual(of("G", "changed").map((d) => d.arg), ["default"], "reply overrides hint");
  assert.equal(of("G", "later")[0].theme, "default");

  // a forged hint is refused (and still stripped); nothing was known yet, so "default"
  const [cSync] = of("C", "sync");
  assert.equal(cSync.search, "?id=C");
  assert.equal(cSync.theme, "default");
  assert.ok(probes.every((l) => l.data.theme !== "evil"), "a forged hint never reaches themeName");

  // (b) internal helpers are not on the page-visible surface
  for (const sync of [aSync, cSync, gSync]) {
    assert.ok(sync.panelKeys.includes("themeName") && sync.panelKeys.includes("themeChanged"));
    assert.ok(!sync.panelKeys.includes("_getThemeName"), "no internal helper on panels");
    assert.equal(sync.hostBridge, "undefined", "the frontend-only bridge is not in extension frames");
  }

  // the host refused a name that is not Chrome's
  assert.ok(said.includes('[theme-test] report light -> {"ok":true,"changed":false}'), said.join("|"));
  assert.ok(said.includes('[theme-test] report dark -> {"ok":true,"changed":true}'), said.join("|"));

  // (a) after the broadcast: A already showed dark (no event); C and B learn dark from the
  // reply, then everyone gets the real change
  assert.deepEqual(of("A", "changed").map((d) => d.arg), ["default"]);
  assert.deepEqual(of("C", "changed").map((d) => d.arg), ["dark", "default"]);
  const [bSync] = of("B", "sync");
  assert.ok(bSync, "frame B ran");
  assert.equal(bSync.search, "?id=B", "no hint, nothing rewritten");
  assert.equal(bSync.theme, "default");
  assert.equal(of("B", "later")[0].theme, "dark", "a frame without a hint learns the theme from the register reply");
  assert.deepEqual(of("B", "changed").map((d) => [d.arg, d.theme]), [
    ["dark", "dark"],
    ["default", "default"],
  ]);

  // the hint never reaches another frame as MessageSender.url
  const received = probes.filter((l) => l.data.phase === "msg").map((l) => l.data.from);
  assert.ok(received.length >= 1, "A's message reached a sibling frame");
  for (const from of received) {
    assert.ok(!from.includes("__rozenite_theme"), `sender.url carries no hint: ${from}`);
    assert.ok(from.startsWith(`rozenite://${ID}/probe.html?id=A&q=a%20b+c&q=2`), from);
  }
});
