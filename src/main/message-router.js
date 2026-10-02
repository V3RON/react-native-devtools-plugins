// Host-side message router: the registry of live extension frames plus the
// relay for chrome.runtime.sendMessage / Ports traffic between them
// (docs/features/RUNTIME-MESSAGING.md).
//
// Pure: frames register with an injected send(payload) closure, so the wire
// semantics (extension scoping, response settling, port lifecycle) are
// unit-testable without Electron. Identity is owned by the caller (ipc.js)
// and derived from the frame itself — never from message payloads.
//
// Chrome parity notes:
//   - messaging is extension-scoped (same extensionId only);
//   - multiple target pages all receive the message; the LAST valid response
//     reaches the sender callback (Chrome's documented behavior);
//   - a frame that dies mid-send simply concludes its leg;
//   - connect() with no peers fails like Chrome's
//     "Could not establish connection.".
const createMessageRouter = () => {
  const frames = new Map(); // frameKey -> {key, extensionId, url, send}
  const ports = new Map(); // portId -> {extensionId, initiator, legs:Set}
  const pending = new Map(); // requestId -> {expected:Set, lastResponse, resolve}
  let nextRequestId = 1;
  let nextPortId = 1;

  const registerFrame = (frame) => frames.set(frame.key, frame);

  const peersOf = (fromKey) => {
    const from = frames.get(fromKey);
    if (!from) {
      return [];
    }
    return [...frames.entries()].filter(
      ([key, f]) => f.extensionId === from.extensionId && key !== fromKey
    );
  };

  // ── sendMessage ──────────────────────────────────────────────────────────
  /**
   * Chrome's answer for "the context was reached, nothing was listening in it". A
   * targeted sender must hear exactly this, because that is what its own API throws.
   */
  const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";

  const settle = (id) => {
    const req = pending.get(id);
    if (!req || req.expected.size > 0) {
      return;
    }
    pending.delete(id);
    if (req.targeted && req.lastResponse === undefined && req.silent !== undefined) {
      // Every leg of a ONE-frame request said "nobody listens here". `chrome.tabs.
      // sendMessage` fails in that case; resolving undefined would be the shell claiming
      // the app answered with nothing.
      req.reject(new Error(req.silent));
      return;
    }
    req.resolve(req.lastResponse);
  };

  const sendMessage = ({ fromKey, message }) => {
    const from = frames.get(fromKey);
    const targets = peersOf(fromKey);
    if (!from || targets.length === 0) {
      return Promise.resolve(undefined); // Chrome: callback(undefined)
    }
    const id = nextRequestId++;
    const sender = { id: from.extensionId, url: from.url };
    return new Promise((resolve) => {
      pending.set(id, {
        expected: new Set(targets.map(([key]) => key)),
        lastResponse: undefined,
        resolve,
      });
      for (const [key, frame] of targets) {
        frame.send({ kind: "message", payload: { requestId: id, message, sender } });
      }
    });
  };

  /**
   * One targeted leg: deliver to ONE frame and wait for its answer, in this same mesh.
   *
   * `chrome.tabs.sendMessage` is the consumer — Chrome addresses the content scripts of
   * one tab, which is not the fan-out `sendMessage` does. Reusing this router rather than
   * a second request map is the point: the same `pending` bookkeeping, the same
   * last-response settling, the same extension scoping (a caller cannot address a frame
   * of another extension, and the app's seat is an ordinary frame), and a frame that dies
   * still settles its legs through `unregisterFrame`.
   *
   * Chrome's semantics for the call itself: the addressed context answers, or the request
   * FAILS with "Receiving end does not exist". It never resolves `undefined` for "nobody
   * answered", so this promise rejects in that case (`settle` above). A caller that
   * treated silence as an empty answer would be reporting a delivery that did not happen.
   *
   * @returns {{ok: true, requestId: number, promise: Promise<unknown>}|{ok: false, error: string}}
   */
  const sendTo = ({ fromKey, targetKey, message }) => {
    const from = frames.get(fromKey);
    const target = frames.get(targetKey);
    if (!from) {
      return { ok: false, error: "Could not establish connection." };
    }
    if (!target || target.extensionId !== from.extensionId) {
      // Chrome's own answer for an addressable-but-absent receiver, and the same rule
      // `peersOf` applies: extension scoping is not relaxed for a targeted send.
      return { ok: false, error: NO_RECEIVER };
    }
    const id = nextRequestId++;
    const sender = { id: from.extensionId, url: from.url };
    const promise = new Promise((resolve, reject) => {
      pending.set(id, {
        expected: new Set([targetKey]),
        lastResponse: undefined,
        targeted: true,
        silent: undefined,
        resolve,
        reject,
      });
      try {
        target.send({ kind: "message", payload: { requestId: id, message, sender } });
      } catch (error) {
        // The frame vanished as it was being handed the message. That is the same truth
        // as a leg that dies mid-send: nothing there can answer.
        failTargeted(id, error.message);
      }
    });
    return { ok: true, requestId: id, promise };
  };

  /** Ends a targeted request as a failure, with the reason the mesh cannot deliver it. */
  const failTargeted = (id, reason) => {
    const req = pending.get(id);
    if (!req) {
      return;
    }
    pending.delete(id);
    req.reject(new Error(reason || NO_RECEIVER));
  };

  /**
   * The host-side marker for "this context was reached and nothing was listening in it"
   * (src/main/content-bridge.js turns the app loader's `nr: true` into this). It travels
   * as a response because that is the only channel a leg has, but it is NOT one: such a
   * leg settles, so no sender waits for an answer nobody will send, yet it never becomes
   * the value a peer resolves with, and it must not let a fan-out finish early while other
   * peers are still thinking. For a targeted send the distinction IS the answer — Chrome
   * fails that call — which is why the request also records the fact (`silent`).
   */
  const isNoReceiver = (response) =>
    Boolean(response && response.__rozeniteNoReceiver === true);

  const resolveDelivery = ({ fromKey, requestId, response }) => {
    const req = pending.get(requestId);
    if (!req || !req.expected.has(fromKey)) {
      return;
    }
    req.expected.delete(fromKey);
    if (isNoReceiver(response)) {
      req.silent =
        (typeof response.error === "string" && response.error) || NO_RECEIVER;
      settle(requestId);
      return;
    }
    req.lastResponse = response;
    // A real answer outranks a silent leg that arrived first: something did listen.
    req.silent = undefined;
    settle(requestId);
  };

  // ── Ports ────────────────────────────────────────────────────────────────
  const members = (port) => [port.initiator, ...port.legs];

  const closePort = (portId, exceptKey) => {
    const port = ports.get(portId);
    if (!port) {
      return;
    }
    ports.delete(portId);
    for (const key of members(port)) {
      if (key === exceptKey) {
        continue;
      }
      frames.get(key)?.send({ kind: "port-disconnect", payload: { portId } });
    }
  };

  const connect = ({ fromKey, name }) => {
    const from = frames.get(fromKey);
    const targets = peersOf(fromKey);
    if (!from || targets.length === 0) {
      return { ok: false, error: "Could not establish connection." };
    }
    const portId = nextPortId++;
    ports.set(portId, {
      extensionId: from.extensionId,
      initiator: fromKey,
      legs: new Set(targets.map(([key]) => key)),
    });
    const initiator = { id: from.extensionId, url: from.url };
    for (const [key, frame] of targets) {
      frame.send({ kind: "port-connect", payload: { portId, name, initiator } });
    }
    return { ok: true, portId };
  };

  const portPost = ({ fromKey, portId, message }) => {
    const port = ports.get(portId);
    if (!port || !members(port).includes(fromKey)) {
      return;
    }
    const from = frames.get(fromKey);
    const fromInfo = { id: from.extensionId, url: from.url };
    for (const key of members(port)) {
      if (key === fromKey) {
        continue;
      }
      frames
        .get(key)
        ?.send({ kind: "port-message", payload: { portId, message, from: fromInfo } });
    }
  };

  const portDisconnect = ({ fromKey, portId }) => closePort(portId, fromKey);

  // ── lifecycle ────────────────────────────────────────────────────────────
  const unregisterFrame = (key) => {
    frames.delete(key);
    for (const [id, req] of [...pending]) {
      if (req.expected.delete(key)) {
        if (req.targeted && req.lastResponse === undefined && req.silent === undefined) {
          // The one context this request addressed is gone. Chrome's call fails here;
          // resolving undefined would tell the sender the app had answered nothing.
          req.silent = `Could not establish connection. "${key}" is no longer reachable.`;
        }
        settle(id);
      }
    }
    for (const [portId, port] of [...ports]) {
      if (port.initiator === key || port.legs.has(key)) {
        closePort(portId, key);
      }
    }
  };

  return {
    registerFrame,
    unregisterFrame,
    sendMessage,
    sendTo,
    resolveDelivery,
    connect,
    portPost,
    portDisconnect,
  };
};

module.exports = { createMessageRouter };
