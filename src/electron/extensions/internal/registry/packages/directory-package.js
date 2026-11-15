// An extension package read from a folder on disk (./index.js says what a package is).
//
// Containment is the one rule here: an inner path is untrusted (it comes from a URL or a
// manifest), so it may only ever name something inside the extension's folder, decided on
// `fs.realpath` rather than on path text, with a symlinked root refused outright. The rule
// used to exist twice — once in the file server and once in the i18n reader — and now
// exists once, behind `entry()`, `list()`, `read()` and `open()`.
//
// `resolveInside` is exported for the containment tests and for nothing else: no caller
// outside this folder gets an OS path (tests/architecture-boundary.test.js).
const fs = require("fs");
const path = require("path");
const { RESERVED_INNER_PATHS } = require("../../scheme/protocol");

/**
 * The containment guard for a REQUESTED path: the inner path must resolve to
 * something inside the package's folder (`path.resolve`
 * collapses `..` first, and the `root + path.sep` prefix rule means one
 * extension can never name a sibling's file — `/…/extensions/ab` does not start
 * with `/…/extensions/a/`), and the path must not be a reserved one.
 *
 * It is the only guard for paths a request names, but NOT the only place the rule
 * below is enforced: `containmentFor` in src/electron/extensions/internal/registry/i18n-host.js applies the same
 * realpath rule to the paths THAT file derives for itself, which never come here.
 *
 * Containment is then checked on RESOLVED paths, not on path text (finding F1,
 * docs/SECURITY-PLATFORM.md §3.2). The string rule alone was not enough: every
 * read that follows this guard (`fs.statSync`, `net.fetch(file://)`) FOLLOWS
 * symlinks, so one link planted inside an extension folder — `stolen ->
 * ~/.ssh/id_ed25519` — made the folder's own page read arbitrary files with a
 * plain `fetch("stolen")`, no IPC and no prompt. So: one `lstat` says the root
 * is not itself a link, one `realpath` says what the root and the target
 * actually are, and the prefix rule is applied to those.
 *
 * Which is also where the two containment layers agree, stated once so nobody
 * re-derives it: A SYMLINKED FOLDER IS NEVER AN EXTENSION ROOT. The discovery
 * scan reaches folders through `readdir({ withFileTypes: true })` +
 * `isDirectory()` (src/electron/extensions/internal/registry/extensions.js), which never reports a link, and the
 * server refuses a linked root for the same reason — otherwise the two would
 * disagree about what an extension is, and the disagreement would be the
 * permissive one. A link that stays INSIDE its extension folder keeps working:
 * the rule is about where a path lands, not about which directory entries are links.
 *
 * The guard returns the REALPATH, not the text-contained path, and that is the
 * second half of the rule: a caller that reads what this returns opens a path with
 * no link components left in it, so the read cannot be re-directed by a link that
 * appears after the check. Returning the text path would hand the caller a name
 * whose meaning can still change underneath it.
 *
 * The residual race, stated honestly: between the `realpath` here and the `open`
 * in the caller, another writer can still swap a PARENT DIRECTORY of the target,
 * and the inode opened is then not the inode checked. That window is a
 * confidentiality question — an extension page has no `fs`, so this server IS its
 * read channel, and a mid-flight swap is a read, not a corruption — and it is
 * closed only by opening a descriptor relative to a checked directory, which
 * `net.fetch(file://)` and the plain `fs` reads here cannot do. It is accepted for
 * the reason §7 item 7 gives: reaching it needs write access to the developer's own
 * `extensions/` folder, and that access already means rewriting the extension's
 * own files and running its own code. Integrity is not the mitigation being
 * claimed here; the point is that the remaining window needs the same privilege as
 * the thing we already accept.
 *
 * What that window does NOT include, stated honestly: HARDLINKS are invisible to
 * every check here. A hardlink is not a link to them — `lstatSync().isSymbolicLink()`
 * is false and `realpathSync` reports the name's own path — so a file hardlinked
 * INTO an extension folder passes containment as one of its own. What keeps that
 * from being an escape is where Unix permissions live: on the INODE. `link()` is
 * permissive (measured on macOS: even a root-owned 0600 file the developer cannot
 * read hardlinks fine), but every read through the new name fails EACCES exactly as
 * the old name did — the mode and owner came with the inode. This server reads with
 * no more privilege than the developer's own shell, and creating the hardlink took
 * write access to this folder, which §7 item 7 already treats as full developer
 * control; so the residual is at most "one file this process could already read
 * gains a servable name", never the arbitrary read a symlink made. Directory
 * hardlinks are not creatable at all (measured: EPERM).
 *
 * Scope of the platform behaviour: everything above was MEASURED on macOS; the
 * Linux equivalents are claimed BY CONSTRUCTION (`lstat`/`realpath` with the same
 * semantics, no directory hardlinks, permissions equally per-inode) because no CI
 * here runs them. On Windows, `lstatSync().isSymbolicLink()` is false for NTFS
 * junctions and other reparse points, and the realpath prefix compare is
 * case-sensitive on a case-insensitive filesystem, so neither is covered by this
 * rule or by these tests.
 *
 * @returns {string|null} the real (link-free) path for anything that exists, the
 * text-contained path for a name with nothing behind it (so a caller can still
 * answer "missing"), or null when the request is refused
 */
const resolveInside = (root, innerPath) => {
  const target = path.resolve(root, innerPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }
  // Three sync syscalls per path, deliberately per request rather than cached: the
  // install folder is a LIVE folder whose contents change under us (docs/
  // SECURITY-PLATFORM.md §7, item 7), so caching these answers would be caching the
  // security decision, and a stale entry is exactly the window the rule is meant to
  // close. The folder is a developer's own and the calls are three stats at most.
  let isLink;
  try {
    isLink = fs.lstatSync(root).isSymbolicLink();
  } catch {
    // No such folder (or no permission to look): report the contained path and
    // let the caller's own existence check answer "missing", which is what it did
    // before this guard existed. Nothing can be read through a folder that is not
    // there — and nothing through a dangling link below it either, because stat
    // follows the link and fails.
    return target;
  }
  if (isLink) {
    return null; // the decided policy: see the docblock — the scanner skips it too
  }
  // Root and target are resolved in SEPARATE tries, because the two ENOENTs mean
  // different things: ENOENT on the root means this extension has no folder (the
  // scanner would not have offered it, so it is a refusal, not a missing file), while
  // ENOENT on the target means the extension is installed and the name it asked for is
  // simply not there — the honest "missing" src/electron/extensions/internal/content/content-scripts.js reports.
  // One shared `try` keyed the answer on whichever threw first, so a root that
  // vanished mid-call returned the text-contained target UNVALIDATED: the fail-open
  // attached to the wrong operand.
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch (error) {
    // ENOENT / ENOTDIR mean nothing can be BEHIND this path — it does not exist, or
    // a component of it is a plain file (a dangling link is ENOENT, and a link to a
    // file with segments left is ENOTDIR, so an escape cannot hide in either). That
    // is the caller's "does not exist" case, and it has to keep reporting the
    // contained name: src/electron/extensions/internal/content/content-scripts.js tells a developer a manifest path
    // that names no file is MISSING, and a blanket refusal would turn that honest
    // message into a false accusation of escaping the folder.
    // Any other failure (EACCES, ELOOP, …) is a path this server cannot say anything
    // about, so it is refused rather than guessed.
    return error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? target : null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return null;
  }
  return realTarget;
};


/** `"a/b.js"`, `"/a/b.js"` → `"a/b.js"`: a leading `/` is the extension's root (Chrome's rule). */
const normalizeInner = (innerPath) => String(innerPath || "").replace(/^\/+/, "");

/**
 * @param {{id: string, root: string}} options the extension id and its folder
 * @returns {object} an ExtensionPackage (./index.js)
 */
const createDirectoryPackage = ({ id, root }) => {
  const absoluteRoot = path.resolve(root);

  /** The real path for a contained inner path, or null when refused. Reserved names are refused. */
  const locate = (innerPath) => {
    const inner = normalizeInner(innerPath);
    if (RESERVED_INNER_PATHS.has(inner)) {
      return { inner, real: null };
    }
    return { inner, real: resolveInside(absoluteRoot, inner) };
  };

  const rootIsLink = () => {
    try {
      return fs.lstatSync(absoluteRoot).isSymbolicLink();
    } catch {
      return false;
    }
  };

  const entry = (innerPath) => {
    const { real } = locate(innerPath);
    if (!real) {
      return {
        kind: "refused",
        reason: rootIsLink()
          ? "refused: the extension folder cannot be resolved (it is a symlink)"
          : "refused: it resolves outside the extension folder",
      };
    }
    let stat;
    try {
      stat = fs.statSync(real);
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return { kind: "missing" };
      }
      return { kind: "refused", reason: `refused: unreadable (${error && error.code})` };
    }
    return {
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "missing",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  };

  const list = (innerDir) => {
    const { inner, real } = locate(innerDir);
    if (!real || entry(innerDir).kind !== "directory") {
      return null;
    }
    let names;
    try {
      names = fs.readdirSync(real);
    } catch {
      return null;
    }
    return names.map((name) => {
      const child = inner ? `${inner}/${name}` : name;
      const { kind, reason } = entry(child);
      return { name, kind, reason };
    });
  };

  const read = (innerPath) => {
    const { real } = locate(innerPath);
    if (!real || entry(innerPath).kind !== "file") {
      return null;
    }
    try {
      return fs.readFileSync(real);
    } catch {
      return null;
    }
  };

  const open = (innerPath, { start = 0, end } = {}) => {
    const { real } = locate(innerPath);
    const info = real ? entry(innerPath) : null;
    if (!info || info.kind !== "file") {
      return null;
    }
    const last = end === undefined ? info.size - 1 : Math.min(end, info.size - 1);
    if (info.size === 0 || start > last) {
      const { Readable } = require("stream");
      return { size: info.size, stream: Readable.from([]) };
    }
    return { size: info.size, stream: fs.createReadStream(real, { start, end: last }) };
  };

  return {
    id,
    source: "directory",
    // What caches key on: the folder itself, by its real path when it has one.
    cacheKey: `directory:${resolveInside(absoluteRoot, "") || absoluteRoot}`,
    entry,
    list,
    read,
    readText: (innerPath) => {
      const bytes = read(innerPath);
      return bytes === null ? null : bytes.toString("utf8").replace(/^\uFEFF/, "");
    },
    open,
    describe: (innerPath) => path.join(absoluteRoot, normalizeInner(innerPath)),
  };
};

module.exports = { createDirectoryPackage, resolveInside, normalizeInner };
