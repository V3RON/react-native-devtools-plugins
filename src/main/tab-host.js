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
const NO_TARGET = { attached: false };

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
      const handle = await openWindow(url);
      if (handle === null || handle === undefined) {
        return { via: null, handle: null };
      }
      opened.add(handle);
      return { via: "window", handle };
    }
    // "none", or a policy whose capability is missing: nothing opens. The shim
    // reports openedVia: null, which is the whole truth.
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
    openExternal: async (url) => {
      const { shell } = require("electron");
      await shell.openExternal(url);
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
