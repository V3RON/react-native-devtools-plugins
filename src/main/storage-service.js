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
          // Never cache an area that was not read: a later write would overwrite a file
          // this process has not seen. The call fails and the next one reads again.
          log(`could not read ${area} storage of ${extensionId}: ${error.message}`);
          throw new Error(`storage: could not read ${area} storage (${error.message})`);
        }
      }
      entry = {
        map: new Map(Object.entries(loaded)),
        persistence,
        // Present for an area the old per-frame shim wrote (see electronStorePersistence):
        // {snapshot: the nested data as it was at upgrade, shadow: dotted names that have
        // been written or removed since, which the fallback must never resolve again}.
        legacy:
          persistence && persistence.legacy
            ? { snapshot: persistence.legacy.snapshot, shadow: new Set(persistence.legacy.shadow || []) }
            : null,
        // The meta file could not be written when the area was first read; save() retries
        // it before it writes any data.
        metaDirty: Boolean(persistence && persistence.metaPending),
        dirty: false,
        timer: null,
        id,
      };
      if (entry.metaDirty) {
        markDirty(entry);
      }
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
      // Meta first: the shadow set (and the "this area was already classified" fact) must be
      // on disk no later than the data it describes, or a crash between the two writes
      // could resurrect a removed dotted key / re-classify rewritten data as legacy.
      if (entry.metaDirty && entry.persistence.saveMeta) {
        entry.persistence.saveMeta(
          entry.legacy ? { snapshot: entry.legacy.snapshot, shadow: [...entry.legacy.shadow] } : null
        );
        entry.metaDirty = false;
      }
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

  // An old-format file nested `"a.b"` as {a: {b}}, and which nested objects came from dotted
  // keys cannot be recovered, so nothing is migrated or rewritten. Instead the data as it was
  // at upgrade time is kept as a frozen snapshot (`legacy.snapshot`), and a get() of a dotted
  // key that is not stored under its own name is answered from it — but only while that is
  // still the pre-upgrade truth:
  //   - the snapshot is never updated, and its top-level key must still hold exactly the
  //     snapshot's value, so nested data written AFTER the upgrade is not read as paths;
  //   - a dotted name that has been written or removed since is in `legacy.shadow` (persisted
  //     beside the snapshot) and is never resolved again, so a removed value cannot come back.
  // Removing a key the fallback resolves emits onChanged {oldValue} like any removal; the
  // nested leaf itself stays in its parent object (that object is a key of its own).
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fallbackValue = (entry, key) => {
    const legacy = entry.legacy;
    if (!legacy || !key.includes(".") || entry.map.has(key) || legacy.shadow.has(key)) {
      return undefined;
    }
    const [first, ...rest] = key.split(".");
    if (!Object.hasOwn(legacy.snapshot, first) || !entry.map.has(first) || !same(entry.map.get(first), legacy.snapshot[first])) {
      return undefined;
    }
    let value = legacy.snapshot[first];
    for (const part of rest) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
        return undefined;
      }
      value = value[part];
    }
    return value;
  };
  const legacyView = (entry, keys) => {
    const names =
      typeof keys === "string"
        ? [keys]
        : Array.isArray(keys)
          ? keys
          : keys && typeof keys === "object"
            ? Object.keys(keys)
            : [];
    let view = entry.map;
    for (const name of names) {
      const value = typeof name === "string" ? fallbackValue(entry, name) : undefined;
      if (value !== undefined) {
        view = view === entry.map ? new Map(entry.map) : view;
        view.set(name, value);
      }
    }
    return view;
  };
  const shadow = (entry, key) => {
    if (entry.legacy && key.includes(".") && !entry.legacy.shadow.has(key)) {
      entry.legacy.shadow.add(key);
      entry.metaDirty = true;
    }
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
          value = core.get(entry.legacy ? legacyView(entry, arg) : entry.map, arg);
          break;
        case "getBytesInUse":
          value = core.getBytesInUse(entry.map, arg);
          break;
        case "getKeys":
          value = core.getKeys(entry.map);
          break;
        case "set":
          changes = core.set(entry.map, area, arg);
          if (entry.legacy) {
            Object.keys(arg).forEach((key) => shadow(entry, key));
          }
          break;
        case "remove": {
          const list = typeof arg === "string" ? [arg] : arg;
          const resolved = [];
          if (entry.legacy && Array.isArray(list)) {
            for (const key of list) {
              const old = typeof key === "string" ? fallbackValue(entry, key) : undefined;
              if (old !== undefined) {
                resolved.push([key, { oldValue: old }]);
              }
              if (typeof key === "string") {
                shadow(entry, key);
              }
            }
          }
          changes = core.remove(entry.map, arg);
          if (resolved.length) {
            changes = Object.fromEntries([...resolved, ...Object.entries(changes)]);
          }
          break;
        }
        case "clear":
          if (entry.legacy) {
            [...entry.map.keys()].forEach((key) => shadow(entry, key));
          }
          changes = core.clear(entry.map);
          break;
      }

      if (entry.metaDirty) {
        markDirty(entry);
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
// Same file names the per-frame stores used (`extension-<id>-<area>.json`), so what an
// extension saved before the move is still there. The WHOLE object is written
// (`store.store = …`) rather than `store.set(items)`: electron-store treats a dot in
// a key as a path, which would store `{"a.b": 1}` as `{a: {b: 1}}` and read back
// a different key than the extension wrote.
//
// The data file holds the extension's keys and NOTHING else — no marker in its key
// namespace. What this module needs to remember lives in a sibling file,
// `extension-<id>-<area>.meta.json`: {version: 2, legacy: null | {snapshot, shadow}}.
// The first time an area is opened with no meta file, a non-empty data file is by
// definition one the old per-frame shim wrote: its content is frozen into
// `legacy.snapshot` (see the fallback in createStorageService) and the meta file is written
// at once, so that decision is made exactly once. An empty/new area gets `legacy: null`,
// also written at once — otherwise its first data would be mistaken for legacy later.
const electronStorePersistence = ({ cwd, Store: StoreClass } = {}) => {
  const Store = StoreClass || require("electron-store").default; // StoreClass: test seam
  return (extensionId, area) => {
    const name = `extension-${extensionId}-${area}`;
    const options = cwd ? { cwd } : {};
    const store = new Store({ name, ...options });
    const metaStore = new Store({ name: `${name}.meta`, ...options });
    const persistence = {
      legacy: null,
      metaPending: false,
      load: () => {
        const items = store.store;
        const meta = metaStore.store;
        if (meta.version === 2) {
          persistence.legacy = meta.legacy || null;
        } else {
          persistence.legacy =
            Object.keys(items).length > 0 ? { snapshot: JSON.parse(JSON.stringify(items)), shadow: [] } : null;
          try {
            metaStore.store = { version: 2, legacy: persistence.legacy };
          } catch {
            // Not fatal and not a reason to forget the classification: it stays in memory,
            // and the service retries the write before any data is written.
            persistence.metaPending = true;
          }
        }
        return items;
      },
      save: (items) => {
        store.store = items;
      },
      saveMeta: (legacy) => {
        metaStore.store = { version: 2, legacy };
        persistence.legacy = legacy;
        persistence.metaPending = false;
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
};
