// The three Electron primitives behind InspectorFrontendHost, under bare Node:
// openInNewTab (src/main/external-open.js), save/append/close (src/main/host-files.js
// over the real save service) and getHostConfig (src/main/host-config.js).
// docs/api/INSPECTOR-FRONTEND-HOST.md.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openableUrl, createExternalOpener } = require("../src/main/external-open");
const { createHostFiles } = require("../src/main/host-files");
const { createSaveService } = require("../src/main/save-service");
const { buildHostConfig, DEFAULT_HOST_CONFIG } = require("../src/main/host-config");

// ── openInNewTab ─────────────────────────────────────────────────────────────
test("openableUrl allows http(s) only and normalizes", () => {
  assert.strictEqual(openableUrl("https://reactnative.dev/docs"), "https://reactnative.dev/docs");
  assert.strictEqual(openableUrl(" http://localhost:8081 "), "http://localhost:8081/");
  for (const bad of [
    "file:///etc/passwd",
    "smb://host/share",
    "javascript:alert(1)",
    "data:text/html,hi",
    "chrome://settings",
    "rozenite://ext/page.html",
    "ms-msdt:/id",
    "https://trusted.example@evil.example/",
    "http://user:pw@localhost:8081/",
    "//evil.example",
    "not a url",
    "http://",
    "",
    "   ",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.strictEqual(openableUrl(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("the opener hands only allowed URLs to openExternal and reports refusals", async () => {
  const opened = [];
  const opener = createExternalOpener({ openExternal: (url) => opened.push(url) });
  assert.deepStrictEqual(await opener.open("https://example.com/a?b=1"), {
    ok: true,
    url: "https://example.com/a?b=1",
  });
  const refused = await opener.open("file:///etc/passwd");
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /not http\(s\)/);
  assert.deepStrictEqual(opened, ["https://example.com/a?b=1"]);

  const failing = createExternalOpener({
    openExternal: () => {
      throw new Error("no browser");
    },
  });
  assert.deepStrictEqual(await failing.open("https://example.com"), { ok: false, error: "no browser" });
});

// ── save / append / close ────────────────────────────────────────────────────
const makeFiles = (dialogAnswers) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-files-"));
  const events = [];
  const dialogs = [];
  const answers = [...dialogAnswers];
  const saveService = createSaveService({
    showSaveDialog: async (options) => {
      dialogs.push(options.defaultPath);
      const next = answers.shift();
      if (next === "cancel") return { canceled: true };
      return { canceled: false, filePath: path.join(dir, next) };
    },
    fetchUrl: async () => {
      throw new Error("a frontend save must never fetch");
    },
    writeFile: (target, data, options) => fs.promises.writeFile(target, data, options),
    unlink: (target) => fs.promises.unlink(target),
    downloadsDir: () => dir,
  });
  const logs = [];
  const files = createHostFiles({
    saveService,
    appendFile: (target, data) => fs.promises.appendFile(target, data, "utf8"),
    dispatch: (name, args) => {
      events.push([name, ...args]);
      return true;
    },
    log: (message) => logs.push(message),
  });
  return { dir, files, events, dialogs, logs };
};

test("first save asks, writes, remembers the path and raises savedURL with the frontend's url", async () => {
  const { dir, files, events, dialogs } = makeFiles(["chosen.log"]);
  const url = "file:///logs/console.log";
  const reply = await files.save({ url, content: "hello\n", forceSaveAs: false });
  assert.strictEqual(reply.ok, true);
  const target = path.join(dir, "chosen.log");
  assert.strictEqual(fs.readFileSync(target, "utf8"), "hello\n");
  assert.deepStrictEqual(events, [["savedURL", url, target]]);
  // The dialog's suggestion is the url's last segment, not the whole url.
  assert.strictEqual(path.basename(dialogs[0]), "console.log");
  assert.strictEqual(files.pathOf(url), target);
});

test("a second save of the same url re-uses the path without asking, unless forceSaveAs", async () => {
  const { dir, files, events, dialogs } = makeFiles(["a.txt", "b.txt"]);
  const url = "dump.txt";
  await files.save({ url, content: "one" });
  await files.save({ url, content: "two" });
  assert.strictEqual(dialogs.length, 1, "no second dialog");
  assert.strictEqual(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "two");
  await files.save({ url, content: "three", forceSaveAs: true });
  assert.strictEqual(dialogs.length, 2);
  assert.strictEqual(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "three");
  assert.strictEqual(files.pathOf(url), path.join(dir, "b.txt"));
  assert.deepStrictEqual(events.map((e) => e[0]), ["savedURL", "savedURL", "savedURL"]);
});

test("a cancelled dialog raises canceledSaveURL, writes nothing and keeps no handle", async () => {
  const { dir, files, events, logs } = makeFiles(["cancel"]);
  const url = "net.har";
  const reply = await files.save({ url, content: "{}" });
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.canceled, true);
  assert.deepStrictEqual(events, [["canceledSaveURL", url]]);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.strictEqual(files.pathOf(url), null);
  assert.deepStrictEqual(logs, [], "a user cancel is not worth a warning");
});

test("a cancelled forceSaveAs keeps the old handle", async () => {
  const { files, events } = makeFiles(["keep.txt", "cancel"]);
  await files.save({ url: "x.txt", content: "1" });
  await files.save({ url: "x.txt", content: "2", forceSaveAs: true });
  assert.deepStrictEqual(events.map((e) => e[0]), ["savedURL", "canceledSaveURL"]);
  assert.match(files.pathOf("x.txt"), /keep\.txt$/);
});

test("append grows the saved file in order and raises appendedToURL per chunk", async () => {
  const { dir, files, events } = makeFiles(["log.txt"]);
  const url = "console.log";
  // Fired back to back like the frontend's stream: nothing awaits between the calls.
  const pending = [
    files.save({ url, content: "a\n" }),
    files.append({ url, content: "b\n" }),
    files.append({ url, content: "c\n" }),
  ];
  await Promise.all(pending);
  assert.strictEqual(fs.readFileSync(path.join(dir, "log.txt"), "utf8"), "a\nb\nc\n");
  assert.deepStrictEqual(events.map((e) => e[0]), ["savedURL", "appendedToURL", "appendedToURL"]);
  assert.ok(events.every((e) => e[1] === url));
});

test("append to a url that was never saved is ignored: no file, no event", async () => {
  const { dir, files, events, logs } = makeFiles([]);
  const reply = await files.append({ url: "/etc/passwd", content: "pwned" });
  assert.strictEqual(reply.ok, false);
  assert.deepStrictEqual(events, []);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.match(logs[0], /no saved file/);
});

test("close forgets the handle, so a later append is ignored", async () => {
  const { files, events } = makeFiles(["z.txt"]);
  await files.save({ url: "z", content: "1" });
  await files.close({ url: "z" });
  assert.strictEqual(files.pathOf("z"), null);
  await files.append({ url: "z", content: "2" });
  assert.deepStrictEqual(events.map((e) => e[0]), ["savedURL"]);
});

test("base64 content is decoded to bytes, and a failed write settles the frontend promise", async () => {
  const { dir, files, events, logs } = makeFiles(["bin.dat", path.join("missing-dir", "x")]);
  await files.save({ url: "bin.dat", content: Buffer.from([1, 2, 3, 255]).toString("base64"), isBase64: true });
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, "bin.dat"))], [1, 2, 3, 255]);
  const failed = await files.save({ url: "bad", content: "x" });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.canceled, false);
  assert.deepStrictEqual(events.map((e) => e[0]), ["savedURL", "canceledSaveURL"]);
  assert.match(logs[0], /InspectorFrontendHost\.save\(bad\)/);
});

test("save and append reject a non-string url", async () => {
  const { files, events } = makeFiles([]);
  assert.strictEqual((await files.save({ url: 5, content: "x" })).ok, false);
  assert.strictEqual((await files.append({ url: null, content: "x" })).ok, false);
  assert.strictEqual((await files.save()).ok, false);
  assert.deepStrictEqual(events, []);
});

// ── getHostConfig ────────────────────────────────────────────────────────────
test("the default host config switches off every feature this shell cannot serve", () => {
  const config = buildHostConfig();
  assert.strictEqual(config.aidaAvailability.enabled, false);
  assert.strictEqual(config.aidaAvailability.disallowLogging, true);
  for (const key of [
    "devToolsConsoleInsights",
    "devToolsFreestyler",
    "devToolsAiAssistanceNetworkAgent",
    "devToolsAiAssistanceFileAgent",
    "devToolsAiAssistancePerformanceAgent",
    "devToolsAiGeneratedTimelineLabels",
    "devToolsPrivacyUI",
    "devToolsVeLogging",
  ]) {
    assert.strictEqual(config[key].enabled, false, key);
  }
  assert.strictEqual(config.isOffTheRecord, false);
  // JSON-serializable: it crosses IPC.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(config)), config);
});

test("an override merges one level deep and never mutates the defaults", () => {
  const config = buildHostConfig({
    aidaAvailability: { enabled: true },
    devToolsConsoleInsights: { enabled: true },
    extra: 1,
  });
  assert.strictEqual(config.aidaAvailability.enabled, true);
  assert.strictEqual(config.aidaAvailability.disallowLogging, true, "sibling keys survive");
  assert.strictEqual(config.devToolsConsoleInsights.enabled, true);
  assert.strictEqual(config.extra, 1);
  assert.strictEqual(DEFAULT_HOST_CONFIG.aidaAvailability.enabled, false);
  assert.strictEqual(buildHostConfig().aidaAvailability.enabled, false);
  assert.deepStrictEqual(buildHostConfig("nope"), buildHostConfig());
  assert.deepStrictEqual(buildHostConfig([1]), buildHostConfig());
});
