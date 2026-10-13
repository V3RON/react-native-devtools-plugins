// Panel.onShown / onHidden (docs/features/DEVTOOLS-PANELS.md): the shim half
// (src/chrome-shim/devtools.js handlePanelEvent) and the host half
// (src/main/panel-host.js setPanelVisible / isFrontendFrame) — who hears a panel's
// visibility, who may report it, and that a reload or a repeat report cannot
// produce a phantom event. The live end-to-end run is documented in
// docs/evidence/panel-events/.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createDevtools } = require("../src/chrome-shim/devtools");
const panelHost = require("../src/main/panel-host");
const { panelIdFor } = require("../src/shared/protocol");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const makeShim = (extensionId = "my-ext") => {
  const errors = [];
  const shim = createDevtools({
    extensionId,
    onPanelCreated: () => {},
    logger: { error: (...args) => errors.push(args), warn: () => {}, log: () => {} },
  });
  const create = async (path) => {
    let panel;
    shim.namespace.panels.create("P", null, path, (p) => {
      panel = p;
    });
    await tick();
    return panel;
  };
  return { shim, create, errors };
};

test("a host panel event fires onShown / onHidden of the panel created at that pagePath only", async () => {
  const { shim, create } = makeShim();
  const mine = await create("/panel.html");
  const other = await create("/other.html");
  const seen = [];
  mine.onShown.addListener((...args) => seen.push(["mine.shown", args.length]));
  mine.onHidden.addListener(() => seen.push("mine.hidden"));
  other.onShown.addListener(() => seen.push("other.shown"));

  shim.handlePanelEvent({ pagePath: "/panel.html", event: "shown" });
  shim.handlePanelEvent({ pagePath: "/panel.html", event: "hidden" });
  assert.deepStrictEqual(seen, [["mine.shown", 0], "mine.hidden"]);
});

test("junk panel events are ignored and a throwing listener does not stop the next", async () => {
  const { shim, create, errors } = makeShim();
  const panel = await create("/panel.html");
  const seen = [];
  panel.onShown.addListener(() => {
    throw new Error("bad listener");
  });
  panel.onShown.addListener(() => seen.push("second"));

  shim.handlePanelEvent(null);
  shim.handlePanelEvent({ pagePath: "/panel.html", event: "exploded" });
  shim.handlePanelEvent({ pagePath: "/missing.html", event: "shown" });
  assert.deepStrictEqual(seen, []);

  shim.handlePanelEvent({ pagePath: "/panel.html", event: "shown" });
  assert.strictEqual(errors.length, 1, "the bad listener is reported");
});

test("a Panel names its iframe with the same id the host derives", async () => {
  const { create } = makeShim("sample-extension");
  const panel = await create("/panel.html");
  assert.strictEqual(panel._panelId, panelIdFor("sample-extension", "/panel.html"));
  assert.strictEqual(panel._panelId, "ext.sample-extension.panel.html");
});

// ── host half ────────────────────────────────────────────────────────────────
const register = (extensionId, pagePath, send) =>
  panelHost.addPanel({ extensionId, title: "T", pagePath, owner: send ? { send } : undefined });

test("setPanelVisible delivers one event per real transition, to the creating frame only", () => {
  const a = [];
  const b = [];
  register("ext-a", "/p.html", (d) => a.push(d));
  register("ext-b", "/p.html", (d) => b.push(d));
  const id = panelIdFor("ext-a", "/p.html");

  assert.strictEqual(panelHost.setPanelVisible(id, true), true);
  assert.strictEqual(panelHost.setPanelVisible(id, true), false, "repeat shown is not an event");
  assert.strictEqual(panelHost.setPanelVisible(id, false), true);
  assert.strictEqual(panelHost.setPanelVisible(id, false), false, "repeat hidden is not an event");

  assert.deepStrictEqual(a, [
    { kind: "panel", payload: { pagePath: "/p.html", event: "shown" } },
    { kind: "panel", payload: { pagePath: "/p.html", event: "hidden" } },
  ]);
  assert.deepStrictEqual(b, [], "another extension's frame hears nothing");
});

test("an unknown or non-string panelId is not an event", () => {
  assert.strictEqual(panelHost.setPanelVisible("ext.nobody.nothing", true), false);
  assert.strictEqual(panelHost.setPanelVisible(undefined, true), false);
  assert.strictEqual(panelHost.setPanelVisible({ toString: () => "x" }, true), false);
});

test("a re-created panel (reloaded devtools page) moves the seat; the old frame goes quiet", () => {
  const stale = [];
  const fresh = [];
  register("ext-c", "/p.html", (d) => stale.push(d));
  // the devtools page reloads and calls panels.create again: dedupe keeps the tab,
  // the new frame becomes the owner
  register("ext-c", "/p.html", (d) => fresh.push(d));
  const id = panelIdFor("ext-c", "/p.html");

  panelHost.setPanelVisible(id, true);
  assert.deepStrictEqual(stale, []);
  assert.strictEqual(fresh.length, 1);
});

test("only the frontend's own main frame may report visibility", () => {
  const frontend = { on: () => {}, isDestroyed: () => false, mainFrame: { id: "main" } };
  panelHost.attach(frontend);
  const frame = frontend.mainFrame;
  assert.strictEqual(panelHost.isFrontendFrame({ sender: frontend, senderFrame: frame }), true);
  // an extension iframe inside the SAME webContents is not the main frame
  assert.strictEqual(
    panelHost.isFrontendFrame({ sender: frontend, senderFrame: { id: "ext-iframe" } }),
    false
  );
  // nor is any other webContents (e.g. a background context's window)
  assert.strictEqual(
    panelHost.isFrontendFrame({ sender: { mainFrame: frame }, senderFrame: frame }),
    false
  );
});
