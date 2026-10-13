// The DevTools theme vocabulary and the boot hint that carries it
// (docs/features/DEVTOOLS-PANELS.md#theme-themename--themechanged).
//
// Chrome's `chrome.devtools.panels.themeName` is "default" (light) or "dark".
//
// The panel bridge knows the theme before it creates any extension iframe, and
// a script in an extension page's <head> may read `themeName` before any async
// IPC could answer. So the bridge appends `?__rozenite_theme=<name>` to the frame
// URL (src/frontend/panel-bridge.js duplicates the literal: it is evaluated as a
// plain script, not required), and the extension-frame preload — which runs before
// page scripts — takes the hint off the URL synchronously with `takeThemeHint`.
const THEME_NAMES = new Set(["default", "dark"]);
const THEME_PARAM = "__rozenite_theme";

/**
 * Split the theme hint out of a URL's query string, byte for byte: only the hint
 * parameter and the ONE separator that belonged to it are removed, so whatever the
 * extension's own query looked like (encoding, order, repeated keys, `+` vs `%20`,
 * empty segments such as `a=1&&b=2`) comes back unchanged.
 *
 * @param {string} search `location.search` ("" or "?a=b&c")
 * @returns {{theme: string|null, search: string|null}} `theme` is the validated
 *          name (null if absent or not one of Chrome's two); `search` is the
 *          query with the hint removed, or null when there was no hint at all
 */
const takeThemeHint = (search) => {
  const parts = String(search || "")
    .replace(/^\?/, "")
    .split("&");
  let hint;
  let found = false;
  const kept = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    const name = eq === -1 ? part : part.slice(0, eq);
    if (name === THEME_PARAM) {
      if (!found) {
        hint = eq === -1 ? "" : part.slice(eq + 1);
      }
      found = true;
    } else {
      kept.push(part);
    }
  }
  if (!found) {
    return { theme: null, search: null };
  }
  const rest = kept.join("&");
  return { theme: THEME_NAMES.has(hint) ? hint : null, search: rest === "" ? "" : `?${rest}` };
};

/**
 * `url` without the theme hint (the same bytes otherwise). The host stores and hands
 * out frame URLs (MessageSender.url, tab messages), and the hint is the shell's own
 * detail: an extension comparing `sender.url` with `runtime.getURL(...)` must see the
 * address it asked for, whatever the preload has or has not stripped yet.
 */
const stripThemeHintFromUrl = (url) => {
  const text = String(url || "");
  const hashAt = text.indexOf("#");
  const beforeHash = hashAt === -1 ? text : text.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : text.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) {
    return text;
  }
  const { search } = takeThemeHint(beforeHash.slice(queryAt));
  return search === null ? text : beforeHash.slice(0, queryAt) + search + hash;
};

module.exports = { THEME_NAMES, THEME_PARAM, takeThemeHint, stripThemeHintFromUrl };
