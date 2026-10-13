// The host-owned chrome.storage (docs/features/STORAGE-AND-I18N.md).
//
// Chrome keeps one storage per extension, shared by every context of it (devtools
// page, panels, background worker, options page), and tells every one of them when
// it changes. This shell used to keep a store per frame: session was an in-memory Map
// per frame and local/sync were a per-frame electron-store on a shared file, so a
// value written in one frame was invisible to its siblings and nobody heard about it.
// Here main owns the state, which is the only place a second frame can be reached from:
//
//   - one Map per (extension, area), loaded lazily; `local`/`sync` persist through the
//     injected `openPersistence`, `session` never does (it dies with the shell, which is
//     Chrome's "cleared when the browser restarts");
//   - every write is applied once, here, and its change event goes to EVERY registered
//     context of THAT extension — the writer included, so each context sees the same
//     events in the same order — and to no other extension's context;
//   - identity is the registered frame (`attach` is called by src/main/ipc.js with an
//     extension id read from the frame's own URL). A call names a `frameKey` the router
//     already verified; nothing in a payload says whose storage it is.
//
// Ordering: each extension has a counter, and every event carries its number. A write's
// reply carries the number of the last event it produced, so the calling context can
// hold its callback until that event has been delivered to it — the order Chrome shows
// (onChanged before the set callback) without relying on IPC replies and pushes
// arriving in any particular order relative to each other.
//
// Pure: Electron enters only through `send` closures and `openPersistence`.
const core = require("../shared/storage-core");

const SESSION_ACCESS_LEVELS = ["TRUSTED_CONTEXTS", "TRUSTED_AND_UNTRUSTED_CONTEXTS"];
const OPS = new Set(["get", "set", "remove", "clear", "getBytesInUse", "getKeys", "setAccessLevel"]);

const NOT_ALLOWED = "Access to storage is not allowed from this context.";

/** No disk: every area is memory (unit tests, and what `session` always is). */
const memoryPersistence = () => null;

/**
 * @param {object} [deps]
 * @param {(extensionId: string, area: string) => ({load: () => object, save: (items: object) => void}|null)} [deps.openPersistence]
 *        called for `local` and `sync` only; null means "memory only"
 * @param {(message: string) => void} [deps.log]
 */
const createStorageService = ({ openPersistence = memoryPersistence, log = () => {} } = {}) => {
  const areas = new Map(); // `${extensionId}\0${area}` -> {map, persistence}
  const contexts = new Map(); // frameKey -> {frameKey, extensionId, send, allowed, trusted}
  const sequences = new Map(); // extensionId -> last event number
  const accessLevels = new Map(); // extensionId -> session access level

  const open = (extensionId, area) => {
    const id = `${extensionId}\0${area}`;
    let entry = areas.get(id);
    if (!entry) {
      const persistence = area === "session" ? null : openPersistence(extensionId, area);
      let loaded = {};
      if (persistence) {
        try {
          loaded = persistence.load() || {};
        } catch (error) {
          log(`could not read ${area} storage of ${extensionId}: ${error.message}`);
        }
      }
      entry = { map: new Map(Object.entries(loaded)), persistence };
      areas.set(id, entry);
    }
    return entry;
  };

  const sessionLevel = (extensionId) => accessLevels.get(extensionId) || "TRUSTED_CONTEXTS";

  /** Whether `context` may see `area` of its extension right now. */
  const mayAccess = (context, area) =>
    area !== "session" || context.trusted || sessionLevel(context.extensionId) === "TRUSTED_AND_UNTRUSTED_CONTEXTS";

  const broadcast = (extensionId, area, changes) => {
    const seq = (sequences.get(extensionId) || 0) + 1;
    sequences.set(extensionId, seq);
    for (const context of [...contexts.values()]) {
      if (context.extensionId !== extensionId || !context.allowed() || !mayAccess(context, area)) {
        continue;
      }
      try {
        context.send({ seq, area, changes });
      } catch {
        // A frame that cannot be reached is retired by its own sender (ipc.js).
      }
    }
    return seq;
  };

  const attach = ({ frameKey, extensionId, send, allowed = () => true, trusted = true }) => {
    contexts.set(frameKey, { frameKey, extensionId, send, allowed, trusted });
  };
  const detach = (frameKey) => {
    contexts.delete(frameKey);
  };

  /**
   * One storage call from one registered context.
   *
   * @returns {{ok: true, value: any, seq: number}|{ok: false, error: string}} `seq` is
   *          the number of the last event this call produced (0 when nothing changed).
   */
  const call = ({ frameKey, area, op, arg }) => {
    const context = contexts.get(frameKey);
    if (!context) {
      return { ok: false, error: "storage: unknown context" };
    }
    if (!core.AREAS.includes(area) || !OPS.has(op)) {
      return { ok: false, error: `storage: unsupported call ${area}.${op}` };
    }
    if (!context.allowed()) {
      return { ok: false, error: "permission 'storage' is not declared" };
    }
    if (!mayAccess(context, area)) {
      return { ok: false, error: NOT_ALLOWED };
    }
    try {
      if (op === "setAccessLevel") {
        const level = arg && arg.accessLevel;
        if (area !== "session") {
          return { ok: false, error: "storage: setAccessLevel exists on storage.session only" };
        }
        if (!context.trusted) {
          return { ok: false, error: NOT_ALLOWED };
        }
        if (!SESSION_ACCESS_LEVELS.includes(level)) {
          return { ok: false, error: "Error in invocation of storage.setAccessLevel: accessLevel is not a valid enum value." };
        }
        accessLevels.set(context.extensionId, level);
        return { ok: true, value: undefined, seq: 0 };
      }

      const entry = open(context.extensionId, area);
      let value;
      let changes = null;
      switch (op) {
        case "get":
          value = core.get(entry.map, arg);
          break;
        case "getBytesInUse":
          value = core.getBytesInUse(entry.map, arg);
          break;
        case "getKeys":
          value = core.getKeys(entry.map);
          break;
        case "set":
          changes = core.set(entry.map, area, arg);
          break;
        case "remove":
          changes = core.remove(entry.map, arg);
          break;
        case "clear":
          changes = core.clear(entry.map);
          break;
      }

      if (!changes || Object.keys(changes).length === 0) {
        return { ok: true, value, seq: 0 };
      }
      if (entry.persistence) {
        try {
          entry.persistence.save(Object.fromEntries(entry.map));
        } catch (error) {
          // The disk refused: the Map is ahead of it. Forget the Map so the next call
          // reloads what is really there, and tell the caller its write did not land.
          areas.delete(`${context.extensionId}\0${area}`);
          return { ok: false, error: `storage: could not persist (${error.message})` };
        }
      }
      return { ok: true, value, seq: broadcast(context.extensionId, area, changes) };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  };

  return {
    attach,
    detach,
    call,
    /** Diagnostics/tests: which contexts would hear an extension's events. */
    contextsOf: (extensionId) =>
      [...contexts.values()].filter((c) => c.extensionId === extensionId).map((c) => c.frameKey),
  };
};

// ── the electron-store persistence src/main/ipc.js installs ─────────────────
// Same file names the per-frame stores used (`extension-<id>-<area>`), so what an
// extension saved before the move is still there. The WHOLE object is written
// (`store.store = …`) rather than `store.set(items)`: electron-store treats a dot in
// a key as a path, which would store `{"a.b": 1}` as `{a: {b: 1}}` and read back
// a different key than the extension wrote.
const electronStorePersistence = () => {
  const { default: Store } = require("electron-store");
  return (extensionId, area) => {
    const store = new Store({ name: `extension-${extensionId}-${area}` });
    return {
      load: () => store.store,
      save: (items) => {
        store.store = items;
      },
    };
  };
};

module.exports = {
  createStorageService,
  electronStorePersistence,
  SESSION_ACCESS_LEVELS,
  NOT_ALLOWED,
};
