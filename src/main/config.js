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

module.exports = {
  repoRoot,

  // The RN DevTools frontend, served by the patched fork's Metro dev server.
  // See docs/ARCHITECTURE.md — this coupling is a known limitation.
  frontendURL: process.env.DEVTOOLS_FRONTEND_URL || DEFAULT_FRONTEND_URL,

  // Root folder holding the unpacked extensions ("installed extensions").
  extensionsDir:
    process.env.DEVTOOLS_EXTENSIONS_DIR || path.join(repoRoot, "extensions"),

  preloadPath: path.join(repoRoot, "src/preload/index.js"),

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
