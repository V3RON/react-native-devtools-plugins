// Host side of chrome.i18n (docs/features/STORAGE-AND-I18N.md): turns an extension
// folder's `_locales/` into the bundle its frames resolve `getMessage` against, and
// localizes the manifest and CSS the host itself reads.
//
// Why a bundle served over the extension protocol and not an IPC call: extensions call
// `chrome.i18n.getMessage` at the top of their first script, so the answer has to exist
// before any page script runs. Every IPC channel here is async (src/shared/ipc.js — no
// sendSync), and an async answer would arrive after the first call. The extension
// protocol is already the one sanctioned way for a frame to read its own files, it
// already carries the path-containment guard, and a synchronous XMLHttpRequest to the
// frame's OWN origin reads it without any new channel (src/preload/extension-frame.js).
// The frame decides nothing: the extension id is the request's own hostname, the UI
// locale is the host's, and every file read happens here under the containment guard.
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
const localeDirectories = (root) => {
  const found = {};
  try {
    for (const entry of fs.readdirSync(path.join(root, LOCALES_DIR), { withFileTypes: true })) {
      const locale = entry.isDirectory() ? i18n.normalizeLocale(entry.name) : "";
      // `_locales/pt_br` is accepted for `pt_BR`; an exact name wins over a mis-cased one.
      if (locale && (found[locale] === undefined || entry.name === locale)) {
        found[locale] = entry.name;
      }
    }
  } catch {
    // no _locales folder: a bundle with only the predefined messages
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
const loadBundle = ({ root, extensionId, uiLocaleOverride = "", log = console }) => {
  const { uiLocale, preferredLanguages } = systemLocale(uiLocaleOverride);
  let defaultLocale = "";
  try {
    const manifest = readJson(path.join(root, "manifest.json"));
    defaultLocale = typeof manifest.default_locale === "string" ? manifest.default_locale : "";
  } catch {
    // unreadable manifest: no default locale
  }
  const directories = localeDirectories(root);
  const warn = (message) => log.warn(`[i18n] ${extensionId}: ${message}`);
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
      catalogs[locale] = readJson(path.join(root, LOCALES_DIR, directories[locale], "messages.json"));
    } catch (error) {
      warn(`_locales/${directories[locale]}/messages.json unreadable (${error.message}); skipped`);
    }
  }
  return i18n.buildBundle({ extensionId, uiLocale, defaultLocale, catalogs, preferredLanguages, warn });
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
  const localized = wantsMessages ? i18n.localizeStrings(manifest, bundle) : { ...manifest };
  if (typeof manifest.default_locale === "string") {
    localized.current_locale = bundle.uiLocale;
  }
  return localized;
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
};
