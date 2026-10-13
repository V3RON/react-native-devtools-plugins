// Panel.onShown / onHidden (docs/features/DEVTOOLS-PANELS.md): onShown receives the
// panel page's own window, so this devtools page can write straight into the panel's
// document — which is also how a person sees the events happen.
//
// DevTools detaches a hidden tab's content, so the panel page is re-created on every
// show; the devtools page is the long-lived side, so it keeps the history and
// re-renders all of it into whichever window onShown hands over.
const history = [];

const render = (win) => {
  const list = win && win.document && win.document.getElementById("panel-events");
  if (!list) {
    return;
  }
  list.textContent = "";
  for (const text of history) {
    const item = win.document.createElement("li");
    item.textContent = text;
    list.appendChild(item);
  }
};

const record = (text, win) => {
  console.log(`[panel-events] ${text}`);
  history.push(`${new Date().toLocaleTimeString()} ${text}`);
  render(win);
};

let panelWindow = null;
chrome.devtools.panels.create("Osudio", null, "/panel.html", (panel) => {
  panel.onShown.addListener((win) => {
    panelWindow = win;
    record(`onShown (window: ${win ? win.location.href : "none"})`, win);
  });
  panel.onHidden.addListener(() => {
    // onHidden carries no window in Chrome either; the one from onShown is still
    // reachable until the panel page is torn down.
    record("onHidden", panelWindow);
  });
});
