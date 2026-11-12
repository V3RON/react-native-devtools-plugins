// chrome.storage for one extension context (docs/features/STORAGE-AND-I18N.md).
//
// What an area MEANS (get/set/remove/clear, quota, change detection, JSON copies) lives
// in src/shared/storage-core.js and runs wherever the state lives. This file is the
// API shape around it — promise AND callback style, lastError, the per-area and global
// `onChanged` events — and it runs in one of two modes, chosen by what is injected:
//
//   call      — the production mode. The state is the HOST's (src/main/storage-service.js):
//               every call is an async round trip, and every change to the extension's
//               storage, from this context or any other, comes back as a delivery that
//               `handleDelivery` turns into events. A write's callback is held until its
//               own event has been delivered here, so listeners see the change first, as
//               in Chrome.
//   createBackend — a synchronous in-process backend (unit tests, tools): the state lives
//               in this context and the events are fired by the write itself.
//
// Backend interface (synchronous, createBackend mode):
//   getAll(): object   get(key): value   set(itemsObject): void
//   delete(key): void  clear(): void
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");
const core = require("../shared/storage-core");

// In-memory backend for the in-process mode (the production session area is the
// host's, shared by the extension's contexts).
const createMemoryBackend = () => {
  const map = new Map();
  return {
    getAll: () => Object.fromEntries(map),
    get: (key) => map.get(key),
    set: (items) => Object.entries(items).forEach(([k, v]) => map.set(k, v)),
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
  };
};

// How long a write waits for its own change event before giving up and answering
// anyway. The event follows the reply within a tick in practice; the bound exists so a
// lost delivery degrades to "listener told late" and never to "write never completes".
const EVENT_WAIT_MS = 2000;

/** `fn(keys, cb)`-style signatures where the leading argument is optional. */
const optionalFirst = (first, second) =>
  typeof first === "function" ? [undefined, first] : [first, second];

/**
 * Build the local+sync+session areas for one extension.
 *
 * @param {object} deps
 * @param {(area: string) => object} [deps.createBackend] in-process mode
 * @param {(area: string, op: string, arg: any) => Promise<{ok: boolean, value?: any, seq?: number, error?: string}>} [deps.call]
 *        host mode: one storage operation, executed against the host's store
 */
const createExtensionStorage = ({ createBackend, call }) => {
  const globalChanged = createEvent();
  const events = {};
  let lastErrorPair = null;

  const fire = (area, changes) => {
    // Per-area events take (changes); chrome.storage.onChanged adds the area name.
    events[area]._fire(changes);
    globalChanged._fire(changes, area);
  };

  // ── host mode: events arrive as deliveries; writes wait for their own ──────
  let delivered = 0;
  let waiters = [];
  const handleDelivery = (delivery) => {
    const change = delivery && delivery.payload ? delivery.payload : delivery;
    if (!change || !events[change.area] || !change.changes) {
      return;
    }
    try {
      fire(change.area, change.changes);
    } finally {
      delivered = Math.max(delivered, Number(change.seq) || 0);
      waiters = waiters.filter((waiter) => {
        if (waiter.seq > delivered) {
          return true;
        }
        waiter.release();
        return false;
      });
    }
  };
  const eventDelivered = (seq) =>
    !seq || seq <= delivered
      ? Promise.resolve()
      : new Promise((resolve) => {
          const waiter = { seq, release: () => (clearTimeout(timer), resolve()) };
          const timer = setTimeout(() => {
            waiters = waiters.filter((w) => w !== waiter);
            resolve();
          }, EVENT_WAIT_MS);
          waiters.push(waiter);
        });

  const executeRemote = (area, op, arg) =>
    Promise.resolve(call(area, op, arg)).then((reply) => {
      if (!reply || !reply.ok) {
        throw new Error((reply && reply.error) || "storage: the host did not answer");
      }
      return eventDelivered(reply.seq).then(() => reply.value);
    });

  // ── in-process mode: the same core over a synchronous backend ──────────────
  const backends = {};
  if (!call) {
    for (const area of core.AREAS) {
      backends[area] = createBackend(area);
    }
  }
  const executeLocal = (area, op, arg) => {
    const backend = backends[area];
    const map = new Map(Object.entries(backend.getAll()));
    let changes = null;
    let value;
    switch (op) {
      case "get":
        value = core.get(map, arg);
        break;
      case "getBytesInUse":
        value = core.getBytesInUse(map, arg);
        break;
      case "getKeys":
        value = core.getKeys(map);
        break;
      case "set":
        changes = core.set(map, area, arg);
        backend.set(Object.fromEntries(Object.keys(changes).map((key) => [key, map.get(key)])));
        break;
      case "remove":
        changes = core.remove(map, arg);
        Object.keys(changes).forEach((key) => backend.delete(key));
        break;
      case "clear":
        changes = core.clear(map);
        backend.clear();
        break;
      case "setAccessLevel":
        // One context sees its own memory: there is no other context to restrict.
        break;
    }
    if (changes && Object.keys(changes).length > 0) {
      fire(area, changes);
    }
    return Promise.resolve(value);
  };
  const execute = call ? executeRemote : executeLocal;

  const createArea = (area) => {
    const onChanged = createEvent();
    events[area] = onChanged;
    const run = (op, arg, callback) =>
      promiseOrCallback(() => execute(area, op, arg), callback, {
        setError: lastErrorPair && lastErrorPair.setError,
        clearError: lastErrorPair ? lastErrorPair.clearError : undefined,
      });

    const api = {
      ...core.LIMITS[area],
      get: (keys, callback) => {
        [keys, callback] = optionalFirst(keys, callback);
        return run("get", keys, callback);
      },
      set: (items, callback) => run("set", items, callback),
      remove: (keys, callback) => run("remove", keys, callback),
      clear: (callback) => run("clear", undefined, callback),
      getBytesInUse: (keys, callback) => {
        [keys, callback] = optionalFirst(keys, callback);
        return run("getBytesInUse", keys, callback);
      },
      getKeys: (callback) => run("getKeys", undefined, callback),
      onChanged,
    };
    if (area === "session") {
      // Chrome: session is invisible to content scripts unless the extension widens it.
      api.setAccessLevel = (details, callback) => run("setAccessLevel", details, callback);
    }
    return api;
  };

  const storage = {};
  for (const area of core.AREAS) {
    storage[area] = createArea(area);
  }
  storage.onChanged = globalChanged;
  // Host -> context entry points; src/chrome-shim/index.js does not expose them, it only
  // reads the three areas and `onChanged`.
  storage.handleDelivery = handleDelivery;
  storage.bindLastError = (pair) => {
    lastErrorPair = pair;
  };
  return storage;
};

module.exports = {
  createExtensionStorage,
  createMemoryBackend,
};
