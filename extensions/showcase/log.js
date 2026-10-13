// Second panel: a live log fed by a long-lived runtime.connect Port to the
// background worker. Also adopts the DevTools theme (see panel.js for the details).
const applyTheme = (name) => {
  document.documentElement.dataset.theme = name === "dark" ? "dark" : "light";
};
const panels = chrome.devtools && chrome.devtools.panels;
applyTheme(panels && panels.themeName);
// Chrome's real hook is setThemeChangeHandler; event-style spellings are tried first.
let wired = false;
for (const name of ["themeChanged", "onThemeChanged"]) {
  if (!wired && panels && panels[name] && typeof panels[name].addListener === "function") {
    panels[name].addListener(applyTheme);
    wired = true;
  }
}
if (!wired && panels && typeof panels.setThemeChangeHandler === "function") {
  panels.setThemeChangeHandler(applyTheme);
}

const out = document.getElementById("entries");
const conn = document.getElementById("conn");
const line = (e) => {
  const time = new Date(e.t).toISOString().slice(11, 23);
  out.textContent += `${time}  [${e.source}] ${e.text}\n`;
  out.scrollTop = out.scrollHeight;
};

const connect = () => {
  let port;
  try {
    port = chrome.runtime.connect({ name: "showcase-log" });
  } catch (e) {
    conn.textContent = "connect failed: " + e.message;
    return;
  }
  conn.textContent = "connected";
  port.onMessage.addListener((m) => {
    if (m.type === "history") m.entries.forEach(line);
    else if (m.type === "log") line(m.entry);
  });
  port.onDisconnect.addListener(() => {
    conn.textContent = "disconnected, retrying...";
    setTimeout(connect, 1500); // a Chrome worker may have been evicted
  });
};
connect();
