// Pure chrome.storage.StorageArea implementation against an injected
// backend — no electron-store (or any storage tech) reference in here.
//
// Backend interface (synchronous):
//   getAll(): object        — every key/value
//   get(key): value         — single value (undefined if absent)
//   set(itemsObject): void  — set many
//   delete(key): void
//   clear(): void
//
// NOTE: per-frame backend instances writing the same file race with each
// other (docs/LIMITATIONS.md). The fix is to inject a main-process-backed
// backend later — no changes needed in this file.
const { createEvent } = require("./event");

const QUOTA_BYTES = { local: 10485760, sync: 102400 }; // 10MB / 100KB
// Chrome exposes the session quota as MAX_SESSION_STORAGE_QUOTA (1 MiB).
const SESSION_MAX_BYTES = 1048576;

// In-memory backend: chrome.storage.session semantics (per-context, not
// persisted). Deviation: Chrome shares session storage across an extension's
// contexts; here it is per-frame until the router owns storage.
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

const createStorageArea = (backend, areaName) => {
  const onChanged = createEvent();

  return {
    QUOTA_BYTES: areaName === "session" ? undefined : QUOTA_BYTES[areaName],
    ...(areaName === "session" ? { MAX_SESSION_STORAGE_QUOTA: SESSION_MAX_BYTES } : {}),

    get: (keys, callback) => {
      const executeGet = () => {
        if (keys === null || keys === undefined) {
          return backend.getAll();
        } else if (typeof keys === "string") {
          const value = backend.get(keys);
          return { [keys]: value };
        } else if (Array.isArray(keys)) {
          const result = {};
          keys.forEach((key) => {
            result[key] = backend.get(key);
          });
          return result;
        } else if (typeof keys === "object") {
          const result = {};
          Object.keys(keys).forEach((key) => {
            const value = backend.get(key);
            result[key] = value !== undefined ? value : keys[key];
          });
          return result;
        }
        return {};
      };

      if (callback) {
        try {
          callback(executeGet());
        } catch (error) {
          callback({});
        }
      } else {
        return Promise.resolve(executeGet());
      }
    },

    set: (items, callback) => {
      const executeSet = () => {
        const oldValues = {};
        const changedItems = {};

        Object.keys(items).forEach((key) => {
          oldValues[key] = backend.get(key);
        });

        backend.set(items);

        Object.keys(items).forEach((key) => {
          const oldValue = oldValues[key];
          const newValue = items[key];

          if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
            changedItems[key] = { oldValue, newValue };
          }
        });

        if (Object.keys(changedItems).length > 0) {
          onChanged._fire(changedItems, areaName);
        }
      };

      if (callback) {
        try {
          executeSet();
        } catch (error) {
          // Chrome-like: surface nothing, still invoke the callback
        }
        callback();
      } else {
        return Promise.resolve(executeSet());
      }
    },

    remove: (keys, callback) => {
      const executeRemove = () => {
        const keysToRemove = Array.isArray(keys) ? keys : [keys];
        const oldValues = {};
        const changedItems = {};

        keysToRemove.forEach((key) => {
          oldValues[key] = backend.get(key);
        });

        keysToRemove.forEach((key) => {
          backend.delete(key);
        });

        keysToRemove.forEach((key) => {
          if (oldValues[key] !== undefined) {
            changedItems[key] = { oldValue: oldValues[key], newValue: undefined };
          }
        });

        if (Object.keys(changedItems).length > 0) {
          onChanged._fire(changedItems, areaName);
        }
      };

      if (callback) {
        try {
          executeRemove();
        } catch (error) {
          // Chrome-like: surface nothing, still invoke the callback
        }
        callback();
      } else {
        return Promise.resolve(executeRemove());
      }
    },

    clear: (callback) => {
      const executeClear = () => {
        const oldStore = { ...backend.getAll() };
        backend.clear();

        const changedItems = {};
        Object.keys(oldStore).forEach((key) => {
          changedItems[key] = { oldValue: oldStore[key], newValue: undefined };
        });

        if (Object.keys(changedItems).length > 0) {
          onChanged._fire(changedItems, areaName);
        }
      };

      if (callback) {
        try {
          executeClear();
        } catch (error) {
          // Chrome-like: surface nothing, still invoke the callback
        }
        callback();
      } else {
        return Promise.resolve(executeClear());
      }
    },

    getBytesInUse: (keys, callback) => {
      const executeGetBytesInUse = () => {
        let itemsToCheck = {};

        if (keys === null || keys === undefined) {
          itemsToCheck = backend.getAll();
        } else if (typeof keys === "string") {
          const value = backend.get(keys);
          if (value !== undefined) {
            itemsToCheck[keys] = value;
          }
        } else if (Array.isArray(keys)) {
          keys.forEach((key) => {
            const value = backend.get(key);
            if (value !== undefined) {
              itemsToCheck[key] = value;
            }
          });
        }

        let totalBytes = 0;
        Object.keys(itemsToCheck).forEach((key) => {
          const keyBytes = new TextEncoder().encode(key).length;
          const valueBytes = new TextEncoder().encode(
            JSON.stringify(itemsToCheck[key])
          ).length;
          totalBytes += keyBytes + valueBytes;
        });

        return totalBytes;
      };

      if (callback) {
        try {
          callback(executeGetBytesInUse());
        } catch (error) {
          callback(0);
        }
      } else {
        return Promise.resolve(executeGetBytesInUse());
      }
    },

    getKeys: (callback) => {
      const executeGetKeys = () => Object.keys(backend.getAll());

      if (callback) {
        try {
          callback(executeGetKeys());
        } catch (error) {
          callback([]);
        }
      } else {
        return Promise.resolve(executeGetKeys());
      }
    },

    onChanged,
  };
};

/**
 * Build the local+sync+session areas for one extension, backends created via
 * `createBackend(areaName)`.
 */
const createExtensionStorage = ({ createBackend }) => ({
  local: createStorageArea(createBackend("local"), "local"),
  sync: createStorageArea(createBackend("sync"), "sync"),
  session: createStorageArea(createBackend("session"), "session"),
});

module.exports = {
  createStorageArea,
  createExtensionStorage,
  createMemoryBackend,
};
