// chrome.i18n message semantics, as pure functions (docs/features/STORAGE-AND-I18N.md).
//
// Chrome splits the work in two and so does this module, because the split is
// observable by extensions:
//
//   STAGE 1 — "bundle" (browser process in Chrome, main process here). The catalogs
//       of the locale fallback chain are merged PER MESSAGE NAME (a name missing from
//       `pt_BR` is taken from `pt`, then from `default_locale`), names are
//       case-insensitive, and each message's `$placeholder$` variables are replaced by
//       their `content` — once, not recursively. `buildBundle` produces the result.
//   STAGE 2 — `getMessage` (renderer in Chrome, the extension frame here). Works on
//       the stage-1 text: `$1`..`$9` take the call's substitutions, a run of k >= 2
//       dollars becomes k-1 dollars, and any other `$x` (a lone `$`, `$0`, `$name`)
//       is DROPPED together with the character that follows it. That last rule is
//       Chromium's base::ReplaceStringPlaceholders and looks like a bug, but it is
//       what extensions are written against.
//
// Every rule below was checked against a real Chromium 141 loading a fixture
// extension (--load-extension); the evidence is in tests/i18n.test.js (the cases are
// named after what they pin) and docs/features/STORAGE-AND-I18N.md.
//
// Where this module is deliberately more lenient than Chrome: Chrome refuses to LOAD
// an extension whose catalog has an invalid name, a message without `message`, a
// placeholder without string `content` or an undefined `$variable$`. A dev shell that
// refuses to show an extension's panel because of a typo in a Portuguese catalog is
// worse than one that skips the entry and says so, so the offending entry is skipped
// (an undefined variable becomes the empty string) and reported through `warn`.

// Chrome's reserved predefined-message prefix and the characters a message or
// placeholder name may use ("[a-zA-Z0-9_]" for authors; "@" only for the predefined).
const NAME_RE = /^[A-Za-z0-9_]+$/;
const VARIABLE_RE = /\$([A-Za-z0-9_@]+)\$/g;
const MARKER_PREFIX = "__MSG_";
// A locale directory name: `ll`, `ll_RR`, `es_419`, `zh_Hant_TW`.
const LOCALE_NAME_RE = /^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8}){0,2}$/;

// Languages written right to left (ICU's list, limited to those with a locale).
const RTL_LANGUAGES = new Set(["ar", "ckb", "dv", "fa", "he", "iw", "ku", "ps", "sd", "ug", "ur", "yi"]);

/** `pt-BR` / `pt_br` -> `pt_BR`; anything that is not a locale name -> "". */
const normalizeLocale = (value) => {
  const parts = String(value || "").trim().replace(/-/g, "_").split("_");
  if (!parts[0]) {
    return "";
  }
  const [language, ...rest] = parts;
  const cased = [
    language.toLowerCase(),
    ...rest.map((part) =>
      part.length === 2 ? part.toUpperCase() : part.length === 4 ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part
    ),
  ].join("_");
  return LOCALE_NAME_RE.test(cased) ? cased : "";
};

/** `pt_BR` -> `pt-BR` (BCP 47, what chrome.i18n.getUILanguage returns). */
const toLanguageTag = (locale) => String(locale).replace(/_/g, "-");

/**
 * The locales to read, most specific first: `pt_BR` -> [`pt_BR`, `pt`, <default_locale>].
 * Chrome's order, with duplicates removed.
 */
const localeChain = (uiLocale, defaultLocale) => {
  const chain = [];
  const add = (locale) => {
    if (locale && !chain.includes(locale)) {
      chain.push(locale);
    }
  };
  const parts = normalizeLocale(uiLocale).split("_").filter(Boolean);
  for (let length = parts.length; length > 0; length -= 1) {
    add(parts.slice(0, length).join("_"));
  }
  add(normalizeLocale(defaultLocale));
  return chain;
};

/** chrome.i18n.getAcceptLanguages: system languages with their bare language, then English. */
const acceptLanguagesFor = (uiLocale, preferredLanguages = []) => {
  const out = [];
  const add = (tag) => {
    if (tag && !out.includes(tag)) {
      out.push(tag);
    }
  };
  const expand = (tag) => {
    const normalized = normalizeLocale(tag);
    if (!normalized) {
      return;
    }
    add(toLanguageTag(normalized));
    add(normalized.split("_")[0]);
  };
  expand(uiLocale);
  preferredLanguages.forEach(expand);
  if (!out.some((tag) => tag.split("-")[0] === "en")) {
    add("en-US");
    add("en");
  }
  return out;
};

/** `@@bidi_*` / `@@ui_locale` / `@@extension_id` for one extension and UI locale. */
const predefinedMessages = ({ extensionId, uiLocale }) => {
  const rtl = RTL_LANGUAGES.has(String(uiLocale).split("_")[0].toLowerCase());
  return {
    "@@extension_id": extensionId,
    "@@ui_locale": uiLocale,
    "@@bidi_dir": rtl ? "rtl" : "ltr",
    "@@bidi_reversed_dir": rtl ? "ltr" : "rtl",
    "@@bidi_start_edge": rtl ? "right" : "left",
    "@@bidi_end_edge": rtl ? "left" : "right",
  };
};

/**
 * One parsed messages.json -> { lowercased name -> stage-1 text }.
 * Chrome iterates the catalog's keys in sorted order and the last duplicate (after
 * lower-casing) wins, regardless of file order — `A` and `a` resolve to `a`'s text.
 */
const compileCatalog = (catalog, { warn = () => {}, locale = "?" } = {}) => {
  const compiled = {};
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    warn(`_locales/${locale}/messages.json is not a JSON object; ignored`);
    return compiled;
  }
  for (const name of Object.keys(catalog).sort()) {
    const entry = catalog[name];
    if (!NAME_RE.test(name)) {
      warn(`_locales/${locale}: message name "${name}" is invalid (only A-Z a-z 0-9 _); skipped`);
      continue;
    }
    if (!entry || typeof entry.message !== "string") {
      warn(`_locales/${locale}: "${name}" has no string "message"; skipped`);
      continue;
    }
    const placeholders = {};
    let valid = true;
    if (entry.placeholders !== undefined) {
      const declared = entry.placeholders;
      if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
        valid = false;
      } else {
        for (const [placeholder, body] of Object.entries(declared)) {
          if (!NAME_RE.test(placeholder) || !body || typeof body.content !== "string") {
            valid = false;
            break;
          }
          placeholders[placeholder.toLowerCase()] = body.content;
        }
      }
    }
    if (!valid) {
      warn(`_locales/${locale}: "${name}" has an invalid placeholder; skipped`);
      continue;
    }
    // Stage 1: `$name$` -> content, a single pass (content is NOT scanned again).
    // Predefined `@@` names are not variables inside messages (Chrome rejects them).
    const text = entry.message.replace(VARIABLE_RE, (_all, variable) => {
      const content = placeholders[variable.toLowerCase()];
      if (content === undefined) {
        warn(`_locales/${locale}: "${name}" uses $${variable}$ but declares no such placeholder`);
        return "";
      }
      return content;
    });
    compiled[name.toLowerCase()] = text;
  }
  return compiled;
};

/**
 * @param {object} input
 * @param {string} input.extensionId
 * @param {string} input.uiLocale       `pt_BR`-style
 * @param {string} [input.defaultLocale]
 * @param {Object<string, object>} input.catalogs  locale -> parsed messages.json (only locales that exist)
 * @param {string[]} [input.preferredLanguages]
 * @returns the serialisable bundle the frame resolves getMessage against
 */
const buildBundle = ({
  extensionId,
  uiLocale,
  defaultLocale = "",
  catalogs = {},
  preferredLanguages = [],
  warn = () => {},
}) => {
  const ui = normalizeLocale(uiLocale) || "en_US";
  const messages = {};
  // Least specific first so a more specific locale overwrites it.
  for (const locale of localeChain(ui, defaultLocale).reverse()) {
    if (catalogs[locale] !== undefined) {
      Object.assign(messages, compileCatalog(catalogs[locale], { warn, locale }));
    }
  }
  return {
    extensionId,
    uiLocale: ui,
    uiLanguage: toLanguageTag(ui),
    defaultLocale: normalizeLocale(defaultLocale),
    acceptLanguages: acceptLanguagesFor(ui, preferredLanguages),
    predefined: predefinedMessages({ extensionId, uiLocale: ui }),
    messages,
  };
};

/**
 * Stage 2 (Chromium base::ReplaceStringPlaceholders). `substitutions` is an array of
 * strings, at most nine.
 */
const applySubstitutions = (text, substitutions = []) => {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "$") {
      out += text[i];
      continue;
    }
    i += 1; // the character after a `$` is always consumed
    if (i >= text.length) {
      break; // a trailing `$` vanishes
    }
    if (text[i] === "$") {
      // `$$` is the escape: a run of k dollars yields k-1 of them.
      while (i < text.length && text[i] === "$") {
        out += "$";
        i += 1;
      }
      i -= 1;
    } else if (text[i] >= "1" && text[i] <= "9") {
      out += substitutions[Number(text[i]) - 1] ?? "";
    }
    // anything else (`$0`, `$x`, `$ `): dropped with its `$`.
  }
  return out;
};

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

const signatureError = () =>
  new TypeError(
    "Error in invocation of i18n.getMessage(string messageName, optional any substitutions, optional object options): No matching signature."
  );

/**
 * chrome.i18n.getMessage against a bundle. Returns "" for an unknown name (Chrome's
 * answer), `undefined` for more than nine substitutions (Chrome logs an error and
 * returns nothing), and throws Chrome's signature TypeError for a bad call.
 */
const getMessage = (bundle, args) => {
  const [name, substitutions, options] = args;
  if (
    args.length < 1 ||
    args.length > 3 ||
    typeof name !== "string" ||
    (args.length === 3 && options !== undefined && (options === null || typeof options !== "object"))
  ) {
    throw signatureError();
  }
  let subs = [];
  if (typeof substitutions === "string") {
    subs = [substitutions];
  } else if (Array.isArray(substitutions)) {
    if (substitutions.length > 9) {
      return undefined;
    }
    // Chrome stringifies array members (`[1, null]` -> "1", "null").
    subs = substitutions.map((value) => String(value));
  } // numbers, objects, null and undefined as the whole argument mean "none"
  const key = name.toLowerCase();
  let text;
  if (bundle && own(bundle.predefined, key)) {
    text = bundle.predefined[key];
  } else if (bundle && own(bundle.messages, key)) {
    text = bundle.messages[key];
  } else {
    return "";
  }
  if (options && options.escapeLt) {
    text = text.replace(/</g, "&lt;");
  }
  return applySubstitutions(text, subs);
};

/**
 * Chromium's `__MSG_name__` scan, which is NOT a greedy regex: after the prefix a name
 * ends at the FIRST `__`, so `__MSG_a____MSG_b__` is two markers and `__MSG_a__b__` is
 * the marker `a` followed by the text `b__`. A marker with an unknown (or empty) name is
 * left as written. `stopAtUnknown` is Chromium's CSS behaviour
 * (MessageBundle::ReplaceVariables): it gives up at the first unknown name, leaving that
 * marker AND every later one in the file literal. The manifest keeps going, because there
 * Chromium refuses the extension instead and this shell is lenient (see the parity cases).
 */
const replaceMarkers = (text, lookup, { stopAtUnknown = false } = {}) => {
  let out = "";
  let position = 0;
  for (;;) {
    const start = text.indexOf(MARKER_PREFIX, position);
    if (start === -1) {
      return out + text.slice(position);
    }
    out += text.slice(position, start);
    const end = text.indexOf("__", start + MARKER_PREFIX.length);
    if (end === -1) {
      return out + text.slice(start);
    }
    const value = lookup(text.slice(start + MARKER_PREFIX.length, end).toLowerCase());
    if (value === undefined) {
      if (stopAtUnknown) {
        return out + text.slice(start);
      }
      out += text.slice(start, end + 2);
    } else {
      out += value;
    }
    position = end + 2;
  }
};

const messageLookup = (bundle) => (key) => (own(bundle.messages, key) ? bundle.messages[key] : undefined);

// The only manifest fields Chromium localizes (extension_l10n_util::LocalizeManifest).
// Measured in Chromium 141 (cases-localization.js): name, short_name, description,
// action.default_title, commands.*.description and omnibox.keyword ARE localized;
// permissions, host_permissions, content_security_policy, web_accessible_resources,
// background, options_ui, devtools_page, homepage_url, author and version_name are NOT.
// `browser_action` / `page_action` default_title are in the same Chromium function (MV2
// aliases of `action`); they are included from the source, not from a run, since an MV3
// Chromium does not load those keys.
const localizeField = (value, bundle) =>
  typeof value === "string" ? replaceMarkers(value, messageLookup(bundle)) : value;

/**
 * A copy of `manifest` with `__MSG_name__` replaced in exactly Chromium's field list. Every
 * other string stays literal on purpose: a marker in `host_permissions`, the CSP or a script
 * path must not make a manifest's CAPABILITIES depend on the UI language.
 */
const localizeManifestFields = (manifest, bundle) => {
  const out = { ...manifest };
  for (const key of ["name", "short_name", "description"]) {
    if (key in out) {
      out[key] = localizeField(out[key], bundle);
    }
  }
  for (const action of ["action", "browser_action", "page_action"]) {
    if (out[action] && typeof out[action] === "object" && "default_title" in out[action]) {
      out[action] = { ...out[action], default_title: localizeField(out[action].default_title, bundle) };
    }
  }
  if (out.omnibox && typeof out.omnibox === "object" && "keyword" in out.omnibox) {
    out.omnibox = { ...out.omnibox, keyword: localizeField(out.omnibox.keyword, bundle) };
  }
  if (out.commands && typeof out.commands === "object" && !Array.isArray(out.commands)) {
    out.commands = Object.fromEntries(
      Object.entries(out.commands).map(([name, command]) => [
        name,
        command && typeof command === "object" && "description" in command
          ? { ...command, description: localizeField(command.description, bundle) }
          : command,
      ])
    );
  }
  return out;
};

/** CSS files also get the predefined `@@` names (`__MSG_@@bidi_dir__`); first unknown name stops the file. */
const localizeCss = (text, bundle) =>
  replaceMarkers(
    text,
    (key) => (own(bundle.predefined, key) ? bundle.predefined[key] : messageLookup(bundle)(key)),
    { stopAtUnknown: true }
  );

module.exports = {
  LOCALE_NAME_RE,
  normalizeLocale,
  toLanguageTag,
  localeChain,
  acceptLanguagesFor,
  predefinedMessages,
  compileCatalog,
  buildBundle,
  applySubstitutions,
  getMessage,
  localizeManifestFields,
  localizeCss,
};
