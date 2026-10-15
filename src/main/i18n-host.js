// Host side of chrome.i18n (docs/features/STORAGE-AND-I18N.md): turns an extension
// folder's `_locales/` into the bundle its frames resolve `getMessage` against, and
// localizes the manifest and CSS the host itself reads.
//
// Why a bundle served over the extension protocol and not an IPC call: extensions call
// `chrome.i18n.getMessage` at the top of their first script, so the answer has to exist
// before any page script runs. Every IPC channel here is async (src/shared/ipc.js — no
// sendSync), and an async answer would arrive after the first call. The extension
// protocol is already the one sanctioned way for a frame to read its own files, and a
// synchronous XMLHttpRequest to the frame's OWN origin reads it without any new
// channel (src/preload/extension-frame.js).
// The frame decides nothing: the extension id is the request's own hostname, the UI
// locale is the host's, and every file read happens here under a containment check —
// but NOT under the protocol server's guard. That guard decides containment for the
// path a REQUEST names; the paths in this file are built here from the root it was
// handed, so `containmentFor` below applies the same realpath rule to them. Reading
// the server's "every read goes through the guard" as covering these derived paths is
// how an escaping `_locales` once reached a bundle (docs/SECURITY-PLATFORM.md §3.2).
const fs = require("fs");
const path = require("path");
const i18n = require("../shared/i18n");

const LOCALES_DIR = "_locales";
// A catalog larger than this is not a message catalog; refusing it keeps one
// extension from making the host read gigabytes on every frame load.
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

const readJson = (file) => {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) {
    throw new Error("not a regular file of acceptable size");
  }
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
};

/**
 * The realpath rule, applied HERE rather than left to the caller.
 *
 * `src/main/extension-server.js` decides containment for the path a REQUEST names,
 * but the reads in this file are for paths this file DERIVES — `manifest.json`,
 * `_locales/<locale>/messages.json` — and a derived path never passes that guard.
 * One `victim/_locales -> outside` link therefore left the message bundle reading
 * outside the folder while `resolveExtensionFile("victim",
 * "_locales/en/messages.json")` correctly answered null: the guard looked closed
 * because the request it refused was not the request being read. So containment is
 * decided again here, on every path derived from `root`, and every caller of this
 * file inherits it — the protocol handler, the manifest reader, and the CSS
 * localisation alike.
 *
 * The anchor is `fs.realpathSync(root)`, i.e. the root this file was handed after the
 * caller's own check, and the rule is the guard's: the real path of the derived name
 * must be the root or start with it plus a separator (docs/SECURITY-PLATFORM.md §3.2).
 *
 * That rule therefore exists twice: `resolveInsideExtension` in
 * src/main/extension-server.js, and `containmentFor` here. It cannot be shared,
 * because extension-server requires THIS module and a shared guard would close the
 * cycle in the wrong direction — so the two are deliberately the same rule, and a
 * change to one is a change to the other. It is not one rule enforced in two places by
 * accident; it is one rule with two enforcement points because one of the readers
 * derives paths the request-time guard never sees.
 *
 * @returns {((innerPath: string) => string) & { realRoot: string }} the REAL path to
 * read, throwing an `Error` whose `refused` flag says whether the path exists but is
 * not allowed here (as opposed to simply not being there)
 */
const containmentFor = (root) => {
  // The linked-root refusal lives HERE as well as in the request guard, not only in the
  // callers: the doctrine "a symlinked folder is never an extension root" is a property
  // of THIS module's reads, and until now it held only because every caller (
  // src/main/extension-server.js) had refused a linked root before handing it in. A
  // caller that forgot would get a bundle out of a folder the scanner would not even
  // list — the permissive disagreement the guard's docblock rules out. `lstat` decides,
  // because `realpath` resolves the link and would make a linked root look ordinary.
  let rootIsLink = true;
  try {
    rootIsLink = fs.lstatSync(root).isSymbolicLink();
  } catch {
    // Cannot even look at the entry: nothing under it can be vouched for either.
  }
  let realRoot = null;
  if (!rootIsLink) {
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      // The root itself cannot be resolved: this file can say nothing about any path
      // under it, so every read is refused rather than trusted.
      realRoot = null;
    }
  }
  // A root that is a link, or cannot be resolved, leaves `realRoot` null and so refuses
  // every read below rather than being trusted. A folder that is not there has no
  // messages either way, and a linked folder is not an extension at all.
  const contain = (innerPath) => {
    if (realRoot === null) {
      const error = new Error("the extension folder cannot be resolved");
      error.refused = true;
      throw error;
    }
    let real;
    try {
      real = fs.realpathSync(path.resolve(root, innerPath));
    } catch (error) {
      // ENOENT/ENOTDIR are the ordinary "this extension has no such file" case (no
      // `_locales`, or no catalog for this locale); anything else is a path this file
      // cannot say anything about. Both end the read; only the `refused` flag differs,
      // and it decides whether the caller stays quiet or reports the path.
      const missing = error && (error.code === "ENOENT" || error.code === "ENOTDIR");
      const wrapped = missing
        ? new Error("no such file")
        : new Error(`unreadable (${error && error.code})`);
      wrapped.refused = !missing;
      throw wrapped;
    }
    // The rule: the real path must BE the root or sit under it plus a separator.
    // Its teeth were verified by bypassing exactly this line: with the check forced
    // never to refuse, the probe in tests/background-worker-electron.test.js reports
    // BOTH outsideContents and outsideMessage true, so neither assertion is vacuous.
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      const error = new Error("refused: it resolves outside the extension folder");
      error.refused = true;
      throw error;
    }
    return real;
  };
  contain.realRoot = realRoot === null ? root : realRoot;
  return contain;
};

/** A read of one file under `root`, or the refusal that stopped it. */
const readUnderRoot = (contain, innerPath) => readJson(contain(innerPath));

/**
 * The host's UI locale and the user's preferred languages.
 *
 * `DEVTOOLS_UI_LOCALE` (config.uiLocale) wins when set — a test and screenshot knob —
 * otherwise Electron's own: `app.getLocale()` is the locale Chromium resolved for this
 * app (what `--lang=` and the OS language select), `getPreferredSystemLanguages()` the
 * OS list. Outside Electron (unit tests of this file) it degrades to en-US.
 */
const systemLocale = (override = "") => {
  let uiLocale = override;
  let preferred = [];
  try {
    const { app } = require("electron");
    if (app && typeof app.getLocale === "function") {
      uiLocale = uiLocale || app.getLocale();
      if (typeof app.getPreferredSystemLanguages === "function") {
        preferred = app.getPreferredSystemLanguages();
      }
    }
  } catch {
    // not running under Electron
  }
  return { uiLocale: uiLocale || "en-US", preferredLanguages: Array.isArray(preferred) ? preferred : [] };
};

/** Directory names under `_locales`, as { normalized name -> real directory name }. */
const localeDirectories = (root, contain, warn = () => {}) => {
  const found = {};
  // The directory itself first: a linked `_locales` is exactly the shape that made this
  // file read outside the folder, and listing it is already a read of it.
  // The listing then reads what that check RETURNED rather than re-joining the text
  // path: readdir follows links too, so between the check and the readdir a swapped-in
  // `_locales` would put an outside folder's ENTRY NAMES into the warnings below. No
  // bytes leak — the per-entry check under it refuses each escaped entry — but a name is
  // still information, and a check whose answer is thrown away is not a check.
  let localesDir;
  try {
    localesDir = contain(LOCALES_DIR);
  } catch (error) {
    if (error.refused) {
      warn(`${LOCALES_DIR} is ${error.message}`);
    }
    // Not refused: it is simply not there, which is the ordinary case for an
    // extension with no catalog and must stay silent.
    return found;
  }
  try {
    for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
      const locale = entry.isDirectory() ? i18n.normalizeLocale(entry.name) : "";
      // `_locales/pt_br` is accepted for `pt_BR`; an exact name wins over a mis-cased one.
      if (!locale) {
        continue;
      }
      try {
        contain(path.join(LOCALES_DIR, entry.name));
      } catch (error) {
        if (error.refused) {
          warn(`${LOCALES_DIR}/${entry.name} is ${error.message}`);
        }
        continue;
      }
      if (found[locale] === undefined || entry.name === locale) {
        found[locale] = entry.name;
      }
    }
  } catch {
    // unreadable listing: a bundle with only the predefined messages
  }
  return found;
};

/**
 * @param {object} input
 * @param {string} input.root         absolute extension folder (already containment-checked)
 * @param {string} input.extensionId
 * @param {string} [input.uiLocaleOverride]
 * @param {object} [input.log]
 */
const buildFromDisk = ({ root, extensionId, uiLocale, preferredLanguages, log }) => {
  const contain = containmentFor(root);
  let defaultLocale = "";
  try {
    const manifest = readUnderRoot(contain, "manifest.json");
    defaultLocale = typeof manifest.default_locale === "string" ? manifest.default_locale : "";
  } catch (error) {
    // An unreadable or absent manifest means no default locale. A REFUSED one is
    // reported: a manifest the host is not allowed to read is not the same fact as a
    // manifest that is not there, and silence here would make the first look like the
    // second (docs/SECURITY-PLATFORM.md §3.2).
    if (error.refused) {
      log.warn(`[i18n] ${extensionId}: manifest.json is ${error.message}`);
    }
  }
  const warn = (message) => log.warn(`[i18n] ${extensionId}: ${message}`);
  const directories = localeDirectories(root, contain, warn);
  if (Object.keys(directories).length > 0 && !i18n.normalizeLocale(defaultLocale)) {
    warn(
      "has a _locales folder but no valid default_locale in manifest.json (Chrome refuses to load it); " +
        "using only the UI locale chain"
    );
  } else if (defaultLocale && directories[i18n.normalizeLocale(defaultLocale)] === undefined) {
    warn(`default_locale "${defaultLocale}" has no _locales/${defaultLocale}/messages.json`);
  }
  const catalogs = {};
  for (const locale of i18n.localeChain(uiLocale, defaultLocale)) {
    if (directories[locale] === undefined) {
      continue;
    }
    try {
      catalogs[locale] = readUnderRoot(contain, path.join(LOCALES_DIR, directories[locale], "messages.json"));
    } catch (error) {
      warn(`_locales/${directories[locale]}/messages.json unreadable (${error.message}); skipped`);
    }
  }
  return i18n.buildBundle({ extensionId, uiLocale, defaultLocale, catalogs, preferredLanguages, warn });
};

// A bundle is rebuilt only when something it was built from changed. The host asks for
// one per frame load AND on every manifest read (the permission gate alone reads the
// manifest several times per frame registration), so re-parsing every catalog each time
// would be the common case; stat()ing the inputs is the cheap way to know it is still
// valid, and it keeps "edit messages.json, reload the frame" working without a restart.
const bundleCache = new Map(); // root -> { signature, bundle }
/**
 * The signature reads go through the same containment as the bundle reads: `stat`
 * follows links too, so stamping a raw joined name would let a linked catalog report
 * an outside file's mtime and size to whoever can time a rebuild. Refused or missing
 * both stamp "-", which is what "no such input" already meant.
 */
const statStamp = (contain, innerPath) => {
  let file;
  try {
    file = contain(innerPath);
  } catch {
    return "-";
  }
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "-";
  }
};

const loadBundle = ({ root, extensionId, uiLocaleOverride = "", log = console }) => {
  const { uiLocale, preferredLanguages } = systemLocale(uiLocaleOverride);
  // The signature covers only directories containment allowed, so an entry can never
  // carry a locale that was refused here, and the cache is keyed on the REAL root: two
  // names for one folder are one folder, and an entry must not be reachable under a
  // path whose containment verdict differs (`contain.realRoot` falls back to the text
  // root when the root cannot be resolved, which is the case where nothing is readable
  // through it anyway).
  const contain = containmentFor(root);
  const directories = localeDirectories(root, contain);
  const signature = [
    extensionId,
    uiLocale,
    preferredLanguages.join(","),
    statStamp(contain, "manifest.json"),
    ...Object.values(directories).map((dir) => `${dir}=${statStamp(contain, path.join(LOCALES_DIR, dir, "messages.json"))}`),
  ].join("|");
  const cacheKey = contain.realRoot;
  const cached = bundleCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return cached.bundle;
  }
  const bundle = buildFromDisk({ root, extensionId, uiLocale, preferredLanguages, log });
  bundleCache.set(cacheKey, { signature, bundle });
  return bundle;
};

/**
 * `__MSG_name__` substitution for a manifest the host reads (extension name in the panel
 * list, CSP, permissions, chrome.runtime.getManifest). Cheap when there is nothing to
 * do: a manifest without the marker never touches `_locales`. Chrome also adds
 * `current_locale` to the localized manifest; so does this, when the extension has a
 * `default_locale`.
 */
const localizeManifest = ({ manifest, rawText, root, extensionId, uiLocaleOverride, log }) => {
  const wantsMessages = rawText.includes("__MSG_");
  if (!wantsMessages && typeof manifest.default_locale !== "string") {
    return manifest;
  }
  const bundle = loadBundle({ root, extensionId, uiLocaleOverride, log });
  const localized = wantsMessages ? i18n.localizeManifestFields(manifest, bundle) : { ...manifest };
  if (typeof manifest.default_locale === "string") {
    localized.current_locale = bundle.uiLocale;
  }
  return localized;
};

// Whether a CSS file contains a marker at all, remembered per (path, mtime, size): the
// protocol handler asks for every stylesheet, and almost none of them use i18n, so the
// common case must not cost a second full read before net.fetch serves the file.
const MAX_LOCALIZED_CSS_BYTES = 2 * 1024 * 1024;
const cssMarkerCache = new Map();
const cssUsesMessages = (file) => {
  const stat = fs.statSync(file);
  if (stat.size > MAX_LOCALIZED_CSS_BYTES) {
    return false;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = cssMarkerCache.get(file);
  if (cached && cached.stamp === stamp) {
    return cached.uses;
  }
  const uses = fs.readFileSync(file, "utf8").includes("__MSG_");
  cssMarkerCache.set(file, { stamp, uses });
  return uses;
};

/** A `.css` file served from an extension with `_locales`: `__MSG_x__` and `__MSG_@@bidi_dir__`. */
const localizeCssFile = ({ text, root, extensionId, uiLocaleOverride, log }) =>
  text.includes("__MSG_")
    ? i18n.localizeCss(text, loadBundle({ root, extensionId, uiLocaleOverride, log }))
    : text;

module.exports = {
  LOCALES_DIR,
  systemLocale,
  loadBundle,
  localizeManifest,
  localizeCssFile,
  cssUsesMessages,
};
