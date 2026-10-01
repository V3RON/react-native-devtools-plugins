// Where each frame class runs and with which webPreferences
// (docs/ARCHITECTURE.md §Security model, docs/LIMITATIONS.md §Security).
//
// There is exactly ONE webPreferences object per WebContents, and every
// extension page today lives in the *frontend's own frame tree* as an iframe:
// panel-host.js hands the frontend a devtools-page/panel URL list and
// src/frontend/panel-bridge.js creates the iframes itself
// (docs/features/DEVTOOLS-PANELS.md). So the frontend frame and the extension
// frames are not separable by preference — whatever is set here applies to
// both. That is the constraint this table encodes, and the reason the two
// entries below are identical today.
//
// An extension's background context is the one exception: it is the main frame of
// a hidden window of its own (src/main/background-host.js), so it has its own
// WebContents and COULD be given its own policy. It is given this one anyway —
// see extensionFramePreferences for why that is a decision rather than an
// oversight.
//
// Per-entry decisions were measured with Electron 38 (headless, `show: false`)
// against a real `rozenite://<id>/…` frame loading the production preload:
//
//   nodeIntegrationInSubFrames: false → the extension-frame preload does not
//       run at all, so no chrome.* exists: the option is load-bearing and
//       stays true.
//   nodeIntegration: true             → would put require/process/Buffer in the
//       page world; it is already false and stays false (asserted by
//       tests/extension-frame-electron.test.js).
//   sandbox: true                     → the preload can no longer require ANY
//       file: not `fs`/`path` (Electron's sandboxed built-in subset) and not
//       `./chrome-shim` (local files are unreachable). Turning it on means
//       shipping one bundled, self-contained preload file, i.e. a build step
//       this repo deliberately does not have. Still open — LIMITATIONS.md.
//   webSecurity: true                 → `rozenite://` iframes DO still load
//       inside the `http://127.0.0.1:8081` frontend: the scheme is registered
//       standard + secure + `bypassCSP`, which is what the embedding needs.
//       So the off-switch is not required for panel hosting and is turned off
//       here (it stays off for both frame classes, asserted by the same test).
//
// `allowRunningInsecureContent` is the other half of the old pairing: with
// webSecurity on it must stay off, or a secure-context extension page could
// load `http://` subresources.
//
// What the extension PAGE can therefore reach is not "whatever the preload can
// reach": the preload exposes named, validated channels only, and the raw
// `ipcRenderer` exposure that used to hand every extension folder a Node-level
// IPC handle is gone (asserted).

/** The shared baseline for every frame in the DevTools window. */
const basePreferences = ({ preloadPath }) => ({
  preload: preloadPath,
  // Extension pages are hosted by the frontend; the preload must run in those
  // iframes (see header — measured: without it no chrome.* exists).
  nodeIntegrationInSubFrames: true,
  // No Node surface in any page world, and the page-world absence of
  // require/process/Buffer/ipcRenderer is asserted, not assumed.
  nodeIntegration: false,
  contextIsolation: true,
  // Same-origin policy enforced: `rozenite://` frames still load inside the
  // http:// frontend (the scheme is registered standard + bypassCSP), inline
  // `<script>` in an extension page is refused, and per-extension CSP rides the
  // response headers (src/main/extension-server.js).
  // What it does NOT do is separate one extension from another: every
  // `rozenite://<id>` shares one origin, so a page in extension A can fetch a
  // sibling's files. Measured, asserted, and recorded in docs/LIMITATIONS.md —
  // webSecurity on is not the same as per-extension origin isolation.
  webSecurity: true,
  allowRunningInsecureContent: false,
  // Still false: a sandboxed preload cannot require this repo's preload modules
  // (no bundler). See the header and docs/LIMITATIONS.md.
  sandbox: false,
});

/** Preferences for the BrowserWindow holding the frontend (+ its extension iframes). */
const frontendPreferences = ({ preloadPath }) => basePreferences({ preloadPath });

/**
 * Preferences for extension frames.
 *
 * Two kinds of frame consume this today, and they do NOT share a WebContents any
 * more: an extension's devtools page and panels are iframes inside the frontend
 * (same WebContents, so the policy is unavoidably the frontend's), while an
 * extension's background context is the main frame of its own hidden window
 * (src/main/background-host.js) and so could be given a different policy.
 *
 * It is not given one, on purpose: a worker must not be able to reach anything a
 * panel cannot, and the day someone wants them to differ is the day this function
 * stops being an alias — which is the only reason it exists separately.
 */
const extensionFramePreferences = ({ preloadPath }) => basePreferences({ preloadPath });

module.exports = {
  basePreferences,
  frontendPreferences,
  extensionFramePreferences,
};
