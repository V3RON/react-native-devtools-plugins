// The Tier-2 shims inside a REAL background worker (GitHub issue #4).
//
// The unit suites cover the rules; this file covers the claims that only a real
// process can make, because each one depends on a path a unit test fakes:
//
//   1. `chrome.notifications` gating across the process boundary — a worker whose
//      manifest does not declare `notifications` gets lastError and no id, and main
//      is never even asked to show one.
//   2. `chrome.alarms` really schedules a timer in the worker's own context, and its
//      `scheduledTime` is the moment Chrome would have fired — i.e. `create` was
//      judged by Chrome's real 30-second floor — while only the WAIT was shortened by
//      the host's clock scale. `clear` really stops an alarm.
//   3. `runtime.openOptionsPage()` opens a window for an extension that declares
//      `options_ui`, over the extension's own URL, and the page that loads there has a
//      working `chrome.*`; an extension that declares none is refused, naming its id.
//   4. `chrome.downloads` is gated in MAIN as well as in the frame, and a granted save
//      writes real bytes into the directory the host was configured with.
//
// Two rules the harness keeps so this stays a suite and not an interruption: the save
// dialog is answered by the harness and the filesystem writes go to the run's temp
// dir (--downloads-dir), and the options window is a hidden one. See
// tests/extension-frame-harness.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { electronBinary, runHarness, stageExtension } = require("./electron-runner");

const binary = electronBinary();
const suite = binary ? test : test.skip;

const TIER2_ID = "tier2.local";
const NO_OPTIONS_ID = "no-options.local";

const manifest = (options = {}) =>
  JSON.stringify({
    name: "Tier2 Fixture",
    version: "1.0.0",
    manifest_version: 3,
    background: { service_worker: "bg.js" },
    ...(options.permissions && options.permissions.length ? { permissions: options.permissions } : {}),
    ...(options.optionsUi
      ? {
          options_ui: {
            page: "options.html",
            ...(options.openInTab ? { open_in_tab: true } : {}),
          },
        }
      : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  });

// One worker that exercises all four claims and prints one line per result. Each
// probe is wrapped so a missing namespace fails an assertion rather than throwing the
// worker down before the other probes report.
const workerScript = `
const report = (line) => console.log("TIER2:" + line);

// ── 1. notifications: the manifest says no, so nothing is shown or named ───
try {
  chrome.notifications.create("tier2-notification", { type: "basic", title: "t", message: "m" }, (id) => {
    report("notifications-callback:" + String(id) + ":lastError=" + String(chrome.runtime.lastError && chrome.runtime.lastError.message));
  });
  chrome.notifications.create("tier2-promise", { type: "basic", title: "t", message: "m" })
    .then((id) => report("notifications-resolved:" + String(id)))
    .catch((error) => report("notifications-rejected:" + String(error && error.message)));
} catch (error) {
  report("notifications-threw:" + String(error && error.message));
}

// ── 2. alarms: a real timer, in this context, judged by Chrome's floors ─────
try {
  const created = Date.now();
  // 0.5 min is Chrome's own 30-second floor, so create() is accepted for the same
  // reason Chrome accepts it. The host's clock scale shortens only the WAIT.
  chrome.alarms.create("tick-once", { delayInMinutes: 0.5 });
  chrome.alarms.create("later-one", { delayInMinutes: 2 });
  let fired = 0;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "tick-once") {
      report("alarm-should-not-fire:" + alarm.name);
      return;
    }
    fired++;
    report("alarm-fired:" + alarm.name + ":fired=" + fired +
      ":scheduledTime=" + alarm.scheduledTime + ":created=" + created + ":now=" + Date.now());
    chrome.alarms.getAll((all) =>
      report("alarm-list:" + JSON.stringify(all.map((a) => ({ name: a.name, period: a.periodInMinutes === undefined ? "none" : a.periodInMinutes }))))
    );
  });
  setTimeout(() => {
    chrome.alarms.clear("later-one", (wasCleared) => report("alarm-cleared:" + String(wasCleared)));
    chrome.alarms.clear("later-one", (again) => report("alarm-clear-again:" + String(again)));
  }, 600);
  setTimeout(() => chrome.alarms.clearAll((count) => report("alarm-cleared-all:" + String(count))), 1500);
} catch (error) {
  report("alarms-threw:" + String(error && error.message));
}

// ── 3. openOptionsPage: this manifest declares no options_ui ───────────────
try {
  chrome.runtime.openOptionsPage()
    .then(() => report("options-resolved"))
    .catch((error) => report("options-rejected:" + String(error && error.message)));
} catch (error) {
  report("options-threw:" + String(error && error.message));
}

// ── 4. downloads: not declared, so no id and nothing written ───────────────
try {
  chrome.downloads.download({ url: "https://example.com/ungranted.txt" })
    .then((id) => report("downloads-resolved:" + String(id)))
    .catch((error) => report("downloads-rejected:" + String(error && error.message)));
  chrome.downloads.search({}).then((items) => report("downloads-search:" + JSON.stringify(items)))
    .catch((error) => report("downloads-search-rejected:" + String(error && error.message)));
} catch (error) {
  report("downloads-threw:" + String(error && error.message));
}

// ── 5. the accept-and-grant shells: they exist, they answer, they stay quiet ─
// The load itself is the first claim: this worker NAMES all three at module scope, so
// before step 6 it took a TypeError at load and had no background context at all.
try {
  chrome.commands.onCommand.addListener(() => report("command-fired-should-not-happen"));
  chrome.contextMenus.onClicked.addListener(() => report("menu-clicked-should-not-happen"));
  chrome.sidePanel.onClicked.addListener(() => report("panel-clicked-should-not-happen"));
  chrome.contextMenus.create({ id: "shell-item", title: "Shell item", contexts: ["selection"] });
  chrome.sidePanel.setOptions({ path: "panel.html", enabled: true });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.sidePanel.open({ tabId: 1 })
    .then(() => report("shells-open-resolved-WRONG"))
    .catch((error) => report("shells-open-rejected:" + String(error && error.message)));
  // Chrome's own validation, through the promise that reports it:
  chrome.contextMenus.update("never-made", { title: "x" })
    .then(() => report("shells-update-resolved-WRONG"))
    .catch((error) => report("shells-update-rejected:" + String(error && error.message)));
  // getAll reads the MANIFEST, which arrives with RUNTIME_REGISTER, so it is asked for once
  // the registration reply has had time to land.
  setTimeout(() => {
    chrome.commands.getAll((all) =>
      report("shells-commands:" + JSON.stringify(all && all.openShell ? all.openShell : all))
    );
    chrome.sidePanel.getOptions({ path: "panel.html" }, (opts) => report("shells-options:" + JSON.stringify(opts)));
    chrome.sidePanel.getPanelBehavior((b) => report("shells-behavior:" + JSON.stringify(b)));
    chrome.contextMenus.remove("shell-item", () => report("shells-removed"));
    chrome.contextMenus.remove("shell-item", () => report("shells-remove-again-lastError:" + String(chrome.runtime.lastError && chrome.runtime.lastError.message)));
  }, 400);
} catch (error) {
  report("shells-threw:" + String(error && error.message));
}

console.log("TIER2:ready");
`;

// The second worker has the permissions the first lacks, so a save really writes and
// an options page really opens.
const grantedScript = `
const report = (line) => console.log("GRANTED:" + line);

chrome.downloads.download(
  { url: "https://example.com/files/granted.txt", saveAs: false },
  (id) => report("url-callback:" + String(id) + ":lastError=" + String(chrome.runtime.lastError && chrome.runtime.lastError.message))
);

chrome.downloads.download({ filename: "content-save.txt", body: "written by the worker" })
  .then((id) => report("content-resolved:" + String(id)))
  .catch((error) => report("content-rejected:" + String(error && error.message)));

setTimeout(() => {
  chrome.downloads.search({}, (items) =>
    report("search:" + JSON.stringify((items || []).map((i) => ({ id: i.id, state: i.state, filename: i.filename, totalBytes: i.totalBytes }))))
  );
}, 900);

// onChanged arrives from the host for the transitions that really happened.
chrome.downloads.onChanged.addListener((delta) =>
  report("changed:" + JSON.stringify({ id: delta.id, state: delta.state }))
);

chrome.runtime.openOptionsPage()
  .then(() => report("options-opened"))
  .catch((error) => report("options-rejected:" + String(error && error.message)));

console.log("GRANTED:ready");
`;

// A manifest that declares options_ui with an in-tab request, so the reported
// difference is observable too.
const noOptionsScript = `
chrome.runtime.openOptionsPage()
  .then(() => console.log("NOOPTIONS:resolved"))
  .catch((error) => console.log("NOOPTIONS:rejected:" + String(error && error.message)));
console.log("NOOPTIONS:ready");
`;

// The options page itself. CSP is `script-src 'self'`, so the script is a file.
const optionsPage = `<!DOCTYPE html>
<html><body><h1>Tier2 options</h1><script src="options.js"></script></body></html>
`;
const optionsScript = `
// An options page is an extension page: the shim has to be up in it as well, or
// "open the options page" would open a page that cannot function.
const id = typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.id : "none";
console.log("OPTIONS:loaded:id=" + id + ":canGetURL=" + String(chrome.runtime.getURL("options.html").startsWith("rozenite://" + id + "/")));
`;

const noOptionsExtensions = (root) => {
  const extensionsDir = path.join(root, "extensions");
  stageExtension(extensionsDir, NO_OPTIONS_ID, {
    "manifest.json": manifest({}),
    "bg.js": noOptionsScript,
  });
  return extensionsDir;
};

suite("tier-2 shims inside a real background worker", { timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-tier2-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const downloadsDir = path.join(root, "downloads");
  fs.mkdirSync(downloadsDir, { recursive: true });

  const extensionsDir = path.join(root, "extensions");
  stageExtension(extensionsDir, TIER2_ID, {
    // `alarms` only: notifications and downloads must be denied, and the manifest
    // declares no options_ui, so openOptionsPage has to fail. `commands` is declared so
    // the shells suite can assert `commands.getAll` reads the manifest, not a guess.
    "manifest.json": manifest({
      permissions: ["alarms"],
      commands: {
        openShell: {
          description: "Open the shell",
          suggested_key: { default: "Alt+Shift+S" },
          global: true,
        },
      },
    }),
    "bg.js": workerScript,
  });
  noOptionsExtensions(root);

  // 100 = 100 seconds of alarm time per second of real time, so Chrome's 30-second
  // floor costs 300 ms in this run while still being validated as Chrome validates it.
  const clockScale = 100;

  const run = await runHarness({
    binary,
    root: path.join(root, "run1"),
    extensionsDir,
    backgroundHost: true,
    downloadsDir,
    hostPage: "<!DOCTYPE html><html><body>no extension frames</body></html>",
    alarmClockScale: clockScale,
    waitFor: "TIER2:alarm-cleared-all",
    timeoutMs: 120000,
    settleMs: 1500,
  });

  const lines = (extensionId) =>
    run.observed
      .filter((line) => line.kind === "worker-console" && line.extensionId === extensionId)
      .map((line) => String(line.message));
  const said = (extensionId, needle) => lines(extensionId).some((m) => m.includes(needle));
  const find = (extensionId, needle) => lines(extensionId).find((m) => m.includes(needle));
  const optionsWindows = () =>
    (run.observed.find((line) => line.kind === "options-windows") || {}).windows || [];
  const harnessLine = run.observed.find((l) => l.kind === "harness") || {};

  console.log(
    [
      `  [electron/tier2/run1] exit=${run.code} worker-lines=${run.observed.filter((l) => l.kind === "worker-console").length}`,
      `  [electron/tier2/run1] ${TIER2_ID} said: ${JSON.stringify(lines(TIER2_ID).slice(0, 16))}`,
      `  [electron/tier2/run1] ${NO_OPTIONS_ID} said: ${JSON.stringify(lines(NO_OPTIONS_ID))}`,
      `  [electron/tier2/run1] notification-shows: ${JSON.stringify(
        run.observed.filter((l) => l.kind === "notification-show").map((l) => l.id)
      )}`,
      `  [electron/tier2/run1] options windows: ${JSON.stringify(optionsWindows())}`,
      `  [electron/tier2/run1] saves: ${JSON.stringify(run.observed.filter((l) => l.kind === "save-write"))}`,
    ].join("\n")
  );

  assert.equal(said(TIER2_ID, "TIER2:ready"), true, "the worker ran to the end of its probes");
  assert.equal(
    harnessLine.alarmClockScale,
    clockScale,
    "the host really configured the clock scale this run asked for"
  );

  // ── 1. notifications: denied by the manifest, and the verdict survives IPC ──
  assert.match(
    JSON.stringify(lines(TIER2_ID)),
    /TIER2:notifications-callback:undefined:lastError=Cannot use chrome\.notifications\.\*: permission 'notifications' is not declared/,
    "callback style: Chrome hands the callback no id to work with, and lastError names the missing permission"
  );
  assert.match(
    JSON.stringify(lines(TIER2_ID)),
    /notifications-rejected:Cannot use chrome\.notifications\.\*: permission 'notifications' is not declared/,
    "promise style: the same denial as a rejection"
  );
  assert.equal(
    said(TIER2_ID, "notifications-resolved"),
    false,
    "no id was resolved for a context that had not earned one"
  );
  assert.equal(
    run.observed.filter((l) => l.kind === "notification-show").length,
    0,
    "and the notifier was never asked to show anything"
  );

  // ── 2. alarms: a real timer fired, judged and scheduled by Chrome's rules ──
  assert.equal(said(TIER2_ID, "TIER2:alarms-threw"), false, "chrome.alarms is usable in a worker");
  assert.equal(said(TIER2_ID, "alarm-should-not-fire"), false, "the cleared alarm never fired");
  const firedLine = find(TIER2_ID, "alarm-fired:tick-once");
  assert.ok(firedLine, "the 30-second alarm really fired inside this run");
  assert.equal(
    lines(TIER2_ID).filter((m) => m.includes("alarm-fired:tick-once")).length,
    1,
    "and exactly once"
  );

  const fields = Object.fromEntries(
    String(firedLine)
      .split(":")
      .slice(1)
      .filter((part) => part.includes("="))
      .map((part) => part.split("="))
  );
  const scheduledTime = Number(fields.scheduledTime);
  const created = Number(fields.created);
  const nowAtFire = Number(fields.now);
  assert.ok(scheduledTime > 0, "onAlarm carries a scheduledTime");
  // Chrome's floor, not a shortened one: `create` was validated against the real
  // 30 s, and scheduledTime reports THAT moment. Only the wait was compressed.
  const scheduledDelay = scheduledTime - created;
  assert.ok(
    scheduledDelay >= 29000 && scheduledDelay <= 31000,
    `scheduledTime is create() + Chrome's 30 s floor, got ${scheduledDelay}ms`
  );
  assert.ok(
    scheduledTime > nowAtFire,
    `and it is still in the future when the scaled timer fires — the shim reports the schedule, not the tick's clock (${scheduledTime} > ${nowAtFire})`
  );

  const listLine = find(TIER2_ID, "alarm-list:");
  assert.match(
    String(listLine),
    /\{"name":"later-one","period":"none"\},\{"name":"tick-once","period":"none"\}/,
    `getAll listed both live alarms, with no invented periodInMinutes on a one-shot: ${listLine}`
  );
  assert.match(JSON.stringify(lines(TIER2_ID)), /alarm-cleared:true/, "clear() reports what it removed");
  assert.match(JSON.stringify(lines(TIER2_ID)), /alarm-clear-again:false/, "and false once it is gone");

  // ── 3. openOptionsPage: an extension with no options_ui is told so ─────────
  assert.equal(said(NO_OPTIONS_ID, "NOOPTIONS:ready"), true, "the second worker ran");
  assert.equal(
    said(NO_OPTIONS_ID, "NOOPTIONS:resolved"),
    false,
    "a resolved promise would claim a window opened when the host refused to open one"
  );
  assert.match(
    JSON.stringify(lines(NO_OPTIONS_ID)),
    /NOOPTIONS:rejected:Cannot open the options page: this extension \(no-options\.local\) does not declare options_ui in its manifest\.json\./,
    "the rejection names the extension, from the manifest on disk"
  );
  assert.equal(optionsWindows().length, 0, "and no window was created");

  // The ungranted worker's own openOptionsPage attempt is refused the same way.
  assert.match(
    JSON.stringify(lines(TIER2_ID)),
    /TIER2:options-rejected:Cannot open the options page/,
    "tier2.local declares no options_ui either"
  );

  // ── 4. downloads: gated in the frame, so main is never asked ──────────────
  assert.equal(said(TIER2_ID, "downloads-resolved"), false, "no id for a refused download");
  assert.match(
    JSON.stringify(lines(TIER2_ID)),
    /downloads-rejected:Cannot use chrome\.downloads\.\*: permission 'downloads' is not declared/,
    "the frame's gate rejects it"
  );
  assert.match(
    JSON.stringify(lines(TIER2_ID)),
    /downloads-search-rejected:Cannot use chrome\.downloads\.\*/,
    "and search is gated the same way, rather than answering an empty list as if it had looked"
  );
  assert.equal(
    run.observed.filter((l) => l.kind === "save-write").length,
    0,
    "nothing was written for a denied extension"
  );
  assert.deepEqual(fs.readdirSync(downloadsDir), [], "the downloads dir is exactly as this run left it");

  // ── 5. the accept-and-grant shells: they load, answer, and stay quiet ──────
  // Before step 6 this worker could not have got here at all: naming `chrome.commands`
  // at module scope was a TypeError at LOAD, and the whole background context went with it.
  assert.equal(said(TIER2_ID, "shells-threw"), false, "no synchronous throw at module scope");
  assert.equal(
    said(TIER2_ID, "shells-open-resolved-WRONG"),
    false,
    "sidePanel.open resolved, which would claim a panel came up"
  );
  assert.match(
    JSON.stringify(lines(TIER2_ID)),
    /TIER2:shells-open-rejected:chrome\.sidePanel\.open: this host has no side-panel drawer/,
    "open() fails, because its promise means a panel is up and none can be"
  );
  assert.match(
    JSON.stringify(lines(TIER2_ID)),
    /TIER2:shells-update-rejected:Cannot find menu item with id never-made/,
    "contextMenus.update keeps Chromium's own rejection across the process boundary"
  );
  const commandsLine = find(TIER2_ID, "shells-commands:");
  assert.match(
    String(commandsLine),
    /"name":"openShell","description":"Open the shell","shortcuts":\["Alt\+Shift\+S"\],"global":true/,
    `commands.getAll answered from the manifest on disk: ${commandsLine}`
  );
  const shellsLine = find(TIER2_ID, "shells-options:");
  assert.deepEqual(
    JSON.parse(String(shellsLine).replace("TIER2:shells-options:", "")),
    { path: "panel.html", enabled: true },
    `the configuration the worker wrote is the configuration it reads back: ${shellsLine}`
  );
  const behaviorLine = find(TIER2_ID, "shells-behavior:");
  assert.deepEqual(
    JSON.parse(String(behaviorLine).replace("TIER2:shells-behavior:", "")),
    { openPanelOnActionClick: true },
    `the one real PanelBehavior key round-trips: ${behaviorLine}`
  );
  assert.match(JSON.stringify(lines(TIER2_ID)), /TIER2:shells-removed/);
  assert.match(
    JSON.stringify(lines(TIER2_ID)),
    /TIER2:shells-remove-again-lastError:Cannot find menu item with id shell-item/,
    "and the registry knows an id it already removed is gone"
  );
  for (const never of ["command-fired", "menu-clicked", "panel-clicked"]) {
    assert.equal(
      said(TIER2_ID, never),
      false,
      `${never} fired: no keystroke, click or menu was observed by this host`
    );
  }

  // ── 6. nothing here interrupted a human ───────────────────────────────────
  assert.equal(harnessLine.notifier, "fake", "the notifier was the recorder, not Electron's");
  assert.equal(harnessLine.saveDialog, "fake", "and the save dialog was answered by the harness");
  assert.equal(
    run.observed.filter((l) => l.kind === "worker-console" && Number(l.value) >= 3).length,
    0,
    `no uncaught errors in either worker: ${JSON.stringify(
      run.observed
        .filter((l) => l.kind === "worker-console" && Number(l.value) >= 3)
        .map((l) => `${l.extensionId}: ${l.message}`)
    )}`
  );
});

suite(
  "a granted extension really saves, really reports onChanged, and really opens its options page",
  { timeout: 240000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-tier2-granted-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const downloadsDir = path.join(root, "downloads");
    fs.mkdirSync(downloadsDir, { recursive: true });

    // Its own extensions dir, so the first suite's ungranted manifest cannot be
    // installed alongside it by the same background host.
    const extensionsDir = path.join(root, "extensions");
    stageExtension(extensionsDir, TIER2_ID, {
      "manifest.json": manifest({ permissions: ["downloads"], optionsUi: true, openInTab: true }),
      "bg.js": grantedScript,
      "options.html": optionsPage,
      "options.js": optionsScript,
    });

    const run = await runHarness({
      binary,
      root: path.join(root, "run"),
      extensionsDir,
      backgroundHost: true,
      downloadsDir,
      // The options window is created for real, but hidden: "a window opened" is only
      // observable as a window that exists and loads.
      optionsWindows: "real",
      hostPage: "<!DOCTYPE html><html><body>no extension frames</body></html>",
      waitFor: "GRANTED:search",
      timeoutMs: 120000,
      settleMs: 2000,
    });

    const lines = run.observed
      .filter((l) => l.kind === "worker-console" && l.extensionId === TIER2_ID)
      .map((l) => String(l.message));
    const said = (needle) => lines.some((m) => m.includes(needle));
    const windows = (run.observed.find((l) => l.kind === "options-windows") || {}).windows || [];
    const writes = run.observed.filter((l) => l.kind === "save-write");

    console.log(
      [
        `  [electron/tier2/granted] exit=${run.code} worker-lines=${lines.length}`,
        `  [electron/tier2/granted] said: ${JSON.stringify(lines.slice(0, 14))}`,
        `  [electron/tier2/granted] options windows: ${JSON.stringify(windows)}`,
        `  [electron/tier2/granted] options console: ${JSON.stringify(
          run.observed.filter((l) => l.kind === "options-console").map((l) => l.message)
        )}`,
        `  [electron/tier2/granted] saves: ${JSON.stringify(writes)}`,
        `  [electron/tier2/granted] dir: ${JSON.stringify(fs.readdirSync(downloadsDir))}`,
      ].join("\n")
    );

    assert.equal(said("GRANTED:ready"), true, "the granted worker ran");

    // ── the bytes really landed, in the directory the host configured ────────
    const contentFile = path.join(downloadsDir, "content-save.txt");
    const written = await new Promise((resolve) => {
      const deadline = Date.now() + 6000;
      const poll = () => {
        if (fs.existsSync(contentFile)) {
          resolve(fs.readFileSync(contentFile, "utf8"));
        } else if (Date.now() > deadline) {
          resolve(null);
        } else {
          setTimeout(poll, 100);
        }
      };
      poll();
    });
    assert.equal(
      written,
      "written by the worker",
      `a content save wrote the bytes it was given (${JSON.stringify(fs.readdirSync(downloadsDir))})`
    );
    assert.equal(said("GRANTED:content-resolved"), true, "and the call resolved with the host's id");

    assert.equal(
      writes.some((entry) => entry.name === "granted.txt"),
      true,
      `a URL download fetched and wrote a file named from the URL: ${JSON.stringify(writes)}`
    );
    assert.equal(said("GRANTED:url-callback"), true, "the callback style names the same id");
    assert.match(JSON.stringify(lines), /GRANTED:url-callback:\d+:lastError=null/);

    const searchLine = lines.find((m) => m.includes("GRANTED:search:"));
    assert.ok(searchLine, "search answered");
    const items = JSON.parse(searchLine.slice("GRANTED:search:".length));
    assert.equal(items.length, 2, "search returned both downloads this shell really tracked");
    assert.ok(
      items.every((item) => item.state === "complete" && item.totalBytes > 0),
      `both report complete with a real byte count: ${JSON.stringify(items)}`
    );
    assert.ok(
      items.every((item) => String(item.filename).startsWith(downloadsDir)),
      "and the filenames are paths in the directory the host chose, not a guess at one"
    );

    // ── onChanged arrived from the host for the transitions that happened ────
    const changed = lines.filter((m) => m.includes("GRANTED:changed:"));
    assert.equal(changed.length >= 2, true, `the host pushed the real transitions: ${JSON.stringify(changed)}`);
    assert.ok(
      changed.some((m) => /"current":"in_progress"/.test(m)),
      "an in_progress delta, and Chrome's first-of-a-download shape with no previous"
    );
    assert.ok(changed.some((m) => /"current":"complete"/.test(m)), "and a completion delta");
    assert.ok(
      !changed.some((m) => /"previous":"in_progress","current":"in_progress"/.test(m)),
      "no delta claims a transition that did not happen"
    );

    // ── the options page opened as a real window, over the extension's URL ──
    assert.equal(said("GRANTED:options-opened"), true, "openOptionsPage resolved");
    assert.equal(windows.length, 1, "one window, for the extension that asked");
    assert.match(windows[0].url, /^rozenite:\/\/tier2\.local\/options\.html$/);
    assert.equal(windows[0].extensionId, TIER2_ID);
    const optionsConsole = run.observed
      .filter((l) => l.kind === "options-console")
      .map((l) => String(l.message));
    assert.equal(
      optionsConsole.some((m) => m.includes("OPTIONS:loaded:id=tier2.local")),
      true,
      `the window really loaded the page and the shim works there: ${JSON.stringify(optionsConsole)}`
    );
    assert.equal(
      optionsConsole.some((m) => m.includes("canGetURL=true")),
      true,
      "and getURL inside it points back at this extension's own files"
    );
    assert.deepEqual(
      (run.observed.find((l) => l.kind === "options-windows") || {}).tracked,
      [TIER2_ID],
      "the production host tracked the window it opened"
    );
  }
);

suite(
  "a denied chrome.downloads is refused by the host even when the frame asks",
  { timeout: 240000 },
  async (t) => {
    // The frame's gate is the polite half. A page-world script can reach its own
    // `chrome.downloads` wrapper, so main decides the same verdict from the manifest on
    // disk and simply does not serve the channel.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-tier2-hostgate-"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const downloadsDir = path.join(root, "downloads");
    fs.mkdirSync(downloadsDir, { recursive: true });

    const extensionsDir = path.join(root, "extensions");
    stageExtension(extensionsDir, TIER2_ID, {
      "manifest.json": manifest({ permissions: ["storage"] }),
      "panel.html": `<!DOCTYPE html><html><body><script src="panel.js"></script></body></html>`,
      "panel.js": `
        const MARKER = "__ROZENITE_PROBE__";
        const out = {};
        // Callback style first, because that is where lastError is observable:
        // Chrome scopes it to the callback's own synchronous run.
        chrome.downloads.download({ url: "https://example.com/from-panel.txt" }, function (id) {
          out.callbackId = id;
          out.callbackLastError = String(chrome.runtime.lastError && chrome.runtime.lastError.message);
        });
        chrome.downloads.download({ url: "https://example.com/from-panel.txt" })
          .then((id) => { out.resolved = id; })
          .catch((error) => { out.rejected = String(error && error.message); })
          .then(() => {
            out.lastErrorAfterRejection = String(chrome.runtime.lastError && chrome.runtime.lastError.message);
            return chrome.downloads.search({});
          })
          .then((items) => { out.searched = (items || []).length; })
          .catch((error) => { out.searchRejected = String(error && error.message); })
          .then(() => {
            // And the shape is still there: an extension feature-detecting by calling
            // gets a failing call, not a TypeError (docs/OVERVIEW.md).
            out.shape = ["download", "search", "cancel", "erase", "show", "showDefaultFolder"]
              .filter((name) => typeof chrome.downloads[name] !== "function");
            out.events = ["onChanged", "onDeterminingFilename"]
              .filter((name) => !chrome.downloads[name] || typeof chrome.downloads[name].addListener !== "function");
            console.log(MARKER + JSON.stringify(out));
            console.log("[tier2-hostgate] done");
          });
      `,
    });

    const run = await runHarness({
      binary,
      root: path.join(root, "run"),
      extensionsDir,
      downloadsDir,
      hostPage: `<!DOCTYPE html><html><body>
        <iframe src="rozenite://${TIER2_ID}/panel.html" width="400" height="300"></iframe>
      </body></html>`,
      waitFor: "[tier2-hostgate] done",
      timeoutMs: 120000,
      settleMs: 1200,
    });

    const probe = (run.observed.find((l) => l.kind === "probe") || {}).data || {};
    console.log(`  [electron/tier2/hostgate] exit=${run.code} probe: ${JSON.stringify(probe)}`);

    assert.ok(probe.rejected, `the panel's call was denied: ${JSON.stringify(probe)}`);
    assert.match(probe.rejected, /permission 'downloads' is not declared/);
    assert.equal(probe.resolved, undefined, "no id came back from the promise style");
    assert.equal(probe.callbackId, undefined, "and the callback style gets no id to work with, like Chrome's");
    assert.match(
      String(probe.callbackLastError),
      /'downloads' is not declared/,
      "lastError is set for the duration of the callback"
    );
    assert.equal(
      probe.lastErrorAfterRejection,
      "null",
      "and it is cleared again afterwards — Chrome's scoping, not a sticky error"
    );
    assert.match(String(probe.searchRejected), /'downloads' is not declared/);
    assert.deepEqual(probe.shape, [], "every method kept its shape");
    assert.deepEqual(probe.events, [], "and both events stayed registrable");
    assert.deepEqual(fs.readdirSync(downloadsDir), [], "and no file was written");
  }
);
