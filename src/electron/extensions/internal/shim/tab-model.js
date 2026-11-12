// The tab model behind `chrome.tabs` (docs/features/SMALL-SHIMS.md, issue #4).
//
// There is no browser here, so there is no tab list to inspect. What this shell
// has instead is ONE tab standing for the inspected React Native target — the same
// object `chrome.devtools.inspectedWindow` is about — plus the tabs this extension
// asked `create` to open and the host REALLY opened.
//
// The honesty line this file draws:
//   - the synthetic tab's `url`/`title` come only from the host. When the CDP
//     bridge has no session the answer is `about:blank` + `""` — Chrome's own "no
//     document loaded" values — and `status`/`windowId` are ABSENT rather than
//     guessed, because there is no loaded document and no window to be in;
//   - a created tab reports the URL the extension asked for plus `openedVia`,
//     saying what actually happened: "internal" (a shell window really opened),
//     "external" (the OS browser really got the URL) or null (nothing opened).
//     Chrome has no such field; it is here because a descriptor that claimed to be
//     a tab when nothing opened is exactly the fabrication this shell forbids;
//   - an id this model never handed out fails with Chrome's own "No tab with id"
//     error instead of answering with a tab the extension did not name.
//
// Pure: the inspected target's real url/title and the open/close capabilities are
// injected by the caller (src/preload/extension-frame.js), so nothing here knows
// about Electron or IPC — the layering rule in docs/ARCHITECTURE.md.

/** Chrome's "no document loaded" url — the honest answer when nothing is attached. */
const UNKNOWN_URL = "about:blank";

/** Chrome's answer for "no tab". */
const TAB_ID_NONE = -1;

/** Chrome's error text for an id it does not know. */
const noSuchTab = (tabId) => new Error(`No tab with id: ${tabId}.`);

/**
 * The synthetic tab. `title`/`url` are the host's; `id` and the flags below are
 * this shell's own vocabulary about a thing it does define (one tab, always the
 * front one), so they are stated as fact. `status` and `windowId` appear only when
 * a CDP session really reported the target.
 */
const syntheticTab = ({ tabId, attached, url, title }) => ({
  id: tabId,
  active: true,
  pinned: false,
  highlighted: true,
  discarded: false,
  autoDiscardable: false,
  incognito: false,
  index: 0,
  selectedIndex: 0,
  frozen: false,
  title: attached ? String(title ?? "") : "",
  url: attached && url ? String(url) : UNKNOWN_URL,
  ...(attached ? { status: "complete" } : {}),
});

/**
 * Is this tab "in the window the extension is looking at"? Chrome's
 * `currentWindow` / `lastFocusedWindow` / `lastOpenedWindow` filters ask which
 * window a tab belongs to, and this shell has exactly one window with one inspected
 * thing in it — the synthetic tab. A tab `create` produced belongs to no window this
 * shell models (it opened in the OS browser, in a separate shell window, or not at
 * all), so it matches none of those filters.
 *
 * The caller passes the predicate rather than this module guessing from a field: the
 * inspected tab's identity is the shim's business (src/chrome-shim/tabs.js), and
 * nothing about a descriptor should be inferable into "you are the inspected one".
 *
 * @param {(tab: object) => boolean} isInspected
 */
const queryMatcher =
  (isInspected) =>
  (tab, queryInfo, matchesPattern) => {
    const q = queryInfo || {};
    if (q.active === true && tab.active !== true) {
      return false;
    }
    if (q.active === false && tab.active === true) {
      return false;
    }
    const inOnlyWindow = isInspected(tab);
    for (const key of ["currentWindow", "lastFocusedWindow", "lastOpenedWindow"]) {
      if (q[key] === true && !inOnlyWindow) {
        return false;
      }
      if (q[key] === false && inOnlyWindow) {
        return false;
      }
    }
    if (q.windowId !== undefined || q.groupId !== undefined || q.title !== undefined) {
      return false;
    }
    if (q.status !== undefined && tab.status !== q.status) {
      return false;
    }
    if (q.url !== undefined) {
      const patterns = Array.isArray(q.url) ? q.url : [q.url];
      if (!patterns.some((pattern) => matchesPattern(tab.url, pattern))) {
        return false;
      }
    }
    return true;
  };

module.exports = {
  TAB_ID_NONE,
  UNKNOWN_URL,
  noSuchTab,
  queryMatcher,
  syntheticTab,
};
