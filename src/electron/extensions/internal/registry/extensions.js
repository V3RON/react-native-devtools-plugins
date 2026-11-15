// Extension discovery: "installed extension" == folder in extensionsDir
// (docs/features/EXTENSION-MANAGEMENT.md). Replaces the old hardcoded fork
// knowledge: the shell scans the folder, parses each manifest and enumerates
// the devtools pages to the frontend (panel-host.js -> panel-bridge).
const extensionServer = require("../scheme/extension-server");
const contentScripts = require("../content/content-scripts");
const { buildExtensionURL } = require("../scheme/protocol");
const { listPackages } = require("./packages");

/** Every installed extension folder name, in filesystem order. */
const extensionFolders = () => listPackages().map((pkg) => pkg.id);

/**
 * Every extension folder with a `devtools_page` manifest entry.
 * @returns {{ extensionId: string, name: string, devtoolsPageURL: string }[]}
 */
const scanExtensions = () => {
  const found = [];
  for (const { id } of listPackages()) {
    const manifest = extensionServer.loadManifest(id);
    if (!manifest || !manifest.devtools_page) {
      continue;
    }
    found.push({
      extensionId: id,
      name: manifest.name || id,
      devtoolsPageURL: buildExtensionURL(id, manifest.devtools_page),
    });
  }
  return found;
};

/**
 * Every extension folder that declares a background context — MV3
 * `background.service_worker` or the legacy non-empty `background.scripts`.
 *
 * Independent of `scanExtensions` on purpose: one extension routinely declares
 * BOTH a devtools page and a background (graphql and altair do), and it must be
 * listed by both scans — the panel and the worker are separate execution
 * contexts with separate hosts (docs/features/BACKGROUND-WORKER.md).
 *
 * @returns {{ extensionId: string, name: string, script: string, type: "classic" | "module" }[]}
 */
const scanBackgroundExtensions = () => {
  const found = [];
  for (const { id } of listPackages()) {
    const manifest = extensionServer.loadManifest(id);
    const background = manifest && manifest.background;
    if (!background || typeof background !== "object") {
      continue;
    }
    // Chrome prefers `service_worker` and falls back to `scripts[0]` (MV2).
    const script =
      typeof background.service_worker === "string" && background.service_worker
        ? background.service_worker
        : Array.isArray(background.scripts) &&
            typeof background.scripts[0] === "string" &&
            background.scripts[0]
          ? background.scripts[0]
          : null;
    if (!script) {
      continue;
    }
    found.push({
      extensionId: id,
      name: manifest.name || id,
      script,
      // `type: "module"` is Chrome's ESM opt-in for the service worker; the
      // bootstrap document has to say so on the <script> tag or the import
      // statements in an ESM worker throw at parse time.
      type: background.type === "module" ? "module" : "classic",
    });
  }
  return found;
};

/**
 * Every extension folder that declares `content_scripts`.
 *
 * A third scan for the same reason the other two are separate: a content script is
 * a fourth execution context (inside the inspected app, not in this shell), with its
 * own host (`src/electron/extensions/internal/content/content-bridge.js`) and its own, much stricter, permission
 * story (`src/electron/extensions/internal/content/content-gate.js`). This scan reads MANIFESTS ONLY — no script
 * source is opened here, because reading third-party source is the first step
 * toward running it in the user's app.
 *
 * @returns {{extensionId: string, name: string, entries: object[], problems: string[]}[]}
 */
const scanContentScriptExtensions = () =>
  contentScripts.scanContentScriptExtensions({ listExtensions: extensionFolders });

module.exports = {
  extensionFolders,
  scanExtensions,
  scanBackgroundExtensions,
  scanContentScriptExtensions,
};
