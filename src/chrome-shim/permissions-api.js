// `chrome.permissions` — accept-and-grant, truthfully (docs/features/SMALL-SHIMS.md).
//
// Chrome's model: required permissions are granted at install, `request()` asks the
// user for OPTIONAL ones, and `contains`/`getAll` report the result. This shell has
// no prompt and no install-time grant step: capability is decided from the manifest
// **on disk** by the host (src/main/ipc.js hands every frame its verdict, and
// src/chrome-shim/permission-gate.js + src/main/delivery-scope.js enforce it). So
// the only honest answer this namespace can give is a report of that verdict:
//
//   contains/getAll  — exactly the permissions the manifest declares. Not "everything
//                      the extension asked about": an undeclared permission reports
//                      false, which is what makes the shim safe to put in front of
//                      feature-detection code instead of a lie that lights it up.
//   request          — resolves true when everything requested is already declared
//                      (Chrome's own fast path: no prompt for a granted permission).
//                      Requests for anything else resolve FALSE rather than true,
//                      because answering true would claim a capability the host's
//                      gate then refuses at the first call — a worse outcome than a
//                      clean false. One console line says why.
//   remove           — resolves, and nothing changes. Chrome behaves the same way for
//                      REQUIRED permissions: they cannot be revoked at runtime, and
//                      `onRemoved` does not fire for them.
//   onAdded/onRemoved — registrable, never fire: nothing here changes a grant, so
//                      there is no transition to report.
//
// So `request()` accepting a call is shape fidelity, not new capability — the
// divergence is recorded in docs/LIMITATIONS.md.
//
// `host_permissions` are deliberately absent from every answer, matching
// src/shared/permissions.js: they buy network reach, not API access, so reporting
// them as granted permissions would overstate what the extension can call.
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");

/**
 * @param {object} deps
 * @param {() => (string[]|Promise<string[]>)} deps.declared the extension's declared
 *        permissions from the HOST's verdict (RUNTIME_REGISTER), never from a
 *        page-reachable manifest. May return a promise while that verdict is in
 *        flight — the frame's own `chrome.*` is built before the reply lands, and
 *        guessing either way would be a fabrication.
 * @param {(message: string) => void} [deps.onUnsupportedRequest] one honest report
 *        per request that asks for something this shell cannot grant
 */
const createPermissionsApi = ({ declared, onUnsupportedRequest = () => {} }) => {
  /** Declared list now, or after the host's verdict lands. */
  const withDeclared = (produce) => {
    const list = declared() || [];
    if (list && typeof list.then === "function") {
      return list.then((settled) => produce(new Set(settled || [])));
    }
    return produce(new Set(list));
  };

  const requested = (permissions) => {
    if (!permissions || !Array.isArray(permissions.permissions)) {
      return [];
    }
    return permissions.permissions.filter((p) => typeof p === "string");
  };

  const missing = (permissions, granted) =>
    requested(permissions).filter((p) => !granted.has(p));

  return {
    contains: (permissions, callback) =>
      promiseOrCallback(
        () => withDeclared((granted) => missing(permissions, granted).length === 0),
        callback
      ),

    getAll: (callback) =>
      promiseOrCallback(
        () => withDeclared((granted) => ({ permissions: [...granted] })),
        callback
      ),

    request: (permissions, callback) =>
      promiseOrCallback(
        () =>
          withDeclared((granted) => {
            const missingNow = missing(permissions, granted);
            if (missingNow.length === 0) {
              return true;
            }
            onUnsupportedRequest(
              `Permissions ${JSON.stringify(missingNow)} are not declared in this ` +
                "extension's manifest.json. This host decides capability from the manifest " +
                "on disk and shows no prompt, so request() grants nothing new: it reports " +
                "false instead of claiming access the gate would then refuse."
            );
            return false;
          }),
        callback
      ),

    remove: (permissions, callback) =>
      // Chrome cannot remove a REQUIRED permission either, and does not fire
      // onRemoved for one. Nothing changes here, which is the honest answer.
      promiseOrCallback(() => undefined, callback),

    onAdded: createEvent(),
    onRemoved: createEvent(),
  };
};

module.exports = { createPermissionsApi };
