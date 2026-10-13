// Panel.onShown / onHidden (docs/features/DEVTOOLS-PANELS.md): onShown receives the
// panel page's own window, so this devtools page can write straight into the panel's
// document — which is also how a person sees the events happen. The panel page stays
// alive while its tab is hidden (like Chrome's), so the list simply grows.
const record = (text, win) => {
  console.log(`[panel-events] ${text}`);
  const list = win && win.document && win.document.getElementById("panel-events");
  if (list) {
    const item = win.document.createElement("li");
    item.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    list.appendChild(item);
  }
};

let panelWindow = null;
chrome.devtools.panels.create(chrome.i18n.getMessage("panelTitle"), null, "/panel.html", (panel) => {
  panel.onShown.addListener((win) => {
    panelWindow = win;
    record(`onShown (window: ${win ? win.location.href : "none"})`, win);
  });
  panel.onHidden.addListener(() => {
    // onHidden carries no window in Chrome either; the one from onShown is still live
    record("onHidden", panelWindow);
  });
});
