// `chrome.tabs.sendMessage`'s wiring inside a REAL Electron process (GitHub issue #5).
//
// The unit suites prove the rules; only a real process can prove the chain that carries
// them — production preload → production shim → IPC → `src/main/tab-send.js` → the real
// content bridge → the real gate — and in particular the two things a fake cannot:
//
//   1. A call that reaches nothing REJECTS with a reason, in the frame, instead of
//      resolving `undefined`. That is the whole honesty argument for wiring the API at
//      all, and it depends on the reply surviving the process boundary intact.
//   2. The failure is gated twice: a frame whose manifest does not declare `tabs` is
//      refused by MAIN and never reaches the content bridge, so a missing grant cannot be
//      turned into an injection question.
//
// What this is NOT: no content script is injected in any of these runs. The harness runs
// with no CDP session (`DEVTOOLS_CDP_BRIDGE=off`), and the gate is default-closed, so the
// honest outcome is a refusal. Claiming a delivery here would require a device, and
// docs/features/CONTENT-SCRIPTS.md records that as still outstanding rather than faking it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { electronBinary, runHarness, stageExtension, consoleLines } = require("./electron-runner");

const binary = electronBinary();
const suite = binary ? test : test.skip;

const GRANTED_ID = "tabsend.local";
const UNGRANTED_ID = "no-tabs.local";

const manifest = (permissions) =>
  JSON.stringify({
    name: "Tab Send Fixture",
    version: "1.0.0",
    manifest_version: 3,
    background: { service_worker: "bg.js" },
    permissions,
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  });

/**
 * One worker, two probes, one line each. Both must FAIL, and the reasons must differ:
 * a grant-less caller that gets the injection reason would mean MAIN let the call through
 * and only the gate stopped it.
 */
const workerScript = `
const report = (line) => console.log("TABSEND:" + chrome.runtime.id + "|" + line);
const probe = (name, fn) => { try { return fn().then((v) => report(name + ":resolved:" + JSON.stringify(v)), (e) => report(name + ":rejected:" + e.message)); } catch (error) { report(name + ":threw:" + error.message); } };

const tabId = chrome.devtools.inspectedWindow.tabId;

probe("granted", () =>
  chrome.tabs.sendMessage(tabId, { ask: true }).then((response) => ({ response }))
);
probe("granted-callback", () =>
  new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { ask: true }, (response) => {
      resolve({ response, lastError: chrome.runtime.lastError && chrome.runtime.lastError.message });
    });
  })
);
probe("bad-tab-id", () => chrome.tabs.sendMessage(424242, { ask: true }).then((r) => ({ response: r })));
report("done");
`;

/** The same script for the frame with no `tabs` grant: only the manifest differs. */
const ungrantedScript = workerScript;

suite("chrome.tabs.sendMessage in a real Electron process", { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-tabsend-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const extensionsDir = path.join(root, "extensions");
  stageExtension(extensionsDir, GRANTED_ID, {
    "manifest.json": manifest(["tabs"]),
    "bg.js": workerScript,
  });
  stageExtension(extensionsDir, UNGRANTED_ID, {
    "manifest.json": manifest([]),
    "bg.js": ungrantedScript,
  });

  const hostPage = `<!DOCTYPE html>
<html><body>
  <iframe src="rozenite://${GRANTED_ID}/panel.html" width="600" height="400"></iframe>
</body></html>
`;

  const run = await runHarness({
    binary,
    root: path.join(root, "run1"),
    extensionsDir,
    hostPage,
    extensionId: GRANTED_ID,
    backgroundHost: true,
    waitFor: "|done",
    timeoutMs: 90000,
    settleMs: 2500,
  });

  const lines = consoleLines(run.observed).map((line) => String(line));
  /** One worker's probe lines: the id is in the line, so two workers cannot be mixed. */
  const text = (extensionId, name) =>
    lines.filter((line) => line.includes(`TABSEND:${extensionId}|${name}:`)).join("\n");

  const granted = (name) => text(GRANTED_ID, name);
  const ungranted = (name) => text(UNGRANTED_ID, name);

  // 1. The granted caller's promise rejects — it does NOT resolve undefined. A resolved
  //    undefined is what an extension reads as "the page answered nothing".
  assert.ok(
    granted("granted").length > 0,
    `the granted probe reported (exit ${run.code}):\n${lines.slice(-25).join("\n")}`
  );
  assert.match(granted("granted"), /:rejected:/, "a send with no receiver rejects");
  assert.ok(
    !/:resolved:/.test(granted("granted")),
    `must not resolve, and especially not to undefined: ${granted("granted")}`
  );
  assert.match(
    granted("granted"),
    /no content script of "tabsend\.local" is running/,
    "and the rejection names what is actually missing"
  );

  // 2. Callback style: no value at all, and the reason on runtime.lastError — Chrome's
  //    shape, asserted across a real process boundary rather than against a fake holder.
  //    The probe stringifies `{response, lastError}`, so an absent `response` KEY is the
  //    evidence: `response: undefined` is what a value-less Chrome callback passes.
  const callbackLine = granted("granted-callback");
  assert.match(callbackLine, /:resolved:/, "the probe itself completed");
  assert.ok(!/"response":/.test(callbackLine), `the callback got no value: ${callbackLine}`);
  assert.match(callbackLine, /"lastError":"[^"]/, "and lastError carried the reason");

  // 3. An id that is not the inspected target is Chrome's own error, produced by the shim
  //    in the frame with no host round-trip. The ungranted worker never gets that far:
  //    its `chrome.tabs.*` call is refused at the permission check, which is the earlier
  //    and more true reason (ordering that only a real frame can show).
  assert.match(granted("bad-tab-id"), /:rejected:No tab with id: 424242/);
  assert.match(ungranted("bad-tab-id"), /permission 'tabs' is not declared/);

  // 4. The grant-less extension is refused by MAIN's gate, with the permission as the
  //    reason — not the injection reason. It never reached the content bridge.
  // 4. MAIN's own gate, not the injection gate: the grant-less worker hears about the
  //    permission and never gets as far as an answer about content scripts.
  assert.match(
    ungranted("granted"),
    /:rejected:Cannot use chrome\.tabs\..*permission 'tabs' is not declared/,
    `the grant-less worker is refused by the host's grant check (exit ${run.code}):\n` +
      lines.filter((l) => /TABSEND:/.test(l)).join("\n")
  );
  assert.ok(
    !/no content script/.test(ungranted("granted")),
    "a denied caller never reaches the content bridge at all"
  );
  assert.ok(
    !/permission 'tabs'/.test(granted("granted")),
    "while the granted caller's answer is about injection, not permission"
  );

  // 5. The refusal carries the BRIDGE's own verdict, including the state of the gate. That
  //    is stronger evidence than a startup log line (which goes to the main process's
  //    stdout, not the recorded frame output): the answer the extension received was
  //    produced by consulting the real gate in this process, and says `not scanned`
  //    because this run's extensions folder was never scanned for content scripts.
  assert.match(
    granted("granted"),
    /docs\/features\/CONTENT-SCRIPTS\.md is the opt-in/,
    "the failure points at the mechanism that would change the answer"
  );
});
