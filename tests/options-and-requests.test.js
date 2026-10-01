// `runtime.openOptionsPage()` (src/main/options-host.js) and the one-context request
// queue (src/main/context-request.js), under bare Node.
//
// Both exist because of the same honesty problem: a verdict or an answer that only
// someone else can give. The manifest on disk decides whether an options page
// exists, so an in-frame guess would be a fabrication; a filename suggestion must
// come from the context that was asked, so a reply accepted from anyone would be a
// fabrication too.
//
// GitHub issue #4; docs/features/SMALL-SHIMS.md.
const test = require("node:test");
const assert = require("node:assert");

const {
  NO_PAGE,
  createOptionsHost,
  optionsPageOf,
} = require("../src/main/options-host");
const { createRequestQueue } = require("../src/main/context-request");

// ── the manifest is the whole authority ──────────────────────────────────────
test("an options page is read the way Chrome reads it", () => {
  assert.deepEqual(optionsPageOf({ options_ui: { page: "src/options.html" } }), {
    page: "src/options.html",
    openInTab: false,
  });
  assert.deepEqual(optionsPageOf({ options_ui: { page: "o.html", open_in_tab: true } }), {
    page: "o.html",
    openInTab: true,
  });
  // The older bare-string spelling is still in the wild.
  assert.deepEqual(optionsPageOf({ options_ui: "options.html" }), {
    page: "options.html",
    openInTab: false,
  });
  // Declaring options_ui without a page is not an options page.
  assert.equal(optionsPageOf({ options_ui: { open_in_tab: true } }), null);
  assert.equal(optionsPageOf({}), null);
  assert.equal(optionsPageOf(null), null);
  assert.equal(optionsPageOf({ options_ui: 42 }), null);
  // `chrome_url_overrides` and `options_page` are different features and are not
  // quietly accepted as an options page.
  assert.equal(optionsPageOf({ chrome_url_overrides: { newtab: "n.html" } }), null);
});

const optionsHarness = ({ manifest = {}, openWindow = async () => 101, buildUrl = (id, p) => `rozenite://${id}/${p}` } = {}) => {
  const opened = [];
  const closed = [];
  const logs = [];
  const host = createOptionsHost({
    readManifest: () => manifest,
    buildUrl,
    openWindow: async (url, options) => {
      opened.push({ url, options });
      return openWindow(url, options);
    },
    closeWindow: (handle) => {
      closed.push(handle);
      return true;
    },
    log: (message) => logs.push(message),
  });
  return { host, opened, closed, logs };
};

test("an extension with no options_ui is told so, and no window is opened", async () => {
  const { host, opened } = optionsHarness({ manifest: { name: "no options here" } });
  const reply = await host.openOptionsPage("plain.local");
  assert.deepEqual(reply, NO_PAGE("plain.local"));
  assert.match(reply.error, /does not declare options_ui/);
  assert.deepEqual(opened, [], "a resolved no-op would leave an extension waiting for a window that never comes");
  assert.deepEqual(host.list(), []);
});

test("a declared options page opens a window over the extension's own URL", async () => {
  const { host, opened } = optionsHarness({ manifest: { options_ui: { page: "src/options.html" } } });
  const reply = await host.openOptionsPage("altair");
  assert.equal(reply.ok, true);
  assert.equal(reply.url, "rozenite://altair/src/options.html");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, "rozenite://altair/src/options.html");
  assert.match(opened[0].options.title, /altair options/);
  assert.deepEqual(host.list(), ["altair"], "the host tracks the window it opened");
});

test("open_in_tab is reported rather than silently dropped", async () => {
  const inTab = optionsHarness({ manifest: { options_ui: { page: "o.html", open_in_tab: true } } });
  const reply = await inTab.host.openOptionsPage("ext.local");
  assert.equal(reply.openInTab, true);
  // This shell has no browser tab to open it in; the difference is stated in the
  // window's own title rather than being pretended away.
  assert.match(inTab.opened[0].options.title, /manifest requests open_in_tab/);

  const popup = optionsHarness({ manifest: { options_ui: { page: "o.html" } } });
  await popup.host.openOptionsPage("ext.local");
  assert.doesNotMatch(popup.opened[0].options.title, /open_in_tab/, "and only when the manifest asked for it");
});

test("a page the file server refuses gets no window", async () => {
  const { host, opened } = optionsHarness({
    manifest: { options_ui: { page: "../../etc/passwd" } },
    buildUrl: () => null,
  });
  const reply = await host.openOptionsPage("evil.local");
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not a file this extension serves/);
  assert.deepEqual(opened, [], "no window is opened on a 404");
});

test("a manifest that cannot be read is the same answer as no options_ui", async () => {
  const { host, opened } = optionsHarness();
  const throwing = createOptionsHost({
    readManifest: () => {
      throw new Error("manifest unreadable");
    },
    openWindow: async () => 1,
    buildUrl: (id, p) => `rozenite://${id}/${p}`,
  });
  const reply = await throwing.openOptionsPage("broken.local");
  assert.equal(reply.ok, false);
  assert.equal(host.pageOf("x"), null);
  assert.equal(throwing.pageOf("broken.local"), null, "pageOf does not throw either");
  assert.deepEqual(opened, []);
});

test("a window the OS refuses is reported as a failure", async () => {
  const { host } = optionsHarness({ manifest: { options_ui: { page: "o.html" } }, openWindow: async () => null });
  const reply = await host.openOptionsPage("ext.local");
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Could not open a window/);
  assert.deepEqual(host.list(), [], "a window that does not exist is not tracked as open");
});

test("a second open focuses the tracked window instead of stacking a second one", async () => {
  const { host, opened, closed, logs } = optionsHarness({ manifest: { options_ui: { page: "o.html" } } });
  await host.openOptionsPage("ext.local");
  const second = await host.openOptionsPage("ext.local");
  assert.equal(second.ok, true);
  assert.equal(opened.length, 2, "the shell's only focus affordance is opening it again");
  assert.equal(logs.filter((l) => /already open; focusing/.test(l)).length, 1, "and it says so");
  host.closeAll();
  assert.deepEqual(closed, [101], "closeAll closes the handle it was given");
  assert.deepEqual(host.list(), []);
  host.closeAll();
  assert.deepEqual(closed, [101], "twice is harmless");
});

test("the Electron-backed options host is never built by this suite", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "options-host.js"), "utf8");
  const attach = source.slice(source.indexOf("const attachOptionsHost"));
  assert.match(attach, /require\("electron"\)/, "the real opener is Electron-backed");
  assert.match(attach, /extensionFramePreferences/, "and gives an options page no more privileges than a panel");
  assert.match(attach, /resolveExtensionFile/, "with the file server's containment rules");
  const here = fs.readFileSync(__filename, "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(here, /attachOptionsHost\s*\(/);
  assert.doesNotMatch(here, /getOptionsHost\s*\(/);
});

// ── asking one context and waiting for THAT answer ───────────────────────────
const queueHarness = (overrides = {}) => {
  const sent = [];
  const queue = createRequestQueue({
    deliver: (frameKey, delivery) => {
      sent.push({ frameKey, ...delivery });
      return overrides.deliver === undefined ? true : overrides.deliver(frameKey, delivery);
    },
  });
  return { queue, sent };
};

test("a request reaches one context and its reply settles it", async () => {
  const { queue, sent } = queueHarness();
  const pending = queue.request("3:3", { kind: "download", payload: { event: "determiningFilename" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].frameKey, "3:3");
  assert.equal(typeof sent[0].payload.requestId, "string", "the queue mints the id, so a reply cannot invent one");

  const id = sent[0].payload.requestId;
  assert.equal(queue.resolve("other:frame", id, { suggestion: "stolen.txt" }), false, "a frame that was not asked cannot answer");
  assert.equal(queue.pending().length, 1, "and the request stays open");
  assert.equal(queue.resolve("3:3", id, { suggestion: "mine.txt" }), true);

  assert.deepEqual(await pending, { suggestion: "mine.txt" });
  assert.deepEqual(queue.pending(), []);
});

test("an unanswered request settles as timedOut, and a late reply changes nothing", async () => {
  const { queue, sent } = queueHarness();
  const pending = queue.request("3:3", { kind: "download", payload: {} }, { timeoutMs: 10 });
  const id = sent[0].payload.requestId;
  assert.deepEqual(await pending, { timedOut: true });
  assert.equal(
    queue.resolve("3:3", id, { suggestion: "fashionably-late.txt" }),
    false,
    "a download whose name was already decided is not reopened by a late answer"
  );
});

test("a caller decides what an unanswered question means", async () => {
  const { queue } = queueHarness();
  const pending = queue.request("3:3", { kind: "download", payload: {} }, {
    timeoutMs: 10,
    onUnanswered: () => ({ noListener: true }),
  });
  assert.deepEqual(await pending, { noListener: true });
});

test("a question with nowhere to go is answered now, not at the timeout", async () => {
  const { queue } = queueHarness({ deliver: () => false });
  const started = Date.now();
  const pending = queue.request("gone:frame", { kind: "download", payload: {} }, { timeoutMs: 5000 });
  assert.deepEqual(await pending, { timedOut: true });
  assert.ok(Date.now() - started < 100, "the unreachable context did not make the save wait five seconds");
});

test("a context that goes away settles its open requests", async () => {
  const { queue, sent } = queueHarness();
  const mine = queue.request("3:3", { kind: "download", payload: {} }, { timeoutMs: 5000 });
  const theirs = queue.request("4:4", { kind: "download", payload: {} }, { timeoutMs: 5000 });
  queue.dropContext("3:3");
  assert.deepEqual(await mine, { timedOut: true });
  assert.equal(queue.pending().length, 1, "another context's request is untouched");
  queue.dropContext("4:4", () => ({ failed: true }));
  assert.deepEqual(await theirs, { failed: true });
  assert.deepEqual(queue.pending(), []);
  void sent;
});

test("a reply for a request id that never existed is refused", async () => {
  const { queue } = queueHarness();
  assert.equal(queue.resolve("3:3", "req-999", { suggestion: "x.txt" }), false);
});
