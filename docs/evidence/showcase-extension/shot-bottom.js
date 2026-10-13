// Scrolls the Showcase panel to the bottom and screenshots the host window.
//   node shot-bottom.js <port> <out.png> [electron]   (default: real Chromium DevTools window)
const { getJson, connect, evaluate, screenshot } = require("./cdp");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const port = Number(process.argv[2]);
  const out = process.argv[3];
  const ts = await getJson(port);
  const hostPage = process.argv[4] === "electron"
    ? ts.find((t) => t.type === "page" && t.url.includes("rn_fusebox"))
    : (await Promise.all(ts.filter((t) => t.url.includes("devtools_app")).map(async (t) => {
        const c = await connect(t.webSocketDebuggerUrl);
        const side = await evaluate(c, `(async()=>{const m=await import('devtools://devtools/bundled/ui/legacy/legacy.js');return m.DockController.DockController.instance().dockSide()})()`);
        c.close();
        return side === "undocked" ? t : null;
      }))).find(Boolean);
  const panelT = ts.find((t) => t.url.endsWith("/panel.html") && /^(chrome-extension|rozenite):/.test(t.url));
  const p = await connect(panelT.webSocketDebuggerUrl);
  await evaluate(p, `window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(600);
  const c = await connect(hostPage.webSocketDebuggerUrl);
  await screenshot(c, out);
  c.close();
  p.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
