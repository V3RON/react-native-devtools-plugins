// Second panel: a live log fed by a long-lived runtime.connect Port to the
// background worker. Also adopts the DevTools theme (theme.js).
window.ShowcaseTheme.init();

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
