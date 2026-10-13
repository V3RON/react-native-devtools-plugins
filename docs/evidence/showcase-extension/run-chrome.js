// Drives real Chromium (started with the showcase extension + --auto-open-devtools-for-tabs
// on --remote-debugging-port=9252) over CDP: undock DevTools, open the Showcase panel,
// press the interactive cards, capture screenshots and the panel's results as JSON.
//   node run-chrome.js [port=9252] [outDir=.]
const path = require("path");
const fs = require("fs");
const { getJson, connect, evaluate, screenshot } = require("./cdp");

const PORT = Number(process.argv[2] || 9252);
const OUT = path.resolve(process.argv[3] || __dirname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const devtoolsPages = async () => (await getJson(PORT)).filter((t) => t.url.startsWith("devtools://") && t.url.includes("devtools_app"));
const dockSideOf = async (t) => {
  const c = await connect(t.webSocketDebuggerUrl);
  try {
    return await evaluate(c, `(async()=>{const m=await import('devtools://devtools/bundled/ui/legacy/legacy.js');return m.DockController.DockController.instance().dockSide()})()`);
  } finally {
    c.close();
  }
};
const inspectorView = `(async()=>{const m=await import('devtools://devtools/bundled/ui/legacy/legacy.js');return m.InspectorView.InspectorView.instance()})()`;

(async () => {
  // 1. Undock DevTools so the panel gets a full-size window.
  let dt = (await devtoolsPages())[0];
  let c = await connect(dt.webSocketDebuggerUrl);
  await evaluate(c, `(async()=>{const m=await import('devtools://devtools/bundled/ui/legacy/legacy.js');m.DockController.DockController.instance().setDockSide('undocked')})()`);
  c.close();
  await sleep(2500);
  for (const t of await devtoolsPages()) if ((await dockSideOf(t)) === "undocked") dt = t;
  c = await connect(dt.webSocketDebuggerUrl);

  const tabIds = JSON.parse(await evaluate(c, `(async()=>{const iv=await ${inspectorView};return JSON.stringify(iv.tabbedPane.tabIds())})()`));
  console.log("tabs:", tabIds.filter((i) => i.startsWith("chrome-extension://")));
  const mainId = tabIds.find((i) => i.endsWith("Showcase"));
  const logId = tabIds.find((i) => i.endsWith("ShowcaseLog"));
  const show = (id) => evaluate(c, `(async()=>{const iv=await ${inspectorView};await iv.showPanel(${JSON.stringify(id)})})()`);

  // 2. Open the log panel first (so onHidden has something to fire for), then the main one.
  await show(logId);
  await sleep(1500);
  await screenshot(c, path.join(OUT, "chrome-2-log-panel.png"));
  await show(mainId);
  await sleep(3500);

  const frames = async (suffix) => (await getJson(PORT)).find((t) => t.url.endsWith(suffix) && t.url.startsWith("chrome-extension://"));
  const panelT = await frames("/panel.html");
  const p = await connect(panelT.webSocketDebuggerUrl);
  const click = (label) =>
    evaluate(p, `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`);

  // 3. Press the interactive cards.
  for (const label of ["Notify", "Arm alarm", "Save HAR", "Reload", "Re-run"]) console.log("click", label, await click(label));
  await sleep(1200);
  console.log("click Save JSON", await click("Save JSON"));
  await sleep(1500);
  await show(logId);
  await sleep(800);
  await show(mainId);
  // The alarm ticks every 30 s; wait for the first one.
  await sleep(33000);

  await screenshot(c, path.join(OUT, "chrome-1-showcase-panel.png"));
  const results = JSON.parse(await evaluate(p, `JSON.stringify(window.__showcase.results)`));
  fs.writeFileSync(path.join(OUT, "chrome-results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));

  // 4. Theme: flip DevTools to dark and prove the panel follows (themeChanged).
  await evaluate(c, `(async()=>{const m=await import('devtools://devtools/bundled/core/common/common.js');m.Settings.Settings.instance().moduleSetting('ui-theme').set('dark')})()`).catch((e) => console.log("theme set failed", e.message));
  await sleep(2500);
  console.log("panel theme attr after dark:", await evaluate(p, `document.documentElement.dataset.theme + ' / ' + chrome.devtools.panels.themeName`));
  await screenshot(c, path.join(OUT, "chrome-3-dark-theme.png"));
  c.close();
  p.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
