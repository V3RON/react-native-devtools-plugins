// Which extension CONTEXTS the host can still reach, and how to push to one
// (docs/features/BACKGROUND-WORKER.md, docs/features/SMALL-SHIMS.md).
//
// Several host behaviors produce an event that belongs to ONE extension context and
// nowhere else: a system notification the user clicked, a download that finished, an
// alarm that fired. The router in src/main/message-router.js is the wrong tool — it
// fans out to every frame of an extension, and Chrome does not do that: it delivers
// to the context that registered the listener. So the host keeps its own registry of
// the `send` closure each registered frame was handed, and delivers by that key.
//
// Why this is not a privileged channel: the `send` closure is the SAME one
// src/main/ipc.js builds for the message router and the background host's lifecycle
// push (`frame.send(...)` — the only form measured to actually land on Electron 38,
// see the note in ipc.js). A frame cannot register, look up, or address another
// frame's key: keys are built from the host's own `WebContents` id + `frameId`, and
// only main calls `register`.
//
// Pure: nothing here imports Electron, so the routing rules are unit-tested under
// bare Node.
const createContextRegistry = () => {
  const contexts = new Map(); // frameKey -> {frameKey, extensionId, send, kind}

  /**
   * @param {{frameKey: string, extensionId: string, send: function, kind?: string}} frame
   */
  const register = (frame) => {
    contexts.set(frame.frameKey, frame);
  };

  const unregister = (frameKey) => {
    contexts.delete(frameKey);
  };

  /**
   * Push one delivery to one context.
   *
   * @returns {boolean} whether it reached a context. A false here is the honest
   *          answer to "did the extension hear about it": the context was gone, so
   *          nothing may claim the event was delivered.
   */
  const deliver = (frameKey, delivery) => {
    const context = contexts.get(frameKey);
    if (!context) {
      return false;
    }
    try {
      context.send(delivery);
      return true;
    } catch {
      // The frame is detached: retire it, exactly like the router's sender does.
      contexts.delete(frameKey);
      return false;
    }
  };

  return {
    register,
    unregister,
    deliver,
    has: (frameKey) => contexts.has(frameKey),
    /** Diagnostics/tests: which contexts are reachable, and of which extension. */
    list: () =>
      [...contexts.values()].map(({ frameKey, extensionId, kind }) => ({
        frameKey,
        extensionId,
        kind: kind || "frame",
      })),
  };
};

// The process-wide registry src/main/ipc.js feeds (created lazily so requiring this
// module from a test pulls in nothing).
let instance;
const getContextRegistry = () => {
  if (!instance) {
    instance = createContextRegistry();
  }
  return instance;
};

module.exports = { createContextRegistry, getContextRegistry };
