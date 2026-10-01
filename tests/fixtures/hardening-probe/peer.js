// The messaging peer for tests/fixtures/hardening-probe/probe.js.
//
// Same extension, second frame: probe.js sends from its own frame and the host
// router relays, so a round-trip here crosses two frames rather than looping
// inside one page (docs/features/RUNTIME-MESSAGING.md).
const MARKER = "__ROZENITE_PROBE__";
const chrome0 = window.chrome;

const say = (payload) =>
  console.log(`${MARKER}${JSON.stringify({ peer: true, url: location.href, ...payload })}`);

say({ registered: true, id: chrome0.runtime.id });

chrome0.runtime.onMessage.addListener((message, sender, sendResponse) => {
  say({ gotMessage: message && message.type, from: sender && sender.id });
  if (message && message.type === "probe-ping") {
    sendResponse({ type: "probe-pong", from: chrome0.runtime.id, via: location.pathname });
    say({ responded: true });
  }
});

chrome0.runtime.onConnect.addListener((port) => {
  say({ connected: port.name });
  port.onMessage.addListener((message) => {
    say({ portMessage: message });
    if (message === "probe-port-ping") {
      port.postMessage("probe-port-pong");
    }
  });
});
