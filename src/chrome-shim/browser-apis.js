// The browser-UI namespaces a background context expects: `chrome.action` and
// `chrome.notifications`.
//
// Both had to exist from the day the background context did: an MV3 worker that
// references `chrome.action.onClicked` or `chrome.notifications.create` at module
// scope otherwise dies at LOAD time — an ESM worker's top-level statements run before
// any listener can guard them, so a missing namespace takes the whole background
// context with it (docs/OVERVIEW.md's stubbing rule: a no-op degrades, a TypeError
// kills). Only ONE of them is still a shell.
//
// `notifications` is REAL now (docs/features/SMALL-SHIMS.md, issue #4): a system
// notification is shown, the id it was given is the id the callback receives, and the
// click/close events are the OS's own. What it still does not do:
//   - `onButtonClicked` / `onShowSettings` never fire — Electron's `Notification` has
//     no button callbacks and no settings affordance, so a `buttons` array is reported
//     as ignored rather than dropped in silence;
//   - a notification that could not be shown is given NO id. Chrome's callback receives
//     the id it allocated; allocating a plausible one for something that is not on
//     screen would let an extension store it, and a click that never happens would have
//     been promised forever. One console line carries the platform's reason.
//
// `action` stays a shell: Chrome hands an `onClicked` listener a Tab, and the one tab
// this shell has is the inspected RN target, which has no toolbar button to click. So
// the methods accept and resolve, `onClicked` never fires, and that is the honest state
// until there is a toolbar surface or an explicit "no toolbar here" decision
// (docs/LIMITATIONS.md).
//
// `notifications` is permission-gated like Chrome's (src/shared/permissions.js): an
// extension that does not declare it fails the call. `action` needs no permission in
// Chrome and stays ungated here.
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");

const callAsync = (callback, ...args) => {
  if (typeof callback === "function") {
    setTimeout(() => callback(...args), 0);
  }
};

/** `chrome.action` — accept-and-grant by design: registrable, inert, never fires. Chrome's
 *  toolbar surface does not exist here; see the namespace comment in index.js. */
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
 * `chrome.notifications` — [REAL] Electron `Notification`
 * (docs/features/SMALL-SHIMS.md, GitHub issue #4).
 *
 * What is real:
 *   - `create` shows a system notification and names the id it allocated, so an
 *     extension can store it and `clear` it, and so a later click has something to
 *     refer to. If nothing could be shown, `create` names NOTHING: the id is the
 *     promise of a click, and a failed show does not get to make one. One console
 *     line carries the reason.
 *   - the registry behind `clear` / `getAll` / `update`, so `clear` answers with
 *     whether it knew that id and `getAll` with what is actually still up;
 *   - `onClicked` / `onClosed`, fired by the real notification the user clicked or
 *     dismissed, delivered into the context that created it. An `onClicked` this
 *     shell could not observe is NEVER fired — Altair's listener opens a changelog
 *     URL, so a fabricated click would launch something.
 *
 * What is not real, stated:
 *   - `onButtonClicked` / `onShowSettings` never fire: Electron's Notification has no
 *     button callbacks and no settings affordance, so a `buttons` array in the
 *     options is reported as ignored rather than silently dropped;
 *   - `getPermissionLevel` reports what this host can OBSERVE (whether the platform
 *     notification backend works at all) — there is no permission prompt to read a
 *     verdict from. `setPermissionLevel` was removed from Chrome in 42 and stays a
 *     registrable no-op because real manifests still call it.
 *
 * @param {object} deps
 * @param {(notification: {id: string, title: string, message: string, iconUrl?: string,
 *         silent?: boolean}) => (Promise<string|null>|string|null)} deps.show
 *        shows it; resolves null on success or an error message on failure, and is
 *        the ONLY way a notification reaches the screen — a test injects a recorder
 * @param {(id: string) => (boolean|Promise<boolean>)} [deps.hide] closes what `show` opened
 * @param {(() => (string|Promise<string>))|string} [deps.permissionLevel] "granted" |
 *        "denied" | "unspecifed" (Chrome's own typo, kept: extensions compare on it)
 * @param {(message: string) => void} [deps.onUnsupported]
 */
const createNotifications = ({
  show = null,
  hide = null,
  permissionLevel = "granted",
  onUnsupported = () => {},
} = {}) => {
  const shown = new Map(); // id -> {options, closed}
  let nextGeneratedId = 1;
  const reported = new Set();
  const report = (key, message) => {
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    onUnsupported(message);
  };

  const events = {
    onClicked: createEvent(),
    onClosed: createEvent(),
    onButtonClicked: createEvent(),
    onPermissionLevelChanged: createEvent(),
    onShowSettings: createEvent(),
  };

  /** The injected level may be a value or a getter that asks the host. */
  const level = async () => {
    const value = typeof permissionLevel === "function" ? permissionLevel() : permissionLevel;
    return await value;
  };

  /** Chrome: `onClosed` fires once per notification, however it went away. */
  const fireClosed = (id) => {
    const entry = shown.get(id);
    if (!entry || entry.closed) {
      return;
    }
    entry.closed = true;
    shown.delete(id);
    events.onClosed._fire(id);
  };

  const createNotification = async (notificationId, options) => {
    const opts = options || (typeof notificationId === "object" && notificationId) || {};
    // Chrome allocates an id when the caller did not name one, and requires one when
    // the caller did; a named id that is still showing is NOT replaced (Chrome's
    // update-on-create rule is a separate call).
    const id =
      typeof notificationId === "string" && notificationId
        ? notificationId
        : `rozenite-${Date.now()}-${nextGeneratedId++}`;
    if (shown.has(id)) {
      return id;
    }
    if (!show) {
      // No capability injected at all: nothing can be shown, so nothing is named.
      report(
        "no-capability",
        "chrome.notifications.create has no notification backend in this context: nothing was " +
          "shown and notifications.onClicked will not fire for it."
      );
      return undefined;
    }
    if (Array.isArray(opts.buttons) && opts.buttons.length) {
      report(
        "buttons",
        `chrome.notifications: ${opts.buttons.length} button(s) ignored — Electron's Notification has ` +
          "no button callbacks, so notifications.onButtonClicked never fires."
      );
    }
    if (opts.requireInteraction === false) {
      report(
        "autoDismiss",
        "chrome.notifications: requireInteraction is ignored — this host cannot auto-dismiss a " +
          "system notification, so it stays up until the user closes it."
      );
    }
    let failure;
    try {
      failure = await show({
      id,
      title: typeof opts.title === "string" ? opts.title : "",
      message: typeof opts.message === "string" ? opts.message : "",
        iconUrl: opts.iconUrl,
        silent: opts.iconType === "silent",
      });
    } catch (error) {
      // A notifier that throws is a failed show, not a crashed extension: the shim's
      // promise-style API rejects nothing here, it just declines to name an id.
      failure = (error && error.message) || "the notification backend threw";
    }
    if (failure) {
      // Nothing was shown, so no id is named: an id is a promise about a click.
      // One line per context, not per attempt: an extension that retries in a loop
      // would otherwise fill the console with the same platform refusal.
      report("show-failed", `chrome.notifications.create could not show a notification: ${failure}`);
      return undefined;
    }
    shown.set(id, { options: { ...opts }, closed: false });
    return id;
  };

  return {
    PermissionLevel: {
      unspecifed: "unspecifed", // Chrome's own typo, kept: extensions compare on it
      granted: "granted",
      denied: "denied",
    },
    ...events,

    create: (notificationId, options, callback) => {
      const cb =
        typeof notificationId === "function"
          ? notificationId
          : typeof options === "function"
            ? options
            : callback;
      const named = typeof notificationId === "string" ? notificationId : undefined;
      const opts = typeof notificationId === "object" ? notificationId : options;
      return promiseOrCallback(() => createNotification(named, opts), cb);
    },

    // Chrome: resolves true when the id belonged to the extension and was still up.
    // Updating a notification that is ALREADY on screen is not something Electron
    // can do, so the registry is not rewritten to claim the shown one changed.
    update: (notificationId, options, callback) =>
      promiseOrCallback(
        () => {
          const known = shown.has(notificationId);
          if (!known) {
            return false;
          }
          report(
            `update:${notificationId}`,
            "chrome.notifications.update: a notification already on screen cannot be changed by " +
              "this host, so the id is reported as known and the displayed text is unchanged."
          );
          return true;
        },
        typeof notificationId === "function" ? notificationId : callback
      ),

    clear: (notificationId, callback) =>
      promiseOrCallback(async () => {
        const known = shown.has(notificationId);
        if (known) {
          if (hide) {
            await hide(notificationId);
          }
          // Chrome fires onClosed for a cleared notification too.
          fireClosed(notificationId);
        }
        return known;
      }, typeof notificationId === "function" ? notificationId : callback),

    getAll: (callback) =>
      promiseOrCallback(
        () =>
          Object.fromEntries(
            [...shown.entries()].map(([id, entry]) => [id, { ...entry.options }])
          ),
        callback
      ),

    getPermissionLevel: (callback) =>
      promiseOrCallback(() => level(), callback),

    // Removed since Chrome 42; kept registrable because real manifests still call it.
    setPermissionLevel: (levelOrCallback, callback) =>
      promiseOrCallback(() => undefined, typeof levelOrCallback === "function" ? levelOrCallback : callback),

    // ── host → context event delivery (NOT part of chrome.notifications) ─────
    // The OS handed main a click or a close; it arrives on this context's own
    // RUNTIME_DELIVER channel and the shim decides what it means. Chrome's rule
    // preserved: the event goes to the context that created the notification, not
    // to every frame of the extension.
    _onDelivery: (delivery) => {
      if (!delivery || delivery.kind !== "notification") {
        return false;
      }
      const payload = delivery.payload || {};
      const id = payload && payload.notificationId;
      if (!id) {
        return false;
      }
      if (payload.event === "click") {
        events.onClicked._fire(id);
        return true;
      }
      if (payload.event === "closed") {
        fireClosed(id);
        return true;
      }
      return false;
    },
    _shownIds: () => [...shown.keys()],
  };
};

module.exports = { createAction, createNotifications };
