// The host half of `chrome.tabs.sendMessage` (src/main/tab-send.js), where the two
// properties that matter live: the receiver is chosen from the CALLER's identity, and a
// context that reached nothing is a failure rather than an empty success
// (docs/features/CONTENT-SCRIPTS.md, GitHub issue #5).
//
// The mesh itself is tested in tests/content-bridge-protocol.test.js and the shim in
// tests/tabs.test.js; this file is about the seam between them, including the shapes an
// untrusted frame could try to exploit.
const test = require("node:test");
const assert = require("node:assert");

const { deliverTabMessage, extensionIdOfFrame } = require("../src/main/tab-send");
const { createMessageRouter } = require("../src/main/message-router");

const CALLER_URL = "rozenite://ext-a/panel.html";
const APP_KEY = "rozenite-app:ext-a";

const bridgeThatIsInjected = (extensionId) => ({
  tabTarget: ({ extensionId: asked }) =>
    asked === extensionId
      ? { ok: true, frameKey: `rozenite-app:${extensionId}` }
      : { ok: false, error: `no content script of "${asked}" is running in the inspected target` },
});

/**
 * A real router with both seats present, so the mesh's own rules (scoping, settling) are
 * the ones under test rather than a fake that agrees with whatever the code does.
 */
const world = ({ appExtensionId = "ext-a", mode = "answers" } = {}) => {
  const router = createMessageRouter();
  const received = [];
  router.registerFrame({
    key: "panel:ext-a",
    extensionId: "ext-a",
    url: CALLER_URL,
    send: (delivery) => received.push(delivery),
  });
  router.registerFrame({
    key: APP_KEY,
    extensionId: appExtensionId,
    url: `rozenite://${appExtensionId}/`,
    send: (delivery) => {
      if (delivery.kind !== "message") return;
      if (mode === "answers") {
        router.resolveDelivery({
          fromKey: APP_KEY,
          requestId: delivery.payload.requestId,
          response: "answered",
        });
      } else if (mode === "silent") {
        // What the injected loader really does when the app has no onMessage listener: it
        // ANSWERS, and says nobody was listening. It does not go quiet — the host has no
        // way to tell a refusal from a slow app, which is why the loader carries `nr`.
        router.resolveDelivery({
          fromKey: APP_KEY,
          requestId: delivery.payload.requestId,
          response: {
            __rozeniteNoReceiver: true,
            error: "Could not establish connection. Receiving end does not exist.",
          },
        });
      }
    },
  });
  return { router, received, sendTo: (args) => router.sendTo(args) };
};

const call = (overrides = {}) =>
  deliverTabMessage({
    granted: true,
    frameUrl: CALLER_URL,
    fromKey: "panel:ext-a",
    bridge: bridgeThatIsInjected("ext-a"),
    sendTo: () => ({ ok: true, requestId: 1, promise: Promise.resolve("answered") }),
    message: { ask: true },
    ...overrides,
  });

test("a granted frame reaches its OWN extension's app context, through the real mesh", async () => {
  const w = world();
  const outcome = await deliverTabMessage({
    granted: true,
    frameUrl: CALLER_URL,
    fromKey: "panel:ext-a",
    bridge: bridgeThatIsInjected("ext-a"),
    sendTo: w.sendTo,
    message: { ask: true },
  });
  assert.deepStrictEqual(outcome, { ok: true, response: "answered" });
  assert.strictEqual(w.received.length, 0, "the caller does not receive its own message");
});

test("a silent app context fails the call through the real mesh, not just a fake", async () => {
  const w = world({ mode: "silent" });
  const outcome = await deliverTabMessage({
    granted: true,
    frameUrl: CALLER_URL,
    fromKey: "panel:ext-a",
    bridge: bridgeThatIsInjected("ext-a"),
    sendTo: w.sendTo,
    message: { ask: true },
  });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error, /Receiving end does not exist/);
  assert.ok(!("response" in outcome), "and no invented response value");
});

test("the payload cannot address another extension's content script", async () => {
  const seen = [];
  const outcome = await call({
    // A frame of ext-a that tries to name ext-b anywhere in its payload: identity comes
    // from `frameUrl`, so the extra fields are inert and the target stays ext-a's.
    frameUrl: CALLER_URL,
    message: { extensionId: "ext-b", targetKey: "rozenite-app:ext-b", tabId: 999 },
    sendTo: (args) => {
      seen.push(args);
      return { ok: true, requestId: 1, promise: Promise.resolve("ok") };
    },
  });
  assert.strictEqual(outcome.ok, true);
  assert.deepStrictEqual(
    seen.map((a) => a.targetKey),
    ["rozenite-app:ext-a"],
    "the addressed context is the caller's own, never the one named in the payload"
  );
});

test("no grant, no delivery, and the reason is the permission", async () => {
  let touched = 0;
  const outcome = await call({
    granted: false,
    sendTo: () => {
      touched += 1;
      return { ok: true, requestId: 1, promise: Promise.resolve("should not happen") };
    },
  });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error, /permission 'tabs' is not declared/);
  assert.strictEqual(touched, 0, "a denied caller never reaches the mesh at all");
});

test("an unregistered frame is refused as itself, not as a missing permission", async () => {
  const outcome = await call({ fromKey: null });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error, /not registered/);
});

test("a frame url with no extension id cannot address anything", async () => {
  for (const frameUrl of ["", "not a url", "https://evil.test/"]) {
    const outcome = await call({ frameUrl });
    assert.strictEqual(outcome.ok, false, `${frameUrl || "(empty)"} must not be deliverable`);
    // `https://evil.test/` really has a hostname, so the check that matters is that the
    // TARGET is resolved from it, and an extension that was never injected cannot be
    // reached: the bridge's own verdict is what refuses.
    assert.ok(outcome.error.length > 10, "and the refusal says why");
  }
});

test("extensionIdOfFrame reads only the frame's own origin", () => {
  assert.strictEqual(extensionIdOfFrame(CALLER_URL), "ext-a");
  assert.strictEqual(extensionIdOfFrame("rozenite://ext-a/panel.html?x=#y"), "ext-a");
  assert.strictEqual(extensionIdOfFrame("not a url"), null);
  assert.strictEqual(extensionIdOfFrame(""), null);
});

test("nothing injected is a refusal with the bridge's reason, not an empty success", async () => {
  const outcome = await call({
    bridge: {
      tabTarget: () => ({
        ok: false,
        error: 'no content script of "ext-a" is running in the inspected target',
      }),
    },
  });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error, /no content script of "ext-a" is running/);
});

test("no bridge running says so, instead of pretending a send was attempted", async () => {
  const outcome = await call({ bridge: null });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error, /no content bridge running/);
});

test("the mesh refusing the leg is reported, with its error", async () => {
  const outcome = await call({ sendTo: () => ({ ok: false, error: "Could not establish connection." }) });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error, /Could not establish connection/);
});

// The honesty case this whole path exists for: the message REACHED the app and nothing in
// it was listening. Chrome fails the call; a shell that resolved undefined would be
// reporting a delivery whose answer it invented.
test("an app that heard the message and has no listener FAILS the call", async () => {
  const outcome = await call({
    sendTo: () => ({
      ok: true,
      requestId: 1,
      promise: Promise.reject(
        new Error("Could not establish connection. Receiving end does not exist.")
      ),
    }),
  });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error, /Receiving end does not exist/);
});

test("a listener that answered nothing really is a success with undefined", async () => {
  const outcome = await call({
    sendTo: () => ({ ok: true, requestId: 1, promise: Promise.resolve(undefined) }),
  });
  assert.deepStrictEqual(outcome, { ok: true, response: undefined });
});

test("the mesh's own scoping still applies to a cross-extension target", async () => {
  // The bridge points at an app context of ANOTHER extension (it must never, but the
  // router is the layer that owns extension scoping, so it is the one that says no).
  const router = createMessageRouter();
  router.registerFrame({ key: "panel:ext-a", extensionId: "ext-a", url: CALLER_URL, send: () => {} });
  router.registerFrame({ key: APP_KEY, extensionId: "ext-b", url: "rozenite://ext-b/", send: () => {} });
  const outcome = await call({
    bridge: { tabTarget: () => ({ ok: true, frameKey: APP_KEY }) },
    sendTo: (args) => router.sendTo(args),
  });
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.error, /Receiving end does not exist/);
});
