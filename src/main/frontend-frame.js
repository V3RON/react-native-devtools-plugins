// Who may call the frontend-only IPC channels (InspectorFrontendHost.save / append /
// close / openInNewTab / getHostConfig, THEME_REPORT, the PREF_* / WINDOW_* /
// SHOW_CONTEXT_MENU family, ...), in one place.
//
// "The sender is the frontend" is three facts, all required:
//
//   1. the WebContents is the frontend window's (an extension background window or a
//      popup is another WebContents with the same preload),
//   2. the frame is that WebContents' MAIN frame (extension panels are iframes inside
//      the very same WebContents), and
//   3. that main frame is still on the frontend's ORIGIN. A main frame that was
//      navigated away — a dropped file, a link, a top-level navigation — keeps the
//      preload and the WebContents, but it is no longer the frontend and must not
//      reach channels that write files or open URLs. `guardNavigation` also stops the
//      navigation itself; this check is what remains true if something slips past it.
//
// Fact 3 is the shared rule in src/shared/frontend-identity.js, because the preload applies
// the same test to decide which surface a frame gets (F4): what may CALL the frontend's
// channels and what may HOLD the frontend's host object are one question.
//
// The frontend WebContents is injectable (`setFrontendContents`, called by
// src/main/window.js) so the rule runs against a loopback page in the Electron tests.
const { isFrontendUrl } = require("../shared/frontend-identity");

let frontendContents = null;

const setFrontendContents = (contents) => {
  frontendContents = contents;
};

const getFrontendContents = () => frontendContents;

/** Facts 1 and 2: the event came from `contents`' own main frame. */
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
 * All three facts. `options.contents` / `options.frontendURL` override the registered
 * frontend window and `config.frontendURL` (tests).
 */
const isFrontendFrame = (event, options = {}) => {
  const contents = options.contents || frontendContents;
  if (!isMainFrameOf(contents, event)) {
    return false;
  }
  return isFrontendUrl(event.senderFrame.url, options.frontendURL || require("./config").frontendURL);
};

/** Whether the frontend window may navigate to `url` (same origin only). */
const navigationAllowed = (url, frontendURL = require("./config").frontendURL) =>
  isFrontendUrl(url, frontendURL);

/**
 * Deny top-level navigations of the frontend window away from the frontend's origin.
 * A reload, a hash change and the frontend's own same-origin navigations are untouched.
 */
const guardNavigation = (contents, frontendURL) => {
  const deny = (event, url) => {
    if (!navigationAllowed(url, frontendURL)) {
      event.preventDefault();
      console.warn(`[frontend] blocked navigation away from the frontend origin: ${String(url).slice(0, 120)}`);
    }
  };
  contents.on("will-navigate", (event, url) => deny(event, url));
  contents.on("will-redirect", (event, url) => deny(event, url));
};

module.exports = {
  setFrontendContents,
  getFrontendContents,
  isMainFrameOf,
  isFrontendFrame,
  navigationAllowed,
  guardNavigation,
};
