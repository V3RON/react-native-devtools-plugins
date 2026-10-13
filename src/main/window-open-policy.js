// The frontend window's window.open policy (docs/features/DEVTOOLS-PANELS.md).
//
// Every window.open is denied. Nothing in this shell needs one: the frontend's own
// openInNewTab goes through the host (HOST_OPEN_EXTERNAL -> shell.openExternal), and
// extension pages open nothing through window.open — chrome.tabs.create has its own
// policy (src/main/tab-host.js). That matters beyond tidiness: a devtools page looks its
// panel frame up with `window.open("", panelId)` (Panel.onShown's window,
// src/preload/extension-frame.js). A frame that exists is found without this handler
// being asked; a name that matches nothing would otherwise create a real window, and so
// would any other URL an extension frame passes (about:blank#x, about:srcdoc, http(s),
// rozenite://...).
const windowOpenHandler = () => ({ action: "deny" });

module.exports = { windowOpenHandler };
