// Delivery scope: which host->frame network deliveries a frame may receive, and
// proof that the live push path actually works (GitHub issue #20).
//
// Two halves, because the bug this file exists for had two halves.
//
// 1. THE MATRIX. `src/main/delivery-scope.js` decides per message, not per
//    subscription, because one CDP capture feeds two Chrome APIs: `completed` and
//    `error` belong to `chrome.devtools.network` (no permission needed in Chrome)
//    AND to `chrome.webRequest`, while `request` / `sendHeaders` / `response` /
//    `redirect` feed webRequest's pre-completion steps alone. So the rule is not
//    "no data without the permission" — it is "no webRequest lifecycle without
//    the permission". Asserted per grant set x per payload kind, against the real
//    module, with the kind list itself pinned against what the host can actually
//    push (src/main/network-service.js), so a kind added there cannot go
//    unclassified here.
//
// 2. THE LIVE PUSH. Issue #20: `ipc.js` called `deliveryAllowed` without importing
//    it. The ReferenceError was thrown INSIDE the sender filter, which runs inside
//    network-service's `broadcast`, whose `try { … } catch {}` swallowed it — so
//    every live delivery for every frame died with no log line, while the
//    pull-based reads (getHAR, getContent) kept working and hid it. A matrix unit
//    test could never have caught that, because the function it tested was fine;
//    only "a real push reaches a real subscribed frame" catches it. That is the
//    suite below: the production shell in Electron (tests/extension-frame-harness.js)
//    with the production CDP bridge pointed at a fake inspected app that keeps
//    reporting real CDP traffic (tests/fake-rn-app.js), and the evidence is the
//    `chrome.webRequest` / `chrome.devtools.network` events a real `rozenite://`
//    frame observed.
//
// The DENY half of the live path is deliberately not faked here: a frame's
// `chrome.webRequest` listeners are withdrawn by the shim's own gate
// (src/chrome-shim/permission-gate.js), so a permission-less frame cannot observe
// main's filter separately from its own — that split is asserted where each half
// lives (`tests/extension-frame-electron.test.js` for the shim, the matrix above
// for main). What this file proves live is the direction that was broken: data
// reaching a frame that IS entitled to it.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  WEB_REQUEST_ONLY,
  deliveryAllowed,
} = require("../src/main/delivery-scope");
const { DELIVERED } = require("../src/main/network-service");

const { electronBinary, runHarness, stageExtension, consoleLines } = require("./electron-runner");

// ── 1. the allow/deny matrix ─────────────────────────────────────────────────
// The vocabulary, pinned at the source that produces it: `DELIVERED` is every
// request-lifecycle kind network-service broadcasts, plus the two non-record
// payloads it pushes (`navigated`, `status`). Anything outside this list arriving
// at the filter is the kind of surprise this assertion exists to surface.
const RECORD_KINDS = [...DELIVERED]; // request | sendHeaders | response | completed | error
const OTHER_KINDS = ["navigated", "status"];
// `redirect` is webRequest-only too; network-service carries it inside the
// `request` delivery's `extra` (src/main/network-service.js:104), and
// src/chrome-shim/network-bridge.js turns a redirectResponse into
// onBeforeRedirect — the reason it is on the set even though it is not a top-level
// kind of its own.
const ALL_KINDS = [...RECORD_KINDS, ...OTHER_KINDS, "redirect"];

test("WEB_REQUEST_ONLY names exactly the pre-completion lifecycle steps", () => {
  // The set is the security claim: these are the payloads whose object is a
  // webRequest `details`. `completed` / `error` are NOT on it — dropping them
  // would break chrome.devtools.network for an extension that legitimately
  // declares no permissions (Altair: storage, tabs, notifications only).
  assert.deepStrictEqual(
    [...WEB_REQUEST_ONLY].sort(),
    ["redirect", "request", "response", "sendHeaders"]
  );
});

test("every kind the host can push is classified by the matrix", () => {
  for (const kind of ALL_KINDS) {
    const verdict = deliveryAllowed({ webRequest: false }, kind);
    assert.equal(
      typeof verdict,
      "boolean",
      `${kind} gets a verdict, not undefined (an undefined verdict is how a filter silently becomes a pass-through)`
    );
    assert.equal(
      verdict,
      !WEB_REQUEST_ONLY.has(kind),
      `${kind}: webRequest-only iff it is on the set`
    );
  }
  // The other direction, and the load-bearing one for issue #20: the kinds the
  // host broadcasts are all known here. A new lifecycle step in network-service
  // that is not added to the matrix is an unclassified delivery, and this is the
  // assertion that says so.
  for (const kind of [...RECORD_KINDS, ...OTHER_KINDS]) {
    assert.ok(
      ALL_KINDS.includes(kind),
      `network-service can push ${kind}; the matrix must classify it`
    );
  }
});

test("a grant set without `webRequest` gets the devtools data and no webRequest lifecycle", () => {
  // The grant sets a real frame can end up with: what ipc.js stores from
  // grantedPermissions() (`every known permission => boolean`, `grants.get(key)`
  // for a frame that has not registered, and the `|| {}` fallback the tabs
  // handlers use).
  const grantSets = {
    "no grants object at all": undefined,
    "null grants": null,
    "empty grants": {},
    "other permissions only": { storage: true, tabs: true, notifications: true },
    "webRequest explicitly denied": { webRequest: false, storage: true },
  };
  for (const [label, grants] of Object.entries(grantSets)) {
    for (const kind of WEB_REQUEST_ONLY) {
      assert.equal(
        deliveryAllowed(grants, kind),
        false,
        `${label}: ${kind} is a webRequest details object and must not be delivered`
      );
    }
    for (const kind of ["completed", "error", "navigated", "status"]) {
      assert.equal(
        deliveryAllowed(grants, kind),
        true,
        `${label}: ${kind} also feeds chrome.devtools.network, which needs no permission`
      );
    }
  }
});

test("a grant set with `webRequest` gets everything", () => {
  for (const grants of [
    { webRequest: true },
    { webRequest: true, storage: false, tabs: false },
    // Chrome's own manifest truthiness, and the reason the filter uses Boolean():
    // a truthy non-boolean is still a grant.
    { webRequest: "yes" },
    { webRequest: 1 },
  ]) {
    for (const kind of ALL_KINDS) {
      assert.equal(
        deliveryAllowed(grants, kind),
        true,
        `${JSON.stringify(grants)}: ${kind} is allowed`
      );
    }
  }
});

test("an unknown kind is not a free pass for webRequest-shaped data", () => {
  // The filter's default is DENY for anything on the set and ALLOW for anything
  // off it. That is only safe because the set is the exhaustive list of
  // webRequest-detail payloads (docs/features/WEBREQUEST.md), which the two
  // assertions above pin. An unrecognised kind therefore follows devtools'
  // no-permission-needed rule rather than failing closed — this test exists so
  // that choice stays a decision someone read, not an accident.
  assert.equal(deliveryAllowed(undefined, "something-new"), true);
  assert.equal(deliveryAllowed({ webRequest: false }, "something-new"), true);
  assert.equal(deliveryAllowed({ webRequest: true }, "something-new"), true);
});

test("the filter is pure: it reads the grants it is handed and mutates nothing", () => {
  const grants = { webRequest: false };
  const before = JSON.stringify(grants);
  for (const kind of ALL_KINDS) {
    deliveryAllowed(grants, kind);
  }
  assert.strictEqual(JSON.stringify(grants), before);
  // Same verdicts on the second pass, and on a frozen copy — the filter runs on
  // every delivery for every frame, so a stateful one would be a leak.
  const frozen = Object.freeze({ webRequest: false });
  for (const kind of ALL_KINDS) {
    assert.strictEqual(deliveryAllowed(frozen, kind), deliveryAllowed(grants, kind));
  }
});

// ── 2. the live push, in a real Electron process ─────────────────────────────
const binary = electronBinary();
const suite = binary ? test : test.skip;

const GRANTED_ID = "scope-granted.local";
const UNGRANTED_ID = "scope-open.local";

const manifestFor = (id, permissions) =>
  JSON.stringify({
    name: `Delivery Scope ${id}`,
    version: "1.0.0",
    manifest_version: 3,
    permissions,
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  });

/**
 * One panel script, staged into both extensions. It registers a listener for every
 * webRequest event this host emits, plus devtools.network's two events, and reports
 * what it observed once it has seen a whole request cycle (or its deadline passes).
 * `permissions.getAll()` is reported too, so the frame's own view of its grants is
 * in the evidence next to the events.
 */
const panelScript = `
const MARKER = "__ROZENITE_PROBE__";
const seen = [];
const note = (label, details) =>
  seen.push({
    label,
    url: (details && details.url) || "",
    requestId: (details && details.requestId) || "",
  });

for (const name of [
  "onBeforeRequest",
  "onBeforeSendHeaders",
  "onSendHeaders",
  "onBeforeRedirect",
  "onResponseStarted",
  "onCompleted",
  "onErrorOccurred",
]) {
  chrome.webRequest[name].addListener((details) => note(name, details), { urls: ["<all_urls>"] });
}
chrome.devtools.network.onRequestFinished.addListener((request) =>
  note("onRequestFinished", { url: request && request.request && request.request.url })
);
chrome.devtools.network.onNavigated.addListener((url) => note("onNavigated", { url }));

const DEADLINE = Date.now() + 20000;
const report = () => {
  const listeners = {};
  for (const name of ["onBeforeRequest", "onSendHeaders", "onResponseStarted", "onCompleted"]) {
    listeners[name] = chrome.webRequest[name].hasListeners();
  }
  Promise.all([
    chrome.permissions.getAll(),
    chrome.devtools.network.getNetworkStatus(),
  ])
    .then(([permissions, status]) => {
      console.log(
        MARKER +
          JSON.stringify({
            extensionId: chrome.runtime.id,
            permissions,
            status: {
              available: status.available,
              enableState: status.enableState,
              requests: status.requests,
              finished: status.finished,
            },
            listeners,
            seen,
          })
      );
      // A plain line, because the MARKER line becomes a structured record and is
      // invisible to the harness's --wait-for log match.
      console.log("[scope-probe] reported " + chrome.runtime.id);
    })
    .catch((error) => {
      console.log("[scope-probe] failed " + chrome.runtime.id + ": " + error.message);
    });
};

// Report once a full cycle has arrived, plus a window to collect stragglers; a
// frame that receives nothing reports at its deadline rather than never.
const startedAt = Date.now();
const check = () => {
  const settled =
    seen.length > 0 &&
    seen.some((entry) => entry.label === "onCompleted" || entry.label === "onRequestFinished");
  if (Date.now() > DEADLINE || (settled && Date.now() - startedAt > 2000)) {
    report();
    return;
  }
  setTimeout(check, 150);
};
check();
`;

const panelHtml = `<!DOCTYPE html>
<html><body><script src="/panel.js"></script></body></html>
`;

/** Ask the OS for a free loopback port (two calls; the race is unobservable here). */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

suite(
  "a live CDP delivery reaches a subscribed extension frame",
  { timeout: 180000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-scope-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const extensionsDir = path.join(root, "extensions");
    stageExtension(extensionsDir, GRANTED_ID, {
      "manifest.json": manifestFor(GRANTED_ID, ["webRequest"]),
      "panel.html": panelHtml,
      "panel.js": panelScript,
    });
    stageExtension(extensionsDir, UNGRANTED_ID, {
      "manifest.json": manifestFor(UNGRANTED_ID, []),
      "panel.html": panelHtml,
      "panel.js": panelScript,
    });

    const [metroPort, cdpPort] = await Promise.all([freePort(), freePort()]);
    const hostPage = `<!DOCTYPE html>
<html><body>
  <iframe src="rozenite://${GRANTED_ID}/panel.html" width="600" height="400"></iframe>
  <iframe src="rozenite://${UNGRANTED_ID}/panel.html" width="100" height="100"></iframe>
</body></html>
`;

    const run = await runHarness({
      binary,
      root: path.join(root, "run1"),
      extensionsDir,
      hostPage,
      // The fake app streams one request lifecycle every 400 ms, so a frame that is
      // entitled to data has seen a full cycle well before this settles.
      extraArgs: [
        "--fake-rn-app=on",
        `--metro-port=${metroPort}`,
        `--cdp-port=${cdpPort}`,
        "--fake-app-interval=400",
      ],
      waitFor: "[scope-probe] reported scope-open.local",
      timeoutMs: 150000,
      settleMs: 3000,
    });

    const probes = run.observed.filter((line) => line.kind === "probe" && line.data);
    const byId = Object.fromEntries(probes.map((line) => [line.data.extensionId, line.data]));
    const granted = byId[GRANTED_ID];
    const ungranted = byId[UNGRANTED_ID];
    const fakeApp = (run.observed.find((line) => line.kind === "fake-app") || {}).stats || {};
    const dump = () =>
      [
        `  exit=${run.code} probes=${probes.length}`,
        `  fake app: ${JSON.stringify(fakeApp)}`,
        `  granted: ${JSON.stringify(granted)}`,
        `  ungranted: ${JSON.stringify(ungranted)}`,
        `  console: ${consoleLines(run.observed).slice(-15).join(" | ")}`,
        `  output tail: ${String(run.output).slice(-1500)}`,
      ].join("\n");

    // 0. The premise: the run really had a debugger session, and the fake app
    //    really served traffic through it. Without this, an empty event list below
    //    would be a passing "no data" test rather than a failing delivery test.
    assert.ok(
      fakeApp.enabled,
      `the model's lazy Network.enable reached the inspected app over the real bridge:${dump()}`
    );
    assert.ok(
      fakeApp.announced.length > 0,
      `the inspected app reported requests:${dump()}`
    );

    assert.ok(granted, `the granted frame reported:${dump()}`);
    assert.ok(ungranted, `the ungranted frame reported:${dump()}`);

    // 1. THE GAP THAT LET ISSUE #20 SHIP. Every one of these events is a
    //    NETWORK_DELIVER push that travelled main -> preload -> shim -> listener.
    //    With `deliveryAllowed` unimported, the ReferenceError inside the sender
    //    filter was swallowed by network-service's broadcast catch, and NONE of
    //    them arrived — for any frame — while getHAR still worked fine.
    const grantedLabels = granted.seen.map((entry) => entry.label);
    for (const name of [
      "onBeforeRequest",
      "onBeforeSendHeaders",
      "onSendHeaders",
      "onResponseStarted",
      "onCompleted",
      "onRequestFinished",
    ]) {
      assert.ok(
        grantedLabels.includes(name),
        `a subscribed frame received ${name} pushes:${dump()}`
      );
    }

    // 2. The pushes carry the app's real data, not a shape the shell invented: the
    //    url is the fake app's own, and the webRequest step and the devtools event
    //    agree on which request they describe.
    const completed = granted.seen.find((entry) => entry.label === "onCompleted");
    const finished = granted.seen.find((entry) => entry.label === "onRequestFinished");
    assert.match(completed.url, /^https:\/\/delivery-scope\.test\/live-\d+$/, dump());
    assert.strictEqual(finished.url, completed.url, "one CDP capture feeds both APIs");
    assert.match(completed.requestId, /^live-\d+$/, "the record's own CDP request id");
    assert.ok(
      granted.seen.filter((entry) => entry.label === "onCompleted").length >= 2,
      `the stream keeps arriving, so this is not one lucky message:${dump()}`
    );

    // 3. The host's own availability verdict, seen from the frame: the domain is
    //    enabled and requests are being counted. `available: false` here with the
    //    events above would mean the shell was answering from something other than
    //    the live capture.
    assert.deepStrictEqual(
      {
        available: granted.status.available,
        enableState: granted.status.enableState,
      },
      { available: true, enableState: "enabled" },
      dump()
    );
    assert.ok(
      granted.status.requests > 0 && granted.status.finished > 0,
      `the host counted the live traffic: ${dump()}`
    );

    // 4. The frame-side half of the grant gate, observed from a frame that declares
    //    nothing: its webRequest listeners are withdrawn, so it cannot receive the
    //    lifecycle even though main is pushing to entitled frames. devtools.network
    //    still works for it — Chrome needs no permission for that, and this is the
    //    Altair case delivery-scope.js exists to protect.
    assert.deepStrictEqual(
      {
        onBeforeRequest: granted.listeners.onBeforeRequest,
        onCompleted: granted.listeners.onCompleted,
      },
      { onBeforeRequest: true, onCompleted: true },
      `the granted frame's listeners stayed registered:${dump()}`
    );
    assert.deepStrictEqual(
      {
        onBeforeRequest: ungranted.listeners.onBeforeRequest,
        onSendHeaders: ungranted.listeners.onSendHeaders,
        onResponseStarted: ungranted.listeners.onResponseStarted,
        onCompleted: ungranted.listeners.onCompleted,
      },
      {
        onBeforeRequest: false,
        onSendHeaders: false,
        onResponseStarted: false,
        onCompleted: false,
      },
      `a frame without the permission has no webRequest listeners to deliver to:${dump()}`
    );
    const ungrantedLabels = new Set(ungranted.seen.map((entry) => entry.label));
    assert.ok(
      ungrantedLabels.has("onRequestFinished"),
      `chrome.devtools.network keeps working with no permissions declared:${dump()}`
    );
    const leaked = [...ungrantedLabels].filter(
      (label) => label !== "onRequestFinished" && label !== "onNavigated"
    );
    assert.deepStrictEqual(
      leaked,
      [],
      `no webRequest event reaches a frame without the permission:${dump()}`
    );

    // 5. And the delivery-scope filter ran for BOTH frames without throwing: a
    //    ReferenceError on the push path is invisible in the NDJSON by design (that
    //    is what the swallowed catch does), so the proof is that the frames' own
    //    reports arrived with real grants attached.
    assert.deepStrictEqual(granted.permissions.permissions.sort(), ["webRequest"]);
    assert.deepStrictEqual(ungranted.permissions.permissions, []);
  }
);
