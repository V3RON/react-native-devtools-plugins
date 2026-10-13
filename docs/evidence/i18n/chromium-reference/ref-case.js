// Ground truth for chrome.i18n: loads a throwaway extension into REAL headless Chromium
// (--load-extension) and prints what chrome.i18n answers there (or Chromium's load error).
//
//   node docs/evidence/i18n/chromium-reference/ref-case.js <spec.json>
//
// Used through ref-batch.js; the cases are in cases.js and their recorded answers in
// results.txt. The unit tests in tests/i18n.test.js pin this shell to those answers.
//   spec: {lang, locales:{en:{...},pt:{...}}, default_locale, calls:[[name, subs?...]], extra:{}}
// Loads a throwaway extension into REAL Chromium and prints getMessage results (or the load error).
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const S = fs.mkdtempSync(path.join(require("os").tmpdir(), "i18n-ref-"));
const dir = fs.mkdtempSync(path.join(S, "case-"));
const ext = fs.realpathSync(dir);
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify({
  manifest_version: 3, name: "case", version: "1", default_locale: spec.default_locale === undefined ? "en" : spec.default_locale,
  background: { service_worker: "sw.js" }, ...(spec.manifest || {}),
}));
fs.writeFileSync(path.join(ext, "sw.js"), "");
for (const [loc, msgs] of Object.entries(spec.locales)) {
  fs.mkdirSync(path.join(ext, "_locales", loc), { recursive: true });
  fs.writeFileSync(path.join(ext, "_locales", loc, "messages.json"), JSON.stringify(msgs));
}
fs.writeFileSync(path.join(ext, "t.html"), '<script src="t.js"></script>');
fs.writeFileSync(path.join(ext, "t.js"), `
window.onerror=(m)=>{document.title="ERR"+m};const calls=${JSON.stringify(spec.calls)};
const out={};
calls.forEach((c,i)=>{try{out[i+":"+JSON.stringify(c)]=chrome.i18n.getMessage(...c)}catch(e){out[i+":"+JSON.stringify(c)]="THROW "+e.message}});
out.manifest=chrome.runtime.getManifest();out.uiLang=chrome.i18n.getUILanguage(); out.ui_locale=chrome.i18n.getMessage("@@ui_locale");
out.bidi=["@@bidi_dir","@@bidi_reversed_dir","@@bidi_start_edge","@@bidi_end_edge"].map(n=>chrome.i18n.getMessage(n));
Promise.all([chrome.i18n.getAcceptLanguages(), ...(${JSON.stringify(spec.detect || [])}).map(t=>chrome.i18n.detectLanguage(t))]).then(r=>{out.accept=r[0];out.detect=r.slice(1);window.__out=JSON.stringify(out);document.title="DONE"}).catch(e=>{document.title="ERR"+e.message});
`);
const id = [...crypto.createHash("sha256").update(ext).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const lang = spec.lang || "en-US";
const prof = path.join(S, "prof-case");
fs.rmSync(prof, { recursive: true, force: true });
const port = Number(process.env.REF_PORT || 9276);
const env = { ...process.env, LANGUAGE: lang.replace("-", "_"), LC_ALL: lang.replace("-", "_") + ".UTF-8" };
const child = spawn(process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", [
  "--no-sandbox", "--headless=new", `--user-data-dir=${prof}`, `--lang=${lang}`,
  `--load-extension=${ext}`, `--remote-debugging-port=${port}`, "--enable-logging=stderr", "about:blank",
], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
let err = "";
child.stderr.on("data", (d) => { const m = String(d).match(/Failed to load extension from.*$/m); if (m) err = m[0]; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (v) => { console.log(typeof v === "string" ? v : JSON.stringify(v)); try { process.kill(-child.pid, "SIGKILL"); } catch {} fs.rmSync(S, { recursive: true, force: true }); process.exit(0); };
(async () => {
  for (let i = 0; i < 30 && !err; i++) {
    await sleep(200);
    try {
      const tl = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (tl.some((x) => x.url.includes(id))) break;
    } catch {}
  }
  await sleep(300);
  if (err) return done("LOAD ERROR: " + err.replace(/^Failed to load extension from: \S+\. /, ""));
  const json = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(json.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let n = 0; const pend = {};
  ws.on("message", (m) => { const o = JSON.parse(m); if (o.id && pend[o.id]) pend[o.id](o); });
  const send = (method, params) => new Promise((r) => { const i = ++n; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${id}/t.html` });
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const a = await send("Target.attachToTarget", { targetId, flatten: true });
    const r = await new Promise((res) => { const i = ++n; pend[i] = res; ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: "document.title+\"|\"+(window.__out||\"\")" }, sessionId: a.result.sessionId })); });
    const title = r.result && r.result.result && r.result.result.value;
    if (title && title.startsWith("ERR")) return done(title); if (title && title.startsWith("DONE")) return done(JSON.parse(title.slice(title.indexOf("|")+1)));
  }
  done("NO RESULT");
})();
