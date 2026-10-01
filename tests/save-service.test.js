// The shell's one save-to-disk path (src/main/save-service.js), under bare Node.
//
// Everything that makes a download report honest lives in this file, so it is all
// injected: the save dialog, the fetch, the filesystem, the clock, the registry
// that onChanged is pushed through, and the context that answers a filename
// question. Nothing here needs Electron, and no write escapes a temp dir.
//
// The invariants under test are the ones that separate a real save from a shim
// that only looks like one:
//   - `complete` only after the write resolved, with the byte count ACTUALLY written;
//   - a failure is `interrupted` with the platform's own message, and the partial
//     file is removed rather than reported as a download;
//   - a cancelled download is `interrupted` / `CANCELED`, Chrome's vocabulary;
//   - no id is issued for a save that was refused up front;
//   - one extension's `search`/`erase` never sees another extension's files;
//   - `onDeterminingFilename` never silently overrides an unanswered question.
// GitHub issue #4; docs/features/SMALL-SHIMS.md.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CANCELED,
  createSaveService,
  deltaFor,
  nameFromUrl,
  safeName,
} = require("../src/main/save-service");

// ── the injected world ───────────────────────────────────────────────────────
/** A filesystem that records instead of writing, plus a real temp dir for one test. */
const memoryFs = (options = {}) => {
  const written = new Map();
  const unlinked = [];
  return {
    written,
    unlinked,
    writeFile: async (target, data, fsOptions) => {
      if (options.throwOnWrite) {
        throw new Error(options.throwOnWrite);
      }
      written.set(target, { data, options: fsOptions });
    },
    unlink: async (target) => {
      unlinked.push(target);
    },
  };
};

/**
 * Build a service with every capability faked.
 *
 * @param {object} options
 *  - `fetch` what fetchUrl resolves/rejects with
 *  - `dialog` what the save dialog replies
 *  - `answer` how a filename question is answered
 *  - `refuseWrite`, `noDialog` shortcuts for the failure paths
 */
const harness = (options = {}) => {
  const fsFake = memoryFs({ throwOnWrite: options.refuseWrite });
  const delivered = [];
  const asked = [];
  let clock = 0;
  const service = createSaveService({
    showSaveDialog: async (dialogOptions) => {
      asked.push(dialogOptions);
      if (options.noDialog) {
        return { canceled: true };
      }
      return options.dialog || { canceled: false, filePath: `/tmp/chosen/${dialogOptions.defaultPath.split("/").pop()}` };
    },
    fetchUrl: async (url) => {
      if (options.fetchError) {
        throw new Error(options.fetchError);
      }
      return options.fetch
        ? options.fetch(url)
        : { buffer: Buffer.from(options.body === undefined ? "hello" : options.body) };
    },
    writeFile: fsFake.writeFile,
    unlink: fsFake.unlink,
    downloadsDir: () => options.downloadsDir || "/Downloads",
    now: () => new Date(1700000000000 + clock++ * 1000).toISOString(),
    contextRegistry: {
      deliver: (frameKey, delivery) => {
        delivered.push({ frameKey, ...delivery });
        return true;
      },
    },
    askContext: options.answer
      ? async (frameKey, delivery) => {
          asked.push({ frameKey, ...delivery });
          return options.answer;
        }
      : null,
    // Short enough that the "extension never answered" path is testable without a
    // 3s wait, and it is injected precisely so the production default is not a test's.
    suggestTimeoutMs: options.suggestTimeoutMs ?? 50,
    log: (message) => logs.push(message),
  });
  const logs = [];
  return { service, fsFake, delivered, asked, logs };
};

// ── naming ───────────────────────────────────────────────────────────────────
test("a filename is derived from the URL, and is never a path", () => {
  assert.equal(nameFromUrl("https://example.com/a/b/report.pdf?v=2"), "report.pdf");
  assert.equal(nameFromUrl("https://example.com"), "example.com");
  assert.equal(nameFromUrl("https://example.com/%F0%9F%93%84.pdf"), "\u{1F4C4}.pdf");
  // A malformed escape must not throw its way out of a download.
  assert.equal(nameFromUrl("https://example.com/%E0%A4%A.pdf"), "%E0%A4%A.pdf");
  // A data URL carries no name: the generic one, not a mime-derived guess.
  assert.equal(nameFromUrl("data:text/plain,hello"), "download");
  // A plain name that is not a URL stays the name it is.
  assert.equal(nameFromUrl("har-export.json"), "har-export.json");

  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Windows\\system32\\drivers\\etc\\hosts"), "hosts");
  assert.equal(safeName("a<b>c|d?e\"f*g\u0000"), "a_b_c_d_e_f_g_");
  assert.equal(safeName("   "), "download");
  assert.equal(safeName("", "fallback.json"), "fallback.json");
});

// ── the happy path ───────────────────────────────────────────────────────────
test("a URL save completes only after the write, with the bytes actually written", async () => {
  const { service, fsFake, delivered } = harness({ body: "12345" });
  const started = await service.start({
    frameKey: "1:1",
    owner: "a.local",
    url: "https://example.com/files/report.txt",
  });

  assert.equal(started.ok, true);
  assert.equal(typeof started.id, "number", "an id was allocated and is tracked");
  assert.deepEqual(service.list(), [started.id]);

  const written = [...fsFake.written.entries()];
  assert.equal(written.length, 1);
  assert.equal(written[0][0], "/Downloads/report.txt", "the derived name, in the downloads dir");

  const item = service.get({ id: started.id });
  assert.equal(item.state, "complete");
  assert.equal(item.totalBytes, 5, "the byte count that was written, not the one requested");
  assert.notEqual(item.endTime, "", "a finished download has an endTime");
  assert.ok(!("frameKey" in item) && !("owner" in item), "host routing detail stays out of DownloadItem");

  const states = delivered
    .filter((d) => d.kind === "download" && d.payload.event === "changed")
    .map((d) => d.payload.download.state);
  assert.deepEqual(states, ["in_progress", "in_progress", "complete"]);
  assert.deepEqual(
    delivered.map((d) => d.frameKey),
    ["1:1", "1:1", "1:1"],
    "onChanged went to the context that started the download, and nowhere else"
  );
});

test("a delta reports a transition, and only a transition", async () => {
  const { service, delivered } = harness();
  const { id } = await service.start({ frameKey: "1:1", owner: "a.local", url: "https://x.test/a.txt" });
  const changes = delivered.filter((d) => d.payload.event === "changed");
  const last = changes[changes.length - 1].payload.delta;

  assert.equal(last.id, id);
  assert.deepEqual(last.state, { previous: "in_progress", current: "complete" });
  assert.ok(!last.filename, "the path was already reported, so the finish delta does not repeat it");
  assert.ok(!last.error, "a successful download reports no error");

  const filenameChange = changes
    .map((entry) => entry.payload.delta)
    .filter((delta) => delta.filename);
  assert.equal(filenameChange.length, 1, "the chosen path is reported exactly once, when it becomes known");
  assert.equal(filenameChange[0].filename.previous, "");
  assert.equal(filenameChange[0].filename.current, "/Downloads/a.txt");

  // And the first delta of a download carries `current` only — there is no previous
  // state to name, which is exactly how Chrome's first onChanged of a download reads.
  assert.deepEqual(deltaFor(null, { id: 1, state: "in_progress", filename: "", error: "" }), {
    id: 1,
    state: { current: "in_progress" },
  });
  assert.deepEqual(deltaFor({ state: "in_progress", filename: "", error: "" }, { id: 1, state: "in_progress", filename: "", error: "" }), {
    id: 1,
  }, "no transition, no property");
});

test("a content save writes what it was given, base64 or plain", async () => {
  const plain = harness();
  const a = await plain.service.start({
    owner: "a.local",
    filename: "har-export.json",
    content: '{"log":true}',
  });
  assert.equal(a.ok, true);
  assert.equal(plain.service.get({ id: a.id }).state, "complete");
  assert.equal([...plain.fsFake.written.keys()][0], "/Downloads/har-export.json");
  assert.equal([...plain.fsFake.written.values()][0].data, '{"log":true}');

  const encoded = harness();
  const b = await encoded.service.start({
    owner: "a.local",
    filename: "bytes.bin",
    content: Buffer.from("binary").toString("base64"),
    isBase64: true,
  });
  assert.equal(Buffer.from([...encoded.fsFake.written.values()][0].data, "base64").toString(), "binary");
  assert.equal(encoded.service.get({ id: b.id }).totalBytes, 6);
});

test("saveAs asks the user, and a refusal is an interruption with no error", async () => {
  const accepted = harness({ dialog: { canceled: false, filePath: "/Users/me/Desktop/taken.txt" } });
  const a = await accepted.service.start({
    owner: "a.local",
    url: "https://example.com/proposal.pdf",
    saveAs: true,
    title: "Export proposal",
  });
  assert.equal(accepted.asked.length, 1, "the dialog was really opened");
  assert.match(accepted.asked[0].defaultPath, /Downloads\/proposal\.pdf$/, "Chrome's default: the suggested name");
  assert.equal(accepted.service.get({ id: a.id }).filename, "/Users/me/Desktop/taken.txt");
  assert.equal(accepted.service.get({ id: a.id }).state, "complete");

  const refused = harness({ noDialog: true });
  const b = await refused.service.start({ owner: "a.local", url: "https://example.com/x.txt", saveAs: true });
  assert.equal(b.ok, true, "Chrome still hands back an id: the download happened, and stopped");
  const item = refused.service.get({ id: b.id });
  assert.equal(item.state, "interrupted");
  assert.equal(item.error, "", "the user said no, which is not an error");
  assert.equal(refused.fsFake.written.size, 0, "nothing was written");
});

test("a data: URL is saved without a network round trip, like Chrome's", async () => {
  const plain = harness();
  const a = await plain.service.start({
    owner: "a.local",
    url: "data:text/plain,hello%20there",
    filename: "inline.txt",
  });
  assert.equal(a.ok, true);
  assert.equal([...plain.fsFake.written.values()][0].data.toString(), "hello there");
  assert.equal(plain.service.get({ id: a.id }).state, "complete");

  const encoded = harness();
  const b = await encoded.service.start({
    owner: "a.local",
    url: `data:application/pdf;base64,${Buffer.from("pdf-bytes").toString("base64")}`,
    filename: "doc.pdf",
  });
  assert.equal([...encoded.fsFake.written.values()][0].data.toString(), "pdf-bytes");
  assert.equal(encoded.service.get({ id: b.id }).totalBytes, 9);

  // The `data` field of chrome.downloads.download is itself a data URL.
  const field = harness();
  await field.service.start({ owner: "a.local", filename: "field.txt", content: "data:text/plain,x" });
  assert.equal([...field.fsFake.written.values()][0].data.toString(), "x");
});

// ── the failure paths ────────────────────────────────────────────────────────
test("a failed fetch is `interrupted` with the platform's message, not a fake success", async () => {
  const { service, fsFake } = harness({ fetchError: "404 Not Found" });
  const started = await service.start({ frameKey: "1:1", owner: "a.local", url: "https://x.test/gone.txt" });
  assert.equal(started.ok, true, "the id is real: the download was created and then failed");
  const item = service.get({ id: started.id });
  assert.equal(item.state, "interrupted");
  assert.equal(item.error, "404 Not Found", "the platform's own reason, verbatim");
  assert.equal(item.totalBytes, undefined, "no bytes were written");
  assert.equal(fsFake.written.size, 0);
});

test("a failed write is `interrupted` and the partial file is removed", async () => {
  const { service, fsFake } = harness({ refuseWrite: "ENOSPC: no space left on device" });
  const started = await service.start({ frameKey: "1:1", owner: "a.local", url: "https://x.test/big.bin" });
  const item = service.get({ id: started.id });
  assert.equal(item.state, "interrupted");
  assert.match(item.error, /ENOSPC/, "the filesystem's message reaches the extension");
  assert.deepEqual(fsFake.unlinked, ["/Downloads/big.bin"], "nothing half-written is left behind");
});

test("a request with neither url nor content is refused before an id exists", async () => {
  const { service } = harness();
  const refused = await service.start({ owner: "a.local" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /url or body\/content is required/);
  assert.deepEqual(service.list(), [], "no id was allocated for a save that never started");
});

test("cancel stops an active download and removes the file it had written", async () => {
  let releaseFetch;
  const gate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const { service, fsFake } = harness({
    fetch: async () => {
      await gate;
      return { buffer: Buffer.from("partial") };
    },
  });
  const started = service.start({ frameKey: "1:1", owner: "a.local", url: "https://x.test/slow.bin" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    await service.cancel({ id: 4242, owner: "a.local" }),
    false,
    "an unknown id is not cancellable, and Chrome resolves rather than throws"
  );

  const id = service.list()[0];
  assert.equal(await service.cancel({ id, owner: "a.local" }), true);
  releaseFetch();
  await started;

  const item = service.get({ id });
  assert.equal(item.state, "interrupted");
  assert.equal(item.error, CANCELED, "Chrome's own vocabulary for a cancelled download");
  assert.equal(fsFake.written.size, 0, "the fetch aborted before the write");
});

// ── per-extension scoping ────────────────────────────────────────────────────
test("one extension cannot see, cancel, or erase another extension's downloads", async () => {
  const { service } = harness({ body: "abc" });
  const mine = await service.start({ frameKey: "1:1", owner: "a.local", url: "https://x.test/mine.txt" });
  const theirs = await service.start({
    frameKey: "2:2",
    owner: "b.local",
    url: "https://x.test/theirs.txt",
  });

  assert.deepEqual(
    service.search({ owner: "a.local" }).map((item) => item.id),
    [mine.id],
    "`search` is scoped to the caller"
  );
  assert.deepEqual(service.search({ owner: "b.local" }).map((i) => i.id), [theirs.id]);
  assert.equal(service.search({ owner: "c.local" }).length, 0, "an extension with no downloads sees none");
  assert.equal(
    service.search({}).length,
    2,
    "the host itself (the DevTools frontend's own save path) is the only cross-extension caller"
  );

  assert.deepEqual(service.erase({ ids: [theirs.id], owner: "a.local" }), {
    id: [],
    url: [],
    filename: [],
  }, "erasing another extension's entry is refused, and reported as nothing erased");
  const ownErase = service.erase({ ids: [mine.id], owner: "a.local" });
  assert.deepEqual(ownErase.id, [mine.id]);
  assert.deepEqual(ownErase.filename, ["/Downloads/mine.txt"], "Chrome's EraseResults names what it erased");
  assert.equal(service.get({ id: mine.id }), null, "erased means gone from this shell's registry");
  assert.equal(service.search({ owner: "b.local" }).length, 1, "the other extension still has its own");
});

test("erase refuses a running download, like Chrome does", async () => {
  let releaseFetch;
  const gate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const { service } = harness({
    fetch: async () => {
      await gate;
      return { buffer: Buffer.from("x") };
    },
  });
  const started = service.start({ owner: "a.local", url: "https://x.test/running.bin" });
  await new Promise((resolve) => setImmediate(resolve));
  const id = service.list()[0];
  assert.deepEqual(service.erase({ ids: [id], owner: "a.local" }).id, [], "still in progress: nothing erased");
  releaseFetch();
  await started;
  assert.deepEqual(service.erase({ ids: [id], owner: "a.local" }).id, [id]);
});

test("search filters on what this shell really knows, and never on what it does not", async () => {
  const { service } = harness({ body: "abcdef" });
  const done = await service.start({ owner: "a.local", url: "https://x.test/a.log" });
  await service.start({ owner: "a.local", url: "https://x.test/b.log" });

  assert.equal(service.search({ owner: "a.local", query: { id: done.id } }).length, 1);
  assert.equal(service.search({ owner: "a.local", query: { state: "complete" } }).length, 2);
  assert.equal(service.search({ owner: "a.local", query: { state: "interrupted" } }).length, 0);
  assert.equal(service.search({ owner: "a.local", query: { filenamePrefix: "/Downloads/a" } }).length, 1);
  assert.equal(service.search({ owner: "a.local", query: { limit: 1 } }).length, 1);
  assert.equal(
    service.search({ owner: "a.local", query: { startedBefore: new Date(2100, 0).toISOString() } }).length,
    2,
    "Chrome's startTime-style filter is honoured against the timestamp this shell recorded"
  );
  assert.equal(service.search({ owner: "a.local", query: { startedBefore: "1970-01-01" } }).length, 0);
  assert.equal(
    service.search({ owner: "a.local", query: { danger: "file" } }).length,
    2,
    "a filter this shell cannot answer (Chrome's `danger`) is ignored rather than matching nothing — the shim reports that gap"
  );
});

// ── onDeterminingFilename ────────────────────────────────────────────────────
test("an extension's filename suggestion is used", async () => {
  const { service, asked } = harness({ answer: { suggestion: "renamed-by-extension.txt" } });
  const started = await service.start({ frameKey: "9:9", owner: "a.local", url: "https://x.test/original.txt" });
  assert.equal(asked[0].payload.event, "determiningFilename");
  assert.equal(asked[0].frameKey, "9:9", "only the creating context is asked");
  assert.equal(service.get({ id: started.id }).filename, "/Downloads/renamed-by-extension.txt");
});

test("an unanswered question keeps the derived name and says so", async () => {
  const { service, logs } = harness({ answer: { timedOut: true } });
  const started = await service.start({ owner: "a.local", frameKey: "9:9", url: "https://x/test/keep.txt" });
  assert.equal(service.get({ id: started.id }).filename, "/Downloads/keep.txt");
  assert.equal(
    logs.some((line) => /never answered/.test(line)),
    true,
    "the shell reports that it decided the name itself rather than pretending the extension chose it"
  );
});

test("with no context to ask, no question is posed and no timeout is waited", async () => {
  const { service, asked } = harness({ answer: { suggestion: "ignored.txt" } });
  const started = await service.start({ owner: "a.local", url: "https://x.test/frontend-save.txt" });
  assert.equal(asked.length, 0, "the frontend's own save has no extension to ask");
  assert.equal(service.get({ id: started.id }).filename, "/Downloads/frontend-save.txt");
});

test("an explicit filename skips the suggestion step Chrome skips", async () => {
  const { service, asked } = harness({ answer: { suggestion: "should-not-be-used.txt" } });
  const started = await service.start({
    frameKey: "9:9",
    owner: "a.local",
    url: "https://x.test/a.txt",
    filename: "asked-for.txt",
  });
  assert.equal(asked.length, 0, "Chrome does not ask when the caller named the file");
  assert.equal(service.get({ id: started.id }).filename, "/Downloads/asked-for.txt");
});

// ── the one test that touches a real disk ────────────────────────────────────
test("the bytes really land on disk when the filesystem is the real one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-save-"));
  try {
    const service = createSaveService({
      showSaveDialog: async () => ({ canceled: true }),
      fetchUrl: async () => ({ buffer: Buffer.from("written for real\n") }),
      writeFile: (target, data, options) => fs.promises.writeFile(target, data, options),
      unlink: (target) => fs.promises.unlink(target),
      downloadsDir: () => dir,
    });
    const started = await service.start({ owner: "a.local", url: "https://x.test/real.txt" });
    const target = path.join(dir, "real.txt");
    assert.equal(fs.readFileSync(target, "utf8"), "written for real\n");
    assert.equal(service.get({ id: started.id }).totalBytes, fs.statSync(target).size);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── no Electron-backed defaults in a test run ────────────────────────────────
// ── no Electron-backed defaults in a test run ────────────────────────────────
test("this suite never builds the Electron-backed save service", () => {
  // The injected-deps rule, asserted rather than promised: `attachSaveService()`
  // with no overrides reaches for Electron's `dialog` and the user's real
  // `~/Downloads`, and a test that called it could raise a save dialog on the
  // developer's machine and write into their Downloads folder.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "save-service.js"), "utf8");
  const attach = source.slice(source.indexOf("const attachSaveService"));
  assert.match(attach, /require\("electron"\)/, "the real backend exists and is Electron-backed");
  assert.match(attach, /os\.homedir\(\), "Downloads"/, "and points at the user's Downloads folder");

  const here = fs.readFileSync(__filename, "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(here, /attachSaveService\s*\(/, "this file never installs it");
  assert.doesNotMatch(here, /getSaveService\s*\(/, "and never builds one by default");
});
