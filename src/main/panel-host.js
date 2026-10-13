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
const { dispatchToFrontend } = require("./dispatch");
const config = require("./config");

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "panel-bridge.js"),
  "utf8"
);


let contents = null;
let ready = Promise.resolve(); // resolves when the live bridge is up
const panels = new Map(); // panelId -> { panelId, extensionId, title, pageURL }

// panelId -> { extensionId, pagePath, send } of the devtools-page frame that created the panel
// most recently. Kept apart from `panels` because that map is serialized into the
// frontend. Chrome hands the Panel object (and so its onShown/onHidden) to the
// devtools page that called panels.create and to no one else, so visibility events
// go to exactly this frame; a reloaded devtools page re-creates its panels (dedupe
// keeps the tab) and takes the seat over, which is what retires a stale sender. Only a
// frame of the SAME extension may take a seat over (see addPanel).
const owners = new Map();
const shown = new Set(); // panelIds the frontend last reported as selected
const hosted = new Map(); // panelId -> promise: the bridge has added the tab

// DEVTOOLS_SHOW_PANEL=<extensionId>[/<pagePath>]: open the shell on that extension's
// panel, once, the first time it registers (the host-internal consumer of showPanel).
let startupPanel = config.showPanel ? String(config.showPanel).trim() : "";
if (startupPanel.endsWith("/")) {
  console.warn(
    `[extensions] DEVTOOLS_SHOW_PANEL="${startupPanel}" has an empty page path, so it can never ` +
      "match a panel; use <extensionId> or <extensionId>/<pagePath>"
  );
  startupPanel = "";
}
const matchesStartupPanel = (extensionId, pagePath) => {
  if (!startupPanel) {
    return false;
  }
  const slash = startupPanel.indexOf("/");
  const wantedExtension = slash === -1 ? startupPanel : startupPanel.slice(0, slash);
  if (wantedExtension !== extensionId) {
    return false;
  }
  return (
    slash === -1 ||
    panelIdFor(extensionId, startupPanel.slice(slash + 1)) === panelIdFor(extensionId, pagePath)
  );
};

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
    extensionId,
    title: String(title || "Extension"),
    pageURL: buildExtensionURL(extensionId, pagePath || ""),
  };
  const existing = panels.get(panel.panelId);
  if (existing && existing.extensionId !== extensionId) {
    // The id is injective across extensions (src/shared/protocol.js); this only guards
    // ids whose sanitized forms collide, and it is the rule that matters: another
    // extension's panel, its events and its window are never taken over.
    return false;
  }
  if (owner) {
    owners.set(panel.panelId, { extensionId, pagePath, send: owner.send });
  }
  if (existing) {
    return true; // re-registration (reload replay race) — already hosted
  }
  panels.set(panel.panelId, panel);
  const added = ready
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
  hosted.set(panel.panelId, added);
  if (matchesStartupPanel(extensionId, pagePath)) {
    startupPanel = ""; // once
    showPanel(panel.panelId);
  }
  return true;
};

/**
 * Host -> frontend `showPanel` (docs/features/DISPATCH-CHANNEL.md): select the tab of a
 * panel this host registered. The panelId is checked against the live registry — it is
 * never forwarded blindly, so the frontend is only ever asked to show a view this shell
 * created. Waits for the bridge to have added the tab, so it can be called straight after
 * registration. Host-internal: Chrome has no extension API for this, and nothing an
 * extension frame can send reaches it. Selecting the tab is what makes the frontend fire
 * the normal visibility report, so Panel.onShown follows by the usual path.
 * @returns {Promise<boolean>} whether the frontend received the request
 */
const showPanel = (panelId) => {
  if (typeof panelId !== "string" || !panels.has(panelId)) {
    return Promise.resolve(false);
  }
  return Promise.resolve(hosted.get(panelId)).then(() =>
    dispatchToFrontend("showPanel", [panelId])
  );
};

module.exports = { attach, addPanel, showPanel, setPanelVisible };
