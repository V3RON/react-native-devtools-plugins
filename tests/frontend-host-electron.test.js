// The frontend-only IPC channels in a REAL Electron process (tests/frontend-host-harness.js):
// production preload + IPC handlers + dispatch channel + src/main/frontend-frame.js, with
// loopback pages standing in for the frontend and for "somewhere else".
//
// What only a real process can prove:
//   - a dispatched event reaches window.InspectorFrontendAPI WITH its arguments (Electron's
//     executeInMainWorld takes `args`; any other key silently runs the function with none);
//   - the frontend's main frame can open/save/read config, and nothing else can: not an
//     iframe of the frontend, not a main frame on another origin with the same preload, not
//     the frontend window itself once it has been navigated away.
// Seams: DEVTOOLS_TEST_OPEN_LOG / DEVTOOLS_TEST_SAVE_DIALOG, so no browser and no dialog.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { electronBinary, readLines } = require("./electron-runner");

const binary = electronBinary();
const suite = binary ? test : test.skip;

const run = () =>
  new Promise((resolve) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-host-"));
    const out = path.join(root, "observed.ndjson");
    const saved = path.join(root, "saved");
    const openLog = path.join(root, "open.log");
    fs.mkdirSync(saved);
    const child = spawn(
      binary,
      [path.join(__dirname, "frontend-host-harness.js"), `--out=${out}`, `--user-data-dir=${path.join(root, "ud")}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // ELECTRON_RUN_AS_NODE stripped for the reason tests/electron-runner.js spells out.
        env: {
          ...process.env,
          DEVTOOLS_TEST_OPEN_LOG: openLog,
          DEVTOOLS_TEST_SAVE_DIALOG: saved,
          ELECTRON_RUN_AS_NODE: undefined,
        },
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", () => {
      clearTimeout(timer);
      const [result] = readLines(out);
      resolve({
        result,
        output: output.slice(-3000),
        opened: fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf8").trim().split("\n") : [],
        saved: fs.readdirSync(saved),
        savedText: (name) => fs.readFileSync(path.join(saved, name), "utf8"),
      });
    });
  });

suite("the frontend-only channels accept the frontend's main frame and nothing else", async () => {
  const { result, output, opened, saved, savedText } = await run();
  assert.ok(result, `the harness reported nothing:\n${output}`);
  assert.strictEqual(result.harnessError, undefined, result.harnessError);

  // 1. dispatch carries its arguments
  assert.deepStrictEqual(result.dispatched, [["savedURL", "u", "p"]]);

  // 2. the frontend itself: https opened, file: refused, save written and answered
  assert.ok(opened.includes("https://example.com/from-frontend"), `opened: ${opened}`);
  assert.ok(!opened.some((url) => url.startsWith("file:")), "a file: URL never reaches the opener");
  assert.deepStrictEqual(saved.filter((name) => name === "f.txt"), ["f.txt"]);
  assert.strictEqual(savedText("f.txt"), "hello");
  assert.ok(
    result.afterSave.some((event) => event[0] === "savedURL" && event[1] === "f.txt" && /f\.txt$/.test(event[2])),
    JSON.stringify(result.afterSave)
  );
  assert.strictEqual(result.hostConfigA.aidaAvailability.enabled, false);

  // 3. frame identity, decided by frame
  assert.strictEqual(result.mainAccepted, true);
  assert.strictEqual(result.childFrameFound, true);
  assert.strictEqual(result.childAccepted, false, "an iframe of the frontend is not the frontend");
  assert.strictEqual(result.nullFrameAccepted, false);
  assert.strictEqual(result.noEventAccepted, false);

  // 4. a main frame on another origin with the same preload is refused end to end
  assert.ok(!opened.includes("https://example.com/from-other-origin"));
  assert.ok(!saved.includes("evil.txt"));
  // Changed by F4, and stronger for it. This used to assert `{}` — the stranger's call
  // reached HOST_CONFIG and was refused there. Now the stranger never gets the surface to
  // call with (src/preload/index.js installs it only for the frontend's own origin), so the
  // page has nothing to invoke. The channel-level refusal is still asserted for the exact
  // same frame below (strangerRefused.hostConfig), so nothing about the gate's behavior
  // stopped being checked; what changed is that the surface it protected is also gone.
  assert.strictEqual(result.hostConfigB, "no surface", "a stranger has no host surface at all");
  assert.deepStrictEqual(
    result.surfaceOnOtherOrigin,
    ["undefined", "undefined"],
    "the F4 window shape: a main frame, the production preload, not the frontend's origin — " +
      "no InspectorFrontendHost and no chrome.*"
  );

  // 4b. the nine channels at the channel boundary, in a real process: the SAME handlers the
  // renderer's `invoke` reaches, called with events built from real frames of real windows.
  // This is the criterion "the nine channels refuse a non-frontend sender", for real: the
  // production electron-store on disk is what proves a refusal is not just a return value.
  const REFUSED = { ok: false, error: "not the DevTools frontend" };
  assert.deepStrictEqual(result.strangerRefused.set, REFUSED, "PREF_SET from a stranger is refused");
  assert.deepStrictEqual(result.strangerRefused.getAll, REFUSED, "PREF_GET_ALL too");
  assert.deepStrictEqual(result.strangerRefused.clear, REFUSED, "and PREF_CLEAR");
  assert.deepStrictEqual(
    result.strangerRefused.childFrame,
    REFUSED,
    "an iframe of the frontend is not the frontend either"
  );
  assert.deepStrictEqual(
    result.strangerRefused.hostConfig,
    {},
    "the already-gated control answers a stranger with the frontend's own 'nothing configured' " +
      "shape (HOST_CONFIG's pre-existing refusal, unchanged here) — the nine now refuse on the " +
      "same rule, and report it as a refusal because their callers are fire-and-forget"
  );
  assert.strictEqual(
    result.strangerRefused.storeUnchanged,
    true,
    `the persisted store did not move: ${result.strangerRefused.storeText}`
  );
  assert.ok(
    !/f4Stolen/.test(result.strangerRefused.storeText),
    "no preference the stranger wrote reached the file"
  );
  // ...and the frontend's own main frame still gets through the same handler: without this,
  // every refusal above would only prove the handlers are broken.
  assert.strictEqual(result.frontendAccepted.set, undefined, "PREF_SET returns nothing, as it always did");
  assert.strictEqual(result.frontendAccepted.storeChanged, true, "and it really wrote");
  // The store file is pretty-printed, so match the pair rather than its exact bytes.
  assert.match(result.frontendStoreText, /"f4Mine":\s*"written-by-the-frontend"/);
  assert.strictEqual(result.frontendSurface, "object", "the frontend keeps its host surface");

  // 5. a navigated-away frontend: the guard holds the URL, and the origin check holds
  //    when something gets past the guard
  assert.strictEqual(result.reloaded, true, "the navigation guard leaves a reload alone");
  assert.match(result.urlAfterNavigationAttempt, /\/frontend\.html$/, "will-navigate denied the move");
  assert.strictEqual(result.originAfterLoad, true);
  assert.strictEqual(result.movedMainAccepted, false);
  assert.ok(!opened.includes("https://example.com/from-navigated-away"));
  assert.ok(!saved.includes("moved.txt"));
  // F4's other half in the same window: once the main frame is off the frontend's origin,
  // the preload installs nothing there either, so the page cannot even try those channels.
  assert.strictEqual(
    result.surfaceAfterLoad,
    "undefined",
    "the navigated-away document has no host surface — the identity check, not just the guard"
  );

  // 6. chrome.tabs.create's open policies, through the real attachTabHost wiring: both
  //    decide with the same allowlist and refuse with the same message (F6).
  assert.strictEqual(result.tabsHttps.via, "external");
  assert.ok(opened.includes("https://example.com/from-tabs"));
  assert.match(result.tabsFile, /^rejected: refused to open a URL that is not http\(s\)/);
  assert.strictEqual(result.windowHttps.via, "window", "https opens in a shell window");
  assert.strictEqual(
    result.windowRozenite.via,
    "window",
    "an extension page of this shell's own scheme still opens — Altair's create of its own app page"
  );
  assert.match(result.windowFile, /^rejected: refused to open a URL that is not http\(s\)/);
  assert.strictEqual(
    result.windowFile,
    result.tabsFile,
    "one refusal message for one URL, whichever policy is set"
  );
  assert.deepStrictEqual(
    result.windowLoaded,
    ["https://example.com/from-tabs", "rozenite://probe.local/index.html"],
    "the refused file: URL never reached the window"
  );

  // 7. WINDOW_CLOSE from a stranger is refused, and the frontend window is still standing —
  //    which is the damage that used to be reachable from any frame with a preload.
  assert.deepStrictEqual(result.strangerClose, REFUSED, "a stranger cannot close the DevTools window");
  assert.strictEqual(result.frontendWindowAlive, true, "and it really did not close it");
});
