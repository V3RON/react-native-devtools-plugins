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
 * @returns {string|null} the normalized URL when it may be opened, else null
 */
const openableUrl = (url) => {
  if (typeof url !== "string" || !url.trim() || url.length > 8192) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
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
