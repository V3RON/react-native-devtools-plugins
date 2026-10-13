// The frontend's DevTools theme, as the host knows it
// (docs/features/DEVTOOLS-PANELS.md: chrome.devtools.panels.themeName / themeChanged).
//
// The frontend decides the theme (the `ui-theme` setting, or the system's
// `prefers-color-scheme` while it is "systemPreferred"); the bridge running in its
// main world (src/frontend/panel-bridge.js) reports the RESULT, and this module is
// the one place that remembers it and fans a change out to every reachable
// extension context. Chrome's vocabulary: "default" (light) | "dark".
//
// Pure: the fan-out and the frame check are injected, so the rules are unit-tested
// under bare Node.
const { THEME_NAMES } = require("../shared/theme");

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

/**
 * Whether an IPC event came from `contents`' own main frame — the only principal
 * allowed to report frontend state. Extension iframes live in the same webContents
 * but are different frames, so this is decided by frame, not by sender.
 */
const isMainFrameOf = (contents, event) =>
  Boolean(
    contents &&
      !contents.isDestroyed() &&
      event &&
      event.sender === contents &&
      event.senderFrame &&
      event.senderFrame === contents.mainFrame
  );

/**
 * The THEME_REPORT handler body. The frame is checked FIRST; the payload is not
 * even looked at for a caller that is not the frontend.
 */
const createThemeReportHandler =
  ({ themeHost, isFrontendFrame }) =>
  (event, payload) => {
    if (!isFrontendFrame(event)) {
      return { ok: false };
    }
    return { ok: true, changed: themeHost.report(payload ? payload.themeName : undefined) };
  };

module.exports = { createThemeHost, createThemeReportHandler, isMainFrameOf, THEME_NAMES };
