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
//   - the bytes are staged in a temp file this download created and renamed onto the
//     final name only on success, so a failure removes that temp file and NOTHING the
//     service did not create — a file the user already had at the target name survives
//     a failed fetch, a bad `data:` URL, a failed write and a cancel (GitHub issue #22);
//   - a name that is already taken yields `name (1).ext` (Chrome's default `uniquify`)
//     rather than a silent overwrite, and a symlink at the target is refused rather
//     than followed, which is how a write would leave the downloads directory;
//   - a cancelled download is `interrupted` / `CANCELED`, Chrome's vocabulary;
//   - no id is issued for a save that was refused up front;
//   - one extension's `search`/`erase` never sees another extension's files;
//   - `onDeterminingFilename` never silently overrides an unanswered question.
// GitHub issues #4 and #22; docs/features/SMALL-SHIMS.md.
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
/**
 * A stand-in directory, faithful exactly where the save service's file rules touch it
 * — which is what stops an F2 assertion from passing on a service that clobbers.
 *
 *   - `writeFile` honours `flag: "wx"` the way a real exclusive `open` does: a name that
 *     is already taken, by a file OR a symlink, is refused with EEXIST; a plain write
 *     onto a symlink is recorded as a link FOLLOWED rather than as a file written;
 *   - a failing write leaves the bytes it got behind, as the real disk does, so only a
 *     service that cleans up after itself can take them away;
 *   - `rename` moves bytes that are really there and refuses ones that are not, and
 *     replacing a name takes the link with it — `rename(2)` does not write through one;
 *   - `unlink` and `lstat` fail with ENOENT for a name that is not there, so a test
 *     cannot "prove" a cleanup that removed nothing or a conflict check that never looked.
 */
const memoryFs = (options = {}) => {
  const entries = new Map(); // path -> { data, link: false } | { link: true }
  for (const [target, kind] of Object.entries(options.existing || {})) {
    entries.set(target, kind === "symlink" ? { link: true } : { data: kind });
  }

  const written = []; // every writeFile call: { path, data, options }
  const renamed = []; // every rename call: [from, to]
  const unlinked = []; // every unlink call, whatever it then did or failed to do
  const followed = []; // writes that went through a symlink — there must be none

  const enoent = (verb, target) => {
    const error = new Error(`${verb}: no such file or directory, ${verb} '${target}'`);
    error.code = "ENOENT";
    return error;
  };
  const isThere = (target) => entries.has(target);
  const isLink = (target) => isThere(target) && entries.get(target).link === true;

  return {
    written,
    renamed,
    unlinked,
    followed,
    /** The bytes standing at `target`, or undefined when nothing is. */
    at: (target) => (isThere(target) && !isLink(target) ? entries.get(target).data : undefined),
    exists: isThere,
    isSymlink: isLink,
    /** Every name standing in the directory right now. */
    names: () => [...entries.keys()],
    lstat: async (target) => {
      // A real look at a directory costs a round trip, and the save service's claim rule
      // is only meaningful if it holds ACROSS one: a probe that resolves in the same
      // microtask lets an ordering bug (claim *after* the look) hide behind this fake.
      // So the answer lands a tick late, and any second download looking at the same name
      // is really inside the gap while the first is still looking.
      await new Promise((resolve) => setImmediate(resolve));
      if (!isThere(target)) {
        throw enoent("lstat", target);
      }
      const link = isLink(target);
      return { isSymbolicLink: () => link, isFile: () => !link };
    },
    writeFile: async (target, data, fsOptions) => {
      const exclusive = fsOptions && (fsOptions.flag === "wx" || fsOptions.flag === "ax");
      if (isLink(target)) {
        if (exclusive) {
          // O_CREAT|O_EXCL does not follow the link: the open simply fails.
          const error = new Error(`EEXIST: file already exists, open '${target}'`);
          error.code = "EEXIST";
          throw error;
        }
        followed.push(target);
      } else if (exclusive && isThere(target)) {
        const error = new Error(`EEXIST: file already exists, open '${target}'`);
        error.code = "EEXIST";
        throw error;
      }
      written.push({ path: target, data, options: fsOptions });
      if (options.throwOnWrite) {
        if (!isLink(target)) {
          entries.set(target, { data: "<partial>" });
        }
        throw new Error(options.throwOnWrite);
      }
      if (!isLink(target)) {
        entries.set(target, { data });
      }
    },
    rename: async (from, to) => {
      renamed.push([from, to]);
      if (!isThere(from)) {
        throw enoent("rename", from);
      }
      entries.set(to, entries.get(from));
      entries.delete(from);
    },
    unlink: async (target) => {
      unlinked.push(target);
      if (!isThere(target)) {
        throw enoent("unlink", target);
      }
      entries.delete(target); // an unlink removes the link itself, never its target
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
 *  - `existing` what already stands in the downloads directory (path -> bytes, or
 *    "symlink"); the F2 rules are only testable against a directory that can say no
 *  - `gateWrite` a promise the staged write waits behind, to cancel mid-write
 */
const harness = (options = {}) => {
  const fsFake = memoryFs({ throwOnWrite: options.refuseWrite, existing: options.existing });
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
    writeFile: options.gateWrite
      ? async (target, data, fsOptions) => {
          await options.gateWrite;
          return fsFake.writeFile(target, data, fsOptions);
        }
      : fsFake.writeFile,
    rename: fsFake.rename,
    lstat: fsFake.lstat,
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

  const written = fsFake.written;
  assert.equal(written.length, 1, "the bytes are staged in one file the service created");
  assert.equal(written[0].path, "/Downloads/report.txt.rozenite-partial");
  // The staged write asks for an EXCLUSIVE create, so the guarantee does not rest on this
  // file's own bookkeeping: the kernel refuses a name that is taken, including one an
  // attacker planted between the check and the write, instead of the bytes going through it.
  assert.equal(written[0].options.flag, "wx", "the partial is created, never opened over");
  assert.deepEqual(
    fsFake.renamed,
    [["/Downloads/report.txt.rozenite-partial", "/Downloads/report.txt"]],
    "the staged file is renamed onto the name the download reports"
  );
  assert.equal(fsFake.at("/Downloads/report.txt").toString(), "12345", "the derived name, in the downloads dir");
  assert.equal(fsFake.exists("/Downloads/report.txt.rozenite-partial"), false, "and no partial file is left behind");

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
  assert.equal(plain.fsFake.at("/Downloads/har-export.json"), '{"log":true}');

  const encoded = harness();
  const b = await encoded.service.start({
    owner: "a.local",
    filename: "bytes.bin",
    content: Buffer.from("binary").toString("base64"),
    isBase64: true,
  });
  assert.equal(Buffer.from(encoded.fsFake.at("/Downloads/bytes.bin"), "base64").toString(), "binary");
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
  // The user pointed at this exact name, so this is the one path that is not uniquified.
  assert.deepEqual(
    accepted.fsFake.renamed,
    [["/Users/me/Desktop/taken.txt.rozenite-partial", "/Users/me/Desktop/taken.txt"]],
    "the bytes are staged beside the chosen name and renamed onto it"
  );

  const refused = harness({ noDialog: true });
  const b = await refused.service.start({ owner: "a.local", url: "https://example.com/x.txt", saveAs: true });
  assert.equal(b.ok, true, "Chrome still hands back an id: the download happened, and stopped");
  const item = refused.service.get({ id: b.id });
  assert.equal(item.state, "interrupted");
  assert.equal(item.error, "", "the user said no, which is not an error");
  assert.equal(refused.fsFake.written.length, 0, "nothing was written");
});

test("a data: URL is saved without a network round trip, like Chrome's", async () => {
  const plain = harness();
  const a = await plain.service.start({
    owner: "a.local",
    url: "data:text/plain,hello%20there",
    filename: "inline.txt",
  });
  assert.equal(a.ok, true);
  assert.equal(plain.fsFake.at("/Downloads/inline.txt").toString(), "hello there");
  assert.equal(plain.service.get({ id: a.id }).state, "complete");

  const encoded = harness();
  const b = await encoded.service.start({
    owner: "a.local",
    url: `data:application/pdf;base64,${Buffer.from("pdf-bytes").toString("base64")}`,
    filename: "doc.pdf",
  });
  assert.equal(encoded.fsFake.at("/Downloads/doc.pdf").toString(), "pdf-bytes");
  assert.equal(encoded.service.get({ id: b.id }).totalBytes, 9);

  // The `data` field of chrome.downloads.download is itself a data URL.
  const field = harness();
  await field.service.start({ owner: "a.local", filename: "field.txt", content: "data:text/plain,x" });
  assert.equal(field.fsFake.at("/Downloads/field.txt").toString(), "x");
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
  assert.equal(fsFake.written.length, 0);
  assert.deepEqual(fsFake.unlinked, [], "a download that wrote nothing has no business unlinking anything");
});

// This is the assertion GitHub issue #22 inverts. It used to read
// `assert.deepEqual(fsFake.unlinked, ["/Downloads/big.bin"])`, which pinned the bug: the
// service deleting a file that it had not created. The right shape of the same promise is
// that the bytes the SERVICE wrote are cleaned up, and nothing else is ever touched.
test("a failed write is `interrupted`, and the only unlink is the partial this download staged", async () => {
  const { service, fsFake } = harness({ refuseWrite: "ENOSPC: no space left on device" });
  const started = await service.start({ frameKey: "1:1", owner: "a.local", url: "https://x.test/big.bin" });
  const item = service.get({ id: started.id });
  assert.equal(item.state, "interrupted");
  assert.match(item.error, /ENOSPC/, "the filesystem's message reaches the extension");
  assert.deepEqual(
    fsFake.unlinked,
    ["/Downloads/big.bin.rozenite-partial"],
    "nothing half-written is left behind, and nothing else is unlinked either"
  );
  assert.equal(fsFake.exists("/Downloads/big.bin"), false, "the name the download wanted was never created");
  assert.deepEqual(fsFake.renamed, [], "a failed write is never renamed onto a final name");
});

// ── F2: a failed download must not delete what it did not write (issue #22) ───
/**
 * The four ways the old code reached `removePartial(record.filename)` after the target had
 * been chosen — a rejected fetch, a malformed `data:`, a failing write, a cancel — each one
 * with a file the user put in their Downloads folder themselves. The rule under test is the
 * shell's whole right to delete: it may only ever unlink a file it created in this download.
 */
const failureModes = [
  {
    name: "a rejected fetch",
    options: { fetchError: "404 Not Found" },
    request: { url: "https://x.test/big.bin" },
  },
  {
    name: "a malformed data: URL",
    options: {},
    // No comma at all, so the decode throws — and, before this fix, it threw only after
    // the target had been chosen and recorded, which is how a bad URL deleted a file.
    request: { url: "data:text/plain", filename: "big.bin" },
  },
  {
    name: "a write the filesystem refuses",
    options: { refuseWrite: "ENOSPC: no space left on device" },
    request: { url: "https://x.test/big.bin" },
  },
  {
    name: "a cancel while the bytes are being written",
    options: { gateWrite: true },
    request: { url: "https://x.test/big.bin" },
  },
];

for (const mode of failureModes) {
  test(`F2: ${mode.name} leaves a pre-existing ~/Downloads/big.bin untouched`, async () => {
    const options = { ...mode.options };
    let gateRelease;
    if (mode.options.gateWrite) {
      options.gateWrite = new Promise((resolve) => {
        gateRelease = resolve;
      });
    }
    const { service, fsFake } = harness({
      ...options,
      existing: { "/Downloads/big.bin": "the user's own bytes" },
    });

    const started = service.start({ frameKey: "1:1", owner: "a.local", ...mode.request });
    if (gateRelease) {
      await new Promise((resolve) => setImmediate(resolve));
      await service.cancel({ id: service.list()[0], owner: "a.local" });
      gateRelease();
    }
    const { id } = await started;

    const item = service.get({ id });
    assert.equal(item.state, "interrupted", `${mode.name} is reported as an interruption`);
    assert.equal(
      fsFake.at("/Downloads/big.bin"),
      "the user's own bytes",
      "the file the user put there is exactly as it was"
    );
    for (const path of fsFake.unlinked) {
      assert.equal(
        path.endsWith(".rozenite-partial"),
        true,
        `the only thing this service may unlink is its own partial file, not ${path}`
      );
    }
    assert.equal(
      fsFake.names().filter((name) => !name.endsWith(".rozenite-partial")).length,
      1,
      `the directory holds the user's file and nothing this download left behind: ${JSON.stringify(fsFake.names())}`
    );
  });
}

// ── the name a write lands on (issue #22: Chrome's default is uniquify) ──────
test("a name that is taken yields `name (1).ext` and leaves the original intact", async () => {
  const { service, fsFake } = harness({
    body: "the new download",
    existing: { "/Downloads/report.txt": "the user's own bytes" },
  });
  const started = await service.start({ owner: "a.local", url: "https://x.test/report.txt" });

  const item = service.get({ id: started.id });
  assert.equal(item.state, "complete");
  assert.equal(item.filename, "/Downloads/report (1).txt", "Chrome's spelling: a counter before the extension");
  assert.equal(fsFake.at("/Downloads/report.txt"), "the user's own bytes", "no silent overwrite");
  assert.equal(fsFake.at("/Downloads/report (1).txt").toString(), "the new download");
  assert.deepEqual(fsFake.unlinked, [], "a successful download unlinks nothing");
});

test("the counter keeps counting while names are taken, and a name without an extension gets one too", async () => {
  const { service, fsFake } = harness({
    existing: {
      "/Downloads/report.txt": "one",
      "/Downloads/report (1).txt": "two",
      "/Downloads/report (2).txt": "three",
      "/Downloads/plain": "four",
    },
  });
  const withExtension = await service.start({ owner: "a.local", url: "https://x.test/report.txt" });
  assert.equal(service.get({ id: withExtension.id }).filename, "/Downloads/report (3).txt");

  const withoutExtension = await service.start({ owner: "a.local", url: "https://x.test/plain" });
  assert.equal(service.get({ id: withoutExtension.id }).filename, "/Downloads/plain (1)", "no extension to insert before");
  assert.equal(fsFake.at("/Downloads/report.txt"), "one");
  assert.equal(fsFake.at("/Downloads/report (1).txt"), "two");
  assert.equal(fsFake.at("/Downloads/report (2).txt"), "three");
  assert.equal(fsFake.at("/Downloads/plain"), "four");
});

test("two downloads that want the same name get two files, not one overwritten file", async () => {
  // Neither download has a file to look at when it starts, so the only thing that can keep
  // them apart is deciding the name and renaming under one lock. Without it, both pick
  // `/Downloads/same.txt` and the second renames over the first — the same clobber F2 is,
  // just with a race instead of a delete.
  const { service, fsFake } = harness({ body: "bytes" });
  const both = await Promise.all([
    service.start({ owner: "a.local", url: "https://x.test/same.txt" }),
    service.start({ owner: "a.local", url: "https://x.test/same.txt" }),
  ]);

  const filenames = both.map((started) => service.get({ id: started.id }).filename);
  assert.deepEqual(filenames, ["/Downloads/same.txt", "/Downloads/same (1).txt"]);
  assert.equal(both.every((started) => service.get({ id: started.id }).state === "complete"), true);
  assert.equal(new Set(fsFake.names()).size, fsFake.names().length, "two renames, two files");
});

test("a `saveAs` path the user chose is used as given, not uniquified", async () => {
  // The dialog IS Chrome's conflict prompt: uniquifying a path the user just pointed at
  // would save `proposal (1).pdf` behind their back.
  const { service, fsFake } = harness({
    dialog: { canceled: false, filePath: "/Users/me/Desktop/proposal.pdf" },
  });
  const started = await service.start({ owner: "a.local", url: "https://example.com/proposal.pdf", saveAs: true });
  assert.equal(service.get({ id: started.id }).filename, "/Users/me/Desktop/proposal.pdf");
  assert.deepEqual(fsFake.renamed, [["/Users/me/Desktop/proposal.pdf.rozenite-partial", "/Users/me/Desktop/proposal.pdf"]]);
});

test("a partial file left by an earlier run is stepped around, never unlinked", async () => {
  // A crash mid-download leaves `report.txt.rozenite-partial` in the user's folder. It is
  // bytes this service wrote in some past life, which is not the same as being ours now:
  // the next download stages beside it and leaves it where it is, so the user can still
  // see what was lost rather than have it quietly vanish.
  const { service, fsFake } = harness({
    existing: { "/Downloads/report.txt.rozenite-partial": "bytes from a crashed run" },
  });
  const started = await service.start({ owner: "a.local", url: "https://x.test/report.txt" });

  const item = service.get({ id: started.id });
  assert.equal(item.state, "complete");
  assert.equal(item.filename, "/Downloads/report.txt", "the final name was free and is used");
  assert.equal(
    fsFake.at("/Downloads/report.txt.rozenite-partial"),
    "bytes from a crashed run",
    "the leftover is exactly as the last run left it"
  );
  assert.equal(fsFake.exists("/Downloads/report.txt.1.rozenite-partial"), false);
  assert.deepEqual(
    fsFake.renamed,
    [["/Downloads/report.txt.rozenite-partial.1", "/Downloads/report.txt"]],
    "this download staged under a name of its own"
  );
  assert.deepEqual(fsFake.unlinked, [], "and unlinking someone else's leftover is not on the table");
});

test("an explicit `overwrite` is honored — the one no-prompt name the caller asked to replace", async () => {
  const { service, fsFake } = harness({
    existing: { "/Downloads/report.txt": "the user's own bytes" },
  });
  const started = await service.start({
    owner: "a.local",
    url: "https://x.test/report.txt",
    conflictAction: "overwrite",
  });
  assert.equal(service.get({ id: started.id }).filename, "/Downloads/report.txt");
  assert.equal(fsFake.at("/Downloads/report.txt").toString(), "hello", "replaced, because the caller asked for it");
  assert.equal(fsFake.exists("/Downloads/report (1).txt"), false, "and not uniquified");
  // Even a sanctioned replace arrives atomically: the old bytes survive down the wire
  // until the new ones are complete, because the overwrite happens by rename, not by
  // truncation. A write that named the final file first is the F2 bug wearing a passport.
  assert.deepEqual(
    fsFake.renamed,
    [["/Downloads/report.txt.rozenite-partial", "/Downloads/report.txt"]],
    "the replacement is a rename onto the name, not a write into it"
  );
});

test("a name that is a whole dot is refused, and nothing is created beside it", async () => {
  // `safeName` keeps `.` and `..` (they are not paths), and the old code's write onto one
  // failed with EISDIR. Under uniquify that accident is gone: the name is free once the
  // directory counts as taken, so the dot has to be refused as what it is.
  for (const name of [".", ".."]) {
    const { service, fsFake } = harness();
    const started = await service.start({ owner: "a.local", url: "https://x.test/a.txt", filename: name });
    const item = service.get({ id: started.id });
    assert.equal(item.state, "interrupted", `${name} is refused`);
    assert.match(item.error, /is not a filename/, `and the reason says why: ${item.error}`);
    assert.deepEqual(fsFake.renamed, [], "no rename happened, so no dot-named file appeared");
    assert.deepEqual(fsFake.written, [], "and nothing was even staged — the name is refused before a file is made");
    assert.deepEqual(fsFake.names(), [], "and the directory holds nothing this download made");
  }

  // A name that merely begins with a dot is a real filename and still works.
  const hidden = harness();
  const ok = await hidden.service.start({ owner: "a.local", filename: ".env", content: "A=1" });
  assert.equal(hidden.service.get({ id: ok.id }).state, "complete");
  assert.equal(hidden.fsFake.at("/Downloads/.env"), "A=1");
});

test("a directory the shell cannot look at stops the download rather than releasing its name", async () => {
  // "There is nothing at this name" and "I cannot tell what is at this name" are different
  // answers, and a conflict check that treats them alike is a check that passes whenever the
  // filesystem is having a bad day. Only ENOENT means free.
  const fsFake = memoryFs();
  const probeError = Object.assign(new Error("EACCES: permission denied, lstat '/Downloads/report.txt'"), {
    code: "EACCES",
  });
  const service = createSaveService({
    showSaveDialog: async () => ({ canceled: true }),
    fetchUrl: async () => ({ buffer: Buffer.from("hello") }),
    writeFile: fsFake.writeFile,
    rename: fsFake.rename,
    lstat: async () => {
      throw probeError;
    },
    unlink: fsFake.unlink,
    downloadsDir: () => "/Downloads",
  });

  const started = await service.start({ owner: "a.local", url: "https://x.test/report.txt" });
  const item = service.get({ id: started.id });
  assert.equal(item.state, "interrupted");
  assert.equal(item.error, probeError.message, "the platform's own reason, verbatim");
  assert.deepEqual(fsFake.written, [], "nothing was staged");
  assert.deepEqual(fsFake.renamed, [], "nothing was renamed onto the name it could not inspect");
  assert.deepEqual(fsFake.unlinked, [], "and nothing was deleted on the way out");
});

test("a download that failed while holding a name does not hold it from the next one", async () => {
  // The name claim exists only to cover the gap between choosing a name and renaming onto
  // it. A download that dies before any rename leaves nothing on disk under that name, so a
  // leaked claim would be a name held by a dead download — the next one would find its own
  // name "taken" and write `big (1).bin` for no reason the user could see.
  let attempts = 0;
  const { service, fsFake } = harness({
    fetch: async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("404 Not Found");
      }
      return { buffer: Buffer.from("the retry") };
    },
  });

  const failed = await service.start({ owner: "a.local", url: "https://x.test/big.bin" });
  assert.equal(service.get({ id: failed.id }).state, "interrupted");
  assert.equal(fsFake.exists("/Downloads/big.bin"), false, "nothing was written under the name");

  const retry = await service.start({ owner: "a.local", url: "https://x.test/big.bin" });
  assert.equal(
    service.get({ id: retry.id }).filename,
    "/Downloads/big.bin",
    "the retry gets the plain name: the failed download released its claim"
  );
  assert.equal(service.get({ id: retry.id }).state, "complete");
});

// ── F2's escape hatch: a symlink sitting at the name the download wants ───────
test("a pre-existing symlink at the target name is refused, not followed", async () => {
  const { service, fsFake } = harness({
    existing: { "/Downloads/report.txt": "symlink" },
  });
  const started = await service.start({ owner: "a.local", url: "https://x.test/report.txt" });

  const item = service.get({ id: started.id });
  assert.equal(item.state, "interrupted");
  assert.match(item.error, /symlink/, `the reason says what was refused: ${item.error}`);
  assert.equal(fsFake.followed.length, 0, "not one write went through the link");
  assert.equal(fsFake.isSymlink("/Downloads/report.txt"), true, "the link itself is left as the user had it");
  assert.deepEqual(
    fsFake.renamed.map(([from, to]) => to),
    [],
    "and it is not replaced by a rename either — a rename would take the link with it"
  );
  assert.equal(
    fsFake.exists("/Downloads/report (1).txt"),
    false,
    "refused means refused: it does not quietly land on the next name"
  );
});

test("a symlink at the name is refused even when the caller asked to overwrite it", async () => {
  const { service, fsFake } = harness({
    existing: { "/Downloads/report.txt": "symlink" },
  });
  const started = await service.start({
    owner: "a.local",
    url: "https://x.test/report.txt",
    conflictAction: "overwrite",
  });
  assert.equal(service.get({ id: started.id }).state, "interrupted");
  assert.match(service.get({ id: started.id }).error, /symlink/);
  assert.equal(fsFake.followed.length, 0);
  assert.equal(fsFake.isSymlink("/Downloads/report.txt"), true);
});

test("a symlink at the path a save dialog chose is refused too", async () => {
  const { service, fsFake } = harness({
    dialog: { canceled: false, filePath: "/Users/me/Desktop/notes.txt" },
    existing: { "/Users/me/Desktop/notes.txt": "symlink" },
  });
  const started = await service.start({ owner: "a.local", url: "https://x.test/notes.txt", saveAs: true });
  assert.equal(service.get({ id: started.id }).state, "interrupted");
  assert.match(service.get({ id: started.id }).error, /symlink/);
  assert.equal(fsFake.followed.length, 0);
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
  assert.equal(fsFake.written.length, 0, "the fetch aborted before the write");
  assert.deepEqual(fsFake.unlinked, [], "there was no file of ours to remove, so nothing was unlinked");
});

test("a cancel while the bytes are being written removes the staged file and renames nothing", async () => {
  let releaseWrite;
  const gateWrite = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const { service, fsFake } = harness({
    existing: { "/Downloads/slow.bin": "the user's own bytes" },
    gateWrite,
  });
  const started = service.start({ owner: "a.local", url: "https://x.test/slow.bin" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await service.cancel({ id: service.list()[0], owner: "a.local" }), true);
  releaseWrite();
  await started;

  const item = service.get({ id: (await started).id });
  assert.equal(item.state, "interrupted");
  assert.equal(item.error, CANCELED);
  assert.deepEqual(fsFake.renamed, [], "the staged file never became a final name");
  assert.equal(fsFake.at("/Downloads/slow.bin"), "the user's own bytes");
  assert.deepEqual(
    fsFake.names().filter((name) => name.endsWith(".rozenite-partial")),
    [],
    "the file it staged is cleaned up, and no other partial is left"
  );
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

// ── the tests that touch a real disk ─────────────────────────────────────────
/**
 * A service on the real `fs`, into a real temp dir: nothing stands between issue #22 and
 * the proof. `fetchError` is injectable because the finding is what a FAILED download does.
 */
const realDiskService = (dir, options = {}) =>
  createSaveService({
    showSaveDialog: async () => ({ canceled: true }),
    fetchUrl:
      options.fetchError !== undefined
        ? async () => {
            throw new Error(options.fetchError);
          }
        : async () => ({ buffer: Buffer.from("written for real\n") }),
    writeFile: (target, data, fsOptions) => fs.promises.writeFile(target, data, fsOptions),
    rename: (from, to) => fs.promises.rename(from, to),
    lstat: (target) => fs.promises.lstat(target),
    unlink: (target) => fs.promises.unlink(target),
    downloadsDir: () => dir,
  });

const listing = (dir) => fs.readdirSync(dir).sort();

test("the bytes really land on disk when the filesystem is the real one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-save-"));
  try {
    const service = realDiskService(dir);
    const started = await service.start({ owner: "a.local", url: "https://x.test/real.txt" });
    const target = path.join(dir, "real.txt");
    assert.equal(fs.readFileSync(target, "utf8"), "written for real\n");
    assert.equal(service.get({ id: started.id }).totalBytes, fs.statSync(target).size);

    // Same name again, on the real disk: Chrome's uniquify, not a second write over the
    // first file. And the listing proves the staging is a rename — a leftover partial
    // beside the file would show up here.
    const second = await service.start({ owner: "a.local", url: "https://x.test/real.txt" });
    assert.equal(service.get({ id: second.id }).filename, path.join(dir, "real (1).txt"));
    assert.deepEqual(listing(dir), ["real (1).txt", "real.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// The audit measured F2 against real `fs` ("Pre-existing files at the target name were
// removed after a rejected fetch, after a malformed `data:` URL… A pre-existing symlink was
// followed"), so this is that experiment as a test. The fake proves the rules; this proves
// the rules hold against the syscalls. The symlink's TARGET sits outside the downloads dir,
// which is the escape the fix has to close.
test("F2 on the real disk: nothing a download did not write is deleted, overwritten, or written through", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-f2-"));
  const outside = path.join(os.tmpdir(), `rozenite-f2-target-${path.basename(dir)}.txt`);
  try {
    fs.writeFileSync(outside, "the user's own bytes");
    fs.writeFileSync(path.join(dir, "big.bin"), "the user's own bytes");
    fs.symlinkSync(outside, path.join(dir, "linked.bin"));
    const before = listing(dir);

    const failed = realDiskService(dir, { fetchError: "404 Not Found" });
    const a = await failed.start({ owner: "a.local", url: "https://x.test/big.bin" });
    assert.equal(failed.get({ id: a.id }).state, "interrupted");
    assert.match(failed.get({ id: a.id }).error, /404/, "and the failure is still reported honestly");
    assert.deepEqual(listing(dir), before, "a rejected fetch deleted nothing");

    const malformed = await failed.start({
      owner: "a.local",
      url: "data:text/plain",
      filename: "big.bin",
    });
    assert.equal(failed.get({ id: malformed.id }).state, "interrupted");
    assert.deepEqual(listing(dir), before, "and a malformed data: URL deleted nothing either");

    const symlinks = realDiskService(dir);
    const through = await symlinks.start({
      owner: "a.local",
      url: "https://x.test/linked.bin",
      content: "written by the download",
    });
    const linkedItem = symlinks.get({ id: through.id });
    assert.equal(linkedItem.state, "interrupted", "the link was refused, not written through");
    assert.match(linkedItem.error, /symlink/, `and the reason says so: ${linkedItem.error}`);
    assert.deepEqual(listing(dir), before, "a refused symlink added nothing to the directory");
    assert.equal(
      fs.readFileSync(path.join(dir, "big.bin"), "utf8"),
      "the user's own bytes",
      "the file the user put there is exactly as it was, byte for byte"
    );
    assert.equal(
      fs.readFileSync(outside, "utf8"),
      "the user's own bytes",
      "the file OUTSIDE the downloads dir — the point of the symlink attack — is untouched"
    );
    assert.equal(fs.lstatSync(path.join(dir, "linked.bin")).isSymbolicLink(), true, "and the link is still a link");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(outside, { force: true });
  }
});

test("F2 on the real disk: a download that dies mid-write deletes only the partial it created", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-f2-write-"));
  try {
    fs.writeFileSync(path.join(dir, "big.bin"), "the user's own bytes");
    const service = createSaveService({
      showSaveDialog: async () => ({ canceled: true }),
      fetchUrl: async () => ({ buffer: Buffer.from("new bytes") }),
      // The real filesystem with the failure the audit hit: bytes are on their way and the
      // disk says no. The partial is really on disk by the time this rejects, so the
      // cleanup below has a real file of its own to remove and no excuse to touch another.
      writeFile: async (target, data, fsOptions) => {
        const handle = await fs.promises.open(target, fsOptions && fsOptions.flag ? fsOptions.flag : "w");
        await handle.writeFile("partial-bytes", "utf8");
        await handle.close();
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      },
      rename: (from, to) => fs.promises.rename(from, to),
      lstat: (target) => fs.promises.lstat(target),
      unlink: (target) => fs.promises.unlink(target),
      downloadsDir: () => dir,
    });

    const started = await service.start({ owner: "a.local", url: "https://x.test/big.bin" });
    const item = service.get({ id: started.id });
    assert.equal(item.state, "interrupted");
    assert.match(item.error, /ENOSPC/);
    assert.equal(fs.readFileSync(path.join(dir, "big.bin"), "utf8"), "the user's own bytes");
    assert.deepEqual(listing(dir), ["big.bin"], "its own partial is gone, and nothing else was");
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

  // And it wires the three file capabilities issue #22's rules are built on, because a rule
  // the injected world honours and the real one does not is a rule nobody is under. `lstat`
  // specifically: `stat` answers about what a symlink points AT, so wiring it here would
  // hand the symlink check a fact about someone else's file and report every link as free.
  assert.match(attach, /lstat: \(target\) => fs\.lstat\(target\)/, "the real backend lstats, it does not stat");
  assert.match(attach, /rename: \(from, to\) => fs\.rename\(from, to\)/, "and it renames");
  assert.match(attach, /unlink: \(target\) => fs\.unlink\(target\)/, "and it can clean up its own partial");

  const here = fs.readFileSync(__filename, "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(here, /attachSaveService\s*\(/, "this file never installs it");
  assert.doesNotMatch(here, /getSaveService\s*\(/, "and never builds one by default");
});
