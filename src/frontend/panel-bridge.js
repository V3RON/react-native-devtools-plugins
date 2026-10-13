// Shell-driven extension hosting — frontend half (docs/features/DEVTOOLS-PANELS.md).
//
// NOT a module: main process reads this file and evaluates it as an
// expression via webContents.executeJavaScript in the FRONTEND's main world
// on every page load (src/main/panel-host.js). Config arrives via
// window.__SHELL_EXT_CONFIG__ = { devtoolsPages, panels }.
//
// The dynamic import resolves to the very module instance the frontend (and
// Rozenite's host.js) already use — same URL string, same module map — so
// InspectorView.instance() is the live singleton, not a second copy.
(async () => {
  const config = window.__SHELL_EXT_CONFIG__ || { devtoolsPages: [], panels: [] };

  // Boot only after the frontend has built its app UI (same readiness signal
  // Rozenite's host.js waits on): constructing InspectorView before Main's
  // init sequence dies in theme-support setup.
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (document.querySelector(".main-tabbed-pane")) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 30000) {
        clearInterval(timer);
        reject(new Error("frontend UI did not appear within 30s"));
      }
    }, 100);
  });

  const legacy = await import("/rozenite/ui/legacy/legacy.js");
  const inspectorView = legacy.InspectorView.InspectorView.instance();

  const devtoolsPageFrames = [];

  // Panel.onShown / onHidden: the widget lifecycle is the truth about tab selection
  // (wasShown runs when the tab's content is attached and visible, willHide when
  // another tab replaces it), so it is hooked on the instance rather than inferred
  // from tab clicks. Main de-duplicates and routes to the creating devtools page.
  //
  // "Shown" is reported once the panel's iframe has LOADED, not when the tab is
  // selected: DevTools detaches a hidden tab's content, so every show re-creates the
  // iframe's browsing context, and the devtools page can only obtain the panel's
  // window (onShown's argument) once that context is registered and navigated. Chrome
  // fires onShown with a ready window too. If no load follows a show (an embedder that
  // keeps the frame alive), the report goes out anyway after a short grace period.
  const LOAD_GRACE_MS = 1500;
  const reportVisibility = (view, panelId, frame) => {
    const report = (shown) => {
      try {
        window.InspectorFrontendHost.setExtensionPanelVisible(panelId, shown);
      } catch {
        // host without the shell method: panel events simply stay quiet
      }
    };
    let visible = false;
    let awaitingLoad = false;
    let grace = null;
    const settle = () => {
      clearTimeout(grace);
      if (awaitingLoad && visible) {
        awaitingLoad = false;
        report(true);
      }
      awaitingLoad = false;
    };
    frame.addEventListener("load", settle);
    const wasShown = view.wasShown;
    const willHide = view.willHide;
    view.wasShown = function (...args) {
      const result = wasShown.apply(this, args);
      visible = true;
      awaitingLoad = true;
      clearTimeout(grace);
      grace = setTimeout(settle, LOAD_GRACE_MS);
      return result;
    };
    view.willHide = function (...args) {
      visible = false;
      awaitingLoad = false;
      clearTimeout(grace);
      report(false);
      return willHide.apply(this, args);
    };
  };

  const addPanel = ({ panelId, title, pageURL }) => {
    if (inspectorView.hasPanel(panelId)) {
      return false; // duplicate replay / re-registration
    }
    const view = new legacy.View.SimpleView(title, true, panelId);
    const frame = document.createElement("iframe");
    frame.src = pageURL;
    // Named so the creating devtools page can obtain this frame's window for
    // Panel.onShown(window): `window.open("", name)` resolves an existing named frame
    // without navigating it (the panel frame lives in a shadow tree, so it is not in
    // window.parent.frames). src/preload/extension-frame.js has the other half.
    frame.name = panelId;
    frame.style.cssText = "width:100%;height:100%;border:0";
    view.contentElement.appendChild(frame);
    reportVisibility(view, panelId, frame);
    inspectorView.addPanel(view);
    return true;
  };

  window.__SHELL_EXT_PANELS__ = { addPanel, version: 1 };

  // Chrome-style hidden devtools page per extension: the extension-frame
  // preload arms these frames with chrome.*, and their
  // chrome.devtools.panels.create calls arrive back as EXT_PANEL_CREATE IPCs
  // (kept referenced so the frames are never GC'd).
  for (const extension of config.devtoolsPages) {
    const frame = document.createElement("iframe");
    frame.src = extension.devtoolsPageURL;
    frame.setAttribute("hidden", "");
    frame.style.cssText =
      "position:fixed;left:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    devtoolsPageFrames.push(frame);
  }

  // Replay panels registered before this load (frontend reloads keep tabs).
  let replayed = 0;
  for (const panel of config.panels) {
    if (addPanel(panel)) {
      replayed++;
    }
  }

  console.log(
    `🧩 Shell extensions: ${config.devtoolsPages.length} devtools page(s), ` +
      `${replayed} panel(s) replayed`
  );
  return config.devtoolsPages.length;
})();
