#!/usr/bin/env node
// Live evidence driver for chrome.i18n (docs/evidence/i18n/README.md).
//
//   node docs/evidence/i18n/drive.js <name> [--lang <tag>] [--env-locale <tag>] [--out <dir>]
//
// Brings up the whole stack on this feature's ports and drives the REAL UI:
//   1. headless Chromium on CHROME_PORT with a tiny page  = the "inspected target"
//   2. src/tools/fake-cdp.js on CDP_PORT                   = RN-shaped CDP in front of it
//   3. the Electron shell (xvfb) on ELECTRON_PORT          = the thing under test
// then opens the sample extension's "Osudio" panel tab (its title comes from
// chrome.i18n.getMessage("panelTitle") in devtools.js), reads what the panel rendered
// and captures a screenshot. Everything is torn down at the end (only what this script
// started is killed).
//
// --lang        passed to Electron as `--lang=<tag>` (Chromium's own UI-locale switch)
// --env-locale  sets DEVTOOLS_UI_LOCALE instead (the shell's override knob)
// Ports are this feature's assignment: 9272-9276.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..", "..", "..");
const arg = (name, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const NAME = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "run";
const LANG = arg("lang");
const ENV_LOCALE = arg("env-locale");
const OUT = path.resolve(arg("out", __dirname));
const CHROME_PORT = 9272;
const CDP_PORT = 9273;
const ELECTRON_PORT = 9274;
const TARGET_URL = "http://127.0.0.1:9275/";
// panelTitle in extensions/sample-extension/_locales/*/messages.json
const PANEL_TITLES = ["Osudio", "Painel Osudio", "Osudio-Panel", "لوحة Osudio"];
const CHROMIUM = process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const start = (command, args, options = {}) => {
  const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], ...options });
  child.output = "";
  child.stdout.on("data", (d) => (child.output += d));
  child.stderr.on("data", (d) => (child.output += d));
  children.push(child);
  return child;
};
const stopAll = () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
};
process.on("exit", stopAll);

const getJson = async (url) => (await fetch(url)).json();
const waitFor = async (description, probe, attempts = 80, delay = 500) => {
  let lastError = "";
  for (let i = 0; i < attempts; i += 1) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error.message; // not yet
    }
    await sleep(delay);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? ` (last error: ${lastError})` : ""}`);
};

/** A minimal CDP client over one websocket; sessions via flatten. */
const connect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        id += 1;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      }),
    on: (listener) => ws.on("message", (raw) => listener(JSON.parse(raw))),
    close: () => ws.close(),
  };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 1. the inspected target: a tiny page served locally so fake-cdp can find it by URL.
  const http = require("http");
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<title>inspected target</title><h1>inspected target</h1>");
  });
  await new Promise((resolve) => server.listen(9275, "127.0.0.1", resolve));
  const chromeProfile = fs.mkdtempSync("/tmp/i18n-evidence-chrome-");
  start(CHROMIUM, [
    "--no-sandbox",
    "--headless=new",
    `--user-data-dir=${chromeProfile}`,
    `--remote-debugging-port=${CHROME_PORT}`,
    TARGET_URL,
  ]);
  await waitFor("the target page", async () =>
    (await getJson(`http://127.0.0.1:${CHROME_PORT}/json`)).some((t) => t.url === TARGET_URL)
  );

  // 2. fake CDP
  const fake = start("node", [
    path.join(REPO, "src/tools/fake-cdp.js"),
    "--chrome-host", "127.0.0.1",
    "--chrome-port", String(CHROME_PORT),
    "--listen-port", String(CDP_PORT),
    "--target-url", TARGET_URL,
  ]);
  await sleep(1500);

  // 3. the Electron shell
  const userData = fs.mkdtempSync("/tmp/i18n-evidence-user-");
  const env = {
    ...process.env,
    DEVTOOLS_CDP_BRIDGE: "off",
    DEVTOOLS_FRONTEND_URL: `http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:${CDP_PORT}`,
  };
  if (ENV_LOCALE) {
    env.DEVTOOLS_UI_LOCALE = ENV_LOCALE;
  }
  const electronArgs = [
    "-a", "-s", "-screen 0 1700x900x24",
    path.join(REPO, "node_modules/.bin/electron"),
    REPO,
    "--no-sandbox",
    `--remote-debugging-port=${ELECTRON_PORT}`,
    `--user-data-dir=${userData}`,
  ];
  if (LANG) {
    electronArgs.push(`--lang=${LANG}`);
  }
  const shell = start("xvfb-run", electronArgs, { env, cwd: REPO });
  globalThis.__shell = shell;

  const page = await waitFor("the frontend window", async () =>
    (await getJson(`http://127.0.0.1:${ELECTRON_PORT}/json`)).find((t) => t.type === "page" && /rn_fusebox/.test(t.url))
  );
  const cdp = await connect(page.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"));
  const evaluate = async (expression, contextId) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId ? { contextId } : {}),
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const issues = [];
  cdp.on((m) => m.method === "Audits.issueAdded" && issues.push(m.params.issue.code + ":" + JSON.stringify(m.params.issue.details).slice(0, 160)));
  await cdp.send("Audits.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 720, deviceScaleFactor: 1, mobile: false });

  // The panel tab strip is built by the frontend once extensions registered; the tab's
  // title is whatever the extension's devtools page passed to panels.create — here
  // chrome.i18n.getMessage("panelTitle").
  const tabSelector = "[role=tab]";
  let lastTitles = [];
  const tabs = await waitFor("extension panel tabs", async () => {
    const titles = await evaluate(`(() => {
      const collect = (root) => [...root.querySelectorAll('${tabSelector}')].map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim());
      const out = collect(document);
      for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) out.push(...collect(el.shadowRoot)); }
      return out;
    })()`);
    lastTitles = titles;
    globalThis.__lastTitles = titles;
    return titles.some((t) => PANEL_TITLES.includes(t)) ? titles : null;
  }, 120);
  const info = { name: NAME, lang: LANG || null, envLocale: ENV_LOCALE || null, tabs };

  // Which tab belongs to the sample extension: its title is the translated panelTitle.
  const title = tabs.find((t) => PANEL_TITLES.includes(t));
  info.panelTabTitle = title || null;
  if (title) {
    // A real pointer click on the tab: DevTools tabs ignore a synthetic `.click()`.
    const rect = await evaluate(`(() => {
      const hit = (root) => [...root.querySelectorAll('${tabSelector}')].find((el) => (el.getAttribute('aria-label') || el.textContent || '').trim() === ${JSON.stringify(title)});
      let el = hit(document);
      if (!el) { for (const host of document.querySelectorAll('*')) { if (host.shadowRoot && (el = hit(host.shadowRoot))) break; } }
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    }
  }

  // The extension's panel is an out-of-process iframe: attach to its own target through
  // the browser endpoint and read what the panel rendered, from the panel's own context.
  const browser = await connect((await getJson(`http://127.0.0.1:${ELECTRON_PORT}/json/version`)).webSocketDebuggerUrl);
  const panelTarget = await waitFor("the panel frame target", async () =>
    (await browser.send("Target.getTargets")).targetInfos.find((t) => t.url.startsWith("rozenite://sample-extension/panel.html"))
  );
  info.panelTarget = panelTarget.url;
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: true });
  const inPanel = async (expression) => {
    const result = await browser.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };
  await waitFor("the panel's own checks", async () => inPanel("document.querySelectorAll('#results li').length > 6"));
  await sleep(1000);
  info.panel = await inPanel(`({
    heading: document.getElementById('heading').textContent,
    demo: [...document.querySelectorAll('#i18n-demo > div')].map((d) => d.textContent),
    direction: getComputedStyle(document.body).direction,
    getUILanguage: chrome.i18n.getUILanguage(),
    acceptLanguages: null,
    checks: [...document.querySelectorAll('#results li')].map((li) => li.textContent).filter((t) => /i18n/.test(t) || /^FAIL/.test(t)),
  })`);
  info.panel.acceptLanguages = await inPanel("chrome.i18n.getAcceptLanguages()");
  // The very first message the preload resolved, before any panel script: the tab title.
  info.panelTabTitleFromGetMessage = title;
  info.issues = issues;
  info.console = shell.output
    .split("\n")
    .filter((line) => /i18n|\[check\] (PASS|FAIL) chrome\.i18n|Deprecation|Synchronous/i.test(line))
    .slice(0, 20);

  await sleep(1500);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, `${NAME}.png`), Buffer.from(shot.data, "base64"));
  fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info, null, 2));

  cdp.close();
  server.close();
  stopAll();
  process.exit(0);
})().catch(async (error) => {
  console.error("DRIVER FAILED:", error.message);
  try {
    const list = await getJson(`http://127.0.0.1:${ELECTRON_PORT}/json`);
    console.error("targets:", JSON.stringify(list.map((t) => [t.type, t.url])));
    const dt = list.find((t) => t.url.includes("sample-extension/devtools.html"));
    const probe = await connect(dt.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"));
    const r = await probe.send("Runtime.evaluate", { expression: "JSON.stringify({t: chrome.i18n.getMessage('panelTitle'), l: chrome.i18n.getUILanguage(), s: document.scripts.length})", returnByValue: true });
    console.error("devtools page:", JSON.stringify(r));
  } catch {}
  console.error("tabs seen:", JSON.stringify(globalThis.__lastTitles || []));
  console.error(String(globalThis.__shell && globalThis.__shell.output).slice(-9000));
  stopAll();
  process.exit(1);
});
