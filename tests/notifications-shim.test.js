// chrome.notifications — the real Electron-backed notifications shim, tested with the
// notifier injected so nothing reaches the screen (src/chrome-shim/browser-apis.js +
// src/main/notification-host.js). GitHub issue #4.
//
// The honesty rules under test, in order:
//   1. an id is named only for a notification that really showed;
//   2. onClicked fires only from the backend's own click callback — never invented;
//   3. the click reaches the context that created the notification, not every frame;
//   4. `clear`/`getAll` answer from what is actually still up.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createNotifications } = require("../src/chrome-shim/browser-apis");
const { createNotificationHost } = require("../src/main/notification-host");
const { createContextRegistry } = require("../src/main/context-registry");
const { createChromeNamespace } = require("../src/chrome-shim");
const { createMemoryBackend, createExtensionStorage } = require("../src/chrome-shim/storage");
const { createGrantGate } = require("../src/shared/permissions");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A notifier that records and hands back the callbacks a platform would call. */
const fakeNotifier = () => {
  const shown = [];
  const notifier = async (notification, handlers) => {
    shown.push(notification);
    notifier.handlers.set(notification.id, handlers);
    return null;
  };
  notifier.shown = shown;
  notifier.handlers = new Map();
  notifier.hide = (id) => notifier.handlers.delete(id);
  notifier.click = (id) => notifier.handlers.get(id)?.onClick();
  notifier.close = (id) => notifier.handlers.get(id)?.onClose();
  return notifier;
};

const make = (deps = {}) => {
  const notes = [];
  // The notifier a test hands in is the ONLY thing that can "show" anything here: it
  // records, and it hands back the click/close callbacks a platform would call.
  const notifier = deps.notifier || fakeNotifier();
  const notifications = createNotifications({
    show: async (n) =>
      notifier(
        { id: n.id, title: n.title, message: n.message, silent: n.silent, iconUrl: n.iconUrl },
        {
          // The context-level events are driven through `_onDelivery` in these tests,
          // which is the same envelope main pushes; these callbacks are the seam.
          onClick: () => notifications._onDelivery({ kind: "notification", payload: { event: "click", notificationId: n.id } }),
          onClose: () => notifications._onDelivery({ kind: "notification", payload: { event: "closed", notificationId: n.id } }),
        }
      ),
    hide: notifier.hide,
    onUnsupported: (message) => notes.push(message),
    ...(deps.show === undefined ? {} : { show: deps.show }),
    ...(deps.hide === undefined ? {} : { hide: deps.hide }),
    ...(deps.permissionLevel === undefined ? {} : { permissionLevel: deps.permissionLevel }),
  });
  return { notifications, notifier, notes };
};

test("create names the id of a notification that really showed, promise and callback", async () => {
  const { notifications, notifier } = make();
  const id = await notifications.create("build-done", { type: "basic", title: "Build", message: "finished" });
  assert.equal(id, "build-done");
  assert.equal(notifier.shown.length, 1);
  assert.deepEqual(
    { id: notifier.shown[0].id, title: notifier.shown[0].title, message: notifier.shown[0].message, silent: notifier.shown[0].silent },
    { id: "build-done", title: "Build", message: "finished", silent: false }
  );

  let cbId = "not called";
  const returned = notifications.create("second", { title: "t", message: "m" }, (result) => {
    cbId = result;
  });
  assert.strictEqual(returned, undefined, "callback style returns no promise");
  await tick();
  assert.equal(cbId, "second");
});

test("create allocates an id when the extension named none", async () => {
  const { notifications, notifier } = make();
  const id = await notifications.create({ title: "t", message: "m" });
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
  assert.equal(notifier.shown[0].id, id);
});

test("nothing shown means NO id, and the reason is reported once", async () => {
  const { notifications, notes } = make({ show: async () => "notification daemon unreachable" });
  assert.strictEqual(await notifications.create("x", { title: "t", message: "m" }), undefined);
  await notifications.create("y", { title: "t", message: "m" });
  assert.equal(notes.filter((n) => /could not show/.test(n)).length, 1, "reported once per context");
  assert.match(notes[0], /notification daemon unreachable/);
  assert.deepEqual(await notifications.getAll(), {}, "and nothing entered the registry");
});

test("a throwing notifier is a failure, not a crash, and names no id", async () => {
  const { notifications } = make({
    show: async () => {
      throw new Error("boom");
    },
  });
  assert.strictEqual(await notifications.create("x", { title: "t" }), undefined);
});

test("update/clear/getAll answer from what is actually still up", async () => {
  const { notifications, notes } = make();
  await notifications.create("a", { title: "A", message: "one" });
  await notifications.create("b", { title: "B", message: "two" });
  assert.deepEqual(Object.keys(await notifications.getAll()), ["a", "b"]);
  assert.deepEqual(await notifications.getAll("a"), {
    a: { title: "A", message: "one" },
    b: { title: "B", message: "two" },
  });

  assert.strictEqual(await notifications.update("a", { title: "A2" }), true);
  assert.match(JSON.stringify(notes), /cannot be changed/);
  assert.equal((await notifications.getAll()).a.title, "A", "the shown text is not rewritten");
  assert.strictEqual(await notifications.update("nope", {}), false);

  assert.strictEqual(await notifications.clear("a"), true);
  assert.strictEqual(await notifications.clear("a"), false, "a second clear reports false");
  assert.deepEqual(Object.keys(await notifications.getAll()), ["b"]);
});

test("clear fires onClosed once, however the notification went away", async () => {
  const { notifications } = make();
  await notifications.create("a", { title: "A", message: "m" });
  const closed = [];
  notifications.onClosed.addListener((id) => closed.push(id));
  await notifications.clear("a");
  notifications._onDelivery({ kind: "notification", payload: { event: "closed", notificationId: "a" } });
  assert.deepEqual(closed, ["a"]);
});

test("the backend's own close removes it from the registry and fires onClosed", async () => {
  const { notifications, notifier } = make();
  await notifications.create("a", { title: "A", message: "m" });
  const closed = [];
  notifications.onClosed.addListener((id) => closed.push(id));
  // The delivery path is what a context actually receives: main saw the backend close
  // it and pushed one message back to this context.
  notifications._onDelivery({ kind: "notification", payload: { event: "closed", notificationId: "a" } });
  assert.deepEqual(closed, ["a"]);
  assert.deepEqual(await notifications.getAll(), {});
});

test("onClicked fires from a real click delivery, and never from anything else", async () => {
  const { notifications } = make();
  await notifications.create("a", { title: "A", message: "m" });
  const clicked = [];
  notifications.onClicked.addListener((id) => clicked.push(id));

  assert.strictEqual(
    notifications._onDelivery({ kind: "notification", payload: { event: "click", notificationId: "a" } }),
    true
  );
  assert.deepEqual(clicked, ["a"]);

  // A malformed or unrelated delivery is refused, and the caller is told so it can
  // fall through to the messaging client rather than swallow it.
  assert.strictEqual(notifications._onDelivery({ kind: "notification", payload: {} }), false);
  assert.strictEqual(notifications._onDelivery({ kind: "message", payload: {} }), false);
  assert.strictEqual(
    notifications._onDelivery({ kind: "notification", payload: { event: "exploded" } }),
    false
  );
  assert.deepEqual(clicked, ["a"], "nothing else fired it");
});

test("getPermissionLevel reports what the host can observe, and the typo is kept", async () => {
  const { notifications } = make({ permissionLevel: () => "denied" });
  assert.strictEqual(await notifications.getPermissionLevel(), "denied");
  let cbLevel = null;
  await notifications.getPermissionLevel((level) => {
    cbLevel = level;
  });
  await tick();
  assert.strictEqual(cbLevel, "denied", "callback style, not the callback's return value");
  assert.deepEqual(notifications.PermissionLevel, {
    unspecifed: "unspecifed",
    granted: "granted",
    denied: "denied",
  });
  // Removed from Chrome in 42, still registrable.
  assert.strictEqual(await notifications.setPermissionLevel("granted"), undefined);
});

test("unsupported notification features are reported rather than dropped in silence", async () => {
  const { notifications, notes } = make();
  await notifications.create("a", { title: "t", message: "m", buttons: [{ title: "OK" }] });
  await notifications.create("b", { title: "t", message: "m", requireInteraction: false });
  assert.match(JSON.stringify(notes), /1 button\(s\) ignored/);
  assert.match(JSON.stringify(notes), /requireInteraction is ignored/);
  assert.ok(notifications.onButtonClicked.hasListener !== undefined, "the event shape still exists");
});

test("with no notification backend at all, create names nothing and says so", async () => {
  const { notifications, notes } = make({ show: null });
  assert.strictEqual(await notifications.create("a", { title: "t" }), undefined);
  assert.match(JSON.stringify(notes), /no notification backend in this context/);
});

// ── gated, inside the real namespace ─────────────────────────────────────────
const namespaceWith = (grants, deps = {}) => {
  const gate = createGrantGate(() => grants);
  const warnings = [];
  const chrome = createChromeNamespace({
    extensionId: "notif.local",
    getManifest: () => ({ permissions: Object.keys(grants).filter((p) => grants[p]) }),
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    permissions: gate,
    showNotification: async () => null,
    logger: { warn: (m) => warnings.push(m), error: () => {}, log: () => {} },
    ...deps,
  });
  gate.manifestLoaded();
  return { chrome, warnings };
};

test("chrome.notifications is gated on the declared notifications permission", async () => {
  const { chrome } = namespaceWith({ notifications: false });
  await assert.rejects(
    () => chrome.notifications.create("a", { title: "t", message: "m" }),
    /permission 'notifications' is not declared/
  );
  let sawError = null;
  await chrome.notifications.create("a", { title: "t" }, () => {
    sawError = "called";
  });
  assert.equal(sawError, "called", "the callback still runs, with lastError set");
});

test("a declared notifications permission makes create work end to end in the namespace", async () => {
  const shown = [];
  const { chrome } = namespaceWith({ notifications: true }, {
    showNotification: async (n) => {
      shown.push(n);
      return null;
    },
  });
  const id = await chrome.notifications.create("hello", { title: "t", message: "m" });
  assert.equal(id, "hello");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].id, "hello");
  assert.equal(shown[0].title, "t");
  assert.equal(shown[0].message, "m");
});

test("chrome.handleDelivery routes a notification click to onClicked, and nothing else to it", async () => {
  const { chrome } = namespaceWith({ notifications: true });
  const clicked = [];
  const messages = [];
  chrome.notifications.onClicked.addListener((id) => clicked.push(id));
  chrome.runtime.onMessage.addListener((message) => messages.push(message));

  chrome.handleDelivery({ kind: "notification", payload: { event: "click", notificationId: "n1" } });
  assert.deepEqual(clicked, ["n1"]);
  assert.deepEqual(messages, [], "a notification delivery is not a runtime message");

  chrome.handleDelivery({
    kind: "message",
    payload: { message: { hi: 1 }, sender: {}, requestId: null, expected: [] },
  });
  assert.deepEqual(clicked, ["n1"], "and an ordinary message does not fire onClicked");
});

test("the gate does not expose the shim's internal host hooks", () => {
  const { chrome } = namespaceWith({ notifications: true });
  assert.strictEqual(chrome.notifications._onDelivery, undefined);
  assert.strictEqual(chrome.notifications._shownIds, undefined);
});

// ── the host side: ownership, and never a fabricated click ───────────────────
const wire = (deps = {}) => {
  const registry = createContextRegistry();
  const received = new Map(); // frameKey -> deliveries
  const makeSender = (frameKey) => (delivery) => {
    received.set(frameKey, [...(received.get(frameKey) || []), delivery]);
  };
  registry.register({ frameKey: "wc1:f1", extensionId: "ext.local", send: makeSender("wc1:f1") });
  registry.register({ frameKey: "wc1:f2", extensionId: "ext.local", send: makeSender("wc1:f2") });
  return {
    received,
    registry,
    host: createNotificationHost({ contextRegistry: registry, ...deps }),
  };
};

test("a click is delivered to the creating context alone, not to its sibling frame", async () => {
  const notifier = fakeNotifier();
  const { host, received } = wire({ notifier });
  const shown = await host.show({
    frameKey: "wc1:f1",
    id: "build",
    title: "Build done",
    message: "in 4s",
  });
  assert.deepEqual(shown, { ok: true, notificationId: "build" });
  notifier.click("build");
  assert.deepEqual([...received.keys()], ["wc1:f1"], "only the owner heard about it");
  assert.deepEqual(received.get("wc1:f1"), [
    { kind: "notification", payload: { event: "click", notificationId: "build" } },
  ]);
});

test("a click for an unknown id, or after a close, fires nothing", async () => {
  const notifier = fakeNotifier();
  const { host, received } = wire({ notifier });
  await host.show({ frameKey: "wc1:f1", id: "x", title: "t", message: "m" });
  notifier.click("never-shown");
  assert.deepEqual([...received.keys()], [], "an id this host never showed is not clickable");
  notifier.click("x");
  notifier.click("x");
  assert.equal(received.get("wc1:f1").length, 1, "two platform clicks still arrive once");
  notifier.close("x");
  notifier.click("x");
  notifier.close("x");
  assert.equal(received.get("wc1:f1").length, 2, "then the close, and nothing after it");
});

test("the host never invents a click: showing something never delivers one", async () => {
  const notifier = fakeNotifier();
  const { host, received } = wire({ notifier });
  await host.show({ frameKey: "wc1:f1", id: "x", title: "t", message: "m" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([...received.keys()], [], "show() alone produces no event of any kind");
});

test("a failed show reports the platform's reason and owns nothing", async () => {
  const { host } = wire({ notifier: async () => "notification daemon unreachable" });
  assert.deepEqual(await host.show({ frameKey: "wc1:f1", id: "x" }), {
    ok: false,
    error: "notification daemon unreachable",
  });
  assert.deepEqual(host.list(), []);
});

test("a notifier that throws is reported as a failure, not a crash", async () => {
  const { host } = wire({
    notifier: async () => {
      throw new Error("ipc exploded");
    },
  });
  assert.deepEqual(await host.show({ frameKey: "wc1:f1", id: "x" }), {
    ok: false,
    error: "ipc exploded",
  });
});

test("clear reports whether this host knew the id, and stops forwarding its events", async () => {
  const notifier = fakeNotifier();
  const { host, received } = wire({ notifier, hide: notifier.hide });
  await host.show({ frameKey: "wc1:f1", id: "x", title: "t", message: "m" });
  assert.strictEqual(await host.clear({ notificationId: "x" }), true);
  assert.strictEqual(await host.clear({ notificationId: "x" }), false);
  notifier.click("x");
  assert.deepEqual([...received.keys()], [], "a cleared notification cannot hand over a click");
});

test("a context that goes away cannot receive a notification event", async () => {
  const notifier = fakeNotifier();
  const { host, received, registry } = wire({ notifier });
  await host.show({ frameKey: "wc1:f1", id: "x", title: "t", message: "m" });
  registry.unregister("wc1:f1");
  notifier.click("x");
  assert.deepEqual([...received.keys()], [], "the delivery had nowhere to go, and said so");
});

test("the harness's recording notifier is what the suite runs against, not Electron's", () => {
  // A guard on the rule, not a behavior: src/main/notification-host.js exports the
  // real notifier, and the headless harness must not be allowed to install it.
  const { electronNotifier } = require("../src/main/notification-host");
  assert.equal(typeof electronNotifier, "function");
  const harness = require("node:fs")
    .readFileSync(require("node:path").join(__dirname, "extension-frame-harness.js"), "utf8");
  assert.match(harness, /arg\("notifier"\) \|\| "fake"/, "fake is the default");
  assert.match(
    harness,
    /if \(notifierMode !== "real"\)[\s\S]{0,20}const deny = notifierMode === "deny";[\s\S]{0,2000}attachNotificationHost\(\{\n        notifier: fakeNotifier/,
    "the real notifier is installed only when a run asks for it by name"
  );
});
