// `chrome.downloads`' Chrome-shaped surface (src/chrome-shim/downloads.js).
//
// The save service decides what happens to bytes; this file decides what the
// extension SEES, and the honesty rules that matter most are here:
//   - an id appears only when the host allocated one;
//   - a refused save rejects the call with the host's reason rather than returning
//     a number that later "searches" as if it had been written;
//   - `onDeterminingFilename` keeps Chrome's two-step contract: nothing is decided
//     until the extension's callback runs, and the callback may run once;
//   - with NO listener the download proceeds immediately (Chrome's rule), which is
//     answered here rather than by letting the host wait out its timeout;
//   - a call that does nothing says so, because a silent no-op reads as a success.
const test = require("node:test");
const assert = require("node:assert");

const { createDownloads } = require("../src/chrome-shim/downloads");

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @param {object} overrides injected host capabilities
 * @returns {{downloads: object, calls: object, unsupported: string[], suggestions: array}}
 */
const setup = (overrides = {}) => {
  const calls = { start: [], cancel: [], erase: [], search: [] };
  const unsupported = [];
  const suggestions = [];
  const downloads = createDownloads({
    start: async (request) => {
      calls.start.push(request);
      return overrides.startReply || { ok: true, id: 7 };
    },
    cancel: async (id) => {
      calls.cancel.push(id);
      return overrides.cancelReply === undefined ? true : overrides.cancelReply;
    },
    erase: async (ids) => {
      calls.erase.push(ids);
      return overrides.eraseReply || { id: ids, url: ["https://x.test/a.txt"], filename: ["/Downloads/a.txt"] };
    },
    search: async (query) => {
      calls.search.push(query);
      return overrides.searchReply === undefined ? [{ id: 7 }] : overrides.searchReply;
    },
    onUnsupported: (message) => unsupported.push(message),
    respondSuggestion: (requestId, suggestion) => suggestions.push({ requestId, suggestion }),
    ...overrides,
  });
  return { downloads, calls, unsupported, suggestions };
};

// ── download() ───────────────────────────────────────────────────────────────
test("download resolves the id the host allocated, and nothing else", async () => {
  const { downloads, calls } = setup();
  const id = await downloads.download({ url: "https://example.com/a.txt", filename: "renamed.txt" });
  assert.equal(id, 7, "the host's id, verbatim");
  assert.deepEqual(calls.start[0], {
    url: "https://example.com/a.txt",
    content: undefined,
    filename: "renamed.txt",
    saveAs: false,
    title: undefined,
  });
});

test("download's callback style gets the same id, and no promise is double-handed", async () => {
  const { downloads } = setup();
  const seen = await new Promise((resolve) => downloads.download({ url: "https://example.com/a.txt" }, resolve));
  assert.equal(seen, 7);
});

test("a refused save rejects with the host's reason and hands back no id", async () => {
  const { downloads } = setup({ startReply: { ok: false, error: "downloads: permission 'downloads' is not declared" } });
  await assert.rejects(() => downloads.download({ url: "https://example.com/a.txt" }), /not declared/);

  // …and the callback style reports it as an error rather than as `undefined`.
  const asCallback = await new Promise((resolve) => {
    downloads.download({ url: "https://example.com/a.txt" }, (id, error) => resolve({ id, error }));
  });
  assert.equal(asCallback.id, undefined, "no id is handed to a callback for a save that did not happen");
  assert.match(asCallback.error.message, /not declared/);
});

test("with no save backend in this context, download fails loudly", async () => {
  const { downloads, unsupported } = setup();
  const bare = createDownloads({ onUnsupported: (m) => unsupported.push(m) });
  await assert.rejects(() => bare.download({ url: "https://example.com/a.txt" }), /no save backend/);
  assert.equal(unsupported.length, 1);
  assert.match(unsupported[0], /nothing was written/);
});

test("Chrome's `body` becomes the file's content, and that is reported", async () => {
  const { downloads, calls, unsupported } = setup();
  await downloads.download({ url: "https://example.com/api", body: "query={me}" });
  assert.equal(calls.start[0].content, "query={me}");
  assert.equal(
    unsupported.some((m) => /`method` is ignored/.test(m)),
    false,
    "`method` was not asked for, so nothing is claimed about it"
  );

  await downloads.download({ url: "https://example.com/api", method: "POST", body: "x" });
  assert.equal(
    unsupported.some((m) => /`method` is ignored/.test(m)),
    true,
    "a POST Chrome would send is reported, not quietly turned into a file"
  );
});

test("a call that does nothing says so once, not silently and not repeatedly", async () => {
  const { downloads, unsupported } = setup();
  await downloads.show(7);
  await downloads.show(7);
  await downloads.showDefaultFolder();
  const shelf = unsupported.filter((m) => /no download shelf/.test(m));
  assert.equal(shelf.length, 2, "show and showDefaultFolder, one report each");
});

test("a query field the host cannot filter on is reported, not silently ignored", async () => {
  const { downloads, unsupported } = setup();
  await downloads.search({ danger: "FILE" });
  assert.equal(
    unsupported.some((m) => /"danger" is not implemented and was ignored/.test(m)),
    true,
    "results may include a download Chrome would have excluded — so the shim says it"
  );
  await downloads.search({ state: "complete" });
  assert.equal(
    unsupported.filter((m) => /is not implemented/.test(m)).length,
    1,
    "a supported field is not reported as unsupported"
  );
});

test("search/erase/cancel report the host's answer", async () => {
  const { downloads, calls } = setup();
  assert.deepEqual(await downloads.search({ id: 7 }), [{ id: 7 }]);
  assert.deepEqual(calls.search[0], { id: 7 });

  const erased = await downloads.erase({ ids: [7] });
  assert.deepEqual(erased, { id: [7], url: ["https://x.test/a.txt"], filename: ["/Downloads/a.txt"] });

  assert.equal(await downloads.cancel(7), true);
  assert.equal(await downloads.cancel("not a number"), true, "the host decides; the shim does not invent a rule");

  const withNoBackend = createDownloads({});
  assert.deepEqual(await withNoBackend.search({}), [], "no backend means no tracked downloads, not a fake list");
  assert.equal(await withNoBackend.cancel(1), false);
  assert.deepEqual(await withNoBackend.erase({ ids: [1] }), { id: [], url: [], filename: [] });
});

// ── onDeterminingFilename ────────────────────────────────────────────────────
test("with no listener registered, the download proceeds at once", async () => {
  const { downloads, suggestions } = setup();
  const consumed = downloads._onDelivery({
    kind: "download",
    payload: { event: "determiningFilename", requestId: "req-1", download: { id: 7 } },
  });
  assert.equal(consumed, true);
  assert.deepEqual(suggestions, [{ requestId: "req-1", suggestion: null }], "answered immediately, not at the timeout");
});

test("a listener's suggestion reaches the host, and only once", async () => {
  const { downloads, suggestions } = setup();
  downloads.onDeterminingFilename.addListener((download, suggest) => {
    suggest(`${download.id}-chosen.txt`);
    // Chrome's callback may be invoked once; a second call is a no-op rather than a
    // second answer that could overwrite the first.
    suggest("too-late.txt");
  });
  downloads._onDelivery({
    kind: "download",
    payload: { event: "determiningFilename", requestId: "req-2", download: { id: 7 } },
  });
  assert.deepEqual(suggestions, [{ requestId: "req-2", suggestion: "7-chosen.txt" }]);
});

test("an asynchronous suggestion is not pre-empted by an auto-answer", async () => {
  const { downloads, suggestions } = setup();
  downloads.onDeterminingFilename.addListener((download, suggest) => {
    // The common real case: the extension asks the user, or derives a name.
    setTimeout(() => suggest("eventually.txt"), 10);
  });
  downloads._onDelivery({
    kind: "download",
    payload: { event: "determiningFilename", requestId: "req-3", download: { id: 7 } },
  });
  await nextTick();
  assert.deepEqual(suggestions, [], "nothing is answered for a listener that is still working");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(suggestions, [{ requestId: "req-3", suggestion: "eventually.txt" }]);
});

test("a listener that calls back with no argument means `use the default name`", async () => {
  const { downloads, suggestions } = setup();
  downloads.onDeterminingFilename.addListener((download, suggest) => suggest());
  downloads._onDelivery({
    kind: "download",
    payload: { event: "determiningFilename", requestId: "req-4", download: { id: 7 } },
  });
  assert.deepEqual(suggestions, [{ requestId: "req-4", suggestion: null }]);
});

test("onChanged carries the host's delta and download", async () => {
  const { downloads } = setup();
  const seen = [];
  downloads.onChanged.addListener((delta, download) => seen.push({ delta, download }));
  const consumed = downloads._onDelivery({
    kind: "download",
    payload: { event: "changed", delta: { id: 7, state: { previous: "in_progress", current: "complete" } }, download: { id: 7 } },
  });
  assert.equal(consumed, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].delta.state.current, "complete");
  assert.equal(seen[0].download.id, 7);
});

test("anything that is not a download delivery is left for the router", () => {
  const { downloads } = setup();
  assert.equal(downloads._onDelivery({ kind: "message", payload: {} }), false);
  assert.equal(downloads._onDelivery({ kind: "download", payload: { event: "unknown" } }), false);
  assert.equal(downloads._onDelivery(null), false);
});

test("the shim's host hooks stay out of the exposed namespace", () => {
  const raw = setup().downloads;
  assert.equal(typeof raw._onDelivery, "function");
  const { gateCallbackNamespace } = require("../src/chrome-shim/permission-gate");
  const exposed = gateCallbackNamespace(raw, {
    api: "downloads",
    check: () => ({ ok: true }),
    setLastError: () => {},
  });
  assert.ok(!("_onDelivery" in exposed), "chrome.downloads._onDelivery is not page-visible API");
  assert.deepEqual(
    Object.keys(exposed).sort(),
    ["cancel", "download", "erase", "onChanged", "onDeterminingFilename", "search", "show", "showDefaultFolder"],
    "the Chrome surface, in full"
  );
});

test("a denied permission fails every method with lastError and leaves the shape", async () => {
  const { gateCallbackNamespace } = require("../src/chrome-shim/permission-gate");
  let lastError;
  const denied = gateCallbackNamespace(setup().downloads, {
    api: "downloads",
    check: () => ({ ok: false, permission: "downloads", error: "permission 'downloads' is not declared" }),
    setLastError: (value) => {
      lastError = value;
    },
  });
  await assert.rejects(() => denied.download({ url: "https://example.com/a.txt" }), /'downloads' is not declared/);
  // Chrome's scoping: lastError is readable DURING the callback and cleared after it.
  const seen = await new Promise((resolve) =>
    denied.search({}, function () {
      resolve(lastError);
    })
  );
  assert.match(String(seen && seen.message), /'downloads' is not declared/);
  await new Promise((resolve) => denied.search({}, resolve));
  assert.equal(lastError, null, "and it is cleared again, like Chrome's");
});
