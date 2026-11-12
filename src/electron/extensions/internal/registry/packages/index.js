// Extension packages: one read-only object per installed extension, addressed by inner
// path. The host asks the package for bytes and never gets an OS path back, so nothing
// outside this folder can name a file outside an extension.
//
//   ExtensionPackage = {
//     id,                         the extension id (the folder name today)
//     source,                     "directory" | "memory", for log lines
//     cacheKey,                   what a cache of derived data (i18n bundles) keys on
//     entry(innerPath),           {kind: "file" | "directory" | "missing" | "refused",
//                                  size?, mtimeMs?, reason?}
//     list(innerDir),             [{name, kind, reason?}] | null when not a directory
//     read(innerPath),            Buffer | null
//     readText(innerPath),        string | null, BOM stripped
//     open(innerPath, {start, end}),  {size, stream} | null — a Node Readable of the
//                                  inclusive byte range, for streaming responses
//     describe(innerPath),        a human-readable location, for log lines only
//   }
//
// Every package refuses the reserved inner paths (../../scheme/protocol.js
// RESERVED_INNER_PATHS) and anything that climbs above its root. Implementations:
// ./directory-package.js (a folder under the configured extensions dir) and
// ./memory-package.js (tests).
const fs = require("fs");
const path = require("path");
const { settings: config } = require("../../settings");
const { createDirectoryPackage, resolveInside, normalizeInner } = require("./directory-package");
const { createMemoryPackage } = require("./memory-package");
const { innerPathOf } = require("./inner-path");
const { RESERVED_INNER_PATHS } = require("../../scheme/protocol");

// Acceptable extension ids (id == folder name == URL hostname).
const EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_IDS = new Set([".", ".."]);

const isExtensionId = (extensionId) =>
  typeof extensionId === "string" && EXTENSION_ID_RE.test(extensionId) && !RESERVED_IDS.has(extensionId);

/**
 * The installed package for an extension id, or null: an implausible id, no extensions
 * folder configured, no such folder, or a folder that is a symlink (never an extension
 * root — see ./directory-package.js). Built per call: the folder is live, and caching the
 * answer would be caching the security decision.
 */
const packageFor = (extensionId) => {
  if (!isExtensionId(extensionId) || !config.extensionsDir) {
    return null;
  }
  const root = path.resolve(config.extensionsDir, extensionId);
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return createDirectoryPackage({ id: extensionId, root });
};

/** Every installed package, in filesystem order. */
const listPackages = () => {
  let entries;
  try {
    entries = fs.readdirSync(config.extensionsDir, { withFileTypes: true });
  } catch {
    return []; // no extensions dir -> no extensions
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => packageFor(entry.name))
    .filter(Boolean);
};

/**
 * The directory guard keyed by extension id, as the file server applied it before
 * packages existed. Kept for the containment tests (tests/extension-symlink-containment
 * .test.js), which pin the rule itself; host code asks a package instead.
 *
 * @returns {string|null} see ./directory-package.js resolveInside
 */
const resolveInsideExtension = (extensionId, innerPath) => {
  if (!isExtensionId(extensionId) || !config.extensionsDir) {
    return null;
  }
  return resolveInside(path.resolve(config.extensionsDir, extensionId), innerPath);
};

/**
 * Resolve an extension-relative path to a FILE that may be served, or null.
 * Identical containment rules to `resolveInsideExtension`, plus the reserved
 * paths: a bootstrap request must never be answered from a file that happens to
 * exist at that name, because then the generated document would be whatever the
 * extension wrote there instead of what this server generated.
 */
const resolveExtensionFile = (extensionId, innerPath) => {
  const normalized = normalizeInner(innerPath);
  if (RESERVED_INNER_PATHS.has(normalized)) {
    return null;
  }
  return resolveInsideExtension(extensionId, normalized);
};



module.exports = {
  EXTENSION_ID_RE,
  RESERVED_INNER_PATHS,
  isExtensionId,
  packageFor,
  listPackages,
  createDirectoryPackage,
  createMemoryPackage,
  innerPathOf,
  resolveInsideExtension,
  resolveExtensionFile,
};
