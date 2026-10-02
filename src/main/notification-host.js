// The host half of `chrome.notifications` — the only place a system notification can
// actually be raised (docs/features/SMALL-SHIMS.md, GitHub issue #4).
//
// Three rules this file exists to keep:
//
//   1. NOTHING IS SHOWN THAT CANNOT BE REPORTED. `show` resolves an error string when
//      the platform refused, and the shim then names no id. A notification that does
//      not exist must not have an id, because an id is a promise about a click.
//   2. A CLICK IS NEVER FABRICATED. Altair's `notifications.onClicked` listener opens
//      a changelog URL, so firing that event without the OS having observed a click
//      would launch something the user never asked for. `onClicked` therefore fires
//      only from the notifier's own click callback, and `onClosed` only from the
//      notifier's own close callback or a `clear` this host performed.
//   3. THE EVENT GOES TO THE CONTEXT THAT CREATED IT. Chrome delivers to the context
//      that made the notification, not to every frame of the extension, so the owner's
//      frame key is recorded at show time and the delivery goes back through
//      src/main/context-registry.js — the same `send` closure the message router and
//      the background host's lifecycle push use.
//
// `notifier` is injected: a test records what would have been shown and hands back
// click/close callbacks to fire by hand, so the suite never raises a real system
// notification (docs/ARCHITECTURE.md's layering rule — nothing here is required for
// the rules above to be testable).
const NOOP = () => {};

/**
 * @param {object} deps
 * @param {(notification: {id: string, title: string, message: string, silent?: boolean,
 *         iconUrl?: string}, handlers: {onClick: function, onClose: function}) =>
 *         (Promise<string|null>|string|null)} deps.notifier shows it; resolves null on
 *        success or an error message; may be a no-op recorder in tests
 * @param {{deliver: (frameKey: string, delivery: object) => boolean}} deps.contextRegistry
 * @param {(id: string) => (boolean|Promise<boolean>)} [deps.hide] closes a shown
 *        notification in the backend (Electron 38 has no close(), so this may only
 *        drop the host's reference — see electronNotifier's note)
 * @param {() => (string|Promise<string>)} [deps.permissionLevel] the observable level
 */
const createNotificationHost = ({
  notifier = NOOP,
  contextRegistry,
  hide = null,
  permissionLevel = () => "granted",
}) => {
  const owners = new Map(); // notificationId -> {frameKey, hide}
  let seq = 0;

  const deliver = (frameKey, event, notificationId) =>
    contextRegistry ? contextRegistry.deliver(frameKey, {
      kind: "notification",
      payload: { event, notificationId },
    }) : false;

  /**
   * Show one notification on behalf of one context.
   *
   * @returns {Promise<{ok: true, notificationId: string}|{ok: false, error: string}>}
   *          the failure carries the platform's own reason, which the shim turns into
   *          "no id was allocated".
   */
  const show = async ({ frameKey, id, title, message, silent, iconUrl }) => {
    const notificationId =
      typeof id === "string" && id ? id : `rozenite-${Date.now()}-${++seq}`;
    // Registered BEFORE showing: a notifier whose click callback fires synchronously
    // must still find an owner, or the click would be silently lost.
    const owner = { frameKey, clicked: false, closed: false, cleared: false };
    owners.set(notificationId, owner);
    try {
      const failure = await notifier(
        {
          id: notificationId,
          title: String(title ?? ""),
          message: String(message ?? ""),
          silent: Boolean(silent),
          iconUrl,
        },
        {
          // Guarded so a notifier firing twice (or after a close) cannot hand the
          // extension two clicks for one notification.
          onClick: () => {
            if (owner.closed || owner.clicked || owner.cleared) {
              return;
            }
            owner.clicked = true;
            deliver(frameKey, "click", notificationId);
          },
          onClose: () => {
            if (owner.closed || owner.cleared) {
              return;
            }
            owner.closed = true;
            owners.delete(notificationId);
            deliver(frameKey, "closed", notificationId);
          },
        }
      );
      if (failure) {
        // Nothing was shown: the owner record goes away with it, so no click can
        // ever be forwarded for a notification that does not exist.
        owners.delete(notificationId);
        return { ok: false, error: String(failure) };
      }
      return { ok: true, notificationId };
    } catch (error) {
      owners.delete(notificationId);
      return { ok: false, error: (error && error.message) || "notification backend failed" };
    }
  };

  /**
   * Report whether this host knew the id, and stop forwarding events for it.
   *
   * Chrome's `onClosed` for a cleared notification is fired by the SHIM (it owns the
   * registry the extension's `getAll` reads), so this method fires nothing itself.
   * Marking the owner cleared is what keeps a backend that reports a click later —
   * because Electron 38 has no way to take a shown notification back off the screen —
   * from handing the extension a click for an id it already cleared.
   */
  const clear = async ({ notificationId }) => {
    const owner = owners.get(notificationId);
    if (!owner) {
      return false;
    }
    owner.cleared = true;
    owners.delete(notificationId);
    if (hide) {
      try {
        await hide(notificationId);
      } catch {
        // Closing is best-effort. The id stays owned until the backend says it
        // closed, which is what `getAll` and a later `clear` then report.
      }
    }
    return true;
  };

  return {
    show,
    clear,
    permissionLevel: () => permissionLevel(),
    /** Diagnostics/tests: which ids are up, and which context owns each. */
    list: () =>
      [...owners.entries()].map(([id, owner]) => ({ id, frameKey: owner.frameKey })),
  };
};

// ── the Electron-backed singleton, created lazily by src/main/ipc.js ─────────
let instance;

/**
 * Electron's `Notification`, wrapped in the injected-notifier shape.
 *
 * `isSupported()` is the only permission truth this host can observe: macOS/Windows
 * need a bundled app identity to raise a notification at all, and Linux needs a
 * notification daemon. There is no prompt to read a verdict from, so
 * `getPermissionLevel` reports that observation and nothing more.
 */
const electronNotifier = () => {
  const { Notification } = require("electron");
  const live = new Map(); // id -> Notification
  const show = async (notification, handlers) => {
    if (!Notification.isSupported()) {
      return "this platform cannot show notifications (Electron reports Notification.isSupported() false)";
    }
    try {
      const note = new Notification({
        title: notification.title,
        message: notification.message,
        silent: notification.silent === true,
      });
      live.set(notification.id, note);
      note.on("click", () => handlers.onClick());
      note.on("close", () => {
        live.delete(notification.id);
        handlers.onClose();
      });
      note.on("revoked", () => {
        live.delete(notification.id);
        handlers.onClose();
      });
      note.show();
      return null;
    } catch (error) {
      return (error && error.message) || "Notification.show() failed";
    }
  };
  show.hide = (id) => {
    const note = live.get(id);
    if (!note) {
      return false;
    }
    live.delete(id);
    // Electron 38 removed Notification.close(): a shown notification stays on screen
    // until the user or the OS dismisses it. What the shell CAN do is stop
    // forwarding its events, which is what makes `clear` honest — the extension is
    // told onClosed (by its own shim) and will not be handed a click for an id it
    // cleared. Recorded in docs/LIMITATIONS.md rather than presented as a dismiss.
    note.removeAllListeners();
    return true;
  };
  return show;
};

const attachNotificationHost = (deps = {}) => {
  const { getContextRegistry } = require("./context-registry");
  instance = createNotificationHost({
    notifier: electronNotifier(),
    contextRegistry: getContextRegistry(),
    permissionLevel: () => {
      const { Notification } = require("electron");
      try {
        return Notification.isSupported() ? "granted" : "denied";
      } catch {
        return "unspecifed";
      }
    },
    ...deps,
  });
  return instance;
};

const getNotificationHost = () => instance || attachNotificationHost();

module.exports = {
  createNotificationHost,
  electronNotifier,
  attachNotificationHost,
  getNotificationHost,
};
