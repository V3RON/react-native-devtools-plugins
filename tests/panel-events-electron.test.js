// Panel.onShown / onHidden across the real process boundary
// (docs/features/DEVTOOLS-PANELS.md#panel-events-panelonshown--onhidden): the production
// panel bridge, host routing, preload and shim, in a real Electron process.
//
// The harness's loopback page stands in for the frontend: it serves a FAKE
// /rozenite/ui/legacy/legacy.js (InspectorView + SimpleView, ~25 lines, the same
// wasShown/willHide/setHideOnDetach contract the real widget has) and a `.main-tabbed-pane`,
// so the PRODUCTION src/frontend/panel-bridge.js boots in it exactly as it does in the app.
// The page then plays the user: it selects tabs through the fake's `__select`.
// Run: npm test (needs a display; the Electron suites skip without Electron).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { electronBinary, runHarness, stageExtension } = require("./electron-runner");

// "exta" + "/panel.html" and "exta.panel" + "html" both used to be `ext.exta.panel.html`.
const A = "exta";
const B = "exta.panel";
const A1 = "ext.4.exta.panel.html";
const A2 = "ext.4.exta.slow.html";
const B1 = "ext.10.exta.panel.html";

const manifest = (name) =>
  JSON.stringify({
    name,
    version: "1.0",
    manifest_version: 3,
    devtools_page: "devtools.html",
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  });

const DEVTOOLS_HTML = `<!DOCTYPE html><html><head><script src="/dt.js"></script></head><body></body></html>`;

// One devtools page for both extensions; what differs is decided by its own hostname.
const DEVTOOLS_JS = `
const M = "__ROZENITE_PROBE__";
const ext = location.hostname;
const boot = Math.random().toString(36).slice(2);
const log = (o) => console.log(M + JSON.stringify({ ext, boot, ...o }));
const panels = chrome.devtools.panels;
log({
  ev: "start",
  handlePanelEvent: typeof chrome.handlePanelEvent,
  rawHandlePanelEvent: typeof (window.chromeElectron && window.chromeElectron.handlePanelEvent),
  themeAtStart: panels.themeName,
});
panels.setThemeChangeHandler((arg) => log({ ev: "theme", arg, live: panels.themeName }));
const make = (title, pagePath, tag) =>
  panels.create(title, "", pagePath, (panel) => {
    log({
      ev: "created",
      tag,
      keys: Object.keys(panel),
      themeAfterCreate: panels.themeName,
      themeDescriptorIsGetter: typeof Object.getOwnPropertyDescriptor(panels, "themeName").get,
    });
    panel.onShown.addListener((...args) => {
      const win = args[0];
      let info;
      try {
        info = {
          href: win.location.href,
          topIsSelf: win.top === win,
          readable: Boolean(win.document && win.document.body),
          token: win.__loadToken || null,
        };
      } catch (error) {
        info = { error: String(error) };
      }
      log({ ev: "shown", tag, argc: args.length, ...info });
      if (ext === ${JSON.stringify(B)}) {
        // another extension's panel frame, looked up by its (guessable) name
        let foreign = "none";
        try {
          const other = window.open("", ${JSON.stringify(A1)});
          foreign = other === null ? "null" : "window";
          if (other) {
            try { void other.document.body; foreign = "window-readable"; } catch { foreign = "window-opaque"; }
          }
        } catch (error) {
          foreign = "threw";
        }
        log({ ev: "foreign-open", foreign });
      }
    });
    panel.onHidden.addListener((...args) => log({ ev: "hidden", tag, argc: args.length }));
  });
if (ext === ${JSON.stringify(A)}) {
  make("A1", "/panel.html", "A1");
  make("A2", "/slow.html", "A2");
} else {
  make("B1", "html", "B1");
}
`;

const PANEL_HTML = `<!DOCTYPE html><html><head><script src="/panel.js"></script></head><body>panel</body></html>`;
// A fresh token per document: two shows reading the same token = the page was not reloaded.
const PANEL_JS = `
window.__loadToken = Math.random().toString(36).slice(2);
console.log("__ROZENITE_PROBE__" + JSON.stringify({ ev: "panel-load", ext: location.hostname, page: location.pathname, token: window.__loadToken }));
`;
// Blocks its own load for ~600 ms, so a show -> hide inside that window is "before load".
const SLOW_HTML = `<!DOCTYPE html><html><head><script src="/slow.js"></script></head><body>slow</body></html>`;
const SLOW_JS = `const t = Date.now(); while (Date.now() - t < 600) {}`;

// ── the fake frontend ───────────────────────────────────────────────────────
const FAKE_LEGACY = `
const views = new Map();
const shadow = () => document.getElementById("panels").shadowRoot;
class SimpleView {
  constructor(title, isWebView, id) {
    this.id = id;
    this.contentElement = document.createElement("div");
  }
  setHideOnDetach() { this.hideOnDetach = true; }
  wasShown() {}
  willHide() {}
}
let current = null;
window.__select = (id) => {
  if (current) {
    const old = views.get(current);
    old.contentElement.style.display = "none"; // hideOnDetach: kept in the tree, hidden
    old.willHide();
  }
  current = id;
  const view = views.get(id);
  if (!view.contentElement.isConnected) shadow().appendChild(view.contentElement);
  view.contentElement.style.display = "";
  view.wasShown();
};
window.__viewIds = () => [...views.keys()];
window.__addPlain = (id) => { const v = new SimpleView(id, false, id); views.set(id, v); };
export const View = { SimpleView };
export const InspectorView = {
  InspectorView: {
    instance: () => ({
      hasPanel: (id) => views.has(id),
      addPanel: (view) => views.set(view.id, view),
    }),
  },
};
`;

const hostPage = `<!DOCTYPE html>
<html><body>
<div class="main-tabbed-pane"></div>
<div id="panels"></div>
<script>
  document.getElementById("panels").attachShadow({ mode: "open" }); // like DevTools' shadow trees
  const say = (m) => console.log("[panel-test] " + m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    // wait for the production bridge to have created the panels
    for (let i = 0; i < 300 && !(window.__viewIds && window.__viewIds().length >= 3); i++) await sleep(100);
    say("panels " + window.__viewIds().join(","));
    // let the devtools pages finish their create callbacks
    await sleep(500);
    if (!sessionStorage.getItem("phase2")) {
      window.__addPlain("network");
      await window.__SHELL_HOST__.reportTheme("dark");
      await sleep(300);
      window.__select(${JSON.stringify(A1)});   await sleep(2500);
      window.__select("network");               await sleep(800);
      window.__select(${JSON.stringify(A1)});   await sleep(1500);
      window.__select("network");               await sleep(600);
      // show -> hide before the panel page has loaded
      window.__select(${JSON.stringify(A2)});   await sleep(150);
      window.__select("network");               await sleep(3000);
      window.__select(${JSON.stringify(B1)});   await sleep(2500);
      window.__select("network");               await sleep(600);
      say("phase1 done");
      sessionStorage.setItem("phase2", "1");
      location.reload();
    } else {
      window.__addPlain("network");
      window.__select(${JSON.stringify(A1)});   await sleep(2500);
      window.__select("network");               await sleep(600);
      say("done");
    }
  })();
</script>
</body></html>
`;

const binary = electronBinary();
const suite = binary ? test : test.skip;

suite("panel events: onShown(window)/onHidden through the production bridge in real Electron", { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-panel-events-"));
  t.after(() => process.env.KEEP_TEST_DIR || fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const extensionsDir = path.join(root, "extensions");
  const common = {
    "devtools.html": DEVTOOLS_HTML,
    "dt.js": DEVTOOLS_JS,
    "panel.js": PANEL_JS,
    "panel.html": PANEL_HTML,
  };
  stageExtension(extensionsDir, A, {
    ...common,
    "manifest.json": manifest("A"),
    "slow.html": SLOW_HTML,
    "slow.js": SLOW_JS,
  });
  stageExtension(extensionsDir, B, { ...common, "manifest.json": manifest("B"), html: PANEL_HTML });

  // The fake frontend's module, next to the host page (the harness serves this folder).
  const legacyDir = path.join(root, "run", "frontend", "rozenite", "ui", "legacy");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "legacy.js"), FAKE_LEGACY);

  const run = await runHarness({
    binary,
    root: path.join(root, "run"),
    extensionsDir,
    hostPage,
    waitFor: "[panel-test] done",
    settleMs: 600,
    extraArgs: ["--panel-bridge=on"],
    timeoutMs: 120000,
  });
  const probes = run.observed.filter((l) => l.kind === "probe" && l.data && l.data.ev).map((l) => l.data);
  const said = run.observed.filter((l) => l.kind === "console" && l.message.startsWith("[panel-test]")).map((l) => l.message);
  console.log(`  [electron/panel-events] ${JSON.stringify({ said, probes })}`);
  assert.ok(
    said.includes("[panel-test] done"),
    `the choreography finished: ${JSON.stringify({ code: run.code, said, output: run.output.slice(-1200) })}`
  );

  const ofExt = (ext, ev, tag) => probes.filter((p) => p.ext === ext && p.ev === ev && (!tag || p.tag === tag));
  const firstBoot = (ext) => (ofExt(ext, "start")[0] || {}).boot;

  // (g) the delivery hook is not in the page world; (0) theme getter survives create()
  for (const ext of [A, B]) {
    const [start] = ofExt(ext, "start");
    assert.ok(start, `${ext}: devtools page ran`);
    assert.equal(start.handlePanelEvent, "undefined", "handlePanelEvent is not exposed to the page");
    assert.equal(start.rawHandlePanelEvent, "undefined", "nor on the raw bridge handle");
  }
  const [created] = ofExt(A, "created", "A1");
  assert.ok(created, "panels.create called back");
  assert.ok(!created.keys.some((k) => k.startsWith("_") && k !== "_title" && k !== "_pagePath"), "no _panelId on the Panel");
  assert.ok(!created.keys.includes("_panelId"));
  assert.equal(created.themeDescriptorIsGetter, "function", "themeName is still a live getter after create is wrapped");
  const themeEvents = ofExt(A, "theme").filter((p) => p.boot === firstBoot(A));
  assert.ok(themeEvents.length >= 1 && themeEvents.every((p) => p.live === "dark" && p.arg === "dark"),
    `themeName tracks the theme handler after create: ${JSON.stringify(themeEvents)}`);

  // (a) onShown's argument is the panel page's real window
  const shownA1 = ofExt(A, "shown", "A1").filter((p) => p.boot === firstBoot(A));
  assert.equal(shownA1.length, 2, "A1 shown twice in phase 1");
  for (const shown of shownA1) {
    assert.equal(shown.argc, 1, "onShown gets the window");
    assert.equal(shown.href, "rozenite://exta/panel.html");
    assert.equal(shown.topIsSelf, false, "a frame, not a top-level window");
    assert.equal(shown.readable, true, "same-origin: the document is readable");
  }
  // (3) the panel page survives hide/show: same document both times, one load
  assert.ok(shownA1[0].token && shownA1[0].token === shownA1[1].token, "the panel page was not reloaded on re-show");
  assert.equal(probes.filter((p) => p.ev === "panel-load" && p.ext === A && p.page === "/panel.html").length, 2, "one load per frontend boot (phase 1 + phase 2), not per show");

  // (b) onHidden has no arguments, and shown/hidden strictly alternate
  const hiddenA1 = ofExt(A, "hidden", "A1").filter((p) => p.boot === firstBoot(A));
  assert.equal(hiddenA1.length, 2);
  assert.ok(hiddenA1.every((p) => p.argc === 0), "onHidden has 0 arguments");
  const order = probes
    .filter((p) => p.ext === A && p.tag === "A1" && p.boot === firstBoot(A) && (p.ev === "shown" || p.ev === "hidden"))
    .map((p) => p.ev);
  assert.deepEqual(order, ["shown", "hidden", "shown", "hidden"]);

  // (c) show -> hide before the page loaded emits nothing (neither event, even later)
  assert.deepEqual(ofExt(A, "shown", "A2").concat(ofExt(A, "hidden", "A2")), [], "no events for A2");

  // (d) another extension cannot reach this panel's frame by name, and nothing was opened
  const foreign = ofExt(B, "foreign-open").map((p) => p.foreign);
  assert.ok(foreign.length >= 1, "B looked");
  assert.ok(foreign.every((f) => f === "null" || f === "window-opaque"), `no usable window: ${foreign}`);
  assert.equal(run.observed.filter((l) => l.kind === "window-created").length, 0, "no browser window was created");

  // (e) the extension whose id used to collide hears only its OWN panel, once, and A heard
  // nothing of it
  const shownB = ofExt(B, "shown", "B1");
  assert.equal(shownB.length, 1, "B1 shown exactly once");
  assert.equal(shownB[0].href, "rozenite://exta.panel/html");
  assert.equal(ofExt(B, "hidden", "B1").length, 1);
  assert.equal(ofExt(A, "shown").filter((p) => p.href && p.href.includes("exta.panel/html")).length, 0);

  // (f) after a frontend reload the NEW devtools page gets events (registry replay + dedupe)
  const boots = [...new Set(ofExt(A, "start").map((p) => p.boot))];
  assert.equal(boots.length, 2, "devtools page was recreated by the reload");
  const afterReload = ofExt(A, "shown", "A1").filter((p) => p.boot === boots[1]);
  assert.equal(afterReload.length, 1, "the recreated devtools page hears onShown");
  assert.equal(afterReload[0].href, "rozenite://exta/panel.html");
  assert.equal(ofExt(A, "hidden", "A1").filter((p) => p.boot === boots[1]).length, 1);
  // ...and the OLD one hears nothing more once it is gone
  assert.equal(ofExt(A, "shown", "A1").filter((p) => p.boot === boots[0]).length, 2);
});
