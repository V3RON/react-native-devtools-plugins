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

// Resolved once: the CDP socket's Origin allowlist below has to name the same
// origin the frontend window actually loads (src/main/frontend-frame.js applies
// the same rule to the IPC channels).
const frontendURL = process.env.DEVTOOLS_FRONTEND_URL || DEFAULT_FRONTEND_URL;

// The origin of the frontend URL, or null when it is not a valid absolute URL or
// carries an opaque origin (`file:`/`data:`, whose `URL.origin` is the literal
// string "null"). In both cases there is no origin to put on the allowlist, and an
// Origin-bearing frontend is then refused for the plain reason that no origin is
// allowlisted — it does NOT fall through to the Origin-less-loopback rule, because
// a browser always sends an `Origin` and a page cannot send an empty one. A
// frontend like that has to name its origin in DEVTOOLS_CDP_ALLOWED_ORIGINS (an
// opaque origin has none to name, so in practice it cannot use this socket at all).
// Failing closed here is the point (docs/SECURITY-PLATFORM.md F3).
const originOf = (url) => {
  try {
    const { origin } = new URL(String(url));
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};
const originOfFrontendURL = originOf(frontendURL);

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

// How fast an extension's `chrome.alarms` timers run, as a multiplier on the real
// delay (src/chrome-shim/alarms.js). 1 = real time, which is what a user gets.
//
// It exists because a headless test cannot wait 30 s for Chrome's own minimum alarm
// delay, and faking the shim's clock inside the extension context would test nothing
// about the path this shell actually uses. The value is decided HERE, in main, and
// handed to each context through its RUNTIME_REGISTER reply — the frame never reads
// the environment itself, so a page cannot notice or influence it.
const alarmClockScale = () => {
  const value = Number(process.env.DEVTOOLS_ALARM_CLOCK_SCALE);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

// Which extensions may inject a content script INTO THE INSPECTED APP, and by
// default: none of them (src/main/content-gate.js is the full reasoning).
//
// The value is a comma/space-separated list of extension ids (the `extensions/<id>`
// folder name) and/or the literal `<all_rn_targets>`:
//
//   DEVTOOLS_CONTENT_SCRIPTS=graphql              only that extension injects
//   DEVTOOLS_CONTENT_SCRIPTS='<all_rn_targets>'   every extension that declares scripts
//   (unset)                                       NOTHING is injected — the default
//
// `matches` URL patterns are deliberately NOT part of this decision: an RN target has
// no page URL for a pattern to be written against, so allowing a pattern would mean
// inventing which target it "really" meant. The gate reports what each pattern would
// have matched, as information, and decides from this list alone.
//
// Chrome needs no such switch, which is the point of having one here: a content script
// runs third-party code inside the user's running app, in the app's own JS context
// (Hermes has no isolated worlds), and this shell has no UI to ask the user first.
const contentScriptAllowlist = () =>
  (process.env.DEVTOOLS_CONTENT_SCRIPTS || "").trim() || null;

// Test seams for the Electron primitives a headless run cannot answer. Both are OFF
// unless the variable is set, and neither changes what a user-facing run does.
//
//   DEVTOOLS_TEST_OPEN_LOG=<file>      InspectorFrontendHost.openInNewTab appends the URL
//                                      it WOULD have handed to shell.openExternal to this
//                                      file instead of launching a browser. The scheme
//                                      allowlist runs first, so only allowed URLs land.
//   DEVTOOLS_TEST_SAVE_DIALOG=<dir>    the save dialog auto-answers with <dir>/<default
//                                      name>; the literal `cancel` answers "cancelled".
//
// Honoured only from an UNPACKAGED app (`app.isPackaged` false; plain Node, i.e. the unit
// tests, counts as unpackaged): a shipped build ignores them and says so. Whenever one is
// active the shell logs a loud warning at startup, because DEVTOOLS_TEST_SAVE_DIALOG
// replaces EVERY save dialog, `chrome.downloads` with `saveAs` included. A relative
// directory resolves against the process's working directory.
const isPackaged = () => {
  try {
    const { app } = require("electron");
    return Boolean(app && app.isPackaged);
  } catch {
    return false;
  }
};
const testSeam = (name, resolve = (value) => value) => {
  const value = (process.env[name] || "").trim();
  if (!value) {
    return null;
  }
  if (isPackaged()) {
    console.warn(`[config] ${name} is ignored: this is a packaged build.`);
    return null;
  }
  console.warn(
    `[config] TEST SEAM ACTIVE: ${name}=${value} — do not set this in a user-facing launch ` +
      "(docs/api/INSPECTOR-FRONTEND-HOST.md)."
  );
  return resolve(value);
};
const testOpenLog = testSeam("DEVTOOLS_TEST_OPEN_LOG", (value) => path.resolve(value));
const testSaveDialog = testSeam("DEVTOOLS_TEST_SAVE_DIALOG", (value) =>
  value === "cancel" ? value : path.resolve(value)
);

// JSON object merged over the frontend's host config (src/main/host-config.js), so a
// deployment can turn a feature the shell disables back on (and a test can prove the
// config reaches the UI). Anything that is not a JSON object is ignored.
const hostConfigOverride = () => {
  try {
    const parsed = JSON.parse(process.env.DEVTOOLS_HOST_CONFIG || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

module.exports = {
  repoRoot,

  testOpenLog,
  testSaveDialog,
  hostConfigOverride: hostConfigOverride(),

  // The RN DevTools frontend, served by the patched fork's Metro dev server.
  // See docs/ARCHITECTURE.md — this coupling is a known limitation.
  frontendURL,

  // Root folder holding the unpacked extensions ("installed extensions").
  extensionsDir:
    process.env.DEVTOOLS_EXTENSIONS_DIR || path.join(repoRoot, "extensions"),

  preloadPath: path.join(repoRoot, "src/preload/index.js"),

  // Override for the UI locale chrome.i18n reports (`pt-BR`, `de`...). Unset = what
  // Electron resolved for the app (`--lang=`, then the OS language) — see
  // src/main/i18n-host.js. A knob for tests and for previewing a translation.
  uiLocale: (process.env.DEVTOOLS_UI_LOCALE || "").trim(),

  // chrome.tabs.create policy: "none" | "external" | "window" (see
  // TABS_OPEN_POLICIES above for why the default opens nothing).
  tabsOpen: tabsOpenPolicy(),

  // Which extensions may inject content scripts into the inspected app
  // (src/main/content-gate.js). `null` means nothing is allowed — the default.
  contentScripts: contentScriptAllowlist(),

  // DEVTOOLS_SHOW_PANEL=<extensionId>[/<pagePath>]: select that extension's panel tab the
  // first time it registers (the host-internal consumer of the `showPanel` dispatch
  // event, src/main/panel-host.js). Unset = the frontend's own default tab.
  showPanel: (process.env.DEVTOOLS_SHOW_PANEL || "").trim() || null,

  // chrome.alarms' clock multiplier (src/chrome-shim/alarms.js), resolved to a NUMBER
  // on purpose: this value travels to each extension context inside its
  // RUNTIME_REGISTER reply, which crosses IPC through the structured-clone serializer.
  // A function-valued property is dropped by that serializer rather than transferred,
  // so a getter-style export would reach the frame as `undefined` and every context
  // would silently run unscaled. Observed both ways in
  // tests/tier2-worker-electron.test.js, which cannot observe a real alarm firing
  // unless the scale really arrives.
  alarmClockScale: alarmClockScale(),

  // In-process CDP bridge (src/main/cdp-bridge.js). Metro host/port and the
  // target filters mirror the flags src/tools/rn-cdp.js takes.
  cdpBridge: {
    enabled: !bridgeDisabled,
    metroHost: process.env.DEVTOOLS_METRO_HOST || "127.0.0.1",
    metroPort: positiveNumber("DEVTOOLS_METRO_PORT", 8081),
    // Unset = the bridge's own loopback default (docs/SECURITY-PLATFORM.md F3).
    // Set it (e.g. to a LAN address) only for remote-device development.
    listenHost: process.env.DEVTOOLS_CDP_HOST || undefined,
    listenPort: positiveNumber("DEVTOOLS_CDP_PORT", 9223),
    // Which browser origins may open the CDP socket. Always includes the
    // frontend's own origin — it is the only browser document that dials the
    // socket — and DEVTOOLS_CDP_ALLOWED_ORIGINS is the documented escape hatch
    // for serving the frontend from another host. Unset by default, so nothing
    // beyond the frontend gets in (src/main/cdp-bridge.js `verifyClient`).
    // Entries are taken as typed; the bridge normalizes each to an origin and logs
    // what it ended up allowing, because this module is required by processes that
    // read their stdout back as data.
    allowedOrigins: [
      originOfFrontendURL,
      ...(process.env.DEVTOOLS_CDP_ALLOWED_ORIGINS || "")
        .split(/[,\s]+/)
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ""),
    ].filter((origin) => origin !== null),
    app: process.env.DEVTOOLS_APP_FILTER || null,
    device: process.env.DEVTOOLS_DEVICE_FILTER || null,
    // chrome.devtools.inspectedWindow.eval waits at most this long for the app.
    requestTimeoutMs: positiveNumber("DEVTOOLS_CDP_REQUEST_TIMEOUT_MS", 10000),
  },
};
