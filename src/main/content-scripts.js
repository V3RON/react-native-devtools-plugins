// The host-side content-script registry (docs/features/CONTENT-SCRIPTS.md, GitHub
// issue #5).
//
// What this file decides, from the manifest ON DISK and nothing else:
//
//   1. which folders declare content scripts at all  (`scanContentScriptExtensions`)
//   2. where each declared `js` / `css` file really is, through the SAME containment
//      rules the extension file server uses (`resolveExtensionFile`), so a
//      `content_scripts.js: ["../../sibling/x.js"]` entry is REFUSED and never read
//      (an extension cannot reach another extension's files, or any file on disk,
//      through a manifest key Chrome never contained this tightly);
//   3. what the source of a script is, and ONLY for an entry the injection gate
//      already allowed (`readEntrySources` takes a `mayRead` predicate and defaults
//      to nothing — a parse pass that read every third-party file in
//      `extensions/` before deciding whether to run it would be backwards).
//
// This is the registry half only. Deciding WHETHER a script may run inside the
// user's app is src/main/content-gate.js (default CLOSED), and actually running it
// is src/main/content-bridge.js.
const fs = require("fs");
const config = require("./config");
const { resolveExtensionFile, loadManifest } = require("./extension-server");

/**
 * The installed extension folders — the same list `extensions.js` walks. Read at
 * CALL time (like the scanners do), which is what lets a test point
 * `config.extensionsDir` at a throwaway folder.
 */
const extensionFolders = () => {
  try {
    return fs
      .readdirSync(config.extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

// Chrome's defaults (developer.chrome.com/docs/extensions/reference/manifest/content-scripts).
const DEFAULT_RUN_AT = "document_idle";
const DEFAULT_WORLD = "ISOLATED";
const RUN_AT_VALUES = ["document_start", "document_end", "document_idle"];
const WORLD_VALUES = ["ISOLATED", "MAIN"];

const strings = (value) =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry) : [];

const booleanOr = (value, fallback) => (typeof value === "boolean" ? value : fallback);

/**
 * One `content_scripts` array entry, normalized to the fields this host can act on.
 * Chrome's unknown/invalid keys are not repaired: a garbage entry is reported as a
 * problem rather than silently turned into something injectable.
 *
 * @returns {{entry: object|null, problems: string[]}}
 */
const normalizeEntry = (raw, index) => {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`content_scripts[${index}]: not an object, skipped`);
    return { entry: null, problems };
  }
  const matches = strings(raw.matches);
  const js = strings(raw.js);
  const css = strings(raw.css);
  if (matches.length === 0) {
    // Chrome requires `matches`; an entry without it can never be keyed to a
    // target, so it is skipped — with the reason recorded, never in silence.
    problems.push(`content_scripts[${index}]: no usable "matches", skipped`);
    return { entry: null, problems };
  }
  if (js.length === 0 && css.length === 0) {
    problems.push(
      `content_scripts[${index}]: declares neither "js" nor "css", skipped`
    );
    return { entry: null, problems };
  }
  if (js.length === 0) {
    problems.push(
      `content_scripts[${index}]: css-only; this host has no DOM, so nothing is injected`
    );
  }
  const runAt = RUN_AT_VALUES.includes(raw.run_at) ? raw.run_at : DEFAULT_RUN_AT;
  if (raw.run_at !== undefined && runAt !== raw.run_at) {
    problems.push(
      `content_scripts[${index}]: unknown run_at ${JSON.stringify(raw.run_at)}, ` +
        `using "${runAt}" (and see the note: run_at collapses to "on attach" here anyway)`
    );
  }
  const world = WORLD_VALUES.includes(raw.world) ? raw.world : DEFAULT_WORLD;
  if (raw.world !== undefined && world !== raw.world) {
    problems.push(
      `content_scripts[${index}]: unknown world ${JSON.stringify(raw.world)}, using "${world}" ` +
        "(Hermes has no isolated worlds: ISOLATED runs in the app's main context too)"
    );
  }
  return {
    entry: {
      index,
      matches,
      excludeMatches: strings(raw.exclude_matches),
      js,
      css,
      runAt,
      world,
      // Both are meaningless without frames, kept in the record so the report can say so.
      allFrames: booleanOr(raw.all_frames, false),
      matchAboutBlank: booleanOr(raw.match_about_blank, false),
    },
    problems,
  };
};

/**
 * Every `content_scripts` entry of one manifest, normalized.
 * @returns {{entries: object[], problems: string[]}}
 */
const parseContentScripts = (manifest) => {
  const declared = manifest && manifest.content_scripts;
  if (declared === undefined) {
    return { entries: [], problems: [] };
  }
  if (!Array.isArray(declared)) {
    return {
      entries: [],
      problems: [`content_scripts: expected an array, found ${typeof declared}`],
    };
  }
  const entries = [];
  const problems = [];
  declared.forEach((raw, index) => {
    const normalized = normalizeEntry(raw, index);
    problems.push(...normalized.problems);
    if (normalized.entry) {
      entries.push(normalized.entry);
    }
  });
  return { entries, problems };
};

/**
 * Resolve one declared inner path to a path on disk, or to a refusal.
 *
 * `resolveExtensionFile` is the server's own guard (src/main/extension-server.js):
 * the same rule that decides what `rozenite://<id>/<path>` may serve. Going through
 * it rather than `path.join`ing here is the point — content scripts then cannot
 * reach a file the extension could not already fetch from its own origin, and a
 * sibling-escaping path comes back as `null`, i.e. refused, never read.
 */
const resolveDeclaredPath = (extensionId, innerPath) => {
  const filePath = resolveExtensionFile(extensionId, innerPath);
  if (!filePath) {
    return {
      ok: false,
      refused: true,
      innerPath,
      reason: `refused: "${innerPath}" resolves outside extension "${extensionId}"`,
    };
  }
  return { ok: true, innerPath, filePath };
};

/**
 * Where one entry's files are, without reading any of them. A missing file is
 * REPORTED (`ok: false`, reason "does not exist") — silently dropping a script the
 * manifest named is how an extension ends up half-installed and nobody notices.
 */
const resolveEntryPaths = (extensionId, entry) => {
  const resolve = (kind) => (innerPath) => {
    const resolved = resolveDeclaredPath(extensionId, innerPath);
    if (!resolved.ok) {
      return { ...resolved, kind };
    }
    let isFile = false;
    try {
      isFile = fs.statSync(resolved.filePath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      return {
        ok: false,
        missing: true,
        kind,
        innerPath,
        reason: `${kind} "${innerPath}" is declared in the manifest but is not a file in ${extensionId}`,
      };
    }
    return { ok: true, kind, innerPath, filePath: resolved.filePath };
  };
  return {
    js: entry.js.map(resolve("js")),
    css: entry.css.map(resolve("css")),
  };
};

/**
 * Read the SOURCE of one entry's js files. Caller must pass a `mayRead` verdict:
 * reading third-party source is the first step toward executing it in the user's
 * app, so an entry the gate did not allow is never read at all.
 *
 * @param {string} extensionId
 * @param {object} entry a `resolveEntryPaths` result
 * @param {(info: {kind: string, innerPath: string}) => boolean} [mayRead]
 */
const readEntrySources = (extensionId, entry, mayRead = () => false) => {
  const sources = [];
  const problems = [];
  for (const file of entry.js) {
    if (!file.ok) {
      problems.push(file.reason);
      continue;
    }
    if (mayRead(file) !== true) {
      problems.push(`not read: "${file.innerPath}" (the injection gate did not allow it)`);
      continue;
    }
    try {
      sources.push({ innerPath: file.innerPath, source: fs.readFileSync(file.filePath, "utf8") });
    } catch (error) {
      problems.push(`could not read "${file.innerPath}": ${error.message}`);
    }
  }
  for (const file of entry.css) {
    if (!file.ok) {
      problems.push(file.reason);
    }
  }
  return { sources, problems };
};

/**
 * Which folders declare content scripts. Independent of `scanExtensions` /
 * `scanBackgroundExtensions` for the same reason those two are independent of each
 * other: one extension declares several context kinds, and each has its own host.
 *
 * No source file is read here — only manifests.
 *
 * @param {(id: string) => object} [readManifest] host-side manifest reader
 * @param {() => object[]} [listExtensions] folder enumeration (injectable for tests)
 * @returns {{extensionId: string, name: string, entries: object[], problems: string[]}[]}
 */
const scanContentScriptExtensions = ({
  readManifest = loadManifest,
  listExtensions = extensionFolders,
} = {}) => {
  const found = [];
  for (const extensionId of listExtensions()) {
    let manifest = {};
    try {
      manifest = readManifest(extensionId) || {};
    } catch {
      continue;
    }
    const { entries, problems } = parseContentScripts(manifest);
    if (entries.length === 0 && problems.length === 0) {
      continue;
    }
    found.push({ extensionId, name: manifest.name || extensionId, entries, problems });
  }
  return found;
};

module.exports = {
  DEFAULT_RUN_AT,
  DEFAULT_WORLD,
  parseContentScripts,
  resolveDeclaredPath,
  resolveEntryPaths,
  readEntrySources,
  scanContentScriptExtensions,
};
