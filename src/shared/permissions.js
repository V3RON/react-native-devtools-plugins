// Declared-permission enforcement (docs/features/EXTENSION-MANAGEMENT.md,
// docs/LIMITATIONS.md §Security).
//
// The shape rule stays: every namespace an extension asks for exists, so
// feature detection by CALLING keeps working (docs/OVERVIEW.md stubbing rule).
// What changed is that a declaration now buys capability: an extension that
// calls an API whose permission it did not declare gets a failing call, not a
// working one. Enforcement has two homes and both are asserted:
//
//   - the transport (src/main/ipc.js + src/main/delivery-scope.js): the host
//     decides from the manifest on disk and simply does not send what was not
//     granted, so a frame cannot talk itself into data;
//   - the shim (src/chrome-shim/permission-gate.js): the promise/callback APIs
//     answer with `runtime.lastError` + a rejected promise, like Chrome's
//     permission errors.
//
// Deviation, stated rather than implied: Chrome does not inject an undeclared
// namespace at all (`chrome.tabs === undefined`), while this shell keeps the
// namespace and fails the call. Shape first, then capability — see
// docs/LIMITATIONS.md.
//
// Only `permissions` counts, like Chrome's `permissions.contains()`:
// `host_permissions` grants network reach, not API access, and
// `optional_permissions` are by definition not granted yet.
const API_PERMISSIONS = {
  storage: "storage",
  tabs: "tabs",
  webRequest: "webRequest",
  notifications: "notifications",
  alarms: "alarms",
  downloads: "downloads",
};

// Namespaces Chrome's DevTools extensions may use without declaring anything.
// Keeping this explicit stops "not in the table" from silently meaning "needs
// a permission nobody declared".
const UNGATED_APIS = [
  "runtime",
  "i18n",
  "action",
  "commands",
  "contextMenus",
  "extension",
];

/** The permission an API namespace needs, or null when it needs none. */
const requiredPermission = (api) =>
  Object.prototype.hasOwnProperty.call(API_PERMISSIONS, api)
    ? API_PERMISSIONS[api]
    : null;

/** @returns {string[]} every permission the manifest declares */
const declaredPermissions = (manifest) => {
  const declared = manifest && manifest.permissions;
  return Array.isArray(declared) ? declared.filter((p) => typeof p === "string") : [];
};

/**
 * A gate over a permission set that may not be known yet.
 *
 * Why the "unknown" state exists: the extension-frame preload fetches the
 * manifest/host verdict over async IPC while page scripts run immediately, and a
 * frame must never be denied a permission it does hold. While unknown, `check`
 * and `has` return a PROMISE that settles once the verdict lands; callers that
 * cannot wait (webRequest's listener registration) act on it as soon as it does.
 *
 * @param {() => (object|null|undefined)} getManifest returns the manifest, or
 *        nothing while it is unknown; call `manifestLoaded()` when it arrives
 */
const createPermissionGate = (getManifest) => {
  const known = () => {
    const manifest = getManifest();
    return manifest && typeof manifest === "object" ? manifest : null;
  };
  let waiters = [];

  const settled = () =>
    new Promise((resolve) => {
      const manifest = known();
      if (manifest) {
        resolve(manifest);
        return;
      }
      waiters.push(resolve);
    });

  const decide = (api, permission, manifest) =>
    declaredPermissions(manifest).includes(permission)
      ? { ok: true }
      : {
          ok: false,
          permission,
          error:
            `Cannot use chrome.${api}.*: permission '${permission}' is not declared in ` +
            "this extension's manifest.json.",
        };

  return {
    /** @returns {{ok: true}|{ok: false, error, permission}|Promise<verdict>} */
    check(api) {
      const permission = requiredPermission(api);
      if (!permission) {
        return { ok: true };
      }
      const manifest = known();
      if (!manifest) {
        return settled().then((m) => decide(api, permission, m));
      }
      return decide(api, permission, manifest);
    },
    /** @returns {boolean|Promise<boolean>} */
    has(permission) {
      const manifest = known();
      if (!manifest) {
        return settled().then((m) => declaredPermissions(m).includes(permission));
      }
      return declaredPermissions(manifest).includes(permission);
    },
    /** The manifest arrived: release every waiter with the real answer. */
    manifestLoaded() {
      const manifest = known() || {};
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) {
        resolve(manifest);
      }
    },
    declared: () => declaredPermissions(known()),
  };
};

/**
 * A gate over an explicit permission map (`{tabs: true, …}`), which is what the
 * host hands a frame at registration. Same unknown/promise behavior, so the
 * frame can build its chrome.* before the answer exists.
 * @param {() => (object|null)} getGrants
 */
const createGrantGate = (getGrants) =>
  createPermissionGate(() => {
    const grants = getGrants();
    if (!grants) {
      return null;
    }
    return {
      permissions: Object.keys(grants).filter((permission) => grants[permission]),
    };
  });

module.exports = {
  API_PERMISSIONS,
  UNGATED_APIS,
  createGrantGate,
  createPermissionGate,
  declaredPermissions,
  requiredPermission,
};
