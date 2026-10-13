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

  // Theme -> host -> every extension context (chrome.devtools.panels.themeName /
  // themeChanged). ThemeSupport is the frontend's own authority: it resolves the
  // `ui-theme` setting ("default" | "dark" | "systemPreferred") against the
  // system's prefers-color-scheme and dispatches `themechange` after applying it.
  // Reported BEFORE the extension frames are created, and also carried on each frame's
  // URL (`?__rozenite_theme=`, src/shared/theme.js), so they boot with the answer.
  //
  // Best effort, never on the critical path: a moved module or a stuck IPC costs the
  // extensions their theme (they stay on "default"), not their panels.
  let currentTheme = "default";
  let themeKnown = false; // read from ThemeSupport at least once
  try {
    const themeModule = await import("/rozenite/ui/legacy/theme_support/theme_support.js");
    const themeSupport = themeModule.ThemeSupport.instance();
    const reportTheme = () => {
      currentTheme = themeSupport.themeName() === "dark" ? "dark" : "default";
      return window.__SHELL_HOST__?.reportTheme(currentTheme);
    };
    if (!window.__SHELL_THEME_LISTENER__) {
      // The bridge re-runs on every page load, but a load is a fresh window; this
      // only guards a manual re-evaluation from stacking listeners.
      window.__SHELL_THEME_LISTENER__ = true;
      themeSupport.addEventListener(themeModule.ThemeChangeEvent.eventName, () => {
        reportTheme();
      });
    }
    currentTheme = themeSupport.themeName() === "dark" ? "dark" : "default";
    themeKnown = true;
    await Promise.race([
      Promise.resolve(reportTheme()),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch (error) {
    console.warn("[extensions] theme reporting unavailable:", error);
  }

  // The frame URL's theme hint; same literal as THEME_PARAM in src/shared/theme.js.
  // Never stamped when the theme could not be read: a guessed "default" would boot a dark
  // frontend's frames wrong and flip them once the register reply arrived.
  const withTheme = (url) => {
    if (!themeKnown) {
      return url;
    }
    const hash = url.indexOf("#");
    const base = hash === -1 ? url : url.slice(0, hash);
    const tail = hash === -1 ? "" : url.slice(hash);
    return `${base}${base.includes("?") ? "&" : "?"}__rozenite_theme=${currentTheme}${tail}`;
  };

  const devtoolsPageFrames = [];

  // Panel.onShown / onHidden: the widget lifecycle is the truth about tab selection
  // (wasShown runs when the tab's content is attached and visible, willHide when
  // another tab replaces it), so it is hooked on the instance rather than inferred
  // from tab clicks. Main de-duplicates and routes to the creating devtools page.
  //
  // The FIRST show is reported once the panel's iframe has loaded, not when the tab is
  // selected: the devtools page can only obtain the panel's window (onShown's argument)
  // once that browsing context is registered and navigated, and Chrome hands over a
  // ready window too. If no load follows (an embedder that kept the frame alive), the
  // report goes out anyway after a short grace period. Later shows report at once:
  // the view is setHideOnDetach, so the page is still there.
  const LOAD_GRACE_MS = 1500;
  const reportVisibility = (view, panelId, frame) => {
    const report = (shown) => {
      try {
        window.__SHELL_HOST__.reportPanelVisible(panelId, shown);
      } catch {
        // host without the shell method: panel events simply stay quiet
      }
    };
    let visible = false;
    let loadedOnce = false;
    let awaitingLoad = false;
    let grace = null;
    const settle = () => {
      clearTimeout(grace);
      loadedOnce = true;
      if (awaitingLoad && visible) {
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
      if (loadedOnce) {
        report(true);
      } else {
        awaitingLoad = true;
        clearTimeout(grace);
        grace = setTimeout(settle, LOAD_GRACE_MS);
      }
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
    // Keep the panel page alive while its tab is hidden, as the frontend's own
    // ExtensionPanel/ExtensionView do (models/extensions): without it DevTools detaches
    // the content, which destroys and reloads the iframe on every show.
    view.setHideOnDetach();
    const frame = document.createElement("iframe");
    frame.src = withTheme(pageURL);
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
    frame.src = withTheme(extension.devtoolsPageURL);
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
