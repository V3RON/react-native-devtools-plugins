// Shared helpers for the evidence drivers: launch the shell under Xvfb with its own
// remote-debugging port, then drive the frontend window over CDP. Ports (9292-9296):
// 9292 inspected Chromium, 9293 fake-cdp, 9294 Electron, 9295 static target page.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const REPO = path.resolve(__dirname, "..", "..", "..");
const ELECTRON_PORT = 9294;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Launch the shell. `wrapDir` holds an `electron` script that adds --no-sandbox (root). */
const launchShell = ({ wrapDir, env = {}, userData }) => {
  const child = spawn(
    "xvfb-run",
    ["-a", "-s", "-screen 0 1280x900x24", "npx", "electron", ".", `--remote-debugging-port=${ELECTRON_PORT}`,
      `--user-data-dir=${userData}`],
    {
      cwd: REPO,
      env: {
        ...process.env,
        ELECTRON_OVERRIDE_DIST_PATH: wrapDir,
        DEVTOOLS_CDP_BRIDGE: "off",
        DEVTOOLS_FRONTEND_URL: "http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9293",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so `stop` takes xvfb, npx and electron down together
    }
  );
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await sleep(500);
  };
  return { child, log, stop };
};

const frontendTarget = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${ELECTRON_PORT}/json`)).json();
      const page = list.find((t) => t.type === "page" && /rn_fusebox/.test(t.url));
      if (page) return page;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("frontend window never appeared on the Electron CDP port");
};

/** A tiny CDP client over one websocket. */
const connect = async (target) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === "Runtime.consoleAPICalled") {
      consoleLines.push(message.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };
  const screenshot = async (file) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  };
  const click = async (x, y, button = "left") => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
    }
  };
  return { send, evaluate, screenshot, click, consoleLines, close: () => ws.close() };
};

module.exports = { REPO, sleep, launchShell, frontendTarget, connect };
