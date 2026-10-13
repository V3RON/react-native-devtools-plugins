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
// Persistence is write-behind. A write updates the Map and broadcasts at once; the file is
// rewritten on a short per-(extension, area) debounce and on `flush()` (src/main/ipc.js calls
// it on quit). Rewriting a whole 10 MB area synchronously on every write cost ~70 ms of main's
// event loop per tiny `set`, which a busy extension would turn into a stalled shell. The price
// is the failure model: a disk error can no longer reject the write that caused it (the write
// already succeeded and was announced) — it is logged and retried with the next write/flush —
// and a crash can lose up to `persistDelayMs` of writes.
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
const createStorageService = ({
  openPersistence = memoryPersistence,
  log = () => {},
  persistDelayMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  const areas = new Map(); // `${extensionId}\0${area}` -> {map, persistence, legacy, dirty, timer}
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
      entry = {
        map: new Map(Object.entries(loaded)),
        persistence,
        // Written by the old per-frame shim (see electronStorePersistence): dotted keys are
        // still readable by name.
        legacy: Boolean(persistence && persistence.legacy),
        dirty: false,
        timer: null,
        id,
      };
      areas.set(id, entry);
    }
    return entry;
  };

  const save = (entry) => {
    if (entry.timer) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
    if (!entry.dirty || !entry.persistence) {
      return;
    }
    try {
      entry.persistence.save(Object.fromEntries(entry.map));
      entry.dirty = false;
    } catch (error) {
      // Stays dirty: the next write or flush retries.
      log(`could not persist ${entry.id.replace("\0", "/")}: ${error.message}`);
    }
  };
  const markDirty = (entry) => {
    if (!entry.persistence) {
      return;
    }
    entry.dirty = true;
    if (!entry.timer) {
      entry.timer = setTimer(() => save(entry), persistDelayMs);
      if (entry.timer && typeof entry.timer.unref === "function") {
        entry.timer.unref();
      }
    }
  };
  /** Write every pending change to disk now (quit, tests). */
  const flush = () => {
    for (const entry of areas.values()) {
      save(entry);
    }
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

  // An old-format file nested `"a.b"` as {a: {b}}. For such an area a key that is not stored
  // under its own name is looked up as a dotted path, so `get("settings.theme")` still finds
  // what an extension saved under that name. Reads only: nothing is rewritten, and a key
  // stored verbatim (a write after the upgrade) always wins.
  const dottedLookup = (map, key) => {
    const [first, ...rest] = key.split(".");
    let value = map.get(first);
    for (const part of rest) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
        return undefined;
      }
      value = value[part];
    }
    return value;
  };
  const legacyView = (map, keys) => {
    const names =
      typeof keys === "string"
        ? [keys]
        : Array.isArray(keys)
          ? keys
          : keys && typeof keys === "object"
            ? Object.keys(keys)
            : [];
    let view = map;
    for (const name of names) {
      if (typeof name === "string" && name.includes(".") && !map.has(name)) {
        const value = dottedLookup(map, name);
        if (value !== undefined) {
          view = view === map ? new Map(map) : view;
          view.set(name, value);
        }
      }
    }
    return view;
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
          value = core.get(entry.legacy ? legacyView(entry.map, arg) : entry.map, arg);
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
      markDirty(entry);
      return { ok: true, value, seq: broadcast(context.extensionId, area, changes) };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  };

  return {
    attach,
    detach,
    call,
    flush,
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
//
// That is exactly what the OLD per-frame shim did, so a file it wrote can hold `a.b` as
// `{a: {b}}`, and which nested objects came from dotted keys is not recoverable. Choice:
// do not guess and rewrite. Files carry a format marker; a non-empty file WITHOUT one is
// legacy, is read as-is (a nested value is still there under its first segment) and is
// flagged `legacy`, which makes the service resolve not-found dotted keys as paths. The
// marker records the flag, so it survives the first save and the fallback keeps working
// for as long as the file lives. A new or empty file is written in the new format and
// has no fallback.
const FORMAT_KEY = "__rozenite_storage_format__";

const electronStorePersistence = ({ cwd } = {}) => {
  const { default: Store } = require("electron-store");
  return (extensionId, area) => {
    const store = new Store({ name: `extension-${extensionId}-${area}`, ...(cwd ? { cwd } : {}) });
    const persistence = {
      legacy: false,
      load: () => {
        const raw = store.store;
        const marker = raw[FORMAT_KEY];
        persistence.legacy = marker ? Boolean(marker.legacy) : Object.keys(raw).length > 0;
        return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== FORMAT_KEY));
      },
      save: (items) => {
        store.store = { ...items, [FORMAT_KEY]: { version: 2, legacy: persistence.legacy } };
      },
    };
    return persistence;
  };
};

module.exports = {
  createStorageService,
  electronStorePersistence,
  SESSION_ACCESS_LEVELS,
  NOT_ALLOWED,
  FORMAT_KEY,
};
