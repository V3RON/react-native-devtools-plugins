// The browser-UI namespaces a background context expects but this host has no
// browser UI for: `chrome.action` and `chrome.notifications`.
//
// Both exist as REGISTRABLE SHELLS and nothing more. They are here because an MV3
// worker that references `chrome.action.onClicked` or `chrome.notifications.create`
// at module scope otherwise dies at LOAD time — an ESM worker's top-level
// statements run before any listener can guard them, so a missing namespace takes
// the whole background context with it (docs/OVERVIEW.md's stubbing rule: a
// no-op degrades, a TypeError kills).
//
// [STUB — issue #4 owns making this real]
//
// What stays fake on purpose, in one place each:
//   - `action` invents no toolbar button: no badge, no popup, no click. The one
//     thing Chrome hands an `onClicked` listener is a Tab, and there is no tab
//     model here (src/chrome-shim/tabs.js), so `onClicked` can never fire.
//   - `notifications.create` shows nothing and returns nothing. Chrome's callback
//     receives the notification id it allocated; allocating a plausible-looking id
//     for a notification that does not exist would let an extension store it, and
//     then a click that never happens has been promised forever. So the callback
//     gets `undefined`, once, plus one console line.
//   - `notifications.onClicked` therefore never fires either.
//
// `notifications` is permission-gated like Chrome's (src/shared/permissions.js):
// an extension that does not declare it fails the call. `action` needs no
// permission in Chrome and stays ungated here.
const { createEvent } = require("./event");

const callAsync = (callback, ...args) => {
  if (typeof callback === "function") {
    setTimeout(() => callback(...args), 0);
  }
};

/** `chrome.action` — [STUB, issue #4]. Registrable, inert, never fires. */
const createAction = () => ({
  onClicked: createEvent(),
  onBadgeTextChanged: createEvent(),
  create: (options, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
  setPopup: (details, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
  getPopup: (tabId, callback) => {
    callAsync(callback, "");
    return Promise.resolve("");
  },
  setIcon: (details, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
  setBadgeText: (details, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
  setBadgeBackgroundColor: (details, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
  setBadgeTextColor: (details, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
  setTitle: (details, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
  enable: (windowId, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
  disable: (windowId, callback) => {
    callAsync(callback);
    return Promise.resolve(undefined);
  },
});

/**
 * `chrome.notifications` — [STUB, issue #4] → Electron `Notification`.
 *
 * @param {(message: string) => void} [onStubCall] one honest report per worker
 *        context, so the console says "nothing was shown" instead of going quiet
 */
const createNotifications = ({ onStubCall = () => {} } = {}) => {
  let reported = false;
  const report = (method) => {
    if (reported) {
      return;
    }
    reported = true;
    onStubCall(
      `chrome.notifications.${method} is an inert shell: no notification was shown ` +
        "and notifications.onClicked will never fire (issue #4 owns making this real)."
    );
  };

  return {
    PermissionLevel: {
      unspecifed: "unspecifed", // Chrome's own typo, kept: extensions compare on it
      granted: "granted",
      denied: "denied",
    },
    onClicked: createEvent(),
    onClosed: createEvent(),
    onButtonClicked: createEvent(),
    onPermissionLevelChanged: createEvent(),
    onShowSettings: createEvent(),
    create: (notificationId, options, callback) => {
      const cb = typeof notificationId === "function" ? notificationId : callback;
      report("create");
      // Chrome: callback(notificationId). Nothing was created, so nothing is named.
      callAsync(cb, undefined);
      return Promise.resolve(undefined);
    },
    update: (notificationId, options, callback) => {
      const cb = typeof callback === "function" ? callback : notificationId;
      callAsync(cb, false);
      return Promise.resolve(false);
    },
    clear: (notificationId, callback) => {
      const cb = typeof notificationId === "function" ? notificationId : callback;
      callAsync(cb, false);
      return Promise.resolve(false);
    },
    getAll: (callback) => {
      callAsync(callback, {});
      return Promise.resolve({});
    },
    getPermissionLevel: (callback) => {
      // "granted" is not a claim about this host: the shell shows nothing either
      // way. It is the answer that stops an extension asking the user for a
      // permission this host would then have to honour.
      callAsync(callback, "granted");
      return Promise.resolve("granted");
    },
    // Removed since Chrome 42; kept registrable because real manifests still call it.
    setPermissionLevel: (level, callback) => {
      callAsync(callback);
      return Promise.resolve(undefined);
    },
  };
};

module.exports = { createAction, createNotifications };
