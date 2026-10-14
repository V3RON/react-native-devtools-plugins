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
        env: { ...process.env, DEVTOOLS_TEST_OPEN_LOG: openLog, DEVTOOLS_TEST_SAVE_DIALOG: saved },
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
  assert.deepStrictEqual(result.hostConfigB, {}, "getHostConfig answers nothing to a stranger");

  // 5. a navigated-away frontend: the guard holds the URL, and the origin check holds
  //    when something gets past the guard
  assert.strictEqual(result.reloaded, true, "the navigation guard leaves a reload alone");
  assert.match(result.urlAfterNavigationAttempt, /\/frontend\.html$/, "will-navigate denied the move");
  assert.strictEqual(result.originAfterLoad, true);
  assert.strictEqual(result.movedMainAccepted, false);
  assert.ok(!opened.includes("https://example.com/from-navigated-away"));
  assert.ok(!saved.includes("moved.txt"));

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
});
