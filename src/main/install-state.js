// Which extension versions the host has already seen (GitHub issue #3).
//
// Chrome's `runtime.onInstalled` reasons are derived from exactly this state:
// an extension id the browser has never seen is an INSTALL, a stored version
// that differs from the manifest on disk is an UPDATE, and anything else means
// "nothing new happened, this is a normal launch" (→ `onStartup`).
//
// The state is main-process state in `electron-store`, like the frontend's
// preferences (src/main/preferences.js), and it lives under `userData` — which
// is what makes the behavior testable: a fresh `--user-data-dir` yields
// `install` again, because the file it is remembered in does not exist yet.
//
// Deliberately NOT derived from the extension folder's mtime or a content hash:
// `version` is what Chrome compares and what an extension author bumps.
const { default: Store } = require("electron-store");

const CURRENT_VERSION = 1;

/**
 * The reason an extension's background context is being started, or null when
 * nothing was installed or updated. Pure, so the rule is unit-testable without
 * Electron or a userData dir.
 *
 * @param {{version?: string}|null|undefined} stored what was remembered, if anything
 * @param {string} version the version the manifest on disk declares now
 * @returns {"install" | "update" | null}
 */
const installReasonFor = (stored, version) => {
  if (!stored || typeof stored !== "object") {
    return "install";
  }
  if (String(stored.version) !== String(version)) {
    return "update";
  }
  return null;
};

/**
 * @param {{get: (key: string) => any, set: (key: string, value: any) => void}} store
 *        an electron-store-shaped store, injected so the rule is testable
 */
const createInstallState = (store) => {
  const read = () => {
    const all = store.get("extensions");
    return all && typeof all === "object" ? all : {};
  };

  return {
    /** What is remembered for one extension id: {version, installedAt} | null. */
    get: (extensionId) => {
      const entry = read()[extensionId];
      return entry && typeof entry === "object" ? entry : null;
    },

    /**
     * Compare the manifest's version against what is remembered, remember this
     * launch's version, and return the lifecycle reason it implies. Writing on
     * every call is what makes the second launch of an unchanged extension come
     * back as null rather than "install" forever.
     */
    record: (extensionId, version) => {
      const all = read();
      const reason = installReasonFor(all[extensionId], version);
      all[extensionId] = {
        version: String(version ?? ""),
        installedAt:
          all[extensionId] && all[extensionId].installedAt
            ? all[extensionId].installedAt
            : new Date().toISOString(),
      };
      store.set("extensions", all);
      return reason;
    },

    /** Forget one extension (or, with no id, everything) — a re-install test hook. */
    forget: (extensionId) => {
      if (extensionId === undefined) {
        store.set("extensions", {});
        return;
      }
      const all = read();
      delete all[extensionId];
      store.set("extensions", all);
    },
  };
};

// One store per main process, created lazily: electron-store resolves its path
// from app.getPath("userData"), which is only meaningful once the app is ready
// and after any --user-data-dir override is applied.
let instance;
const openInstallState = () => {
  if (!instance) {
    instance = createInstallState(
      new Store({ name: "extension-installs", projectVersion: String(CURRENT_VERSION) })
    );
  }
  return instance;
};

module.exports = {
  CURRENT_VERSION,
  createInstallState,
  installReasonFor,
  openInstallState,
};
