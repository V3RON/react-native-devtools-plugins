#!/usr/bin/env node
// Dev-only tool: CDP man-in-the-middle.
//
// Makes the RN DevTools frontend (which connects to ws://localhost:<listen>)
// talk to a real Chrome tab's CDP endpoint instead of an RN app — used to
// develop/verify extension behavior against a web target (docs/ARCHITECTURE.md).
//
// Usage:
//   node src/tools/fake-cdp.js \
//     [--target-url http://localhost:8081/] \
//     [--chrome-host localhost] [--chrome-port 9222] [--listen-port 9223]
//
// Requires Chrome running with --remote-debugging-port=<chrome-port>.
const WebSocket = require("ws");
const { default: fetch } = require("node-fetch");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const CHROME_HOST = arg("chrome-host", "localhost");
const CHROME_PORT = Number(arg("chrome-port", 9222));
const LISTEN_PORT = Number(arg("listen-port", 9223));
// Which Chrome tab to attach to (exact URL match on /json).
const TARGET_URL = arg("target-url", "http://localhost:8081/");

(async () => {
  // 1. Find the real CDP WebSocket URL of the target tab in Chrome.
  const versionRes = await fetch(`http://${CHROME_HOST}:${CHROME_PORT}/json`);
  const targets = await versionRes.json();
  const target = targets.find(
    (t) => t.type === "page" && t.url === TARGET_URL
  );
  if (!target) {
    console.error(`No Chrome tab with url ${TARGET_URL} on port ${CHROME_PORT}`);
    process.exit(1);
  }
  console.log(`Attaching to: ${target.webSocketDebuggerUrl}`);

  // 2. Connect to the real Chrome instance (once; shared by all clients).
  const realWs = new WebSocket(target.webSocketDebuggerUrl);

  // 3. Accept frontend connections on the listen port and proxy both ways.
  const server = new WebSocket.Server({ port: LISTEN_PORT });
  const clients = new Set();

  realWs.on("message", (msg) => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg.toString());
    }
  });

  server.on("connection", (client) => {
    console.log("RN DevTools connected");
    clients.add(client);
    client.on("message", (msg) => {
      if (realWs.readyState === WebSocket.OPEN) realWs.send(msg.toString());
    });
    client.on("close", () => clients.delete(client));
  });

  console.log(`Fake CDP server running on ws://localhost:${LISTEN_PORT}`);
})();
