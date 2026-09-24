// chrome.devtools shim tests (src/chrome-shim/devtools.js):
// panels.create semantics (callback vs promise style, host notification),
// inspectedWindow.eval degradation, and the inert-shape stub rule.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createDevtools, tabIdFor } = require("../src/chrome-shim/devtools");

const makeDevtools = () => {
  const created = [];
  const { namespace } = createDevtools({
    extensionId: "my-ext",
    onPanelCreated: (p) => created.push(p),
  });
  return { devtools: namespace, created };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("panels.create (callback style) notifies the host and calls back with a Panel", async () => {
  const { devtools, created } = makeDevtools();
  let panel = null;
  const returned = devtools.panels.create("Osudio", null, "/panel.html", (p) => {
    panel = p;
  });
  assert.strictEqual(returned, undefined, "callback style returns nothing");
  assert.deepStrictEqual(created, [{ title: "Osudio", pagePath: "/panel.html" }]);
  await tick();
  assert.ok(panel, "callback fired");
  assert.ok(panel.onShown.hasListener !== undefined, "Panel event shape");
  assert.ok(panel.onHidden.hasListener !== undefined);
  assert.doesNotThrow(() => panel.setWidth(400));
});

test("panels.create tolerates a null callback (real extensions do this)", async () => {
  const { devtools, created } = makeDevtools();
  const result = devtools.panels.create("X", null, "/p.html", null);
  assert.strictEqual(created.length, 1);
  await result; // null cb -> promise style; must resolve with a Panel
  assert.ok(result instanceof Promise);
});

test("panels.create (promise style, 3 args) resolves with a Panel", async () => {
  const { devtools } = makeDevtools();
  const panel = await devtools.panels.create("Altair GraphQL", "icon.png", "/panel.html");
  assert.strictEqual(panel._title, "Altair GraphQL");
  assert.strictEqual(panel._pagePath, "/panel.html");
});

test("inspectedWindow.eval degrades honestly: isError pair, callback + promise", async () => {
  const { devtools } = makeDevtools();
  let cbArgs = null;
  devtools.inspectedWindow.eval("1+1", (result, info) => {
    cbArgs = [result, info];
  });
  await tick();
  assert.strictEqual(cbArgs[0], undefined);
  assert.strictEqual(cbArgs[1].isError, true);

  const [result, info] = await devtools.inspectedWindow.eval("1+1");
  assert.strictEqual(result, undefined);
  assert.strictEqual(info.isError, true);
});

test("out-of-scope APIs exist as inert shapes (stubbing rule)", async () => {
  const { devtools } = makeDevtools();

  // devtools.network: events never fire, getHAR is an empty-but-valid HAR
  let fired = 0;
  devtools.network.onRequestFinished.addListener(() => fired++);
  const har = await new Promise((resolve) => devtools.network.getHAR(resolve));
  assert.deepStrictEqual(JSON.parse(har).log.entries, []);
  assert.strictEqual(fired, 0);
  devtools.network.onNavigated.addListener(() => fired++);
  await tick();
  assert.strictEqual(fired, 0);

  // panels.elements sidebar panes: inert but addressable
  const pane = await new Promise((resolve) =>
    devtools.panels.elements.createSidebarPane("State", resolve)
  );
  assert.doesNotThrow(() => {
    pane.setTitle("x");
    pane.setExpression("a");
    pane.setObject({});
  });

  // theme + misc namespaces exist without throwing
  assert.strictEqual(devtools.panels.themeName, "dark");
  devtools.panels.themeChanged.addListener(() => {});
  devtools.commands.onCommand.addListener(() => {});
  assert.doesNotThrow(() => devtools.panels.openResource("a.js", 1));
  assert.ok(devtools.inspectedWindow.tabId > 0);
});

test("inspectedWindow.tabId is a stable positive int per extension", () => {
  assert.strictEqual(tabIdFor("altair"), tabIdFor("altair"));
  assert.notStrictEqual(tabIdFor("altair"), tabIdFor("graphql"));
  assert.ok(Number.isInteger(tabIdFor("graphql")) && tabIdFor("graphql") > 0);
});

test("chrome.tabs inert shell: shapes exist, query answers empty", async () => {
  const { createTabs } = require("../src/chrome-shim/tabs");
  const tabs = createTabs();
  const viaCb = await new Promise((resolve) => tabs.query({}, resolve));
  assert.deepStrictEqual(viaCb, []);
  assert.deepStrictEqual(await tabs.query({ active: true }), []);
  tabs.onUpdated.addListener(() => {});
  assert.strictEqual(tabs.TAB_ID_NONE, -1);
  await tabs.sendMessage(1, "hi"); // resolves undefined, like a failed Chrome send
});
