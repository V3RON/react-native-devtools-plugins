// The extension file server: maps `rozenite://<extension-id>/<path>` to
// `<extensionsDir>/<extension-id>/<path>`.
//
// Security: both the extension id and the inner path derive from an
// untrusted URL, so resolution is guarded against path traversal — a
// request can never escape its own extension directory.
const path = require("path");
const { protocol } = require("electron");
const config = require("./config");
const {
  EXTENSION_SCHEME,
  parseExtensionURL,
} = require("../shared/protocol");

// Acceptable extension-id folder names (id == folder name == URL hostname).
const EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_IDS = new Set([".", ".."]);

// net::ERR_FILE_NOT_FOUND
const FILE_NOT_FOUND = -6;

/**
 * Resolve an extension-relative path, or null if it escapes the extension dir.
 */
const resolveExtensionFile = (extensionId, innerPath) => {
  if (!EXTENSION_ID_RE.test(extensionId) || RESERVED_IDS.has(extensionId)) {
    return null;
  }
  const root = path.resolve(config.extensionsDir, extensionId);
  const target = path.resolve(root, innerPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }
  return target;
};

// Must run before app ready.
const registerExtensionSchemePrivileges = () => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EXTENSION_SCHEME,
      privileges: { standard: true, supportFetchAPI: true, bypassCSP: true },
    },
  ]);
};

// Must run after app ready.
const registerExtensionProtocol = () => {
  protocol.registerFileProtocol(EXTENSION_SCHEME, (request, callback) => {
    const parsed = parseExtensionURL(request.url);
    const filePath =
      parsed && resolveExtensionFile(parsed.extensionId, parsed.innerPath);
    if (!filePath) {
      callback({ error: FILE_NOT_FOUND });
      return;
    }
    callback({ path: filePath });
  });
};

module.exports = {
  resolveExtensionFile,
  registerExtensionSchemePrivileges,
  registerExtensionProtocol,
};
