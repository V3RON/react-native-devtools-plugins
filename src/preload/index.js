// Preload entry point: context dispatch only — no logic here.
//
//   rozenite: frames            -> ./extension-frame  (chrome.* shim)
//   the frontend's main frame   -> ./frontend-host    (InspectorFrontendHost)
//   anything else               -> nothing installed
//
// The protocol check comes FIRST, on purpose. An extension page is an extension
// page whether it is an iframe in the frontend or the main document of its own
// hidden window, and the shell hosts an extension's background context exactly
// that way: a `show: false` BrowserWindow whose MAIN frame is
// `rozenite://<id>/__rozenite_background__` (src/main/background-host.js,
// docs/features/BACKGROUND-WORKER.md). Ordering these the other way round hands
// that window the frontend's InspectorFrontendHost stub and no `chrome.*` at all.
//
// The second branch used to be `else if (process.isMainFrame)` — "not our scheme, and a
// main frame" taken to mean "is the frontend". That is the wrong question (GitHub issue #24,
// docs/SECURITY-PLATFORM.md F4): an extension's own top-level window is a main frame with a
// preload too, so `location.href = "https://evil.test"` in a worker or options page installed
// the FRONTEND's host surface in a remote document — and the channels that surface used to
// answer anyone. It now asks the positive question, from the same rule main applies to the
// channels (src/main/frontend-frame.js), so the two realms cannot disagree: a frame gets the
// frontend's surface only when its own URL *is* the frontend's origin. Extension windows are
// additionally guarded against navigating away at all (src/main/extension-window-policy.js);
// this check is what holds if something gets past that guard, which is the same division of
// labor as main's channel gate.
const { preloadBranch } = require("../shared/frontend-identity");

const branch = preloadBranch(window.location.href, process.isMainFrame);

if (branch === "extension") {
  require("./extension-frame");
} else if (branch === "frontend") {
  require("./frontend-host");
}
