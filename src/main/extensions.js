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

module.exports = { scanExtensions };
