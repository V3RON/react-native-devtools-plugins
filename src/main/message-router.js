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
  const settle = (id) => {
    const req = pending.get(id);
    if (!req || req.expected.size > 0) {
      return;
    }
    pending.delete(id);
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

  const resolveDelivery = ({ fromKey, requestId, response }) => {
    const req = pending.get(requestId);
    if (!req || !req.expected.has(fromKey)) {
      return;
    }
    req.expected.delete(fromKey);
    req.lastResponse = response;
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
    resolveDelivery,
    connect,
    portPost,
    portDisconnect,
  };
};

module.exports = { createMessageRouter };
