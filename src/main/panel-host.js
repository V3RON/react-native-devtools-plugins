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
const { buildExtensionURL, panelIdFor } = require("../shared/protocol");

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "panel-bridge.js"),
  "utf8"
);


let contents = null;
let ready = Promise.resolve(); // resolves when the live bridge is up
const panels = new Map(); // panelId -> { panelId, title, pageURL }

// panelId -> { pagePath, send } of the devtools-page frame that created the panel
// most recently. Kept apart from `panels` because that map is serialized into the
// frontend. Chrome hands the Panel object (and so its onShown/onHidden) to the
// devtools page that called panels.create and to no one else, so visibility events
// go to exactly this frame; a reloaded devtools page re-creates its panels (dedupe
// keeps the tab) and takes the seat over, which is what retires a stale sender.
const owners = new Map();
const shown = new Set(); // panelIds the frontend last reported as selected

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
  // A fresh frontend document starts with no panel selected.
  webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      shown.clear();
    }
  });
  webContents.on("did-finish-load", boot);
};

/** Whether `event` came from the frontend's own main frame (the only legitimate
 *  reporter of tab selection). */
const isFrontendFrame = (event) =>
  Boolean(
    contents &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame
  );

/**
 * The frontend reports a panel tab becoming (in)visible. Idempotent: only a real
 * transition is forwarded, and only to the creating devtools-page frame.
 * @returns {boolean} whether an event was delivered
 */
const setPanelVisible = (panelId, visible) => {
  if (typeof panelId !== "string" || !panels.has(panelId) || shown.has(panelId) === visible) {
    return false;
  }
  if (visible) {
    shown.add(panelId);
  } else {
    shown.delete(panelId);
  }
  const owner = owners.get(panelId);
  if (!owner) {
    return false;
  }
  owner.send({
    kind: "panel",
    payload: { pagePath: owner.pagePath, event: visible ? "shown" : "hidden" },
  });
  return true;
};

const addPanel = ({ extensionId, title, pagePath, owner }) => {
  const panel = {
    panelId: panelIdFor(extensionId, pagePath),
    title: String(title || "Extension"),
    pageURL: buildExtensionURL(extensionId, pagePath || ""),
  };
  if (owner) {
    owners.set(panel.panelId, { pagePath, send: owner.send });
  }
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

module.exports = { attach, addPanel, panelIdFor, isFrontendFrame, setPanelVisible };
