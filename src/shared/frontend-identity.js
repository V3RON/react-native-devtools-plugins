// Who "the frontend" is, as one rule for both realms that have to agree about it
// (docs/SECURITY-PLATFORM.md F4).
//
// Two decisions live here, because they are the same decision seen from two sides:
//
//   src/main/frontend-frame.js  asks "may this frame call the frontend-only channels?";
//   src/preload/index.js        asks "does this frame get the frontend's host surface?".
//
// Before F4 they were different rules, and the preload's was the wrong one: it installed
// `frontend-host` for any MAIN frame whose protocol was not `rozenite:` — "not our scheme"
// taken as "is the frontend". An extension's own top-level window (a hidden background
// worker, an options page) is a main frame with a preload, so one
// `location.href = "https://evil.test"` handed a remote page the frontend's
// InspectorFrontendHost surface — the nine `PREF_* / WINDOW_* / SHOW_CONTEXT_MENU` channels
// that used to be ungated in main (src/main/ipc.js). Identity is a positive check on this
// frame's own URL now, in both realms, from this one file.
//
// Renderer-safe on purpose: no `electron` and no `./config` (src/main/config.js pulls in the
// main process, and a preload cannot require it). The two realms read the same environment
// variable rather than importing each other, and tests/security.test.js pins that the main
// side's default is this file's `DEFAULT_FRONTEND_URL`, so they cannot drift.
const { EXTENSION_SCHEME } = require("./protocol");

// The same default src/main/config.js uses, duplicated BY NECESSITY (see the header): a
// renderer preload cannot require the main process's config module. Keep the two in step —
// the drift test in tests/security.test.js is what enforces it.
const DEFAULT_FRONTEND_URL =
  "http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223";

/** The environment's override for the frontend URL, as both realms can read it. */
const frontendUrlFromEnv = () => process.env.DEVTOOLS_FRONTEND_URL || "";

/** `rozenite://…`: an extension document, in any frame of any window. */
const isExtensionUrl = (url) =>
  typeof url === "string" && url.startsWith(`${EXTENSION_SCHEME}://`);

const originOf = (url) => {
  try {
    const { origin } = new URL(String(url));
    // `about:` / `data:` / `blob:` / `file:` have an opaque origin: nothing can prove
    // which document it came from, so it identifies nothing (fail closed).
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

/**
 * Whether `url` IS the frontend: the frontend's own origin, any path (the frontend
 * navigates inside itself and reloads).
 *
 * An opaque origin identifies nothing, so it matches nothing — and that includes the
 * frontend's own URL if the frontend is declared as `file:`/`about:`/`data:`. That is
 * pre-existing behavior, kept deliberately: `src/main/frontend-frame.js` has always refused
 * an origin-less frontend rather than guess, and a security fix does not widen a gate as a
 * side effect of narrowing others. A deployment that wants `file://` has to say so in an
 * origin the rule can compare (or `frontendURL` in a form that has one).
 */
const isFrontendUrl = (url, frontendURL = frontendUrlFromEnv()) => {
  const expected = originOf(frontendURL);
  return expected !== null && originOf(url) === expected;
};

/**
 * Which branch of `src/preload/index.js` a frame gets, as a pure function of the frame's
 * own facts (its URL, whether it is a main frame) and the frontend's URL. Unit-tested in
 * tests/security.test.js; the live half is tests/frontend-host-electron.test.js.
 *
 *   "extension" — an extension document: the chrome.* shim. FIRST and unconditionally: an
 *                 extension page is an extension page whether it is an iframe in the
 *                 frontend or the main document of its own hidden window (that is how the
 *                 background worker is hosted, src/main/background-host.js), and ordering
 *                 these the other way round hands that window the frontend's stub and no
 *                 chrome.* at all.
 *   "frontend"  — the frontend's own MAIN frame. An iframe of the frontend's origin is not
 *                 the frontend host: main applies the same main-frame rule to the channels
 *                 (src/main/frontend-frame.js), so the two checks cannot disagree.
 *   "none"      — everything else, which is the F4 list: an extension window that has
 *                 navigated away, an about:/data:/file: document, a popup. Nothing installed.
 */
const preloadBranch = (url, isMainFrame, frontendURL = frontendUrlFromEnv()) => {
  if (isExtensionUrl(url)) {
    return "extension";
  }
  return isMainFrame && isFrontendUrl(url, frontendURL) ? "frontend" : "none";
};

module.exports = {
  DEFAULT_FRONTEND_URL,
  frontendUrlFromEnv,
  isExtensionUrl,
  isFrontendUrl,
  preloadBranch,
};
