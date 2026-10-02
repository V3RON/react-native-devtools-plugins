// The Tier-2 accept-and-grant shells (src/chrome-shim/browser-shells.js) — GitHub issue #4.
//
// What is under test is the boundary of an honest no-op:
//   - nothing here may throw SYNCHRONOUSLY, because an ESM worker's module-scope statements
//     run before anything can guard them and a TypeError kills the whole background context;
//   - no event here fires. A listener registered for a click or a keypress must stay quiet:
//     firing it runs the handler the extension wrote for a real user action, which is the
//     one thing worse than an API that does nothing;
//   - a call that claims something must fail rather than resolve. `sidePanel.open`'s promise
//     means "the panel is up", so it rejects; `contextMenus.create`'s id is the key this
//     registry really filed under, not a number standing in for a menu item;
//   - Chrome's own validations still reject, with Chromium's own message text, because a
//     rejected call is the extension learning about its own bug;
//   - what the caller configured reads back, so an extension's own bookkeeping is tested
//     rather than asserted;
//   - every missing-surface report happens once per key, so a rebuild loop cannot flood the
//     console.
const test = require("node:test");
const assert = require("node:assert");

const {
  CONTEXT_TYPES,
  ITEM_TYPES,
  createCommands,
  createContextMenus,
  createSidePanel,
} = require("../src/chrome-shim/browser-shells");
const { createChromeNamespace } = require("../src/chrome-shim");
const { createExtensionStorage, createMemoryBackend } = require("../src/chrome-shim/storage");
const { requiredPermission } = require("../src/shared/permissions");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const setup = (factories = {}) => {
  const lastError = { value: undefined };
  const reports = [];
  const onUnsupported = (message) => reports.push(message);
  return {
    lastError,
    reports,
    commands: createCommands({
      getManifest: factories.manifest || (() => ({})),
      onUnsupported,
      lastError,
    }),
    contextMenus: createContextMenus({ onUnsupported, lastError }),
    sidePanel: createSidePanel({ onUnsupported, lastError }),
  };
};

// ── the load-time contract ───────────────────────────────────────────────────
test("a worker's module-scope calls on all three namespaces do not throw", () => {
  // The exact shapes real extensions use at top level. Altair's background.js is one of
  // them; a TypeError here means the worker never loads at all.
  const chrome = createChromeNamespace({
    extensionId: "shells.local",
    getManifest: () => ({
      permissions: ["storage"],
      commands: { "open-panel": { description: "Open the panel", suggested_key: { default: "Alt+Shift+K" } } },
    }),
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  assert.doesNotThrow(() => {
    chrome.commands.onCommand.addListener(() => {});
    chrome.commands.getAll(() => {});
    chrome.contextMenus.ContextType;
    chrome.contextMenus.onClicked.addListener(() => {});
    chrome.contextMenus.create({ id: "one", title: "One", contexts: ["selection"] });
    chrome.contextMenus.removeAll(() => {});
    chrome.sidePanel.setOptions({ path: "panel.html" });
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    chrome.sidePanel.open({ tabId: 1 }).catch(() => {});
  }, "no synchronous throw, so an ESM worker survives its own top level");

  // And the shape is Chrome's shape: an extension feature-detecting by calling gets a
  // function, not a TypeError (docs/OVERVIEW.md).
  assert.deepEqual(
    ["onCommand", "getAll"].filter((name) => !chrome.commands[name]),
    [],
    "chrome.commands"
  );
  assert.deepEqual(
    [
      "onClicked",
      "onVisited",
      "ContextType",
      "ItemType",
      "create",
      "update",
      "remove",
      "removeAll",
    ].filter((name) => !chrome.contextMenus[name]),
    [],
    "chrome.contextMenus"
  );
  assert.deepEqual(
    [
      "onClicked",
      "setOptions",
      "getOptions",
      "setPanelBehavior",
      "getPanelBehavior",
      "open",
    ].filter((name) => !chrome.sidePanel[name]),
    [],
    "chrome.sidePanel"
  );
  for (const event of [
    chrome.commands.onCommand,
    chrome.contextMenus.onClicked,
    chrome.sidePanel.onClicked,
  ]) {
    assert.equal(typeof event.addListener, "function", "events stay registrable");
  }
});

test("none of the three is permission-gated, matching Chrome", () => {
  // Chrome needs no manifest permission for any of them; a gate here would break
  // extensions that legitimately use them with an otherwise minimal manifest.
  for (const api of ["commands", "contextMenus", "sidePanel"]) {
    assert.strictEqual(requiredPermission(api), null, `chrome.${api} needs no permission`);
  }
});

test("no event in these shells has a producer, so nothing fires", async () => {
  const s = setup({ manifest: () => ({ commands: { go: { description: "go" } } }) });
  let fired = [];
  s.commands.onCommand.addListener((...args) => fired.push(["onCommand", ...args]));
  s.contextMenus.onClicked.addListener((...args) => fired.push(["onClicked", ...args]));
  s.contextMenus.onVisited.addListener((...args) => fired.push(["onVisited", ...args]));
  s.sidePanel.onClicked.addListener((...args) => fired.push(["sidePanel.onClicked", ...args]));

  // Exercise every method, including the failure paths: an error path that "helpfully"
  // announced a click would show up here.
  await s.commands.getAll();
  await s.contextMenus.create({ id: "a", title: "A" });
  await s.contextMenus.update("a", { title: "B" });
  await s.contextMenus.remove("a");
  await s.contextMenus.removeAll();
  await s.contextMenus.create({ id: "c", title: "C" }).catch(() => {});
  await s.contextMenus.remove("never-created").catch(() => {});
  await s.sidePanel.setOptions({ path: "p.html" });
  await s.sidePanel.getOptions({ path: "p.html" });
  await s.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await s.sidePanel.open({ tabId: 3 }).catch(() => {});
  await tick();

  assert.deepEqual(fired, [], "no keystroke, click or menu was observed, so nothing is announced");
});

// ── chrome.commands ─────────────────────────────────────────────────────────
test("getAll answers from the manifest, which is a fact both Chrome and this shell can read", async () => {
  const s = setup({
    manifest: () => ({
      commands: {
        // Altair's own declaration.
        openDevTools: {
          suggested_key: { default: "Alt+Shift+A", mac: "Command+Shift+A" },
          description: "Open Altair's DevTools panel",
          global: true,
        },
        "no-keys": { description: "no shortcut declared" },
      },
    }),
  });
  const all = await s.commands.getAll();
  assert.deepEqual(Object.keys(all), ["openDevTools", "no-keys"]);
  assert.equal(all.openDevTools.name, "openDevTools", "Chrome's Command fields");
  assert.equal(all.openDevTools.description, "Open Altair's DevTools panel");
  assert.equal(all.openDevTools.global, true);
  assert.deepEqual(
    all.openDevTools.shortcuts,
    ["Alt+Shift+A"],
    "the DECLARED default: per-platform resolution is one of the things this shell cannot do"
  );
  assert.deepEqual(all["no-keys"].shortcuts, [], "no shortcut declared, none invented");
});

test("getAll answers undefined for an extension with no commands, like Chrome", async () => {
  const s = setup();
  assert.strictEqual(await s.commands.getAll(), undefined);
  assert.deepEqual(s.reports, [], "and nothing is claimed, so nothing has to be reported");
});

test("getAll reports the missing shortcut routing once, however often it is called", async () => {
  const s = setup({ manifest: () => ({ commands: { go: { description: "go" } } }) });
  for (let i = 0; i < 5; i++) {
    await s.commands.getAll();
  }
  assert.equal(s.reports.length, 1, "a polling extension does not flood the console");
  assert.match(s.reports[0], /routes no keyboard shortcut/);
  assert.match(s.reports[0], /onCommand will never fire/);
});

test("getAll works in callback style too, and hands back the same value", async () => {
  const s = setup({ manifest: () => ({ commands: { go: { description: "go" } } }) });
  const seen = await new Promise((resolve) => s.commands.getAll(resolve));
  assert.deepEqual(Object.keys(seen), ["go"]);
});

// ── chrome.contextMenus ─────────────────────────────────────────────────────
test("the registry round-trips: create, update, remove, removeAll all answer about real ids", async () => {
  const s = setup();
  const id = await s.contextMenus.create({ id: "inspect", title: "Inspect", contexts: ["page"] });
  assert.equal(id, "inspect", "the id the caller chose is the id it gets back");
  await s.contextMenus.create({ title: "generated me" });
  assert.equal(s.contextMenus._itemIds().length, 2);

  await s.contextMenus.update("inspect", { title: "Inspect deeper" });
  await s.contextMenus.remove("inspect");
  assert.deepEqual(s.contextMenus._itemIds(), ["rozenite-generated-0"], "remove removed that one");

  await s.contextMenus.removeAll();
  assert.deepEqual(s.contextMenus._itemIds(), [], "removeAll cleared the registry");
});

test("Chrome's own validations reject, with Chromium's own message text", async () => {
  const s = setup();
  const cases = [
    [
      () => s.contextMenus.create({ id: "no-title" }),
      /All menu items except for separators must have a title/,
    ],
    [() => s.contextMenus.create({ title: 42 }), /title must be a string/],
    [
      () => s.contextMenus.create({ title: "bad context", contexts: ["not_a_context"] }),
      /Values must be of type ContextType/,
    ],
    [
      () => s.contextMenus.create({ title: "bad type", type: "toggle" }),
      /Values must be of type ItemType/,
    ],
    [
      () => s.contextMenus.update("never-created", { title: "x" }),
      /Cannot find menu item with id never-created/,
    ],
    [
      () => s.contextMenus.remove("never-created"),
      /Cannot find menu item with id never-created/,
    ],
  ];
  for (const [call, expected] of cases) {
    await assert.rejects(call, expected);
  }
  assert.deepEqual(s.contextMenus._itemIds(), [], "a rejected create registered nothing");
});

test("a duplicate id is refused the way Chrome refuses it", async () => {
  const s = setup();
  await s.contextMenus.create({ id: "twice", title: "first" });
  await assert.rejects(
    () => s.contextMenus.create({ id: "twice", title: "second" }),
    /Cannot create item with duplicate id twice/,
    "quietly merging would leave the caller configuring a blend of two calls"
  );
  assert.deepEqual(s.contextMenus._itemIds(), ["twice"], "and the original is untouched");
});

test("a separator needs no title, because Chrome's rule is about visible text", async () => {
  const s = setup();
  await s.contextMenus.create({ id: "sep", type: "separator" });
  assert.deepEqual(s.contextMenus._itemIds(), ["sep"]);
});

test("a rejected contextMenus call sets lastError for a callback caller and clears it after", async () => {
  const s = setup();
  let during = "not called";
  let after = "not called";
  await new Promise((resolve) => {
    s.contextMenus.update("nope", { title: "x" }, () => {
      during = s.lastError.value;
      setTimeout(() => {
        after = s.lastError.value;
        resolve();
      }, 0);
    });
  });
  assert.match(String(during && during.message), /Cannot find menu item with id nope/);
  assert.strictEqual(after, undefined, "Chrome's scoping: not a sticky error");

  // Promise style: rejected, and lastError untouched outside a callback.
  await assert.rejects(() => s.contextMenus.remove("nope"));
  assert.strictEqual(s.lastError.value, undefined);
});

test("Chrome's enums are exported as Chrome spells them", () => {
  const menus = setup().contextMenus;
  assert.deepEqual(menus.ContextType, Object.fromEntries(CONTEXT_TYPES.map((v) => [v, v])));
  assert.deepEqual(menus.ItemType, Object.fromEntries(ITEM_TYPES.map((v) => [v, v])));
  assert.equal(menus.ContextType.page, "page");
  assert.equal(menus.ItemType.separator, "separator");
  assert.equal(menus.ACTION_MENU_TOP_LEVEL_LIMIT, 6);
});

// ── chrome.sidePanel ────────────────────────────────────────────────────────
test("setOptions / getOptions round-trip, per path and extension-scoped", async () => {
  const s = setup();
  await s.sidePanel.setOptions({ path: "panel.html", enabled: true });
  await s.sidePanel.setOptions({ enabled: false });

  assert.deepEqual(await s.sidePanel.getOptions({ path: "panel.html" }), {
    path: "panel.html",
    enabled: true,
  });
  // The extension-scoped answer is what was SET: Chrome's own default is `enabled: true`,
  // and reporting that default would claim a panel state this host does not have.
  assert.deepEqual(await s.sidePanel.getOptions(), { enabled: false });
  assert.deepEqual(s.sidePanel._state().paths, ["panel.html"]);
});

test("sidePanel.open fails, because its promise means a panel came up", async () => {
  const s = setup();
  await assert.rejects(
    () => s.sidePanel.open({ tabId: 7 }),
    /no side-panel drawer, so there is nothing to open/,
    "a resolve would let `await open(); sendMessage({to:'panel'})` hang forever"
  );
  assert.equal(s.reports.filter((m) => m.includes("sidePanel.open")).length, 1);
});

test("sidePanel.open keeps Chrome's own argument rejection", async () => {
  const s = setup();
  await assert.rejects(
    () => s.sidePanel.open({}),
    /At least one of `tabId` and `windowId` must be provided/
  );
});

test("setPanelBehavior keeps Chrome's key and reports an unknown one instead of rejecting", async () => {
  const s = setup();
  // A key Chrome's schema rejects is reported and ignored: inventing this shell's own
  // refusal would break code that works in Chrome.
  await s.sidePanel.setPanelBehavior({ openPanelOnActionClick: true, openOnWhatever: true });
  assert.deepEqual(await s.sidePanel.getPanelBehavior(), { openPanelOnActionClick: true });
  assert.equal(s.reports.filter((m) => m.includes("openOnWhatever")).length, 1);
  assert.match(s.reports.find((m) => m.includes("openOnWhatever")), /Chrome's schema rejects it/);
});

test("the missing panel surface is reported once per call site", async () => {
  const s = setup();
  for (let i = 0; i < 4; i++) {
    await s.sidePanel.setOptions({ path: `p${i}.html` });
    await s.sidePanel.open({ windowId: 1 }).catch(() => {});
  }
  assert.equal(s.reports.filter((m) => m.includes("sidePanel.setOptions")).length, 1);
  assert.equal(s.reports.filter((m) => m.includes("sidePanel.open")).length, 1);
});

test("a rejected sidePanel call sets lastError for the callback caller only", async () => {
  const s = setup();
  let during = "not called";
  await new Promise((resolve) => {
    s.sidePanel.open({}, () => {
      during = s.lastError.value;
      resolve();
    });
  });
  assert.match(String(during && during.message), /tabId.*windowId/s);
  assert.strictEqual(s.lastError.value, undefined, "cleared again, like Chrome's");
});

// ── what the page may see ───────────────────────────────────────────────────
test("the shells' diagnostics are non-enumerable, so contextBridge cannot hand them over", () => {
  // These three namespaces are UNGATED, so the gate's `_`-filter
  // (src/chrome-shim/permission-gate.js) is not in play: whatever is enumerable on them
  // reaches the page world through the preload's exposeInMainWorld clone.
  const s = setup({ manifest: () => ({ commands: { go: {} } }) });
  for (const [namespace, name] of [
    [s.commands, "_declaredNames"],
    [s.contextMenus, "_itemIds"],
    [s.sidePanel, "_state"],
  ]) {
    assert.equal(typeof namespace[name], "function", `${name} exists for tests`);
    assert.equal(
      Object.keys(namespace).includes(name),
      false,
      `${name} is not enumerable — JSON of the namespace cannot carry it to a page`
    );
    assert.equal(JSON.stringify(namespace).includes(name), false, "and not through JSON either");
  }
});
