// The development shell's target pick (src/electron/shell/frontend-target.js): upstream
// gets the frontend URL from dev-middleware; this shell builds it from Metro's /json/list.
const test = require("node:test");
const assert = require("node:assert");
const {
  frontendURLFor,
  namesDebugger,
  pickTarget,
  resolveFrontendURL,
} = require("../src/electron/shell/frontend-target");
const { cdpTargetOf } = require("../src/electron/extensions/internal/cdp/cdp-session");

const BASE = "http://127.0.0.1:8081/rozenite/rn_fusebox.html";
const entry = (over = {}) => ({
  type: "node",
  description: "com.example.app",
  deviceName: "iPhone 17 Pro",
  webSocketDebuggerUrl: "ws://127.0.0.1:8081/inspector/debug?device=abc&page=1",
  ...over,
});

test("the frontend URL carries the target's debugger URL as ws=, which the host reads back", () => {
  const url = frontendURLFor(entry(), BASE);
  assert.equal(new URL(url).searchParams.get("ws"), "127.0.0.1:8081/inspector/debug?device=abc&page=1");
  assert.equal(new URL(url).origin, "http://127.0.0.1:8081", "the page's origin is unchanged");
  // The round trip the two halves depend on: what the shell writes is what the host dials.
  assert.equal(cdpTargetOf(url).wsUrl, entry().webSocketDebuggerUrl);
  const secure = frontendURLFor(entry({ webSocketDebuggerUrl: "wss://h:1/inspector/debug?page=1" }), BASE);
  assert.equal(new URL(secure).searchParams.get("wss"), "h:1/inspector/debug?page=1");
  assert.equal(new URL(secure).searchParams.has("ws"), false);
});

test("the first React Native target that passes the filters is picked", () => {
  const list = [
    { type: "page", webSocketDebuggerUrl: "ws://x/1" },
    entry({ description: "other.app", webSocketDebuggerUrl: "ws://x/2" }),
    entry({ webSocketDebuggerUrl: "ws://x/3" }),
  ];
  assert.equal(pickTarget(list).webSocketDebuggerUrl, "ws://x/2");
  assert.equal(pickTarget(list, { app: "com.example" }).webSocketDebuggerUrl, "ws://x/3");
  assert.equal(pickTarget(list, { device: "Pixel" }), null);
  assert.equal(pickTarget("nope"), null);
});

test("a configured URL that names its debugger is loaded as it is", async () => {
  const given = `${BASE}?ws=somewhere:1/inspector/debug`;
  assert.equal(namesDebugger(given), true);
  assert.equal(namesDebugger(BASE), false);
  const fetch = () => assert.fail("no lookup for a URL that names its debugger");
  assert.equal(await resolveFrontendURL({ frontendURL: given, target: {}, fetch }), given);
});

test("without one, the shell waits for Metro to list an app", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return { json: async () => (calls === 2 ? [] : [entry()]) };
  };
  const logs = [];
  const url = await resolveFrontendURL({
    frontendURL: BASE,
    target: { metroHost: "127.0.0.1", metroPort: 8081 },
    pollIntervalMs: 1,
    fetch,
    log: (message) => logs.push(message),
  });
  assert.equal(calls, 3);
  assert.equal(new URL(url).searchParams.get("ws"), "127.0.0.1:8081/inspector/debug?device=abc&page=1");
  assert.equal(logs.filter((line) => /waiting/.test(line)).length, 1, "the wait is announced once");
});
