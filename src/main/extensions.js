// Extension discovery: "installed extension" == folder in extensionsDir
// (docs/features/EXTENSION-MANAGEMENT.md). Replaces the old hardcoded fork
// knowledge: the shell scans the folder, parses each manifest and enumerates
// the devtools pages to the frontend (panel-host.js -> panel-bridge).
const fs = require("fs");
const path = require("path");
const config = require("./config");
const extensionServer = require("./extension-server");
const { buildExtensionURL } = require("../shared/protocol");

/**
 * Every extension folder with a `devtools_page` manifest entry.
 * @returns {{ extensionId: string, name: string, devtoolsPageURL: string }[]}
 */
const scanExtensions = () => {
  let entries;
  try {
    entries = fs.readdirSync(config.extensionsDir, { withFileTypes: true });
  } catch {
    return []; // no extensions dir -> no extensions
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = extensionServer.loadManifest(entry.name);
    if (!manifest || !manifest.devtools_page) {
      continue;
    }
    found.push({
      extensionId: entry.name,
      name: manifest.name || entry.name,
      devtoolsPageURL: buildExtensionURL(entry.name, manifest.devtools_page),
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
  let entries;
  try {
    entries = fs.readdirSync(config.extensionsDir, { withFileTypes: true });
  } catch {
    return []; // no extensions dir -> no extension
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = extensionServer.loadManifest(entry.name);
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
      extensionId: entry.name,
      name: manifest.name || entry.name,
      script,
      // `type: "module"` is Chrome's ESM opt-in for the service worker; the
      // bootstrap document has to say so on the <script> tag or the import
      // statements in an ESM worker throw at parse time.
      type: background.type === "module" ? "module" : "classic",
    });
  }
  return found;
};

module.exports = { scanExtensions, scanBackgroundExtensions };
