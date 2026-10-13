// The semantics of one chrome.storage StorageArea, over a plain Map
// (docs/features/STORAGE-AND-I18N.md). Pure: no Electron, no IPC, no persistence —
// the host's storage service (src/main/storage-service.js) owns the Maps and the
// frame-side shim (src/chrome-shim/storage.js) only forwards, so there is exactly one
// implementation of what get/set/remove/clear mean.
//
// Chrome rules this copies:
//   - values are JSON-serialized on the way in and out: a caller can never hold a
//     reference into the store, `undefined`/functions are dropped, a Date becomes its
//     ISO string, NaN becomes null;
//   - an absent key is ABSENT from a get() result (it is not `{key: undefined}`);
//   - a change event names only keys whose stored value really changed, with
//     `oldValue` absent for a new key and `newValue` absent for a removed one;
//   - a write that would break the quota changes NOTHING and fails with Chrome's text.

const LIMITS = {
  local: { QUOTA_BYTES: 10485760 },
  sync: {
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    // Published by Chrome, enforced by Chrome Sync's servers; this shell has no such
    // servers, so they are constants only.
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
  },
  // Chrome 112+: session shares local's 10 MB budget (it used to be 1 MB).
  session: { QUOTA_BYTES: 10485760 },
};

const AREAS = Object.keys(LIMITS);

const encoder = new TextEncoder();
const utf8Length = (text) => encoder.encode(text).length;

/** JSON copy of one value, or undefined when JSON has no representation for it. */
const copyValue = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const invocationError = (call) =>
  new TypeError(`Error in invocation of ${call}: No matching signature.`);

/** Chrome's byte accounting: key length + the JSON text of the value, in UTF-8. */
const bytesOf = (key, value) => utf8Length(key) + utf8Length(JSON.stringify(value));

const totalBytes = (map) => {
  let total = 0;
  for (const [key, value] of map) {
    total += bytesOf(key, value);
  }
  return total;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {Map<string, any>} map
 * @param {null|undefined|string|string[]|object} keys
 */
const get = (map, keys) => {
  const result = {};
  if (keys === null || keys === undefined) {
    for (const [key, value] of map) {
      result[key] = copyValue(value);
    }
    return result;
  }
  if (typeof keys === "string") {
    keys = [keys];
  }
  if (Array.isArray(keys)) {
    for (const key of keys) {
      if (typeof key !== "string") {
        throw invocationError("storage.get(optional string or array or object keys, function callback)");
      }
      if (map.has(key)) {
        result[key] = copyValue(map.get(key));
      }
    }
    return result;
  }
  if (isPlainObject(keys)) {
    // The object form: its values are defaults for absent keys.
    for (const key of Object.keys(keys)) {
      if (map.has(key)) {
        result[key] = copyValue(map.get(key));
      } else {
        const fallback = copyValue(keys[key]);
        if (fallback !== undefined) {
          result[key] = fallback;
        }
      }
    }
    return result;
  }
  throw invocationError("storage.get(optional string or array or object keys, function callback)");
};

const quotaError = (area, reason) => {
  if (area === "session") {
    return new Error("Session storage quota bytes exceeded. Values were not stored.");
  }
  return new Error(`${reason} quota exceeded`);
};

/**
 * Apply a set(). All-or-nothing: the quota is checked against the state the write
 * would produce, before anything is stored.
 *
 * @returns {Object<string, {oldValue?: any, newValue?: any}>} only the keys that changed
 */
const set = (map, area, items) => {
  if (!isPlainObject(items)) {
    throw invocationError("storage.set(object items, optional function callback)");
  }
  const incoming = new Map();
  for (const key of Object.keys(items)) {
    const value = copyValue(items[key]);
    if (value !== undefined) {
      incoming.set(key, value);
    }
  }

  const limits = LIMITS[area] || LIMITS.local;
  let bytes = totalBytes(map);
  let count = map.size;
  for (const [key, value] of incoming) {
    if (map.has(key)) {
      bytes -= bytesOf(key, map.get(key));
    } else {
      count += 1;
    }
    const itemBytes = bytesOf(key, value);
    bytes += itemBytes;
    if (limits.QUOTA_BYTES_PER_ITEM && itemBytes > limits.QUOTA_BYTES_PER_ITEM) {
      throw quotaError(area, "QUOTA_BYTES_PER_ITEM");
    }
  }
  if (limits.MAX_ITEMS && count > limits.MAX_ITEMS) {
    throw quotaError(area, "MAX_ITEMS");
  }
  if (bytes > limits.QUOTA_BYTES) {
    throw quotaError(area, "QUOTA_BYTES");
  }

  const changes = {};
  for (const [key, value] of incoming) {
    const had = map.has(key);
    const oldValue = map.get(key);
    if (had && same(oldValue, value)) {
      continue;
    }
    map.set(key, value);
    changes[key] = had ? { oldValue, newValue: copyValue(value) } : { newValue: copyValue(value) };
  }
  return changes;
};

const remove = (map, keys) => {
  const list = typeof keys === "string" ? [keys] : keys;
  if (!Array.isArray(list) || list.some((key) => typeof key !== "string")) {
    throw invocationError("storage.remove(string or array keys, optional function callback)");
  }
  const changes = {};
  for (const key of list) {
    if (map.has(key)) {
      changes[key] = { oldValue: map.get(key) };
      map.delete(key);
    }
  }
  return changes;
};

const clear = (map) => {
  const changes = {};
  for (const [key, value] of map) {
    changes[key] = { oldValue: value };
  }
  map.clear();
  return changes;
};

const getBytesInUse = (map, keys) => {
  if (keys === null || keys === undefined) {
    return totalBytes(map);
  }
  const list = typeof keys === "string" ? [keys] : keys;
  if (!Array.isArray(list) || list.some((key) => typeof key !== "string")) {
    throw invocationError("storage.getBytesInUse(optional string or array keys, function callback)");
  }
  let total = 0;
  for (const key of new Set(list)) {
    if (map.has(key)) {
      total += bytesOf(key, map.get(key));
    }
  }
  return total;
};

const getKeys = (map) => [...map.keys()];

module.exports = {
  LIMITS,
  AREAS,
  copyValue,
  bytesOf,
  get,
  set,
  remove,
  clear,
  getBytesInUse,
  getKeys,
};
