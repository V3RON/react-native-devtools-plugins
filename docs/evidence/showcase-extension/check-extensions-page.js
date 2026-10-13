// Opens chrome://extensions in the same Chromium (port 9252) and records, from the page's own
// chrome.developerPrivate, the extension's state: errors, service worker, views.
//   node check-extensions-page.js [port=9252] [outDir=.]
const path = require("path");
const fs = require("fs");
const { getJson, connect, evaluate, screenshot } = require("./cdp");
const PORT = Number(process.argv[2] || 9252);
const OUT = path.resolve(process.argv[3] || __dirname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ver = await getJson(PORT, "/json/version");
  const br = await connect(ver.webSocketDebuggerUrl);
  const { targetId } = await br.send("Target.createTarget", { url: "chrome://extensions" });
  await sleep(2500);
  const t = (await getJson(PORT)).find((x) => x.id === targetId);
  const c = await connect(t.webSocketDebuggerUrl);
  const info = JSON.parse(
    await evaluate(
      c,
      `(async()=>{const all=await chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true});
        return JSON.stringify(all.filter(e=>e.name==='DevTools Showcase').map(e=>({name:e.name,version:e.version,state:e.state,
          runtimeErrors:e.runtimeErrors.length,manifestErrors:e.manifestErrors.length,
          views:e.views.map(v=>({type:v.type,url:v.url,isIframe:v.isIframe})),
          permissions:e.permissions.simplePermissions.map(p=>p.message)})))})()`
    )
  );
  fs.writeFileSync(path.join(OUT, "chrome-extensions-page.json"), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info, null, 2));
  // Focus the card in the page for the screenshot.
  await evaluate(c, `(()=>{const m=document.querySelector('extensions-manager');const l=m.shadowRoot.querySelector('extensions-item-list');const items=l.shadowRoot.querySelectorAll('extensions-item');items.forEach(i=>{if(!i.shadowRoot.textContent.includes('DevTools Showcase'))i.style.display='none'});})()`).catch(() => {});
  await screenshot(c, path.join(OUT, "chrome-4-extensions-page.png"));
  c.close();
  await br.send("Target.closeTarget", { targetId });
  br.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
