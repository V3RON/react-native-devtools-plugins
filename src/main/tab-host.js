// The host half of `chrome.tabs` (docs/features/SMALL-SHIMS.md, GitHub issue #4).
//
// Two capabilities the frame's shim cannot do for itself:
//
//   targetInfo() — the inspected target's real url + title. The CDP bridge is the
//     only thing in this process that knows what is being inspected, so it is the
//     only honest source. When no session is attached the answer is
//     `{attached: false}` and the SHIM decides the fallback (Chrome's
//     `about:blank` + `""`) — this module never invents a URL to look plausible.
//
//   open(details) — what `chrome.tabs.create` is allowed to do about an URL. The
//     policy is config, not a code path: `none` (default) opens nothing,
//     `external` hands the URL to the OS browser, `window` opens it in a shell
//     window. `none` is the default for a reason stated in config.js and repeated
//     in docs/LIMITATIONS.md: both shipped extensions call `create` from an
//     automated handler (graphql's `onInstalled` opens a marketing page), so an
//     automatic external open would launch the user's browser because a devtools
//     session started.
//
// Everything is injected — `bridgeStatus`, `sendCommand`, `openExternal`,
// `openWindow` — so the rules are unit-testable under bare Node and a test can
// observe an open without launching anything (docs/ARCHITECTURE.md's layering).
//
// What a policy may NOT open is decided here rather than inside the injected
// capability, so the rule holds whichever window or browser is wired up — see
// `openableWindowUrl` below and docs/SECURITY-PLATFORM.md's F6.
const { openableUrl, refusalMessage } = require("./external-open");
const { parseExtensionURL } = require("../shared/protocol");

const NO_TARGET = { attached: false };

/**
 * What the `window` policy may load in a window of this shell.
 *
 * The http(s) half is `openableUrl` — the same check the `external` branch applies —
 * so the two policies cannot disagree about one URL. Before that they did: `window`
 * handed `url` straight to `win.loadURL`, which made `chrome.tabs.create` a route to
 * any scheme a shell window can host, `file://` included (docs/SECURITY-PLATFORM.md's
 * F6 — chained with a download that leaves a file in `~/Downloads`, that is a read of
 * anything the developer's `file://` origin can fetch).
 *
 * The extension scheme is allowed additionally, and only in this branch: it is this
 * shell's own protocol (`src/main/extension-server.js`), and an extension opening one
 * of its OWN pages is what `create` exists for — Altair's
 * `create({ url: "altair-app/index.html" })` resolves against the extension origin and
 * arrives here as `rozenite://<id>/…` (`src/chrome-shim/tabs.js`). Widening
 * `ALLOWED_PROTOCOLS` is the wrong place for that: the external policy must never see
 * the scheme, since `shell.openExternal` has no handler for it. A `rozenite:` URL whose
 * hostname names no extension is refused outright — the protocol has nothing to serve
 * for it, and "we opened a window and it 404s" is not what a filter is for.
 *
 * What comes back is the string that was checked, not the caller's: `openableUrl` hands
 * back the form it parsed, the way the external branch hands `allowed` to
 * `shell.openExternal` rather than the raw input.
 *
 * @returns {string|null} the URL this policy may load, or null when it is refused
 */
const openableWindowUrl = (url) => {
  const requested = typeof url === "string" ? url.trim() : "";
  if (!requested) {
    return null;
  }
  // `parseExtensionURL` is a prefix + hostname rule over the string, so for the scheme
  // this branch alone allows, the checked string IS the trimmed one.
  return openableUrl(requested) || (parseExtensionURL(requested) ? requested : null);
};

/**
 * @param {object} deps
 * @param {() => {attached: boolean, target: object|null}} deps.bridgeStatus
 * @param {(method: string, params?: object) => Promise<object>} [deps.sendCommand]
 * @param {(url: string) => (void|Promise<void>)} [deps.openExternal] shell.openExternal
 * @param {(url: string) => (number|null)} [deps.openWindow] opens an internal window,
 *        returns its id; the id is the handle `close` expects
 * @param {(handle: any) => (boolean|Promise<boolean>)} [deps.closeWindow] closes an
 *        internal window this module opened, by its handle
 * @param {"none"|"external"|"window"} [deps.policy]
 */
const createTabHost = ({
  bridgeStatus = () => ({ attached: false, target: null }),
  sendCommand = null,
  openExternal = null,
  openWindow = null,
  closeWindow = null,
  policy = "none",
} = {}) => {
  /**
   * What the host knows about the inspected target.
   *
   * `Target.getTargetInfo` is the direct question, and it is asked only while a
   * session is open (the bridge rejects the command otherwise). Its failure is not
   * fatal: the bridge's own target record — the entry from the CDP target list it
   * attached to, i.e. real data it already has — answers the same question. When
   * neither has a url, `attached` says so and the shim falls back.
   */
  const targetInfo = async () => {
    const status = bridgeStatus() || {};
    if (!status.attached) {
      return { ...NO_TARGET };
    }
    if (sendCommand) {
      try {
        const reply = await sendCommand("Target.getTargetInfo", {});
        const info = reply && reply.targetInfo;
        if (info) {
          return { attached: true, url: info.url ?? "", title: info.title ?? "" };
        }
      } catch {
        // Reported by the shim's own fallback path; a bridge that is attached but
        // will not answer Target.getTargetInfo is worth one line, not a crash.
      }
    }
    const record = status.target || null;
    if (record && (record.url !== undefined || record.title !== undefined)) {
      return { attached: true, url: record.url ?? "", title: record.title ?? "" };
    }
    // Attached, but nothing was reported about the target: still attached, and the
    // shim's `about:blank` + `""` fallback is what an extension then sees.
    return { attached: true, url: "", title: "" };
  };

  /** Handles this module opened, so `close` only closes its own windows. */
  const opened = new Set();

  /**
   * Open `url`, honoring the policy. Resolves `{via, handle}` where `via` is what
   * the shim will report as the created tab's `openedVia`, and `handle` is this
   * module's own id for whatever was opened (null when nothing was).
   *
   * A URL the policy may not open is a THROWN refusal, which is how the `external`
   * branch already reports one (its `openExternal` is
   * `src/main/external-open.js`'s opener, which rejects). `src/main/ipc.js` turns the
   * throw into `{ok: false, error}`, and the frame's shim says the reason and resolves
   * `openedVia: null` — so a refused create looks the same whichever policy is set, and
   * Chrome's `create` never has to model a failure it does not have.
   */
  const open = async ({ url }) => {
    if (typeof url !== "string" || !url) {
      return { via: null, handle: null };
    }
    if (policy === "external" && openExternal) {
      await openExternal(url);
      return { via: "external", handle: null };
    }
    if (policy === "window" && openWindow) {
      // The capability exists, so the question is only what it may load — checked
      // BEFORE the window is created. A window that opened and then failed to load has
      // already happened as a side effect; a refused URL must not cause one.
      const loadable = openableWindowUrl(url);
      if (!loadable) {
        throw new Error(refusalMessage(url));
      }
      const handle = await openWindow(loadable);
      if (handle === null || handle === undefined) {
        return { via: null, handle: null };
      }
      opened.add(handle);
      return { via: "window", handle };
    }
    // "none", or a policy whose capability is missing: nothing opens. The shim
    // reports openedVia: null, which is the whole truth. The capability check comes
    // first for the same reason it does for `external` above: a host that cannot open a
    // window has not been offered a URL filter either, so there is nothing to refuse.
    return { via: null, handle: null };
  };

  /**
   * Close a handle `open` handed back. Anything else reports false: this host will
   * not close a window it did not open, and claiming otherwise would be a
   * side effect nobody asked for.
   */
  const close = async (handle) => {
    if (!opened.has(handle) || !closeWindow) {
      return false;
    }
    opened.delete(handle);
    return closeWindow(handle);
  };

  return { targetInfo, open, close, policy: () => policy };
};

// ── the Electron-backed singleton, created lazily by src/main/ipc.js ─────────
let instance;

const attachTabHost = (deps = {}) => {
  const config = require("./config");
  const { createTabHost: build } = require("./tab-host");
  const bridge = require("./cdp-bridge");
  instance = build({
    bridgeStatus: bridge.status,
    sendCommand: bridge.sendCommand,
    policy: config.tabsOpen,
    // http(s) only — the allowlist InspectorFrontendHost.openInNewTab uses
    // (src/main/external-open.js): an extension-supplied `file:`/`smb:` URL must not
    // reach the OS launcher.
    openExternal: async (url) => {
      const reply = await require("./external-open").getExternalOpener().open(url);
      if (!reply.ok) {
        throw new Error(reply.error);
      }
    },
    // The handle rides async IPC back to the frame, so it has to be serializable:
    // the BrowserWindow id, which `closeWindow` below resolves again in main.
    openWindow: (url) => {
      const { BrowserWindow } = require("electron");
      const win = new BrowserWindow({ width: 1000, height: 700, title: "Extension tab" });
      win.loadURL(url).catch(() => {});
      return win.id;
    },
    closeWindow: (id) => {
      const { BrowserWindow } = require("electron");
      const win = BrowserWindow.getAllWindows().find((entry) => entry.id === id);
      if (!win || win.isDestroyed()) {
        return false;
      }
      win.close();
      return true;
    },
    ...deps,
  });
  return instance;
};

const getTabHost = () => instance || attachTabHost();

module.exports = { createTabHost, attachTabHost, getTabHost };
