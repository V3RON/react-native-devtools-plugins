// The frontend's DevTools theme, as the host knows it
// (docs/features/DEVTOOLS-PANELS.md: chrome.devtools.panels.themeName / themeChanged).
//
// The frontend decides the theme (the `ui-theme` setting, or the system's
// `prefers-color-scheme` while it is "systemPreferred"); the bridge running in its
// main world (src/frontend/panel-bridge.js) reports the RESULT, and this module is
// the one place that remembers it and fans a change out to every reachable
// extension context. Chrome's vocabulary: "default" (light) | "dark".
//
// Pure: the fan-out is injected, so the rules are unit-tested under bare Node.
const THEME_NAMES = new Set(["default", "dark"]);

/**
 * @param {{broadcast: (delivery: {kind: string, payload: object}) => number}} deps
 *        `broadcast` pushes one delivery to every registered extension context
 */
const createThemeHost = ({ broadcast }) => {
  // "default" until the frontend says otherwise: it is ThemeSupport's own initial
  // value, and the bridge reports before it creates any extension frame.
  let themeName = "default";

  return {
    get: () => themeName,
    /**
     * @param {unknown} next what the frontend reported; anything but Chrome's two
     *        names is refused rather than forwarded to extensions
     * @returns {boolean} whether this changed the theme (and so was broadcast)
     */
    report(next) {
      if (typeof next !== "string" || !THEME_NAMES.has(next) || next === themeName) {
        return false;
      }
      themeName = next;
      broadcast({ kind: "theme", payload: { themeName } });
      return true;
    },
  };
};

module.exports = { createThemeHost, THEME_NAMES };
