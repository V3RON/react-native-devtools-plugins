// chrome.tabs — the one-tab model (src/chrome-shim/tabs.js + tab-model.js) and the
// host's open policy (src/main/tab-host.js). GitHub issue #4.
//
// Everything the model cannot know is injected: the inspected target's real
// url/title, the capability to open something, the capability to close it. No test
// here opens a window, launches a browser, or touches the filesystem.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createTabs, UNKNOWN_URL } = require("../src/chrome-shim/tabs");
const { queryMatcher } = require("../src/chrome-shim/tab-model");
const { createChromeNamespace } = require("../src/chrome-shim");
const { createMemoryBackend, createExtensionStorage } = require("../src/chrome-shim/storage");
const { createGrantGate } = require("../src/shared/permissions");
const { createTabHost } = require("../src/main/tab-host");
const { tabIdFor } = require("../src/chrome-shim/devtools");

const ATTACHED = { attached: true, url: "ws://10.0.0.5:8081/debugger-proxy?role=debugger", title: "RnApp" };

const make = (deps = {}) => {
  const notes = [];
  const tabs = createTabs({
    tabId: 4242,
    getTarget: () => ATTACHED,
    resolveUrl: (inner) => `rozenite://probe.local/${String(inner).replace(/^\//, "")}`,
    onUnsupported: (message) => notes.push(message),
    ...deps,
  });
  return { tabs, notes };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("query / get / update answer with the SAME tab, and its id round-trips", async () => {
  const { tabs } = make();
  const [one] = await tabs.query({});
  assert.equal(one.id, 4242, "the id is the one this shell defined");
  assert.equal(one.url, ATTACHED.url, "url comes from the host");
  assert.equal(one.title, ATTACHED.title, "title comes from the host");
  assert.equal(one.status, "complete");

  const byId = await tabs.get(one.id);
  assert.deepStrictEqual(byId, one, "get(id) is the same tab query returned");
  const updated = await tabs.update(one.id, { active: true });
  assert.deepStrictEqual(updated, one, "update answers with the same tab");
  assert.deepStrictEqual(await tabs.query({ active: true }), [one]);
});

test("the synthetic id is the id chrome.devtools.inspectedWindow.tabId reports", () => {
  const chrome = createChromeNamespace({
    extensionId: "altair",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    getTargetInfo: () => ATTACHED,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  assert.strictEqual(chrome.devtools.inspectedWindow.tabId, tabIdFor("altair"));
});

test("no CDP session means about:blank + empty title, and no status/windowId claim", async () => {
  const { tabs } = make({ getTarget: () => ({ attached: false }) });
  const [tab] = await tabs.query({});
  assert.equal(tab.url, UNKNOWN_URL);
  assert.equal(tab.title, "");
  assert.strictEqual(tab.status, undefined, "nothing loaded, so no status is claimed");
  assert.strictEqual(tab.windowId, undefined, "this tab is in no window");
});

test("the host's answer may arrive late, and the tab reflects it when it does", async () => {
  let info = { attached: false };
  const { tabs } = make({ getTarget: () => Promise.resolve(info) });
  assert.equal((await tabs.get(4242)).url, UNKNOWN_URL);
  info = ATTACHED;
  assert.equal((await tabs.get(4242)).url, ATTACHED.url, "no cached fabrication");
});

test("query filters: only the ones this shell can answer match", async () => {
  const { tabs } = make();
  assert.equal((await tabs.query({ currentWindow: true })).length, 1);
  assert.equal((await tabs.query({ lastFocusedWindow: true })).length, 1);
  assert.equal((await tabs.query({ status: "complete" })).length, 1);
  assert.equal((await tabs.query({ status: "loading" })).length, 0);
  assert.equal((await tabs.query({ url: "*://*/*" })).length, 1);
  assert.equal((await tabs.query({ url: "https://example.com/*" })).length, 0);
  // No window/group model exists, so a filter on one matches nothing rather than
  // implying a windowId this shell does not have.
  assert.equal((await tabs.query({ windowId: 1 })).length, 0);
  assert.equal((await tabs.query({ title: "RnApp" })).length, 0);
});

test("query's url filter uses the same match-pattern compiler as chrome.webRequest", () => {
  const { urlMatchesPattern } = require("../src/chrome-shim/web-request");
  const matches = queryMatcher((tab) => tab.id === 4242);
  const tab = { id: 4242, active: true, url: "https://a.example.com/x" };
  assert.strictEqual(matches(tab, { url: ["https://*.example.com/*"] }, urlMatchesPattern), true);
  assert.strictEqual(matches(tab, { url: ["http://*.example.com/*"] }, urlMatchesPattern), false);
  // One compiler, one answer: whatever chrome.webRequest decides, tabs.query agrees.
  assert.strictEqual(
    matches(tab, { url: "https://*.example.com/*" }, urlMatchesPattern),
    urlMatchesPattern(tab.url, "https://*.example.com/*")
  );
});

test("get() with an unknown id fails with Chrome's own error, promise and callback", async () => {
  let lastError = null;
  const lastErrorHolder = {
    setError: (error) => {
      lastError = error;
    },
    clearError: () => {
      lastError = null;
    },
  };
  const { tabs } = make({ lastError: lastErrorHolder });
  await assert.rejects(() => tabs.get(999999), /No tab with id: 999999/);

  let callbackValue = "not called";
  const returned = tabs.get(999999, (tab) => {
    callbackValue = tab;
  });
  assert.strictEqual(returned, undefined, "callback style returns no promise");
  await tick();
  assert.strictEqual(callbackValue, undefined, "no value alongside the error");
  assert.strictEqual(lastError, null, "lastError is scoped to the callback only");

  let seenError = null;
  await new Promise((resolve) =>
    tabs.get(999999, () => {
      seenError = lastError;
      resolve();
    })
  );
  await tick();
  assert.match(String(seenError && seenError.message), /No tab with id/);
});

// The test above builds its OWN lastError holder and hands it to createTabs, so it proves
// the contract on one side of a seam and stays green while the seam itself is wired wrong.
// This is that same failure through the wiring an extension frame actually gets, which is
// where `deps.lastError` was being handed the bare `{value}` cell: with no setError,
// promiseOrCallback falls back to `callback(undefined, {message})`, an argument Chrome never
// passes, while runtime.lastError stays empty — so the extension's error check below reads a
// failed lookup as a successful `undefined`.
test("a tab failure reaches chrome.runtime.lastError through the real namespace wiring", async () => {
  const chrome = createChromeNamespace({
    extensionId: "altair",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    getTargetInfo: () => ATTACHED,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => chrome.tabs.get(999999),
    /No tab with id: 999999/,
    "promise style rejects with the same message"
  );

  let observed = null;
  await new Promise((resolve) =>
    chrome.tabs.get(999999, function (tab) {
      // Chrome's shape: no value to work with, and the error lives on runtime.lastError.
      // `runtime.lastError` is a static `null` on a bare namespace because contextBridge
      // cloning loses getters — src/preload/extension-frame.js re-defines it as a live
      // getter over this same holder. `_getLastLastError()` is that holder.
      observed = {
        tab,
        args: arguments.length,
        lastError: chrome.runtime._getLastLastError(),
      };
      resolve();
    })
  );
  await tick();
  assert.strictEqual(observed.tab, undefined, "the callback gets no tab");
  assert.strictEqual(observed.args, 0, "and no second error argument, which Chrome never passes");
  assert.ok(observed.lastError, "the shared lastError holder is set for the callback's duration");
  assert.match(String(observed.lastError.message), /No tab with id: 999999/);

  await tick();
  assert.ok(
    !chrome.runtime._getLastLastError(),
    "and scoped to that callback: it does not leak and read as a stale failure on the next one"
  );
});

test("create returns an id and a real url, and resolves a relative path against the extension origin", async () => {
  // The exact consumer: Altair's assets/tabs.js.
  const { tabs } = make();
  const tab = await tabs.create({ url: "altair-app/index.html" });
  assert.ok(tab.id, "an id, or Altair stores nothing");
  assert.equal(tab.url, "rozenite://probe.local/altair-app/index.html");
  assert.strictEqual(tab.openedVia, null, "no open capability injected = nothing opened");
  const fetched = await tabs.get(tab.id);
  assert.equal(fetched.url, tab.url, "get(create's id) then works — this is what used to throw");
  assert.doesNotThrow(() => String(fetched.url).includes("probe.local"));
});

test("create with an absolute URL keeps it, and with no URL reports it opened nothing", async () => {
  const { tabs, notes } = make({ openTab: async () => ({ via: "external" }) });
  assert.equal((await tabs.create({ url: "https://altairgraphql.dev/updated" })).url, "https://altairgraphql.dev/updated");
  const empty = await tabs.create({});
  assert.equal(empty.url, UNKNOWN_URL);
  assert.strictEqual(empty.openedVia, null);
  assert.equal(notes.filter((n) => /empty tab/.test(n)).length, 1);
});

test("create fires onCreated once, with the descriptor it returned", async () => {
  const { tabs } = make();
  const fired = [];
  tabs.onCreated.addListener((tab) => fired.push(tab));
  const tab = await tabs.create({ url: "https://example.com" });
  assert.deepEqual(fired, [tab]);
});

test("the create policy is injectable, and openedVia reports what really happened", async () => {
  const calls = [];
  const { tabs } = make({
    openTab: async (details) => {
      calls.push(details);
      return { via: "external", handle: null };
    },
  });
  const tab = await tabs.create({ url: "https://example.com/page" });
  assert.deepEqual(calls, [{ url: "https://example.com/page", windowId: undefined, active: true }]);
  assert.equal(tab.openedVia, "external", "the descriptor says the OS browser got it");
  assert.equal((await tabs.get(tab.id)).openedVia, "external");
});

test("query({currentWindow: true}) does not return a created tab", async () => {
  const { tabs } = make({ openTab: async () => ({ via: "external" }) });
  const created = await tabs.create({ url: "https://example.com" });
  const current = await tabs.query({ currentWindow: true });
  assert.deepEqual(current.map((t) => t.id), [4242], "created tabs belong to no window here");
  assert.ok((await tabs.query({})).some((t) => t.id === created.id), "but query() does list them");
});

test("remove closes what the host opened, is a no-op for the inspected id, and fails for an unknown one", async () => {
  const closed = [];
  const { tabs, notes } = make({
    openTab: async () => ({ via: "window", handle: 77 }),
    closeTab: async (handle) => {
      closed.push(handle);
      return true;
    },
  });
  const created = await tabs.create({ url: "https://example.com" });
  const removed = [];
  tabs.onRemoved.addListener((id) => removed.push(id));
  assert.strictEqual(await tabs.remove(created.id), undefined, "Chrome's callback carries no value");
  assert.deepEqual(closed, [77], "the host window really was closed by its handle");
  assert.deepEqual(removed, [created.id]);
  assert.equal((await tabs.query({})).length, 1, "the inspected tab remains");

  assert.strictEqual(await tabs.remove(4242), undefined, "a resolving no-op, not an error");
  assert.ok(notes.some((n) => /is a no-op: that id is the inspected target/.test(n)));
  await assert.rejects(() => tabs.remove(created.id), /No tab with id/);
});

test("update reports what it cannot do, and never fabricates an activation", async () => {
  const { tabs, notes } = make();
  let activated = 0;
  tabs.onActivated.addListener(() => activated++);
  const tab = await tabs.update(4242, { url: "https://example.com", active: true });
  assert.equal(tab.url, ATTACHED.url, "the tab is unchanged, because nothing navigated");
  assert.ok(notes.some((n) => /navigating to/.test(n)));
  assert.ok(notes.some((n) => /already the active one/.test(n)));
  assert.strictEqual(activated, 0, "onActivated does not fire without a change");
});

// Issue #12 refused to wire `tabs.sendMessage` at all, because this host had no receiver
// and routing it into the extension's own mesh would have let an extension message itself
// and report the success as "a page answered". Issue #5 supplied the real receiver — the
// extension's allowlisted content script, inside the inspected app. These are the same two
// guarantees #12 pinned, restated for a call that can now succeed:
//   (a) the message still NEVER travels through this extension's runtime mesh;
//   (b) a call that reaches nothing FAILS with a reason. `undefined` is the shape of "the
//       page answered nothing", and reporting that for a silent app is a lie.
const makeMessagingChrome = ({ sendToApp, onMeshSend }) => {
  const notes = [];
  const chrome = createChromeNamespace({
    extensionId: "probe.local",
    getManifest: () => ({ permissions: ["tabs"] }),
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    sendToApp,
    transport: {
      sendMessage: () => onMeshSend(),
      respond: () => Promise.resolve(),
      connect: () => Promise.resolve({ ok: false }),
      portPost: () => Promise.resolve(),
      portClose: () => Promise.resolve(),
    },
    logger: { warn: (m) => notes.push(m), error: () => {}, log: () => {} },
  });
  return { chrome, notes };
};

// The same id chrome.devtools.inspectedWindow.tabId reports for this extension.
const APP_TAB = tabIdFor("probe.local");

test("tabs.sendMessage goes to the app context, never into this extension's own mesh", async () => {
  const delivered = [];
  const { chrome } = makeMessagingChrome({
    sendToApp: (details) => {
      delivered.push(details);
      return Promise.resolve({ ok: true, response: { from: "the app" } });
    },
    onMeshSend: () => {
      throw new Error("tabs.sendMessage must NOT route through the runtime mesh");
    },
  });
  let received = 0;
  chrome.runtime.onMessage.addListener(() => received++);

  assert.deepStrictEqual(await chrome.tabs.sendMessage(APP_TAB, { hi: true }), { from: "the app" });
  assert.deepStrictEqual(delivered, [{ message: { hi: true } }]);
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(received, 0, "an extension cannot message itself and call that a page");

  // Callback style gets the same value and no error. (`runtime.lastError` is only a live
  // getter in a real frame — see tests/extension-frame-electron.test.js — so the falsiness
  // of the holder is what a unit-test namespace can honestly show.)
  let callbackArgs = null;
  chrome.tabs.sendMessage(APP_TAB, { hi: 2 }, (response) => {
    callbackArgs = [response, chrome.runtime.lastError];
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(callbackArgs[0], { from: "the app" });
  assert.ok(!callbackArgs[1], "a delivered message sets no lastError");
});

test("a refused tabs.sendMessage fails with its reason, and still never self-messages", async () => {
  const { chrome } = makeMessagingChrome({
    sendToApp: () =>
      Promise.resolve({
        ok: false,
        error: 'tabs.sendMessage: no content script of "probe.local" is running in the inspected target',
      }),
    onMeshSend: () => {
      throw new Error("a refused tab send must still not touch the runtime mesh");
    },
  });
  let received = 0;
  chrome.runtime.onMessage.addListener(() => received++);
  await assert.rejects(
    () => chrome.tabs.sendMessage(APP_TAB, { hi: true }),
    /no content script of "probe\.local" is running/
  );
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(received, 0, "failure does not route it into the mesh either");
});

/**
 * The failure paths of the shim itself, against `createTabs` with a real lastError holder
 * — the same shape a frame has. `createChromeNamespace` exposes `runtime.lastError` as a
 * plain null (the live getter is installed by the frame preload), so it cannot show the
 * scoping being asserted here.
 */
const makeFailingTabs = ({ sendToApp, lastError }) =>
  createTabs({ tabId: APP_TAB, sendToApp, lastError, onUnsupported: () => {} });

const makeHolder = (sink) => ({
  setError: (error) => sink.push(error),
  clearError: () => sink.push(null),
});

test("tabs.sendMessage: every way it can fail, and how the caller is told", async () => {
  // 1. nothing injected: the host's refusal becomes Chrome's connection failure, for both
  //    calling conventions, with lastError scoped to the callback.
  const seen = [];
  const tabs = makeFailingTabs({
    sendToApp: () =>
      Promise.resolve({
        ok: false,
        error: "Could not establish connection. Receiving end does not exist.",
      }),
    lastError: makeHolder(seen),
  });
  await assert.rejects(
    () => tabs.sendMessage(APP_TAB, { hi: true }),
    /Receiving end does not exist/
  );

  let callbackArgs = null;
  await new Promise((resolve) =>
    tabs.sendMessage(APP_TAB, { hi: true }, (response) => {
      // Chrome's callback-style failure gets NO value and reads the error off lastError,
      // which is why the holder's contents during the call are what matters here.
      callbackArgs = { response, inFlight: seen[seen.length - 1] };
      resolve();
    })
  );
  assert.strictEqual(callbackArgs.response, undefined, "no value alongside the error");
  assert.match(String(callbackArgs.inFlight && callbackArgs.inFlight.message), /Receiving end/);
  assert.strictEqual(seen[seen.length - 1], null, "and lastError is cleared afterwards");

  // 2. a context with no route to the app at all says so, rather than answering undefined.
  const unrouted = makeFailingTabs({ sendToApp: null, lastError: null });
  await assert.rejects(
    () => unrouted.sendMessage(APP_TAB, { hi: true }),
    /no route to the inspected target/
  );

  // 3. an id that is not the inspected target is Chrome's own error.
  await assert.rejects(() => unrouted.sendMessage(4242, { hi: true }), /No tab with id: 4242/);

  // 4. a tab this shell opened really exists but has no content script in it, and says so
  //    instead of pretending the message landed.
  const opened = await unrouted.create({ url: "https://example.com" });
  await assert.rejects(
    () => unrouted.sendMessage(opened.id, { hi: true }),
    /is a tab this shell opened, not the inspected target/
  );
});

test("chrome.tabs is gated on the declared tabs permission, promise and callback", async () => {
  const storage = createExtensionStorage({ createBackend: () => createMemoryBackend() });
  const gate = createGrantGate(() => ({ storage: true, tabs: false }));
  const chrome = createChromeNamespace({
    extensionId: "probe.local",
    getManifest: () => ({ permissions: ["storage"] }),
    storage,
    networkBridge: { webRequest: {}, network: {} },
    permissions: gate,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  gate.manifestLoaded();
  await assert.rejects(() => chrome.tabs.query({}), /permission 'tabs' is not declared/);
  let rejected = null;
  await chrome.tabs.create({ url: "https://example.com" }).catch((e) => {
    rejected = e;
  });
  assert.match(String(rejected && rejected.message), /permission 'tabs'/);
});

// ── the host's open policy (src/main/tab-host.js) ────────────────────────────
test("targetInfo answers about:blank-equivalent when the bridge is not attached, without asking", async () => {
  let asked = 0;
  const host = createTabHost({
    bridgeStatus: () => ({ attached: false, target: null }),
    sendCommand: async () => {
      asked++;
      return { targetInfo: { url: "ws://should-not-be-asked", title: "nope" } };
    },
  });
  assert.deepStrictEqual(await host.targetInfo(), { attached: false });
  assert.strictEqual(asked, 0, "no command is sent when nothing is attached");
});

test("targetInfo prefers Target.getTargetInfo and falls back to the bridge's own target record", async () => {
  const fromCommand = createTabHost({
    bridgeStatus: () => ({ attached: true, target: { url: "ws://from/list" } }),
    sendCommand: async (method) => {
      assert.equal(method, "Target.getTargetInfo");
      return { targetInfo: { url: "ws://from/cdp", title: "App" } };
    },
  });
  assert.deepStrictEqual(await fromCommand.targetInfo(), {
    attached: true,
    url: "ws://from/cdp",
    title: "App",
  });

  const refused = createTabHost({
    bridgeStatus: () => ({ attached: true, target: { url: "ws://from/list", title: "Listed" } }),
    sendCommand: async () => {
      throw new Error("CDP method not available");
    },
  });
  assert.deepStrictEqual(await refused.targetInfo(), {
    attached: true,
    url: "ws://from/list",
    title: "Listed",
  });

  const silent = createTabHost({ bridgeStatus: () => ({ attached: true, target: null }) });
  assert.deepStrictEqual(await silent.targetInfo(), { attached: true, url: "", title: "" });
});

test("open: the default policy opens nothing and says so; external and window are wired", async () => {
  const launched = [];
  const none = createTabHost({ openExternal: async (url) => launched.push(url) });
  assert.deepStrictEqual(await none.open({ url: "https://example.com" }), { via: null, handle: null });
  assert.deepEqual(launched, [], "the default policy launches no browser");

  const external = createTabHost({
    policy: "external",
    openExternal: async (url) => launched.push(url),
  });
  assert.deepStrictEqual(await external.open({ url: "https://example.com" }), {
    via: "external",
    handle: null,
  });
  assert.deepEqual(launched, ["https://example.com"]);

  const opened = [];
  const inWindow = createTabHost({
    policy: "window",
    openWindow: (url) => {
      opened.push(url);
      return 5;
    },
    closeWindow: (id) => id === 5,
  });
  assert.deepStrictEqual(await inWindow.open({ url: "https://example.com" }), {
    via: "window",
    handle: 5,
  });
  assert.deepEqual(opened, ["https://example.com"]);

  // A policy whose capability is missing opens nothing rather than throwing.
  assert.deepStrictEqual(await createTabHost({ policy: "window" }).open({ url: "x" }), {
    via: null,
    handle: null,
  });
  assert.deepStrictEqual(await createTabHost({ policy: "external" }).open({}), {
    via: null,
    handle: null,
  });
});

test("close only closes windows this host opened", async () => {
  const closed = [];
  const host = createTabHost({
    policy: "window",
    openWindow: () => 9,
    closeWindow: (id) => {
      closed.push(id);
      return true;
    },
  });
  assert.strictEqual(await host.close(9), false, "a handle this host never handed out is not closed");
  assert.deepEqual(closed, []);
  await host.open({ url: "https://example.com" });
  assert.strictEqual(await host.close(9), true);
  assert.deepEqual(closed, [9]);
  assert.strictEqual(await host.close(9), false, "and only once");
});
