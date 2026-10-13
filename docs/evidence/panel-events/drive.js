// CDP driver that produced the screenshots in this folder (see README.md).
//   node docs/evidence/panel-events/drive.js <out-dir> [electron-port=9234]
// Needs the shell running with --remote-debugging-port=<electron-port> and
// DEVTOOLS_SHOW_PANEL=sample-extension/panel.html, so the shell itself selects the panel
// through the `showPanel` dispatch event before anything is clicked.
const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");

const OUT = process.argv[2];
const PORT = process.argv[3] || "9234";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) =>
  new Promise((resolve, reject) =>
    http.get(url, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject)
  );

const connect = async (match) => {
  const t = (await getJSON(`http://127.0.0.1:${PORT}/json/list`)).find(match);
  if (!t) throw new Error("target not found");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else events.push(msg);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;
  return { send, events, evaluate };
};

const DEEP = `const deep=(id)=>{let f=null;const walk=(root)=>{for(const el of root.querySelectorAll('*')){if(el.id===id)f=el;if(el.shadowRoot)walk(el.shadowRoot);}};walk(document);return f;};`;
const OSUDIO = "tab-ext.16.sample-extension.panel.html";
const PANEL_ID = "ext.16.sample-extension.panel.html";
const OTHER = "tab-network";

const logLines = (c) =>
  c.events.filter((e) => e.method === "Runtime.consoleAPICalled")
    .map((e) => e.params.args.map((a) => a.value).join(" ")).filter((l) => l.includes("[panel-events]"));

(async () => {
  const frontend = async () => {
    const c = await connect((x) => x.url.includes("rn_fusebox"));
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 520, deviceScaleFactor: 1, mobile: false });
    return c;
  };
  const shot = async (c, name) =>
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  const click = async (c, id) => {
    const [x, y] = await c.evaluate(`(() => { ${DEEP} const b = deep(${JSON.stringify(id)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  const scrollPanel = (dev) => dev.send("Runtime.evaluate", { expression: "panelWindow.scrollTo(0, 99999)" });
  const selected = (c, id) => c.evaluate(`(() => { ${DEEP} const t = deep(${JSON.stringify(id)}); return t && t.getAttribute('aria-selected'); })()`);

  let dev = await connect((x) => x.url.startsWith("rozenite://sample-extension/devtools.html"));
  await dev.send("Runtime.enable");
  let main = await frontend();
  await sleep(1500);

  // 1. nothing clicked: the shell's own showPanel (DEVTOOLS_SHOW_PANEL) selected Osudio
  console.log("osudio selected before any click:", await selected(main, OSUDIO));
  await shot(main, "1-showpanel-no-click");

  await click(main, OTHER); await sleep(900);
  await shot(main, "2-network-selected");
  await click(main, OSUDIO); await sleep(900);
  await scrollPanel(dev); await sleep(200);
  await shot(main, "3-osudio-reshown-same-page");

  // 4. showPanel again from the Network tab, the way the preload's dispatcher calls it
  await click(main, OTHER); await sleep(700);
  await main.evaluate(`window.InspectorFrontendAPI.showPanel(${JSON.stringify(PANEL_ID)})`);
  await sleep(900);
  console.log("osudio selected after showPanel dispatch:", await selected(main, OSUDIO));
  await scrollPanel(dev); await sleep(200);
  await shot(main, "4-showpanel-from-network");
  const before = logLines(dev);
  console.log("devtools-page console (before reload):\n" + before.join("\n"));

  // 5. frontend reload: new devtools page, panel deduped, events still flow
  await main.send("Page.reload", {});
  await sleep(14000);
  dev = await connect((x) => x.url.startsWith("rozenite://sample-extension/devtools.html"));
  await dev.send("Runtime.enable");
  main = await frontend();
  await sleep(1000);
  await click(main, OSUDIO); await sleep(1500);
  await click(main, OTHER); await sleep(800);
  await click(main, OSUDIO); await sleep(1000);
  await scrollPanel(dev); await sleep(200);
  await shot(main, "5-after-frontend-reload");
  const after = logLines(dev);
  console.log("devtools-page console (after reload):\n" + after.join("\n"));
  fs.writeFileSync(`${OUT}/console.txt`, `# before frontend reload\n${before.join("\n")}\n# after frontend reload (new devtools page, panel deduped)\n${after.join("\n")}\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
