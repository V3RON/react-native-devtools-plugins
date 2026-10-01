// Central configuration for the Electron main process.
// Every value is overridable via environment variables.
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");

// `?ws=` in the frontend URL is load-bearing: it makes the frontend build open a
// core/sdk/WebSocketConnection to that host:port instead of using
// InspectorFrontendHost.sendMessageToBackend. The CDP bridge (src/main/cdp-bridge.js)
// listens there and owns the RN debugger session.
const DEFAULT_FRONTEND_URL =
  "http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223";

// "off"/"disabled"/"false"/"0" -> the shell does not touch the CDP socket at all;
// an external relay (npm run rn-cdp, npm run fake-cdp) must answer on the
// frontend's `ws` host:port instead.
const bridgeDisabled = ["off", "disabled", "false", "0"].includes(
  (process.env.DEVTOOLS_CDP_BRIDGE || "").toLowerCase()
);

const positiveNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// What `chrome.tabs.create({url})` is allowed to do with the URL
// (docs/features/SMALL-SHIMS.md, docs/LIMITATIONS.md).
//
//   none     — open nothing. The created Tab descriptor says `openedVia: null`.
//   external — hand the URL to the OS browser (shell.openExternal), which is
//              Chrome's closest mapping for an extension opening a "tab".
//   window   — open it in a window of this shell instead.
//
// `none` is the default because both shipped extensions call `create` from an
// AUTOMATED path, not a user gesture: graphql's `runtime.onInstalled` handler
// opens a marketing URL, and Altair opens one from `notifications.onClicked`.
// Launching the user's real browser because a devtools session started is a side
// effect no extension asked this host for, and it is not reversible by them. The
// capability is fully wired (src/main/tab-host.js) and injectable, so this is a
// policy switch rather than a missing feature.
const TABS_OPEN_POLICIES = ["none", "external", "window"];
const tabsOpenPolicy = () => {
  const raw = (process.env.DEVTOOLS_TABS_OPEN || "").toLowerCase();
  return TABS_OPEN_POLICIES.includes(raw) ? raw : "none";
};

// Alarms' floor, in ms, for the shim's timers (src/chrome-shim/alarms.js). A test
// drives the shim with its own fake timers; this only scales what a real extension
// schedules, and Chrome's own 30 s minimum is what the shim validates against.
module.exports = {
  repoRoot,

  // The RN DevTools frontend, served by the patched fork's Metro dev server.
  // See docs/ARCHITECTURE.md — this coupling is a known limitation.
  frontendURL: process.env.DEVTOOLS_FRONTEND_URL || DEFAULT_FRONTEND_URL,

  // Root folder holding the unpacked extensions ("installed extensions").
  extensionsDir:
    process.env.DEVTOOLS_EXTENSIONS_DIR || path.join(repoRoot, "extensions"),

  preloadPath: path.join(repoRoot, "src/preload/index.js"),

  // chrome.tabs.create policy: "none" | "external" | "window" (see
  // TABS_OPEN_POLICIES above for why the default opens nothing).
  tabsOpen: tabsOpenPolicy(),

  // In-process CDP bridge (src/main/cdp-bridge.js). Metro host/port and the
  // target filters mirror the flags src/tools/rn-cdp.js takes.
  cdpBridge: {
    enabled: !bridgeDisabled,
    metroHost: process.env.DEVTOOLS_METRO_HOST || "127.0.0.1",
    metroPort: positiveNumber("DEVTOOLS_METRO_PORT", 8081),
    listenHost: process.env.DEVTOOLS_CDP_HOST || undefined,
    listenPort: positiveNumber("DEVTOOLS_CDP_PORT", 9223),
    app: process.env.DEVTOOLS_APP_FILTER || null,
    device: process.env.DEVTOOLS_DEVICE_FILTER || null,
    // chrome.devtools.inspectedWindow.eval waits at most this long for the app.
    requestTimeoutMs: positiveNumber("DEVTOOLS_CDP_REQUEST_TIMEOUT_MS", 10000),
  },
};
