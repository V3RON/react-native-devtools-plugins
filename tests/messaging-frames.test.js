// Frame-delivery regressions for the runtime-messaging path.
//
// Both bugs below were found by tests/extension-frame-electron.test.js — the
// first test in this repo's history that could actually observe a message
// crossing two real extension frames. The unit tests that predate it wire the
// client and router together in one process, where neither failure is visible:
// that is exactly the gap a "verified live" claim can hide behind.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createMessageRouter } = require("../src/main/message-router");
const { createEvent } = require("../src/chrome-shim/event");
const { createMessagingClient } = require("../src/chrome-shim/messaging");

const REPO = path.join(__dirname, "..");

const makeWorld = () => {
  const router = createMessageRouter();
  const frames = new Map();
  const addFrame = (key, extensionId) => {
    const runtimeEvents = { onMessage: createEvent(), onConnect: createEvent() };
    const lastError = { value: null };
    const client = createMessagingClient({
      extensionId,
      runtimeEvents,
      lastError,
      transport: {
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
      },
    });
    router.registerFrame({
      key,
      extensionId,
      url: `rozenite://${extensionId}/page.html`,
      send: (delivery) => client.handleDelivery(delivery),
    });
    frames.set(key, { client, runtimeEvents });
    return frames.get(key);
  };
  return { router, addFrame };
};

test("postMessage straight after connect() reaches the responder", async () => {
  // Chrome returns a Port synchronously and `postMessage` is legal immediately.
  // The router-assigned id only exists after connect()'s round-trip, so a post
  // made in that window used to be sent under a `pending-N` id the router had
  // never seen — dropped, with no error anywhere.
  const { addFrame } = makeWorld();
  const panel = addFrame("1:1", "ext-a");
  const peer = addFrame("1:2", "ext-a");

  peer.runtimeEvents.onConnect.addListener((port) => {
    port.onMessage.addListener((message) => port.postMessage(`echo:${message}`));
  });

  const port = panel.client.connect({ name: "early" });
  const echoed = new Promise((resolve, reject) => {
    port.onMessage.addListener(resolve);
    setTimeout(() => reject(new Error("no echo: the early post was dropped")), 500);
  });
  port.postMessage("hello");

  assert.strictEqual(await echoed, "echo:hello");
});

test("posts made before and after connect() resolves keep their order", async () => {
  const { addFrame } = makeWorld();
  const panel = addFrame("1:1", "ext-a");
  const peer = addFrame("1:2", "ext-a");
  const seenByPeer = [];

  peer.runtimeEvents.onConnect.addListener((port) => {
    port.onMessage.addListener((message) => {
      seenByPeer.push(message);
    });
  });

  const port = panel.client.connect({ name: "ordered" });
  port.postMessage("first");
  port.postMessage("second");
  await new Promise((resolve) => setImmediate(resolve));
  port.postMessage("third");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepStrictEqual(seenByPeer, ["first", "second", "third"]);
});

test("disconnecting a port before connect() resolves leaks nothing", async () => {
  const { addFrame } = makeWorld();
  const panel = addFrame("1:1", "ext-a");
  const peer = addFrame("1:2", "ext-a");
  let delivered = 0;
  peer.runtimeEvents.onConnect.addListener((port) => {
    port.onMessage.addListener(() => {
      delivered++;
    });
  });

  const port = panel.client.connect({ name: "ghost" });
  port.postMessage("queued-then-abandoned");
  port.disconnect(); // before connect()'s round-trip resolves
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(delivered, 0, "a closed port's queued posts must not be flushed");
});

test("main addresses frames through the registered principal, not a tuple of ids", () => {
  // webContents.sendToFrame([webContentsId, frameId], …) silently delivers
  // nothing: that tuple is read as [processId, routingId]. With an out-of-process
  // extension frame every runtime/network delivery was dropped and nothing threw.
  // WebFrameMain.send addresses the same object the principal check verified.
  const source = fs
    .readFileSync(path.join(REPO, "src", "main", "ipc.js"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.match(source, /frame\.send\(channel/, "deliveries go through WebFrameMain.send");
  assert.doesNotMatch(source, /sendToFrame/, "no id-tuple addressing left in the sender");
});
