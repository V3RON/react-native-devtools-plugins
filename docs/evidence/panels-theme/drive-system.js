const WebSocket = require("ws");
const fs = require("fs");
const OUT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => (await fetch(u)).json();

const connect = (url) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const handlers = [];
    ws.on("message", (m) => {
      const msg = JSON.parse(m);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else handlers.forEach((h) => h(msg));
    });
    const send = (method, params = {}) =>
      new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    ws.on("open", () => resolve({ send, on: (h) => handlers.push(h), ws }));
  });

const evalIn = async (c, expression) => {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result.exceptionDetails ? "EXC " + JSON.stringify(r.result.exceptionDetails) : r.result.result.value;
};
const shot = async (c, name) => {
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64"));
};

(async () => {
  const targets = await get("http://localhost:9224/json");
  const page = targets.find((t) => t.type === "page" && t.url.includes("rn_fusebox"));
  const main = await connect(page.webSocketDebuggerUrl);
  await main.send("Runtime.enable");
  await sleep(2000);
  const panelId = "ext.sample-extension.panel.html";
  const setTheme = (v) =>
    evalIn(
      main,
      `import("/rozenite/core/common/common.js").then(c => { c.Settings.Settings.instance().moduleSetting("ui-theme").set(${JSON.stringify(v)}); return c.Settings.Settings.instance().moduleSetting("ui-theme").get(); })`
    );
  const showPanel = () =>
    evalIn(main, `import("/rozenite/ui/legacy/legacy.js").then(l => l.InspectorView.InspectorView.instance().showPanel(${JSON.stringify(panelId)})).then(()=> "shown")`);

  const log = [];
  const panelState = async (label) => {
    const ts = (await get("http://localhost:9224/json")).filter((t) => t.url.includes("sample-extension/panel.html"));
    const out = [];
    for (const t of ts) {
      const c = await connect(t.webSocketDebuggerUrl);
      const msgs = [];
      c.on((m) => {
        if (m.method === "Runtime.consoleAPICalled") msgs.push(m.params.args.map((a) => a.value).join(" "));
      });
      await c.send("Runtime.enable");
      await sleep(300);
      const v = await evalIn(c, `JSON.stringify({themeName: chrome.devtools.panels.themeName, line: document.getElementById("theme").textContent})`);
      out.push({ v, theme: msgs.filter((m) => m.startsWith("[theme]")) });
      c.ws.close();
    }
    const cls = await evalIn(main, `document.documentElement.classList.contains("theme-with-dark-background")`);
    log.push({ label, frontendDark: cls, panel: out });
    console.log(label, JSON.stringify({ frontendDark: cls, panel: out }));
  };

  await showPanel();
  console.log("set systemPreferred", await setTheme("systemPreferred"));
  await main.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(1500);
  // Annotation only (not product UI): states the inputs of this shot, read live from the
  // frontend, so the two system-preference shots are distinguishable and self-describing.
  const caption = (media) =>
    evalIn(
      main,
      `import("/rozenite/core/common/common.js").then(c => {
        let el = document.getElementById("evidence-caption");
        if (!el) { el = document.createElement("div"); el.id = "evidence-caption";
          el.style.cssText = "position:fixed;right:4px;bottom:4px;z-index:99999;font:11px monospace;padding:3px 6px;background:#ff0;color:#000;border:1px solid #000";
          document.body.appendChild(el); }
        el.textContent = "ui-theme=" + c.Settings.Settings.instance().moduleSetting("ui-theme").get() +
          " | emulated prefers-color-scheme: ${media}";
      })`
    );
  await caption("dark");
  await shot(main, "5-system-dark");
  await panelState("systemPreferred + system dark");
  await main.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await sleep(1500);
  await caption("light");
  await shot(main, "6-system-light");
  await panelState("systemPreferred + system flips to light");
  fs.writeFileSync(`${OUT}/log-system.json`, JSON.stringify(log, null, 2));
  process.exit(0);
})();
