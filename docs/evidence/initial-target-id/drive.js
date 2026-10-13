// Evidence driver for InspectorFrontendHost.initialTargetId (see README.md here).
//
//   xvfb-run -a node docs/evidence/initial-target-id/drive.js
//
// Ports 9262-9266. Starts: headless Chromium (9262, the inspected page), a fake
// Metro serving /json/list on 9263 whose single entry points at Chromium's
// BROWSER-level websocket and uses the page's CDP targetId as its `id`, then the
// shell with the in-process CDP bridge ON (bridge listens on 9264, Electron's own
// debug port is 9265). The frontend is loaded with `browserConnection=true`, the
// only mode in which it calls initialTargetId. The driver records the frontend's
// websocket frames, shows the id it receives, evaluates in the Console and
// screenshots.
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "../../..");
const OUT = __dirname;
const [CHROME, METRO, BRIDGE, ELECTRON] = [9262, 9263, 9264, 9265];
const CHROME_BIN = process.env.CHROME_BIN || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FRONTEND = `http://127.0.0.1:8081/rozenite/worker_app.html?ws=localhost:${BRIDGE}&browserConnection=true`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const log = (...a) => console.log("[drive]", ...a);

const getJson = (url) =>
  new Promise((resolve, reject) =>
    http.get(url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject)
  );
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error("timeout: " + fn);
    await sleep(250);
  }
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.p = new Map(); this.on = () => {};
    this.ws.on("message", (m) => { const d = JSON.parse(String(m));
      if (d.id && this.p.has(d.id)) { this.p.get(d.id)(d); this.p.delete(d.id); } else this.on(d); }); }
  open() { return new Promise((r) => this.ws.on("open", r)); }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((r) => { this.p.set(id, r); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, "base64"));
    log("screenshot", name);
  }
}

(async () => {
  try {
    // 1. the inspected page
    const pageHtml = `http://127.0.0.1:${CHROME}/json/version`;
    children.push(spawn(CHROME_BIN, ["--headless=new", "--no-sandbox", "--disable-gpu",
      `--remote-debugging-port=${CHROME}`, "--remote-allow-origins=*", pageHtml],
      { stdio: "ignore", detached: true }));
    const page = await until(async () =>
      (await getJson(`http://127.0.0.1:${CHROME}/json/list`)).find((t) => t.type === "page"));
    const version = await getJson(`http://127.0.0.1:${CHROME}/json/version`);
    log("inspected page CDP targetId:", page.id);

    // 2. fake Metro: one debuggable entry, id = the page's CDP targetId
    const metro = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url.startsWith("/json/list") ? [{
        id: page.id, type: "node", title: "fake RN target", description: "fake [C++ connection]",
        appId: "fake", deviceName: "headless", webSocketDebuggerUrl: version.webSocketDebuggerUrl,
      }] : []));
    });
    await new Promise((r) => metro.listen(METRO, "127.0.0.1", r));

    // 3. the shell, bridge ON
    const electron = spawn("npx", ["electron", ".", "--no-sandbox", `--remote-debugging-port=${ELECTRON}`], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { ...process.env, DEVTOOLS_FRONTEND_URL: FRONTEND, DEVTOOLS_METRO_PORT: String(METRO),
        DEVTOOLS_CDP_PORT: String(BRIDGE), DEVTOOLS_CDP_HOST: "127.0.0.1" },
    });
    children.push(electron);
    const shellLog = fs.createWriteStream(path.join(OUT, "shell.log"));
    electron.stdout.pipe(shellLog); electron.stderr.pipe(shellLog);

    const target = await until(async () =>
      (await getJson(`http://127.0.0.1:${ELECTRON}/json/list`)).find((t) => t.type === "page" && /:8081\/rozenite\/worker_app/.test(t.url)));
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    // Record the frontend's CDP websocket traffic from page start (main world, before any
    // frontend script): the frames that mention autoAttachRelated / attachedToTarget.
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      window.__frames = [];
      const keep = (dir, d) => { const t = String(d).slice(0, 300);
        (window.__all=window.__all||[]).push(dir+" "+t.slice(0,80)); if (/autoAttachRelated|attachedToTarget/.test(t)) window.__frames.push(dir + "  " + t); };
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { keep("frontend -> bridge", d); return send.call(this, d); };
      const orig = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
      Object.defineProperty(WebSocket.prototype, "onmessage", { configurable: true,
        get() { return orig.get.call(this); },
        set(fn) { orig.set.call(this, fn && ((e) => { keep("bridge -> frontend", e.data); return fn.call(this, e); })); } });
    })()` });
    await cdp.send("Page.reload"); // so the hooks see the frontend's websocket from the start
    await until(() => cdp.eval("(window.__frames||[]).some(f => /attachedToTarget/.test(f))"), 30000);
    await sleep(3000);
    if (process.env.DBG) console.log((await cdp.eval("window.__all.filter(x=>/Target\./.test(x)).slice(0,12)")).join("\n"));
    const frames = (await cdp.eval("window.__frames")).map((f) => f.slice(0, 260));

    // 4. what the frontend host answers, asked directly too
    const direct = await cdp.eval("InspectorFrontendHost.initialTargetId()");
    log("InspectorFrontendHost.initialTargetId() ->", JSON.stringify(direct));
    const lines = [
      `inspected page CDP targetId : ${page.id}`,
      `initialTargetId() (direct)  : ${JSON.stringify(direct)}`,
      "", "frontend websocket frames (filtered):", ...frames,
    ];
    fs.writeFileSync(path.join(OUT, "frames.log"), lines.join("\n") + "\n");
    console.log(lines.join("\n"));

    await cdp.shot("1-frontend-attached.png");

    // 5. the Application panel lists the inspected page's origin: the frontend is attached to it
    const click = async (x, y) => { for (const type of ["mousePressed", "mouseReleased"])
      await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); };
    await click(42, 13); // the Application tab (the shell remembers the last-used tab)
    await sleep(1500);
    await click(14, 165); // expand "Local storage": the origin below it comes from the attached page
    await sleep(1500);
    await cdp.shot("2-application-origin-of-attached-page.png");
    log("done");
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    for (const c of children) try { process.kill(-c.pid); } catch {}
    setTimeout(() => process.exit(), 500);
  }
})();
