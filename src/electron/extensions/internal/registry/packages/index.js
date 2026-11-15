// Extension packages: one read-only object per installed extension, addressed by inner
// path. The host asks the package for bytes and never gets an OS path back, so nothing
// outside this folder can name a file outside an extension.
//
//   ExtensionPackage = {
//     id,                         the extension id (the folder name today)
//     source,                     "directory" | "crx" | "memory", for log lines
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
// ./directory-package.js (a folder under the configured extensions dir),
// ./crx-package.js (a signed .crx file in that dir, read in place) and
// ./memory-package.js (tests).
//
// Installing an extension is dropping either into the extensions dir: an unpacked folder
// (its id is the folder name) or a .crx (its id is Chrome's, derived from the signing
// key). A folder wins over a .crx with the same id, and of two .crx files with one id the
// first by file name wins; both are said once on the console.
const fs = require("fs");
const path = require("path");
const { settings: config } = require("../../settings");
const { createDirectoryPackage, resolveInside, normalizeInner } = require("./directory-package");
const { createMemoryPackage } = require("./memory-package");
const { createCrxPackage } = require("./crx-package");
const { innerPathOf } = require("./inner-path");
const { RESERVED_INNER_PATHS } = require("../../scheme/protocol");

// Acceptable extension ids (id == folder name == URL hostname).
const EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_IDS = new Set([".", ".."]);

const isExtensionId = (extensionId) =>
  typeof extensionId === "string" && EXTENSION_ID_RE.test(extensionId) && !RESERVED_IDS.has(extensionId);

const said = new Set();
const sayOnce = (message) => {
  if (!said.has(message)) {
    said.add(message);
    console.warn(`[extensions] ${message}`);
  }
};

/** A folder package for `extensionId`, or null (no such folder, or a symlinked one). */
const folderPackage = (extensionId) => {
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

// .crx file -> {stamp, pkg} for the file version it was built from. Parsing verifies the
// whole file's signature, so it happens once per (mtime, size), not once per request.
const crxCache = new Map();
const crxPackageAt = (file, stat) => {
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = crxCache.get(file);
  if (cached && cached.stamp === stamp) {
    return cached.pkg;
  }
  let pkg = null;
  try {
    pkg = createCrxPackage({ file });
    for (const problem of pkg.problems) {
      sayOnce(`${path.basename(file)} (${pkg.id}): ${problem}`);
    }
  } catch (error) {
    sayOnce(`${path.basename(file)} is not loaded: ${error.message}`);
  }
  crxCache.set(file, { stamp, pkg });
  return pkg;
};

/**
 * Every loadable .crx in the extensions dir, first by file name per id. Symlinked .crx
 * files are skipped, for the reason a symlinked folder is (./directory-package.js).
 */
const crxPackages = () => {
  let names;
  try {
    names = fs
      .readdirSync(config.extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".crx"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const byId = new Map();
  for (const name of names) {
    const file = path.join(config.extensionsDir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const pkg = crxPackageAt(file, stat);
    if (!pkg) {
      continue;
    }
    if (byId.has(pkg.id)) {
      sayOnce(`${name} is not loaded: ${path.basename(byId.get(pkg.id).file)} already provides ${pkg.id}`);
      continue;
    }
    byId.set(pkg.id, pkg);
  }
  return [...byId.values()];
};

/**
 * The installed package for an extension id, or null: an implausible id, no extensions
 * folder configured, or nothing installed under it. A folder is looked up first, then the
 * .crx files. Looked up per call: the folder is live, and caching the answer would be
 * caching the security decision (a .crx's parse is cached by its file version).
 */
const packageFor = (extensionId) => {
  if (!isExtensionId(extensionId) || !config.extensionsDir) {
    return null;
  }
  return folderPackage(extensionId) || crxPackages().find((pkg) => pkg.id === extensionId) || null;
};

/** Every installed package: folders in filesystem order, then .crx files by name. */
const listPackages = () => {
  let entries;
  try {
    entries = fs.readdirSync(config.extensionsDir, { withFileTypes: true });
  } catch {
    return []; // no extensions dir -> no extensions
  }
  const folders = entries
    .filter((entry) => entry.isDirectory() && isExtensionId(entry.name))
    .map((entry) => folderPackage(entry.name))
    .filter(Boolean);
  const taken = new Set(folders.map((pkg) => pkg.id));
  const packed = crxPackages().filter((pkg) => {
    if (taken.has(pkg.id)) {
      sayOnce(`${path.basename(pkg.file)} is not loaded: the folder ${pkg.id}/ provides that id`);
      return false;
    }
    return true;
  });
  return [...folders, ...packed];
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
  createCrxPackage,
  innerPathOf,
  resolveInsideExtension,
  resolveExtensionFile,
};
