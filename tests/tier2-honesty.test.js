// The Tier-2 honesty invariants, asserted in one place (GitHub issue #4).
//
// Every per-API suite already checks its own rules. This file checks the rules that are
// EASY to break by accident while adding the next namespace, because they are the same
// mistake wearing different clothes:
//
//   1. NO FABRICATED PRODUCER. Chrome fires an event because the browser observed
//      something. This shell may fire one only when something in this host observed it, so
//      every `_fire` call site is enumerated here and each is attributed to a producer that
//      really observed something. A new `_fire` with no line below is a new invented event.
//   2. NO FABRICATED VALUE. A call that could not do its work fails or answers `undefined`;
//      it does not return a plausible id, a plausible URL, or a plausible screenshot.
//   3. NO FABRICATED CAPABILITY. A namespace never registers a UI surface it cannot show
//      (toolbar button, browser menu, notification button, side panel) as if it had one.
//   4. THE SHIM NEVER REACHES FOR THE HOST. src/chrome-shim has no transport, no Electron,
//      no browser globals — so nothing here can silently start talking to main. (Grep-
//      verified as a layering rule in security.test.js; this file asserts the Tier-2 half:
//      that the injectables are the ONLY way in.)
//   5. A SHIM NEVER TOUCHES THE REAL WORLD IN A TEST. The `attach*`/`get*` singletons are
//      the Electron-backed entry points; a unit test that called one would raise a modal on
//      the developer's screen or write into their Downloads folder.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createChromeNamespace } = require("../src/chrome-shim");
const { createExtensionStorage, createMemoryBackend } = require("../src/chrome-shim/storage");
const { createGrantGate } = require("../src/shared/permissions");

const REPO = path.join(__dirname, "..");
const readSource = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");
/** Code with its comments stripped: an honest log line is not a capability claim. */
const codeOf = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\*\/)/.test(line))
    .join("\n");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * A namespace with the manifest grants a test names and NOTHING ELSE injected: no
 * notification backend, no save service, no tab-opener, no CDP target. Every honest
 * answer in this file is therefore an answer with no host capability behind it.
 */
const namespace = ({ permissions = [] } = {}) => {
  const grants = Object.fromEntries(permissions.map((permission) => [permission, true]));
  const gate = createGrantGate(() => grants);
  gate.manifestLoaded();
  return createChromeNamespace({
    extensionId: "honesty.local",
    getManifest: () => ({ name: "Honesty", version: "1.0.0", manifest_version: 3, permissions }),
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    permissions: gate,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
};

// ── 1. every event this shell can fire has a producer that observed something ──
test("every _fire call site in chrome-shim is attributed to a real producer", () => {
  // Why each of these is honest. A new call site has to appear here, which is the point:
  // adding `onX._fire(...)` should be a deliberate act, not a side effect of wiring.
  const PRODUCERS = {
    // The host saw the OS notification's own click/close callback (notification-host.js
    // forwards Electron's), delivered to the context that created it.
    "browser-apis.js:_fire": 2,
    // create/remove really happened through this shell's own tab model.
    "tabs.js:_fire": 2,
    // A real timer elapsed (alarms.js owns the setTimeout), so the alarm is scheduled now.
    "alarms.js:_fire": 1,
    // main's save service reported a transition it performed; the shim relays it.
    "downloads.js:_fire": 2,
    // The storage write this very context just made.
    "storage.js:_fire": 3,
    "index.js:_fire": 1, // the per-area events above, fanned into chrome.storage.onChanged
    // RUNTIME_DELIVER really arrived for this extension from another context, or the host
    // reported the worker's own onInstalled/onStartup (main decides those, from install state).
    "messaging.js:_fire": 8,
    // CDP Network.* events the inspected app really reported.
    "network-bridge.js:_fire": 2,
  };

  const counts = {};
  for (const file of fs.readdirSync(path.join(REPO, "src", "chrome-shim"))) {
    if (!file.endsWith(".js")) {
      continue;
    }
    const fired = (codeOf(readSource("src", "chrome-shim", file)).match(/\._fire\(/g) || []).length;
    if (fired) {
      counts[`${file}:_fire`] = fired;
    }
  }

  assert.deepStrictEqual(
    counts,
    PRODUCERS,
    `event producers changed: ${JSON.stringify(counts)}. A new _fire needs a sentence above ` +
      "naming what in this host actually observed the event."
  );
});

test("the events with no producer in this host stay registrable and silent", async () => {
  const chrome = namespace({ permissions: ["tabs", "notifications", "alarms", "downloads", "storage"] });
  const fired = [];
  const watch = (label, event) => event.addListener(() => fired.push(label));

  // Chrome fires each of these because the browser UI observed something this host does
  // not have: no toolbar button, no tab strip, no browser menu, no notification button, no
  // grant prompt, no panel drawer, no keyboard-shortcut routing.
  watch("action.onClicked", chrome.action.onClicked);
  watch("tabs.onUpdated", chrome.tabs.onUpdated);
  watch("tabs.onActivated", chrome.tabs.onActivated);
  watch("tabs.onHighlighted", chrome.tabs.onHighlighted);
  watch("tabs.onMoved", chrome.tabs.onMoved);
  watch("tabs.onAttached", chrome.tabs.onAttached);
  watch("tabs.onDetached", chrome.tabs.onDetached);
  watch("notifications.onButtonClicked", chrome.notifications.onButtonClicked);
  watch("notifications.onShowSettings", chrome.notifications.onShowSettings);
  watch("permissions.onAdded", chrome.permissions.onAdded);
  watch("permissions.onRemoved", chrome.permissions.onRemoved);
  watch("commands.onCommand", chrome.commands.onCommand);
  watch("contextMenus.onClicked", chrome.contextMenus.onClicked);
  watch("sidePanel.onClicked", chrome.sidePanel.onClicked);

  // Now exercise every path that could be mistaken for one of those triggers, including
  // the ones that create state: a badge set, a tab "activated", an update, a click handler.
  await chrome.action.setBadgeText({ text: "5" });
  await chrome.action.setIcon({ path: "icon.png" }).catch(() => {});
  await chrome.tabs.update(chrome.devtools.inspectedWindow.tabId, { active: true });
  await chrome.tabs.query({ active: true });
  const created = await chrome.tabs.create({ url: "page.html" });
  await chrome.tabs.update(created.id, { url: "other.html" });
  await chrome.tabs.remove(created.id);
  await chrome.notifications
    .create("n", { type: "basic", title: "t", message: "m", buttons: [{ title: "B" }] })
    .catch(() => {});
  await chrome.notifications.clear("n");
  await chrome.permissions.request({ permissions: ["tabs"] });
  await chrome.permissions.remove({ permissions: ["tabs"] });
  await chrome.commands.getAll();
  await chrome.contextMenus.create({ id: "i", title: "I" });
  await chrome.contextMenus.update("i", { title: "J" });
  await chrome.contextMenus.remove("i");
  await chrome.sidePanel.setOptions({ path: "p.html" });
  await chrome.sidePanel.open({ tabId: 1 }).catch(() => {});
  await tick();

  assert.deepEqual(fired, [], `these events have no producer: ${JSON.stringify(fired)}`);
});

test("`tabs.update({active:true})` does not claim an activation happened", async () => {
  // update() answers with the unchanged tab; onActivated is Chrome's "the user is looking
  // at this tab now" event, and there is no tab strip to look at.
  const fired = [];
  const chrome = namespace({ permissions: ["tabs"] });
  chrome.tabs.onActivated.addListener(() => fired.push("onActivated"));
  chrome.tabs.onUpdated.addListener(() => fired.push("onUpdated"));
  chrome.tabs.onHighlighted.addListener(() => fired.push("onHighlighted"));
  const tab = await chrome.tabs.update(chrome.devtools.inspectedWindow.tabId, { active: true });
  await tick();
  assert.deepEqual(fired, []);
  assert.equal(tab.active, true, "the descriptor keeps Chrome's field, without an event to back it");
});

// ── 2. no fabricated values ─────────────────────────────────────────────────
test("a call that could not do its work names nothing", async () => {
  const chrome = namespace({
    permissions: ["notifications", "downloads", "tabs"],
    // No notification backend, no save backend, no open backend: nothing can show, write,
    // or launch, so nothing may be named either.
  });

  const noteId = await chrome.notifications
    .create("n", { type: "basic", title: "t", message: "m" })
    .catch(() => "rejected");
  assert.ok(
    noteId === undefined || noteId === "rejected",
    `no id for a notification that could not be shown (got ${String(noteId)})`
  );
  const captured = await chrome.tabs.captureVisibleTab();
  assert.strictEqual(captured, undefined, "a PNG-shaped string would be a fabricated screenshot");
});

test("nothing in Tier 2 invents an id when the underlying thing did not happen", async () => {
  const chrome = namespace({ permissions: ["notifications", "downloads"] });
  // notifications: no backend injected -> the id Chrome allocates is not handed out.
  const noteId = await chrome.notifications
    .create("no-backend", { type: "basic", title: "t", message: "m" })
    .then((id) => id)
    .catch(() => "rejected");
  assert.ok(
    noteId === undefined || noteId === "rejected",
    `no id for a notification that could not be shown (got ${String(noteId)})`
  );

  // downloads: no save service injected -> same rule.
  const downloadId = await chrome.downloads
    .download({ url: "https://example.com/a.txt" })
    .then((id) => id)
    .catch(() => "rejected");
  assert.ok(
    downloadId === undefined || downloadId === "rejected",
    `no id for a save that did not happen (got ${String(downloadId)})`
  );
});

test("the tab descriptor omits what this host cannot know, rather than guessing", async () => {
  const chrome = namespace({ permissions: ["tabs"] });
  const [tab] = await chrome.tabs.query({});
  assert.equal(tab.id, chrome.devtools.inspectedWindow.tabId, "one tab, one id");
  // No CDP session in this namespace, so: Chrome's own "nothing loaded" pair, and the
  // fields that would need a window model are ABSENT rather than filled with a plausible 0.
  assert.equal(tab.url, "about:blank");
  assert.equal(tab.title, "");
  assert.ok(!("windowId" in tab), "no window model to be in");
  assert.ok(!("groupId" in tab), "no tab groups here");
  assert.ok(!("status" in tab), "nothing reported a load completing");
  assert.ok(!(("lastAccessed" in tab) || "favIconUrl" in tab), "nothing observed a visit or an icon");
});

// ── 3. no fabricated capability ─────────────────────────────────────────────
test("a Tier-2 log line never claims a UI affordance this host does not have", () => {
  // An extension author reads these strings as the contract. The honest phrasing says what
  // is MISSING; these would advertise a surface that exists nowhere in this shell. The
  // pattern is aimed at what a message could SAYS, with the negations that make the honest
  // sentences legal (see the assertions after this one, which pin the real wording).
  const claims = [
    /has been (added|shown|opened|revealed) to (the|a) (browser )?(context |right-click )?menu/i,
    /shown in the (panel|drawer)/i,
    /revealed in (the )?(finder|explorer)/i,
    /notification (button|buttons) (are |is )?(shown|supported)/i,
  ];
  const offenders = [];
  for (const file of fs.readdirSync(path.join(REPO, "src", "chrome-shim"))) {
    if (!file.endsWith(".js")) {
      continue;
    }
    // Strings only: a comment explaining what is missing is exactly what this shell does.
    const strings = (readSource("src", "chrome-shim", file).match(/"(?:[^"\\]|\\.)*"/g) || []).join("\n");
    for (const pattern of claims) {
      if (pattern.test(strings)) {
        offenders.push(`${file}: ${pattern}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, []);

  // And the real wording is pinned, so a future edit cannot quietly drop the negation.
  const shells = readSource("src", "chrome-shim", "browser-shells.js");
  assert.match(shells, /no browser right-click menu/, "contextMenus names its missing surface");
  assert.match(shells, /no keyboard shortcut to an extension/, "commands names its missing routing");
  assert.match(shells, /no side-panel drawer/, "sidePanel names its missing drawer");
  const apis = readSource("src", "chrome-shim", "browser-apis.js");
  assert.match(apis, /button/i, "and a `buttons` array is reported as ignored, not accepted in silence");
});

// ── 4. the only way in is what is injected ─────────────────────────────────
test("every Tier-2 host capability is an injected function, defaulting to nothing", () => {
  // Build with NO injectables at all: the namespace must still construct, keep its shape,
  // and answer honestly. Anything that reached for a missing injectable would throw here.
  const chrome = createChromeNamespace({
    extensionId: "inject.local",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  for (const name of [
    "notifications",
    "alarms",
    "downloads",
    "tabs",
    "permissions",
    "commands",
    "contextMenus",
    "sidePanel",
  ]) {
    assert.equal(typeof chrome[name], "object", `chrome.${name} exists`);
  }

  // Each injectable is a named parameter of the factory, and each has a null default that
  // means "this host cannot do that" — grep-verified rather than trusted.
  const source = readSource("src", "chrome-shim", "index.js");
  for (const injectable of [
    "getTargetInfo",
    "openTabIn",
    "closeTabById",
    "showNotification",
    "hideNotification",
    "getNotificationPermissionLevel",
    "getAlarmClockScale",
    "saveDownload",
    "cancelDownload",
    "eraseDownloads",
    "searchDownloads",
    "respondSuggestion",
    "openOptionsPage",
  ]) {
    assert.match(
      source,
      new RegExp(`${injectable}\\s*=\\s*(null|\\(\\)\\s*=>|\\{)`),
      `${injectable} is an injected dep with a default, not a require`
    );
  }
});

// ── 5. a unit test never reaches the real world ────────────────────────────
test("the Electron-backed singletons are not called from any unit test", () => {
  // getSaveService()/attach*() are the real-world entry points. A unit file that called one
  // would raise a save dialog on the developer's screen or write into their Downloads.
  const dangerous = /\b(getSaveService|attachSaveService|attachNotificationHost|attachOptionsHost|attachTabHost)\s*\(/;
  const offenders = [];
  for (const file of fs.readdirSync(path.join(REPO, "tests"))) {
    if (!file.endsWith(".test.js") || file.includes("electron")) {
      continue; // the Electron suites are exactly where these belong
    }
    // Code, not prose: several test files EXPLAIN this rule in a comment, and a comment
    // naming a function is not a call to it.
    if (dangerous.test(codeOf(fs.readFileSync(path.join(REPO, "tests", file), "utf8")))) {
      offenders.push(file);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `${offenders.join(", ")} would open a window, raise a dialog, or write outside a temp dir`
  );
});

test("nothing in the suite can turn tabs.create's external open on", () => {
  // `shell.openExternal` is the one Tier-2 path that would launch the developer's real
  // browser. It is policy-gated, and the gate has two halves: the default is `none`, and no
  // test flips the switch.
  const config = readSource("src", "main", "config.js");
  assert.match(
    config,
    /TABS_OPEN_POLICIES\.includes\(raw\) \? raw : "none"/,
    "an unset or unrecognised DEVTOOLS_TABS_OPEN means nothing opens"
  );
  assert.match(
    readSource("src", "main", "tab-host.js"),
    /policy === "external" && openExternal/,
    "and the host needs BOTH the policy and an injected opener"
  );

  const offenders = [];
  for (const file of fs.readdirSync(path.join(REPO, "tests"))) {
    if (!/\.(test|js)$/.test(file)) {
      continue;
    }
    if (/DEVTOOLS_TABS_OPEN\s*(=|:)\s*["']?(external|window)/.test(fs.readFileSync(path.join(REPO, "tests", file), "utf8"))) {
      offenders.push(file);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `${offenders.join(", ")} would launch the developer's real browser from a test run`
  );
});
