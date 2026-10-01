#!/usr/bin/env node
// Dev-only tool: run the RN CDP relay as a *separate* process.
//
// The shell now runs the same relay in its own main process
// (src/main/cdp-bridge.js), so this is no longer required for a live app: start
// the shell and it attaches to Metro by itself. Keep using it when you want the
// relay outside the shell — with `DEVTOOLS_CDP_BRIDGE=off npm start` the shell
// leaves the socket alone and this tool answers on the frontend's `ws` port:
//
//   1. polls `http://<metro>/json/list` for debuggable RN pages,
//   2. opens `ws://<metro>/inspector/debug?device=..&page=..` and relays CDP
//      both ways, re-resolving the target when the app (re)connects or reloads.
//
// Usage:
//   node src/tools/rn-cdp.js \
//     [--metro-host 127.0.0.1] [--metro-port 8081] [--listen-port 9223] \
//     [--app expo56] [--device iPhone]
//
// Requires the RN app running against its Metro dev server, with a debugger
// connection established (dev build; Dev Menu -> "Connect to debugger" if the
// app doesn't show up in /json/list).
const { createCdpBridge } = require("../main/cdp-bridge");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const bridge = createCdpBridge({
  metroHost: arg("metro-host", "127.0.0.1"),
  metroPort: Number(arg("metro-port", 8081)),
  listenPort: Number(arg("listen-port", 9223)),
  // Optional substring filters for the /json/list entries.
  app: arg("app", null),
  device: arg("device", null),
  log: (level, message) =>
    console[level === "error" ? "error" : "log"](
      level === "warn" ? `WARNING: ${message}` : message
    ),
});

bridge.start().catch((error) => {
  console.error(`Could not start the RN CDP relay: ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bridge.stop().finally(() => process.exit(0));
  });
}
