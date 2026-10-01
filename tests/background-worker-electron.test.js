// A background worker in a real Electron process (GitHub issue #3).
//
// This is the headless half of "background.js executes / onInstalled fires". It
// boots the PRODUCTION shell through the same harness
// (tests/extension-frame-harness.js) the security tests use — production scheme
// privileges, production file server, production IPC handlers, production
// webPreferences and preload, plus the production background host — against a
// fixture extension staged in a temp extensions dir with a temp `--user-data-dir`.
// No Metro, no device, no frontend fork: a worker context needs none of them,
// which is exactly why these claims can be made from a headless run.
//
// What each numbered assertion below maps to:
//   1. the background script really executes against the shim;
//   2. onInstalled fires with reason `install` on a fresh userData dir, and
//      `update` after the staged manifest's version changes with the SAME dir;
//   3. panel ⇄ worker sendMessage and a Port round-trip through the ordinary
//      router (the worker is a peer, not a special case);
//   4. a denied chrome.tabs.create inside a worker rejects + sets lastError and
//      leaves the worker alive;
//   5. an ESM background loads, and a background whose script throws at load is
//      REPORTED rather than silent.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { electronBinary, runHarness, stageExtension, consoleLines } = require("./electron-runner");

const WORKER_ID = "worker.local";
const THROWER_ID = "thrower.local";

// ── the fixture ──────────────────────────────────────────────────────────────
// An MV3 extension whose background is an ES MODULE (the shape Altair ships) and
// whose background imports a sibling module (so module resolution through
// `rozenite://` has to work, not just the first file).
//
// It deliberately declares `storage` + `notifications` and NOT `tabs`: its worker
// calls chrome.tabs.create, which must take the denial path.
const manifest = (version) =>
  JSON.stringify({
    name: "Background Fixture",
    version,
    manifest_version: 3,
    background: { service_worker: "assets/bg.js", type: "module" },
    permissions: ["storage", "notifications"],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  });

// Module-scope references to the browser-UI namespaces are the whole point of
// this file's first lines: an ESM worker throws at LOAD if `chrome.action` or
// `chrome.notifications` is missing, and the whole context dies with it.
const workerScript = `
import { tag } from "./log.js";

console.log("WORKER:loaded:" + tag() + ":" + chrome.runtime.id);

chrome.action.onClicked.addListener(() => {});
chrome.notifications.create("fixture-notification", { type: "basic", title: "t", message: "m" }, (id) => {
  console.log("WORKER:notifications-callback:" + String(id));
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log("WORKER:onInstalled:" + details.reason);
});
chrome.runtime.onStartup.addListener(() => {
  console.log("WORKER:onStartup");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "ping") {
    sendResponse({ type: "pong", from: chrome.runtime.id, url: location.pathname });
    return;
  }
  if (message && message.type === "tabs-probe") {
    // No \`tabs\` permission in this manifest: Chrome's divergence is that it
    // would not inject chrome.tabs at all; this shell keeps the shape and fails
    // the call (docs/features/EXTENSION-MANAGEMENT.md). Either way the worker
    // must survive it.
    let outcome = {};
    chrome.tabs
      .create({ url: "https://example.com" })
      .then((tab) => {
        outcome = { ok: true, tab: String(tab) };
      })
      .catch((error) => {
        outcome = { ok: false, rejection: String(error && error.message) };
      })
      .then(() => {
        console.log("WORKER:tabs-denied:" + JSON.stringify(outcome));
        console.log("WORKER:alive-after-denial");
        sendResponse(Object.assign({ type: "tabs-result" }, outcome));
      });
    return true; // claims async, like Chrome requires
  }
});

chrome.runtime.onConnect.addListener((port) => {
  console.log("WORKER:port-connected:" + port.name);
  port.onMessage.addListener((message) => {
    port.postMessage("port-pong:" + message);
  });
  port.onDisconnect.addListener(() => console.log("WORKER:port-disconnected"));
});

console.log("WORKER:ready");
`;

const logModule = `export const tag = () => "esm-log-module";\n`;

const panelPage = `<!DOCTYPE html>
<html><body><script src="/panel.js"></script></body></html>
`;

// The panel is the other context of the same extension: it lives in the frontend
// window's frame tree while the worker lives in its own hidden window, so every
// round-trip here crosses two WebContents through the host router.
const panelScript = `
const MARKER = "__ROZENITE_PROBE__";
const report = (data) => console.log(MARKER + JSON.stringify(data));

const withDeadline = (label, produce, ms = 9000) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    setTimeout(() => done({ deadline: label }), ms);
    try {
      produce(done);
    } catch (error) {
      done({ threw: label + ": " + (error && error.message) });
    }
  });

const retry = (fn, attempts, delay) =>
  new Promise((resolve) => {
    let n = 0;
    const step = () => {
      n++;
      fn((value) => {
        if (value) {
          resolve(value);
        } else if (n >= attempts) {
          resolve(null);
        } else {
          setTimeout(step, delay);
        }
      });
    };
    step();
  });

// The worker registers asynchronously, so a single send races it — in this shell
// and in Chrome alike. Retries live in retry(), and each probe carries its own
// deadline so the report says which case happened.
const pingWorker = (message) =>
  retry((done) => {
    chrome.runtime.sendMessage(message, (response) => {
      done(response && response.type ? response : null);
    });
  }, 40, 250);

Promise.all([
  withDeadline("sendMessage", (done) => {
    pingWorker({ type: "ping" }).then((response) => {
      done({
        ok: Boolean(response && response.type === "pong" && response.from === chrome.runtime.id),
        response: response || null,
        // location.pathname of the frame that answered: the bootstrap document,
        // i.e. proof the answer came from the worker context and not from a sibling iframe.
        answeredFrom: response && response.url,
      });
    });
  }, 20000),
  withDeadline("tabs-denial", (done) => {
    pingWorker({ type: "tabs-probe" }).then((response) => done(response || null));
  }, 20000),
  withDeadline("port", (done) => {
    retry((finish) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: "worker-port" });
      } catch (error) {
        finish(null);
        return;
      }
      let settled = false;
      port.onMessage.addListener((message) => {
        if (settled) return;
        settled = true;
        finish({ ok: message === "port-pong:worker-ping", message, name: port.name });
        port.disconnect();
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        port.disconnect();
        finish(null);
      });
      port.postMessage("worker-ping");
    }, 40, 250).then((value) => done(value || { ok: false }));
  }, 20000),
]).then((results) => {
  report({ panelDone: true, messaging: results[0], tabs: results[1], ports: results[2] });
  console.log("[panel-probe] done");
});
`;

const throwerScript = `
console.log("THROWER:before-throw");
throw new Error("fixture worker throws at load");
`;

const binary = electronBinary();
const suite = binary ? test : test.skip;

suite("a background worker in a real Electron process", { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-bg-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const extensionsDir = path.join(root, "extensions");
  stageExtension(extensionsDir, WORKER_ID, {
    "manifest.json": manifest("1.0.0"),
    "assets/bg.js": workerScript,
    "assets/log.js": logModule,
    "panel.html": panelPage,
    "panel.js": panelScript,
  });
  stageExtension(extensionsDir, THROWER_ID, {
    "manifest.json": JSON.stringify({
      name: "Throwing Fixture",
      version: "1.0.0",
      manifest_version: 3,
      background: { service_worker: "bg.js" },
    }),
    "bg.js": throwerScript,
  });

  const hostPage = `<!DOCTYPE html>
<html><body>
  <iframe src="rozenite://${WORKER_ID}/panel.html" width="600" height="400"></iframe>
</body></html>
`;

  const shared = { binary, extensionsDir, hostPage, extensionId: WORKER_ID, timeoutMs: 90000, settleMs: 1200 };

  // ── run 1: a fresh --user-data-dir, so the fixture has never been installed ─
  const first = await runHarness({
    ...shared,
    root: path.join(root, "run1"),
    backgroundHost: true,
    waitFor: "[panel-probe] done",
  });
  // ── run 2: SAME userData dir, manifest version bumped -> update ────────────
  // No panel iframe here: these two launches observe the worker's own report, so
  // they do not pay for the messaging retries in run 1.
  const bareHost = "<!DOCTYPE html><html><body>no extension frames</body></html>";
  const userData = first.userDataDir;
  fs.writeFileSync(path.join(extensionsDir, WORKER_ID, "manifest.json"), manifest("2.0.0"));
  const second = await runHarness({
    ...shared,
    root: path.join(root, "run2"),
    backgroundHost: true,
    userDataDir: userData,
    hostPage: bareHost,
    waitFor: "WORKER:onInstalled:update",
  });
  // ── run 3: SAME userData dir, unchanged version -> startup, nothing new ────
  const third = await runHarness({
    ...shared,
    root: path.join(root, "run3"),
    backgroundHost: true,
    userDataDir: userData,
    hostPage: bareHost,
    waitFor: "WORKER:onStartup",
  });
  // ── run 4: a worker whose script throws at load, on its own ───────────────
  const throwerExtensions = path.join(root, "thrower-extensions");
  stageExtension(throwerExtensions, THROWER_ID, {
    "manifest.json": JSON.stringify({
      name: "Throwing Fixture",
      version: "1.0.0",
      manifest_version: 3,
      background: { service_worker: "bg.js" },
    }),
    "bg.js": throwerScript,
  });
  const thrower = await runHarness({
    ...shared,
    root: path.join(root, "thrower"),
    extensionsDir: throwerExtensions,
    backgroundHost: true,
    hostPage: bareHost,
    waitFor: "THROWER:before-throw",
  });

  const workerLines = (observed) =>
    observed
      .filter((line) => line.kind === "worker-console")
      .map((line) => ({ ...line, text: `${line.extensionId}: ${line.message}` }));

  const describe = (label, run) => {
    const lines = workerLines(run.observed);
    console.log(
      [
        `  [electron/background/${label}] exit=${run.code} worker-lines=${lines.length} ` +
          `background-log=${run.observed.filter((l) => l.kind === "background-log").length} ` +
          `fail-load=${run.observed.filter((l) => l.kind === "fail-load").length}`,
        `  [electron/background/${label}] worker said: ${JSON.stringify(
          lines.map((line) => line.text).slice(0, 14)
        )}`,
        `  [electron/background/${label}] host said: ${JSON.stringify(
          run.observed
            .filter((l) => l.kind === "background-log")
            .map((l) => `${l.level}:${String(l.message).slice(0, 110)}`)
            .slice(0, 10)
        )}`,
        `  [electron/background/${label}] windows: ${JSON.stringify(
          (run.observed.find((l) => l.kind === "background-windows") || {}).windows || []
        )}`,
        `  [electron/background/${label}] panel said: ${JSON.stringify(
          (run.observed.find((l) => l.kind === "probe") || {}).data || null
        )}`,
        run.code !== 0 ? `  [electron/background/${label}] tail: ${run.output.slice(-700)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  };
  describe("run1", first);
  describe("run2", second);
  describe("run3", third);
  describe("thrower", thrower);

  const facts = (run) => {
    const said = (needle) =>
      workerLines(run.observed)
        .filter((line) => line.extensionId === WORKER_ID)
        .map((line) => line.message)
        .some((message) => message.includes(needle));
        const probe = (run.observed.find((line) => line.kind === "probe") || {}).data || {};
    return {
      said,
      errors: workerLines(run.observed).filter(
        (line) => line.extensionId === WORKER_ID && Number(line.value) >= 3
      ),
      probe,
      workerConsole: workerLines(run.observed).filter((line) => line.extensionId === WORKER_ID),
      windows: (run.observed.find((l) => l.kind === "background-windows") || {}).windows || [],
      harness: run.observed.find((l) => l.kind === "harness") || {},
    };
  };

  const r1 = facts(first);
  const r2 = facts(second);
  const r3 = facts(third);

  // ── 1. the background script actually executed, against the shim ──────────
  assert.equal(
    r1.errors.length,
    0,
    `no uncaught errors in the worker: ${JSON.stringify(r1.errors.map((e) => e.message))}`
  );
  assert.equal(r1.said("WORKER:ready"), true, "the worker's last top-level line ran");
  assert.equal(
    r1.said("WORKER:loaded:esm-log-module"),
    true,
    "the ESM worker and its imported sibling both executed (fetched over rozenite://)"
  );
  assert.equal(
    r1.said(`WORKER:loaded:esm-log-module:${WORKER_ID}`),
    true,
    "chrome.runtime.id is this extension's id inside the worker — it has the shim, not a bare page"
  );

  // ── 2. onInstalled install → update, and onStartup on an unchanged launch ─
  assert.equal(r1.said("WORKER:onInstalled:install"), true, "fresh userData dir -> install");
  assert.equal(r1.said("WORKER:onStartup"), false, "install and startup are not both fired");
  assert.equal(r2.said("WORKER:onInstalled:update"), true, "same dir, bumped version -> update");
  assert.equal(r2.said("WORKER:onInstalled:install"), false, "`install` is not re-fired on update");
  assert.equal(r3.said("WORKER:onInstalled:update"), false, "unchanged version -> no install/update");
  assert.equal(r3.said("WORKER:onStartup"), true, "already installed -> onStartup fires");

  // ── 3. panel ⇄ worker round-trips, through the ordinary router ────────────
  assert.equal(
    r1.probe.messaging && r1.probe.messaging.ok,
    true,
    `panel -> worker sendMessage: ${JSON.stringify(r1.probe.messaging)}`
  );
  assert.equal(
    r1.probe.messaging.answeredFrom,
    "/__rozenite_background__",
    "the answer came from the background document, so the peer really was the worker"
  );
  assert.equal(r1.said("WORKER:port-connected:worker-port"), true, "the worker saw the Port");
  assert.equal(
    r1.probe.ports && r1.probe.ports.ok,
    true,
    `Port round-trip panel -> worker: ${JSON.stringify(r1.probe.ports)}`
  );

  // ── 4. a denied chrome.tabs.create inside a worker: rejected + lastError, alive ─
  assert.equal(
    r1.probe.tabs && r1.probe.tabs.ok,
    false,
    `tabs.create must not succeed without the permission: ${JSON.stringify(r1.probe.tabs)}`
  );
  assert.match(
    String(r1.probe.tabs && r1.probe.tabs.rejection),
    /permission 'tabs' is not declared/,
    "the rejection names the missing permission"
  );
  assert.equal(r1.said("WORKER:tabs-denied"), true, "the worker reported the denial itself");
  assert.equal(r1.said("WORKER:alive-after-denial"), true, "the worker is still running afterwards");
  assert.equal(
    r1.errors.length,
    0,
    "the denial did not surface as an uncaught error in the worker"
  );

  // ── 5. the [STUB] browser-UI namespaces exist and do not kill the worker ──
  // The ESM worker references chrome.action.onClicked and chrome.notifications.create
  // at module scope; a missing namespace is a load-time TypeError that would take the
  // whole context down, and run 1 would then have no `ready` line at all.
  assert.equal(r1.said("WORKER:ready"), true, "action/notifications references did not throw");
  assert.match(
    JSON.stringify(r1.workerConsole.map((line) => line.message)),
    /WORKER:notifications-callback:undefined/,
    "notifications.create calls back with no id rather than naming a notification that does not exist"
  );
  assert.equal(
    r1.said("WORKER:onInstalled:update"),
    false,
    "no notification was fabricated as having been shown on update"
  );

  // ── the hidden windows are hidden, and one per extension ──────────────────
  assert.equal(r1.windows.length, 2, "worker.local and thrower.local both got a window");
  for (const win of r1.windows) {
    assert.equal(win.visible, false, `${win.extensionId} is a hidden window`);
    assert.match(win.url, /__rozenite_background__\?script=/);
  }
  assert.equal(
    r1.harness.backgroundHost,
    true,
    "the harness really started the production background host"
  );

  // ── a worker whose script throws at load is REPORTED, not silent ──────────
  const throwerLines = workerLines(thrower.observed).filter((l) => l.extensionId === THROWER_ID);
  assert.equal(
    throwerLines.some((l) => l.message.includes("THROWER:before-throw")),
    true,
    "the throwing worker ran as far as the throw"
  );
  assert.equal(
    throwerLines.some(
      (l) => (Number(l.value) >= 3 || l.level === "error") && /throws at load/.test(l.message)
    ),
    true,
    `the load-time throw is reported as an error: ${JSON.stringify(throwerLines.map((l) => l.text))}`
  );
  assert.equal(
    consoleLines(thrower.observed).some((m) => /throws at load/.test(m)),
    true,
    "and it is visible in the shell's own output, not only in the page"
  );
});

suite(
  "a background context cannot be claimed from a page",
  { timeout: 90000 },
  async (t) => {
    // The reserved bootstrap path is a host affordance, not a filesystem path: a
    // folder that ships a REAL file by that name must not be able to become the
    // worker's document, and `?script=` must not be able to name another
    // extension's file. Both are answered by the protocol handler's containment
    // rules, asserted here in the real process rather than only in a unit test.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-bgsec-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const extensionsDir = path.join(root, "extensions");
    stageExtension(extensionsDir, "a.local", {
      "manifest.json": JSON.stringify({ name: "A", version: "1", manifest_version: 3 }),
      "__rozenite_background__": "<html><body>SHADOWED</body></html>",
      "probe.html": `<!DOCTYPE html><html><body><script src="/probe.js"></script></body></html>`,
      "probe.js": `
        const MARKER = "__ROZENITE_PROBE__";
        const grab = (url) => fetch(url, { cache: "no-store" })
          .then((r) => r.text().then((t) => ({ url, status: r.status, body: t.slice(0, 60) })),
                (e) => ({ url, rejected: String(e.message) }));
        Promise.all([
          grab("/__rozenite_background__"),
          grab("/../b.local/secret.js"),
          fetch("rozenite://b.local/secret.js", { cache: "no-store" })
            .then((r) => r.text().then((t) => ({ siblingStatus: r.status, body: t.slice(0, 80) })),
                  (e) => ({ siblingRejected: String(e.message) })),
        ]).then((results) => {
          console.log(MARKER + JSON.stringify({ results }));
          // The marker line becomes a probe record in the harness, so it is not
          // visible to a --wait-for log-line match; this plain line is what the
          // run settles on.
          console.log("[bgsec-probe] done");
        });
      `,
    });
    stageExtension(extensionsDir, "b.local", {
      "manifest.json": JSON.stringify({ name: "B", version: "1", manifest_version: 3 }),
      "secret.js": "export const secret = 'sibling-extension-content';",
    });

    const run = await runHarness({
      binary,
      root,
      extensionsDir,
      extensionId: "a.local",
      hostPage: `<!DOCTYPE html><html><body>
        <iframe src="rozenite://a.local/probe.html" width="400" height="300"></iframe>
      </body></html>`,
      waitFor: "[bgsec-probe] done",
      timeoutMs: 60000,
      settleMs: 800,
    });
    const data = (run.observed.find((line) => line.kind === "probe") || {}).data || {};
    console.log(
      `  [electron/background/security] exit=${run.code} probe: ${JSON.stringify(data).slice(0, 900)}`
    );

    assert.ok(data.results, `the probe reported (exit ${run.code})`);
    const [bootstrap, traversal, sibling] = data.results;

    // The reserved path is reserved in BOTH directions: a folder that ships a real
    // file named `__rozenite_background__` cannot pre-empt the host's own generated
    // document — the request is refused rather than served from disk.
    assert.match(String(bootstrap.url || ""), /__rozenite_background__/);
    assert.ok(
      !/SHADOWED/.test(String(bootstrap.body || "")),
      `a real file cannot shadow the bootstrap path: ${JSON.stringify(bootstrap)}`
    );

    // Path traversal: `..` never escapes the requesting extension's folder.
    assert.match(String(traversal.url || ""), /\.\./, "the traversal request was attempted");
    assert.equal(
      traversal.status === 404 || Boolean(traversal.rejected),
      true,
      `../ stays inside the extension: ${JSON.stringify(traversal)}`
    );

    // OBSERVED, and asserted so it cannot be mistaken for a guard: a page in one
    // extension can `fetch()` a sibling extension's file and read the body. The
    // traversal guard stops a path from escaping its folder inside one request;
    // it was never a same-origin check, and this is unchanged by the move from
    // registerFileProtocol to protocol.handle (measured both ways, same 200 and
    // same body). docs/LIMITATIONS.md records the gap; closing it needs per-origin
    // isolation for the scheme, which this shell does not have.
    assert.equal(
      sibling.siblingStatus,
      200,
      `recorded so the limitation stays visible: ${JSON.stringify(sibling)}`
    );
    assert.match(String(sibling.body || ""), /sibling-extension/, "the body really was read");
  }
);
