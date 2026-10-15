// Navigation and window-open policy for the windows that host an extension's OWN
// top-level document — the hidden background-worker window (src/main/background-host.js)
// and an options page (src/main/options-host.js). docs/SECURITY-PLATFORM.md F4, §4 L4.
//
// Those two factories used to create a BrowserWindow with the production preload and no
// guard at all, while the frontend's own window had both (`will-navigate` in
// src/main/frontend-frame.js, `setWindowOpenHandler` in src/main/window.js +
// src/main/window-open-policy.js). An extension could therefore move its worker or
// options window to any URL it liked (`location.href = "https://evil.test"`), and
// `window.open` from those pages created an unguarded shell window. Measured on Electron
// 38: unguarded, the cross-scheme navigation commits; with this guard installed,
// `will-navigate` fires, `preventDefault` holds the document on its own origin, and no
// window is created for `window.open`.
//
// The rule is "one extension per window": a worker/options window may navigate inside its
// own `rozenite://<id>/` and nowhere else — not another extension, not the frontend's
// origin, not `about:blank`/`data:`/`file:`. Own-extension rather than exact-URL because
// a reload fires `will-navigate` too, and an extension document's own in-folder navigations
// are its ordinary behavior (§5 note 5 of the security platform: "Worker/options windows
// can no longer navigate off their own extension"). Host equality is compared case-folded:
// URL hosts are case-insensitive, so `rozenite://GRAPHQL/x` is the same extension.
//
// This is also the reason the extension windows' guard is not `navigationAllowed` from
// frontend-frame.js: a `rozenite://` URL's `URL.origin` is the literal string "null"
// (measured), so an origin comparison would either refuse every extension navigation or,
// if it accepted "null" === "null", let any extension navigate to any other. And an
// `about:blank` candidate's "null" origin would then match it. Same-scheme host equality is
// the only comparison that says what is meant here.
//
// `window.open` is denied outright, reusing the frontend's own policy: nothing in this shell
// opens a window from a page. Panels look up their existing named frame with
// `window.open("", panelId)` (src/preload/extension-frame.js) and a frame that exists is
// found without the handler being asked; extension pages that want a tab use
// `chrome.tabs.create`, which has its own policy (src/main/tab-host.js).
//
// The `tabs.create` "window"-policy window is the same shape (docs §4 L4) and belongs to
// that link of the stack, not to this one.
const { windowOpenHandler } = require("./window-open-policy");
const { EXTENSION_SCHEME } = require("../shared/protocol");

const EXTENSION_PROTOCOL = `${EXTENSION_SCHEME}:`;

/** The `rozenite://` host a URL names, or null for anything that is not an extension URL. */
const extensionHostOf = (url) => {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === EXTENSION_PROTOCOL ? parsed.host.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * Whether a window whose own document is `ownUrl` may navigate to `candidateUrl`.
 * Pure, so the rule is unit-tested without Electron (tests/security.test.js).
 *
 * An unparseable or non-extension `ownUrl` lets nothing through: a window with no
 * extension identity has no navigation rights to grant, so the check fails closed rather
 * than falling back to "anything".
 */
const extensionNavigationAllowed = (candidateUrl, ownUrl) => {
  const own = extensionHostOf(ownUrl);
  return own !== null && extensionHostOf(candidateUrl) === own;
};

/**
 * Install the policy on one extension-owned window's WebContents: the navigation guard and
 * the window-open denial, in one call, so a new extension-window factory cannot ship only
 * half of it. Returns nothing; the window is already wired by the caller.
 *
 * @param {object} contents the window's webContents
 * @param {string} ownUrl the extension URL the window was created to load
 * @param {string} [label] what to call this window in the refusal line ("worker" / "options")
 * @param {(message: string) => void} [warn] where the refusal is reported (main's log)
 */
const guardExtensionWindow = (contents, ownUrl, label = "extension", warn = null) => {
  const report = warn || ((message) => console.warn(`[extension-window] ${message}`));

  // window.open: the same decision the frontend window makes (deny, every time), reported
  // first — a hidden worker window or an options window that reaches for `window.open` is
  // worth one log line, and without it the denial is invisible from the main process, which
  // leaves "no window appeared" as evidence only the page has.
  contents.setWindowOpenHandler((details) => {
    report(
      `denied window.open from the ${label} window: ${String(details && details.url).slice(0, 120)}`
    );
    return windowOpenHandler(details);
  });

  const deny = (event, url) => {
    if (!extensionNavigationAllowed(url, ownUrl)) {
      event.preventDefault();
      report(
        `blocked a navigation of the ${label} window away from ${ownOrigin(ownUrl)}: ` +
          `${String(url).slice(0, 120)}`
      );
    }
  };
  // Both events, like the frontend's guard: a server-side redirect that leaves the
  // extension is exactly as much a navigation as the link that started it.
  contents.on("will-navigate", (event, url) => deny(event, url));
  contents.on("will-redirect", (event, url) => deny(event, url));
};

/** How to name the window's own origin in a log line, without echoing its query string. */
const ownOrigin = (ownUrl) => {
  const host = extensionHostOf(ownUrl);
  return host ? `${EXTENSION_SCHEME}://${host}/` : String(ownUrl).slice(0, 60);
};

module.exports = {
  extensionNavigationAllowed,
  guardExtensionWindow,
};
