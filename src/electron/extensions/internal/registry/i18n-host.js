// Host side of chrome.i18n (docs/features/STORAGE-AND-I18N.md): turns an extension
// folder's `_locales/` into the bundle its frames resolve `getMessage` against, and
// localizes the manifest and CSS the host itself reads.
//
// Why a bundle served over the extension protocol and not an IPC call: extensions call
// `chrome.i18n.getMessage` at the top of their first script, so the answer has to exist
// before any page script runs. Every IPC channel here is async (src/electron/extensions/internal/broker/channels.js — no
// sendSync), and an async answer would arrive after the first call. The extension
// protocol is already the one sanctioned way for a frame to read its own files, and a
// synchronous XMLHttpRequest to the frame's OWN origin reads it without any new
// channel (src/electron/extensions/internal/preload/extension-frame.js).
// The frame decides nothing: the extension id is the request's own hostname, the UI
// locale is the host's, and every file read happens here through the extension's
// package (./packages), whose containment rule covers the names this file derives
// (`manifest.json`, `_locales/<locale>/messages.json`) exactly as it covers the names a
// request asks for. Before packages, the rule lived here a second time, because a
// derived path never passed the request-time guard; that is how an escaping `_locales`
// once reached a bundle (docs/SECURITY-PLATFORM.md §3.2).
const i18n = require("./i18n");

const LOCALES_DIR = "_locales";
// A catalog larger than this is not a message catalog; refusing it keeps one
// extension from making the host read gigabytes on every frame load.
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * One JSON file of the package, or the error that stopped it. `error.refused` is true
 * when the package refused the name (outside the extension, unreadable) rather than not
 * having it, which is what callers warn about.
 */
const readJson = (pkg, innerPath) => {
  const info = pkg.entry(innerPath);
  if (info.kind === "refused") {
    const error = new Error(info.reason || "refused");
    error.refused = true;
    throw error;
  }
  if (info.kind === "missing") {
    const error = new Error("no such file");
    error.refused = false;
    throw error;
  }
  if (info.kind !== "file" || info.size > MAX_CATALOG_BYTES) {
    throw new Error("not a regular file of acceptable size");
  }
  return JSON.parse(pkg.readText(innerPath));
};

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
const localeDirectories = (pkg, warn = () => {}) => {
  const found = {};
  const top = pkg.entry(LOCALES_DIR);
  if (top.kind === "refused") {
    warn(`${LOCALES_DIR} is ${top.reason || "refused"}`);
    return found;
  }
  for (const entry of pkg.list(LOCALES_DIR) || []) {
    const locale = i18n.normalizeLocale(entry.name);
    if (!locale) {
      continue;
    }
    if (entry.kind === "refused") {
      warn(`${LOCALES_DIR}/${entry.name} is ${entry.reason || "refused"}`);
      continue;
    }
    if (entry.kind !== "directory") {
      continue;
    }
    // An exact spelling wins over a normalized one (`pt_BR` over `pt_br`).
    if (found[locale] === undefined || entry.name === locale) {
      found[locale] = entry.name;
    }
  }
  return found;
};

/**
 * @param {object} input
 * @param {object} input.pkg          the extension's package (./packages)
 * @param {string} input.extensionId
 * @param {string} [input.uiLocaleOverride]
 * @param {object} [input.log]
 */
const buildFromPackage = ({ pkg, extensionId, uiLocale, preferredLanguages, log }) => {
  let defaultLocale = "";
  try {
    const manifest = readJson(pkg, "manifest.json");
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
  const directories = localeDirectories(pkg, warn);
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
      catalogs[locale] = readJson(pkg, `${LOCALES_DIR}/${directories[locale]}/messages.json`);
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
const bundleCache = new Map(); // package cacheKey -> { signature, bundle }
/**
 * The signature reads go through the same containment as the bundle reads: `stat`
 * follows links too, so stamping a raw joined name would let a linked catalog report
 * an outside file's mtime and size to whoever can time a rebuild. Refused or missing
 * both stamp "-", which is what "no such input" already meant.
 *
 * The granularity this accepts, stated: a relink from one CONTAINED file to another
 * with an identical whole-millisecond mtimeMs AND identical size keeps serving the
 * cached bundle until some other input changes. Containment-only cost (both files
 * are inside the folder), no confidentiality one, and the window closes on the next
 * cache miss for any other edit; the alternative is hashing contents on every frame
 * load. Across the boundary that matters — a relink to OUTSIDE — there is no
 * granularity to speak of: the refusal stamps "-", which no file's stamp can equal,
 * so the swap always forces the rebuild. Suite 7 of
 * tests/extension-symlink-containment.test.js forges exactly that collision.
 */
const statStamp = (pkg, innerPath) => {
  const info = pkg.entry(innerPath);
  return info.kind === "file" ? `${info.mtimeMs}:${info.size}` : "-";
};

const loadBundle = ({ pkg, extensionId, uiLocaleOverride = "", log = console }) => {
  const { uiLocale, preferredLanguages } = systemLocale(uiLocaleOverride);
  // The signature covers only directories containment allowed, so an entry can never
  // carry a locale that was refused here, and the cache is keyed on the package's
  // cacheKey (a folder's REAL path): two names for one folder are one folder, and an
  // entry must not be reachable under a path whose containment verdict differs.
  const directories = localeDirectories(pkg);
  // The silent listing is deliberate, and it is the refusal's loudness rule: this
  // signature pass lists `_locales` WITHOUT a warn, so an escaping entry is reported
  // only when the bundle is actually (re)built below — a persistent escape says it
  // once per rebuild, not once per frame load. That is acceptable because the cache
  // cannot be poisoned: a refused input stamps "-", so a byte-identical outside
  // catalog (same size, same whole-ms mtime) can never produce a stamp that matches
  // the entry made while the file was contained — the check fails closed on the
  // refusal itself, and the bundle behind the cache entry is one where the read was
  // refused. Any later miss both rebuilds and reports again. Suite 7 of
  // tests/extension-symlink-containment.test.js asserts both halves: the swap
  // rebuilds and reports, and the standing refusal stays quiet per access.
  const signature = [
    extensionId,
    uiLocale,
    preferredLanguages.join(","),
    statStamp(pkg, "manifest.json"),
    ...Object.values(directories).map((dir) => `${dir}=${statStamp(pkg, `${LOCALES_DIR}/${dir}/messages.json`)}`),
  ].join("|");
  const cacheKey = pkg.cacheKey;
  const cached = bundleCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return cached.bundle;
  }
  const bundle = buildFromPackage({ pkg, extensionId, uiLocale, preferredLanguages, log });
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
const localizeManifest = ({ manifest, rawText, pkg, extensionId, uiLocaleOverride, log }) => {
  const wantsMessages = rawText.includes("__MSG_");
  if (!wantsMessages && typeof manifest.default_locale !== "string") {
    return manifest;
  }
  const bundle = loadBundle({ pkg, extensionId, uiLocaleOverride, log });
  const localized = wantsMessages ? i18n.localizeManifestFields(manifest, bundle) : { ...manifest };
  if (typeof manifest.default_locale === "string") {
    localized.current_locale = bundle.uiLocale;
  }
  return localized;
};

// Whether a CSS file contains a marker at all, remembered per (package, path, mtime,
// size): the protocol handler asks for every stylesheet, and almost none of them use
// i18n, so the common case must not cost a second full read before the file is streamed.
const MAX_LOCALIZED_CSS_BYTES = 2 * 1024 * 1024;
const cssMarkerCache = new Map();
const cssUsesMessages = (pkg, innerPath) => {
  const info = pkg.entry(innerPath);
  if (info.kind !== "file" || info.size > MAX_LOCALIZED_CSS_BYTES) {
    return false;
  }
  const key = `${pkg.cacheKey}|${innerPath}`;
  const stamp = `${info.mtimeMs}:${info.size}`;
  const cached = cssMarkerCache.get(key);
  if (cached && cached.stamp === stamp) {
    return cached.uses;
  }
  const uses = (pkg.readText(innerPath) || "").includes("__MSG_");
  cssMarkerCache.set(key, { stamp, uses });
  return uses;
};

/** A `.css` file served from an extension with `_locales`: `__MSG_x__` and `__MSG_@@bidi_dir__`. */
const localizeCssFile = ({ text, pkg, extensionId, uiLocaleOverride, log }) =>
  text.includes("__MSG_")
    ? i18n.localizeCss(text, loadBundle({ pkg, extensionId, uiLocaleOverride, log }))
    : text;

module.exports = {
  LOCALES_DIR,
  systemLocale,
  loadBundle,
  localizeManifest,
  localizeCssFile,
  cssUsesMessages,
};
