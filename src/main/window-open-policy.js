// The frontend window's window.open policy (docs/features/DEVTOOLS-PANELS.md).
//
// A blank window.open is never a real request here, but it is how a devtools page
// looks up a panel frame by name (Panel.onShown's window, src/preload/extension-frame.js):
// a frame that exists is found without this handler being asked, and a MISS must not
// spawn a visible empty window. Every other open (the frontend's own openInNewTab, which
// is window.open(url, "_blank")) keeps Electron's default.
const windowOpenHandler = ({ url }) =>
  !url || url === "about:blank" ? { action: "deny" } : { action: "allow" };

module.exports = { windowOpenHandler };
