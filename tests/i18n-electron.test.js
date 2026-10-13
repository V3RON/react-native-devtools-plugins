// chrome.i18n inside a REAL Electron process (docs/features/STORAGE-AND-I18N.md).
//
// What the unit suites cannot prove, and this does:
//
//   1. getMessage is usable on the FIRST statement of the first script, in a devtools
//      page/panel iframe and in the background context alike. That depends on the
//      preload's synchronous read of the bundle over the extension protocol
//      (src/preload/extension-frame.js, src/main/i18n-host.js) actually completing
//      before page scripts run, with no IPC.
//   2. The UI locale is the host's: DEVTOOLS_UI_LOCALE reaches the bundle, and the same
//      extension answers in pt-BR, in an RTL locale, and in a locale it has no folder for.
//   3. The host-side halves land too: the localized manifest (chrome.runtime.getManifest,
//      the panel list's name) and the localized CSS file the page actually loads.
//
// Run under the headless harness (tests/extension-frame-harness.js): no Metro, no device.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { electronBinary, runHarness, stageExtension, consoleLines } = require("./electron-runner");

const binary = electronBinary();
const suite = binary ? test : test.skip;
const ID = "i18n.local";

const catalog = (entries) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === "string" ? { message: v } : v]))
  );
const hello = (text) => ({ message: text, placeholders: { user: { content: "$1" } } });

// The probe runs on the very first statement: nothing has awaited anything.
const probe = (who) => `
const early = chrome.i18n.getMessage("hello", ["Ada"]);
const report = (line) => console.log("I18N:${who}|" + line);
report("early=" + early);
report("lang=" + chrome.i18n.getUILanguage() + " locale=" + chrome.i18n.getMessage("@@ui_locale") +
  " dir=" + chrome.i18n.getMessage("@@bidi_dir") + " id=" + (chrome.i18n.getMessage("@@extension_id") === chrome.runtime.id));
report("fallback=" + chrome.i18n.getMessage("onlyDefault") + " unknown=[" + chrome.i18n.getMessage("nope") + "]");
chrome.i18n.getAcceptLanguages().then((list) => report("accept=" + list.join(",")));
chrome.i18n.detectLanguage("hello").then((r) => report("detect=" + JSON.stringify(r)));
setTimeout(() => {
  report("manifest=" + chrome.runtime.getManifest().name + "/" + chrome.runtime.getManifest().current_locale);
  ${who === "panel" ? 'report("css=" + getComputedStyle(document.body).direction); report("done");' : 'report("done");'}
}, 400);
`;

const stage = (extensionsDir) =>
  stageExtension(extensionsDir, ID, {
    "manifest.json": JSON.stringify({
      name: "__MSG_extName__",
      version: "1",
      manifest_version: 3,
      default_locale: "en",
      background: { service_worker: "bg.js" },
      devtools_page: "devtools.html",
    }),
    "_locales/en/messages.json": catalog({
      extName: "Extension EN",
      hello: hello("Hello, $USER$!"),
      onlyDefault: "default-only",
    }),
    "_locales/pt_BR/messages.json": catalog({ extName: "Extensão PT", hello: hello("Olá, $USER$!") }),
    "_locales/ar/messages.json": catalog({ extName: "ملحق" }),
    "panel.html": '<!DOCTYPE html><html><head><link rel="stylesheet" href="panel.css"><script src="panel.js"></script></head><body>x</body></html>',
    "panel.css": "body{direction:__MSG_@@bidi_dir__}",
    "panel.js": probe("panel"),
    "bg.js": probe("worker"),
  });

const hostPage = `<!DOCTYPE html><html><body>
  <iframe src="rozenite://${ID}/panel.html" width="400" height="300"></iframe>
</body></html>`;

const runWith = async (root, uiLocale) => {
  const extensionsDir = path.join(root, `extensions-${uiLocale}`);
  stage(extensionsDir);
  process.env.DEVTOOLS_UI_LOCALE = uiLocale;
  try {
    const run = await runHarness({
      binary,
      root: path.join(root, `run-${uiLocale}`),
      extensionsDir,
      hostPage,
      extensionId: ID,
      backgroundHost: true,
      waitFor: "I18N:worker|done",
      timeoutMs: 90000,
      settleMs: 1500,
    });
    const lines = consoleLines(run.observed).map(String);
    const pick = (who) =>
      lines
        .filter((line) => line.includes(`I18N:${who}|`))
        .map((line) => line.slice(line.indexOf(`I18N:${who}|`) + `I18N:${who}|`.length));
    return { run, lines, panel: pick("panel"), worker: pick("worker") };
  } finally {
    delete process.env.DEVTOOLS_UI_LOCALE;
  }
};

suite("chrome.i18n in a real Electron process", { timeout: 300000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-i18n-electron-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await t.test("pt-BR: first-statement getMessage answers in Portuguese in the panel and the worker", async () => {
    const { run, lines, panel, worker } = await runWith(root, "pt-BR");
    const dump = `exit ${run.code}\n${lines.slice(-30).join("\n")}`;
    for (const [who, got] of [["panel", panel], ["worker", worker]]) {
      assert.ok(got.length > 0, `${who} reported\n${dump}`);
      assert.ok(got.includes("early=Olá, Ada!"), `${who}: synchronous, translated, substituted: ${got.join(" ; ")}`);
      assert.ok(got.some((l) => l.startsWith("lang=pt-BR locale=pt_BR dir=ltr id=true")), `${who}: ${got.join(" ; ")}`);
      assert.ok(got.includes("fallback=default-only unknown=[]"), `${who} per-message fallback: ${got.join(" ; ")}`);
      assert.ok(got.some((l) => /^accept=pt-BR,pt,/.test(l)), `${who} accept languages: ${got.join(" ; ")}`);
      assert.ok(
        got.includes('detect={"isReliable":false,"languages":[]}'),
        `${who} detectLanguage is an honest undetermined: ${got.join(" ; ")}`
      );
      assert.ok(got.includes("manifest=Extensão PT/pt_BR"), `${who} localized manifest: ${got.join(" ; ")}`);
    }
    assert.ok(panel.includes("css=ltr"), `localized CSS file loaded: ${panel.join(" ; ")}`);
    const sync = run.observed.filter((line) => line.kind === "preload-error");
    assert.deepStrictEqual(sync, [], "no preload error");
  });

  await t.test("ar: right-to-left predefined messages and CSS; messages missing from ar fall back to en", async () => {
    const { lines, panel, worker } = await runWith(root, "ar");
    for (const [who, got] of [["panel", panel], ["worker", worker]]) {
      assert.ok(got.includes("early=Hello, Ada!"), `${who}: hello falls back to en: ${got.join(" ; ")} \n${lines.slice(-10).join("\n")}`);
      assert.ok(got.some((l) => l.startsWith("lang=ar locale=ar dir=rtl id=true")), `${who}: ${got.join(" ; ")}`);
      assert.ok(got.includes("manifest=ملحق/ar"), `${who}: ${got.join(" ; ")}`);
    }
    assert.ok(panel.includes("css=rtl"), `CSS __MSG_@@bidi_dir__ is rtl: ${panel.join(" ; ")}`);
  });

  await t.test("ja: no folder for the locale, default_locale answers", async () => {
    const { panel, worker } = await runWith(root, "ja");
    for (const [who, got] of [["panel", panel], ["worker", worker]]) {
      assert.ok(got.includes("early=Hello, Ada!"), `${who}: ${got.join(" ; ")}`);
      assert.ok(got.some((l) => l.startsWith("lang=ja locale=ja dir=ltr")), `${who}: ${got.join(" ; ")}`);
      assert.ok(got.includes("manifest=Extension EN/ja"), `${who}: ${got.join(" ; ")}`);
    }
  });
});
