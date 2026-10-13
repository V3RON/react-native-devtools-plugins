// Drives the RN DevTools shell (Electron, --remote-debugging-port=9254) over CDP: open the
// Showcase panel, press the interactive cards, capture screenshots + the panel's results.
//   node run-shell.js [port=9254] [outDir=.] [prefix=shell]
const path = require("path");
const fs = require("fs");
const { getJson, connect, evaluate, screenshot } = require("./cdp");

const PORT = Number(process.argv[2] || 9254);
const OUT = path.resolve(process.argv[3] || __dirname);
const PREFIX = process.argv[4] || "shell";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ts = await getJson(PORT);
  const page = ts.find((t) => t.type === "page" && t.url.includes("rn_fusebox"));
  const c = await connect(page.webSocketDebuggerUrl);
  // Electron has no Browser.* domain; size the frontend's viewport instead.
  await Promise.race([c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }), sleep(4000)]);
  await sleep(1000);
  const iv = `(async()=>{const m=await import('/rozenite/ui/legacy/legacy.js');return m.InspectorView.InspectorView.instance()})()`;
  const tabIds = JSON.parse(await evaluate(c, `(async()=>{const v=await ${iv};return JSON.stringify(v.tabbedPane.tabIds())})()`));
  console.log("tabs:", tabIds);
  const mainId = tabIds.find((i) => /showcase/i.test(i) && !/log/i.test(i));
  const logId = tabIds.find((i) => /showcase/i.test(i) && /log/i.test(i));
  const show = (id) => evaluate(c, `(async()=>{const v=await ${iv};await v.showPanel(${JSON.stringify(id)})})()`);

  await show(logId);
  await sleep(1500);
  await screenshot(c, path.join(OUT, `${PREFIX}-2-log-panel.png`));
  await show(mainId);
  await sleep(3500);

  // The panel page is recreated each time its tab is shown: always connect to the live one.
  const livePanel = async () => connect((await getJson(PORT)).find((t) => t.url === "rozenite://showcase/panel.html").webSocketDebuggerUrl);
  let p = await livePanel();
  const click = (label) =>
    evaluate(p, `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`);

  for (const label of ["Reload", "Notify", "Arm alarm", "Save JSON", "Re-run", ...(process.env.EXTRA_CLICKS || "").split(",").filter(Boolean)]) console.log("click", label, await click(label));
  await sleep(1500);
  await show(logId);
  await sleep(800);
  await show(mainId);
  await sleep(500);
  p.close();
  p = await livePanel();
  await sleep(33000); // first alarm tick

  // Flip the frontend theme so the panel OBSERVES a change (light, then back to dark).
  const setTheme = (v) =>
    evaluate(c, `(async()=>{const m=await import('/rozenite/core/common/common.js');m.Settings.Settings.instance().moduleSetting('ui-theme').set(${JSON.stringify(v)})})()`);
  const theme0 = await evaluate(p, `document.documentElement.dataset.theme`);
  await setTheme(theme0 === "dark" ? "default" : "dark");
  await sleep(2500);
  console.log("theme after flip:", await evaluate(p, `document.documentElement.dataset.theme`));
  await screenshot(c, path.join(OUT, `${PREFIX}-4-flipped-theme.png`));
  await setTheme(theme0 === "dark" ? "dark" : "default");
  await sleep(2500);

  await screenshot(c, path.join(OUT, `${PREFIX}-1-showcase-panel.png`));
  await evaluate(p, `window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(600);
  await screenshot(c, path.join(OUT, `${PREFIX}-3-showcase-panel-lower.png`));
  const results = JSON.parse(await evaluate(p, `JSON.stringify(window.__showcase.results)`));
  fs.writeFileSync(path.join(OUT, `${PREFIX}-results.json`), JSON.stringify(results, null, 2));
  for (const [k, v] of Object.entries(results)) console.log(k.padEnd(16), v.state.padEnd(7), v.text.replace(/\n/g, " / ").slice(0, 120));
  c.close();
  p.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
