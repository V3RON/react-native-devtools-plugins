// What the shell may hand to the OS browser (`shell.openExternal`), in one place.
//
// `openExternal` launches whatever application is registered for a URL's scheme —
// `file:`, `smb:`, `ms-msdt:` and friends included — so a string that arrives from a
// page (a DevTools link, a console message, a panel) must never reach it unfiltered.
// The allowlist is http(s) only (and without embedded credentials): the two schemes a
// "new tab" can honestly mean. It is
// shared by `InspectorFrontendHost.openInNewTab` and both `chrome.tabs.create` policies
// (src/main/tab-host.js): the `external` branch applies it directly, the `window` branch
// applies it plus its own extension scheme (see `openableWindowUrl` there for why the
// scheme cannot join the list below — the OS launcher has no handler for it).
//
// The opener is injected so the rules are unit-testable under bare Node; the Electron
// wiring at the bottom is the only part that touches `shell`, and a test seam
// (DEVTOOLS_TEST_OPEN_LOG, src/main/config.js) records the call instead of launching
// a browser.
const ALLOWED_PROTOCOLS = ["http:", "https:"];

/**
 * Idempotent on what it accepts: `openableUrl(openableUrl(u))` returns the same string
 * the first call did, because every check — the length cap included — judges the
 * returned `href`, not the caller's text. The `external` policy depends on this: the
 * shipped path runs the filter twice (the host's check, then the opener's re-check of
 * the string the host handed it), and a second pass that could disagree would be a
 * second verdict, not the same one.
 *
 * @returns {string|null} the normalized URL when it may be opened, else null
 */
const openableUrl = (url) => {
  if (typeof url !== "string" || !url.trim()) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  // The cap judges the href, not the input: percent-encoding expands, so a raw URL
  // under 8192 chars can normalize past it (one `é` becomes `%C3%A9`, an emoji a
  // twelve-char escape). The over-long href is what the OS launcher would receive, so
  // that is the string the cap exists to bound — and checking the input instead made
  // the filter non-idempotent at the cap: the single-pass `window` branch accepted the
  // expanded href while the double-pass `external` branch's re-check refused it.
  if (parsed.href.length > 8192) {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol) || !parsed.hostname) {
    return null;
  }
  // `https://trusted.example@evil.example/` and `http://user:pw@host/`: credentials in a
  // URL are how a link is made to look like a different site, and nothing in DevTools
  // needs them.
  if (parsed.username || parsed.password) {
    return null;
  }
  return parsed.href;
};

/**
 * The refusal a caller sees when `openableUrl` rejects a URL. Shared because the
 * `external` policy and the `window` policy (src/main/tab-host.js) must say the same
 * thing about the same URL — one refusal message, not two that can drift apart.
 *
 * It names http(s) because that is the allowlist both branches share; the `window`
 * branch's one extra reason ("it is a `rozenite:` URL that names no folder", e.g. an
 * embedded port) is not spelled out, deliberately: the message is pinned by the Electron
 * evidence captures as well as the tests, and "this is not openable here" is the whole
 * answer either branch is entitled to give. Wording it differently is a change to make in
 * one place, with the Electron suite runnable.
 */
const refusalMessage = (url) =>
  `refused to open a URL that is not http(s): ${String(url).slice(0, 80)}`;

/**
 * @param {object} deps
 * @param {(url: string) => (void|Promise<void>)} deps.openExternal
 * @returns {{open: (url: any) => Promise<{ok: true, url: string}|{ok: false, error: string}>}}
 */
const createExternalOpener = ({ openExternal }) => ({
  open: async (url) => {
    const allowed = openableUrl(url);
    if (!allowed) {
      return { ok: false, error: refusalMessage(url) };
    }
    try {
      await openExternal(allowed);
    } catch (error) {
      return { ok: false, error: (error && error.message) || "openExternal failed" };
    }
    return { ok: true, url: allowed };
  },
});

// ── the Electron-backed singleton ────────────────────────────────────────────
let instance;

const getExternalOpener = () => {
  if (!instance) {
    instance = createExternalOpener({
      openExternal: async (url) => {
        const { testOpenLog } = require("./config");
        if (testOpenLog) {
          require("fs").appendFileSync(testOpenLog, `${url}\n`);
          return;
        }
        await require("electron").shell.openExternal(url);
      },
    });
  }
  return instance;
};

module.exports = {
  ALLOWED_PROTOCOLS,
  openableUrl,
  refusalMessage,
  createExternalOpener,
  getExternalOpener,
};
