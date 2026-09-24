// Panel host: the main-process half of shell-driven extension hosting
// (docs/features/DEVTOOLS-PANELS.md). Owns
//   1. the frontend bridge (src/frontend/panel-bridge.js), (re)booted on
//      every frontend page load with the current extension scan, and
//   2. the live panel registry: chrome.devtools.panels.create calls arriving
//      from devtools frames (EXT_PANEL_CREATE) become real frontend tabs.
//
// Registry is main-process state (house rule); the bridge is its renderer-side
// projection and replays it after frontend reloads. panelId derives from
// (extensionId, pagePath) — stable across reloads, so replay and fresh
// panels.create calls dedupe against each other.
const fs = require("fs");
const path = require("path");
const { scanExtensions } = require("./extensions");
const { buildExtensionURL } = require("../shared/protocol");

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "panel-bridge.js"),
  "utf8"
);

// devtools' View rejects ids outside [A-Za-z0-9.-] ("Invalid view ID"), so
// path separators in pagePath are folded away; collisions within one
// extension would need paths differing only in punctuation — not a concern.
const panelIdFor = (extensionId, pagePath) =>
  `ext.${extensionId}.${String(pagePath || "").replace(/^\/+/, "") || "index"}`.replace(
    /[^A-Za-z0-9.-]+/g,
    "-"
  );

let contents = null;
let ready = Promise.resolve(); // resolves when the live bridge is up
const panels = new Map(); // panelId -> { panelId, title, pageURL }

const attach = (webContents) => {
  contents = webContents;
  const boot = () => {
    const config = {
      devtoolsPages: scanExtensions(),
      panels: [...panels.values()],
    };
    ready = webContents
      .executeJavaScript(
        `window.__SHELL_EXT_CONFIG__ = ${JSON.stringify(config)};\n${BRIDGE_SOURCE}`,
        true
      )
      .catch((error) => {
        console.error("[extensions] panel bridge failed:", error);
      });
  };
  webContents.on("did-finish-load", boot);
};

const addPanel = ({ extensionId, title, pagePath }) => {
  const panel = {
    panelId: panelIdFor(extensionId, pagePath),
    title: String(title || "Extension"),
    pageURL: buildExtensionURL(extensionId, pagePath || ""),
  };
  if (panels.has(panel.panelId)) {
    return true; // re-registration (reload replay race) — already hosted
  }
  panels.set(panel.panelId, panel);
  ready
    .then(() => {
      if (contents && !contents.isDestroyed()) {
        return contents.executeJavaScript(
          `window.__SHELL_EXT_PANELS__?.addPanel(${JSON.stringify(panel)})`,
          true
        );
      }
      return undefined;
    })
    .catch((error) => console.error("[extensions] addPanel failed:", error));
  return true;
};

module.exports = { attach, addPanel };
