const { default: Store } = require("electron-store");
const { EventEmitter } = require("events");

/**
 * Creates a StorageArea implementation using electron-store
 * @param {Store} store - The electron-store instance
 * @param {string} areaName - The storage area name (local, sync, etc.)
 */
const createStorageArea = (store, areaName) => {
  const eventEmitter = new EventEmitter();

  return {
    // Constants
    QUOTA_BYTES: areaName === "local" ? 10485760 : 102400, // 10MB for local, 100KB for sync

    // Methods
    get: (keys, callback) => {
      const executeGet = () => {
        if (keys === null || keys === undefined) {
          return store.store;
        } else if (typeof keys === "string") {
          const value = store.get(keys);
          return { [keys]: value };
        } else if (Array.isArray(keys)) {
          const result = {};
          keys.forEach((key) => {
            result[key] = store.get(key);
          });
          return result;
        } else if (typeof keys === "object") {
          const result = {};
          Object.keys(keys).forEach((key) => {
            const value = store.get(key);
            result[key] = value !== undefined ? value : keys[key];
          });
          return result;
        }
        return {};
      };

      if (callback) {
        try {
          const result = executeGet();
          callback(result);
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

        // Store old values for change events
        Object.keys(items).forEach((key) => {
          oldValues[key] = store.get(key);
        });

        // Set new values
        store.set(items);

        // Emit change events
        Object.keys(items).forEach((key) => {
          const oldValue = oldValues[key];
          const newValue = items[key];

          if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
            changedItems[key] = {
              oldValue: oldValue,
              newValue: newValue,
            };
          }
        });

        if (Object.keys(changedItems).length > 0) {
          eventEmitter.emit("changed", changedItems, areaName);
        }
      };

      if (callback) {
        try {
          executeSet();
          callback();
        } catch (error) {
          callback();
        }
      } else {
        return Promise.resolve(executeSet());
      }
    },

    remove: (keys, callback) => {
      const executeRemove = () => {
        const keysToRemove = Array.isArray(keys) ? keys : [keys];
        const oldValues = {};
        const changedItems = {};

        // Store old values for change events
        keysToRemove.forEach((key) => {
          oldValues[key] = store.get(key);
        });

        // Remove keys
        keysToRemove.forEach((key) => {
          store.delete(key);
        });

        // Emit change events
        keysToRemove.forEach((key) => {
          if (oldValues[key] !== undefined) {
            changedItems[key] = {
              oldValue: oldValues[key],
              newValue: undefined,
            };
          }
        });

        if (Object.keys(changedItems).length > 0) {
          eventEmitter.emit("changed", changedItems, areaName);
        }
      };

      if (callback) {
        try {
          executeRemove();
          callback();
        } catch (error) {
          callback();
        }
      } else {
        return Promise.resolve(executeRemove());
      }
    },

    clear: (callback) => {
      const executeClear = () => {
        const oldStore = { ...store.store };
        store.clear();

        // Emit change events for all cleared items
        const changedItems = {};
        Object.keys(oldStore).forEach((key) => {
          changedItems[key] = {
            oldValue: oldStore[key],
            newValue: undefined,
          };
        });

        if (Object.keys(changedItems).length > 0) {
          eventEmitter.emit("changed", changedItems, areaName);
        }
      };

      if (callback) {
        try {
          executeClear();
          callback();
        } catch (error) {
          callback();
        }
      } else {
        return Promise.resolve(executeClear());
      }
    },

    getBytesInUse: (keys, callback) => {
      const executeGetBytesInUse = () => {
        let itemsToCheck = {};

        if (keys === null || keys === undefined) {
          itemsToCheck = store.store;
        } else if (typeof keys === "string") {
          const value = store.get(keys);
          if (value !== undefined) {
            itemsToCheck[keys] = value;
          }
        } else if (Array.isArray(keys)) {
          keys.forEach((key) => {
            const value = store.get(key);
            if (value !== undefined) {
              itemsToCheck[key] = value;
            }
          });
        }

        // Calculate bytes used
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
          const result = executeGetBytesInUse();
          callback(result);
        } catch (error) {
          callback(0);
        }
      } else {
        return Promise.resolve(executeGetBytesInUse());
      }
    },

    getKeys: (callback) => {
      const executeGetKeys = () => {
        return Object.keys(store.store);
      };

      if (callback) {
        try {
          const result = executeGetKeys();
          callback(result);
        } catch (error) {
          callback([]);
        }
      } else {
        return Promise.resolve(executeGetKeys());
      }
    },

    // Event handling
    onChanged: {
      addListener: (callback) => {
        eventEmitter.on("changed", callback);
      },
      removeListener: (callback) => {
        eventEmitter.removeListener("changed", callback);
      },
      hasListener: (callback) => {
        return eventEmitter.listenerCount("changed") > 0;
      },
    },
  };
};

/**
 * Creates a new storage for the extension
 * @param {string} extensionId
 */
const getStorage = (extensionId) => {
  const globalStorageEventEmitter = new EventEmitter();

  const localStore = new Store({
    name: `extension-${extensionId}-local`,
  });

  const syncStore = new Store({
    name: `extension-${extensionId}-sync`,
  });

  const local = createStorageArea(localStore, "local");
  const sync = createStorageArea(syncStore, "sync");

  local.onChanged.addListener((changes, areaName) => {
    globalStorageEventEmitter.emit("changed", changes, areaName);
  });

  sync.onChanged.addListener((changes, areaName) => {
    globalStorageEventEmitter.emit("changed", changes, areaName);
  });

  return {
    local,
    sync,
  };
};

const getChromeNamespace = (extensionId) => {
  const storage = getStorage(extensionId);
  const globalStorageEventEmitter = new EventEmitter();

  // Wire up global storage change events
  storage.local.onChanged.addListener((changes, areaName) => {
    globalStorageEventEmitter.emit("changed", changes, areaName);
  });

  storage.sync.onChanged.addListener((changes, areaName) => {
    globalStorageEventEmitter.emit("changed", changes, areaName);
  });

  const eventEmitter = new EventEmitter();

  window.addEventListener("message", (event) => {
    const {
      data: { event: eventName, data },
    } = event;

    if (eventName === "RequestStarted") {
      console.log(data);
      eventEmitter.emit("onBeforeRequest", data);
      eventEmitter.emit("onBeforeSendHeaders", data);
    }

    if (eventName === "RequestFinished") {
      eventEmitter.emit("onRequestFinished", {
        ...data,
        getContent: (cb) => {
          cb(
            "eyJkYXRhIjp7ImNoYXJhY3RlciI6eyJpZCI6IjEiLCJuYW1lIjoiUmljayBTYW5jaGV6Iiwic3RhdHVzIjoiQWxpdmUiLCJzcGVjaWVzIjoiSHVtYW4iLCJnZW5kZXIiOiJNYWxlIiwib3JpZ2luIjp7Im5hbWUiOiJFYXJ0aCAoQy0xMzcpIn0sImxvY2F0aW9uIjp7Im5hbWUiOiJDaXRhZGVsIG9mIFJpY2tzIn19fX0=",
            "base64"
          );
        },
      });
    }
  });

  return {
    runtime: {
      onMessage: {
        addListener: () => {},
      },
      lastError: null, // For callback-based error handling
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (callback) => {
          eventEmitter.on("onBeforeRequest", callback);
        },
      },
      onBeforeSendHeaders: {
        addListener: (callback) => {
          eventEmitter.on("onBeforeSendHeaders", callback);
        },
      },
      onSendHeaders: {
        addListener: () => {},
      },
      onHeadersReceived: {
        addListener: () => {},
      },
      onAuthRequired: {
        addListener: () => {},
      },
      onBeforeRedirect: {
        addListener: () => {},
      },
      onResponseStarted: {
        addListener: () => {},
      },
      onCompleted: {
        addListener: () => {},
      },
    },
    storage: {
      ...storage,
      onChanged: {
        addListener: (callback) => {
          globalStorageEventEmitter.on("changed", callback);
        },
        removeListener: (callback) => {
          globalStorageEventEmitter.removeListener("changed", callback);
        },
        hasListener: (callback) => {
          return globalStorageEventEmitter.listenerCount("changed") > 0;
        },
      },
    },
    // devtools: {
    //   network: {
    //     onRequestFinished: {
    //       addListener: (callback) => {
    //         eventEmitter.on("onRequestFinished", callback);
    //       },
    //     },
    //   },
    // },
  };
};

module.exports = { getChromeNamespace };
