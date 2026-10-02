// The security claims of the extension-frame layer, asserted in a real Electron
// process (GitHub issue #6). Everything tests/security.test.js checks is source
// text; this file starts the production shell headless — production scheme
// privileges, file server, IPC handlers, webPreferences and preload — and asks a
// real `rozenite://…` frame what it can actually reach.
//
// Why this file exists: every guarantee below is the kind that survives a
// refactor only if something asserts it, and "the page world has no ipcRenderer"
// is exactly the claim a comment cannot defend. It has already earned its keep:
// the first run exposed that main's frame addressing dropped every router
// delivery, and that an early `port.postMessage` was silently lost (see
// tests/messaging-frames.test.js).
//
// The harness (tests/extension-frame-harness.js) runs as a child Electron
// process with `show: false`: no visible window, no Metro, no device, no CDP
// bridge. If Electron cannot start, the suite skips with the reason in the
// NDJSON log rather than pretending to have verified.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const HARNESS = path.join(__dirname, "extension-frame-harness.js");
const FIXTURE = path.join(__dirname, "fixtures", "hardening-probe");

// The fixture folder is named `hardening-probe` but must be served under a
// hostname that cannot collide with a real extension folder. The shell's
// extension id IS the URL hostname, so it is staged under `probe.local`.
const EXTENSION_ID = "probe.local";
// The host page's own policy, deliberately different from the extension's, so
// "the extension's CSP applied" is distinguishable from "no CSP applied".
const HOST_CSP =
  "script-src 'self' https://127.0.0.1:9999; object-src 'self'; style-src 'unsafe-inline'";

// Electron ships in devDependencies; resolve its binary without adding anything.
const electronBinary = () => {
  try {
    const resolved = require("electron");
    return typeof resolved === "string" ? resolved : null;
  } catch {
    return null;
  }
};

const readLines = (out) => {
  try {
    return fs
      .readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { kind: "unparseable", line: line.slice(0, 300) };
        }
      });
  } catch {
    return [];
  }
};

/**
 * Run the production shell headless against `extensionsDir`, hosting whatever
 * `hostPage` says. The host page is generated here (never committed) because the
 * frontend's real role in this story is only "an http:// document that embeds a
 * rozenite:// iframe".
 */
const runHarness = ({
  binary,
  root,
  extensionsDir,
  hostPage,
  page = "host.html",
  waitFor = "",
  timeoutMs = 45000,
  settleMs = 900,
}) => {
  const hostDir = path.join(root, "frontend");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, page), hostPage);
  fs.mkdirSync(root, { recursive: true });

  const out = path.join(root, "observed.ndjson");
  fs.writeFileSync(out, "");
  const args = [
    HARNESS,
    `--extensions-dir=${extensionsDir}`,
    `--host-dir=${hostDir}`,
    `--out=${out}`,
    `--user-data-dir=${path.join(root, "userData")}`,
    `--page=${page}`,
    `--timeout=${Math.floor(timeoutMs / 2)}`,
    `--settle=${settleMs}`,
  ];
  if (waitFor) {
    args.push(`--wait-for=${waitFor}`);
  }

  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, output: output.slice(-4000), out });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: "timeout", observed: readLines(out) });
    }, timeoutMs);
    child.on("close", (code) => finish({ code, observed: readLines(out) }));
  });
};

const fixtureHostPage = `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="${HOST_CSP}" />
  </head>
  <body>
    <!-- Two sibling extension frames, as the real frontend hosts a devtools page
         and a panel: the probe sends, this extension's other frame answers, so a
         round-trip crosses two frames through the host router. -->
    <iframe src="rozenite://${EXTENSION_ID}/probe.html" width="500" height="300"></iframe>
    <iframe src="rozenite://${EXTENSION_ID}/peer.html" width="100" height="100"></iframe>
  </body>
</html>
`;

const binary = electronBinary();
const suite = binary ? test : test.skip;

suite(
  "extension frames in a real Electron process",
  { timeout: 120000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-frame-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    // ── arm 1: the permission-free fixture, in a temp extensions dir ───────
    const extensionsDir = path.join(root, "extensions");
    const extensionRoot = path.join(extensionsDir, EXTENSION_ID);
    fs.mkdirSync(extensionRoot, { recursive: true });
    for (const file of fs.readdirSync(FIXTURE)) {
      fs.copyFileSync(path.join(FIXTURE, file), path.join(extensionRoot, file));
    }

    const run = await runHarness({
      binary,
      root: path.join(root, "fixture"),
      extensionsDir,
      hostPage: fixtureHostPage,
    });
    const { code, observed } = run;
    const probeReports = observed.filter((line) => line.kind === "probe");
    const harness = observed.find((line) => line.kind === "harness");
    const frames = observed.find((line) => line.kind === "frames");
    const consoleLines = observed.filter((line) => line.kind === "console");
    const loadFailures = observed.filter((line) => line.kind === "fail-load");
    const preloadErrors = observed.filter((line) => line.kind === "preload-error");
    const report = probeReports
      .filter((line) => line.data && line.data.nodeSurface)
      .map((line) => line.data)[0];
    const peerReports = probeReports.filter((line) => line.data && line.data.registered);

    // One honest dump: a passing assertion here is otherwise invisible to whoever
    // changes this next, and "what did the page actually say" is the whole point.
    console.log(
      [
        `  [electron/fixture] exit=${code} probes=${probeReports.length} ` +
          `console=${consoleLines.length} fail-load=${loadFailures.length} ` +
          `preload-errors=${preloadErrors.length}`,
        `  [electron/fixture] frame tree: ${JSON.stringify(frames ? frames.frames : [])}`,
        `  [electron/fixture] served CSP: ${JSON.stringify(harness ? harness.servedCsp : null)}`,
        `  [electron/fixture] probe said: ${JSON.stringify(report || null)}`,
        `  [electron/fixture] page errors: ${JSON.stringify(
          consoleLines
            .filter((line) => line.level >= 2)
            .map((line) => line.message.slice(0, 130))
        )}`,
        code !== 0 ? `  [electron/fixture] output tail: ${run.output.slice(-700)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );

    assert.equal(preloadErrors.length, 0, "the production preload ran without error");
    assert.ok(harness, "the harness reported its configuration");
    assert.ok(report, `the probe frame reported (exit ${code}); no probe record observed`);

    // ── the frame loaded at all, under the narrowed preferences ─────────────
    assert.equal(
      loadFailures.filter((line) => String(line.validatedURL).startsWith("rozenite://")).length,
      0,
      "rozenite:// frames load with webSecurity on"
    );
    assert.match(report.url, new RegExp(`^rozenite://${EXTENSION_ID.replace(".", "\\.")}/`));
    const { preload, ...prefs } = harness.preferences;
    assert.equal(preload, "<production preload>", "the harness loaded the production preload");
    assert.deepStrictEqual(prefs, {
      nodeIntegrationInSubFrames: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: false,
    });

    // ── no Node / Electron surface in the page world ───────────────────────
    for (const [name, kind] of Object.entries(report.nodeSurface)) {
      assert.equal(kind, "undefined", `window.${name} is not reachable in the page world`);
    }
    for (const [name, kind] of Object.entries(report.bareIdentifiers)) {
      assert.equal(kind, "undefined", `bare \`${name}\` does not resolve in the page world`);
    }

    // ── chrome.* keeps Chrome's shape ─────────────────────────────────────
    for (const namespace of ["runtime", "storage", "devtools", "tabs", "webRequest"]) {
      assert.ok(report.chrome.namespaces.includes(namespace), `chrome.${namespace} exists`);
    }
    assert.ok(
      report.chrome.runtime.every((entry) => !entry.endsWith(":undefined")),
      `chrome.runtime members exist: ${report.chrome.runtime.join(",")}`
    );
    for (const member of ["panels", "network", "inspectedWindow"]) {
      assert.ok(report.chrome.devtools.includes(member), `chrome.devtools.${member} exists`);
    }
    assert.equal(report.chrome.id, EXTENSION_ID, "runtime.id === the URL hostname");

    // ── declared permissions gate real capability ─────────────────────────
    // This fixture declares NO permissions, so every gated API must fail.
    assert.match(
      report.storageDenied,
      /permission 'storage' is not declared/,
      `chrome.storage without the permission: ${report.storageDenied}`
    );
    assert.match(
      report.tabsDenied,
      /permission 'tabs' is not declared/,
      `chrome.tabs without the permission: ${report.tabsDenied}`
    );
    // A denied webRequest listener is registered and then withdrawn, so nothing can
    // reach it. `hasListeners()` is the observable (not `hasListener(fn)`): the chrome
    // namespace crosses contextBridge, which clones the callback, so a page-world
    // function is never the identity the shim stored — measured on Electron 38 and
    // documented as a deviation in docs/features/RUNTIME-MESSAGING.md. Data could not
    // arrive in the window either way: main only starts pushing network deliveries
    // after RUNTIME_REGISTER is answered, and the revocation is queued off that
    // same reply.
    assert.deepStrictEqual(
      report.webRequestListener,
      { settled: false },
      `webRequest listener is registered and then withdrawn on denial: ` +
        JSON.stringify(report.webRequestListener)
    );

    // ── the CSP header the manifest says, and nothing weaker ───────────────
    assert.deepStrictEqual(harness.servedCsp, {
      value: "script-src 'self'; object-src 'self'",
      source: "manifest",
    });
    assert.equal(
      report.cspHeader,
      "script-src 'self'; object-src 'self'",
      "the page itself reads back the header this extension's manifest produced"
    );
    assert.doesNotMatch(
      report.cspHeader || "",
      /unsafe-inline|9999/,
      "the HOST page's policy is not the extension's policy"
    );
    assert.equal(
      report.inlineScriptRan,
      false,
      "inline scripts are refused under the served policy"
    );

    // ── messaging still round-trips (two frames, through the host router) ─
    assert.equal(peerReports.length > 0, true, "the extension's second frame registered");
    assert.equal(
      report.messaging && report.messaging.ok,
      true,
      `sendMessage across two frames: ${JSON.stringify(report.messaging)}`
    );
    assert.equal(
      report.ports && report.ports.ok,
      true,
      `Port round-trip: ${JSON.stringify(report.ports)}`
    );

    // ── arm 2: the SHIPPED sample extension, same shell ────────────────────
    // The fixture shows what a permission-free extension sees. This shows the
    // extension the README tells people to load still works under the narrowed
    // preferences and its own declared permissions — using the checks in
    // panel.html, the ones an extension author actually runs.
    const shipped = await runHarness({
      binary,
      root: path.join(root, "shipped"),
      extensionsDir: path.join(REPO, "extensions"),
      hostPage: `<!DOCTYPE html>
<html><body>
  <iframe src="rozenite://sample-extension/panel.html" width="900" height="700"></iframe>
</body></html>
`,
      // The panel prints one [check] line per assertion and announces when the
      // half that needs no attached app is over; the rest waits on a live RN app.
      waitFor: "[panel-checks] shell half done",
      timeoutMs: 60000,
      settleMs: 500,
    });
    const shippedLines = shipped.observed
      .filter((line) => line.kind === "console")
      .map((line) => line.message);
    const passed = shippedLines.filter((m) => m.startsWith("[check] PASS ")).map((m) => m.slice(13));
    const failed = shippedLines
      .filter((m) => m.startsWith("[check] FAIL "))
      .map((m) => m.slice(13).split(":")[0]);
    const shippedFrames = (shipped.observed.find((line) => line.kind === "frames") || {}).frames;

    console.log(
      [
        `  [electron/sample] exit=${shipped.code} pass=${passed.length} fail=${failed.length}`,
        `  [electron/sample] PASS: ${passed.join(" | ")}`,
        `  [electron/sample] FAIL: ${failed.join(" | ") || "none"}`,
        `  [electron/sample] frames: ${JSON.stringify(shippedFrames || [])}`,
        `  [electron/sample] load/preload problems: ${JSON.stringify(
          shipped.observed
            .filter((line) => line.kind === "preload-error" || line.kind === "fail-load")
            .map((line) => line.message || `${line.errorCode} ${line.validatedURL}`)
        )}`,
        `  [electron/sample] NOT asserted here (needs a live RN app on the CDP bridge): ` +
          `inspectedWindow.eval, and the devtools.network/webRequest checks that wait ` +
          `for app traffic. Last panel lines: ${JSON.stringify(
            shippedLines.filter((m) => m.startsWith("[check]") || m.startsWith("[panel-checks]")).slice(-1)
          )}`,
      ].join("\n")
    );

    assert.equal(
      shipped.observed.filter((line) => line.kind === "preload-error").length,
      0,
      "the sample extension's frames load the production preload without error"
    );
    assert.equal(
      shippedFrames && shippedFrames.some((frame) => frame.url.startsWith("rozenite://sample-extension/")),
      true,
      "the shipped sample-extension panel loads under webSecurity: true"
    );
    for (const name of [
      "no Node surface in the page world",
      "chrome.* has the expected namespaces",
      "manifest CSP is enforced on this frame",
      "runtime identity",
      "sendMessage round-trip (promise)",
      "sendMessage round-trip (callback)",
      "async sendResponse (return true)",
      "Port round-trip",
      "declared permission buys a working chrome.storage call",
      "declared permission lets a webRequest listener register",
      "a declared permission does not produce a permission error",
    ]) {
      assert.equal(
        failed.includes(name),
        false,
        `sample-extension check failed in the real shell: ${name}`
      );
      assert.equal(
        passed.includes(name),
        true,
        `sample-extension check never reported PASS: ${name}`
      );
    }
  }
);

test("the harness records the frame tree so isolation claims stay measurable", () => {
  // Not a guarantee — a record. While sandbox is false the extension frame is a
  // separate renderer process but not a sandboxed one, and this test exists so
  // the docs cannot quietly start describing more than that.
  const source = fs.readFileSync(HARNESS, "utf8");
  assert.match(source, /framesInSubtree/);
  assert.match(source, /separateProcess/);
});
