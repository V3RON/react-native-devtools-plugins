// Runtime messaging tests: router (src/main/message-router.js) + frame-side
// client (src/chrome-shim/messaging.js) wired together in-process, verifying
// the Chrome-parity contract rules from docs/features/RUNTIME-MESSAGING.md.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createMessageRouter } = require("../src/main/message-router");
const { createEvent } = require("../src/chrome-shim/event");
const { createMessagingClient } = require("../src/chrome-shim/messaging");

// Build a world: one router + N frames; frame "delivery" calls the client's
// handleDelivery synchronously (Electron IPC also preserves order).
function makeWorld() {
  const router = createMessageRouter();
  const frames = new Map();

  const addFrame = (key, extensionId) => {
    const runtimeEvents = { onMessage: createEvent(), onConnect: createEvent() };
    const lastError = { value: null };
    const transport = {
      sendMessage: ({ message }) => router.sendMessage({ fromKey: key, message }),
      respond: ({ requestId, response }) =>
        router.resolveDelivery({ fromKey: key, requestId, response }),
      connect: ({ name }) => Promise.resolve(router.connect({ fromKey: key, name })),
      portPost: ({ portId, message }) => {
        router.portPost({ fromKey: key, portId, message });
        return Promise.resolve();
      },
      portClose: ({ portId }) => {
        router.portDisconnect({ fromKey: key, portId });
        return Promise.resolve();
      },
    };
    const client = createMessagingClient({ extensionId, transport, runtimeEvents, lastError });
    router.registerFrame({
      key,
      extensionId,
      url: `rozenite://${extensionId}/page.html`,
      send: (delivery) => client.handleDelivery(delivery),
    });
    const frame = { client, runtimeEvents, lastError };
    frames.set(key, frame);
    return frame;
  };

  return { router, frames, addFrame };
}

const tick = () => new Promise((r) => setImmediate(r));

// The router cannot tell a sender "no peers" from "peers answered nothing" — both come
// back `undefined` — so a sender that needs the difference asks first. The app-side
// sender (src/main/content-bridge.js, an injected content script's sendMessage) does.
test("router.hasPeers: false for a lone frame, true once a peer of one extension exists", async () => {
  const { router, addFrame } = makeWorld();
  addFrame("1:1", "ext-a");
  assert.strictEqual(router.hasPeers("1:1"), false, "nobody else of ext-a is registered");
  assert.strictEqual(router.hasPeers("no-such-frame"), false, "and an unknown sender has no peers");

  addFrame("1:2", "ext-a");
  assert.strictEqual(router.hasPeers("1:1"), true, "a peer of the same extension counts");

  addFrame("2:1", "ext-b");
  assert.strictEqual(router.hasPeers("2:1"), false, "another extension is not a peer");

  router.unregisterFrame("1:2");
  assert.strictEqual(router.hasPeers("1:1"), false, "and the count goes back down when it goes");
});

test("sendMessage: sync sendResponse round-trip (callback + promise)", async () => {
  const { addFrame } = makeWorld();
  const panel = addFrame("1:1", "ext-a");
  const bg = addFrame("1:2", "ext-a");

  bg.runtimeEvents.onMessage.addListener((message, sender, sendResponse) => {
    assert.strictEqual(message.kind, "ready");
    assert.strictEqual(sender.id, "ext-a");
    sendResponse({ kind: "draft", payload: "hi" });
  });

  const viaPromise = await panel.client.sendMessage({ kind: "ready" });
  assert.deepStrictEqual(viaPromise, { kind: "draft", payload: "hi" });

  const viaCallback = await new Promise((resolve) => {
    const returned = panel.client.sendMessage({ kind: "ready" }, (response) => resolve(response));
    assert.strictEqual(returned, undefined, "callback form returns undefined");
  });
  assert.deepStrictEqual(viaCallback, { kind: "draft", payload: "hi" });
});

test("sendMessage: async listener (return true) responds late, exactly-once", async () => {
  const { addFrame } = makeWorld();
  const a = addFrame("1:1", "ext-a");
  const b = addFrame("1:2", "ext-a");

  b.runtimeEvents.onMessage.addListener((message, sender, sendResponse) => {
    setTimeout(() => {
      sendResponse("first");
      sendResponse("ignored"); // Chrome: only the first sendResponse counts
    }, 1);
    return true; // claims async
  });

  assert.strictEqual(await a.client.sendMessage("ping"), "first");
});

test("sendMessage: no listeners -> undefined response, no lastError", async () => {
  const { addFrame } = makeWorld();
  const a = addFrame("1:1", "ext-a");
  addFrame("1:2", "ext-a"); // exists, but adds no listeners

  const response = await a.client.sendMessage("hello");
  assert.strictEqual(response, undefined);

  await new Promise((resolve) => {
    a.client.sendMessage("hello", (r) => {
      assert.strictEqual(r, undefined);
      assert.strictEqual(a.lastError.value, null, "lastError stays clear");
      resolve();
    });
  });
});

test("sendMessage: no receivers at all -> callback(undefined)", async () => {
  const { addFrame } = makeWorld();
  const lonely = addFrame("1:1", "solo");
  assert.strictEqual(await lonely.client.sendMessage("hello"), undefined);
});

test("messaging is extension-scoped", async () => {
  const { addFrame } = makeWorld();
  const a = addFrame("1:1", "ext-a");
  const b = addFrame("1:2", "ext-b");
  let bSaw = false;
  b.runtimeEvents.onMessage.addListener(() => {
    bSaw = true;
  });

  assert.strictEqual(await a.client.sendMessage("secret"), undefined);
  await tick();
  assert.strictEqual(bSaw, false, "cross-extension delivery never happens");

  // Explicit foreign id fails like Chrome; own id works.
  await assert.rejects(() => a.client.sendMessage("ext-b", "secret"));
  await a.client.sendMessage("ext-a", "fine").catch(() => {});
});

test("sendMessage: multiple responders -> last valid response wins", async () => {
  const { addFrame } = makeWorld();
  const a = addFrame("1:1", "ext-a");
  const b = addFrame("1:2", "ext-a");
  const c = addFrame("1:3", "ext-a");
  b.runtimeEvents.onMessage.addListener((m, s, respond) => respond("from-b"));
  c.runtimeEvents.onMessage.addListener((m, s, respond) => respond("from-c"));
  assert.strictEqual(await a.client.sendMessage("x"), "from-c");
});

test("Port: connect, bidirectional postMessage, disconnect", async () => {
  const { addFrame } = makeWorld();
  const panel = addFrame("1:1", "ext-a");
  const bg = addFrame("1:2", "ext-a");

  const bgPorts = [];
  bg.runtimeEvents.onConnect.addListener((port) => {
    bgPorts.push(port);
    port.onMessage.addListener((msg, from) => {
      assert.strictEqual(from.id, "ext-a");
      assert.strictEqual(msg, "hello-bg");
      port.postMessage("hello-panel");
    });
  });

  const port = panel.client.connect({ name: "redux" });
  await tick();
  assert.strictEqual(port.name, "redux");
  assert.strictEqual(bgPorts.length, 1);
  assert.strictEqual(bgPorts[0].name, "redux");
  assert.strictEqual(bgPorts[0].sender.id, "ext-a"); // sender only on the responder side

  const echoed = new Promise((resolve) => port.onMessage.addListener(resolve));
  port.postMessage("hello-bg");
  assert.strictEqual(await echoed, "hello-panel");

  const panelGone = new Promise((resolve) => bgPorts[0].onDisconnect.addListener(resolve));
  port.disconnect();
  assert.strictEqual(await panelGone, bgPorts[0]);
});

test("Port: connect with no peers -> onDisconnect with lastError", async () => {
  const { addFrame } = makeWorld();
  const lonely = addFrame("1:1", "solo");
  const port = lonely.client.connect({ name: "nope" });
  const gone = new Promise((resolve) => port.onDisconnect.addListener(() => resolve(port.lastError)));
  const lastError = await gone;
  assert.strictEqual(lastError.message, "Could not establish connection.");
});

test("frame dying mid-send settles the request; dying port member gets onDisconnect", async () => {
  const { router, addFrame } = makeWorld();
  const a = addFrame("1:1", "ext-a");
  const b = addFrame("1:2", "ext-a");

  // pending send that B never answers
  b.runtimeEvents.onMessage.addListener(() => true); // async, never responds
  const dying = a.client.sendMessage("hangs");
  router.unregisterFrame("1:2"); // B dies
  assert.strictEqual(await dying, undefined, "pending leg concluded by death");

  // live port, then the responder dies
  const bg = addFrame("1:3", "ext-a");
  let bgPort;
  bg.runtimeEvents.onConnect.addListener((p) => {
    bgPort = p;
  });
  const port = a.client.connect({ name: "live" });
  await tick();
  assert.ok(bgPort);
  const gone = new Promise((resolve) => port.onDisconnect.addListener(() => resolve(port.lastError)));
  router.unregisterFrame("1:3");
  assert.strictEqual((await gone).message, "Port disconnected");
});
