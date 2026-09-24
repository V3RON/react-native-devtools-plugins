#!/usr/bin/env node
// Dev-only tool: CDP man-in-the-middle for a real React Native app.
//
// The sibling of fake-cdp.js (docs/ARCHITECTURE.md): instead of a Chrome tab,
// attaches to a React Native app debuggable through Metro's inspector proxy
// (@react-native/dev-middleware, RN >= 0.72 / Expo with it built in):
//
//   1. polls `http://<metro>/json/list` for debuggable RN pages,
//   2. per frontend connection, opens `ws://<metro>/inspector/debug?device=..&page=..`
//      and relays CDP both ways, re-resolving the target when the app
//      (re)connects or reloads.
//
// Usage:
//   node src/tools/rn-cdp.js \
//     [--metro-host 127.0.0.1] [--metro-port 8081] [--listen-port 9223] \
//     [--app expo56] [--device iPhone]
//
// Requires the RN app running against its Metro dev server, with a debugger
// connection established (dev build; Dev Menu -> "Connect to debugger" if the
// app doesn't show up in /json/list).
const WebSocket = require("ws");
const { default: fetch } = require("node-fetch");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const METRO_HOST = arg("metro-host", "127.0.0.1");
const METRO_PORT = Number(arg("metro-port", 8081));
const LISTEN_PORT = Number(arg("listen-port", 9223));
// Optional substring filters for the /json/list entries.
const APP_FILTER = arg("app", null);
const DEVICE_FILTER = arg("device", null);

const POLL_INTERVAL_MS = 1500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  let targets;
  try {
    const res = await fetch(`http://${METRO_HOST}:${METRO_PORT}/json/list`);
    targets = await res.json();
  } catch {
    return null; // Metro not up yet
  }
  const pages = targets.filter(
    (t) =>
      t.type === "node" &&
      t.webSocketDebuggerUrl &&
      (!APP_FILTER || (t.description || t.appId || "").includes(APP_FILTER)) &&
      (!DEVICE_FILTER || (t.deviceName || "").includes(DEVICE_FILTER))
  );
  return pages[0] || null;
}

// Waits for a target, relays until either side closes, then re-resolves.
// Returns only when `client` is closed.
async function attachLoop(client) {
  let upstream = null;
  // Messages arriving while the upstream socket is (re)connecting must not be
  // lost: the frontend sends Runtime.enable/Debugger.enable immediately.
  let pendingSends = [];
  client.on("close", () => upstream && upstream.close());
  client.on("message", (msg) => {
    if (upstream && upstream.readyState === WebSocket.OPEN)
      upstream.send(msg.toString());
    else if (pendingSends.length < 1000) pendingSends.push(msg.toString());
  });

  while (client.readyState === WebSocket.OPEN) {
    const target = await findTarget();
    if (!target) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    console.log(`Attaching to: ${target.webSocketDebuggerUrl}`);
    // Both RN's inspector proxy (origin allowlist) and Expo's extra guard
    // (origin host must equal the dev server's own host — 127.0.0.1) are
    // satisfied by a 127.0.0.1 Origin.
    const socket = await new Promise((resolve) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl, {
        headers: { Origin: `http://${METRO_HOST}:${METRO_PORT}` },
      });
      ws.on("open", () => resolve(ws));
      ws.on("error", (err) => {
        console.error(`Upstream failed: ${err.message}`);
        resolve(null);
      });
    });
    if (!socket || client.readyState !== WebSocket.OPEN) {
      socket && socket.close();
      await sleep(POLL_INTERVAL_MS); // device/page may have changed
      continue;
    }
    upstream = socket;
    for (const msg of pendingSends) socket.send(msg);
    pendingSends = [];

    const disconnected = new Promise((resolve) => {
      socket.on("close", (code, reason) =>
        resolve(`close ${code} ${String(reason) || "(no reason)"}`)
      );
      socket.on("error", (err) => resolve(`error ${err.message}`));
    });
    socket.on("message", (msg) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg.toString());
    });
    console.log(`Attached (${await disconnected}), waiting for it to come back…`);
    socket.close();
    upstream = null;
  }
}

const server = new WebSocket.Server({ port: LISTEN_PORT });
console.log(
  `RN CDP server running on ws://localhost:${LISTEN_PORT} ` +
    `(Metro: ${METRO_HOST}:${METRO_PORT})`
);
server.on("connection", (client) => {
  console.log("RN DevTools connected");
  attachLoop(client).catch((err) => console.error(err));
});
