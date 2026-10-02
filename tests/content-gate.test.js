// The injection gate for content scripts (src/main/content-gate.js) — GitHub issue #5.
//
// The property that matters most here is the boring one: with no configuration, the
// gate injects NOTHING, for every extension, for every entry, and says why. Every
// other assertion in this file is downstream of that one, because the thing this gate
// exists to prevent is a content script running inside the user's running app because
// some manifest happened to declare a URL pattern that looked like it.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const {
  ALL_RN_TARGETS,
  CONTENT_SCRIPTS_PERMISSION,
  parseAllowlist,
  isAllowlisted,
  decideInjection,
  decideEntries,
} = require("../src/main/content-gate");
const config = require("../src/main/config");

const entry = (over = {}) => ({
  index: 0,
  matches: ["https://app.test/*"],
  excludeMatches: [],
  js: ["content.js"],
  css: [],
  runAt: "document_idle",
  world: "ISOLATED",
  allFrames: false,
  matchAboutBlank: false,
  ...over,
});

// ── the default ────────────────────────────────────────────────────────────────
test("the default injects nothing, for every extension and every entry", () => {
  assert.strictEqual(config.contentScripts, null, "the shipped default is unset");
  const manifest = {
    permissions: [CONTENT_SCRIPTS_PERMISSION],
    content_scripts: [{ matches: ["<all_urls>"], js: ["x.js"] }],
  };
  const verdict = decideInjection({
    extensionId: "graphql",
    manifest,
    entry: entry({ matches: ["<all_urls>"] }),
    allowlist: config.contentScripts,
  });
  assert.strictEqual(verdict.allowed, false);
  assert.strictEqual(verdict.code, "not-allowlisted");
  assert.match(verdict.reasons.join("\n"), /not allowlisted/);
  assert.match(verdict.reasons.join("\n"), /DEVTOOLS_CONTENT_SCRIPTS/);
  assert.match(verdict.reasons.join("\n"), /unset — the default, and the safe one/);
});

test("an empty string, a blank string and undefined all mean the same safe nothing", () => {
  for (const allowlist of [undefined, null, "", "   ", []]) {
    const verdict = decideInjection({
      extensionId: "graphql",
      manifest: {},
      entry: entry(),
      allowlist,
    });
    assert.strictEqual(verdict.allowed, false, JSON.stringify(allowlist));
    assert.strictEqual(verdict.code, "not-allowlisted");
  }
});

test("`matches` never opts anything in, however confident the pattern looks", () => {
  const verdict = decideInjection({
    extensionId: "graphql",
    manifest: { permissions: [CONTENT_SCRIPTS_PERMISSION] },
    entry: entry({ matches: ["<all_urls>", "https://www.graphdev.app/draft?*"] }),
    allowlist: null,
    targetUrl: "https://www.graphdev.app/draft?sessionId=1",
  });
  assert.strictEqual(verdict.allowed, false);
  const text = verdict.notes.join("\n");
  assert.match(text, /has no RN analog/);
  assert.match(text, /neither allow nor deny injection/);
  // Informational only, and labelled as such — the graphdev pattern really does
  // match the target url, and saying so is useful; ACTING on it would not be.
  assert.match(text, /\(informational\).*would have matched/s);
});

test("an allowlist of `<all_urls>` is not permission, and says so", () => {
  const parsed = parseAllowlist("<all_urls>");
  assert.deepStrictEqual(parsed.invalid, ["<all_urls>"]);
  assert.strictEqual(parsed.allRnTargets, false);
  assert.deepStrictEqual(parsed.ids, []);
  const verdict = decideInjection({
    extensionId: "graphql",
    manifest: {},
    entry: entry(),
    allowlist: "<all_urls>",
  });
  assert.strictEqual(verdict.allowed, false);
  assert.match(verdict.notes.join("\n"), /ignored allowlist token\(s\) \["<all_urls>"\]/);
});

// ── the opt-in, spelled out ─────────────────────────────────────────────────────
test("the opt-in: an id names one extension, `<all_rn_targets>` names them all", () => {
  assert.deepStrictEqual(parseAllowlist(" graphql ,altair\n x"), {
    tokens: ["graphql", "altair", "x"],
    ids: ["graphql", "altair", "x"],
    allRnTargets: false,
    invalid: [],
  });
  const all = parseAllowlist(ALL_RN_TARGETS);
  assert.strictEqual(all.allRnTargets, true);
  assert.deepStrictEqual(all.ids, []);

  assert.deepStrictEqual(isAllowlisted(parseAllowlist("graphql"), "graphql"), {
    allowed: true,
    via: "graphql",
  });
  assert.deepStrictEqual(isAllowlisted(parseAllowlist("graphql"), "altair"), {
    allowed: false,
    via: null,
  });
  assert.deepStrictEqual(isAllowlisted(parseAllowlist(ALL_RN_TARGETS), "anything"), {
    allowed: true,
    via: ALL_RN_TARGETS,
  });
  // A raw string/array is accepted too, so a caller cannot forget to parse.
  assert.strictEqual(isAllowlisted("altair", "altair").allowed, true);
  assert.strictEqual(isAllowlisted(["altair"], "altair").allowed, true);
});

test("allowlisted is enough on its own — the manifest dimension is reported, not required", () => {
  const verdict = decideInjection({
    extensionId: "graphql",
    manifest: { permissions: ["storage"] },
    entry: entry(),
    allowlist: "graphql",
  });
  assert.strictEqual(verdict.allowed, true);
  assert.strictEqual(verdict.code, "allowlisted");
  assert.strictEqual(verdict.via, "graphql");
  const text = verdict.notes.join("\n");
  assert.match(text, /does not declare "content_scripts"/);
  assert.match(text, /Chrome requires no permission for content scripts/);
  assert.match(text, /the absence is not read as approval/);
});

test("a manifest that DOES declare the host-side permission is told it is a convention, not Chrome", () => {
  const verdict = decideInjection({
    extensionId: "graphql",
    manifest: { permissions: [CONTENT_SCRIPTS_PERMISSION] },
    entry: entry(),
    allowlist: "graphql",
  });
  assert.strictEqual(verdict.allowed, true);
  const text = verdict.notes.join("\n");
  assert.match(text, /declares "content_scripts"/);
  assert.match(text, /host-side convention only/);
  assert.match(text, /Chrome gates content-script injection on no permission at all/);
  // And the notes never claim parity with Chrome anywhere.
  assert.doesNotMatch(text, /matches Chrome/);
});

// ── the degradations the report has to carry ───────────────────────────────────
test("every degradation an entry hits is stated in its own verdict", () => {
  const verdict = decideInjection({
    extensionId: "graphql",
    manifest: {},
    entry: entry({ world: "MAIN", allFrames: true, matchAboutBlank: true, runAt: "document_start" }),
    allowlist: "graphql",
  });
  const text = verdict.notes.join("\n");
  assert.match(text, /run_at "document_start" collapses to "on attach \/ first context"/);
  assert.match(text, /misses code that ran before attach/);
  assert.match(text, /all_frames is meaningless here/);
  assert.match(text, /match_about_blank is meaningless here/);
  // MAIN is the world this host can actually give, so no ISOLATED warning.
  assert.doesNotMatch(text, /cannot be honoured/);

  const isolated = decideInjection({
    extensionId: "graphql",
    manifest: {},
    entry: entry(),
    allowlist: "graphql",
  });
  assert.match(isolated.notes.join("\n"), /world "ISOLATED" cannot be honoured/);
  assert.match(isolated.notes.join("\n"), /Hermes has no isolated worlds/);
});

test("an entry with no js is refused by name, not filtered out quietly", () => {
  const verdict = decideInjection({
    extensionId: "graphql",
    manifest: {},
    entry: entry({ js: [], css: ["overlay.css"] }),
    allowlist: ALL_RN_TARGETS,
  });
  assert.strictEqual(verdict.allowed, false);
  assert.strictEqual(verdict.code, "no-js");
  assert.match(verdict.reasons.join("\n"), /no "js" to inject/);
});

test("decideEntries decides every entry of an extension and keeps the registry's fields", () => {
  const entries = [entry({ index: 0 }), entry({ index: 1, js: ["second.js"], matches: ["*://*/*"] })];
  const decided = decideEntries({
    extensionId: "graphql",
    manifest: { name: "GraphQL" },
    entries,
    allowlist: "graphql",
    targetUrl: "",
  });
  assert.strictEqual(decided.length, 2);
  assert.strictEqual(decided[1].js[0], "second.js");
  assert.strictEqual(decided[0].decision.allowed, true);
  assert.strictEqual(decided[1].decision.allowed, true);

  const blocked = decideEntries({
    extensionId: "altair",
    manifest: {},
    entries,
    allowlist: "graphql",
  });
  assert.ok(blocked.every((entry2) => entry2.decision.allowed === false));
});

test("a host with an allowlist still reports the reason for each entry, allowed or not", () => {
  const allowed = decideInjection({
    extensionId: "altair",
    manifest: {},
    entry: entry(),
    allowlist: ALL_RN_TARGETS,
  });
  assert.match(allowed.reasons.join("\n"), new RegExp(ALL_RN_TARGETS));
  const denied = decideInjection({
    extensionId: "altair",
    manifest: {},
    entry: entry(),
    allowlist: "graphql",
  });
  assert.match(denied.reasons.join("\n"), /not allowlisted/);
  assert.match(denied.reasons.join("\n"), /"graphql","altair"|names "altair"/);
});
