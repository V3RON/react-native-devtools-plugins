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

  console.log("ui-theme now:", await evalIn(main, `import("/rozenite/core/common/common.js").then(c => c.Settings.Settings.instance().moduleSetting("ui-theme").get())`));
  // 1: boot with whatever the persisted setting is — start from a known state: dark
  console.log("set dark", await setTheme("dark"));
  await sleep(500);
  await main.send("Page.reload");
  await sleep(9000);
  const page2 = (await get("http://localhost:9224/json")).find((t) => t.type === "page" && t.url.includes("rn_fusebox"));
  main.ws.close();
  const m2 = await connect(page2.webSocketDebuggerUrl);
  Object.assign(main, m2);
  await main.send("Runtime.enable");
  await showPanel();
  await sleep(1500);
  await shot(main, "1-boot-dark");
  await panelState("boot dark");
  console.log("set default", await setTheme("default"));
  await sleep(1500);
  await shot(main, "2-switched-to-light");
  await panelState("after switch to light");
  console.log("set dark", await setTheme("dark"));
  await sleep(1500);
  await shot(main, "3-switched-back-to-dark");
  await panelState("after switch to dark");
  // boot in light
  console.log("set default", await setTheme("default"));
  await sleep(800);
  await main.send("Page.reload");
  await sleep(9000);
  const page3 = (await get("http://localhost:9224/json")).find((t) => t.type === "page" && t.url.includes("rn_fusebox"));
  const m3 = await connect(page3.webSocketDebuggerUrl);
  Object.assign(main, m3);
  await main.send("Runtime.enable");
  await showPanel();
  await sleep(1500);
  await shot(main, "4-boot-light");
  await panelState("boot light");
  fs.writeFileSync(`${OUT}/log.json`, JSON.stringify(log, null, 2));
  process.exit(0);
})();
