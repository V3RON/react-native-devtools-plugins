// Who may call the frontend-only extension channels (THEME_REPORT, EXT_PANEL_VISIBILITY):
// the frontend of the window this host is attached to, and nothing else.
//
// "The sender is the frontend" is three facts, all required:
//
//   1. the WebContents is the attached frontend window's (an extension background
//      window or a popup is another WebContents running the same session preload),
//   2. the frame is that WebContents' MAIN frame (extension panels are iframes inside
//      the very same WebContents), and
//   3. that main frame is still on the frontend's ORIGIN. A main frame that was
//      navigated away — a dropped file, a link, a top-level navigation — keeps the
//      preload and the WebContents, but it is no longer the frontend.
//
// The guard is per attachment (`createFrontendGuard`, owned by ExtensionHost.attachWindow):
// the frontend URL is the one the window was attached with, not a process-wide setting.
// The embedding shell has its own rule for its own channels (src/electron/shell/frontend-frame.js).

const originOf = (url) => {
  try {
    const { origin } = new URL(String(url));
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

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

/** All three facts, against an explicit frontend WebContents and URL. */
const isFrontendFrame = (event, { contents, frontendURL } = {}) => {
  if (!isMainFrameOf(contents, event)) {
    return false;
  }
  const expected = originOf(frontendURL);
  return expected !== null && originOf(event.senderFrame.url) === expected;
};

/**
 * The attachment's guard. Inert until `attach`: before a window is attached there is
 * no frontend, so nothing is one.
 */
const createFrontendGuard = () => {
  let current = { contents: null, frontendURL: null };
  return {
    attach: (contents, frontendURL) => {
      current = { contents, frontendURL };
    },
    detach: () => {
      current = { contents: null, frontendURL: null };
    },
    contents: () => current.contents,
    isFrontendFrame: (event) => isFrontendFrame(event, current),
  };
};

module.exports = { originOf, isMainFrameOf, isFrontendFrame, createFrontendGuard };
